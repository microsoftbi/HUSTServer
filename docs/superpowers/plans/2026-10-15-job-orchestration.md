# 实现计划：Job 编排

For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans

- 日期：2026-10-15
- Spec：[2026-10-15-job-orchestration-design.md](../specs/2026-10-15-job-orchestration-design.md)（commit `cfe406c`，已批准）
- 执行方式：14 个任务串行执行，每任务独立实现 + 审查 + 单独 git commit

## Goal

在 HUSTServer 中新增「Job 编排」子系统：用户可定义含**有序步骤**（运行工作流 / 运行 SQL）的 Job，每步可单独配置失败策略（abort/continue），Job 自带 1:1 调度配置；支持手动触发、运行历史与每步执行结果查看。同时把 `scheduler.ts` 泛化为通用 cron 注册表，workflow 与 job 各用一个实例。

## Spec 修正说明（相对 spec §4 DDL 的两处补充）

spec §4 的 `job_step_runs` DDL 缺两列，实现时补充（交付时需向用户说明）：

1. `config TEXT NOT NULL DEFAULT '{}'` —— worker 执行需要 workflowId/connectionId/sql。若运行时回读 `job_steps`，会破坏 §5.1「快照步骤定义，在途运行不受编辑影响」语义。
2. `on_failure TEXT NOT NULL DEFAULT 'abort'` —— §5.3 失败策略需按**快照时点**的配置执行，而非编辑后的最新配置。

## Architecture

```
jobRoutes (/api/jobs*, /api/job-runs*) → JobService.trigger/worker
JobService ── workflow 步骤 ──► RunService.trigger(opts.jobRunId) + awaitRun(runId)
          └─ sql 步骤 ────────► jobs/sql.ts（mssql 直连，解密 connections.config_encrypted）
jobScheduler（createScheduler 泛化实例）── onFire ──► JobService.trigger(jobId, {triggerType:'schedule'})
scheduler（workflow 侧同款实例）── onFire ──► RunService.trigger(workflowId, {triggerType:'schedule', scheduleId})
```

## Tech Stack

- `@hustserver/server`：Fastify 5 + better-sqlite3 ^13.0.3 + node-cron ^3.0.3 + cron-parser ^4.9.0；本阶段新增 `mssql ^12.7.4` + `@types/mssql ^12.3.0`（与 `packages/engine` 现有版本一致）
- `@hustserver/engine`：vendored，导出 `buildMssqlConfig`、`SqlServerConnection` 类型
- `@hustserver/web`：React 19 + Vite + react-router-dom 7 + Tailwind 4
- 测试：vitest（server），`app.inject` 风格

## Global Constraints（每个任务都必须遵守）

1. **Job 独立信号量**：JobService 用 `createSemaphore(1)`，绝不复用 RunService 的信号量（否则死锁：Job 占槽 → 等 run → run 等槽）。
2. **快照完整性**：`job_step_runs` 落库时同时快照 `config` 与 `on_failure` 两列。
3. **调度注册条件**：`enabled=1 且 cron_expr 非空`（`listEnabledScheduled` 的 WHERE）。
4. **PUT 整体覆盖**：先删旧 `job_steps` 再按下标重插，`seq = 数组下标`（服务端权威，不信客户端 seq）。
5. **output JSON 契约**：workflow 步骤 `{"runId":"<id>"}`；sql 步骤 `{"rowsAffected":n,"rowCount":n}`。
6. **前端轮询**：JobRunDetailPage 间隔 1s，任一终态（success/error）即停止。
7. **连接可见性**：`role==='admin' || conn.shared===1 || conn.owner_id===userId`；workflow 可见性 `role==='admin' || wf.owner_id===userId`。
8. **migrate 顺序**：`SCHEMA` → `JOB_TABLES` → 幂等 ALTER（先 `pragma('table_info(runs)')` 查列）→ `JOB_INDEXES`（`idx_runs_job_run` 必须在 ALTER 之后）。
9. **测试桩**：所有注入 `scheduler` / `jobScheduler` 的测试桩必须实现 `sync()`（新接口），不再是 `reload()`。
10. **测试时序**：schedule-routes.test 的 `sync.mockClear()` 必须放在 `buildServer` **之后**（构建期无条件 sync 一次会污染次数断言）。
11. **Trae 平台**：派发子代理绝不传 model 参数；禁用 kill/pkill。
12. **提交纪律**：每任务完成并验证通过后单独 commit，`feat:`/`refactor:`/`docs:` + 中文一句话。
13. **解密模式**：`decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex'))`，结果断言为 `SqlServerConnection`。

## Task 1：泛化 scheduler.ts 为通用 cron 注册表

**Files**
- 重写 [apps/server/src/modules/schedules/scheduler.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/modules/schedules/scheduler.ts)
- 重写 [apps/server/src/test/scheduler.test.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/test/scheduler.test.ts) → 实际路径 `apps/server/test/scheduler.test.ts`

**Interfaces**

```ts
export interface CronTask { stop(): void; destroy(): void; }
export interface CronImpl { schedule(expr: string, timezone: string, fn: () => void): CronTask | null; }
export interface CronEntry { id: string; expr: string; timezone: string; }
export interface SchedulerDeps { cronImpl?: CronImpl; onError?: (err: unknown) => void; }
export interface Scheduler {
  sync(entries: CronEntry[], onFire: (id: string) => void): void;
  start(): void;   // 用最近一次 sync 的 (entries, onFire) 重建；从未 sync 则 no-op
  stop(): void;    // 销毁全部任务，不遗忘 sync 参数
  registeredIds(): string[];
}
```

**Steps**
- [ ] 整体重写 `scheduler.ts`，删除 `SchedulesRepo`/`triggerRun` 依赖：

```ts
import cron from 'node-cron';

/** 对 node-cron 定时任务的最小抽象。 */
export interface CronTask {
  stop(): void;
  destroy(): void;
}

/** 对 node-cron 的最小抽象，便于测试注入。 */
export interface CronImpl {
  schedule(expr: string, timezone: string, fn: () => void): CronTask | null;
}

/** 一条 cron 注册项：id 为唯一键（scheduleId 或 jobId）。 */
export interface CronEntry {
  id: string;
  expr: string;
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

const defaultCronImpl: CronImpl = {
  schedule(expr, timezone, fn) {
    if (!cron.validate(expr)) return null;
    const task = cron.schedule(expr, fn, { scheduled: true, timezone });
    return { stop: () => task.stop(), destroy: () => task.stop() };
  },
};

export function createScheduler(deps: SchedulerDeps = {}): Scheduler {
  const impl = deps.cronImpl ?? defaultCronImpl;
  const tasks = new Map<string, CronTask>();
  let lastEntries: CronEntry[] = [];
  let lastOnFire: ((id: string) => void) | null = null;

  const stopAll = (): void => {
    for (const task of tasks.values()) task.destroy();
    tasks.clear();
  };

  const rebuild = (): void => {
    stopAll();
    if (!lastOnFire) return;
    for (const entry of lastEntries) {
      const task = impl.schedule(entry.expr, entry.timezone, () => {
        try {
          lastOnFire!(entry.id);
        } catch (err) {
          deps.onError?.(err);
        }
      });
      if (task) tasks.set(entry.id, task);
    }
  };

  return {
    sync(entries, onFire) {
      lastEntries = entries;
      lastOnFire = onFire;
      rebuild();
    },
    start: rebuild,
    stop: stopAll,
    registeredIds: () => [...tasks.keys()],
  };
}
```

- [ ] 整体重写 `apps/server/test/scheduler.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { createScheduler, type CronEntry, type CronImpl } from '../src/modules/schedules/scheduler.js';

function entry(over: Partial<CronEntry> & { id: string }): CronEntry {
  return { expr: '0 9 * * *', timezone: 'Asia/Shanghai', ...over };
}

/** 捕获注册信息的桩 CronImpl；'INVALID' 表达式视为非法不注册。 */
function stubCron() {
  const registered: Array<{ expr: string; tz: string; fire: () => void }> = [];
  const destroyed: string[] = [];
  const impl: CronImpl = {
    schedule(expr, timezone, fn) {
      if (expr === 'INVALID') return null;
      registered.push({ expr, tz: timezone, fire: fn });
      return { stop: () => {}, destroy: () => destroyed.push(expr) };
    },
  };
  return { registered, destroyed, impl };
}

describe('createScheduler（sync 泛化版）', () => {
  it('sync 后 registeredIds 与传入 entries 一致', () => {
    const { registered, impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' }), entry({ id: 's2', expr: '0 3 * * *' })], () => {});
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(registered.map((r) => r.expr)).toEqual(['0 9 * * *', '0 3 * * *']);
    expect(registered[0].tz).toBe('Asia/Shanghai');
  });

  it('fire 回调收到对应 id；onError 捕获不向外抛出', () => {
    const { registered, impl } = stubCron();
    const onFire = vi.fn();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' })], onFire);
    registered[0].fire();
    expect(onFire).toHaveBeenCalledWith('s1');

    const onError = vi.fn();
    const s2 = createScheduler({
      cronImpl: impl,
      onError,
    });
    s2.sync([entry({ id: 'boom' })], () => {
      throw new Error('x');
    });
    expect(() => registered[1].fire()).not.toThrow(); // registered[1] 是 s2 刚注册的 'boom'
    expect(onError).toHaveBeenCalledOnce();
  });

  it('再次 sync 全量重建并销毁旧任务', () => {
    const { destroyed, impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' })], () => {});
    expect(s.registeredIds()).toEqual(['s1']);
    s.sync([entry({ id: 's1' }), entry({ id: 's2' })], () => {});
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(destroyed.length).toBeGreaterThanOrEqual(1);
    s.sync([entry({ id: 's2' })], () => {});
    expect(s.registeredIds()).toEqual(['s2']);
  });

  it('stop 清空；start 重放最近一次 sync', () => {
    const { impl } = stubCron();
    const onFire = vi.fn();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1' })], onFire);
    s.stop();
    expect(s.registeredIds()).toEqual([]);
    s.start();
    expect(s.registeredIds()).toEqual(['s1']);
  });

  it('从未 sync 时 start 为 no-op', () => {
    const { registered, impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.start();
    expect(s.registeredIds()).toEqual([]);
    expect(registered).toHaveLength(0);
  });

  it('非法 cron 表达式不注册', () => {
    const { impl } = stubCron();
    const s = createScheduler({ cronImpl: impl });
    s.sync([entry({ id: 's1', expr: 'INVALID' })], () => {});
    expect(s.registeredIds()).toEqual([]);
  });
});
```

- [ ] 验证：`pnpm --filter @hustserver/server test`（此时 schedule-routes.test / e2e-smoke.test 会因旧 `reload` 接口失败——属预期，任务 2/10 修复；只需确认 scheduler.test 全绿）与 `pnpm --filter @hustserver/server build`（同样等待任务 2 修复编译错误，此任务先确认 scheduler.ts 自身类型无误）。
- [ ] Commit：`refactor: 泛化 scheduler 为通用 cron 注册表（sync(entries, onFire)）`

## Task 2：schedules/routes.ts 切换到 resync 回调

**Files**
- 修改 [apps/server/src/modules/schedules/routes.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/modules/schedules/routes.ts)
- 修改 [apps/server/test/schedule-routes.test.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/test/schedule-routes.test.ts)

