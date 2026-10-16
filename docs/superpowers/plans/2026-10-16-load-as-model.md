# 实现计划：加载成模型（DuckDB 数据模型）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- 日期：2026-10-16
- Spec：[docs/superpowers/specs/2026-10-16-load-as-model-design.md](../specs/2026-10-16-load-as-model-design.md)（commit `56f1c63`，已批准）
- 执行方式：9 个任务串行执行，每任务独立实现 + 审查 + 单独 git commit

## Goal

新增一条**独立于运行生命周期**的持久化数据链路：Job 编排新增步骤类型 `load_model`，把「资源库 CSV/Excel 文件」或「SQL Server 表/查询」物化进常驻 DuckDB 文件 `<dataDir>/models.duckdb`（一个模型 = 一张表，模型名即表名，全局唯一），并把元数据写入 SQLite `data_models`；仪表板「添加数据集」新增按模型名取数的第三种来源；新增「数据模型」页供浏览/重命名/删除。

## Spec 修正说明（7 处落地细化）

1. **`createModelStore` 签名补 `db`**：spec §7.1 写 `createModelStore({ config })`，但元数据 upsert 需要 `dataModelsRepo(db)`，故落为 `createModelStore({ db, config })`（`db: Database`、`config: AppConfig`）。
2. **engine 模型加载函数独立实现，不重构三个输入节点**：spec §6 原写「抽自三节点（现有节点改为调用它们）」。精读源码后发现强行重构会改变既有工作流输入节点行为——`inputExcel.ts` 直接传 `cfg.path`（未 `resolveInputPath`）且返回 `note: sheetName`；`inputCsv.ts` 自行 `resolveInputPath` + `existsSync`；`inputSqlServer.ts` 用内嵌 `cfg.connection` 而非 `connectionId`。**故本计划只新增 `packages/engine/src/engine/model.ts`，算法与三节点逐字一致，不改动 `nodes/input*.ts`。**
3. **`DEFAULT_LIMIT` / `MAX_LIMIT` 与列类型推断在 `models/service.ts` 内自行定义**：spec §7.2 说「沿用 `data/query.ts` 的 `DEFAULT_LIMIT=1000` / `MAX_LIMIT=10000`」，但该文件的这两个常量是**模块私有且未导出**，且 `apps/server/src/modules/data/query.ts` 当前处于未提交 WIP 状态。**故在 `models/service.ts` 内自建同名常量与 `inferColumnType`/`toCell`（规则与 `data/query.ts` 完全一致），仅从该文件 `import type { QueryResult, QueryColumn, QueryCell }`。** 额外补一处：DuckDB 的 `BIGINT` 经 `getRowsJS()` 可能返回 JS `bigint`（`data/query.ts` 的 mssql 路径不会遇到），故这两个函数需兼容 `bigint`（安全范围内转 `number`，超出保留字符串），否则模型列类型会被误判为 `string`。
4. **重命名用 `PATCH`，前端用 `api.request`**：spec §7.2 定义为 `PATCH /api/models/:name`。前端 `apps/web/src/api.ts` 的 `ApiClient` **没有 `patch()` 方法**，故前端用 `api.request('PATCH', path, { body })`（`pages/ResourcesPage.tsx` 的 `submitRename` 已有先例）。后端保持 `PATCH`。
5. **任务数 11 → 9**：spec §9 的 engine / server / web 测试分项并入下列 9 个可独立验证与提交的任务（engine 模块、配置迁移、模型存储、模型 API、Job 步骤、仪表板来源、模型页、Job 编辑器、端到端验证）。
6. **模型 `owner_id` = Job 的 owner**：显式重申 spec §5.3——取 `jobs.findById(jobRun.job_id)?.owner_id`，**不是** `jobRun.triggered_by`。`owner_id` 仅用于溯源展示，不参与权限判定。
7. **`404 模型不存在` 统一三处**：`POST /api/models/query`、`PATCH /api/models/:name`、`DELETE /api/models/:name`。另补两条 spec 未列的错误文案：`POST /api/models/query` 缺 name → `400 缺少模型名`；`PATCH` 缺 `newName` → `400 缺少新模型名`。

## Architecture

```
资源库 CSV/Excel ─┐                                   Job 步骤 type = 'load_model'
SQL Server 表/查询 ─┴─→ apps/server/src/modules/jobs/service.ts :: executeStep
                                    │  modelStore.load(cfg, job.owner_id)
                                    ▼
                    apps/server/src/modules/models/service.ts  (createModelStore)
                      ├─ createSemaphore(1) 串行（DuckDB 单文件只允许单写者）
                      ├─ staging 表  ← engine/model.ts: loadCsvInto / loadExcelInto / loadSqlServerInto
                      ├─ promoteStagingTable(modelName, staging)  ← CREATE OR REPLACE TABLE（原子覆盖）
                      └─ describeTable + countRows → dataModelsRepo.upsert
                                    │
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
   <dataDir>/models.duckdb                        SQLite  data_models
   （每个模型一张表，模型名即表名）                 （name / source_kind / source_ref / owner_id /
                                                    loaded_at / row_count / columns / created_at）
              │
              ▼
   GET  /api/models              (dashboard.view) → 「数据模型」页 ModelsPage（列表/重命名/删除）
   POST /api/models/query        (dashboard.view) → 仪表板 loadModelDataset → Dataset.def.kind='model'
   PATCH  /api/models/:name      (job)            → 重命名
   DELETE /api/models/:name      (job)            → 删除
```

## Tech Stack

- 后端：Node ≥20，TypeScript 5.6，Fastify 5.12，better-sqlite3 13（同步事务），vitest 2.1
- 引擎：`@duckdb/node-api` 1.5.6-r.1（持久文件库），`mssql` 12，`xlsx` 0.18
- 前端：React 19，Vite 6，react-router-dom 7，Tailwind 4，zustand 5
- Monorepo：pnpm workspace（`@hustserver/engine` / `@hustserver/server` / `@hustserver/web`）

## Global Constraints（每个任务都必须遵守）

1. **模型语义 = 快照**：加载那一刻把数据固化进 DuckDB 文件；仪表板读的是冻结数据，源变化需重跑 Job。
2. **模型名即 DuckDB 表名，全局唯一**，正则 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`；常量 `MODEL_NAME_RE` 定义在 `apps/server/src/modules/models/service.ts` 并导出，`jobs/routes.ts` 复用同一常量（不得复制第二份）。
3. **持久文件库 = `<dataDir>/models.duckdb`**（新增 `AppConfig.modelDbFile`）。后端进程内维护**一个长驻连接**（首次使用时 lazy 打开），所有读写经 `createSemaphore(1)` 串行。
4. **覆盖语义 = staging 表加载 → `promoteStagingTable` 原子替换 → 删 staging**；任何一步失败，旧模型保持不变（`catch` 里 `dropTable(staging)` 后原样抛出）。
5. **权限不新增能力**：`GET /api/models` 与 `POST /api/models/query` = `requireCap('dashboard.view')`；`PATCH` / `DELETE /api/models/:name` = `requireCap('job')`。`data_models.owner_id` 仅溯源。
6. **engine 必须先构建**：`apps/server` 通过 `dist/` 解析 `@hustserver/engine`（其 `package.json` 为 `main: dist/index.js` / `types: dist/index.d.ts`）。Task 1 结束时**必须**执行 `pnpm --filter @hustserver/engine build`，否则 Task 3+ 的 server 测试/构建看不到 `openModelDb` 等新导出。
7. **`JobStepType` 增加 `'load_model'`**；`job_steps.type` / `job_step_runs.type` 均为 `TEXT` 无 CHECK 约束，**不需要迁移**。
8. **取数上限**：`DEFAULT_LIMIT = 1000` / `MAX_LIMIT = 10000`，在 `models/service.ts` 内自行定义（见 Spec 修正说明 3）。
9. **导入扩展名**：server / engine / web 源码一律 `.js` 后缀；web 的 dashboard feature 内部使用 `@bi/*` 别名，`pages/` 与 `components/` 用相对路径 `../api.js`。
10. **测试命令**：`pnpm --filter @hustserver/server test`（= `vitest run`；**当前基线 38 files / 207 tests**，只增不减）；`pnpm --filter @hustserver/engine test`（= `vitest run`）。
11. **构建命令**：`pnpm --filter @hustserver/engine build` / `pnpm --filter @hustserver/server build` / `pnpm --filter @hustserver/web build`（分别 = `tsc -p tsconfig.json`、`tsc -p tsconfig.json`、`tsc -p tsconfig.json && vite build`）。
12. **禁止执行**：`pnpm --filter @hustserver/web test`（前端无测试基础设施，必失败）；`pnpm --filter @hustserver/workflow-designer build`（该包无 build 脚本，报 `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`）。
13. **前端验证方式** = `pnpm --filter @hustserver/web build` + 浏览器实测（`apps/web/tsconfig.json` 的 `include: ["src"]` 不含 test，且仓库无 React Testing Library）。
14. **执行前先处理未提交的前置 WIP**：开工前先跑 `git status --porcelain`，确认 `apps/web/src/features/dashboard/` 下的既有改动（含未跟踪新文件 `apps/web/src/features/dashboard/DataView.tsx`）已单独提交或明确保留；**Task 6 会改 `DataView.tsx`，不得把前置 WIP 与本计划的改动混进同一个 commit**。提交时逐个显式 `git add <file>`。
15. **Git 纪律**：每任务结束单独 commit（`feat:` / `fix:` / `docs:` / `chore:` + 中文一句话）；**禁止** `git add -A` / `git add .` / `git add <目录>`；不更新 git config；不主动 push；提交前用 `git diff --cached --name-only` 确认。
16. **派发子代理绝不传 `model` 参数**（Trae 平台会报 4023 错误）；停进程用 `StopCommand`，禁止 `kill` / `pkill`。
17. **类型检查边界**：`apps/server/tsconfig.json` 与 `packages/engine/tsconfig.json` 的 `include` 为 `["src/**/*.ts"]`、`apps/web/tsconfig.json` 为 `["src"]`，均**不含 test** → 测试文件不做类型检查，但仍须能正确编译运行。

---

## Task 1：engine 模型加载模块

**Files**
- 新增：`packages/engine/src/engine/model.ts`
- 修改：`packages/engine/src/index.ts`（追加导出）
- 新增测试：`packages/engine/test/model.test.ts`

