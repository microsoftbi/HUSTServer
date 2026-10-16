# HUSTServer 设计文档：加载成模型（DuckDB 数据模型）

- 日期：2026-10-16
- 状态：已批准
- 依据：本会话 brainstorming 决策（5 项澄清问答 + 1 项方案选择）；现有实现见 [2026-10-15-job-orchestration-design.md](./2026-10-15-job-orchestration-design.md)、[2026-10-16-dashboard-design.md](./2026-10-16-dashboard-design.md)、[2026-10-16-user-roles-design.md](./2026-10-16-user-roles-design.md)

## 1. 背景与目标

需求原文（[NOTE.md](../../../NOTE.md) L10-13）：

> csv，excel，或者sqlserver里的数据，加一个功能叫加载成模型，其就是把数据加载到duckdb里，加载成模型的数据，也可以在仪表板里被使用。仪表板里既可以访问 csv,excel,sqlserver 里的数据，也可以访问 duckdb 里的数据。
> 具体的实现就是在 Job 编排里，加一个步骤类型，把 csv,excel 或者 sqlserver 里的数据加载成模型，就是指定资源里的 csv or excel 文件，或者 sqlserver 里的表，然后把它们加载到 duckdb 里，完成数据模型的加载。
> 加载成模型后，需要给模型取一个名字，然后在仪表板的设计里，就可以通过这个名字来使用这个模型了。

现状（侦察结论）：