**Interfaces**：`ScheduleRoutesDeps.scheduler: Pick<Scheduler,'reload'>` → `resync: () => void`；删除 `import type { Scheduler }`。

**Steps**
- [ ] routes.ts：
  - 删除第 10 行 `import type { Scheduler } from './scheduler.js';`
  - `ScheduleRoutesDeps` 中 `scheduler: Pick<Scheduler, 'reload'>` 改为 `resync: () => void`
  - 3 处调用（POST 创建 / PUT 更新 / DELETE 成功分支）`deps.scheduler.reload()` → `deps.resync()`
- [ ] schedule-routes.test.ts：
  - `const reload = vi.fn();` → `const sync = vi.fn();`
  - `const scheduler = { reload } as unknown as Scheduler;` → `const scheduler = { sync } as unknown as Scheduler;`
  - **删除** beforeEach 开头的 `reload.mockClear()`，改在 `await app.ready();` 之后添加 `sync.mockClear();`（构建期 server.ts 会无条件 sync 一次，必须清掉）
  - 全部 `expect(reload)` 断言改为 `expect(sync)`（PUT/DELETE 处 `toHaveBeenCalledTimes(1)` 语义不变）
- [ ] 验证：`pnpm --filter @hustserver/server test`——scheduler.test 与 schedule-routes.test 全绿（其余测试仍可能红，任务 10 后全绿）
- [ ] Commit：`refactor: schedule 路由改用 resync 回调联动调度器`

## Task 3：migrate.ts 新增 4 表 + 幂等 ALTER + 索引

**Files**
- 修改 [apps/server/src/db/migrate.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/db/migrate.ts)

**Steps**
- [ ] 在 `SCHEMA` 常量后新增 `JOB_TABLES`（注意 `job_step_runs` 比 spec DDL 多 `config` / `on_failure` 两列快照，见「Spec 修正说明」）：

```ts
const JOB_TABLES = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL DEFAULT 0,
  freq_type   TEXT,
  cron_expr   TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_steps (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,
  on_failure TEXT NOT NULL DEFAULT 'abort',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  triggered_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS job_step_runs (
  id           TEXT PRIMARY KEY,
  job_run_id   TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  step_id      TEXT,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  config       TEXT NOT NULL DEFAULT '{}',
  on_failure   TEXT NOT NULL DEFAULT 'abort',
  status       TEXT NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  error        TEXT,
  output       TEXT,
  created_at   INTEGER NOT NULL
);
`;

