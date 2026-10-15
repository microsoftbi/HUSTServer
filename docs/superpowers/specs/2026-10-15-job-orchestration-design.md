# HUSTServer 设计文档：Job 编排

- 日期：2026-10-15
- 状态：已批准
- 依据：[2026-10-14-hustserver-design.md](./2026-10-14-hustserver-design.md)、[2026-10-14-web-workflow-designer-design.md](./2026-10-14-web-workflow-designer-design.md)

## 1. 背景与目标

平台目前只能「一次跑一个工作流」：手动运行，或由挂在 `schedules` 表上的调度器定时触发。缺少**把多个动作串成一条流水线**的能力——例如「先跑工作日结工作流 → 再执行一段归档 SQL」。

本设计引入 **Job 编排**：用户可定义一个 Job，内含**有序的若干步骤**，每个步骤是「运行工作流」或「运行 SQL」；Job 自带一份调度配置，可定时触发，也可手动触发。

### 目标（本阶段）

1. 主页新增「Job编排」入口，进入后首先是 **Job 列表**，右上角有「新建 Job」按钮。
2. Job 编辑器可**编排步骤**：新增 / 删除 / 上移下移；步骤类型为「运行工作流」与「运行 SQL」。
3. 每个步骤可**单独配置失败策略**（中止 / 继续）。
4. Job 可**配置调度**（1 个 Job 对应 1 份调度配置），保存后即生效。
5. 可**手动运行 Job**，并可查看**运行历史**与**每步执行结果**。

### 非目标（本阶段明确不做）

- **步骤间数据传递**：各步骤相互独立，不做变量 / 参数映射。
- **步骤级重试次数、超时配置**：失败策略只有「中止 / 继续」两态。
- **分支 / 条件 / 并行**：只做线性顺序编排。
- **Job 失败重跑、断点续跑**。
- **调度器的 DB 驱动 + 原子认领演进**：属独立课题，本阶段沿用现有 node-cron 单实例模式。

## 2. 范围与关键决策

| 决策项 | 结论 |
|---|---|
| 实现方案 | **方案 A**：Job 作为独立子系统，复用 `runs` 承载「运行工作流」步骤 |
| Job 与调度关系 | **1:1**，调度字段内嵌在 `jobs` 表；新建 Job 默认不开启调度 |
| 失败策略 | **每步单独配置**，`on_failure ∈ { abort, continue }`，默认 `abort` |
| 步骤间数据传递 | **不支持**，步骤相互独立 |
| 「运行 SQL」目标 | **选择已有连接 + 手写 SQL**（连接取自 `connections` 表，类型 SQL Server） |
| 调度器 | **泛化 `scheduler.ts` 为通用 cron 注册表**，workflow 与 job 各用一个实例 |
| 执行载体 | Job 运行记录独立于 `runs`；「运行工作流」步骤仍落到 `runs` 表 |

### 被否决的方案

- **方案 B：把 Job 编译成「元工作流」交给 engine 执行。** 可复用 engine 的图执行 / 日志 / 预览 / SSE，但 engine 节点是数据管道语义（input/output/transform），「调用另一个工作流」与「执行 DDL/DML」都不在其语义内；且 engine 是**全图 fail-fast**，与「每步单独配置失败策略」直接冲突。改动面更大且语义别扭。
- **方案 C：引入外部编排器（Temporal / Airflow）。** 超出本项目量级，需新增服务与运维成本。

## 3. 架构

```
                  ┌─────────────────┐
   浏览器 ──────► │  jobRoutes      │  /api/jobs*  /api/job-runs*
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐        ┌───────────────────┐
                  │  JobService     │◄───────│  jobScheduler     │
                  │  trigger/worker │  (cron)│  (通用 cron 注册表) │
                  └───┬─────────┬───┘        └───────────────────┘
                      │         │
        workflow 步骤 │         │ sql 步骤
                      ▼         ▼
             RunService      mssql 直连
             (runs 表 +       (connections
              队列 + 限流)      表取连接)
```

- **`JobService`**：负责 Job 的一次运行。顺序遍历步骤，逐步落 `job_step_runs`。
- **「运行工作流」步骤**：调用现有 `RunService.trigger()`，然后**等待该 run 进入终态**，据其状态判定本步成败。
- **「运行 SQL」步骤**：解密连接配置后用 `mssql` 直连执行，记录影响行数。
- **`jobScheduler`**：与 workflow 调度器同构，只是「源」换成 `jobs` 表、「动作」换成 `JobService.trigger`。

## 4. 数据模型