- **DuckDB 只是每次运行的临时实例**：`DuckDBInstance.create(':memory:', …)`（[duckdb.ts](../../../packages/engine/src/engine/duckdb.ts#L12-L21)），随运行 TTL（30 分钟）销毁，**没有任何持久化机制**。
- **资源库没有 DB 实体**：只有文件系统相对路径（根目录 `apps/web/DATA`，[config.ts](../../../apps/server/src/config.ts#L33)），扩展名白名单 `.csv/.xlsx/.xls`（[paths.ts](../../../apps/server/src/modules/resources/paths.ts#L4)）。
- **Job 步骤只有两种类型**：`'workflow'` / `'sql'`（[repo.ts](../../../apps/server/src/modules/jobs/repo.ts#L5)）；`job_steps.type` 是 `TEXT` 无 CHECK 约束，取值靠应用层保证。
- **仪表板取数完全不经过 DuckDB**：SQL 走后端 mssql 直连（[query.ts](../../../apps/server/src/modules/data/query.ts#L46-L62)）；CSV/Excel 走「后端下载字节 + 前端解析」；数据集只持久化 `DatasetDef` 定义（[types.ts](../../../apps/web/src/features/dashboard/types.ts#L83-L92)）。

本次要新增的是一条**独立于运行生命周期**的持久化数据链路：Job 把文件/库表物化进一个常驻 DuckDB 文件，仪表板按「模型名」读取该文件。

## 2. 范围与关键决策

| 决策项 | 结论 |
|---|---|
| 模型语义 | **快照**：加载那一刻把数据固化进 DuckDB 文件；仪表板读的是冻结数据，源变化需重跑 Job |
| 命名 | **全局唯一**，模型名即 DuckDB 表名，限制 `^[A-Za-z_][A-Za-z0-9_]{0,63}$` |
| 更新语义 | **重跑覆盖**：同名模型原子替换；**加载失败保留旧模型不变** |
| 模型形态 | **一步一模型、模型=一张表**（不做多表批量、不做 SQL 视图模型） |
| 存储布局 | **单一持久 DuckDB 文件 `<dataDir>/models.duckdb`** + SQLite `data_models` 元数据表 |
| 权限 | **不新增能力**：创建模型 = Job 步骤（`job`）；浏览/取数 = `dashboard.view`；删除/重命名 = `job` |
| 管理入口 | 新增「数据模型」页（列表 / 删除 / 重命名，不含行数据预览） |

### 被否决的方案

- **每模型一个独立 `.duckdb` 文件**：故障隔离更好，但模型间无法 JOIN、文件数量膨胀、每次查询需开关文件；选单一文件。
- **元数据也放进 DuckDB 内部表**：脱离现有 `better-sqlite3` 迁移体系，列表页每次要开 DuckDB，owner/时间字段需自建；选 SQLite 元数据。
- **模型只存「加载定义」（视图语义）**：用户明确选择快照——源库离线可用、查询快、语义确定。
- **新增 `model.manage` / `model.use` 能力**：要同步改 `roles.ts` / 角色页 / 前端能力判定，收益低于成本；复用现有能力。
- **模型取数走 `connection.use`**：`dashboard_viewer` 的 `ROLE_CAPS` 只有 `dashboard.view`（[roles.ts](../../../apps/server/src/modules/users/roles.ts#L49-L54)），走 `connection.use` 会让查看者打开仪表板 403。模型数据已物化在平台内、不含凭据，因此归 `dashboard.view`。

### 非目标

- 模型手动刷新按钮、模型数据预览页。
- 跨模型 JOIN、自定义 SQL 视图模型。
- 模型版本历史 / 回滚。
- 模型级 ACL（模型全局可见，与「仪表板全部可见」的既有决策一致）。

## 3. 数据流总览

```
资源库 CSV / Excel 文件 ─┐
SQL Server 表 / 查询    ─┴→ Job「加载成模型」步骤
                              ├→ DuckDB 文件 models.duckdb（每个模型一张表，CREATE OR REPLACE）
                              └→ 元数据 upsert 进 SQLite.data_models

仪表板「添加数据集」→ 选模型名 → POST /api/models/query → 读 models.duckdb → { columns, rows }
「数据模型」页        → GET /api/models → 读 SQLite.data_models
```

## 4. 存储与生命周期

### 4.1 DuckDB 数据文件

- 路径：`<dataDir>/models.duckdb`（默认 `~/.hustserver/models.duckdb`）。新增 `AppConfig.modelDbFile`（[config.ts](../../../apps/server/src/config.ts#L6-L27)）。
- 由 `ensureDirs` 覆盖的 `dataDir` 保证目录存在。
- 后端进程内维护**一个长驻文件连接**（首次使用时 lazy 打开），所有读写经 `semaphore(1)` 串行——DuckDB 单文件只允许单写者。
- 「覆盖」实现：先加载进 staging 表 → 成功后 `CREATE OR REPLACE TABLE <name> AS SELECT * FROM <staging>` → 删除 staging。任一步失败则 `<name>` 保持旧内容。

### 4.2 SQLite 元数据表

追加到 [migrate.ts](../../../apps/server/src/db/migrate.ts#L226-L237) 的 `migrate()`（在 `db.exec(JOB_TABLES)` 之后新增一段 `db.exec(MODEL_TABLES)`）：

```sql
CREATE TABLE IF NOT EXISTS data_models (
  name        TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,      -- 'csv' | 'excel' | 'sqlserver'
  source_ref  TEXT NOT NULL,      -- JSON：{resourcePath,format} 或 {connectionId,object?|query?}
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  loaded_at   INTEGER NOT NULL,
  row_count   INTEGER NOT NULL,
  columns     TEXT NOT NULL,      -- JSON: [{name,type}]
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_models_loaded ON data_models(loaded_at DESC);
```

`owner_id` 仅用于溯源展示，**不参与权限判定**（模型全局可见）。

## 5. Job 步骤类型 `load_model`

### 5.1 类型与配置

`JobStepType`（[repo.ts](../../../apps/server/src/modules/jobs/repo.ts#L5)）增加 `'load_model'`。步骤 `config` 为 JSON 字符串：

```ts
type LoadModelConfig =
  | {
      source: 'file';
      modelName: string;
      resourcePath: string;      // 资源库相对路径
      format?: 'csv' | 'excel';  // 缺省按扩展名推断
      delimiter?: string;
      hasHeader?: boolean;
      encoding?: string;
      sheet?: string;
    }
  | {
      source: 'sqlserver';
      modelName: string;
      connectionId: string;
      object?: string;           // 表/视图名
      query?: string;            // 与 object 二选一
    };
```

### 5.2 校验

在 [routes.ts](../../../apps/server/src/modules/jobs/routes.ts#L88-L167) 的手写 `parseBody` 中，`StepBody` 增加 `modelName` / `source` / `resourcePath` / `format` / `delimiter` / `hasHeader` / `encoding` / `sheet` / `object` 字段，并新增分支：

- `modelName` 必须匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`，否则 `400 模型名不合法`。
- `source === 'file'`：`resourcePath` 必须通过 `resolveResourcePath`（防越界）、扩展名在 `RESOURCE_EXTENSIONS` 内、文件实际存在；否则 `400 资源文件不可用`。
- `source === 'sqlserver'`：`connectionId` 可见性判定沿用 sql 分支（admin / shared / owner）；`object` 与 `query` 至少一项非空；否则 `400 连接不可用` / `400 需要指定表或查询`。
- 其他 `source` 值 → `400 步骤来源无效`。

### 5.3 执行

在 [service.ts](../../../apps/server/src/modules/jobs/service.ts#L62-L89) 的 `executeStep` 中，把现有「SQL 分支走 `else` 兜底」改为显式判断，新增：

```ts
} else if (step.type === 'load_model') {
  const cfg = JSON.parse(step.config) as LoadModelConfig;
  const job = jobs.findById(jobRun.job_id);            // 模型归属 = Job 的 owner
  const result = await modelStore.load(cfg, job?.owner_id ?? null);
  output = JSON.stringify({ modelName: cfg.modelName, rowCount: result.rowCount });
  return done(true, null);
}
```

`modelStore` 通过 `JobServiceDeps` 注入（[service.ts](../../../apps/server/src/modules/jobs/service.ts#L12-L17)）。

## 6. engine 层新增

新增 `packages/engine/src/engine/model.ts`，并加入 [index.ts](../../../packages/engine/src/index.ts) 导出：

- `openModelDb(file: string): Promise<DuckSession>` —— 与 `createSession()` 参数完全一致，仅路径由 `':memory:'` 换成文件路径（复用 `SPILL_DIR` / `DUCKDB_MEMORY_LIMIT` / `threads` 配置）。
- `loadCsvInto(conn, table, cfg)` / `loadExcelInto(conn, table, cfg)` / `loadSqlServerInto(conn, table, cfg)` —— 把 [inputCsv.ts](../../../packages/engine/src/nodes/inputCsv.ts)、[inputExcel.ts](../../../packages/engine/src/nodes/inputExcel.ts)、[inputSqlServer.ts](../../../packages/engine/src/nodes/inputSqlServer.ts) 中的读取逻辑抽成「在指定连接上物化出 `table`」的可复用函数（现有节点改为调用它们），Excel/DB 路径复用 [ingest.ts](../../../packages/engine/src/engine/ingest.ts) 的 `materializeRows`。

## 7. 后端模块 `apps/server/src/modules/models/`

### 7.1 文件

- `repo.ts`：`dataModelsRepo(db)`，提供 `upsert(row)` / `list()` / `findByName(name)` / `rename(oldName, newName)` / `remove(name)`。
- `service.ts`：`createModelStore({ config })`，内部持有长驻连接 + `semaphore(1)`，对外：
  - `load(cfg, ownerId: string | null): Promise<{ rowCount: number; columns: ColumnInfo[] }>` —— staging 加载 → 原子替换 → `describeTable`/`countRows` → upsert 元数据。
  - `query(name, limit): Promise<QueryResult>` —— `SELECT * FROM <name> LIMIT ?`。
  - `rename(oldName, newName)` / `remove(name)` —— DuckDB `ALTER TABLE … RENAME TO` / `DROP TABLE` + 元数据同步。
  - `close()` —— 供进程退出/测试清理。
- `routes.ts`：按下表注册（`preHandler: [guard, requireCap(...)]`）。

### 7.2 API

| 方法 | 路径 | 权限 | 入参 | 出参 |
|---|---|---|---|---|
| GET | `/api/models` | `dashboard.view` | — | `{ items: Array<{ name, sourceKind, sourceRef, ownerId, loadedAt, rowCount, columns }> }` |
| POST | `/api/models/query` | `dashboard.view` | `{ name, limit? }` | `QueryResult`（复用 [query.ts](../../../apps/server/src/modules/data/query.ts#L11-L15) 形状：`{columns, rows, truncated}`） |
| PATCH | `/api/models/:name` | `job` | `{ newName }` | `{ ok: true }` |
| DELETE | `/api/models/:name` | `job` | — | `{ ok: true }` |

- 取数上限沿用 `DEFAULT_LIMIT=1000` / `MAX_LIMIT=10000`。
- 模型不存在统一 `404 模型不存在`。
- 重命名需校验 `newName` 合法且未被占用（`409 模型名已存在`）。

### 7.3 装配

在 server 组装处创建 `modelStore` 单例，注入 [jobs/routes.ts](../../../apps/server/src/modules/jobs/routes.ts#L16-L23) 所需的 `jobService`（经 `JobServiceDeps`）与 `models/routes.ts`。

## 8. 前端集成

### 8.1 仪表板数据源

- [types.ts](../../../apps/web/src/features/dashboard/types.ts#L81-L92)：
  - `DatasetSource` 增加 `'model'`。
  - `DatasetDef` 增加 `| { kind: 'model'; modelName: string }`。
- [dataSource.ts](../../../apps/web/src/features/dashboard/services/dataSource.ts#L31-L63)：
  - 新增 `loadModelDataset(name, modelName): Promise<Dataset>` → `POST /api/models/query`，`source: 'model'`。
  - `hydrateDataset` 增加 `saved.def.kind === 'model'` 分支。
- [DataView.tsx](../../../apps/web/src/features/dashboard/DataView.tsx#L54-L321)：
  - `AddMode` 增加 `'model'`；`SOURCE_LABEL` 增加 `model: '模型'`。
  - 「添加数据集」下拉菜单增加第三项「从数据模型添加」。
  - 对话框 `mode === 'model'` 分支：`GET /api/models` 填充下拉（显示名称 + 行列数），载入走 `loadModelDataset`。

### 8.2 「数据模型」页

- 新增 `apps/web/src/pages/ModelsPage.tsx`：表格列出 `name / 来源 / 行数 / 列数 / 加载时间`；行内「重命名」「删除」按钮仅在 `hasCap('job')` 时渲染；操作后重新拉取列表。删除/重命名需二次确认（`window.confirm` 与现有页面保持一致的极简风格）。
- 重命名成功后提示：已引用旧名的仪表板会失效。
- [App.tsx](../../../apps/web/src/App.tsx#L152-L159) 新增路由 `/models`，`RequireCap cap="dashboard.view"`。
- [Layout.tsx](../../../apps/web/src/components/Layout.tsx#L17-L29) 导航新增「数据模型」（`hasCap('dashboard.view')`）。

### 8.3 Job 编辑器

- [types.ts](../../../apps/web/src/types.ts) 的 `JobStepType` 增加 `'load_model'`。
- [JobEditorPage.tsx](../../../apps/web/src/pages/JobEditorPage.tsx#L13-L97)：
  - `EditorStep` 增加 `modelName / source / resourcePath / object / query`（`format/delimiter/hasHeader/encoding/sheet` 按需，MVP 仅暴露文件选择 + 模型名 + SQL Server 表选择）。
  - 类型分段控件由 2 个按钮扩为 3 个（运行工作流 / 运行 SQL / 加载成模型）。
  - `defaultStepName` 增加 `load_model → '加载成模型'`，并加入 `DEFAULT_STEP_NAMES`。
  - 表单按 `source` 条件渲染：`file` 显示资源文件下拉（`GET /api/resources/tree` 过滤 `.csv/.xlsx/.xls`）+ 模型名输入；`sqlserver` 显示连接下拉 + 表下拉（`POST /api/data/tables`）+ 模型名输入。
  - 保存映射：`JSON.stringify({ source, modelName, resourcePath|connectionId+object })`。
  - 步骤列表徽标文案增加「加载成模型」。
- [JobRunDetailPage.tsx](../../../apps/web/src/pages/JobRunDetailPage.tsx) 的步骤类型展示文案同步增加 `load_model`。

## 9. 测试策略

- **engine**（`packages/engine`）：`model.ts` 单测——真实写入 `os.tmpdir()` 下的 duckdb 文件，验证建表、覆盖（旧数据被替换）、`openModelDb` 可重复打开已存在文件。运行：`pnpm --filter @hustserver/engine test`。
- **server**（`apps/server`）：
  - `models/routes` 测试：列表 / 取数 / 重命名 / 删除；权限 403（无 `dashboard.view` 时列表 403；无 `job` 时删除 403）。
  - `jobs/routes` 测试：`load_model` 步骤校验（模型名非法、file 源文件不存在、sqlserver 源缺 object/query）。
  - 运行：`pnpm --filter @hustserver/server test`（**当前基线 38 files / 207 tests**）。
- **web**：无前端测试基础设施（tsconfig 不含 test）→ 验证方式为 `pnpm --filter @hustserver/web build` + 浏览器实测。
- **端到端手测路径**：上传/选一个 CSV → 建 Job（步骤：加载成模型 `sales_model`）→ 运行 → 「数据模型」页出现 `sales_model` → 仪表板加数据集选 `sales_model` → 画图 → 重跑 Job 验证覆盖。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| DuckDB 文件被并发打开（多进程） | 仅后端单进程持有连接；测试用独立 tmp 文件 |
| 加载大表撑爆内存 | 复用 engine 既有 `memory_limit` 与 `SPILL_DIR` 配置（文件库仍可 spill） |
| 重命名导致既有仪表板引用失效 | 走现有 dataset 错误机制（hydrate 失败 → `setError`），UI 明确提示 |
| 模型名与 DuckDB 保留字冲突 | 统一经 `quoteIdent` 包裹；命名正则已排除特殊字符 |
| Job 步骤失败误删旧模型 | staging + `CREATE OR REPLACE` 原子替换，失败不动旧表 |