const JOB_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_jobs_owner        ON jobs(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_steps_job     ON job_steps(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_job_runs_job      ON job_runs(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_step_runs_run ON job_step_runs(job_run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_job_run      ON runs(job_run_id);
`;
```

- [ ] 修改 `migrate()`（不动 `SCHEMA` 常量与 runs 表原定义）：

```ts
export function migrate(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec(JOB_TABLES);
  const runCols = (db.pragma('table_info(runs)') as Array<{ name: string }>).map((c) => c.name);
  if (!runCols.includes('job_run_id')) {
    db.exec('ALTER TABLE runs ADD COLUMN job_run_id TEXT REFERENCES job_runs(id) ON DELETE SET NULL');
  }
  db.exec(JOB_INDEXES);
}
```

- [ ] 验证：`pnpm --filter @hustserver/server build` + `pnpm --filter @hustserver/server test`（现有测试全部走 `migrate(db)`，不回归即通过）
- [ ] Commit：`feat: 数据库新增 Job 编排四表与 runs.job_run_id 幂等迁移`

## Task 4：runs 层支持 job（TriggerType、jobRunId、awaitRun）

**Files**
- 修改 [apps/server/src/modules/runs/repo.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/modules/runs/repo.ts)
- 修改 [apps/server/src/modules/runs/service.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/modules/runs/service.ts)
- 修改 [apps/server/test/run-service.test.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/test/run-service.test.ts)

**Steps**
- [ ] repo.ts：
  - 第 6 行 `export type TriggerType = 'manual' | 'schedule';` → `'manual' | 'schedule' | 'job'`
  - `RunRow` 末尾（`created_at` 后）加 `job_run_id: string | null;`
  - `create` 的 input 加 `jobRunId?: string | null;`
  - `insertStmt` 改 13 列（末尾 `job_run_id`）：

```ts
  const insertStmt = db.prepare(
    'INSERT INTO runs (id,workflow_id,schedule_id,trigger_type,triggered_by,status,engine_run_id,started_at,finished_at,duration_ms,error,created_at,job_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
```

  - `create` 实现加第 13 个参数：

```ts
    create({ workflowId, scheduleId = null, triggerType, triggeredBy = null, status = 'queued', jobRunId = null }) {
      const id = nanoid(12);
      insertStmt.run(id, workflowId, scheduleId, triggerType, triggeredBy, status, null, null, null, null, null, Date.now(), jobRunId);
      return get(id)!;
    },
```

- [ ] service.ts：
  - import 行加 `RunStatus`：`import { runsRepo, type RunRow, type RunStatus, type TriggerType } from './repo.js';`
  - `RunService` 接口 `trigger` 的 opts 加 `jobRunId?: string | null;`，并新增方法签名 `awaitRun(runId: string): Promise<RunStatus>;`
  - `trigger` 实现中 `runs.create({...})` 增加 `jobRunId: opts.jobRunId ?? null,`
  - `createRunService` 内新增等待器（放在 `settle` 之后）：

```ts
  const RUN_TERMINAL = new Set<RunStatus>(['success', 'error', 'canceled']);
  const runWaiters = new Map<string, Array<(status: RunStatus) => void>>();

  /** run 到达终态后唤醒全部等待者；行已丢失时按 error 兜底。 */
  function notifyRunFinished(runId: string): void {
    const waiters = runWaiters.get(runId);
    if (!waiters) return;
    runWaiters.delete(runId);
    const row = runs.findById(runId);
    for (const w of waiters) w(row?.status ?? 'error');
  }
```

  - `worker` 整体包 try/finally（原有逻辑一行不改，仅包裹）：

```ts
  async function worker(run: RunRow): Promise<void> {
    try {
      // ……原有 worker 逻辑原样保留……
    } finally {
      notifyRunFinished(run.id);
    }
  }
```

  - 返回对象新增：

```ts
    awaitRun(runId) {
      const row = runs.findById(runId);
      if (row && RUN_TERMINAL.has(row.status)) return Promise.resolve(row.status);
      return new Promise<RunStatus>((resolve) => {
        const list = runWaiters.get(runId) ?? [];
        list.push(resolve);
        runWaiters.set(runId, list);
      });
    },
```

- [ ] run-service.test.ts 末尾（`describe('createRunService')` 内）追加：

```ts
  it('awaitRun 等待终态并返回状态；已终态立即返回', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const recorder = createRecorder(db);
    const service = createRunService({ db, config: cfg, recorder, executor: async () => { await gate; } });
    const run = service.trigger(workflowId);
    let resolved: RunStatus | undefined;
    const waiter = service.awaitRun(run.id).then((s) => { resolved = s; });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBeUndefined(); // 尚未终态，仍挂起
    release();
    await expect(waiter).resolves.toBe('success');
    expect(await service.awaitRun(run.id)).toBe('success'); // 已终态立即返回
    recorder.dispose();
  });
```

  （`RunStatus` 从 `'../src/modules/runs/repo.js'` import type。）
- [ ] 验证：`pnpm --filter @hustserver/server test` + `pnpm --filter @hustserver/server build`
- [ ] Commit：`feat: RunService 支持 job 触发与按 runId 等待终态`

## Task 5：engine 导出 buildMssqlConfig

**Files**
- 修改 [packages/engine/src/index.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/packages/engine/src/index.ts)

**Steps**
- [ ] 在 `export { tableNameForNode, quoteIdent } ...` 行后追加：

```ts
export { buildMssqlConfig } from './util/mssql.js';
```

- [ ] 验证：`pnpm --filter @hustserver/engine build`
- [ ] Commit：`refactor: engine 对外导出 buildMssqlConfig`

## Task 6：jobs/repo.ts 三个仓储 + 测试

**Files**
- 新增 `apps/server/src/modules/jobs/repo.ts`
- 新增 `apps/server/test/job-repo.test.ts`

**Steps**
- [ ] 新建 `repo.ts`：

```ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { FreqType } from '../schedules/cron.js';

export type JobStepType = 'workflow' | 'sql';
export type JobOnFailure = 'abort' | 'continue';
export type JobRunStatus = 'queued' | 'running' | 'success' | 'error';
export type JobStepRunStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

export interface JobRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  enabled: number;
  freq_type: FreqType | null;
  cron_expr: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
}

export interface JobStepRow {
  id: string;
  job_id: string;
  seq: number;
  type: JobStepType;
  name: string;
  config: string;
  on_failure: JobOnFailure;
  created_at: number;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  trigger_type: 'manual' | 'schedule';
  triggered_by: string | null;
  status: JobRunStatus;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

export interface JobStepRunRow {
  id: string;
  job_run_id: string;
  step_id: string | null;
  seq: number;
  type: JobStepType;
  name: string;
  config: string;
  on_failure: JobOnFailure;
  status: JobStepRunStatus;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  output: string | null;
  created_at: number;
}

export interface JobStepInput {
  type: JobStepType;
  name: string;
  config: string;
  onFailure: JobOnFailure;
}

export interface JobsRepo {
  create(input: {
    ownerId: string;
    name: string;
    description: string | null;
    enabled: boolean;
    freqType: FreqType | null;
    cronExpr: string | null;
    timezone: string;
    steps: JobStepInput[];
  }): JobRow;
  update(
    id: string,
    input: {
      name: string;
      description: string | null;
      enabled: boolean;
      freqType: FreqType | null;
      cronExpr: string | null;
      timezone: string;
      steps: JobStepInput[];
    },
  ): JobRow | null;
  findById(id: string): JobRow | null;
  listForOwner(ownerId: string): JobRow[];
  listAll(): JobRow[];
  listEnabledScheduled(): JobRow[];
  remove(id: string): boolean;
  listSteps(jobId: string): JobStepRow[];
}

export function jobsRepo(db: Database): JobsRepo {
  const getStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const insertJobStmt = db.prepare(
    'INSERT INTO jobs (id,owner_id,name,description,enabled,freq_type,cron_expr,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const updateJobStmt = db.prepare(
    'UPDATE jobs SET name=?,description=?,enabled=?,freq_type=?,cron_expr=?,timezone=?,updated_at=? WHERE id=?',
  );
  const insertStepStmt = db.prepare(
    'INSERT INTO job_steps (id,job_id,seq,type,name,config,on_failure,created_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const deleteStepsStmt = db.prepare('DELETE FROM job_steps WHERE job_id = ?');
  const ownerStmt = db.prepare('SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at DESC');
  const allStmt = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC');
  const enabledScheduledStmt = db.prepare(
    "SELECT * FROM jobs WHERE enabled = 1 AND cron_expr IS NOT NULL AND cron_expr != ''",
  );
  const deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  const stepsStmt = db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY seq ASC');
  const get = (id: string): JobRow | null => (getStmt.get(id) as JobRow | undefined) ?? null;
  const getSteps = (jobId: string): JobStepRow[] => stepsStmt.all(jobId) as JobStepRow[];

  const writeSteps = (jobId: string, steps: JobStepInput[], now: number): void => {
    deleteStepsStmt.run(jobId);
    steps.forEach((s, i) => {
      insertStepStmt.run(nanoid(12), jobId, i, s.type, s.name, s.config, s.onFailure, now);
    });
  };

  return {
    create(input) {
      const id = nanoid(12);
      const now = Date.now();
      db.transaction(() => {
        insertJobStmt.run(
          id, input.ownerId, input.name, input.description, input.enabled ? 1 : 0,
          input.freqType, input.cronExpr, input.timezone, now, now,
        );
        writeSteps(id, input.steps, now);
      })();
      return get(id)!;
    },
    update(id, input) {
      const cur = get(id);
      if (!cur) return null;
      const now = Date.now();
      db.transaction(() => {
        updateJobStmt.run(
          input.name, input.description, input.enabled ? 1 : 0,
          input.freqType, input.cronExpr, input.timezone, now, id,
        );
        writeSteps(id, input.steps, now);
      })();
      return get(id);
    },
    findById: get,
    listForOwner: (ownerId) => ownerStmt.all(ownerId) as JobRow[],
    listAll: () => allStmt.all() as JobRow[],
    listEnabledScheduled: () => enabledScheduledStmt.all() as JobRow[],
    remove: (id) => deleteJobStmt.run(id).changes > 0,
    listSteps: getSteps,
  };
}

export interface JobRunsRepo {
  create(input: { jobId: string; triggerType: 'manual' | 'schedule'; triggeredBy: string | null }): JobRunRow;
  findById(id: string): JobRunRow | null;
  markRunning(id: string, startedAt: number): void;
  finish(id: string, patch: { status: JobRunStatus; finishedAt: number; durationMs: number | null; error: string | null }): void;
  listByJob(jobId: string, opts: { limit: number; offset: number }): JobRunRow[];
  countByJob(jobId: string): number;
}

export function jobRunsRepo(db: Database): JobRunsRepo {
  const getStmt = db.prepare('SELECT * FROM job_runs WHERE id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO job_runs (id,job_id,trigger_type,triggered_by,status,started_at,finished_at,duration_ms,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const markRunningStmt = db.prepare("UPDATE job_runs SET status='running', started_at=? WHERE id=?");
  const finishStmt = db.prepare('UPDATE job_runs SET status=?, finished_at=?, duration_ms=?, error=? WHERE id=?');
  const listStmt = db.prepare('SELECT * FROM job_runs WHERE job_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM job_runs WHERE job_id=?');
  const get = (id: string): JobRunRow | null => (getStmt.get(id) as JobRunRow | undefined) ?? null;
  return {
    create({ jobId, triggerType, triggeredBy }) {
      const id = nanoid(12);
      insertStmt.run(id, jobId, triggerType, triggeredBy, 'queued', null, null, null, null, Date.now());
      return get(id)!;
    },
    findById: get,
    markRunning: (id, startedAt) => markRunningStmt.run(startedAt, id),
    finish: (id, patch) => finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error, id),
    listByJob: (jobId, { limit, offset }) => listStmt.all(jobId, limit, offset) as JobRunRow[],
    countByJob: (jobId) => Number((countStmt.get(jobId) as { c: number }).c),
  };
}

export interface JobStepRunsRepo {
  createBatch(
    jobRunId: string,
    steps: Array<{ stepId: string | null; seq: number; type: JobStepType; name: string; config: string; onFailure: JobOnFailure }>,
  ): void;
  listByJobRun(jobRunId: string): JobStepRunRow[];
  markRunning(id: string, startedAt: number): void;
  finish(id: string, patch: { status: JobStepRunStatus; finishedAt: number; durationMs: number | null; error?: string | null; output?: string | null }): void;
  /** 把从 fromSeq 起的所有 pending 步骤标记为 skipped。 */
  skipRemaining(jobRunId: string, fromSeq: number): void;
  findById(id: string): JobStepRunRow | null;
}

export function jobStepRunsRepo(db: Database): JobStepRunsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO job_step_runs (id,job_run_id,step_id,seq,type,name,config,on_failure,status,started_at,finished_at,duration_ms,error,output,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const listStmt = db.prepare('SELECT * FROM job_step_runs WHERE job_run_id=? ORDER BY seq ASC');
  const markRunningStmt = db.prepare("UPDATE job_step_runs SET status='running', started_at=? WHERE id=?");
  const finishStmt = db.prepare('UPDATE job_step_runs SET status=?, finished_at=?, duration_ms=?, error=?, output=? WHERE id=?');
  const skipStmt = db.prepare(
    "UPDATE job_step_runs SET status='skipped', finished_at=? WHERE job_run_id=? AND seq>=? AND status='pending'",
  );
  const getStmt = db.prepare('SELECT * FROM job_step_runs WHERE id=?');
  const get = (id: string): JobStepRunRow | null => (getStmt.get(id) as JobStepRunRow | undefined) ?? null;
  return {
    createBatch(jobRunId, steps) {
      const now = Date.now();
      db.transaction(() => {
        for (const s of steps) {
          insertStmt.run(nanoid(12), jobRunId, s.stepId, s.seq, s.type, s.name, s.config, s.onFailure, 'pending', null, null, null, null, null, now);
        }
      })();
    },
    listByJobRun: (jobRunId) => listStmt.all(jobRunId) as JobStepRunRow[],
    markRunning: (id, startedAt) => markRunningStmt.run(startedAt, id),
    finish: (id, patch) =>
      finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error ?? null, patch.output ?? null, id),
    skipRemaining: (jobRunId, fromSeq) => skipStmt.run(Date.now(), jobRunId, fromSeq),
    findById: get,
  };
}
```

- [ ] 新建 `job-repo.test.ts`：

```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { jobRunsRepo, jobStepRunsRepo, jobsRepo, type JobStepInput } from '../src/modules/jobs/repo.js';
import { usersRepo } from '../src/modules/users/repo.js';

const STEPS: JobStepInput[] = [
  { type: 'workflow', name: '日结', config: JSON.stringify({ workflowId: 'w1' }), onFailure: 'abort' },
  { type: 'sql', name: '归档', config: JSON.stringify({ connectionId: 'c1', sql: 'DELETE FROM t' }), onFailure: 'continue' },
];

const BASE = { ownerId: '', description: null, freqType: null, cronExpr: null, timezone: 'Asia/Shanghai' } as const;

let db: Database.Database;
let ownerId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', role: 'user' }).id;
});

describe('jobsRepo', () => {
  it('create/listSteps：seq 按数组下标，快照字段可回读', () => {
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: '流水线', enabled: false, steps: STEPS });
    expect(job.id).toBeTruthy();
    expect(job.enabled).toBe(0);
    const steps = jobsRepo(db).listSteps(job.id);
    expect(steps.map((s) => s.seq)).toEqual([0, 1]);
    expect(steps[1].on_failure).toBe('continue');
    expect(JSON.parse(steps[0].config)).toEqual({ workflowId: 'w1' });
  });

  it('update 整体覆盖：删除旧 steps 重插', () => {
    const repo = jobsRepo(db);
    const job = repo.create({ ...BASE, ownerId, name: 'A', enabled: false, steps: STEPS });
    const updated = repo.update(job.id, {
      name: 'B', description: 'd', enabled: true, freqType: 'daily', cronExpr: '0 8 * * *',
      timezone: 'Asia/Shanghai', steps: [STEPS[1]],
    })!;
    expect(updated.name).toBe('B');
    expect(updated.enabled).toBe(1);
    expect(updated.cron_expr).toBe('0 8 * * *');
    const steps = repo.listSteps(job.id);
    expect(steps).toHaveLength(1);
    expect(steps[0].seq).toBe(0);
  });

  it('listEnabledScheduled 只返回 enabled=1 且 cron_expr 非空', () => {
    const repo = jobsRepo(db);
    repo.create({ ...BASE, ownerId, name: '关', enabled: false, freqType: 'daily', cronExpr: '0 8 * * *', steps: STEPS });
    repo.create({ ...BASE, ownerId, name: '开但无cron', enabled: true, steps: STEPS });
    const on = repo.create({ ...BASE, ownerId, name: '开且有cron', enabled: true, freqType: 'daily', cronExpr: '0 8 * * *', steps: STEPS });
    expect(repo.listEnabledScheduled().map((j) => j.id)).toEqual([on.id]);
  });

  it('remove 级联删除 steps；listForOwner/listAll', () => {
    const repo = jobsRepo(db);
    const j1 = repo.create({ ...BASE, ownerId, name: 'j1', enabled: false, steps: STEPS });
    repo.create({ ...BASE, ownerId, name: 'j2', enabled: false, steps: STEPS });
    expect(repo.listForOwner(ownerId)).toHaveLength(2);
    expect(repo.listAll()).toHaveLength(2);
    expect(repo.remove(j1.id)).toBe(true);
    expect(repo.findById(j1.id)).toBeNull();
    expect(repo.listSteps(j1.id)).toHaveLength(0);
  });
});

describe('jobRunsRepo / jobStepRunsRepo', () => {
  it('run 生命周期、step 快照与 skipRemaining', () => {
    const jobs = jobsRepo(db);
    const runs = jobRunsRepo(db);
    const stepRuns = jobStepRunsRepo(db);
    const job = jobs.create({ ...BASE, ownerId, name: 'j', enabled: false, steps: STEPS });

    const jobRun = runs.create({ jobId: job.id, triggerType: 'manual', triggeredBy: ownerId });
    expect(jobRun.status).toBe('queued');

    stepRuns.createBatch(jobRun.id, jobs.listSteps(job.id).map((s) => ({
      stepId: s.id, seq: s.seq, type: s.type, name: s.name, config: s.config, onFailure: s.on_failure,
    })));
    const batch = stepRuns.listByJobRun(jobRun.id);
    expect(batch).toHaveLength(2);
    expect(batch.every((s) => s.status === 'pending')).toBe(true);
    expect(batch[0].config).toBe(STEPS[0].config);
    expect(batch[0].on_failure).toBe('abort');

    stepRuns.markRunning(batch[0].id, 1);
    stepRuns.finish(batch[0].id, { status: 'error', finishedAt: 2, durationMs: 1, error: 'boom' });
    expect(stepRuns.findById(batch[0].id)!.status).toBe('error');

    stepRuns.skipRemaining(jobRun.id, 1);
    expect(stepRuns.findById(batch[1].id)!.status).toBe('skipped');

    runs.markRunning(jobRun.id, 3);
    runs.finish(jobRun.id, { status: 'error', finishedAt: 5, durationMs: 2, error: 'boom' });
    expect(runs.findById(jobRun.id)!.status).toBe('error');
    expect(runs.countByJob(job.id)).toBe(1);
    expect(runs.listByJob(job.id, { limit: 10, offset: 0 })).toHaveLength(1);
  });
});
```

- [ ] 验证：`pnpm --filter @hustserver/server test`
- [ ] Commit：`feat: Job 编排数据仓储（jobs/job_runs/job_step_runs）`

## Task 7：jobs/sql.ts + server 新增 mssql 依赖

**Files**
- 新增 `apps/server/src/modules/jobs/sql.ts`
- 修改 [apps/server/package.json](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/package.json)

**Steps**
- [ ] `package.json` dependencies（`fastify` 与 `nanoid` 之间）加 `"mssql": "^12.7.4"`；devDependencies（`@types/better-sqlite3` 与 `@types/node-cron` 之间）加 `"@types/mssql": "^12.3.0"`；运行 `pnpm install`
- [ ] 新建 `sql.ts`：

```ts
import sql from 'mssql';
import { buildMssqlConfig, type SqlServerConnection } from '@hustserver/engine';

export interface SqlExecResult {
  rowsAffected: number;
  rowCount: number;
}

export type SqlExecutor = (connConfig: SqlServerConnection, sqlText: string) => Promise<SqlExecResult>;

/** 默认执行器：mssql 直连；无论成败都在 finally 关闭连接池。 */
export const defaultSqlExecutor: SqlExecutor = async (connConfig, sqlText) => {
  const pool = new sql.ConnectionPool(buildMssqlConfig(connConfig));
  await pool.connect();
  try {
    const result = await pool.request().query(sqlText);
    return {
      rowsAffected: result.rowsAffected.reduce((sum, n) => sum + n, 0),
      rowCount: result.recordset?.length ?? 0,
    };
  } finally {
    await pool.close();
  }
};
```

- [ ] 验证：`pnpm --filter @hustserver/server build` + `pnpm install` 成功
- [ ] Commit：`feat: Job SQL 步骤执行器（mssql 直连）`

## Task 8：jobs/service.ts 执行引擎 + 测试

**Files**
- 新增 `apps/server/src/modules/jobs/service.ts`
- 新增 `apps/server/test/job-service.test.ts`

**Steps**
- [ ] 新建 `service.ts`：

```ts
import type { SqlServerConnection } from '@hustserver/engine';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { createSemaphore } from '../runs/queue.js';
import { runsRepo } from '../runs/repo.js';
import type { RunService } from '../runs/service.js';
import { jobRunsRepo, jobStepRunsRepo, jobsRepo, type JobRunRow, type JobStepRunRow } from './repo.js';
import { defaultSqlExecutor, type SqlExecutor } from './sql.js';

export interface JobServiceDeps {
  db: Database;
  config: AppConfig;
  runService: RunService;
  sqlExecutor?: SqlExecutor;
}

export interface JobService {
  trigger(jobId: string, opts?: { triggerType?: 'manual' | 'schedule'; triggeredBy?: string | null }): JobRunRow;
  whenIdle(): Promise<void>;
}

export function createJobService(deps: JobServiceDeps): JobService {
  const { db, config, runService } = deps;
  const jobs = jobsRepo(db);
  const jobRuns = jobRunsRepo(db);
  const stepRuns = jobStepRunsRepo(db);
  const connections = connectionsRepo(db);
  const runs = runsRepo(db);
  const runSql = deps.sqlExecutor ?? defaultSqlExecutor;
  // Job 级独立信号量（并发 1）：绝不复用 run 的信号量，否则 workflow 步骤会死锁
  const sem = createSemaphore(1);

  let pending = 0;
  let idleResolvers: Array<() => void> = [];
  function settle(): void {
    pending -= 1;
    if (pending === 0) {
      const waiters = idleResolvers;
      idleResolvers = [];
      for (const w of waiters) w();
    }
  }

  /** 执行单个步骤并落 job_step_runs；永不抛出（异常归一为步骤失败）。 */
  async function executeStep(step: JobStepRunRow, jobRun: JobRunRow): Promise<{ ok: boolean; error: string | null }> {
    const startedAt = Date.now();
    stepRuns.markRunning(step.id, startedAt);
    let output: string | null = null;
    const done = (ok: boolean, error: string | null): { ok: boolean; error: string | null } => {
      const finishedAt = Date.now();
      stepRuns.finish(step.id, {
        status: ok ? 'success' : 'error',
        finishedAt,
        durationMs: finishedAt - startedAt,
        error,
        output,
      });
      return { ok, error };
    };
    try {
      if (step.type === 'workflow') {
        const stepCfg = JSON.parse(step.config) as { workflowId?: string };
        if (!stepCfg.workflowId) throw new Error('步骤缺少 workflowId');
        const run = runService.trigger(stepCfg.workflowId, {
          triggerType: 'job',
          triggeredBy: jobRun.triggered_by,
          jobRunId: jobRun.id,
        });
        output = JSON.stringify({ runId: run.id });
        const status = await runService.awaitRun(run.id);
        if (status !== 'success') {
          return done(false, runs.findById(run.id)?.error ?? '工作流执行失败');
        }
        return done(true, null);
      }
      const stepCfg = JSON.parse(step.config) as { connectionId?: string; sql?: string };
      if (!stepCfg.connectionId) throw new Error('步骤缺少 connectionId');
      if (!stepCfg.sql?.trim()) throw new Error('SQL 不能为空');
      const conn = connections.findById(stepCfg.connectionId);
      if (!conn) throw new Error('连接不存在');
      const connConfig = decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex')) as SqlServerConnection;
      const result = await runSql(connConfig, stepCfg.sql);
      output = JSON.stringify(result);
      return done(true, null);
    } catch (err) {
      return done(false, err instanceof Error ? err.message : String(err));
    }
  }

  async function worker(jobRun: JobRunRow): Promise<void> {
    const startedAt = Date.now();
    try {
      jobRuns.markRunning(jobRun.id, startedAt);
      const steps = stepRuns.listByJobRun(jobRun.id);
      let anyFailed = false;
      for (const step of steps) {
        if (step.status !== 'pending') continue;
        const result = await executeStep(step, jobRun);
        if (!result.ok) {
          anyFailed = true;
          if (step.on_failure === 'abort') {
            stepRuns.skipRemaining(jobRun.id, step.seq + 1);
            const finishedAt = Date.now();
            jobRuns.finish(jobRun.id, {
              status: 'error', finishedAt, durationMs: finishedAt - startedAt, error: result.error,
            });
            return;
          }
        }
      }
      const finishedAt = Date.now();
      jobRuns.finish(jobRun.id, {
        status: anyFailed ? 'error' : 'success',
        finishedAt,
        durationMs: finishedAt - startedAt,
        error: anyFailed ? '部分步骤执行失败' : null,
      });
    } finally {
      // 兜底：意外终止时仍处于 queued/running 的 job_run 置 error，避免永远挂起
      const cur = jobRuns.findById(jobRun.id);
      if (cur && (cur.status === 'queued' || cur.status === 'running')) {
        const finishedAt = Date.now();
        jobRuns.finish(jobRun.id, {
          status: 'error', finishedAt, durationMs: finishedAt - startedAt, error: 'Job worker 意外终止',
        });
      }
    }
  }

  return {
    trigger(jobId, opts = {}) {
      const job = jobs.findById(jobId);
      if (!job) throw new Error('Job 不存在');
      const steps = jobs.listSteps(jobId);
      if (steps.length === 0) throw new Error('Job 没有可执行的步骤');
      const jobRun = jobRuns.create({
        jobId,
        triggerType: opts.triggerType ?? 'manual',
        triggeredBy: opts.triggeredBy ?? null,
      });
      stepRuns.createBatch(jobRun.id, steps.map((s) => ({
        stepId: s.id, seq: s.seq, type: s.type, name: s.name, config: s.config, onFailure: s.on_failure,
      })));
      pending += 1;
      void sem
        .run(() => worker(jobRun))
        .catch(() => {
          /* worker 的 finally 已兜底落库，此处仅防未捕获拒绝 */
        })
        .finally(settle);
      return jobRun;
    },
    whenIdle() {
      if (pending === 0) return Promise.resolve();
      return new Promise<void>((res) => {
        idleResolvers.push(res);
      });
    },
  };
}
```

- [ ] 新建 `job-service.test.ts`：

```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { jobRunsRepo, jobStepRunsRepo, jobsRepo, type JobStepInput } from '../src/modules/jobs/repo.js';
import { createJobService } from '../src/modules/jobs/service.js';
import { runsRepo } from '../src/modules/runs/repo.js';
import type { RunService, RunStatus } from '../src/modules/runs/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const WF_PAYLOAD = JSON.stringify({ nodes: [], edges: [] });

function wfStep(workflowId: string, onFailure: 'abort' | 'continue' = 'abort'): JobStepInput {
  return { type: 'workflow', name: '跑工作流', config: JSON.stringify({ workflowId }), onFailure };
}
function sqlStep(onFailure: 'abort' | 'continue' = 'abort'): JobStepInput {
  return { type: 'sql', name: '跑SQL', config: JSON.stringify({ connectionId: 'c1', sql: 'SELECT 1' }), onFailure };
}

/** 假 RunService：trigger 直落终态 run；awaitRun 返回预设结果。 */
function fakeRunService(outcome: RunStatus): RunService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    trigger(workflowIdArg, opts) {
      calls.push(workflowIdArg);
      const run = runsRepo(db).create({
        workflowId: workflowIdArg,
        triggerType: opts?.triggerType ?? 'manual',
        triggeredBy: opts?.triggeredBy ?? null,
        jobRunId: opts?.jobRunId ?? null,
      });
      runsRepo(db).finish(run.id, {
        status: outcome, finishedAt: Date.now(), durationMs: 0,
        error: outcome === 'error' ? '工作流炸了' : null,
      });
      return run;
    },
    async whenIdle() {},
    async awaitRun() {
      return outcome;
    },
  } as unknown as RunService & { calls: string[] };
}

const BASE = { ownerId: '', description: null, freqType: null, cronExpr: null, timezone: 'Asia/Shanghai' } as const;

let db: Database.Database;
let ownerId: string;
let workflowId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', role: 'user' }).id;
  workflowId = workflowsRepo(db).create({ ownerId, name: 'W', payload: WF_PAYLOAD }).id;
});

describe('createJobService', () => {
  it('全部成功 → success；workflow/sql 步骤 output 符合契约', async () => {
    const runService = fakeRunService('success');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 3, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [wfStep(workflowId), sqlStep()] });
    const jobRun = service.trigger(job.id);
    expect(jobRun.status).toBe('queued');
    await service.whenIdle();
    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('success');
    expect(detail.error).toBeNull();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['success', 'success']);
    expect(JSON.parse(steps[0].output!)).toEqual({ runId: expect.any(String) });
    expect(JSON.parse(steps[1].output!)).toEqual({ rowsAffected: 3, rowCount: 0 });
    expect(runService.calls).toEqual([workflowId]);
  });

  it('abort：首步失败后剩余步骤 skipped，job_runs error 且 error 取自步骤', async () => {
    const runService = fakeRunService('error');
    const service = createJobService({ db, config: cfg, runService });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [wfStep(workflowId, 'abort'), sqlStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('error');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['error', 'skipped']);
    expect(steps[0].error).toBe('工作流炸了');
  });

  it('continue：首步失败仍执行后续步骤，最终 error', async () => {
    const runService = fakeRunService('error');
    const sqlExecutor = vi.fn(async () => ({ rowsAffected: 1, rowCount: 0 }));
    const service = createJobService({ db, config: cfg, runService, sqlExecutor });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [wfStep(workflowId, 'continue'), sqlStep('continue')] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const detail = jobRunsRepo(db).findById(jobRun.id)!;
    expect(detail.status).toBe('error');
    expect(detail.error).toBe('部分步骤执行失败');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['error', 'success']);
  });

  it('sql 步骤连接不存在时步骤失败', async () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [sqlStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].error).toBe('连接不存在');
    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('error');
  });

  it('Job 不存在或无步骤时抛错', () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    expect(() => service.trigger('missing')).toThrow('Job 不存在');
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: '空', enabled: false, steps: [] });
    expect(() => service.trigger(job.id)).toThrow('Job 没有可执行的步骤');
  });
});
```

- [ ] 验证：`pnpm --filter @hustserver/server test`
- [ ] Commit：`feat: JobService 顺序执行引擎（abort/continue 失败策略）`

## Task 9：jobs/routes.ts 八个端点 + 测试

**Files**
- 新增 `apps/server/src/modules/jobs/routes.ts`
- 新增 `apps/server/test/job-routes.test.ts`

**Steps**
- [ ] 新建 `routes.ts`：

```ts
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import { connectionsRepo } from '../connections/repo.js';
import { CronFormatError, isFreqType, nextRunAt, presetToCron, validateCron, type FreqType } from '../schedules/cron.js';
import type { Role, UsersRepo } from '../users/repo.js';
import { workflowsRepo } from '../workflows/repo.js';
import {
  jobRunsRepo, jobStepRunsRepo, jobsRepo,
  type JobOnFailure, type JobRow, type JobStepInput,
} from './repo.js';
import type { JobService } from './service.js';

export interface JobRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  jobService: JobService;
  resync: () => void;
}

interface StepBody {
  type?: unknown;
  name?: unknown;
  onFailure?: unknown;
  workflowId?: unknown;
  connectionId?: unknown;
  sql?: unknown;
}

interface JobBody {
  name?: unknown;
  description?: unknown;
  steps?: unknown;
  schedule?: {
    enabled?: unknown;
    freqType?: unknown;
    time?: unknown;
    weekday?: unknown;
    monthDay?: unknown;
    cronExpr?: unknown;
    timezone?: unknown;
  };
}

interface ParsedSchedule {
  enabled: boolean;
  freqType: FreqType | null;
  cronExpr: string | null;
  timezone: string;
}

export function jobRoutes(app: FastifyInstance, deps: JobRoutesDeps): void {
  const jobs = jobsRepo(deps.db);
  const jobRuns = jobRunsRepo(deps.db);
  const stepRuns = jobStepRunsRepo(deps.db);
  const workflows = workflowsRepo(deps.db);
  const connections = connectionsRepo(deps.db);
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });
  const defaultTimezone = deps.config.tz;

  const canAccess = (ownerId: string, role: Role, userId: string): boolean =>
    role === 'admin' || ownerId === userId;
  const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

  const nextRun = (job: JobRow): number | null =>
    job.enabled && job.cron_expr ? nextRunAt(job.cron_expr, job.timezone) : null;

  /** 按归属校验 Job；不通过时已发送响应并返回 null。 */
  function loadJob(id: string, role: Role, userId: string, reply: FastifyReply): JobRow | null {
    const job = jobs.findById(id);
    if (!job) {
      reply.code(404).send({ error: 'Job 不存在' });
      return null;
    }
    if (!canAccess(job.owner_id, role, userId)) {
      reply.code(403).send({ error: '无权访问' });
      return null;
    }
    return job;
  }

  /** 解析并校验请求体；失败时已发送响应并返回 null。 */
  function parseBody(
    raw: JobBody,
    role: Role,
    userId: string,
    reply: FastifyReply,
  ): { name: string; description: string | null; steps: JobStepInput[]; schedule: ParsedSchedule } | null {
    const name = asString(raw.name);
    if (!name) {
      reply.code(400).send({ error: 'name 不能为空' });
      return null;
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      reply.code(400).send({ error: 'steps 至少需要一条' });
      return null;
    }
    const steps: JobStepInput[] = [];
    for (const item of raw.steps as StepBody[]) {
      const stepName = asString(item.name) ?? '';
      const onFailure: JobOnFailure = item.onFailure === 'continue' ? 'continue' : 'abort';
      if (item.type === 'workflow') {
        const workflowId = asString(item.workflowId);
        const wf = workflowId ? workflows.findById(workflowId) : null;
        if (!wf || !canAccess(wf.owner_id, role, userId)) {
          reply.code(400).send({ error: '工作流不可用' });
          return null;
        }
        steps.push({ type: 'workflow', name: stepName, config: JSON.stringify({ workflowId }), onFailure });
      } else if (item.type === 'sql') {
        const connectionId = asString(item.connectionId);
        const sqlText = asString(item.sql);
        const conn = connectionId ? connections.findById(connectionId) : null;
        if (!conn || !(role === 'admin' || conn.shared === 1 || conn.owner_id === userId)) {
          reply.code(400).send({ error: '连接不可用' });
          return null;
        }
        if (!sqlText) {
          reply.code(400).send({ error: 'SQL 不能为空' });
          return null;
        }
        steps.push({ type: 'sql', name: stepName, config: JSON.stringify({ connectionId, sql: sqlText }), onFailure });
      } else {
        reply.code(400).send({ error: '步骤类型无效' });
        return null;
      }
    }
    const sch = raw.schedule ?? { enabled: false };
    if (sch.enabled === true) {
      const freqType = isFreqType(sch.freqType) ? sch.freqType : null;
      if (!freqType) {
        reply.code(400).send({ error: 'freqType 无效' });
        return null;
      }
      const timezone = asString(sch.timezone) ?? defaultTimezone;
      let cronExpr: string;
      try {
        cronExpr = presetToCron({
          freqType,
          time: asString(sch.time),
          weekday: asNumber(sch.weekday),
          monthDay: asNumber(sch.monthDay),
          cronExpr: asString(sch.cronExpr),
        });
      } catch (err) {
        if (err instanceof CronFormatError) {
          reply.code(400).send({ error: err.message });
          return null;
        }
        throw err;
      }
      if (!validateCron(cronExpr, timezone)) {
        reply.code(400).send({ error: 'cron 表达式或时区无效' });
        return null;
      }
      return { name, description: asString(raw.description) ?? null, steps, schedule: { enabled: true, freqType, cronExpr, timezone } };
    }
    return {
      name, description: asString(raw.description) ?? null, steps,
      schedule: { enabled: false, freqType: null, cronExpr: null, timezone: defaultTimezone },
    };
  }

  function toDetail(job: JobRow) {
    return {
      ...job,
      nextRunAt: nextRun(job),
      steps: jobs.listSteps(job.id).map((s) => ({ ...s, config: JSON.parse(s.config) as unknown })),
      schedule: {
        enabled: job.enabled === 1,
        freqType: job.freq_type,
        cronExpr: job.cron_expr,
        timezone: job.timezone,
      },
    };
  }

  app.get('/api/jobs', { preHandler: guard }, async (req) => {
    const { role, userId } = req.auth!;
    const rows = role === 'admin' ? jobs.listAll() : jobs.listForOwner(userId);
    const items = rows.map((job) => {
      const lastRun = jobRuns.listByJob(job.id, { limit: 1, offset: 0 })[0] ?? null;
      return {
        ...job,
        stepCount: jobs.listSteps(job.id).length,
        nextRunAt: nextRun(job),
        lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, created_at: lastRun.created_at } : null,
      };
    });
    return { items };
  });

  app.post('/api/jobs', { preHandler: guard }, async (req, reply) => {
    const parsed = parseBody((req.body ?? {}) as JobBody, req.auth!.role, req.auth!.userId, reply);
    if (!parsed) return reply;
    const job = jobs.create({
      ownerId: req.auth!.userId, name: parsed.name, description: parsed.description,
      enabled: parsed.schedule.enabled, freqType: parsed.schedule.freqType,
      cronExpr: parsed.schedule.cronExpr, timezone: parsed.schedule.timezone, steps: parsed.steps,
    });
    deps.resync();
    return reply.code(201).send(toDetail(job));
  });

  app.get('/api/jobs/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.role, req.auth!.userId, reply);
    if (!job) return reply;
    return toDetail(job);
  });

  app.put('/api/jobs/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.role, req.auth!.userId, reply);
    if (!job) return reply;
    const parsed = parseBody((req.body ?? {}) as JobBody, req.auth!.role, req.auth!.userId, reply);
    if (!parsed) return reply;
    const updated = jobs.update(id, {
      name: parsed.name, description: parsed.description,
      enabled: parsed.schedule.enabled, freqType: parsed.schedule.freqType,
      cronExpr: parsed.schedule.cronExpr, timezone: parsed.schedule.timezone, steps: parsed.steps,
    })!;
    deps.resync();
    return toDetail(updated);
  });

  app.delete('/api/jobs/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.role, req.auth!.userId, reply);
    if (!job) return reply;
    jobs.remove(id);
    deps.resync();
    return { ok: true };
  });

  app.post('/api/jobs/:id/runs', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.role, req.auth!.userId, reply);
    if (!job) return reply;
    try {
      const jobRun = deps.jobService.trigger(id, { triggerType: 'manual', triggeredBy: req.auth!.userId });
      return reply.code(202).send({ jobRunId: jobRun.id });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : '触发失败' });
    }
  });

  app.get('/api/jobs/:id/runs', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = loadJob(id, req.auth!.role, req.auth!.userId, reply);
    if (!job) return reply;
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 20) || 20, 1), 100);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    return { total: jobRuns.countByJob(id), items: jobRuns.listByJob(id, { limit, offset }) };
  });

  app.get('/api/job-runs/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobRun = jobRuns.findById(id);
    if (!jobRun) return reply.code(404).send({ error: 'Job 运行不存在' });
    const job = jobs.findById(jobRun.job_id);
    if (!job || !canAccess(job.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    return { jobRun, steps: stepRuns.listByJobRun(id) };
  });
}
```

- [ ] 新建 `job-routes.test.ts`：

```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { encryptConfig } from '../src/modules/connections/crypto.js';
import { connectionsRepo } from '../src/modules/connections/repo.js';
import { migrate } from '../src/db/migrate.js';
import type { JobService } from '../src/modules/jobs/service.js';
import type { Recorder } from '../src/modules/runs/recorder.js';
import type { RunService } from '../src/modules/runs/service.js';
import type { Scheduler } from '../src/modules/schedules/scheduler.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-job-routes-'));
const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
});

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;
let workflowId: string;
let sharedConnId: string;
const triggerJob = vi.fn();

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  const alice = await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), role: 'user' });

  const recorder = {} as Recorder;
  const runService = { trigger: vi.fn(), whenIdle: async () => {} } as unknown as RunService;
  const scheduler = { sync: vi.fn(), start() {}, stop() {}, registeredIds: () => [] } as unknown as Scheduler;
  const jobScheduler = { sync: vi.fn(), start() {}, stop() {}, registeredIds: () => [] } as unknown as Scheduler;
  const jobService = { trigger: triggerJob, whenIdle: async () => {} } as unknown as JobService;

  app = await buildServer({
    db, config: cfg, logger: false,
    overrides: { recorder, runService, scheduler, jobService, jobScheduler },
  });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');

  const wf = await app.inject({
    method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie },
    payload: { workflow: { id: 'w', name: '样例', createdAt: 0, updatedAt: 0, nodes: [], edges: [] }, mappings: [] },
  });
  workflowId = wf.json().id;
  sharedConnId = connectionsRepo(db).create({
    ownerId: alice.id, name: '共享库', type: 'sqlserver',
    configEncrypted: encryptConfig({ server: '127.0.0.1', database: 'd', user: 'sa', password: 'p' }, cfg.encryptionKey.toString('hex')),
    shared: true,
  }).id;
  triggerJob.mockClear();
});

describe('job routes', () => {
  it('POST 创建 Job 并 resync；GET 列表含 stepCount/nextRunAt/lastRun', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: {
        name: '日结', description: 'd',
        steps: [{ type: 'workflow', name: 's1', workflowId, onFailure: 'abort' }],
        schedule: { enabled: true, freqType: 'daily', time: '08:00' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().schedule).toMatchObject({ enabled: true, freqType: 'daily', cronExpr: '0 8 * * *' });
    expect(res.json().steps[0].config).toEqual({ workflowId });

    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: aliceCookie } });
    expect(list.statusCode).toBe(200);
    const item = list.json().items[0];
    expect(item).toMatchObject({ name: '日结', stepCount: 1, enabled: 1 });
    expect(typeof item.nextRunAt).toBe('number');
    expect(item.lastRun).toBeNull();
  });

  it('鉴权与基础校验：401 / 403 / 空 name / 空 steps / 非法 schedule', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(anon.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'j', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().id;

    const forbidden = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie: bobCookie } });
    expect(forbidden.statusCode).toBe(403);

    const noName = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: '', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    expect(noName.statusCode).toBe(400);

    const noSteps = await app.inject({ method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie }, payload: { name: 'x', steps: [] } });
    expect(noSteps.statusCode).toBe(400);

    const badSched = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }], schedule: { enabled: true, freqType: 'daily', time: '25:00' } },
    });
    expect(badSched.statusCode).toBe(400);
  });

  it('引用不可见工作流/连接返回 400；共享连接可用', async () => {
    // bob 引用 alice 的私有工作流（bob 建的 wf 才可见，这里直接用 alice 的 wfId）
    const badWf = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: bobCookie },
      payload: { name: 'x', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    expect(badWf.statusCode).toBe(400);

    const noSql = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'sql', name: 's', connectionId: sharedConnId, sql: '', onFailure: 'abort' }] },
    });
    expect(noSql.statusCode).toBe(400);

    const okSql = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: bobCookie },
      payload: { name: 'bob用共享连接', steps: [{ type: 'sql', name: 's', connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'continue' }] },
    });
    expect(okSql.statusCode).toBe(201);
    expect(okSql.json().steps[0].onFailure).toBe('continue');
  });

  it('PUT 整体覆盖；DELETE 后列表为空', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'A', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const jobId = created.json().id;

    const put = await app.inject({
      method: 'PUT', url: `/api/jobs/${jobId}`, headers: { cookie: aliceCookie },
      payload: {
        name: 'B',
        steps: [
          { type: 'workflow', name: 's1', workflowId, onFailure: 'continue' },
          { type: 'sql', name: 's2', connectionId: sharedConnId, sql: 'SELECT 1', onFailure: 'abort' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().name).toBe('B');
    expect(put.json().steps).toHaveLength(2);
    expect(put.json().schedule.enabled).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/api/jobs/${jobId}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: aliceCookie } });
    expect(list.json().items).toHaveLength(0);
  });

  it('手动运行返回 202 并调用 jobService.trigger；运行历史与详情可查', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'J', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const jobId = created.json().id;

    const started = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/runs`, headers: { cookie: aliceCookie } });
    expect(started.statusCode).toBe(202);
    expect(triggerJob).toHaveBeenCalledWith(jobId, { triggerType: 'manual', triggeredBy: expect.any(String) });
    const jobRunId = started.json().jobRunId;

    const history = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}/runs?limit=10`, headers: { cookie: aliceCookie } });
    expect(history.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/job-runs/${jobRunId}`, headers: { cookie: aliceCookie } });
    // jobService 为桩，未真实创建 job_run —— 详情应 404
    expect(detail.statusCode).toBe(404);
  });

  it('admin 可见全部 Job', async () => {
    await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'alice的', steps: [{ type: 'workflow', name: 's', workflowId, onFailure: 'abort' }] },
    });
    const list = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie: adminCookie } });
    expect(list.json().items).toHaveLength(1);
  });
});
```
- [ ] 验证：`pnpm --filter @hustserver/server test`
- [ ] Commit：`feat: Job 编排 REST API（8 端点，归属校验与调度联动）`

## Task 10：server.ts 接线 + index.ts 起停 + e2e 冒烟

**Files**
- 修改 [apps/server/src/server.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/server.ts)
- 修改 [apps/server/src/index.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/index.ts)
- 修改 [apps/server/test/e2e-smoke.test.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/test/e2e-smoke.test.ts)

**Steps**
- [ ] server.ts：
  - 新增 import：

```ts
import { jobsRepo } from './modules/jobs/repo.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { createJobService, type JobService } from './modules/jobs/service.js';
```

  - `FastifyInstance` 模块扩展加 `jobScheduler: Scheduler;`
  - `AppOverrides` 加 `jobService?: JobService;` 与 `jobScheduler?: Scheduler;`
  - 替换 scheduler 创建段并接线（第 54-83 行区域）：

```ts
  const scheduler =
    deps.overrides?.scheduler ??
    createScheduler({ onError: (err) => app.log.error({ err }, '调度触发失败') });
  const jobScheduler =
    deps.overrides?.jobScheduler ??
    createScheduler({ onError: (err) => app.log.error({ err }, 'Job 调度触发失败') });

  app.decorate('scheduler', scheduler);
  app.decorate('jobScheduler', jobScheduler);

  const schedules = schedulesRepo(deps.db);
  const fireWorkflow = (scheduleId: string): void => {
    const row = schedules.findById(scheduleId);
    if (!row) return;
    runService.trigger(row.workflow_id, { triggerType: 'schedule', scheduleId });
  };
  const syncWorkflowScheduler = (): void => {
    scheduler.sync(
      schedules.listEnabled().map((s) => ({ id: s.id, expr: s.cron_expr, timezone: s.timezone })),
      fireWorkflow,
    );
  };
  syncWorkflowScheduler();

  const jobService =
    deps.overrides?.jobService ?? createJobService({ db: deps.db, config: deps.config, runService });
  const jobs = jobsRepo(deps.db);
  const syncJobScheduler = (): void => {
    jobScheduler.sync(
      jobs.listEnabledScheduled().map((j) => ({ id: j.id, expr: j.cron_expr ?? '', timezone: j.timezone })),
      (jobId) => {
        jobService.trigger(jobId, { triggerType: 'schedule' });
      },
    );
  };
  syncJobScheduler();