在 [apps/server/src/db/migrate.ts](../../../apps/server/src/db/migrate.ts) 新增 4 张表，并给 `runs` 加一列。

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 0,   -- 调度开关，默认关
  freq_type   TEXT,                          -- daily/weekly/monthly/cron；未配置调度时为 NULL
  cron_expr   TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_steps (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,               -- 执行顺序，从 0 递增
  type       TEXT NOT NULL,                  -- 'workflow' | 'sql'
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,                  -- JSON，见 §4.1
  on_failure TEXT NOT NULL DEFAULT 'abort',  -- 'abort' | 'continue'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,                -- 'manual' | 'schedule'
  triggered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL,                -- queued/running/success/error
  started_at   INTEGER,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_step_runs (
  id           TEXT PRIMARY KEY,
  job_run_id   TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  step_id      TEXT,                         -- 步骤被删则为 NULL（历史留痕）
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL,                -- pending/running/success/error/skipped
  started_at   INTEGER,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  output       TEXT,                         -- JSON；SQL 步骤存 rowsAffected/rowCount
  created_at   INTEGER NOT NULL
);

-- runs 增列
ALTER TABLE runs ADD COLUMN job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL;

-- 索引
CREATE INDEX IF NOT EXISTS idx_jobs_owner           ON jobs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_steps_job        ON job_steps(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_job_runs_job         ON job_runs(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_step_runs_run    ON job_step_runs(job_run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_job_run         ON runs(job_run_id);
```

> `ALTER TABLE` 需幂等：`migrate()` 需先查 `PRAGMA table_info(runs)` 判断列是否已存在，避免重复执行报错。

### 4.1 步骤 config 形态

- `type: 'workflow'` → `{ "workflowId": "<id>" }`
- `type: 'sql'` → `{ "connectionId": "<id>", "sql": "<SQL 文本>" }`

## 5. 执行模型

### 5.1 触发

`JobService.trigger(jobId, opts)`：

1. 校验 Job 存在、有至少一个步骤。
2. 写一行 `job_runs`，`status = 'queued'`。
3. 按 `job_steps.seq` 预写全部 `job_step_runs`，`status = 'pending'`（快照当时的步骤定义，避免运行中改 Job 影响在途运行）。
4. 交给 **Job 级信号量**（独立于 run 的信号量，固定并发 1），异步进入 worker，立即返回 `job_runs` 行。

> **为什么独立信号量**：workflow 步骤会占用 run 的信号量槽位并在其内部等待完成。若 Job 复用同一信号量，会形成「Job 占槽 → 等 run → run 等槽」的死锁。

### 5.2 Worker

按 `seq` 顺序执行每个 `pending` 步骤：

- **workflow 步骤**
  1. 调 `runService.trigger(workflowId, { triggerType: 'job', triggeredBy, jobRunId })`（需要给 `trigger` 的 opts 增加 `jobRunId`）。
  2. `await runService.awaitRun(runId)` 等待终态。
  3. `success` → 本步成功；`error`/`canceled` → 本步失败，错误取自 `runs.error`。
- **sql 步骤**
  1. 取 `connections.findById(connectionId)`；不存在 → 本步失败（错误：`连接不存在`）。
  2. 解密配置，构造 mssql config，连接执行 `sql`。
  3. 成功 → `output = { rowsAffected, rowCount }`；失败 → 记 `error`。
  4. 无论成败，`finally` 关闭连接。

### 5.3 失败处理

某步失败时，读取该步的 `on_failure`：

- `abort`：把**剩余所有** `pending` 步骤标记为 `skipped`，`job_runs.status = 'error'`，`error` 记为本步错误，结束。
- `continue`：本步标记 `error`，继续执行下一步。

全部步骤（或 `continue` 后剩余步骤）跑完：

- 只要**有任何一步失败** → `job_runs.status = 'error'`；否则 `success`。
- 写 `finished_at` / `duration_ms`。

### 5.4 需要的底层能力（现有代码缺口）

| 能力 | 落点 | 说明 |
|---|---|---|
| `RunService.awaitRun(runId): Promise<RunStatus>` | [runs/service.ts](../../../apps/server/src/modules/runs/service.ts) | 现有 `whenIdle()` 是「等**所有** run 空闲」，粒度太粗。`awaitRun` 需按 runId 挂回调，在 `runs.finish()` 后触发。 |
| `TriggerType` 增 `'job'` | [runs/repo.ts](../../../apps/server/src/modules/runs/repo.ts) | 类型联合加一项。 |
| `trigger()` opts 增 `jobRunId` | runs/service.ts、runs/repo.ts | `runs.create` 写入新列 `job_run_id`。 |

## 6. 调度集成

### 6.1 泛化 `scheduler.ts`

现状把「源 = schedules 表、动作 = triggerRun(workflowId, scheduleId)」写死。改为通用 cron 注册表：

```ts
export interface CronEntry {
  id: string;          // 唯一键（scheduleId 或 jobId）
  expr: string;        // 5 段标准 cron
  timezone: string;
}

export interface SchedulerDeps {
  cronImpl?: CronImpl;
  onError?: (err: unknown) => void;
}

export interface Scheduler {
  /** 记录 (entries, onFire) 并全量重建定时器；不在新集合内的旧任务被销毁。 */
  sync(entries: CronEntry[], onFire: (id: string) => void): void;
  /** 用最近一次 sync 记录的 (entries, onFire) 重建定时器；从未 sync 过则 no-op。 */
  start(): void;
  /** 销毁全部定时器（不遗忘最近一次 sync 的参数）。 */
  stop(): void;
  /** 当前已注册的 id（测试与诊断用）。 */
  registeredIds(): string[];
}
```

- 内部仍为 `Map<id, CronTask>` + 全量重建（`sync` = 销毁旧 + 注册新），并把入参记在闭包里供 `start()` 复用。
- `onFire` 由调用方注入，因此一个实例服务 workflow、另一个服务 job。
- 现有 `scheduler.test.ts` 需按新入参形态适配。

### 6.2 接线

[server.ts](../../../apps/server/src/server.ts)：

```ts
const scheduler = deps.overrides?.scheduler ?? createScheduler({ onError: ... });
const jobScheduler = deps.overrides?.jobScheduler ?? createScheduler({ onError: ... });

// workflow 侧（保持既有行为）
scheduler.sync(
  schedulesRepo(db).listEnabled().map((s) => ({ id: s.id, expr: s.cron_expr, timezone: s.timezone })),
  (id) => { /* 按 id 反查 schedule → runService.trigger(workflowId, { triggerType: 'schedule', scheduleId }) */ },
);

// job 侧
jobScheduler.sync(
  jobsRepo(db).listEnabledScheduled().map((j) => ({ id: j.id, expr: j.cron_expr!, timezone: j.timezone })),
  (id) => jobService.trigger(id, { triggerType: 'schedule' }),
);
```

- `schedules/routes.ts` 现有的 `deps.scheduler.reload()` 调用点（3 处）改为调用注入的回调 `deps.resync()`。为此 `ScheduleRoutesDeps.scheduler: Pick<Scheduler, 'reload'>` 替换为 `resync: () => void`，由 [server.ts](../../../apps/server/src/server.ts) 传入闭包 `() => scheduler.sync(workflowEntries(), fireWorkflow)`。
- `jobs/routes.ts` 保存 / 删除后调用同理注入的 `resync` 闭包（`() => jobScheduler.sync(jobEntries(), fireJob)`）。
- [index.ts](../../../apps/server/src/index.ts)：`app.scheduler.start()` 后追加 `app.jobScheduler.start()`，优雅退出时 `stop()` 亦然。`FastifyInstance` 需 `decorate('jobScheduler', ...)`。

> 本阶段调度仍是**进程内 node-cron 单实例**、**重启不补跑**、**无重叠防护**——与现有 workflow 调度同等能力，不引入新问题。

## 7. API 契约

全部 `preHandler: requireAuth`，并做 owner/admin 归属校验（与 [schedules/routes.ts](../../../apps/server/src/modules/schedules/routes.ts) 同款）。

| 方法 | 路径 | 请求体 | 响应 |
|---|---|---|---|
| GET | `/api/jobs` | — | `{ items: JobListItem[] }`，含 `nextRunAt`、`stepCount`、`lastRun` 摘要 |
| POST | `/api/jobs` | `{ name, description?, steps: StepInput[], schedule?: ScheduleInput }` | `201 JobDetail` |
| GET | `/api/jobs/:id` | — | `JobDetail`（含 `steps`、`schedule`、`nextRunAt`） |
| PUT | `/api/jobs/:id` | 同 POST | `JobDetail` |
| DELETE | `/api/jobs/:id` | — | `{ ok: true }` |
| POST | `/api/jobs/:id/runs` | — | `202 { jobRunId }` |
| GET | `/api/jobs/:id/runs` | `?limit&offset` | `{ total, items: JobRunRow[] }` |
| GET | `/api/job-runs/:id` | — | `{ jobRun, steps: JobStepRunRow[] }` |

类型：

```ts
type StepInput =
  | { type: 'workflow'; name: string; workflowId: string; onFailure: 'abort' | 'continue' }
  | { type: 'sql'; name: string; connectionId: string; sql: string; onFailure: 'abort' | 'continue' };

interface ScheduleInput {
  enabled: boolean;
  freqType: 'daily' | 'weekly' | 'monthly' | 'cron';
  time?: string;      // HH:mm
  weekday?: number;   // 0-6
  monthDay?: number;  // 1-31
  cronExpr?: string;
  timezone?: string;
}
```

### 7.1 校验规则

- `name` 非空。
- `steps` 至少 1 条；`seq` 按数组下标重排（服务端权威决定顺序，不信客户端 `seq`）。
- workflow 步骤：`workflowId` 必须存在，且当前用户可访问（owner/admin）。
- sql 步骤：`connectionId` 必须存在且当前用户可访问；`sql` 非空。
- `onFailure` 缺省为 `'abort'`。
- `schedule` 存在且 `enabled = true` 时：`presetToCron` + `validateCron`（复用 [schedules/cron.ts](../../../apps/server/src/modules/schedules/cron.ts)）；不合法 → `400`。
- `PUT` 为**整体覆盖**语义：先删旧 steps 再插新 steps；调度字段整体替换。

## 8. 前端

### 8.1 入口

- [Layout.tsx](../../../apps/web/src/components/Layout.tsx)：导航新增「Job编排」→ `/jobs`。
- [HomePage.tsx](../../../apps/web/src/pages/HomePage.tsx)：新增入口卡片。
- [App.tsx](../../../apps/web/src/App.tsx)：新增路由 `/jobs`、`/jobs/new`、`/jobs/:id`、`/job-runs/:id`，均包在 `RequireAuth` + `Layout` 内。

### 8.2 页面

**JobListPage（`/jobs`）**
- 标题「Job 编排」+ 右上角「新建 Job」按钮（跳 `/jobs/new`）。
- 表格列：名称 / 步骤数 / 调度（人话描述，如「每天 08:00」/ 未启用）/ 最近运行状态 / 更新时间 / 操作（编辑、运行、历史、删除）。
- 空态提示「暂无 Job，点击右上角『新建 Job』」。

**JobEditorPage（`/jobs/new`、`/jobs/:id`）**
分三块：

1. **基本信息**：名称（必填）、描述。
2. **步骤编排**：纵向列表，每项显示序号、类型徽标、名称、失败策略；操作有上移 / 下移 / 删除；底部「添加步骤」下拉（运行工作流 / 运行 SQL）。
   - 运行工作流步骤表单：工作流下拉（拉 `/api/workflows`）、失败策略单选。
   - 运行 SQL 步骤表单：连接下拉（拉 `/api/connections`，仅 `sqlserver` 类型）、SQL 多行文本框、失败策略单选。
3. **调度配置**：启用开关 + 频次（每天 / 每周 / 每月 / 自定义 cron）+ 对应字段（时间 / 星期 / 日期 / cron 表达式）+ 时区。

底部操作栏：**保存**、**手动运行**（仅已有 id 时可用）、**查看运行历史**。

**JobRunDetailPage（`/job-runs/:id`）**
- 顶部：Job 名、状态、触发方式、耗时。
- 步骤时间线：每步状态 / 耗时 / 错误；SQL 步骤展示影响行数；workflow 步骤提供「查看运行详情」链接跳 `/runs/:runId`（需 API 回传该步对应的 `runId`，见 §9）。
- 轮询或 SSE 刷新运行中状态（本阶段用简单轮询，间隔 1s，终态停止）。

## 9. 补充约定

- `job_step_runs.output`：workflow 步骤记录 `{ "runId": "<id>" }`，供前端跳转 `/runs/:runId`；sql 步骤记录 `{ "rowsAffected": n, "rowCount": n }`。
- Job 运行详情页的状态刷新用**轮询**（`GET /api/job-runs/:id`，间隔 1s，任一终态即停止），本阶段不引入新的 SSE 通道。
- `jobs.enabled` 与 `cron_expr` 的关系：仅当 `enabled = 1` 且 `cron_expr` 非空时，该 Job 才被注册进调度器；此即 `JobsRepo.listEnabledScheduled()` 的过滤条件。

## 10. 改动清单

### 新增

- `apps/server/src/modules/jobs/repo.ts` —— `JobsRepo` / `JobStepsRepo` / `JobRunsRepo` / `JobStepRunsRepo`
- `apps/server/src/modules/jobs/service.ts` —— `createJobService`（`trigger` / worker / `whenIdle`）
- `apps/server/src/modules/jobs/routes.ts` —— §7 全部端点
- `apps/server/src/modules/jobs/sql.ts` —— 用 `mssql` 执行 SQL，返回 `{ rowsAffected, rowCount }`
- `apps/web/src/pages/JobListPage.tsx`
- `apps/web/src/pages/JobEditorPage.tsx`
- `apps/web/src/pages/JobRunDetailPage.tsx`
- 测试：`apps/server/test/job-repo.test.ts`、`job-service.test.ts`（重点覆盖 `abort` / `continue` 两种失败策略与 `skipped` 标记）、`job-routes.test.ts`

### 修改

- [apps/server/src/db/migrate.ts](../../../apps/server/src/db/migrate.ts)：4 张新表 + `runs.job_run_id` 列（幂等 ALTER）+ 索引
- [apps/server/src/modules/runs/repo.ts](../../../apps/server/src/modules/runs/repo.ts)：`TriggerType` 增 `'job'`；`create` 支持 `jobRunId`
- [apps/server/src/modules/runs/service.ts](../../../apps/server/src/modules/runs/service.ts)：新增 `awaitRun(runId)`；`trigger` opts 增 `jobRunId`
- [apps/server/src/modules/schedules/scheduler.ts](../../../apps/server/src/modules/schedules/scheduler.ts)：泛化为 `sync(entries, onFire)`
- [apps/server/src/modules/schedules/routes.ts](../../../apps/server/src/modules/schedules/routes.ts)：`deps.scheduler: Pick<Scheduler,'reload'>` 改为 `deps.resync: () => void`，3 处 `reload()` 调用改为 `resync()`
- [apps/server/src/modules/schedules/repo.ts](../../../apps/server/src/modules/schedules/repo.ts)：`listEnabled` 保留（供构建 `CronEntry[]` 取数）
- [apps/server/src/server.ts](../../../apps/server/src/server.ts)：接线 `jobService` / `jobScheduler` / `jobRoutes`；`decorate('jobScheduler')`
- [apps/server/src/index.ts](../../../apps/server/src/index.ts)：起停 `jobScheduler`
- `apps/server/package.json`：新增 `mssql` 依赖 + `@types/mssql` 开发依赖
- [packages/engine/src/index.ts](../../../packages/engine/src/index.ts)：导出 `buildMssqlConfig`
- [apps/web/src/App.tsx](../../../apps/web/src/App.tsx)、[Layout.tsx](../../../apps/web/src/components/Layout.tsx)、[HomePage.tsx](../../../apps/web/src/pages/HomePage.tsx)：入口与路由
- 既有 `apps/server/test/scheduler.test.ts`：适配泛化后的 `sync` 接口

## 11. 测试策略

- **repo 层**：CRUD、级联删除、`listEnabledScheduled` 只返回 `enabled=1 且 cron_expr 非空` 的 Job。
- **service 层**：
  - 顺序执行，`job_step_runs` 状态依次推进。
  - workflow 步骤成功 / 失败（用假 `RunService` 注入）。
  - sql 步骤成功 / 失败（注入假 sql 执行器，避免真实连库）。
  - `abort`：首步失败后剩余步骤为 `skipped`，`job_runs.status = 'error'`。
  - `continue`：首步失败后仍执行后续步骤，最终 `job_runs.status = 'error'`。
  - 全部成功 → `success`。
- **routes 层**：鉴权（未登录 401、非归属 403）、校验（空 name、空 steps、非法 schedule、不存在的 workflowId/connectionId）。
- **scheduler**：`sync` 全量重建语义、`onFire` 回调、`registeredIds`。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 泛化 scheduler 可能影响现有 workflow 调度 | 保持 `sync` 为纯重建语义；现有专属 `scheduler.test.ts` 先改造为针对新接口的等价测试，确保行为不变（调 `sync` 后 `registeredIds` 与旧 `reload` 一致） |
| Job 占用时间过长（workflow 步骤串行等待） | Job 级信号量默认并发 1；worker 全程异步，不阻塞 HTTP |
| SQL 步骤误操作生产库（DDL/DELETE） | 本阶段不做二次确认；文档与 UI 文案提示「SQL 将直接在该连接上执行」 |
| `mssql` 连接泄漏 | sql 步骤 `finally` 强制 `pool.close()` |
| 运行中修改 Job 定义 | 触发时快照步骤定义进 `job_step_runs`，在途运行不受影响 |