**Interfaces**
```ts
// packages/engine/src/engine/model.ts
export interface ModelCsvConfig {
  /** 资源文件绝对路径（调用方已解析到资源库/上传目录内）。 */
  path: string;
  delimiter?: string;
  hasHeader?: boolean;
  encoding?: 'utf-8' | 'gbk';
}
export interface ModelExcelConfig { path: string; sheet?: string; hasHeader?: boolean }
export interface ModelSqlServerConfig { connection: SqlServerConnection; query: string }

export function openModelDb(file: string): Promise<DuckSession>;
export function dropTable(connection: DuckDBConnection, table: string): Promise<void>;
export function promoteStagingTable(connection: DuckDBConnection, target: string, staging: string): Promise<void>;
export function loadCsvInto(connection: DuckDBConnection, table: string, cfg: ModelCsvConfig): Promise<number>;
export function loadExcelInto(connection: DuckDBConnection, table: string, cfg: ModelExcelConfig): Promise<number>;
export function loadSqlServerInto(connection: DuckDBConnection, table: string, cfg: ModelSqlServerConfig): Promise<number>;
```
Consumes：`createSession` 的参数约定（`config.ts` 的 `SPILL_DIR` / `DUCKDB_MEMORY_LIMIT`）、`materializeRows`（`engine/ingest.ts`）、`countRows`（`engine/duckdb.ts`）、`readExcelSheet`（`util/excel.ts`）、`normalizeDelimiter`（`util/format.ts`）、`resolveInputPath`/`tempPath`/`safeUnlink`/`decodeFileToUtf8`（`util/io.ts`）、`quoteIdent`/`quoteString`（`util/sqlIdent.ts`）、`buildMssqlConfig`（`util/mssql.ts`）。
Produces：`openModelDb` / `dropTable` / `promoteStagingTable` / `loadCsvInto` / `loadExcelInto` / `loadSqlServerInto` + 三个配置类型，供 Task 3 的 `models/service.ts` 使用。

**Steps**

- [ ] 写失败测试 `packages/engine/test/model.test.ts`：
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeSession,
  countRows,
  describeTable,
  loadCsvInto,
  loadExcelInto,
  openModelDb,
  promoteStagingTable,
} from '../src/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-engine-model-'));
const dbFile = path.join(tmp, 'models.duckdb');

function writeCsv(name: string, content: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('engine 模型加载', () => {
  it('openModelDb + loadCsvInto 建表并返回列与行数', async () => {
    const csv = writeCsv('sales.csv', 'id,name\n1,a\n2,b\n');
    const session = await openModelDb(dbFile);
    try {
      const rowCount = await loadCsvInto(session.connection, 'stg_sales', { path: csv });
      expect(rowCount).toBe(2);
      const cols = await describeTable(session.connection, 'stg_sales');
      expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
    } finally {
      closeSession(session);
    }
  });

  it('promoteStagingTable 原子覆盖同名表并清理 staging', async () => {
    const first = writeCsv('a.csv', 'id,v\n1,a\n2,b\n3,c\n');
    const second = writeCsv('b.csv', 'id,v\n9,z\n');
    const session = await openModelDb(dbFile);
    try {
      await loadCsvInto(session.connection, 'stg_a', { path: first });
      await promoteStagingTable(session.connection, 'sales_model', 'stg_a');
      expect(await countRows(session.connection, 'sales_model')).toBe(3);
      await expect(describeTable(session.connection, 'stg_a')).rejects.toThrow();

      await loadCsvInto(session.connection, 'stg_b', { path: second });
      await promoteStagingTable(session.connection, 'sales_model', 'stg_b');
      expect(await countRows(session.connection, 'sales_model')).toBe(1);
      await expect(describeTable(session.connection, 'stg_b')).rejects.toThrow();
    } finally {
      closeSession(session);
    }
  });

  it('文件库持久化：关闭后重新打开仍能读到模型', async () => {
    const csv = writeCsv('p.csv', 'id\n1\n2\n');
    const s1 = await openModelDb(dbFile);
    await loadCsvInto(s1.connection, 'stg_p', { path: csv });
    await promoteStagingTable(s1.connection, 'persist_model', 'stg_p');
    closeSession(s1);

    const s2 = await openModelDb(dbFile);
    try {
      expect(await countRows(s2.connection, 'persist_model')).toBe(2);
    } finally {
      closeSession(s2);
    }
  });

  it('loadExcelInto 从 xlsx 建表', async () => {
    const xlsxPath = path.join(tmp, 'book.xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['id', 'name'], [1, 'x'], [2, 'y']]), 'Sheet1');
    XLSX.writeFile(wb, xlsxPath);

    const session = await openModelDb(dbFile);
    try {
      const rowCount = await loadExcelInto(session.connection, 'excel_model', { path: xlsxPath });
      expect(rowCount).toBe(2);
      const cols = await describeTable(session.connection, 'excel_model');
      expect(cols.map((c) => c.name)).toEqual(['id', 'name']);
    } finally {
      closeSession(session);
    }
  });
});
```
- [ ] 运行 `pnpm --filter @hustserver/engine test`，确认新文件**失败**（`openModelDb` 未导出）。
- [ ] 新建 `packages/engine/src/engine/model.ts`，完整实现：
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sql from 'mssql';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { DUCKDB_MEMORY_LIMIT, SPILL_DIR, ensureDirs } from '../config.js';
import type { SqlServerConnection } from '../types.js';
import { readExcelSheet } from '../util/excel.js';
import { normalizeDelimiter } from '../util/format.js';
import { decodeFileToUtf8, resolveInputPath, safeUnlink, tempPath } from '../util/io.js';
import { buildMssqlConfig } from '../util/mssql.js';
import { quoteIdent, quoteString } from '../util/sqlIdent.js';
import { countRows, type DuckSession } from './duckdb.js';
import { materializeRows } from './ingest.js';

export interface ModelCsvConfig {
  /** 资源文件绝对路径（调用方已解析到资源库/上传目录内）。 */
  path: string;
  delimiter?: string;
  hasHeader?: boolean;
  encoding?: 'utf-8' | 'gbk';
}

export interface ModelExcelConfig {
  path: string;
  sheet?: string;
  hasHeader?: boolean;
}

export interface ModelSqlServerConfig {
  connection: SqlServerConnection;
  query: string;
}

/**
 * 打开常驻的模型 DuckDB 文件库。
 * 参数与 createSession 完全一致，仅把 ':memory:' 换成文件路径（仍复用 SPILL_DIR / 内存上限 / 线程数）。
 */
export async function openModelDb(file: string): Promise<DuckSession> {
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = await DuckDBInstance.create(file, {
    temp_directory: SPILL_DIR,
    memory_limit: DUCKDB_MEMORY_LIMIT,
    threads: String(Math.max(2, Math.min(8, os.cpus().length))),
  });
  const connection = await instance.connect();
  return { instance, connection };
}

/** 删除表（不存在则忽略）。 */
export async function dropTable(connection: DuckDBConnection, table: string): Promise<void> {
  await connection.run(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
}

/** 用 staging 表原子替换目标表；目标已存在时内容被整体替换，失败时目标保持原样。 */
export async function promoteStagingTable(
  connection: DuckDBConnection,
  target: string,
  staging: string,
): Promise<void> {
  await connection.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(target)} AS SELECT * FROM ${quoteIdent(staging)}`,
  );
  await dropTable(connection, staging);
}

/** 把 CSV 文件物化为指定表并返回行数；算法与输入节点 inputCsv 一致。 */
export async function loadCsvInto(
  connection: DuckDBConnection,
  table: string,
  cfg: ModelCsvConfig,
): Promise<number> {
  const sourcePath = resolveInputPath(cfg.path);
  if (!fs.existsSync(sourcePath)) throw new Error(`CSV 文件不存在：${sourcePath}`);

  const delimiter = normalizeDelimiter(cfg.delimiter);
  const hasHeader = cfg.hasHeader !== false;

  let readPath = sourcePath;
  let tempFile: string | null = null;
  if (cfg.encoding === 'gbk') {
    const text = decodeFileToUtf8(sourcePath, 'gbk');
    tempFile = tempPath('.csv');
    fs.writeFileSync(tempFile, text, 'utf-8');
    readPath = tempFile;
  }

  try {
    await connection.run(
      `CREATE OR REPLACE TABLE ${quoteIdent(table)} AS
       SELECT * FROM read_csv_auto(${quoteString(readPath)}, delim = ${quoteString(delimiter)}, header = ${hasHeader ? 'true' : 'false'}, sample_size = -1)`,
    );
    return await countRows(connection, table);
  } finally {
    if (tempFile) safeUnlink(tempFile);
  }
}

/** 把 Excel 工作表物化为指定表并返回行数；算法与输入节点 inputExcel 一致。 */
export async function loadExcelInto(
  connection: DuckDBConnection,
  table: string,
  cfg: ModelExcelConfig,
): Promise<number> {
  const { columns, dataRows } = readExcelSheet(cfg.path, cfg.sheet, cfg.hasHeader !== false);
  const rows = dataRows.map((row) => {
    const record: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      record[column] = row[index] ?? null;
    });
    return record;
  });
  return materializeRows(connection, table, rows, columns);
}

/** 执行 SQL Server 查询并物化为指定表，返回行数；算法与输入节点 inputSqlServer 一致。 */
export async function loadSqlServerInto(
  connection: DuckDBConnection,
  table: string,
  cfg: ModelSqlServerConfig,
): Promise<number> {
  const pool = await new sql.ConnectionPool(buildMssqlConfig(cfg.connection)).connect();
  try {
    const result = await pool.request().query(cfg.query);
    const rows = (result.recordset ?? []) as Array<Record<string, unknown>>;
    const columns =
      rows.length > 0
        ? Object.keys(rows[0])
        : result.recordset && result.recordset.columns
          ? Object.keys(result.recordset.columns)
          : [];
    return await materializeRows(connection, table, rows, columns);
  } finally {
    await pool.close().catch(() => undefined);
  }
}
```
- [ ] 在 `packages/engine/src/index.ts`：先把第 43 行 `export type { DuckSession } from './engine/duckdb.js';` 改为
```ts
export type { DuckSession, ColumnInfo } from './engine/duckdb.js';
```
然后在其后追加
```ts
export {
  openModelDb,
  dropTable,
  promoteStagingTable,
  loadCsvInto,
  loadExcelInto,
  loadSqlServerInto,
} from './engine/model.js';
export type { ModelCsvConfig, ModelExcelConfig, ModelSqlServerConfig } from './engine/model.js';
```
（`ColumnInfo` 必须一并导出：Task 3 的 `LoadResult.columns` 使用该类型。）
- [ ] 运行 `pnpm --filter @hustserver/engine test`，确认 **2 个测试文件全部通过**（`runStoreSink.test.ts` + `model.test.ts`）。
- [ ] 运行 `pnpm --filter @hustserver/engine build`，确认退出码 0 且 `packages/engine/dist/engine/model.js` 与 `dist/engine/model.d.ts` 已生成。
- [ ] Commit：`feat: engine 新增 DuckDB 模型加载模块（openModelDb/load*Into/promoteStagingTable）`

---

## Task 2：后端配置与迁移

**Files**
- 修改：`apps/server/src/config.ts`
- 修改：`apps/server/src/db/migrate.ts`
- 修改测试：`apps/server/test/migrate.test.ts`
- 修改测试：`apps/server/test/config.test.ts`

**Interfaces**
- Consumes：无。
- Produces：`AppConfig.modelDbFile: string`（Task 3 的 `createModelStore` 读取）；SQLite 表 `data_models` + 索引 `idx_data_models_loaded`（Task 3 的 `dataModelsRepo` 使用）。

**Steps**

- [ ] 改 `apps/server/src/config.ts`：`AppConfig` 中 `dbFile: string;` 之后插入一行
```ts
  /** 持久化数据模型库（DuckDB 单文件）。 */
  modelDbFile: string;
```
- [ ] 改 `apps/server/src/config.ts`：`loadConfig` 返回对象中 `dbFile: path.join(dataDir, 'metadata.sqlite'),` 之后插入一行
```ts
    modelDbFile: path.join(dataDir, 'models.duckdb'),