```

  - 路由注册：`scheduleRoutes(app, { db: deps.db, config: deps.config, users, sessions, resync: syncWorkflowScheduler });` 之后加：

```ts
  jobRoutes(app, { db: deps.db, config: deps.config, users, sessions, jobService, resync: syncJobScheduler });
```

- [ ] index.ts：`app.scheduler.start();`（第 65 行）后加 `app.jobScheduler.start();`；shutdown 闭包内 `app.scheduler.stop();`（第 74 行）后加 `app.jobScheduler.stop();`
- [ ] e2e-smoke.test.ts：
  - import 增加：

```ts
import { jobRunsRepo, jobStepRunsRepo, jobsRepo } from '../src/modules/jobs/repo.js';
import type { JobService } from '../src/modules/jobs/service.js';
```

  - describe 顶部（`let stubScheduler: Scheduler;` 旁）新增声明 `let stubJobScheduler: Scheduler;`
  - 第 61 行 stub 改为（并新增 jobScheduler 桩与 jobService 桩，buildServer overrides 加 `jobService: stubJobService, jobScheduler: stubJobScheduler`）：

```ts
    stubScheduler = { start() {}, stop() {}, sync() {}, registeredIds: () => [] } as unknown as Scheduler;
    stubJobScheduler = { start() {}, stop() {}, sync() {}, registeredIds: () => [] } as unknown as Scheduler;
    const stubJobService: JobService = {
      trigger(jobId, opts) {
        const jobRun = jobRunsRepo(db).create({
          jobId, triggerType: opts?.triggerType ?? 'manual', triggeredBy: opts?.triggeredBy ?? null,
        });
        const steps = jobsRepo(db).listSteps(jobId);
        jobStepRunsRepo(db).createBatch(jobRun.id, steps.map((s) => ({
          stepId: s.id, seq: s.seq, type: s.type, name: s.name, config: s.config, onFailure: s.on_failure,
        })));
        for (const s of jobStepRunsRepo(db).listByJobRun(jobRun.id)) {
          jobStepRunsRepo(db).finish(s.id, { status: 'success', finishedAt: Date.now(), durationMs: 0 });
        }
        jobRunsRepo(db).finish(jobRun.id, { status: 'success', finishedAt: Date.now(), durationMs: 0, error: null });
        return jobRunsRepo(db).findById(jobRun.id)!;
      },
      async whenIdle() {},
    };
