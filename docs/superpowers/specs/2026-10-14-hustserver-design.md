# HUSTServer 设计文档：ETL 工作流托管与调度平台

- 日期：2026-10-14
- 状态：待评审
- 依据：[INIT.md](../../../INIT.md)
- 参考项目：[microsoftbi/HUSTERYX](https://github.com/microsoftbi/HUSTERYX)

## 1. 背景与目标

HUSTERYX 是一个单机桌面低代码 ETL 工具：用拖拽 DAG 构建数据处理工作流，本地运行，工作流以 JSON 持久化在 SQLite。

本系统（HUSTServer）在 HUSTERYX 之上构建一个 **Web 托管与调度平台**，让用户把自己做好的 ETL 工作流「发布」到站点，由站点负责周期调度、执行与运行日志留存。

### 目标

1. 用户把 ETL 工作流发布（上传）到站点。
2. 用户在站点配置运行周期（每天 / 每周 / 每月，并支持高级 Cron）。
3. 用户在站点查看每一次部署的运行日志与各节点结果。
4. 系统具备登录管理（登录 / 登出 / 账号生命周期管理）。
5. 角色分管理员与普通用户，权限边界明确。
6. 支持工作流文件上传。
7. 部署目标为 macOS，**不使用 Docker**。

### 非目标（明确不做）

画布 / DAG 编辑、工作流可视化只读渲染、分布式多机执行、容器化、SSO / LDAP、邮件或 IM 告警、工作流版本回滚、数据预览 UI。

## 2. 范围与关键决策

| 决策项 | 结论 |
|---|---|
| 与 HUSTERYX 的关系 | **仅调度托管层**：站点不提供画布，用户上传本地导出的工作流 JSON |
| 服务端执行引擎 | **复用 HUSTERYX 后端引擎**（DuckDB 执行节点），以 vendored 方式引入 |
| 技术栈 | 与 HUSTERYX 一致：Fastify 5 + TypeScript(ESM) 后端；React 19 + Vite + Tailwind 前端 |
| 账号开通 | **仅管理员创建账号**，不开放自助注册 |
| 管理员权限 | **超级管理员**：可查看与管理全部用户的工作流、调度与日志 |
| 输入数据 | **既支持上传数据文件，也支持引用服务端已配置的数据目录 / SQL Server 连接** |
| 调度能力 | 预设周期（每天/每周/每月）+ 高级 Cron + 手动「立即运行」 |
| 部署形态 | macOS 单进程（API + 前端静态 + 调度器），launchd 常驻，无 Docker |

### 与 INIT 的显式偏离

INIT 第 4、8 条提到「用户注册」。经确认，本设计**不开放公开自助注册**，改为「管理员创建账号」。

- 理由：托管平台面向受控环境，账号由管理员统一发放，更符合第 5 条「管理员可以管理所有用户，包括注册、注销」的描述。
- 落地方式：系统首次启动通过 bootstrap 生成初始管理员；此后所有账号由管理员在后台创建。
- 若后续需要公开注册，可在此模型上增加「注册 → 待审核」状态，不影响其它设计。

## 3. 关键事实（来自参考项目源码）

这些事实直接约束了设计：

- 工作流是纯 JSON：`{ id, name, nodes[], edges[], createdAt, updatedAt }`；节点为 `{ id, kind, name, position, config }`。
- 输入节点把**作者本机文件路径**存在 `config.path`（CSV/Excel）；`inputSqlServer` 节点把 **server/database/user/password 明文**直接存在 `config` 里。
- 引擎入口：`createRun(workflow, targetNodeId?, options?)` → `executeWorkflow(runId)`。
- 引擎在 `runStore` 中**仅以内存保存运行上下文**，TTL 约 30 分钟即回收；日志以 SSE 事件（`run-log` / `node-result` / `run-status`）推送。
- 因此：**运行历史与日志的持久化是本系统必须新增的能力**，而非已有能力。

## 4. 总体架构

```
                    macOS 单机（无 Docker，launchd 常驻）
┌──────────────────────────────────────────────────────────────────┐
│  单一 Node 进程 (Fastify 5)                                        │
│                                                                    │
│  ┌────────────┐   ┌───────────────────────────────────────────┐   │
│  │ 静态前端    │   │  API 模块                                  │   │
│  │ (React 构建)│   │  auth │ workflows │ schedules │ runs │ admin │   │
│  └────────────┘   └───────────────┬───────────────────────────┘   │
│                                    │                                │
│  ┌──────────────┐   ┌──────────────▼───────────┐   ┌────────────┐  │
│  │ Scheduler    │──▶│  RunService (并发队列)     │──▶│ Recorder   │  │
│  │ (cron/预设)   │   │  构建运行时工作流(重映射)   │   │ 事件→落库   │  │
│  └──────┬───────┘   └──────────────┬───────────┘   └─────┬──────┘  │
│         │                          ▼                      │         │
│         │              ┌───────────────────────┐          │         │
│         │              │ packages/engine        │          │         │
│         │              │ (HUSTERYX: DuckDB/节点) │──────────┘         │
│         │              │  createRun/execute      │  SSE 事件流        │
│         │              └───────────────────────┘                    │
│         ▼                                                           │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ SQLite(WAL): users/workflows/schedules/runs/run_logs/...      │  │
│  │ 文件目录: uploads/ outputs/ spill/                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

一次运行的数据流：

`Scheduler 触发 / 用户手动` → `RunService` 落 `runs` 行（queued） → 读工作流 JSON 并**应用路径/连接重映射**得到运行时 `Workflow` → `engine.createRun + executeWorkflow` → `Recorder` 消费事件流写入 `run_logs` / `run_node_results`，并按需透传给浏览器实时查看 → 结束后更新 `runs` 状态。

## 5. 引擎集成方案

采用 **Vendored 引擎**：把 HUSTERYX 的 `backend/src/{engine, nodes, util, types, config}` 引入本仓库 `packages/engine`，做两处受控改造：

1. **持久化 sink**：在 `runStore.publishEvent` 增加可注册的监听器，使运行事件可被 `Recorder` 消费落库（不改变原有内存语义与 SSE 行为）。
2. **运行时配置重写**：在执行前允许替换节点 `config`（用于输入路径重映射、连接脱敏替换），不改动节点实现本身。

备选方案（未采用）：
- 外部依赖 + 假 `ServerResponse` 订阅 SSE 落库：依赖内部实现细节、脆弱，且无法安全处理敏感信息。
- 直接扩展 HUSTERYX 单仓：与「桌面单机工具」定位冲突，耦合重。

## 6. 模块划分

每个模块单一职责、接口清晰、可独立测试。

### 后端 `apps/server`

| 模块 | 职责 | 关键接口 |
|---|---|---|
| `auth` | 登录/登出、会话管理、密码哈希、RBAC 守卫 | `login`, `logout`, `requireAuth`, `requireAdmin` |
| `workflows` | 上传/解析/校验工作流 JSON、CRUD、数据绑定、路径重映射 | `parseUpload`, `createWorkflow`, `buildMapping` |
| `schedules` | 调度 CRUD、启停、预设↔cron 换算、next-run 计算 | `upsertSchedule`, `nextRunAt`, `presetToCron` |
| `runs` | 触发运行、并发队列、运行历史与日志查询、SSE 转发 | `trigger`, `listRuns`, `getRunDetail`, `streamRun` |
| `admin` | 用户创建/禁用/重置密码/改角色 | `createUser`, `setStatus`, `resetPassword` |
| `connections` | 命名连接的 CRUD、连通性测试、密文存取 | `listConnections`, `testConnection`, `resolve` |
| `db` | SQLite schema、迁移、访问封装 | `migrate`, 各仓储函数 |
| `recorder` | 订阅引擎事件并落库 `run_logs` / `run_node_results` | `attach(runId, engineRunId)` |
| `server` | 装配路由 + 托管前端静态资源 + 启动 Scheduler | `buildServer` |

### 引擎 `packages/engine`（vendored）

DuckDB 会话、图编译、执行器、节点注册表、`runStore`（新增 sink）、`util`。

### 前端 `apps/web`

React 19 + Vite + Tailwind，管理控制台，无画布。页面：

- 登录页
- 我的工作流：列表 / 上传（解析后引导绑定数据）/ 详情
- 调度配置：周期、Cron、启停、手动运行
- 运行历史：列表 / 日志详情（节点结果 + 逐条日志，支持实时）
- 用户管理（管理员）
- 连接管理

## 7. 数据模型（SQLite）

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',     -- 'admin' | 'user'
  status        TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'disabled'
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE workflows (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,          -- JSON: { nodes: [], edges: [] }
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflow_files (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id       TEXT,                -- 绑定的输入节点；NULL 表示未绑定
  original_ref  TEXT NOT NULL,       -- 上传时工作流里记录的原始路径
  stored_name   TEXT NOT NULL,       -- 服务端存储的相对文件名
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE connections (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT REFERENCES users(id),   -- NULL 表示管理员共享
  name             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'sqlserver',
  config_encrypted TEXT NOT NULL,               -- AES-256-GCM 密文
  shared           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE path_mappings (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  direction    TEXT NOT NULL,        -- 'input' | 'output'
  original_ref TEXT NOT NULL,
  target_type  TEXT NOT NULL,        -- 'uploaded_file' | 'server_path' | 'connection' | 'output_dir'
  target_ref   TEXT
);

CREATE TABLE schedules (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  freq_type   TEXT NOT NULL,         -- 'daily' | 'weekly' | 'monthly' | 'cron'
  cron_expr   TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  schedule_id   TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  trigger_type  TEXT NOT NULL,       -- 'manual' | 'schedule'
  triggered_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL,       -- 'queued' | 'running' | 'success' | 'error' | 'canceled'
  engine_run_id TEXT,
  started_at    INTEGER,
  finished_at   INTEGER,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE run_node_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  name        TEXT,
  kind        TEXT,
  status      TEXT NOT NULL,         -- 'pending' | 'running' | 'success' | 'error' | 'skipped'
  row_count   INTEGER,
  duration_ms INTEGER,
  error       TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE run_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  level    TEXT NOT NULL,            -- 'info' | 'warn' | 'error' | 'success'
  node_id  TEXT,
  message  TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_runs_workflow      ON runs(workflow_id, created_at DESC);
CREATE INDEX idx_run_logs_run       ON run_logs(run_id, ts);
CREATE INDEX idx_run_nodes_run      ON run_node_results(run_id);
```

启用 `journal_mode = WAL`。

**删除语义**：管理员删除用户时，其名下的工作流、调度、运行记录随外键**级联删除**（`runs.triggered_by` 置空以保留他人触发记录）；日常处置用户优先用「禁用」而非删除。

## 8. API 契约

统一前缀 `/api`，除登录外均需会话 Cookie。错误响应 `{ error, detail? }`。

### 认证 `auth`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | `{ username, password }`，成功下发会话 Cookie |
| POST | `/api/auth/logout` | 注销当前会话 |
| GET | `/api/auth/me` | 当前用户信息 |

### 工作流 `workflows`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workflows` | 列表（普通用户仅自己；管理员全部） |
| POST | `/api/workflows/upload` | multipart 上传工作流 JSON，返回解析结果与待绑定的输入/输出引用 |
| POST | `/api/workflows` | 由解析结果 + 绑定信息创建工作流 |
| GET | `/api/workflows/:id` | 详情 |
| DELETE | `/api/workflows/:id` | 删除 |
| PUT | `/api/workflows/:id/mappings` | 更新路径/连接重映射 |
| POST | `/api/workflows/:id/files` | 上传输入数据文件并绑定到节点 |
| GET | `/api/workflows/:id/files` | 已绑定文件列表 |

### 调度 `schedules`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workflows/:id/schedules` | 列出调度 |
| POST | `/api/workflows/:id/schedules` | 新建 `{ freq_type, cron_expr, timezone, enabled }` |
| PUT | `/api/schedules/:id` | 更新 / 启停 |
| DELETE | `/api/schedules/:id` | 删除 |

### 运行 `runs`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/workflows/:id/runs` | 手动「立即运行」，返回 `{ runId }` |
| GET | `/api/workflows/:id/runs` | 运行历史（分页） |
| GET | `/api/runs/:runId` | 运行详情 + 各节点结果 |
| GET | `/api/runs/:runId/logs?after=&limit=` | 逐条日志（增量拉取） |
| GET | `/api/runs/:runId/events` | SSE 实时事件（运行中） |

### 连接 `connections`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/api/connections` | 列出 / 新建 |
| PUT / DELETE | `/api/connections/:id` | 更新 / 删除 |
| POST | `/api/connections/:id/test` | 连通性测试 |

### 管理 `admin`（仅管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users` | 创建用户 `{ username, password, role }` |
| PUT | `/api/admin/users/:id` | 修改角色 / 状态 |
| POST | `/api/admin/users/:id/reset-password` | 重置密码 |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET / PUT | `/api/admin/settings` | 系统配置（并发数、保留天数、共享目录等） |

## 9. 关键流程

### 9.1 发布工作流

1. 用户上传工作流 JSON。
2. 后端校验结构（`nodes` / `edges` / `kind` 白名单），解析出所有输入/输出节点的引用（`config.path` 或内嵌连接）。
3. 前端引导用户逐项绑定：
   - 输入文件 → 上传数据文件 或 选择服务端共享目录中的文件；
   - SQL Server 连接 → 选择已保存的连接（或管理员共享连接）；
   - 输出 → 统一写入服务端 `outputs/<workflowId>/<runId>/`。
4. 保存时：`workflows.payload` 只保留 `nodes`/`edges`；**剥离工作流内嵌的明文连接**，改存 `path_mappings` 中的连接引用；写入 `workflow_files` / `path_mappings`。

### 9.2 调度运行

1. Scheduler 按 `cron_expr` + `timezone` 触发。
2. `RunService.trigger(workflowId, { triggerType: 'schedule', scheduleId })`。
3. 落 `runs` 行（`queued`），入并发队列；获得执行槽后置 `running` 并记 `started_at`。
4. `PathMapper.buildRuntimeWorkflow()` 生成运行时 `Workflow`（重写输入路径、替换连接、重定向输出）。
5. `engine.createRun` → `executeWorkflow`；`Recorder` 订阅事件流写库。
6. 结束更新 `runs`（`success` / `error`、`finished_at`、`duration_ms`、`error`）。
7. 执行失败按配置重试（默认 1 次）。

### 9.3 查看日志

- 历史运行：`GET /api/runs/:runId` + `/logs`。
- 运行中：`GET /api/runs/:runId/events`（SSE）实时推送，前端边收边渲染。

## 10. 调度与并发

- 预设↔Cron：`daily` / `weekly` / `monthly` 映射为标准 cron 表达式，统一存 `cron_expr`，时区 `Asia/Shanghai`。
- 进程内调度（`node-cron` 类库）：启动时从 `schedules` 重建全部任务，增删改热更新。
- 手动「立即运行」与调度触发走同一 `RunService`。
- **并发上限**：全局信号量，默认 2（`MAX_CONCURRENT_RUNS`），超出排队（`queued`）。
- 每次运行使用独立的 DuckDB 内存实例（引擎已支持），并设内存上限自动 spill 到 `spill/`。
- **执行隔离现状与风险**：v1 在 API 进程内执行。若某次运行因原生模块导致进程崩溃，launchd 会拉起重启，调度从 DB 重建，可自愈；但会短暂影响 API。后续可平滑迁移到独立子进程执行（`Recorder` 抽象已为此预留）。

## 11. 权限与安全

- **密码**：argon2id（或 bcrypt）哈希，永不回显。
- **会话**：随机会话令牌存 `sessions` 表，Cookie `httpOnly` + `sameSite=lax`（HTTPS 下 `secure`），服务端可吊销；登出即删行。
- **RBAC**：`requireAuth` / `requireAdmin` 守卫；普通用户只能访问自己 `owner_id` 的工作流、调度、运行与日志；管理员为超级管理员。
- **敏感信息**：`connections.config_encrypted` 用 AES-256-GCM 加密（密钥来自 `ENCRYPTION_KEY`）；API 响应与日志**一律脱敏**（密码替换为 `******`）；上传工作流中内嵌的明文连接在保存前剥离。
- **上传校验**：文件大小与扩展名白名单；`stored_name` 重命名；`resolveInputPath` 约束在数据目录内，防路径穿越。
- **初始管理员**：首次启动若 `users` 为空，按 `BOOTSTRAP_ADMIN_USER` / `BOOTSTRAP_ADMIN_PASSWORD` bootstrap（未设置则生成随机密码并打印一次到启动日志）。

## 12. 数据源与路径重映射

工作流里的路径是作者本机路径，服务端不存在。上传时解析全部输入/输出节点，逐项绑定：

1. **上传数据文件** → 存入 `uploads/<workflowId>/`，运行时把 `config.path` 重写为服务端存储路径。
2. **引用服务端共享目录** → 管理员配置只读共享目录白名单，用户在绑定界面从中选择。
3. **SQL Server 连接** → 用户选择自己保存的连接或管理员共享连接，运行时替换工作流内的明文连接。
4. **输出** → 统一重定向到 `outputs/<workflowId>/<runId>/`，避免并发互相覆盖。

重映射规则持久化在 `path_mappings`，每次运行时由 `PathMapper` 应用。

## 13. 部署（macOS，无 Docker）

- 构建：`pnpm build`（后端 tsc → `dist/`，前端 vite build → 静态资源）。
- 运行：单进程 `node dist/server.js`，Fastify 同时托管 `/api/*` 与前端静态资源。
- 常驻：**launchd LaunchAgent**（开机自启 + 崩溃自动拉起），提供 `scripts/install-macos-service.sh` 生成并加载 plist。
- 数据目录（默认 `~/.hustserver/`）：`metadata.sqlite`、`uploads/`、`outputs/`、`spill/`。
- 日志保留：定时清理任务，默认保留 90 天或最近 N 次运行（可配）。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HUSTSERVER_HOST` | `127.0.0.1` | 监听地址 |
| `HUSTSERVER_PORT` | `8787` | 监听端口 |
| `HUSTSERVER_DATA_DIR` | `~/.hustserver` | 数据目录 |
| `SESSION_SECRET` | — | 会话签名密钥（必填） |
| `ENCRYPTION_KEY` | — | 连接密文加密密钥（必填） |
| `MAX_CONCURRENT_RUNS` | `2` | 全局并发上限 |
| `RUN_MAX_RETRIES` | `1` | 失败重试次数 |
| `LOG_RETENTION_DAYS` | `90` | 日志保留天数 |
| `DUCKDB_MEMORY_LIMIT` | `2GB` | DuckDB 内存上限 |
| `TZ` | `Asia/Shanghai` | 调度时区 |

## 14. 测试策略

- **单元测试**：认证与 RBAC、预设↔cron 换算与 next-run、路径重映射（`PathMapper`）、`Recorder` 落库、日志保留清理、连接加解密与脱敏。
- **集成测试**：上传样例工作流 + 数据 → 触发运行 → 断言 `runs` 成功、`run_logs` / `run_node_results` 已持久化（复用 HUSTERYX `samples/`）。
- **冒烟 e2e**：启动服务 → bootstrap 管理员 → 建账号 → 登录 → 上传 → 手动运行 → 查日志。
- 测试框架：vitest（与 TS/ESM 栈一致）。

## 15. 风险与待定

| 项 | 说明 | 应对 |
|---|---|---|
| 引擎同步成本 | vendored 引擎随上游更新需人工同步 | 固定基线版本，集中改造点（sink + 配置重写），便于 diff |
| 同进程执行稳定性 | 原生模块崩溃会拖累 API | launchd 自愈；预留子进程隔离迁移路径 |
| SQL Server 依赖 | 运行需网络可达目标库 | 提供连接测试；失败信息落日志 |
| DuckDB 原生模块 | macOS 上需正确构建 | 沿用 HUSTERYX 已验证的依赖与 `onlyBuiltDependencies` 配置 |

## 16. 实施里程碑（不含时间评估）

- **M1 骨架与账号体系**：monorepo 骨架、SQLite schema/迁移、认证与 RBAC、管理员用户管理、bootstrap 管理员。
- **M2 工作流发布**：上传与解析、数据文件绑定、路径/连接重映射、工作流 CRUD。
- **M3 引擎集成与运行日志**：vendored 引擎、`RunService`、`Recorder` 持久化、运行历史与日志查询、SSE 实时。
- **M4 调度**：预设 + Cron、Scheduler、启停、手动运行、并发队列与重试。
- **M5 部署与加固**：launchd 安装脚本、日志保留清理、前端完善、测试补齐、安全复查。