```
- [ ] 改 `apps/server/src/db/migrate.ts`：在 `JOB_INDEXES` 常量（第 205-211 行）**之后**新增常量
```ts
const MODEL_TABLES = `
CREATE TABLE IF NOT EXISTS data_models (
  name        TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  loaded_at   INTEGER NOT NULL,
  row_count   INTEGER NOT NULL,
  columns     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_models_loaded ON data_models(loaded_at DESC);
`;
```
- [ ] 改 `apps/server/src/db/migrate.ts`：`migrate()` 中 `db.exec(JOB_TABLES);` 之后插入一行 `db.exec(MODEL_TABLES);`
- [ ] 改 `apps/server/test/migrate.test.ts`：把 `'user_roles']) {` 改为 `'user_roles', 'data_models']) {`（即把 `'data_models'` 追加到「创建全部业务表」的断言数组）；并在 `describe('migrate', ...)` 末尾新增一个用例
```ts
  it('data_models 具备 loaded_at 索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='data_models'").all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_data_models_loaded');
  });
```
- [ ] 改 `apps/server/test/config.test.ts`：在 `expect(cfg.dbFile).toBe('/tmp/hustserver-test/metadata.sqlite');` 之后新增一行
```ts
    expect(cfg.modelDbFile).toBe('/tmp/hustserver-test/models.duckdb');
```
- [ ] 运行 `pnpm --filter @hustserver/server test`，确认全部通过（基线 38 files / 207 tests → 208 tests，0 失败）。
- [ ] Commit：`feat: 新增模型库路径配置与 data_models 元数据表迁移`

---

## Task 3：模型元数据仓储与存储服务

**Files**
- 新增：`apps/server/src/modules/models/repo.ts`
- 新增：`apps/server/src/modules/models/service.ts`
- 新增测试：`apps/server/test/models-service.test.ts`

**Interfaces**
```ts
// apps/server/src/modules/models/repo.ts
export type ModelSourceKind = 'csv' | 'excel' | 'sqlserver';
export interface DataModelRow {
  name: string; source_kind: ModelSourceKind; source_ref: string;
  owner_id: string | null; loaded_at: number; row_count: number;
  columns: string; created_at: number;
}
export interface DataModelsRepo {
  upsert(row: { name: string; sourceKind: ModelSourceKind; sourceRef: string; ownerId: string | null;
                loadedAt: number; rowCount: number; columns: string }): DataModelRow;
  list(): DataModelRow[];
  findByName(name: string): DataModelRow | null;
  rename(oldName: string, newName: string): boolean;
  remove(name: string): boolean;
}
export function dataModelsRepo(db: Database): DataModelsRepo;

// apps/server/src/modules/models/service.ts
export const MODEL_NAME_RE: RegExp;                     // ^[A-Za-z_][A-Za-z0-9_]{0,63}$
export type LoadModelConfig =
  | { source: 'file'; modelName: string; resourcePath: string; format?: 'csv' | 'excel';
      delimiter?: string; hasHeader?: boolean; encoding?: 'utf-8' | 'gbk'; sheet?: string }
  | { source: 'sqlserver'; modelName: string; connectionId: string; object?: string; query?: string };