```

  - describe 末尾追加 Job 闭环冒烟：

```ts
  it('Job 编排闭环：创建 → 手动运行 → 查看步骤结果', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: userCookie },
      payload: {
        name: '日结', steps: [{ type: 'workflow', name: '跑清洗', workflowId, onFailure: 'abort' }],
        schedule: { enabled: true, freqType: 'daily', time: '07:30' },
      },
    });
    expect(created.statusCode).toBe(201);
    const jobId = (created.json() as { id: string }).id;

    const started = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/runs`, headers: { cookie: userCookie } });
    expect(started.statusCode).toBe(202);
    const jobRunId = (started.json() as { jobRunId: string }).jobRunId;

    const detail = await app.inject({ method: 'GET', url: `/api/job-runs/${jobRunId}`, headers: { cookie: userCookie } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { jobRun: { status: string }; steps: Array<{ status: string }> };
    expect(body.jobRun.status).toBe('success');
    expect(body.steps.map((s) => s.status)).toEqual(['success']);
  });
```

- [ ] 验证：`pnpm --filter @hustserver/server test`（**全量测试全绿**）+ `pnpm --filter @hustserver/server build`
- [ ] Commit：`feat: server 接线 jobScheduler/jobService 并完成 Job 闭环冒烟`

## Task 11：前端类型、路由与入口

**Files**
- 修改 [apps/web/src/types.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/types.ts)
- 修改 [apps/web/src/App.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/App.tsx)
- 修改 [apps/web/src/components/Layout.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/components/Layout.tsx)
- 修改 [apps/web/src/pages/HomePage.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/pages/HomePage.tsx)

**Steps**
- [ ] types.ts 末尾追加：

```ts
/** Job 编排相关类型（与 jobs/repo.ts、jobs/routes.ts 对齐）。 */
export type JobStepType = 'workflow' | 'sql';
export type JobOnFailure = 'abort' | 'continue';

export type JobStepConfig = { workflowId: string } | { connectionId: string; sql: string };

export interface JobStep {
  id: string;
  job_id: string;
  seq: number;
  type: JobStepType;
  name: string;
  config: JobStepConfig;
  on_failure: JobOnFailure;
  created_at: number;
}

export interface JobScheduleState {
  enabled: boolean;
  freqType: 'daily' | 'weekly' | 'monthly' | 'cron' | null;
  cronExpr: string | null;
  timezone: string;
}

export interface JobSummary {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  enabled: number;
  freq_type: string | null;
  cron_expr: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
  stepCount: number;
  nextRunAt: number | null;
  lastRun: { id: string; status: string; created_at: number } | null;
}

export interface JobDetail {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  enabled: number;
  freq_type: string | null;
  cron_expr: string | null;
  timezone: string;
  created_at: number;
  updated_at: number;
  nextRunAt: number | null;
  steps: JobStep[];
  schedule: JobScheduleState;
}

export interface JobRunSummary {
  id: string;
  job_id: string;
  trigger_type: 'manual' | 'schedule';
  triggered_by: string | null;
  status: 'queued' | 'running' | 'success' | 'error';
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

export interface JobStepRunSummary {
  id: string;
  job_run_id: string;
  step_id: string | null;
  seq: number;
  type: string;
  name: string;
  config: string;
  on_failure: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  output: string | null;
  created_at: number;
}
```