export interface LoadResult { rowCount: number; columns: ColumnInfo[] }
export interface ModelStore {
  load(cfg: LoadModelConfig, ownerId: string | null): Promise<LoadResult>;
  query(name: string, limit?: number): Promise<QueryResult>;
  rename(oldName: string, newName: string): Promise<void>;
  remove(name: string): Promise<void>;
  close(): void;
}
export function createModelStore(deps: { db: Database; config: AppConfig }): ModelStore;
```
Consumes：`AppConfig.modelDbFile`（Task 2）、`data_models` 表（Task 2）、engine 的 `openModelDb` / `dropTable` / `promoteStagingTable` / `loadCsvInto` / `loadExcelInto` / `loadSqlServerInto` / `countRows` / `describeTable` / `quoteIdent` / `closeSession`（Task 1，**需 engine 已构建**）、`connectionsRepo` / `decryptConfig`（连接解密）、`createSemaphore`（`runs/queue.ts`）、`resolveResourcePath`（`resources/paths.ts`）。
Produces：`createModelStore` / `ModelStore` / `LoadModelConfig` / `MODEL_NAME_RE` / `dataModelsRepo`，供 Task 4（routes + 装配）与 Task 5（Job 步骤执行）使用。

**Steps**

- [ ] 写失败测试 `apps/server/test/models-service.test.ts`：
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { dataModelsRepo } from '../src/modules/models/repo.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';

let db: Database.Database;
let store: ModelStore;
/** data_models.owner_id 有 REFERENCES users(id) 外键且 migrate 打开了 foreign_keys，
 *  故必须插入真实用户行，不能使用任意字符串。 */
let ownerId: string;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-svc-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-svc-res-'));
  fs.writeFileSync(path.join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n3,30\n', 'utf-8');
  fs.writeFileSync(path.join(resourceDir, 'small.csv'), 'id,amount\n9,90\n', 'utf-8');

  db = new Database(':memory:');
  migrate(db);
  ownerId = 'u1';
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(ownerId, 'u1', 'x', 'workflow_author', 'active', Date.now(), Date.now());
  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  store = createModelStore({ db, config: cfg });
});

afterEach(() => {
  store.close();
  db.close();
});

describe('createModelStore', () => {
  it('load 从资源库 CSV 建模型并 upsert 元数据', async () => {
    const res = await store.load(
      { source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' },
      ownerId,
    );
    expect(res.rowCount).toBe(3);
    expect(res.columns.map((c) => c.name)).toEqual(['id', 'amount']);

    const row = dataModelsRepo(db).findByName('sales_model')!;
    expect(row.source_kind).toBe('csv');
    expect(row.row_count).toBe(3);
    expect(row.owner_id).toBe(ownerId);
    expect(JSON.parse(row.source_ref)).toEqual({ resourcePath: 'sales.csv', format: 'csv' });
    expect((JSON.parse(row.columns) as Array<{ name: string }>).map((c) => c.name)).toEqual(['id', 'amount']);
  });

  it('重复 load 同名模型为覆盖：行数按新数据刷新', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    const again = await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'small.csv' }, null);
    expect(again.rowCount).toBe(1);
    expect(dataModelsRepo(db).findByName('sales_model')!.row_count).toBe(1);
    const q = await store.query('sales_model');
    expect(q.rows).toHaveLength(1);
  });

  it('加载失败时不破坏已有模型', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    await expect(
      store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'missing.csv' }, null),
    ).rejects.toThrow();
    const q = await store.query('sales_model');
    expect(q.rows).toHaveLength(3);
  });

  it('query 返回 { columns, rows, truncated }', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    const q = await store.query('sales_model');
    expect(q.columns.map((c) => c.name)).toEqual(['id', 'amount']);
    expect(q.columns.map((c) => c.type)).toEqual(['number', 'number']);
    expect(q.rows).toEqual([[1, 10], [2, 20], [3, 30]]);
    expect(q.truncated).toBe(false);
  });

  it('rename 同步 DuckDB 表与元数据；remove 双双删除', async () => {
    await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);
    await store.rename('sales_model', 'sales_model_v2');
    expect(dataModelsRepo(db).findByName('sales_model')).toBeNull();
    expect(dataModelsRepo(db).findByName('sales_model_v2')).not.toBeNull();
    expect((await store.query('sales_model_v2')).rows).toHaveLength(3);

    await store.remove('sales_model_v2');
    expect(dataModelsRepo(db).findByName('sales_model_v2')).toBeNull();
    await expect(store.query('sales_model_v2')).rejects.toThrow();
  });
});
```
- [ ] 运行 `pnpm --filter @hustserver/server test`，确认新文件**失败**（模块不存在）。
- [ ] 新建 `apps/server/src/modules/models/repo.ts`：
```ts
import type { Database } from 'better-sqlite3';

export type ModelSourceKind = 'csv' | 'excel' | 'sqlserver';

export interface DataModelRow {
  name: string;
  source_kind: ModelSourceKind;
  source_ref: string;
  owner_id: string | null;
  loaded_at: number;
  row_count: number;
  columns: string;
  created_at: number;
}

export interface DataModelsRepo {
  upsert(row: {
    name: string;
    sourceKind: ModelSourceKind;
    sourceRef: string;
    ownerId: string | null;
    loadedAt: number;
    rowCount: number;
    columns: string;
  }): DataModelRow;
  list(): DataModelRow[];
  findByName(name: string): DataModelRow | null;
  rename(oldName: string, newName: string): boolean;
  remove(name: string): boolean;
}

export function dataModelsRepo(db: Database): DataModelsRepo {
  const byName = db.prepare('SELECT * FROM data_models WHERE name = ?');
  const get = (name: string) => (byName.get(name) as DataModelRow | undefined) ?? null;
  const all = db.prepare('SELECT * FROM data_models ORDER BY loaded_at DESC');
  const upsertStmt = db.prepare(`
    INSERT INTO data_models (name, source_kind, source_ref, owner_id, loaded_at, row_count, columns, created_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET
      source_kind = excluded.source_kind,
      source_ref  = excluded.source_ref,
      owner_id    = excluded.owner_id,
      loaded_at   = excluded.loaded_at,
      row_count   = excluded.row_count,
      columns     = excluded.columns
  `);
  const renameStmt = db.prepare('UPDATE data_models SET name = ? WHERE name = ?');
  const del = db.prepare('DELETE FROM data_models WHERE name = ?');

  return {
    upsert(row) {
      upsertStmt.run(
        row.name, row.sourceKind, row.sourceRef, row.ownerId,
        row.loadedAt, row.rowCount, row.columns, Date.now(),
      );
      return get(row.name)!;
    },
    list: () => all.all() as DataModelRow[],
    findByName: get,
    rename: (oldName, newName) => renameStmt.run(newName, oldName).changes > 0,
    remove: (name) => del.run(name).changes > 0,
  };
}
```
- [ ] 新建 `apps/server/src/modules/models/service.ts`：
```ts
import fs from 'node:fs';
import path from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { Database } from 'better-sqlite3';
import {
  closeSession,
  countRows,
  describeTable,
  dropTable,
  loadCsvInto,
  loadExcelInto,
  loadSqlServerInto,
  openModelDb,
  promoteStagingTable,
  quoteIdent,
  type ColumnInfo,
  type DuckSession,
  type SqlServerConnection,
} from '@hustserver/engine';
import { nanoid } from 'nanoid';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import type { QueryCell, QueryColumn, QueryResult } from '../data/query.js';
import { resolveResourcePath } from '../resources/paths.js';
import { createSemaphore } from '../runs/queue.js';
import { dataModelsRepo, type ModelSourceKind } from './repo.js';

/** 模型名即 DuckDB 表名：字母/下划线开头，仅含字母数字下划线，最长 64。 */
export const MODEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 取数上限（与 modules/data/query.ts 保持一致，避免依赖其模块私有常量）。 */
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

export type LoadModelConfig =
  | {
      source: 'file';
      modelName: string;
      resourcePath: string;
      format?: 'csv' | 'excel';
      delimiter?: string;
      hasHeader?: boolean;
      encoding?: 'utf-8' | 'gbk';
      sheet?: string;
    }
  | {
      source: 'sqlserver';
      modelName: string;
      connectionId: string;
      object?: string;
      query?: string;
    };

export interface LoadResult {
  rowCount: number;
  columns: ColumnInfo[];
}

export interface ModelStore {
  load(cfg: LoadModelConfig, ownerId: string | null): Promise<LoadResult>;
  query(name: string, limit?: number): Promise<QueryResult>;
  rename(oldName: string, newName: string): Promise<void>;
  remove(name: string): Promise<void>;
  close(): void;
}

/** 按列的首个非空值推断类型（规则与 modules/data/query.ts 一致，另兼容 DuckDB BIGINT）。 */
function inferColumnType(values: unknown[]): QueryColumn['type'] {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'bigint') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (v instanceof Date) return 'date';
    if (typeof v === 'string') return Number.isNaN(Date.parse(v)) ? 'string' : 'date';
    return 'string';
  }
  return 'unknown';
}

/** 安全整数范围内的 bigint 转 number，超出则保留字符串，避免精度丢失。 */
const MAX_SAFE = 9007199254740991n;

function toCell(v: unknown): QueryCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v >= -MAX_SAFE && v <= MAX_SAFE ? Number(v) : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/** 把点号分隔的对象名逐段加引号（支持 `sales` 与 `dbo.sales`）。 */
function quoteObjectName(object: string): string {
  return object
    .split('.')
    .map((part) => quoteIdent(part.trim()))
    .join('.');
}

export function createModelStore(deps: { db: Database; config: AppConfig }): ModelStore {
  const { db, config } = deps;
  const repo = dataModelsRepo(db);
  const connections = connectionsRepo(db);
  // DuckDB 单文件只允许单写者：所有读写串行
  const sem = createSemaphore(1);

  let session: DuckSession | null = null;
  async function conn(): Promise<DuckDBConnection> {
    if (!session) session = await openModelDb(config.modelDbFile);
    return session.connection;
  }

  async function doLoad(cfg: LoadModelConfig, ownerId: string | null): Promise<LoadResult> {
    const connection = await conn();
    const staging = `__stg_${nanoid(8)}`;
    let sourceKind: ModelSourceKind = 'csv';
    let sourceRef: Record<string, unknown> = {};
    let rowCount = 0;
    try {
      if (cfg.source === 'file') {
        const abs = resolveResourcePath(config.resourceDir, cfg.resourcePath);
        const format = cfg.format ?? (path.extname(abs).toLowerCase() === '.csv' ? 'csv' : 'excel');
        if (!fs.existsSync(abs)) throw new Error(`资源文件不存在：${cfg.resourcePath}`);
        if (format === 'csv') {
          rowCount = await loadCsvInto(connection, staging, {
            path: abs,
            delimiter: cfg.delimiter,
            hasHeader: cfg.hasHeader,
            encoding: cfg.encoding,
          });
        } else {
          rowCount = await loadExcelInto(connection, staging, {
            path: abs,
            sheet: cfg.sheet,
            hasHeader: cfg.hasHeader,
          });
        }
        sourceKind = format;
        sourceRef = { resourcePath: cfg.resourcePath, format };
      } else {
        const row = connections.findById(cfg.connectionId);
        if (!row) throw new Error('连接不存在');
        const connConfig = decryptConfig(
          row.config_encrypted,
          config.encryptionKey,
        ) as unknown as SqlServerConnection;
        const object = cfg.object?.trim();
        const query = cfg.query?.trim()
          ? cfg.query.trim()
          : object
            ? `SELECT * FROM ${quoteObjectName(object)}`
            : '';
        if (!query) throw new Error('需要指定表或查询');
        rowCount = await loadSqlServerInto(connection, staging, { connection: connConfig, query });
        sourceKind = 'sqlserver';
        sourceRef = {
          connectionId: cfg.connectionId,
          ...(object ? { object } : {}),
          ...(cfg.query ? { query: cfg.query } : {}),
        };
      }
      await promoteStagingTable(connection, cfg.modelName, staging);
    } catch (err) {
      await dropTable(connection, staging).catch(() => undefined);
      throw err;
    }
    const columns = await describeTable(connection, cfg.modelName);
    repo.upsert({
      name: cfg.modelName,
      sourceKind,
      sourceRef: JSON.stringify(sourceRef),
      ownerId,
      loadedAt: Date.now(),
      rowCount,
      columns: JSON.stringify(columns),
    });
    return { rowCount, columns };
  }

  async function doQuery(name: string, limit?: number): Promise<QueryResult> {
    const connection = await conn();
    const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const total = await countRows(connection, name);
    const reader = await connection.runAndReadAll(
      `SELECT * FROM ${quoteIdent(name)} LIMIT ${cap}`,
    );
    const names = reader.columnNames();
    const raw = reader.getRowsJS() as unknown[][];
    const columns: QueryColumn[] = names.map((col, i) => ({
      name: col,
      type: inferColumnType(raw.map((r) => r[i])),
    }));
    const rows = raw.map((r) => r.map((v) => toCell(v)));
    return { columns, rows, truncated: total > rows.length };
  }

  async function doRename(oldName: string, newName: string): Promise<void> {
    const connection = await conn();
    await connection.run(`ALTER TABLE ${quoteIdent(oldName)} RENAME TO ${quoteIdent(newName)}`);
    repo.rename(oldName, newName);
  }

  async function doRemove(name: string): Promise<void> {
    const connection = await conn();
    await dropTable(connection, name);
    repo.remove(name);
  }

  return {
    load: (cfg, ownerId) => sem.run(() => doLoad(cfg, ownerId)),
    query: (name, limit) => sem.run(() => doQuery(name, limit)),
    rename: (oldName, newName) => sem.run(() => doRename(oldName, newName)),
    remove: (name) => sem.run(() => doRemove(name)),
    close() {
      closeSession(session);
      session = null;
    },
  };
}
```
- [ ] 运行 `pnpm --filter @hustserver/server test`，确认 `models-service.test.ts` 的 5 个用例全部通过，且整体无失败。
- [ ] Commit：`feat: 新增数据模型仓储与模型存储服务（staging 原子覆盖 + DuckDB 单写者串行）`

---

## Task 4：模型 API 路由与装配

**Files**
- 新增：`apps/server/src/modules/models/routes.ts`
- 修改：`apps/server/src/server.ts`
- 新增测试：`apps/server/test/models-routes.test.ts`

**Interfaces**
```ts
// apps/server/src/modules/models/routes.ts
export interface ModelRouteDeps {
  db: Database; config: AppConfig; users: UsersRepo; sessions: SessionsRepo; modelStore: ModelStore;
}
export function modelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void;
```
HTTP 契约（与 spec §7.2 一致）：
| 方法 | 路径 | 权限 | 入参 | 出参 / 错误 |
|---|---|---|---|---|
| GET | `/api/models` | `dashboard.view` | — | `{ items: Array<{ name, sourceKind, sourceRef, ownerId, loadedAt, rowCount, columns }> }` |
| POST | `/api/models/query` | `dashboard.view` | `{ name, limit? }` | `QueryResult`；缺 name → `400 缺少模型名`；不存在 → `404 模型不存在`；读失败 → `400 读取模型失败` |
| PATCH | `/api/models/:name` | `job` | `{ newName }` | `{ ok: true }`；缺 newName → `400 缺少新模型名`；名不合法 → `400 模型名不合法`；不存在 → `404 模型不存在`；被占用 → `409 模型名已存在` |
| DELETE | `/api/models/:name` | `job` | — | `{ ok: true }`；不存在 → `404 模型不存在` |

Consumes：`createModelStore` / `ModelStore` / `MODEL_NAME_RE` / `dataModelsRepo`（Task 3）、`requireAuth` / `requireCap`（`plugins/guards.ts`）。
Produces：`modelRoutes`；`AppOverrides.modelStore?: ModelStore`（供测试注入）。

**Steps**

- [ ] 写失败测试 `apps/server/test/models-routes.test.ts`：
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createModelStore, type ModelStore } from '../src/modules/models/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

let app: FastifyInstance;
let store: ModelStore;
let authorCookie: string;
let wfCookie: string;
let viewerCookie: string;

async function login(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: 'pw123456' },
  });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-route-data-'));
  const resourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-models-route-res-'));
  fs.writeFileSync(path.join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n3,30\n', 'utf-8');

  const db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const passwordHash = await hashPassword('pw123456');
  await users.create({ username: 'author', passwordHash, roles: ['dashboard_author'] });
  await users.create({ username: 'wf', passwordHash, roles: ['workflow_author'] });
  await users.create({ username: 'viewer', passwordHash, roles: ['dashboard_viewer'] });

  const cfg = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_RESOURCE_DIR: resourceDir,
  });
  store = createModelStore({ db, config: cfg });
  await store.load({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }, null);

  app = await buildServer({ db, config: cfg, logger: false, overrides: { modelStore: store } });
  await app.ready();
  authorCookie = await login('author');
  wfCookie = await login('wf');
  viewerCookie = await login('viewer');
});

afterEach(() => {
  store.close();
});

describe('GET /api/models', () => {
  it('未登录 401；viewer/author 可读，wf（无 dashboard.view）403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(401);

    const viewer = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: viewerCookie } });
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json().items[0]).toMatchObject({ name: 'sales_model', sourceKind: 'csv', rowCount: 3 });

    const author = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: authorCookie } });
    expect(author.statusCode).toBe(200);

    const wf = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: wfCookie } });
    expect(wf.statusCode).toBe(403);
  });
});

describe('POST /api/models/query', () => {
  it('返回 { columns, rows, truncated }', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/models/query', headers: { cookie: authorCookie },
      payload: { name: 'sales_model' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      columns: [{ name: 'id', type: 'number' }, { name: 'amount', type: 'number' }],
      rows: [[1, 10], [2, 20], [3, 30]],
      truncated: false,
    });
  });

  it('缺 name 400 / 模型不存在 404 / 无 dashboard.view 403', async () => {
    const noName = await app.inject({ method: 'POST', url: '/api/models/query', headers: { cookie: authorCookie }, payload: {} });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error).toBe('缺少模型名');

    const missing = await app.inject({ method: 'POST', url: '/api/models/query', headers: { cookie: authorCookie }, payload: { name: 'nope' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('模型不存在');

    const wf = await app.inject({ method: 'POST', url: '/api/models/query', headers: { cookie: wfCookie }, payload: { name: 'sales_model' } });
    expect(wf.statusCode).toBe(403);
  });
});