- [ ] App.tsx：import 三个页面 + Layout 内（`/runs/:id` 路由后）加 4 条路由：

```tsx
import { JobEditorPage } from './pages/JobEditorPage.js';
import { JobListPage } from './pages/JobListPage.js';
import { JobRunDetailPage } from './pages/JobRunDetailPage.js';
```

```tsx
            <Route path="/jobs" element={<JobListPage />} />
            <Route path="/jobs/new" element={<JobEditorPage />} />
            <Route path="/jobs/:id" element={<JobEditorPage />} />
            <Route path="/job-runs/:id" element={<JobRunDetailPage />} />
```

- [ ] Layout.tsx 第 18 行（连接 NavLink）后加：

```tsx
          <NavLink to="/jobs" className={linkClass}>Job编排</NavLink>
```

- [ ] HomePage.tsx 整体替换为：

```tsx
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">欢迎，{user?.username}</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link className="rounded border bg-white p-4 hover:border-blue-500" to="/workflows">
          <div className="font-medium">工作流</div>
          <div className="text-sm text-slate-500">上传、设计与运行数据工作流</div>
        </Link>
        <Link className="rounded border bg-white p-4 hover:border-blue-500" to="/jobs">
          <div className="font-medium">Job 编排</div>
          <div className="text-sm text-slate-500">把工作流与 SQL 串成定时流水线</div>
        </Link>
      </div>
    </div>
  );
}
```

- [ ] 验证：`pnpm --filter @hustserver/web build`（Job 页面文件尚未创建会报错——本任务先完成 types/routes/Layout/Home，Task 12-14 创建页面后再整体验证；若需此任务独立可验证，可先跳过 build，在 Task 14 后统一验证）

> 注：为了保持每任务可独立提交，本任务提交时允许 web build 暂不可用（路由引用的三个页面在 Task 12-14 创建）；Task 14 完成后必须通过 `pnpm --filter @hustserver/web build` 与 `pnpm -r build`。

- [ ] Commit：`feat: 前端新增 Job 编排类型、路由与主页入口`

## Task 12：JobListPage

**Files**
- 新增 `apps/web/src/pages/JobListPage.tsx`

**Steps**
- [ ] 新建页面（版式对齐 WorkflowListPage；GET /api/jobs 返回 `{items}`）：

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { JobSummary } from '../types.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把 5 段 cron 翻译成人话；复杂表达式原样展示。 */
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, , dow] = parts;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom !== '*' && dow !== '*') return expr;
  if (dom !== '*') return `每月 ${dom} 日 ${time}`;
  if (dow === '*') return `每天 ${time}`;
  const days = dow.split(',').map((d) => WEEKDAYS[Number(d)] ?? d);
  return `每${days.join('、')} ${time}`;
}

function describeSchedule(job: JobSummary): string {
  if (!job.enabled || !job.cron_expr) return '未启用';
  return `${describeCron(job.cron_expr)}（${job.timezone}）`;
}

export function JobListPage() {
  const [items, setItems] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function load() {
    try {
      const res = await api.get<{ items: JobSummary[] }>('/api/jobs');
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(job: JobSummary) {
    try {
      const res = await api.post<{ jobRunId: string }>(`/api/jobs/${job.id}/runs`);
      navigate(`/job-runs/${res.jobRunId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(job: JobSummary) {
    if (!window.confirm(`确定删除 Job「${job.name}」？其运行历史将一并删除。`)) return;
    await api.del(`/api/jobs/${job.id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Job 编排</h1>
        <Link className="rounded bg-blue-600 px-3 py-1.5 text-white" to="/jobs/new">
          新建 Job
        </Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">步骤数</th>
            <th className="p-2">调度</th>
            <th className="p-2">最近运行</th>
            <th className="p-2">更新时间</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((job) => (
            <tr key={job.id} className="border-t">
              <td className="p-2">
                <Link className="text-blue-600 underline" to={`/jobs/${job.id}`}>{job.name}</Link>
                {job.description && <div className="text-xs text-slate-500">{job.description}</div>}
              </td>
              <td className="p-2">{job.stepCount}</td>
              <td className="p-2">{describeSchedule(job)}</td>
              <td className="p-2">
                {job.lastRun ? (
                  <Link
                    className={job.lastRun.status === 'error' ? 'text-red-600 underline' : 'text-slate-700 underline'}
                    to={`/job-runs/${job.lastRun.id}`}
                  >
                    {job.lastRun.status}
                  </Link>
                ) : (
                  <span className="text-slate-400">从未运行</span>
                )}
              </td>
              <td className="p-2">{new Date(job.updated_at).toLocaleString()}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600" onClick={() => void run(job)}>运行</button>
                <Link className="text-blue-600 underline" to={`/jobs/${job.id}`}>编辑</Link>
                <button className="text-red-600" onClick={() => void remove(job)}>删除</button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={6}>
                暂无 Job，点击右上角「新建 Job」。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] 验证：`pnpm --filter @hustserver/web build`（Task 13/14 页面未建仍会失败，可延后到 Task 14 统一验证；此任务先确保本文件 tsc 无错）
- [ ] Commit：`feat: Job 列表页（调度人话描述、运行入口、删除）`

## Task 13：JobEditorPage（步骤编排 + 调度配置）

**Files**
- 新增 `apps/web/src/pages/JobEditorPage.tsx`

**Steps**
- [ ] 新建页面（`/jobs/new` 与 `/jobs/:id` 复用；步骤上移/下移/删除、添加步骤下拉、调度四频次、保存/手动运行/历史）：

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { JobOnFailure, JobRunSummary, JobStepType, WorkflowSummary } from '../types.js';

interface ConnectionOption {
  id: string;
  name: string;
  type: string;
}

/** 编辑器内的步骤草稿（key 仅用于 React 列表渲染）。 */
interface EditorStep {
  key: number;
  type: JobStepType;
  name: string;
  workflowId: string;
  connectionId: string;
  sql: string;
  onFailure: JobOnFailure;
}

interface ScheduleForm {
  enabled: boolean;
  freqType: 'daily' | 'weekly' | 'monthly' | 'cron';
  time: string;
  weekday: number;
  monthDay: number;
  cronExpr: string;
  timezone: string;
}

interface JobDetailLike {
  id: string;
  name: string;
  description: string | null;
  steps: Array<{
    type: JobStepType;
    name: string;
    config: { workflowId?: string; connectionId?: string; sql?: string };
    onFailure: JobOnFailure;
  }>;
  schedule: {
    enabled: boolean;
    freqType: 'daily' | 'weekly' | 'monthly' | 'cron' | null;
    cronExpr: string | null;
    timezone: string;
  };
}

const DEFAULT_SCHEDULE: ScheduleForm = {
  enabled: false,
  freqType: 'daily',
  time: '08:00',
  weekday: 1,
  monthDay: 1,
  cronExpr: '0 8 * * *',
  timezone: 'Asia/Shanghai',
};

const FREQ_OPTIONS: Array<{ value: ScheduleForm['freqType']; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'cron', label: '自定义 cron' },
];

let stepKeySeed = 0;
function nextStepKey(): number {
  stepKeySeed += 1;
  return stepKeySeed;
}

function newStep(type: JobStepType): EditorStep {
  return {
    key: nextStepKey(),
    type,
    name: type === 'workflow' ? '运行工作流' : '运行 SQL',
    workflowId: '',
    connectionId: '',
    sql: '',
    onFailure: 'abort',
  };
}

/** 把 DB 里的调度字段反解回表单；解析不出预设时回退为 cron 模式。 */
function cronToForm(freqType: string | null, cronExpr: string | null, timezone: string, enabled: boolean): ScheduleForm {
  const base: ScheduleForm = { ...DEFAULT_SCHEDULE, timezone, enabled };
  if (!freqType || !cronExpr) return base;
  if (freqType === 'cron') return { ...base, freqType: 'cron', cronExpr };
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, freqType: 'cron', cronExpr };
  const [min, hour] = parts;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (freqType === 'daily') return { ...base, freqType: 'daily', time };
  if (freqType === 'weekly') {
    const dow = Number(parts[4]);
    return { ...base, freqType: 'weekly', time, weekday: Number.isInteger(dow) ? dow : 1 };
  }
  const dom = Number(parts[2]);
  return { ...base, freqType: 'monthly', time, monthDay: Number.isInteger(dom) ? dom : 1 };
}

export function JobEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<EditorStep[]>([newStep('workflow')]);
  const [schedule, setSchedule] = useState<ScheduleForm>(DEFAULT_SCHEDULE);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [history, setHistory] = useState<JobRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.get<WorkflowSummary[]>('/api/workflows').then(setWorkflows).catch(() => {});
    void api
      .get<ConnectionOption[]>('/api/connections')
      .then((list) => setConnections(list.filter((c) => c.type === 'sqlserver')))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isNew) return;
    void (async () => {
      try {
        const job = await api.get<JobDetailLike>(`/api/jobs/${id}`);
        setName(job.name);
        setDescription(job.description ?? '');
        setSteps(job.steps.map((s) => ({
          key: nextStepKey(),
          type: s.type,
          name: s.name,
          workflowId: s.config.workflowId ?? '',
          connectionId: s.config.connectionId ?? '',
          sql: s.config.sql ?? '',
          onFailure: s.onFailure,
        })));
        setSchedule(cronToForm(job.schedule.freqType, job.schedule.cronExpr, job.schedule.timezone, job.schedule.enabled));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [id, isNew]);

  useEffect(() => {
    if (isNew) return;
    void api
      .get<{ items: JobRunSummary[] }>(`/api/jobs/${id}/runs?limit=10`)
      .then((res) => setHistory(res.items))
      .catch(() => {});
  }, [id, isNew]);

  const updateStep = (key: number, patch: Partial<EditorStep>): void => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };

  const moveStep = (index: number, dir: -1 | 1): void => {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  function validate(): string | null {
    if (!name.trim()) return '请填写 Job 名称';
    if (steps.length === 0) return '至少需要一个步骤';
    for (const [i, s] of steps.entries()) {
      if (s.type === 'workflow' && !s.workflowId) return `步骤 ${i + 1}：请选择工作流`;
      if (s.type === 'sql') {
        if (!s.connectionId) return `步骤 ${i + 1}：请选择连接`;
        if (!s.sql.trim()) return `步骤 ${i + 1}：请填写 SQL`;
      }
    }
    if (schedule.enabled && schedule.freqType === 'cron' && !schedule.cronExpr.trim()) return '请填写 cron 表达式';
    return null;
  }

  async function save(): Promise<void> {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        steps: steps.map((s) =>
          s.type === 'workflow'
            ? { type: s.type, name: s.name, workflowId: s.workflowId, onFailure: s.onFailure }
            : { type: s.type, name: s.name, connectionId: s.connectionId, sql: s.sql, onFailure: s.onFailure },
        ),
        schedule: schedule.enabled
          ? {
              enabled: true,
              freqType: schedule.freqType,
              time: schedule.time,
              weekday: schedule.weekday,
              monthDay: schedule.monthDay,
              cronExpr: schedule.cronExpr,
              timezone: schedule.timezone,
            }
          : { enabled: false },
      };
      if (isNew) {
        const created = await api.post<{ id: string }>('/api/jobs', { body });
        navigate(`/jobs/${created.id}`, { replace: true });
      } else {
        await api.put(`/api/jobs/${id}`, { body });
        setError(null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runNow(): Promise<void> {
    if (!id) return;
    try {
      const res = await api.post<{ jobRunId: string }>(`/api/jobs/${id}/runs`);
      navigate(`/job-runs/${res.jobRunId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const inputClass = 'w-full rounded border px-2 py-1.5 text-sm';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{isNew ? '新建 Job' : '编辑 Job'}</h1>
        <Link className="text-sm text-blue-600 underline" to="/jobs">返回列表</Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2 rounded border bg-white p-4">
        <h2 className="font-medium">基本信息</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-sm">
            名称（必填）
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-sm">
            描述
            <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded border bg-white p-4">
        <h2 className="font-medium">步骤编排</h2>
        {steps.map((s, i) => (
          <div key={s.key} className="space-y-2 rounded border p-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{i + 1}.</span>
              <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">{s.type === 'workflow' ? '工作流' : 'SQL'}</span>
              <input
                className={`${inputClass} max-w-48`}
                value={s.name}
                onChange={(e) => updateStep(s.key, { name: e.target.value })}
              />
              <div className="ml-auto flex gap-1">
                <button className="rounded border px-2" disabled={i === 0} onClick={() => moveStep(i, -1)}>上移</button>
                <button className="rounded border px-2" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)}>下移</button>
                <button className="rounded border px-2 text-red-600" onClick={() => setSteps((prev) => prev.filter((x) => x.key !== s.key))}>删除</button>
              </div>
            </div>
            <label className="block text-sm">
              失败策略
              <select
                className={inputClass}
                value={s.onFailure}
                onChange={(e) => updateStep(s.key, { onFailure: e.target.value as JobOnFailure })}
              >
                <option value="abort">中止（后续步骤跳过）</option>
                <option value="continue">继续（记录失败并执行下一步）</option>
              </select>
            </label>
            {s.type === 'workflow' ? (
              <label className="block text-sm">
                工作流
                <select className={inputClass} value={s.workflowId} onChange={(e) => updateStep(s.key, { workflowId: e.target.value })}>
                  <option value="">请选择…</option>
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="block text-sm">
                  连接（SQL Server）
                  <select className={inputClass} value={s.connectionId} onChange={(e) => updateStep(s.key, { connectionId: e.target.value })}>
                    <option value="">请选择…</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  SQL（将直接在该连接上执行）
                  <textarea className={`${inputClass} h-24 font-mono`} value={s.sql} onChange={(e) => updateStep(s.key, { sql: e.target.value })} />
                </label>
              </>
            )}
          </div>
        ))}
        <select
          className={inputClass}
          value=""
          onChange={(e) => {
            if (e.target.value) setSteps((prev) => [...prev, newStep(e.target.value as JobStepType)]);
            e.target.value = '';
          }}
        >
          <option value="">+ 添加步骤…</option>
          <option value="workflow">运行工作流</option>
          <option value="sql">运行 SQL</option>
        </select>
      </section>

      <section className="space-y-2 rounded border bg-white p-4">
        <h2 className="font-medium">调度配置</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={schedule.enabled} onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked })} />
          启用定时调度
        </label>
        {schedule.enabled && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              频次
              <select
                className={inputClass}
                value={schedule.freqType}
                onChange={(e) => setSchedule({ ...schedule, freqType: e.target.value as ScheduleForm['freqType'] })}
              >
                {FREQ_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            {schedule.freqType !== 'cron' && (
              <label className="text-sm">
                时间
                <input type="time" className={inputClass} value={schedule.time} onChange={(e) => setSchedule({ ...schedule, time: e.target.value })} />
              </label>
            )}
            {schedule.freqType === 'weekly' && (
              <label className="text-sm">
                星期
                <select className={inputClass} value={schedule.weekday} onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}>
                  {['周日', '周一', '周二', '周三', '周四', '周五', '周六'].map((label, idx) => (
                    <option key={idx} value={idx}>{label}</option>
                  ))}
                </select>
              </label>
            )}
            {schedule.freqType === 'monthly' && (
              <label className="text-sm">
                日期（1-31）
                <input type="number" min={1} max={31} className={inputClass} value={schedule.monthDay} onChange={(e) => setSchedule({ ...schedule, monthDay: Number(e.target.value) })} />
              </label>
            )}
            {schedule.freqType === 'cron' && (
              <label className="text-sm">
                cron 表达式（5 段）
                <input className={`${inputClass} font-mono`} value={schedule.cronExpr} onChange={(e) => setSchedule({ ...schedule, cronExpr: e.target.value })} />
              </label>
            )}
            <label className="text-sm">
              时区
              <input className={inputClass} value={schedule.timezone} onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })} />
            </label>
          </div>
        )}
      </section>

      <div className="flex items-center gap-2">
        <button className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
        {!isNew && (
          <button className="rounded border px-4 py-1.5" onClick={() => void runNow()}>手动运行</button>
        )}
      </div>

      {!isNew && (
        <section className="space-y-2 rounded border bg-white p-4">
          <h2 className="font-medium">最近运行（10 条）</h2>
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">暂无运行记录。</p>
          ) : (
            <table className="w-full border text-left text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-2">状态</th>
                  <th className="p-2">触发方式</th>
                  <th className="p-2">开始时间</th>
                  <th className="p-2">耗时</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className={`p-2 ${r.status === 'error' ? 'text-red-600' : ''}`}>
                      <Link className="underline" to={`/job-runs/${r.id}`}>{r.status}</Link>
                    </td>
                    <td className="p-2">{r.trigger_type === 'manual' ? '手动' : '调度'}</td>
                    <td className="p-2">{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
                    <td className="p-2">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
```

- [ ] 验证：`pnpm --filter @hustserver/web build`（等待 Task 14 后整体验证）
- [ ] Commit：`feat: Job 编辑器（步骤编排与调度配置）`

## Task 14：JobRunDetailPage + 全量验证

**Files**
- 新增 `apps/web/src/pages/JobRunDetailPage.tsx`

**Steps**
- [ ] 新建页面（轮询 1s、终态停止；workflow 步骤跳 `/runs/:runId`；SQL 步骤展示影响行数）：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { JobRunSummary, JobStepRunSummary } from '../types.js';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  success: '成功',
  error: '失败',
  skipped: '已跳过',
  pending: '等待中',
};

/** 处于这些状态需要轮询刷新；到达终态后停止。 */
const ACTIVE_STATUSES = new Set(['queued', 'running', 'pending']);
/** 轮询间隔（毫秒）。 */
const POLL_INTERVAL_MS = 1000;

function StepOutput({ step }: { step: JobStepRunSummary }) {
  if (!step.output) return null;
  try {
    const parsed = JSON.parse(step.output) as { runId?: string; rowsAffected?: number; rowCount?: number };
    if (step.type === 'workflow' && parsed.runId) {
      return (
        <Link className="text-blue-600 underline" to={`/runs/${parsed.runId}`}>
          查看运行详情
        </Link>
      );
    }
    if (typeof parsed.rowsAffected === 'number') {
      return <span className="text-slate-500">影响 {parsed.rowsAffected} 行</span>;
    }
  } catch {
    /* 忽略非 JSON output */
  }
  return null;
}

export function JobRunDetailPage() {
  const { id = '' } = useParams();
  const [jobRun, setJobRun] = useState<JobRunSummary | null>(null);
  const [steps, setSteps] = useState<JobStepRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const detail = await api.get<{ jobRun: JobRunSummary; steps: JobStepRunSummary[] }>(`/api/job-runs/${id}`);
      setJobRun(detail.jobRun);
      setSteps(detail.steps);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!jobRun || !ACTIVE_STATUSES.has(jobRun.status)) return;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [jobRun, load]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!jobRun) return <p className="text-sm text-slate-500">加载中…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Job 运行详情</h1>
        <Link className="text-sm text-blue-600 underline" to={`/jobs/${jobRun.job_id}`}>返回 Job</Link>
      </div>
      <div className="rounded border bg-white p-4 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>
            状态：
            <span className={jobRun.status === 'error' ? 'text-red-600' : 'font-medium'}>
              {STATUS_LABEL[jobRun.status] ?? jobRun.status}
            </span>
          </span>
          <span>触发方式：{jobRun.trigger_type === 'manual' ? '手动' : '调度'}</span>
          <span>开始时间：{jobRun.started_at ? new Date(jobRun.started_at).toLocaleString() : '—'}</span>
          <span>耗时：{jobRun.duration_ms != null ? `${jobRun.duration_ms} ms` : '—'}</span>
        </div>
        {jobRun.error && <p className="mt-2 text-red-600">{jobRun.error}</p>}
      </div>
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">顺序</th>
            <th className="p-2">步骤</th>
            <th className="p-2">类型</th>
            <th className="p-2">状态</th>
            <th className="p-2">耗时</th>
            <th className="p-2">结果</th>
            <th className="p-2">错误</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.id} className="border-t">
              <td className="p-2">{s.seq + 1}</td>
              <td className="p-2">{s.name}</td>
              <td className="p-2">{s.type === 'workflow' ? '工作流' : 'SQL'}</td>
              <td className={`p-2 ${s.status === 'error' ? 'text-red-600' : s.status === 'skipped' ? 'text-slate-400' : ''}`}>
                {STATUS_LABEL[s.status] ?? s.status}
              </td>
              <td className="p-2">{s.duration_ms != null ? `${s.duration_ms} ms` : '—'}</td>
              <td className="p-2"><StepOutput step={s} /></td>
              <td className="p-2 text-red-600">{s.error}</td>
            </tr>
          ))}
          {steps.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={7}>暂无步骤记录。</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] 全量验证：
  - `pnpm --filter @hustserver/server test`
  - `pnpm --filter @hustserver/server build`
  - `pnpm --filter @hustserver/engine build`
  - `pnpm --filter @hustserver/web build`
- [ ] Commit：`feat: Job 运行详情页（1s 轮询、步骤结果与运行跳转）`

## 验收清单（全部任务完成后核对）

- [ ] `pnpm --filter @hustserver/server test` 全绿（含新增 job-repo/job-service/job-routes 测试与改造后的 scheduler/schedule-routes/e2e-smoke）
- [ ] `pnpm -r build` 三包全部通过
- [ ] spec §10 改动清单逐项对照：新增 8 项（jobs/repo、service、routes、sql + 3 个前端页面 + 3 个测试文件）与修改 10 项（migrate、runs/repo、runs/service、scheduler、schedules/routes、schedules/repo 保留、server.ts、index.ts、server package.json、engine/src/index.ts、前端三入口、scheduler.test）全部落地
- [ ] 交付说明中向用户正式告知：`job_step_runs` 补充 `config` / `on_failure` 两快照列（相对 spec §4 DDL 的修正）