describe('PATCH /api/models/:name', () => {
  it('wf 可重命名；author（无 job）403；重名 409；非法名 400；不存在 404', async () => {
    const noCap = await app.inject({ method: 'PATCH', url: '/api/models/sales_model', headers: { cookie: authorCookie }, payload: { newName: 'x' } });
    expect(noCap.statusCode).toBe(403);

    const ok = await app.inject({ method: 'PATCH', url: '/api/models/sales_model', headers: { cookie: wfCookie }, payload: { newName: 'sales_model_v2' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: authorCookie } });
    expect(list.json().items.map((m: { name: string }) => m.name)).toEqual(['sales_model_v2']);

    const conflict = await app.inject({ method: 'PATCH', url: '/api/models/sales_model_v2', headers: { cookie: wfCookie }, payload: { newName: 'sales_model_v2' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe('模型名已存在');

    const bad = await app.inject({ method: 'PATCH', url: '/api/models/sales_model_v2', headers: { cookie: wfCookie }, payload: { newName: '1bad' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('模型名不合法');

    const missing = await app.inject({ method: 'PATCH', url: '/api/models/nope', headers: { cookie: wfCookie }, payload: { newName: 'ok_name' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('DELETE /api/models/:name', () => {
  it('author（无 job）403；wf 可删除；不存在 404', async () => {
    const noCap = await app.inject({ method: 'DELETE', url: '/api/models/sales_model', headers: { cookie: authorCookie } });
    expect(noCap.statusCode).toBe(403);

    const missing = await app.inject({ method: 'DELETE', url: '/api/models/nope', headers: { cookie: wfCookie } });
    expect(missing.statusCode).toBe(404);

    const ok = await app.inject({ method: 'DELETE', url: '/api/models/sales_model', headers: { cookie: wfCookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const list = await app.inject({ method: 'GET', url: '/api/models', headers: { cookie: authorCookie } });
    expect(list.json().items).toHaveLength(0);
  });
});
```
- [ ] 运行 `pnpm --filter @hustserver/server test`，确认新文件**失败**（`/api/models` 404）。
- [ ] 新建 `apps/server/src/modules/models/routes.ts`：
```ts
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth, requireCap } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { dataModelsRepo } from './repo.js';
import { MODEL_NAME_RE, type ModelStore } from './service.js';

export interface ModelRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  modelStore: ModelStore;
}

export function modelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = dataModelsRepo(deps.db);

  app.get('/api/models', { preHandler: [auth, requireCap('dashboard.view')] }, async () => ({
    items: repo.list().map((r) => ({
      name: r.name,
      sourceKind: r.source_kind,
      sourceRef: JSON.parse(r.source_ref) as unknown,
      ownerId: r.owner_id,
      loadedAt: r.loaded_at,
      rowCount: r.row_count,
      columns: JSON.parse(r.columns) as unknown,
    })),
  }));

  app.post('/api/models/query', { preHandler: [auth, requireCap('dashboard.view')] }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; limit?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ error: '缺少模型名' });
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    try {
      return await deps.modelStore.query(name, limit);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: '读取模型失败', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/models/:name', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { newName?: unknown };
    const newName = typeof body.newName === 'string' ? body.newName.trim() : '';
    if (!newName) return reply.code(400).send({ error: '缺少新模型名' });
    if (!MODEL_NAME_RE.test(newName)) return reply.code(400).send({ error: '模型名不合法' });
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    if (repo.findByName(newName)) return reply.code(409).send({ error: '模型名已存在' });
    await deps.modelStore.rename(name, newName);
    return { ok: true };
  });

  app.delete('/api/models/:name', { preHandler: [auth, requireCap('job')] }, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!repo.findByName(name)) return reply.code(404).send({ error: '模型不存在' });
    await deps.modelStore.remove(name);
    return { ok: true };
  });
}
```
- [ ] 改 `apps/server/src/server.ts`：新增导入（与其它 `./modules/*/routes.js` 导入并列）
```ts
import { modelRoutes } from './modules/models/routes.js';
import { createModelStore, type ModelStore } from './modules/models/service.js';
```
- [ ] 改 `apps/server/src/server.ts`：`AppOverrides` 接口中 `jobScheduler?: Scheduler;` 之后新增
```ts
  modelStore?: ModelStore;
```
- [ ] 改 `apps/server/src/server.ts`：`const runService = ...;` 语句块（第 60-61 行）**之后**、`const scheduler =` **之前**插入
```ts
  const modelStore =
    deps.overrides?.modelStore ?? createModelStore({ db: deps.db, config: deps.config });
```
- [ ] 改 `apps/server/src/server.ts`：`dataRoutes(app, { db: deps.db, config: deps.config, users, sessions });` 之后插入
```ts
  modelRoutes(app, { db: deps.db, config: deps.config, users, sessions, modelStore });
```
- [ ] 运行 `pnpm --filter @hustserver/server test`，确认 `models-routes.test.ts` 全部通过且整体无失败。
- [ ] Commit：`feat: 新增数据模型 API 路由（列表/取数/重命名/删除）并接入服务装配`

---

## Task 5：Job 步骤类型 `load_model`

**Files**
- 修改：`apps/server/src/modules/jobs/repo.ts`
- 修改：`apps/server/src/modules/jobs/routes.ts`
- 修改：`apps/server/src/modules/jobs/service.ts`
- 修改：`apps/server/src/server.ts`
- 修改测试：`apps/server/test/job-routes.test.ts`
- 修改测试：`apps/server/test/job-service.test.ts`

**Interfaces**
- Consumes：`LoadModelConfig` / `ModelStore` / `MODEL_NAME_RE`（Task 3）、`resolveResourcePath` / `isAllowedResourceFile`（`resources/paths.ts`）。
- Produces：`JobStepType = 'workflow' | 'sql' | 'load_model'`；步骤 `config` JSON 形状即 `LoadModelConfig`；步骤成功时 `output = JSON.stringify({ modelName, rowCount })`。

**Steps**

- [ ] 改 `apps/server/src/modules/jobs/repo.ts`：把第 5 行改为
```ts
export type JobStepType = 'workflow' | 'sql' | 'load_model';
```
- [ ] 改 `apps/server/src/modules/jobs/service.ts`：新增导入
```ts
import type { LoadModelConfig, ModelStore } from '../models/service.js';
```
- [ ] 改 `apps/server/src/modules/jobs/service.ts`：`JobServiceDeps` 中 `sqlExecutor?: SqlExecutor;` 之后新增
```ts
  modelStore?: ModelStore;
```
- [ ] 改 `apps/server/src/modules/jobs/service.ts`：`const runSql = deps.sqlExecutor ?? defaultSqlExecutor;` 之后新增
```ts
  const modelStore = deps.modelStore;
```
- [ ] 改 `apps/server/src/modules/jobs/service.ts`：`executeStep` 中把「SQL 分支靠 `else` 兜底」改为显式判断，即把第 78-86 行
```ts
      const stepCfg = JSON.parse(step.config) as { connectionId?: string; sql?: string };
      if (!stepCfg.connectionId) throw new Error('步骤缺少 connectionId');
      if (!stepCfg.sql?.trim()) throw new Error('SQL 不能为空');
      const conn = connections.findById(stepCfg.connectionId);
      if (!conn) throw new Error('连接不存在');
      const connConfig = decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex')) as unknown as SqlServerConnection;
      const result = await runSql(connConfig, stepCfg.sql);
      output = JSON.stringify(result);
      return done(true, null);
```
替换为
```ts
      if (step.type === 'sql') {
        const stepCfg = JSON.parse(step.config) as { connectionId?: string; sql?: string };
        if (!stepCfg.connectionId) throw new Error('步骤缺少 connectionId');
        if (!stepCfg.sql?.trim()) throw new Error('SQL 不能为空');
        const conn = connections.findById(stepCfg.connectionId);
        if (!conn) throw new Error('连接不存在');
        const connConfig = decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex')) as unknown as SqlServerConnection;
        const result = await runSql(connConfig, stepCfg.sql);
        output = JSON.stringify(result);
        return done(true, null);
      }
      if (step.type === 'load_model') {
        if (!modelStore) throw new Error('模型存储未配置');
        const stepCfg = JSON.parse(step.config) as LoadModelConfig;
        const job = jobs.findById(jobRun.job_id); // 模型归属 = Job 的 owner
        const result = await modelStore.load(stepCfg, job?.owner_id ?? null);
        output = JSON.stringify({ modelName: stepCfg.modelName, rowCount: result.rowCount });
        return done(true, null);
      }
      throw new Error(`未知步骤类型：${step.type}`);
```
- [ ] 改 `apps/server/src/modules/jobs/routes.ts`：新增导入
```ts
import fs from 'node:fs';
import { MODEL_NAME_RE, type LoadModelConfig } from '../models/service.js';
import { isAllowedResourceFile, resolveResourcePath } from '../resources/paths.js';
```
（`fs` 与既有 `path`/`node:` 导入并列放在文件顶部）
- [ ] 改 `apps/server/src/modules/jobs/routes.ts`：`StepBody` 接口（第 25-32 行）改为
```ts
interface StepBody {
  type?: unknown;
  name?: unknown;
  onFailure?: unknown;
  workflowId?: unknown;
  connectionId?: unknown;
  sql?: unknown;
  modelName?: unknown;
  source?: unknown;
  resourcePath?: unknown;
  format?: unknown;
  delimiter?: unknown;
  hasHeader?: unknown;
  encoding?: unknown;
  sheet?: unknown;
  object?: unknown;
  query?: unknown;
}
```
- [ ] 改 `apps/server/src/modules/jobs/routes.ts`：`parseBody` 中 `} else if (item.type === 'sql') { ... }` 的闭合大括号之后、`} else {` 之前插入 `load_model` 分支
```ts
      } else if (item.type === 'load_model') {
        const modelName = asString(item.modelName);
        if (!modelName || !MODEL_NAME_RE.test(modelName)) {
          reply.code(400).send({ error: '模型名不合法' });
          return null;
        }
        if (item.source === 'file') {
          const resourcePath = asString(item.resourcePath);
          if (!resourcePath) {
            reply.code(400).send({ error: '资源文件不可用' });
            return null;
          }
          let abs: string;
          try {
            abs = resolveResourcePath(deps.config.resourceDir, resourcePath);
          } catch {
            reply.code(400).send({ error: '资源文件不可用' });
            return null;
          }
          if (!isAllowedResourceFile(abs) || !fs.existsSync(abs)) {
            reply.code(400).send({ error: '资源文件不可用' });
            return null;
          }
          const format =
            item.format === 'csv' || item.format === 'excel' ? item.format : undefined;
          steps.push({
            type: 'load_model',
            name: stepName,
            config: JSON.stringify({
              source: 'file',
              modelName,
              resourcePath,
              ...(format ? { format } : {}),
            } satisfies LoadModelConfig),
            onFailure,
          });
        } else if (item.source === 'sqlserver') {
          const connectionId = asString(item.connectionId);
          const conn = connectionId ? connections.findById(connectionId) : null;
          if (!conn || !(isAdmin || conn.shared === 1 || conn.owner_id === userId)) {
            reply.code(400).send({ error: '连接不可用' });
            return null;
          }
          const object = asString(item.object);
          const query = asString(item.query);
          if (!object && !query) {
            reply.code(400).send({ error: '需要指定表或查询' });
            return null;
          }
          steps.push({
            type: 'load_model',
            name: stepName,
            config: JSON.stringify({
              source: 'sqlserver',
              modelName,
              connectionId,
              ...(object ? { object } : {}),
              ...(query ? { query } : {}),
            } satisfies LoadModelConfig),
            onFailure,
          });
        } else {
          reply.code(400).send({ error: '步骤来源无效' });
          return null;
        }
```
- [ ] 改 `apps/server/src/modules/jobs/routes.ts`：`load_model` 分支之后原 `} else {` 的兜底文案不变（`步骤类型无效`），确认三条分支为 `workflow` / `sql` / `load_model` / else。
- [ ] 改 `apps/server/src/server.ts`：把 `createJobService({ db: deps.db, config: deps.config, runService })`（第 88 行）改为
```ts
  const jobService =
    deps.overrides?.jobService ?? createJobService({ db: deps.db, config: deps.config, runService, modelStore });
```
- [ ] 改 `apps/server/test/job-routes.test.ts`：`import { mkdtempSync } from 'node:fs';` 改为 `import { mkdtempSync, writeFileSync } from 'node:fs';`
- [ ] 改 `apps/server/test/job-routes.test.ts`：模块级 cfg 构造（第 20-25 行）改为
```ts
const dataDir = mkdtempSync(join(tmpdir(), 'hs-job-routes-'));
const resourceDir = mkdtempSync(join(tmpdir(), 'hs-job-routes-res-'));
writeFileSync(join(resourceDir, 'sales.csv'), 'id,amount\n1,10\n2,20\n', 'utf-8');
const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
  HUSTSERVER_RESOURCE_DIR: resourceDir,
});
```
- [ ] 改 `apps/server/test/job-routes.test.ts`：在 `describe('job routes', ...)` 内新增两个用例（放在「引用不可见工作流/连接返回 400」用例之后）
```ts
  it('load_model 步骤：file 源校验与成功创建', async () => {
    const badName = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'file', modelName: '1bad', resourcePath: 'sales.csv', onFailure: 'abort' }] },
    });
    expect(badName.statusCode).toBe(400);
    expect(badName.json().error).toBe('模型名不合法');

    const missingFile = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'file', modelName: 'sales_model', resourcePath: 'nope.csv', onFailure: 'abort' }] },
    });
    expect(missingFile.statusCode).toBe(400);
    expect(missingFile.json().error).toBe('资源文件不可用');

    const ok = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: '加载模型', steps: [{ type: 'load_model', name: '加载', source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv', onFailure: 'continue' }] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().steps[0]).toMatchObject({
      type: 'load_model', name: '加载', onFailure: 'continue',
      config: { source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' },
    });
  });

  it('load_model 步骤：sqlserver 源校验与成功创建', async () => {
    const noTarget = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'sqlserver', modelName: 'm', connectionId: sharedConnId, onFailure: 'abort' }] },
    });
    expect(noTarget.statusCode).toBe(400);
    expect(noTarget.json().error).toBe('需要指定表或查询');

    const badSource = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: aliceCookie },
      payload: { name: 'x', steps: [{ type: 'load_model', name: 's', source: 'ftp', modelName: 'm', onFailure: 'abort' }] },
    });
    expect(badSource.statusCode).toBe(400);
    expect(badSource.json().error).toBe('步骤来源无效');

    const ok = await app.inject({
      method: 'POST', url: '/api/jobs', headers: { cookie: bobCookie },
      payload: { name: 'bob加载', steps: [{ type: 'load_model', name: 's', source: 'sqlserver', modelName: 'sales_model', connectionId: sharedConnId, object: 'dbo.sales', onFailure: 'abort' }] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().steps[0].config).toEqual({
      source: 'sqlserver', modelName: 'sales_model', connectionId: sharedConnId, object: 'dbo.sales',
    });
  });
```
- [ ] 改 `apps/server/test/job-service.test.ts`：新增导入 `import type { LoadModelConfig, ModelStore } from '../src/modules/models/service.js';`
- [ ] 改 `apps/server/test/job-service.test.ts`：在 `sqlStep` 之后新增 helper
```ts
function loadModelStep(): JobStepInput {
  return {
    type: 'load_model',
    name: '加载模型',
    config: JSON.stringify({ source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' }),
    onFailure: 'abort',
  };
}
```
- [ ] 改 `apps/server/test/job-service.test.ts`：在 `describe('createJobService', ...)` 内新增两个用例
```ts
  it('load_model 步骤调用 modelStore.load，output 为模型名与行数，ownerId 取 Job 的 owner', async () => {
    const load = vi.fn(async (_cfg: LoadModelConfig, _ownerId: string | null) => ({
      rowCount: 7,
      columns: [{ name: 'id', type: 'BIGINT' }],
    }));
    const modelStore = {
      load, query: vi.fn(), rename: vi.fn(), remove: vi.fn(), close: vi.fn(),
    } as unknown as ModelStore;
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success'), modelStore });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [loadModelStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();

    expect(jobRunsRepo(db).findById(jobRun.id)!.status).toBe('success');
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps.map((s) => s.status)).toEqual(['success']);
    expect(JSON.parse(steps[0].output!)).toEqual({ modelName: 'sales_model', rowCount: 7 });
    expect(load).toHaveBeenCalledWith(
      { source: 'file', modelName: 'sales_model', resourcePath: 'sales.csv' },
      ownerId,
    );
  });

  it('未注入 modelStore 时 load_model 步骤失败', async () => {
    const service = createJobService({ db, config: cfg, runService: fakeRunService('success') });
    const job = jobsRepo(db).create({ ...BASE, ownerId, name: 'J', enabled: false, steps: [loadModelStep()] });
    const jobRun = service.trigger(job.id);
    await service.whenIdle();
    const steps = jobStepRunsRepo(db).listByJobRun(jobRun.id);
    expect(steps[0].status).toBe('error');
    expect(steps[0].error).toBe('模型存储未配置');
  });
```
- [ ] 运行 `pnpm --filter @hustserver/server test`，确认 `job-routes.test.ts` / `job-service.test.ts` 新用例通过且整体无失败。
- [ ] Commit：`feat: Job 编排新增 load_model 步骤类型（校验 + 执行 + 模型存储注入）`

---

## Task 6：仪表板数据源新增「模型」来源

**Files**
- 修改：`apps/web/src/features/dashboard/types.ts`
- 修改：`apps/web/src/features/dashboard/services/dataSource.ts`
- 修改：`apps/web/src/features/dashboard/DataView.tsx`

**Interfaces**
```ts
// types.ts
export type DatasetSource = 'csv' | 'excel' | 'sql' | 'model';
export type DatasetDef =
  | { kind: 'sql'; connectionId: string; query: string }
  | { kind: 'file'; resourcePath: string; format: 'csv' | 'excel' }
  | { kind: 'model'; modelName: string };

// services/dataSource.ts
export function loadModelDataset(name: string, modelName: string): Promise<Dataset>;
```
Consumes：`POST /api/models/query`（Task 4）、既有 `buildColumns` / `coerceRows` / `dedupeHeaders`（`@bi/lib/columns`）、`uid`（`@bi/lib/utils`）。
Produces：`Dataset.source === 'model'` 与 `Dataset.def.kind === 'model'`，供 `hydrateDataset` 与 `DataView` 使用。

**Steps**

- [ ] 改 `apps/web/src/features/dashboard/types.ts`：第 81 行改为
```ts
export type DatasetSource = 'csv' | 'excel' | 'sql' | 'model';
```
- [ ] 改 `apps/web/src/features/dashboard/types.ts`：`DatasetDef` 增加第三个变体
```ts
export type DatasetDef =
  | { kind: 'sql'; connectionId: string; query: string }
  | { kind: 'file'; resourcePath: string; format: 'csv' | 'excel' }
  | { kind: 'model'; modelName: string };
```
- [ ] 改 `apps/web/src/features/dashboard/services/dataSource.ts`：在 `querySqlDataset` 之后新增
```ts
/** 从已加载的数据模型取数；模型数据已物化在平台内，仅返回列与行。 */
export async function loadModelDataset(name: string, modelName: string): Promise<Dataset> {
  const result = await api.post<QueryResult>('/api/models/query', { body: { name: modelName } });
  const headers = dedupeHeaders(result.columns.map((c) => c.name));
  const columns = buildColumns(headers, result.rows);
  const rows = coerceRows(result.rows, columns);
  return {
    id: uid('ds'),
    name,
    source: 'model',
    columns,
    rows,
    createdAt: new Date().toISOString(),
    def: { kind: 'model', modelName },
  };
}
```
- [ ] 改 `apps/web/src/features/dashboard/services/dataSource.ts`：`hydrateDataset` 改为三分支
```ts
export async function hydrateDataset(saved: SavedDataset): Promise<Dataset> {
  const ds =
    saved.def.kind === 'sql'
      ? await querySqlDataset(saved.name, saved.def.connectionId, saved.def.query)
      : saved.def.kind === 'model'
        ? await loadModelDataset(saved.name, saved.def.modelName)
        : await loadFileDataset(saved.name, saved.def.resourcePath);
  return { ...ds, id: saved.id };
}
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：导入改为
```ts
import { loadFileDataset, loadModelDataset, querySqlDataset } from '@bi/services/dataSource';
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：`SOURCE_LABEL` 增加模型项
```ts
const SOURCE_LABEL: Record<DatasetSource, string> = {
  csv: 'CSV',
  excel: 'Excel',
  sql: 'SQL',
  model: '模型',
};
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：`type AddMode = 'file' | 'table';` 改为
```ts
type AddMode = 'file' | 'table' | 'model';

interface ModelOption {
  name: string;
  rowCount: number;
  columns: unknown[];
}
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：下拉菜单第 106-109 行的「从连接的数据库表」项之后新增一项
```tsx
              <DropdownMenuItem onSelect={() => setAddMode('model')}>
                <Database className="h-4 w-4" />
                从数据模型（DuckDB）
              </DropdownMenuItem>
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：空态提示文案 `还没有数据集，从资源库文件或数据库表添加。` 改为 `还没有数据集，从资源库文件、数据库表或数据模型添加。`
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：`AddDatasetDialog` 状态（`tableKeyValue` 那几行之后）新增
```ts
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelNameValue, setModelNameValue] = useState('');
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：打开对话框的 `useEffect`（第 231-258 行）改为
```ts
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setName('');
    setError(null);
    setTableKeyValue('');
    setTables([]);
    setModelNameValue('');
    if (mode === 'file') {
      void (async () => {
        try {
          const tree = await api.get<{ files: ResourceFile[] }>('/api/resources/tree');
          setFiles(tree.files.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name)));
        } catch {
          setFiles([]);
        }
      })();
    } else if (mode === 'model') {
      void (async () => {
        try {
          const res = await api.get<{ items: ModelOption[] }>('/api/models');
          setModels(res.items);
          setModelNameValue((cur) => cur || res.items[0]?.name || '');
        } catch {
          setModels([]);
        }
      })();
    } else {
      void (async () => {
        try {
          const list = await api.get<Array<{ id: string; name: string }>>('/api/connections');
          setConnections(list);
          setConnectionId((cur) => cur || list[0]?.id || '');
        } catch {
          setConnections([]);
        }
      })();
    }
  }, [open, mode]);
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：`loadPreview()` 在 `if (mode === 'file') { ... }` 块之后、`const t = tables.find(...)` 之前插入
```ts
      if (mode === 'model') {
        if (!modelNameValue) return;
        const ds = await loadModelDataset(modelNameValue, modelNameValue);
        setPreview(ds);
        setName((cur) => cur || modelNameValue);
        return;
      }
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：`const canLoad = ...` 改为
```ts
  const canLoad =
    mode === 'file'
      ? Boolean(selectedPath)
      : mode === 'model'
        ? Boolean(modelNameValue)
        : Boolean(tableKeyValue);
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：Dialog 标题改为
```tsx
          <DialogTitle>
            {mode === 'table'
              ? '从数据库表添加数据集'
              : mode === 'model'
                ? '从数据模型添加数据集'
                : '从资源库文件添加数据集'}
          </DialogTitle>
```
- [ ] 改 `apps/web/src/features/dashboard/DataView.tsx`：表单区由 `{mode === 'table' ? ( ... ) : ( ... )}` 改为三分支——把原 `) : (` 改为 `) : mode === 'model' ? (`，插入模型分支后再接原来的文件分支：
```tsx
        ) : mode === 'model' ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>数据模型</Label>
              <Select
                value={modelNameValue}
                onValueChange={(v) => {
                  setModelNameValue(v);
                  setPreview(null);
                }}
              >
                <SelectTrigger className="w-72">
                  <SelectValue
                    placeholder={models.length === 0 ? '暂无数据模型' : '选择模型'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.name} value={m.name}>
                      {m.name}（{m.rowCount} 行 · {m.columns.length} 列）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
```
- [ ] 运行 `pnpm --filter @hustserver/web build`，确认退出码 0。
- [ ] Commit：`feat: 仪表板数据源新增 DuckDB 模型来源（loadModelDataset + 添加数据集对话框）`

---

## Task 7：「数据模型」页 + 路由 + 导航

**Files**
- 新增：`apps/web/src/pages/ModelsPage.tsx`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/components/Layout.tsx`

**Interfaces**
- Consumes：`GET /api/models`、`PATCH /api/models/:name`、`DELETE /api/models/:name`（Task 4）、`useAuth().hasCap`（`apps/web/src/auth.tsx`）、`api`（`apps/web/src/api.ts`）。
- Produces：`ModelsPage`（路由 `/models`，`RequireCap cap="dashboard.view"`）。

**Steps**

- [ ] 新建 `apps/web/src/pages/ModelsPage.tsx`：
```tsx
import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError } from '../api.js';
import { useAuth } from '../auth.js';

interface ModelColumn {
  name: string;
  type: string;
}

interface ModelItem {
  name: string;
  sourceKind: 'csv' | 'excel' | 'sqlserver';
  sourceRef: {
    resourcePath?: string;
    format?: string;
    connectionId?: string;
    object?: string;
    query?: string;
  };
  ownerId: string | null;
  loadedAt: number;
  rowCount: number;
  columns: ModelColumn[];
}

const SOURCE_LABEL: Record<ModelItem['sourceKind'], string> = {
  csv: 'CSV 文件',
  excel: 'Excel 文件',
  sqlserver: 'SQL Server',
};

function sourceText(m: ModelItem): string {
  if (m.sourceKind === 'sqlserver') return m.sourceRef.object ?? m.sourceRef.query ?? '—';
  return m.sourceRef.resourcePath ?? '—';
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

export function ModelsPage() {
  const { hasCap } = useAuth();
  const canManage = hasCap('job');
  const [items, setItems] = useState<ModelItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: ModelItem[] }>('/api/models');
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rename(m: ModelItem): Promise<void> {
    const next = window.prompt('新的模型名（字母或下划线开头，仅含字母数字下划线）', m.name);
    if (next === null) return;
    const newName = next.trim();
    if (!newName || newName === m.name) return;
    if (!window.confirm(`确认把模型「${m.name}」重命名为「${newName}」？已引用旧名的仪表板会失效。`)) return;
    try {
      await api.request('PATCH', `/api/models/${encodeURIComponent(m.name)}`, { body: { newName } });
      await load();
      window.alert(`已重命名为「${newName}」。注意：已引用旧名「${m.name}」的仪表板将失效。`);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function remove(m: ModelItem): Promise<void> {
    if (!window.confirm(`确认删除模型「${m.name}」？该操作不可恢复。`)) return;
    try {
      await api.del(`/api/models/${encodeURIComponent(m.name)}`);
      await load();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">数据模型</h1>
        <button
          className="rounded border px-3 py-1.5 text-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-sm text-slate-500">
        模型由 Job 编排中的「加载成模型」步骤产生；加载后可在仪表板中作为数据集使用。
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{loading ? '加载中…' : '暂无数据模型。'}</p>
      ) : (
        <table className="w-full border text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">模型名</th>
              <th className="p-2">来源</th>
              <th className="p-2">行数</th>
              <th className="p-2">列数</th>
              <th className="p-2">加载时间</th>
              {canManage && <th className="p-2">操作</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.name} className="border-t">
                <td className="p-2 font-mono">{m.name}</td>
                <td className="p-2">
                  {SOURCE_LABEL[m.sourceKind]}：{sourceText(m)}
                </td>
                <td className="p-2">{m.rowCount}</td>
                <td className="p-2">{m.columns.length}</td>
                <td className="p-2">{new Date(m.loadedAt).toLocaleString()}</td>
                {canManage && (
                  <td className="p-2">
                    <div className="flex gap-2">
                      <button className="rounded border px-2" onClick={() => void rename(m)}>
                        重命名
                      </button>
                      <button className="rounded border px-2 text-red-600" onClick={() => void remove(m)}>
                        删除
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```
- [ ] 改 `apps/web/src/App.tsx`：在 `import { LoginPage } from './pages/LoginPage.js';` 之后新增
```ts
import { ModelsPage } from './pages/ModelsPage.js';
```
- [ ] 改 `apps/web/src/App.tsx`：在 `/resources` 的 `<Route>`（第 144-151 行）之后新增
```tsx
            <Route
              path="/models"
              element={
                <RequireCap cap="dashboard.view">
                  <ModelsPage />
                </RequireCap>
              }
            />
```
- [ ] 改 `apps/web/src/components/Layout.tsx`：在 `{hasCap('dashboard.view') && <NavLink to="/dashboards" className={linkClass}>仪表板</NavLink>}` 之后新增
```tsx
          {hasCap('dashboard.view') && <NavLink to="/models" className={linkClass}>数据模型</NavLink>}
```
- [ ] 运行 `pnpm --filter @hustserver/web build`，确认退出码 0。
- [ ] Commit：`feat: 新增「数据模型」页与路由导航（列表/重命名/删除）`

---

## Task 8：Job 编辑器支持 `load_model` 步骤

**Files**
- 修改：`apps/web/src/types.ts`
- 修改：`apps/web/src/pages/JobEditorPage.tsx`
- 修改：`apps/web/src/pages/JobRunDetailPage.tsx`

**Interfaces**
```ts
// apps/web/src/types.ts
export type JobStepType = 'workflow' | 'sql' | 'load_model';
export type LoadModelSource = 'file' | 'sqlserver';
export type JobStepConfig =
  | { workflowId: string }
  | { connectionId: string; sql: string }
  | { source: 'file'; modelName: string; resourcePath: string; format?: 'csv' | 'excel' }
  | { source: 'sqlserver'; modelName: string; connectionId: string; object?: string; query?: string };
```
Consumes：`/api/workflows`、`/api/connections`、`/api/resources/tree`、`/api/data/tables`（既有端点）、`POST/PUT /api/jobs`（Task 5 的校验契约）。
Produces：Job 编辑器可创建/编辑/保存 `load_model` 步骤；保存时 body 形状与后端 `StepBody` 对齐。

**Steps**

- [ ] 改 `apps/web/src/types.ts`：第 79 行起改为
```ts
export type JobStepType = 'workflow' | 'sql' | 'load_model';
export type JobOnFailure = 'abort' | 'continue';
export type LoadModelSource = 'file' | 'sqlserver';

export type JobStepConfig =
  | { workflowId: string }
  | { connectionId: string; sql: string }
  | { source: 'file'; modelName: string; resourcePath: string; format?: 'csv' | 'excel' }
  | { source: 'sqlserver'; modelName: string; connectionId: string; object?: string; query?: string };
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：导入行改为
```ts
import type { JobOnFailure, JobRunSummary, JobStepType, LoadModelSource, WorkflowSummary } from '../types.js';
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：`EditorStep` 接口改为
```ts
/** 编辑器内的步骤草稿（key 仅用于 React 列表渲染）。 */
interface EditorStep {
  key: number;
  type: JobStepType;
  name: string;
  workflowId: string;
  connectionId: string;
  sql: string;
  modelName: string;
  source: LoadModelSource;
  resourcePath: string;
  object: string;
  onFailure: JobOnFailure;
}
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：`JobDetailLike.steps` 的 `config` 类型改为
```ts
    config: {
      workflowId?: string;
      connectionId?: string;
      sql?: string;
      modelName?: string;
      source?: LoadModelSource;
      resourcePath?: string;
      object?: string;
    };
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：`defaultStepName` 改为
```ts
function defaultStepName(type: JobStepType): string {
  if (type === 'workflow') return '运行工作流';
  if (type === 'sql') return '运行 SQL';
  return '加载成模型';
}

/** 自动生成的默认名称集合；名称仍为其中之一时，切换类型会同步更新。 */
const DEFAULT_STEP_NAMES: readonly string[] = [
  defaultStepName('sql'),
  defaultStepName('workflow'),
  defaultStepName('load_model'),
];
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：`newStep` 改为
```ts
function newStep(type: JobStepType): EditorStep {
  return {
    key: nextStepKey(),
    type,
    name: defaultStepName(type),
    workflowId: '',
    connectionId: '',
    sql: '',
    modelName: '',
    source: 'file',
    resourcePath: '',
    object: '',
    onFailure: 'abort',
  };
}
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：新增两个 state（`const [connections, setConnections] = ...` 之后）
```ts
  const [resourceFiles, setResourceFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [tables, setTables] = useState<Array<{ schema: string; name: string }>>([]);
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：初始化 `useEffect`（第 133-139 行）改为
```ts
  useEffect(() => {
    void api.get<WorkflowSummary[]>('/api/workflows').then(setWorkflows).catch(() => {});
    void api
      .get<ConnectionOption[]>('/api/connections')
      .then((list) => setConnections(list.filter((c) => c.type === 'sqlserver')))
      .catch(() => {});
    void api
      .get<{ files: Array<{ name: string; path: string }> }>('/api/resources/tree')
      .then((tree) => setResourceFiles(tree.files.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name))))
      .catch(() => {});
  }, []);
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：编辑态回填（第 148-156 行）改为
```ts
        setSteps(job.steps.map((s) => ({
          key: nextStepKey(),
          type: s.type,
          name: s.name,
          workflowId: s.config.workflowId ?? '',
          connectionId: s.config.connectionId ?? '',
          sql: s.config.sql ?? '',
          modelName: s.config.modelName ?? '',
          source: s.config.source ?? 'file',
          resourcePath: s.config.resourcePath ?? '',
          object: s.config.object ?? '',
          onFailure: s.onFailure,
        })));
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：在历史记录的 `useEffect`（第 164-170 行）之后新增「按草稿连接拉取数据表」的 effect
```ts
  const draftSource = modal?.step.type === 'load_model' ? modal.step.source : null;
  const draftConnId = modal?.step.type === 'load_model' ? modal.step.connectionId : '';
  useEffect(() => {
    if (draftSource !== 'sqlserver' || !draftConnId) {
      setTables([]);
      return;
    }
    let cancelled = false;
    void api
      .post<{ tables: Array<{ schema: string; name: string }> }>('/api/data/tables', {
        body: { connectionId: draftConnId },
      })
      .then((res) => {
        if (!cancelled) setTables(res.tables.map((t) => ({ schema: t.schema, name: t.name })));
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draftSource, draftConnId]);
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：`confirmDraft`（第 200-214 行）改为
```ts
  const confirmDraft = (): void => {
    if (!modal) return;
    const draft = modal.step;
    if (draft.type === 'workflow') {
      if (!draft.workflowId) return setModalError('请选择工作流');
    } else if (draft.type === 'sql') {
      if (!draft.connectionId) return setModalError('请选择连接');
      if (!draft.sql.trim()) return setModalError('请填写 SQL');
    } else {
      if (!draft.modelName.trim()) return setModalError('请填写模型名');
      if (draft.source === 'file') {
        if (!draft.resourcePath) return setModalError('请选择资源文件');
      } else {
        if (!draft.connectionId) return setModalError('请选择连接');
        if (!draft.object) return setModalError('请选择数据表');
      }
    }
    const next: EditorStep = { ...draft, name: draft.name.trim() || defaultStepName(draft.type) };
    setSteps((prev) =>
      modal.editingKey == null ? [...prev, next] : prev.map((s) => (s.key === modal.editingKey ? next : s)),
    );
    closeModal();
  };
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：`validate()`（第 238-250 行）改为
```ts
  function validate(): string | null {
    if (!name.trim()) return '请填写 Job 名称';
    if (steps.length === 0) return '至少需要一个步骤';
    for (const [i, s] of steps.entries()) {
      if (s.type === 'workflow' && !s.workflowId) return `步骤 ${i + 1}：请选择工作流`;
      if (s.type === 'sql') {
        if (!s.connectionId) return `步骤 ${i + 1}：请选择连接`;
        if (!s.sql.trim()) return `步骤 ${i + 1}：请填写 SQL`;
      }
      if (s.type === 'load_model') {
        if (!s.modelName.trim()) return `步骤 ${i + 1}：请填写模型名`;
        if (s.source === 'file') {
          if (!s.resourcePath) return `步骤 ${i + 1}：请选择资源文件`;
        } else {
          if (!s.connectionId) return `步骤 ${i + 1}：请选择连接`;
          if (!s.object) return `步骤 ${i + 1}：请选择数据表`;
        }
      }
    }
    if (schedule.enabled && schedule.freqType === 'cron' && !schedule.cronExpr.trim()) return '请填写 cron 表达式';
    return null;
  }
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：`save()` 的 body 映射（第 263-267 行）改为
```ts
        steps: steps.map((s) => {
          if (s.type === 'workflow') {
            return { type: s.type, name: s.name, workflowId: s.workflowId, onFailure: s.onFailure };
          }
          if (s.type === 'sql') {
            return { type: s.type, name: s.name, connectionId: s.connectionId, sql: s.sql, onFailure: s.onFailure };
          }
          return s.source === 'file'
            ? {
                type: s.type, name: s.name, onFailure: s.onFailure,
                source: 'file', modelName: s.modelName, resourcePath: s.resourcePath,
              }
            : {
                type: s.type, name: s.name, onFailure: s.onFailure,
                source: 'sqlserver', modelName: s.modelName, connectionId: s.connectionId, object: s.object,
              };
        }),
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：步骤列表徽标（第 341 行）改为
```tsx
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                    {s.type === 'workflow' ? '工作流' : s.type === 'sql' ? 'SQL' : '模型'}
                  </span>
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：步骤摘要行（第 350-352 行）改为
```tsx
                <p className="text-slate-600">
                  {s.type === 'workflow'
                    ? `工作流：${workflowName}`
                    : s.type === 'sql'
                      ? `连接：${connectionName} · SQL：${sqlLine}`
                      : `模型：${s.modelName || '（未命名）'} · 来源：${
                          s.source === 'file'
                            ? s.resourcePath || '（未选择）'
                            : s.object || '（未选择）'
                        }`}
                </p>
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：类型分段控件（第 465-478 行）改为三个按钮
```tsx
            <div className="flex gap-1 rounded bg-slate-100 p-1 text-sm">
              <button
                className={`flex-1 rounded px-3 py-1 ${modal.step.type === 'workflow' ? 'bg-white shadow' : ''}`}
                onClick={() => switchDraftType('workflow')}
              >
                运行工作流
              </button>
              <button
                className={`flex-1 rounded px-3 py-1 ${modal.step.type === 'sql' ? 'bg-white shadow' : ''}`}
                onClick={() => switchDraftType('sql')}
              >
                运行 SQL
              </button>
              <button
                className={`flex-1 rounded px-3 py-1 ${modal.step.type === 'load_model' ? 'bg-white shadow' : ''}`}
                onClick={() => switchDraftType('load_model')}
              >
                加载成模型
              </button>
            </div>
```
- [ ] 改 `apps/web/src/pages/JobEditorPage.tsx`：弹窗表单条件渲染（第 484-510 行）改为三分支
```tsx
            {modal.step.type === 'load_model' ? (
              <>
                <label className="block text-sm">
                  数据来源
                  <select
                    className={inputClass}
                    value={modal.step.source}
                    onChange={(e) => patchDraft({ source: e.target.value as LoadModelSource })}
                  >
                    <option value="file">资源库文件（CSV/Excel）</option>
                    <option value="sqlserver">SQL Server 表</option>
                  </select>
                </label>
                {modal.step.source === 'file' ? (
                  <label className="block text-sm">
                    资源文件
                    <select
                      className={inputClass}
                      value={modal.step.resourcePath}
                      onChange={(e) => patchDraft({ resourcePath: e.target.value })}
                    >
                      <option value="">请选择…</option>
                      {resourceFiles.map((f) => (
                        <option key={f.path} value={f.path}>{f.name}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <>
                    <label className="block text-sm">
                      连接（SQL Server）
                      <select
                        className={inputClass}
                        value={modal.step.connectionId}
                        onChange={(e) => patchDraft({ connectionId: e.target.value, object: '' })}
                      >
                        <option value="">请选择…</option>
                        {connections.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      数据表
                      <select
                        className={inputClass}
                        value={modal.step.object}
                        onChange={(e) => patchDraft({ object: e.target.value })}
                      >
                        <option value="">请选择…</option>
                        {tables.map((t) => (
                          <option key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`}>
                            {t.schema}.{t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label className="block text-sm">
                  模型名（字母或下划线开头，仅含字母数字下划线，最长 64）
                  <input
                    className={`${inputClass} font-mono`}
                    value={modal.step.modelName}
                    onChange={(e) => patchDraft({ modelName: e.target.value })}
                  />
                </label>
              </>
            ) : modal.step.type === 'workflow' ? (
              <label className="block text-sm">
                工作流
                <select className={inputClass} value={modal.step.workflowId} onChange={(e) => patchDraft({ workflowId: e.target.value })}>
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
                  <select className={inputClass} value={modal.step.connectionId} onChange={(e) => patchDraft({ connectionId: e.target.value })}>
                    <option value="">请选择…</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  SQL（将直接在该连接上执行）
                  <textarea className={`${inputClass} h-28 font-mono`} value={modal.step.sql} onChange={(e) => patchDraft({ sql: e.target.value })} />
                </label>
              </>
            )}
```
- [ ] 改 `apps/web/src/pages/JobRunDetailPage.tsx`：第 107 行改为
```tsx
              <td className="p-2">{s.type === 'workflow' ? '工作流' : s.type === 'sql' ? 'SQL' : '加载成模型'}</td>
```
- [ ] 运行 `pnpm --filter @hustserver/web build`，确认退出码 0。
- [ ] Commit：`feat: Job 编辑器与运行详情支持「加载成模型」步骤`

---

## Task 9：端到端验证

**Files**
- 只读验证，无代码改动（若发现问题则回到对应任务修复后再提交）。

**Interfaces**
- Consumes：Task 1-8 的全部产出。
- Produces：可发布的功能闭环（engine 测试、server 测试/构建、web 构建、浏览器手测）。

**Steps**

- [ ] 运行 `pnpm --filter @hustserver/engine test`，确认 2 个测试文件全部通过。
- [ ] 运行 `pnpm --filter @hustserver/engine build`，确认退出码 0。
- [ ] 运行 `pnpm --filter @hustserver/server test`，确认**无失败**，且文件数为 38 + 2（新增 `models-service.test.ts`、`models-routes.test.ts`）= **40 files**，用例数 ≥ 207 + 新增用例数。
- [ ] 运行 `pnpm --filter @hustserver/server build`，确认退出码 0。
- [ ] 运行 `pnpm --filter @hustserver/web build`，确认退出码 0（`tsc -p tsconfig.json && vite build`）。
- [ ] 启动后端与前端（若后台仍在运行则复用）：后端 `SESSION_SECRET=please-change-me ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) HUSTSERVER_PORT=8787 BOOTSTRAP_ADMIN_USER=admin BOOTSTRAP_ADMIN_PASSWORD=admin1234 ICUBE_ENABLE_DATABASE_BACKUP=0 pnpm --filter @hustserver/server dev`；前端 `pnpm --filter @hustserver/web dev`。
- [ ] 浏览器手测（`http://localhost:5173`，用 `admin/admin123456` 或 `wf1/pw12345678`）：
  1. 「Job 编排」→ 新建 Job → 添加步骤 → 类型选「加载成模型」→ 来源「资源库文件」→ 选择 `apps/web/DATA` 下的一个 CSV（如 `fact_sales.csv`）→ 模型名填 `sales_model` → 添加 → 保存。
  2. 打开该 Job → 手动运行 → 运行详情应显示该步骤「成功」，类型列为「加载成模型」。
  3. 顶部导航出现「数据模型」→ 打开后能看到 `sales_model`，行数/列数/加载时间与源文件一致。
  4. 「仪表板」→ 新建/进入编辑器 → 「数据」视图 → 添加数据集 → 「从数据模型（DuckDB）」→ 选择 `sales_model` → 载入 → 存为数据集 → 画一个图表验证数据可用。
  5. 回到 Job 手动再运行一次（源 CSV 未变）→ 「数据模型」页 `sales_model` 的行数不变且仍可画图（覆盖语义不破坏既有仪表板）。
  6. 「数据模型」页测试「重命名」：改成 `sales_model_v2` → 列表刷新；再「删除」→ 列表清空。
  7. 权限抽查：用 `da1/pw12345678`（`dashboard_author`）登录，可见「数据模型」页与列表，但**看不到**行内「重命名/删除」（无 `job`）；用 `dv1/pw12345678`（`dashboard_viewer`）登录，可见「数据模型」页但同样无操作按钮。
- [ ] 若第 6 步发现重命名后既有仪表板数据集失效，确认是由 `hydrateDataset` 抛错进入 `datasetStore.setError` 的既有错误路径（符合 spec §10 的缓解策略），无需额外改动。
- [ ] 确认无残留未提交改动混入：`git status --porcelain` 应仅剩本计划以外的既有 WIP（若有）。
- [ ] 如验证过程中有修复，逐文件 `git add` 后提交：`fix: 加载成模型端到端验证修复`
