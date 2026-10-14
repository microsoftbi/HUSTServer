# HUSTServer 实施计划（ETL 工作流托管与调度平台）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HUSTERYX 之上构建一个 macOS 单机（无 Docker）的 Web 平台，让用户把本地导出的 ETL 工作流 JSON 发布到站点，由站点周期调度执行并持久化运行日志。

**Architecture:** 单一 Node 进程（Fastify 5）同时托管 API 与前端静态资源。HUSTERYX 的 `engine/nodes/util/types/config` 以 vendored 方式进入 `packages/engine`（仅做两处受控改造：runStore 事件 sink、config 环境变量名）。平台的持久化、调度、权限、路径重映射全部由本仓库 `apps/server` 新增实现，`Recorder` 订阅引擎事件落库，`RunService` 负责并发队列与重试。

**Tech Stack:** pnpm workspace（monorepo）；后端 Fastify 5 + TypeScript(ESM) + better-sqlite3 + node-cron + cron-parser + bcryptjs + @fastify/cookie + @fastify/multipart；引擎 DuckDB(`@duckdb/node-api`) + `xlsx`；前端 React 19 + Vite + TypeScript + Tailwind v4；测试 vitest。

**Spec:** [`docs/superpowers/specs/2026-10-14-hustserver-design.md`](../specs/2026-10-14-hustserver-design.md)

## Global Constraints

- 部署目标 **macOS，绝不使用 Docker**；单进程运行；launchd 常驻。
- 技术栈必须与 HUSTERYX 对齐：Fastify 5、TypeScript ESM（相对导入带 `.js` 后缀）、DuckDB `@duckdb/node-api`、`xlsx`。
- Node 版本下限 **>= 20**（`node:crypto`、ESM、`@duckdb/node-api`）。
- 原生依赖仅允许 `better-sqlite3`、`@duckdb/node-api`，且必须在根 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 中声明。
- 所有会话 Cookie：`httpOnly` + `sameSite=lax`；HTTPS 场景加 `secure`。
- 密码哈希使用 **bcryptjs**（纯 JS，无原生构建），成本因子 10；密码**永不回显**。
- 连接密文使用 **AES-256-GCM**（`node:crypto`），密钥来自 `ENCRYPTION_KEY`（必填，32 字节，hex）。
- 任何 API 响应与日志中，SQL Server 连接密码一律脱敏为 `******`。
- 环境变量名以 `HUSTSERVER_` 前缀为准（见 Spec §13）；默认数据目录 `~/.hustserver`。
- 默认时区 `Asia/Shanghai`；默认并发上限 `MAX_CONCURRENT_RUNS=2`；默认重试 `RUN_MAX_RETRIES=1`；日志保留 `LOG_RETENTION_DAYS=90`。
- 每个任务结束时必须提交（`git commit`）；提交信息用中文、遵循 `type: 说明` 风格。

## 与 Spec 的两处实现细化（不改变语义）

1. **运行时配置重写（Spec §5 改造点 2）**：引擎入口 `createRun(workflow, ...)` 本就接受任意 `Workflow`，因此 PathMapper **无需修改引擎**，只需在调用 `createRun` 之前构造一份重写后的 `Workflow`。计划中该改造点落在 `apps/server/src/modules/workflows/mapper.ts`，`packages/engine` 只保留 sink 与 config 两处编辑。
2. **`run_node_results` 增加唯一约束**：为支持按 `(run_id, node_id)` upsert，DDL 中 `idx_run_nodes_run` 改为 `UNIQUE (run_id, node_id)`（其余不变）。

## File Structure（先锁定文件职责，再据此拆分任务）

```
HUSTServer/
├─ package.json                     # 根：workspace 脚本（build/test/dev/lint）
├─ pnpm-workspace.yaml              # packages/apps 列表 + onlyBuiltDependencies
├─ tsconfig.base.json               # 共享 TS 配置（ESM / NodeNext / strict）
├─ vitest.config.ts                 # 根测试配置（globals）
├─ .gitignore
├─ .env.example
├─ packages/
│  └─ engine/                       # vendored HUSTERYX 引擎
│     ├─ package.json               # name: @hustserver/engine
│     ├─ tsconfig.json
│     └─ src/
│        ├─ index.ts                # 桶导出：createRun/executeWorkflow/... + 类型
│        ├─ types.ts                # 复制自 HUSTERYX（唯一事实来源）
│        ├─ config.ts               # 【改造2】读取 HUSTSERVER_* 环境变量
│        ├─ engine/{duckdb,graph,registry,executor,runStore}.ts  # runStore 内【改造1】sink
│        ├─ nodes/*.ts              # 13 个节点执行器（原样）
│        └─ util/{io,sqlIdent,format,values,sse}.ts             # 原样
└─ apps/
   ├─ server/
   │  ├─ package.json               # name: @hustserver/server
   │  ├─ tsconfig.json
   │  ├─ vitest.config.ts
   │  ├─ test/                      # 集成测试（含 fixtures/sample-workflow.json）
   │  └─ src/
   │     ├─ config.ts               # loadConfig(env) -> AppConfig
   │     ├─ index.ts                # 入口：ensureDirs→migrate→bootstrap→scheduler→listen
   │     ├─ server.ts               # buildServer(deps) -> FastifyInstance（装配路由+静态）
   │     ├─ bootstrap.ts            # ensureBootstrapAdmin
   │     ├─ db/{index,migrate}.ts   # openDatabase / migrate（DDL 常量）
   │     ├─ plugins/guards.ts       # requireAuth / requireAdmin
   │     └─ modules/
   │        ├─ auth/{password,sessions,service,routes}.ts
   │        ├─ users/{repo,routes}.ts            # 管理员用户管理
   │        ├─ connections/{crypto,repo,probe,routes}.ts
   │        ├─ workflows/{parse,repo,storage,mapper,routes}.ts
   │        ├─ schedules/{cron,repo,scheduler,routes}.ts
   │        ├─ runs/{repo,recorder,queue,service,retention,routes,sse}.ts
   │        └─ settings/{repo,routes}.ts
   └─ web/
      ├─ package.json, vite.config.ts, tsconfig.json, index.html
      ├─ src/{main.tsx,App.tsx,api.ts,auth.tsx,index.css,types.ts,workflowMappings.ts,components/*,pages/*}
      └─ test/{api,workflow-mappings}.test.ts
scripts/install-macos-service.sh    # 生成并加载 launchd LaunchAgent plist
docs/...                            # 本计划与 Spec
```

---

# 里程碑 M1：骨架与账号体系

## Task 1: Monorepo 骨架与测试链路

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`vitest.config.ts`、`.gitignore`、`.env.example`
- Create: `packages/engine/package.json`、`packages/engine/tsconfig.json`
- Create: `apps/server/package.json`、`apps/server/tsconfig.json`、`apps/server/vitest.config.ts`
- Create: `apps/web/package.json`、`apps/web/tsconfig.json`、`apps/web/vite.config.ts`、`apps/web/index.html`
- Test: `apps/server/test/smoke.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: workspace 可 `pnpm install`；`pnpm test` 可运行 vitest；各包可 `pnpm -r build`。

- [ ] **Step 1: 创建根 workspace 文件**

`pnpm-workspace.yaml`
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
onlyBuiltDependencies:
  - better-sqlite3
  - '@duckdb/node-api'
```

`package.json`
```json
{
  "name": "hustserver",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "dev": "pnpm -r --parallel dev"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true,
    "declaration": false,
    "types": ["node"]
  }
}
```

`vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
  },
});
```

`.gitignore`
```
node_modules/
dist/
coverage/
.env
*.sqlite
*.sqlite-wal
*.sqlite-shm
.DS_Store
```

`.env.example`
```
HUSTSERVER_HOST=127.0.0.1
HUSTSERVER_PORT=8787
HUSTSERVER_DATA_DIR=~/.hustserver
SESSION_SECRET=replace-with-a-long-random-string
ENCRYPTION_KEY=replace-with-64-hex-chars
MAX_CONCURRENT_RUNS=2
RUN_MAX_RETRIES=1
LOG_RETENTION_DAYS=90
DUCKDB_MEMORY_LIMIT=2GB
TZ=Asia/Shanghai
BOOTSTRAP_ADMIN_USER=admin
BOOTSTRAP_ADMIN_PASSWORD=
```

- [ ] **Step 2: 创建 `packages/engine` 包壳**

`packages/engine/package.json`
```json
{
  "name": "@hustserver/engine",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@duckdb/node-api": "1.5.6-r.1",
    "nanoid": "^6.0.2",
    "xlsx": "^0.18.5"
  }
}
```

`packages/engine/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "declaration": true },
  "include": ["src/**/*.ts"]
}
```
（`src/` 内容在 Task 13 落地；本步仅建立可编译的空包，先创建 `src/index.ts` 占位：`export {};`）

- [ ] **Step 3: 创建 `apps/server` 包壳**

`apps/server/package.json`
```json
{
  "name": "@hustserver/server",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/multipart": "^10.1.3",
    "@hustserver/engine": "workspace:*",
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^13.0.3",
    "cron-parser": "^4.9.0",
    "fastify": "^5.12.5",
    "nanoid": "^6.0.2",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/better-sqlite3": "^7.6.12",
    "tsx": "^4.19.2"
  }
}
```

`apps/server/tsconfig.json`
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../../packages/engine" }]
}
```

`apps/server/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 4: 创建 `apps/web` 包壳**

`apps/web/package.json`
```json
{
  "name": "@hustserver/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite"
  },
  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^6.0.5"
  }
}
```

`apps/web/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`apps/web/vite.config.ts`
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
```

`apps/web/index.html`
```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>HUSTServer</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

- [ ] **Step 5: 写冒烟测试**

`apps/server/test/smoke.test.ts`
```ts
import { describe, expect, it } from 'vitest';

describe('workspace 骨架', () => {
  it('vitest 可运行', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: 安装依赖并运行测试**

Run: `pnpm install && pnpm test`
Expected: 安装成功；输出 `1 passed`。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "chore: 初始化 pnpm monorepo 骨架与测试链路"
```

## Task 2: 后端配置与应用数据目录

**Files:**
- Create: `apps/server/src/config.ts`
- Test: `apps/server/test/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface AppConfig { host: string; port: number; dataDir: string; dbFile: string; uploadDir: string; outputDir: string; spillDir: string; sessionSecret: string; encryptionKey: Buffer; sessionTtlMs: number; maxConcurrentRuns: number; runMaxRetries: number; logRetentionDays: number; duckdbMemoryLimit: string; tz: string; bootstrapAdminUser?: string; bootstrapAdminPassword?: string; sharedDirs: string[] }`
  - `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`
  - `ensureDirs(cfg: AppConfig): void`

- [ ] **Step 1: 写失败测试**

`apps/server/test/config.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
};

describe('loadConfig', () => {
  it('读取并推导默认值', () => {
    const cfg = loadConfig(base);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8787);
    expect(cfg.dbFile).toBe('/tmp/hustserver-test/metadata.sqlite');
    expect(cfg.uploadDir).toBe('/tmp/hustserver-test/uploads');
    expect(cfg.encryptionKey.length).toBe(32);
    expect(cfg.tz).toBe('Asia/Shanghai');
    expect(cfg.maxConcurrentRuns).toBe(2);
  });

  it('缺少 SESSION_SECRET 抛错', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: '' })).toThrow('SESSION_SECRET');
  });

  it('ENCRYPTION_KEY 非法抛错', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow('ENCRYPTION_KEY');
  });

  it('解析共享目录列表', () => {
    const cfg = loadConfig({ ...base, HUSTSERVER_SHARED_DIRS: '/data/a, /data/b ,' });
    expect(cfg.sharedDirs).toEqual(['/data/a', '/data/b']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/config.test.ts`
Expected: FAIL，`Cannot find module '../src/config.js'`。

- [ ] **Step 3: 实现 config.ts**

`apps/server/src/config.ts`
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  uploadDir: string;
  outputDir: string;
  spillDir: string;
  sessionSecret: string;
  encryptionKey: Buffer;
  sessionTtlMs: number;
  maxConcurrentRuns: number;
  runMaxRetries: number;
  logRetentionDays: number;
  duckdbMemoryLimit: string;
  tz: string;
  bootstrapAdminUser?: string;
  bootstrapAdminPassword?: string;
  sharedDirs: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.HUSTSERVER_DATA_DIR || path.join(os.homedir(), '.hustserver');
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('缺少环境变量 SESSION_SECRET');
  const keyHex = env.ENCRYPTION_KEY;
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('ENCRYPTION_KEY 必须是 64 位十六进制字符串（32 字节）');
  }
  return {
    host: env.HUSTSERVER_HOST || '127.0.0.1',
    port: Number(env.HUSTSERVER_PORT || 8787),
    dataDir,
    dbFile: path.join(dataDir, 'metadata.sqlite'),
    uploadDir: path.join(dataDir, 'uploads'),
    outputDir: path.join(dataDir, 'outputs'),
    spillDir: path.join(dataDir, 'spill'),
    sessionSecret,
    encryptionKey: Buffer.from(keyHex, 'hex'),
    sessionTtlMs: Number(env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000),
    maxConcurrentRuns: Number(env.MAX_CONCURRENT_RUNS || 2),
    runMaxRetries: Number(env.RUN_MAX_RETRIES || 1),
    logRetentionDays: Number(env.LOG_RETENTION_DAYS || 90),
    duckdbMemoryLimit: env.DUCKDB_MEMORY_LIMIT || '2GB',
    tz: env.TZ || 'Asia/Shanghai',
    ...(env.BOOTSTRAP_ADMIN_USER ? { bootstrapAdminUser: env.BOOTSTRAP_ADMIN_USER } : {}),
    ...(env.BOOTSTRAP_ADMIN_PASSWORD ? { bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD } : {}),
    sharedDirs: (env.HUSTSERVER_SHARED_DIRS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function ensureDirs(cfg: AppConfig): void {
  for (const dir of [cfg.dataDir, cfg.uploadDir, cfg.outputDir, cfg.spillDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/config.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/config.ts apps/server/test/config.test.ts
git commit -m "feat: 新增后端配置加载与应用数据目录"
```

## Task 3: SQLite 打开与迁移（DDL）

**Files:**
- Create: `apps/server/src/db/index.ts`、`apps/server/src/db/migrate.ts`
- Test: `apps/server/test/migrate.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `openDatabase(file: string): Database.Database`（`import type { Database } from 'better-sqlite3'`）
  - `migrate(db: Database): void`（幂等，创建全部表与索引）

- [ ] **Step 1: 写失败测试**

`apps/server/test/migrate.test.ts`
```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((r) => r.name);
}

describe('migrate', () => {
  it('创建全部业务表', () => {
    const db = new Database(':memory:');
    migrate(db);
    const names = tableNames(db);
    for (const t of ['users', 'sessions', 'workflows', 'workflow_files', 'connections',
      'path_mappings', 'schedules', 'runs', 'run_node_results', 'run_logs', 'settings']) {
      expect(names).toContain(t);
    }
  });

  it('重复执行幂等', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it('run_node_results 具备 (run_id,node_id) 唯一索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_node_results'").all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_run_nodes_run');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/migrate.test.ts`
Expected: FAIL，`Cannot find module '../src/db/migrate.js'`。

- [ ] **Step 3: 实现 db/index.ts 与 db/migrate.ts**

`apps/server/src/db/index.ts`
```ts
import Database from 'better-sqlite3';

export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export type { Database };
```

`apps/server/src/db/migrate.ts`
```ts
import type { Database } from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_files (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id       TEXT,
  original_ref  TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT REFERENCES users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'sqlserver',
  config_encrypted TEXT NOT NULL,
  shared           INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS path_mappings (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  direction    TEXT NOT NULL,
  original_ref TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_ref   TEXT
);

CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  freq_type   TEXT NOT NULL,
  cron_expr   TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  schedule_id   TEXT REFERENCES schedules(id) ON DELETE SET NULL,
  trigger_type  TEXT NOT NULL,
  triggered_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL,
  engine_run_id TEXT,
  started_at    INTEGER,
  finished_at   INTEGER,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_node_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  name        TEXT,
  kind        TEXT,
  status      TEXT NOT NULL,
  row_count   INTEGER,
  duration_ms INTEGER,
  error       TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  level    TEXT NOT NULL,
  node_id  TEXT,
  message  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_logs_run  ON run_logs(run_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_nodes_run ON run_node_results(run_id, node_id);
`;

export function migrate(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/migrate.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/db apps/server/test/migrate.test.ts
git commit -m "feat: 新增 SQLite 建表迁移（全部业务表与索引）"
```

## Task 4: 密码哈希模块

**Files:**
- Create: `apps/server/src/modules/auth/password.ts`
- Test: `apps/server/test/password.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `hashPassword(plain: string): Promise<string>`
  - `verifyPassword(plain: string, hash: string): Promise<boolean>`（异常时返回 `false`）

- [ ] **Step 1: 写失败测试**

`apps/server/test/password.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';

describe('password', () => {
  it('哈希后可校验通过', async () => {
    const hash = await hashPassword('secret123');
    expect(hash).not.toBe('secret123');
    expect(await verifyPassword('secret123', hash)).toBe(true);
  });

  it('错误密码校验失败', async () => {
    const hash = await hashPassword('secret123');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('过短密码拒绝', async () => {
    await expect(hashPassword('123')).rejects.toThrow('至少');
  });

  it('非法哈希不抛异常而返回 false', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/password.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 password.ts**

`apps/server/src/modules/auth/password.ts`
```ts
import bcrypt from 'bcryptjs';

const COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain || plain.length < 6) throw new Error('密码长度至少 6 位');
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/password.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/auth/password.ts apps/server/test/password.test.ts
git commit -m "feat: 新增 bcrypt 密码哈希与校验"
```

## Task 5: 用户仓储与会话仓储

**Files:**
- Create: `apps/server/src/modules/users/repo.ts`、`apps/server/src/modules/auth/sessions.ts`
- Test: `apps/server/test/repo-users-sessions.test.ts`

**Interfaces:**
- Consumes: `migrate`（Task 3）
- Produces:
  - `interface UserRow { id: string; username: string; password_hash: string; role: 'admin'|'user'; status: 'active'|'disabled'; created_at: number; updated_at: number }`
  - `interface UsersRepo { findById(id): UserRow | null; findByUsername(u): UserRow | null; list(): UserRow[]; create(input: { username: string; passwordHash: string; role: 'admin'|'user' }): UserRow; update(id, patch: { role?; status?; passwordHash? }): UserRow | null; remove(id): boolean; count(): number }`
  - `usersRepo(db: Database): UsersRepo`
  - `interface SessionsRepo { create(userId: string, ttlMs: number): SessionRow; findValid(token: string, now?: number): SessionRow | null; remove(token): void; removeByUser(userId): void; purgeExpired(now?: number): number }`
  - `sessionsRepo(db: Database): SessionsRepo`

- [ ] **Step 1: 写失败测试**

`apps/server/test/repo-users-sessions.test.ts`
```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { usersRepo, type UsersRepo } from '../src/modules/users/repo.js';
import { sessionsRepo, type SessionsRepo } from '../src/modules/auth/sessions.js';

let db: Database.Database;
let users: UsersRepo;
let sessions: SessionsRepo;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  users = usersRepo(db);
  sessions = sessionsRepo(db);
});

describe('usersRepo', () => {
  it('创建与按名查询', () => {
    const u = users.create({ username: 'alice', passwordHash: 'h', role: 'user' });
    expect(u.id).toBeTruthy();
    expect(users.findByUsername('alice')?.id).toBe(u.id);
    expect(users.count()).toBe(1);
  });

  it('用户名唯一', () => {
    users.create({ username: 'alice', passwordHash: 'h', role: 'user' });
    expect(() => users.create({ username: 'alice', passwordHash: 'h', role: 'user' })).toThrow();
  });

  it('修改角色与状态', () => {
    const u = users.create({ username: 'bob', passwordHash: 'h', role: 'user' });
    const updated = users.update(u.id, { role: 'admin', status: 'disabled' });
    expect(updated?.role).toBe('admin');
    expect(updated?.status).toBe('disabled');
  });

  it('删除用户级联清理会话', () => {
    const u = users.create({ username: 'carol', passwordHash: 'h', role: 'user' });
    sessions.create(u.id, 1000);
    expect(users.remove(u.id)).toBe(true);
    expect(sessions.findValid(sessionsRepo(db).list?.() as never)).toBeDefined();
  });
});

describe('sessionsRepo', () => {
  it('创建后可校验', () => {
    const u = users.create({ username: 'dave', passwordHash: 'h', role: 'user' });
    const s = sessions.create(u.id, 10_000);
    expect(sessions.findValid(s.token)?.user_id).toBe(u.id);
  });

  it('过期即失效并清理', () => {
    const u = users.create({ username: 'eve', passwordHash: 'h', role: 'user' });
    const s = sessions.create(u.id, 1000);
    expect(sessions.findValid(s.token, Date.now() + 5000)).toBeNull();
  });

  it('登出移除会话', () => {
    const u = users.create({ username: 'frank', passwordHash: 'h', role: 'user' });
    const s = sessions.create(u.id, 10_000);
    sessions.remove(s.token);
    expect(sessions.findValid(s.token)).toBeNull();
  });
});
```

> 注意：上面第 4 个用例中 `sessionsRepo(db).list?.()` 是笔误写法，**实际请改为**验证级联删除的直接断言：
```ts
it('删除用户级联清理会话', () => {
  const u = users.create({ username: 'carol', passwordHash: 'h', role: 'user' });
  const s = sessions.create(u.id, 10_000);
  users.remove(u.id);
  expect(sessions.findValid(s.token)).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/repo-users-sessions.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 users/repo.ts**

`apps/server/src/modules/users/repo.ts`
```ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export type Role = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  created_at: number;
  updated_at: number;
}

export interface UsersRepo {
  findById(id: string): UserRow | null;
  findByUsername(username: string): UserRow | null;
  list(): UserRow[];
  create(input: { username: string; passwordHash: string; role: Role }): UserRow;
  update(id: string, patch: { role?: Role; status?: UserStatus; passwordHash?: string }): UserRow | null;
  remove(id: string): boolean;
  count(): number;
}

export function usersRepo(db: Database): UsersRepo {
  const findByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
  const findByNameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const listStmt = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
  const insertStmt = db.prepare(
    'INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM users');
  const deleteStmt = db.prepare('DELETE FROM users WHERE id = ?');

  function get(id: string): UserRow | null {
    return (findByIdStmt.get(id) as UserRow | undefined) ?? null;
  }

  return {
    findById: get,
    findByUsername: (username) => (findByNameStmt.get(username) as UserRow | undefined) ?? null,
    list: () => listStmt.all() as UserRow[],
    create({ username, passwordHash, role }) {
      const now = Date.now();
      const id = nanoid(12);
      insertStmt.run(id, username, passwordHash, role, 'active', now, now);
      return get(id)!;
    },
    update(id, patch) {
      const current = get(id);
      if (!current) return null;
      const next = {
        role: patch.role ?? current.role,
        status: patch.status ?? current.status,
        password_hash: patch.passwordHash ?? current.password_hash,
      };
      db.prepare('UPDATE users SET role = ?, status = ?, password_hash = ?, updated_at = ? WHERE id = ?')
        .run(next.role, next.status, next.password_hash, Date.now(), id);
      return get(id);
    },
    remove: (id) => deleteStmt.run(id).changes > 0,
    count: () => Number((countStmt.get() as { c: number }).c),
  };
}
```

- [ ] **Step 4: 实现 auth/sessions.ts**

`apps/server/src/modules/auth/sessions.ts`
```ts
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface SessionsRepo {
  create(userId: string, ttlMs: number): SessionRow;
  findValid(token: string, now?: number): SessionRow | null;
  remove(token: string): void;
  removeByUser(userId: string): void;
  purgeExpired(now?: number): number;
}

export function sessionsRepo(db: Database): SessionsRepo {
  const insert = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)');
  const get = db.prepare('SELECT * FROM sessions WHERE token = ?');
  const del = db.prepare('DELETE FROM sessions WHERE token = ?');
  const delByUser = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

  return {
    create(userId, ttlMs) {
      const now = Date.now();
      const token = randomBytes(32).toString('hex');
      insert.run(token, userId, now, now + ttlMs);
      return { token, user_id: userId, created_at: now, expires_at: now + ttlMs };
    },
    findValid(token, now = Date.now()) {
      const row = get.get(token) as SessionRow | undefined;
      if (!row) return null;
      if (row.expires_at <= now) {
        del.run(token);
        return null;
      }
      return row;
    },
    remove: (token) => {
      del.run(token);
    },
    removeByUser: (userId) => {
      delByUser.run(userId);
    },
    purgeExpired: (now = Date.now()) => purge.run(now).changes,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/repo-users-sessions.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/users apps/server/src/modules/auth/sessions.ts apps/server/test/repo-users-sessions.test.ts
git commit -m "feat: 新增用户与会话仓储"
```

## Task 6: 认证路由、RBAC 守卫与初始管理员

**Files:**
- Create: `apps/server/src/plugins/guards.ts`、`apps/server/src/modules/auth/routes.ts`、`apps/server/src/bootstrap.ts`、`apps/server/src/server.ts`
- Test: `apps/server/test/auth-routes.test.ts`、`apps/server/test/bootstrap.test.ts`

**Interfaces:**
- Consumes: `usersRepo`、`sessionsRepo`、`hashPassword`/`verifyPassword`、`loadConfig`、`migrate`
- Produces:
  - `interface AuthContext { userId: string; role: Role; username: string }`（挂载于 `req.auth`）
  - `requireAuth(deps: { users: UsersRepo; sessions: SessionsRepo })` → preHandler
  - `requireAdmin(req, reply)` → preHandler
  - `authRoutes(app: FastifyInstance, deps: { users: UsersRepo; sessions: SessionsRepo; sessionTtlMs: number }): void`
  - `buildServer(deps: AppDeps): Promise<FastifyInstance>`，其中 `interface AppDeps { db: Database; config: AppConfig; logger?: boolean }`
  - `ensureBootstrapAdmin(db: Database, cfg: AppConfig, log: { info; warn }): Promise<void>`
  - Cookie 名固定为 `hs_session`

- [ ] **Step 1: 写失败测试**

`apps/server/test/auth-routes.test.ts`
```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

let app: FastifyInstance;
let db: Database.Database;

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
});

describe('auth routes', () => {
  it('正确凭据可登录并拿到 Cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('user');
    expect(res.headers['set-cookie']).toContain('hs_session=');
  });

  it('错误密码返回 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'bad' } });
    expect(res.statusCode).toBe(401);
  });

  it('禁用账号无法登录', async () => {
    const users = usersRepo(db);
    users.update(users.findByUsername('alice')!.id, { status: 'disabled' });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } });
    expect(res.statusCode).toBe(401);
  });

  it('/me 需登录，登出后失效', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'alice123' } });
    const cookie = login.headers['set-cookie']!.toString().split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json().username).toBe('alice');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('未登录访问 /me 返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });
});
```

`apps/server/test/bootstrap.test.ts`
```ts
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { ensureBootstrapAdmin } from '../src/bootstrap.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { verifyPassword } from '../src/modules/auth/password.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

describe('ensureBootstrapAdmin', () => {
  it('空库创建初始管理员', async () => {
    const db = new Database(':memory:');
    migrate(db);
    await ensureBootstrapAdmin(db, { ...cfg, bootstrapAdminUser: 'root', bootstrapAdminPassword: 'root123' }, { info() {}, warn() {} });
    const admin = usersRepo(db).findByUsername('root');
    expect(admin?.role).toBe('admin');
    expect(await verifyPassword('root123', admin!.password_hash)).toBe(true);
  });

  it('库非空时不重复创建', async () => {
    const db = new Database(':memory:');
    migrate(db);
    await ensureBootstrapAdmin(db, { ...cfg, bootstrapAdminUser: 'root', bootstrapAdminPassword: 'root123' }, { info() {}, warn() {} });
    await ensureBootstrapAdmin(db, { ...cfg, bootstrapAdminUser: 'root2', bootstrapAdminPassword: 'root123' }, { info() {}, warn() {} });
    expect(usersRepo(db).count()).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/auth-routes.test.ts test/bootstrap.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 guards.ts、auth/routes.ts、bootstrap.ts、server.ts**

`apps/server/src/plugins/guards.ts`
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionsRepo } from '../modules/auth/sessions.js';
import type { Role, UsersRepo } from '../modules/users/repo.js';

export interface AuthContext {
  userId: string;
  role: Role;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export const SESSION_COOKIE = 'hs_session';

export function requireAuth(deps: { users: UsersRepo; sessions: SessionsRepo }) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) {
      await reply.code(401).send({ error: '未登录' });
      return;
    }
    const sess = deps.sessions.findValid(token);
    if (!sess) {
      await reply.code(401).send({ error: '会话无效或已过期' });
      return;
    }
    const user = deps.users.findById(sess.user_id);
    if (!user || user.status !== 'active') {
      await reply.code(401).send({ error: '账号不可用' });
      return;
    }
    req.auth = { userId: user.id, role: user.role, username: user.username };
  };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.auth?.role !== 'admin') {
    await reply.code(403).send({ error: '需要管理员权限' });
  }
}
```

`apps/server/src/modules/auth/routes.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { verifyPassword } from './password.js';
import type { SessionsRepo } from './sessions.js';
import { requireAuth, SESSION_COOKIE } from '../../plugins/guards.js';
import type { UsersRepo } from '../users/repo.js';

export interface AuthRouteDeps {
  users: UsersRepo;
  sessions: SessionsRepo;
  sessionTtlMs: number;
}

export function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: '缺少用户名或密码' });
    const user = deps.users.findByUsername(username);
    if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    const sess = deps.sessions.create(user.id, deps.sessionTtlMs);
    reply.setCookie(SESSION_COOKIE, sess.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(deps.sessionTtlMs / 1000),
    });
    return { id: user.id, username: user.username, role: user.role };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) deps.sessions.remove(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: guard }, async (req) => ({
    id: req.auth!.userId,
    username: req.auth!.username,
    role: req.auth!.role,
  }));
}
```

`apps/server/src/bootstrap.ts`
```ts
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { hashPassword } from './modules/auth/password.js';
import { usersRepo } from './modules/users/repo.js';

export interface BootstrapLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export async function ensureBootstrapAdmin(
  db: Database,
  cfg: AppConfig,
  log: BootstrapLogger,
): Promise<void> {
  const users = usersRepo(db);
  if (users.count() > 0) return;
  const username = cfg.bootstrapAdminUser ?? 'admin';
  const generated = !cfg.bootstrapAdminPassword;
  const password = cfg.bootstrapAdminPassword ?? randomBytes(9).toString('base64url');
  users.create({ username, passwordHash: await hashPassword(password), role: 'admin' });
  if (generated) {
    log.warn(`已创建初始管理员「${username}」，随机密码：${password}（仅显示一次，请立即修改）`);
  } else {
    log.info(`已创建初始管理员「${username}」`);
  }
}
```

`apps/server/src/server.ts`
```ts
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { sessionsRepo } from './modules/auth/sessions.js';
import { usersRepo } from './modules/users/repo.js';

export interface AppDeps {
  db: Database;
  config: AppConfig;
  logger?: boolean;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cookie, { secret: deps.config.sessionSecret });

  const users = usersRepo(deps.db);
  const sessions = sessionsRepo(deps.db);

  authRoutes(app, { users, sessions, sessionTtlMs: deps.config.sessionTtlMs });

  return app;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/auth-routes.test.ts test/bootstrap.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/plugins apps/server/src/modules/auth/routes.ts apps/server/src/bootstrap.ts apps/server/src/server.ts apps/server/test/auth-routes.test.ts apps/server/test/bootstrap.test.ts
git commit -m "feat: 新增认证路由、RBAC 守卫与初始管理员引导"
```

## Task 7: 管理员用户管理路由

**Files:**
- Create: `apps/server/src/modules/users/routes.ts`
- Modify: `apps/server/src/server.ts`（注册 `userAdminRoutes`）
- Test: `apps/server/test/admin-users-routes.test.ts`

**Interfaces:**
- Consumes: `UsersRepo`、`SessionsRepo`、`hashPassword`、`requireAuth`、`requireAdmin`、`AuthContext`
- Produces:
  - `userAdminRoutes(app: FastifyInstance, deps: { users: UsersRepo; sessions: SessionsRepo }): void`
  - 端点：`GET /api/admin/users`、`POST /api/admin/users`、`PUT /api/admin/users/:id`、`POST /api/admin/users/:id/reset-password`、`DELETE /api/admin/users/:id`
  - 列表/详情返回体一律**剔除 `password_hash`**（`publicUser` 投影）

- [ ] **Step 1: 写失败测试**

`apps/server/test/admin-users-routes.test.ts`
```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let userCookie: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  userCookie = await login('alice', 'alice123');
});

describe('admin users routes', () => {
  it('管理员可列出用户且不泄露密码哈希', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[0]).not.toHaveProperty('password_hash');
  });

  it('普通用户访问被拒 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('创建用户：重名返回 409，成功返回 201', async () => {
    const dup = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie },
      payload: { username: 'alice', password: 'whatever1', role: 'user' },
    });
    expect(dup.statusCode).toBe(409);
    const ok = await app.inject({
      method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie },
      payload: { username: 'bob', password: 'bob12345', role: 'user' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().username).toBe('bob');
    expect(ok.json()).not.toHaveProperty('password_hash');
  });

  it('修改角色/状态后可生效，禁用用户的会话立即失效', async () => {
    const bobCookie = await loginFree('bob', 'bob12345');
    const bob = usersRepo(db).findByUsername('bob')!;
    const res = await app.inject({
      method: 'PUT', url: `/api/admin/users/${bob.id}`, headers: { cookie: adminCookie },
      payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('disabled');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: bobCookie } });
    expect(me.statusCode).toBe(401);
  });

  it('重置密码后旧密码失效、新密码可登录', async () => {
    const bob = usersRepo(db).findByUsername('bob')!;
    const res = await app.inject({
      method: 'POST', url: `/api/admin/users/${bob.id}/reset-password`, headers: { cookie: adminCookie },
      payload: { password: 'newpass99' },
    });
    expect(res.statusCode).toBe(200);
    const oldLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'bob12345' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'newpass99' } });
    expect(newLogin.statusCode).toBe(200);
  });

  it('管理员不能删除自己', async () => {
    const admin = usersRepo(db).findByUsername('admin')!;
    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${admin.id}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(400);
  });

  it('删除用户会级联清理会话与名下数据', async () => {
    const bob = usersRepo(db).findByUsername('bob')!;
    const res = await app.inject({ method: 'DELETE', url: `/api/admin/users/${bob.id}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(usersRepo(db).findById(bob.id)).toBeNull();
  });
});

async function loginFree(username: string, password: string): Promise<string> {
  await app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie },
    payload: { username, password, role: 'user' },
  });
  return login(username, password);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/admin-users-routes.test.ts`
Expected: FAIL，`404` 或模块不存在。

- [ ] **Step 3: 实现 users/routes.ts 并注册**

`apps/server/src/modules/users/routes.ts`
```ts
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../../plugins/guards.js';
import { hashPassword } from '../auth/password.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { Role, UserRow, UsersRepo, UserStatus } from './repo.js';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD_LEN = 8;

function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, role: u.role, status: u.status, created_at: u.created_at, updated_at: u.updated_at };
}

function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'user';
}
function isStatus(v: unknown): v is UserStatus {
  return v === 'active' || v === 'disabled';
}

export interface UserAdminDeps {
  users: UsersRepo;
  sessions: SessionsRepo;
}

export function userAdminRoutes(app: FastifyInstance, deps: UserAdminDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });

  app.get('/api/admin/users', { preHandler: [auth, requireAdmin] }, async () => deps.users.list().map(publicUser));

  app.post('/api/admin/users', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { username, password, role } = (req.body ?? {}) as { username?: string; password?: string; role?: unknown };
    if (!username || !USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: '用户名需为 3-32 位字母、数字、_ . -' });
    }
    if (!password || password.length < MIN_PASSWORD_LEN) {
      return reply.code(400).send({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }
    if (!isRole(role)) return reply.code(400).send({ error: 'role 必须为 admin 或 user' });
    if (deps.users.findByUsername(username)) return reply.code(409).send({ error: '用户名已存在' });
    const created = deps.users.create({ username, passwordHash: await hashPassword(password), role });
    return reply.code(201).send(publicUser(created));
  });

  app.put('/api/admin/users/:id', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role, status } = (req.body ?? {}) as { role?: unknown; status?: unknown };
    if (role !== undefined && !isRole(role)) return reply.code(400).send({ error: 'role 非法' });
    if (status !== undefined && !isStatus(status)) return reply.code(400).send({ error: 'status 非法' });
    if (id === req.auth!.userId && status === 'disabled') {
      return reply.code(400).send({ error: '不能禁用当前登录账号' });
    }
    const updated = deps.users.update(id, { role: role as Role | undefined, status: status as UserStatus | undefined });
    if (!updated) return reply.code(404).send({ error: '用户不存在' });
    if (status === 'disabled') deps.sessions.removeByUser(id);
    return publicUser(updated);
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || password.length < MIN_PASSWORD_LEN) {
      return reply.code(400).send({ error: `密码至少 ${MIN_PASSWORD_LEN} 位` });
    }
    const updated = deps.users.update(id, { passwordHash: await hashPassword(password) });
    if (!updated) return reply.code(404).send({ error: '用户不存在' });
    deps.sessions.removeByUser(id);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.auth!.userId) return reply.code(400).send({ error: '不能删除当前登录账号' });
    const removed = deps.users.remove(id);
    if (!removed) return reply.code(404).send({ error: '用户不存在' });
    return { ok: true };
  });
}
```

`apps/server/src/server.ts`（在 `authRoutes(...)` 之后追加；`deps` 已含 `users`/`sessions`）
```ts
import { userAdminRoutes } from './modules/users/routes.js';
// ...
  userAdminRoutes(app, { users, sessions });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/admin-users-routes.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/users/routes.ts apps/server/src/server.ts apps/server/test/admin-users-routes.test.ts
git commit -m "feat: 新增管理员用户管理路由（增删改查/重置密码/禁用）"
```

---

# 里程碑 M2：工作流发布

## Task 8: 工作流 JSON 解析与校验

**Files:**
- Create: `apps/server/src/modules/workflows/parse.ts`
- Test: `apps/server/test/workflow-parse.test.ts`
- Fixture: `apps/server/test/fixtures/sample-workflow.json`

**Interfaces:**
- Consumes: 引擎类型 `Workflow`、`WorkflowNode`、`WorkflowEdge`、`NodeKind`（Task 13 落地前，用本地 `import type` 从 `@hustserver/engine` 引入；Task 13 完成前测试可先引用相对路径 `../../packages/engine/src/types.js`，Task 13 后统一改回包名）
- Produces:
  - `interface InputRef { nodeId: string; name: string; kind: NodeKind; originalRef: string; binding: 'file' | 'connection' }`
  - `interface OutputRef { nodeId: string; name: string; kind: NodeKind; originalRef: string }`
  - `class WorkflowParseError extends Error { constructor(message: string, readonly detail?: string) }`
  - `parseWorkflowPayload(text: string): { workflow: Workflow; inputs: InputRef[]; outputs: OutputRef[] }`
  - 常量 `INPUT_NODE_KINDS`、`OUTPUT_NODE_KINDS`、`NODE_KIND_WHITELIST`

- [ ] **Step 1: 准备 fixture 与失败测试**

`apps/server/test/fixtures/sample-workflow.json`
```json
{
  "id": "wf-sample",
  "name": "示例：CSV 清洗输出",
  "nodes": [
    { "id": "n1", "kind": "inputCsv", "name": "读取订单", "position": { "x": 0, "y": 0 }, "config": { "path": "/Users/me/data/orders.csv" } },
    { "id": "n2", "kind": "filter", "name": "过滤有效", "position": { "x": 200, "y": 0 }, "config": { "expression": "amount > 0" } },
    { "id": "n3", "kind": "outputCsv", "name": "导出结果", "position": { "x": 400, "y": 0 }, "config": { "path": "/Users/me/data/out.csv" } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2" },
    { "id": "e2", "source": "n2", "target": "n3" }
  ],
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000
}
```

`apps/server/test/workflow-parse.test.ts`
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWorkflowPayload, WorkflowParseError } from '../src/modules/workflows/parse.js';

const sample = readFileSync(fileURLToPath(new URL('./fixtures/sample-workflow.json', import.meta.url)), 'utf8');

describe('parseWorkflowPayload', () => {
  it('解析合法工作流并抽取输入/输出引用', () => {
    const { workflow, inputs, outputs } = parseWorkflowPayload(sample);
    expect(workflow.nodes).toHaveLength(3);
    expect(inputs).toEqual([
      { nodeId: 'n1', name: '读取订单', kind: 'inputCsv', originalRef: '/Users/me/data/orders.csv', binding: 'file' },
    ]);
    expect(outputs).toEqual([
      { nodeId: 'n3', name: '导出结果', kind: 'outputCsv', originalRef: '/Users/me/data/out.csv' },
    ]);
  });

  it('SQL Server 输入被识别为连接绑定且不泄露明文', () => {
    const text = JSON.stringify({
      id: 'wf', name: 'sql', createdAt: 0, updatedAt: 0,
      nodes: [{ id: 's1', kind: 'inputSqlServer', name: '读库', position: { x: 0, y: 0 },
        config: { connection: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' }, query: 'select 1' } }],
      edges: [],
    });
    const { inputs } = parseWorkflowPayload(text);
    expect(inputs[0]).toMatchObject({ nodeId: 's1', kind: 'inputSqlServer', binding: 'connection' });
    expect(JSON.stringify(inputs[0])).not.toContain('secret');
  });

  it('非对象/缺字段/未知 kind/悬空连线/重复 id 均抛 WorkflowParseError', () => {
    expect(() => parseWorkflowPayload('not json')).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload('{"nodes":[]}')).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload(JSON.stringify({ id: 'w', name: 'w', nodes: [{ id: 'a', kind: 'bogus', name: 'x', position: { x: 0, y: 0 }, config: {} }], edges: [] }))).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload(JSON.stringify({ id: 'w', name: 'w', nodes: [{ id: 'a', kind: 'filter', name: 'x', position: { x: 0, y: 0 }, config: {} }], edges: [{ id: 'e', source: 'a', target: 'missing' }] }))).toThrow(WorkflowParseError);
    expect(() => parseWorkflowPayload(JSON.stringify({ id: 'w', name: 'w', nodes: [{ id: 'a', kind: 'filter', name: 'x', position: { x: 0, y: 0 }, config: {} }, { id: 'a', kind: 'filter', name: 'y', position: { x: 0, y: 0 }, config: {} }], edges: [] }))).toThrow(WorkflowParseError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-parse.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 parse.ts**

`apps/server/src/modules/workflows/parse.ts`
```ts
import type { NodeKind, Workflow, WorkflowEdge, WorkflowNode } from '@hustserver/engine';

export const NODE_KIND_WHITELIST: readonly NodeKind[] = [
  'inputCsv', 'inputExcel', 'inputSqlServer',
  'filter', 'select', 'join', 'union', 'sort', 'aggregate', 'derive', 'dedupe', 'limit',
  'outputCsv', 'outputExcel', 'outputSqlServer',
];

export const INPUT_NODE_KINDS: readonly NodeKind[] = ['inputCsv', 'inputExcel', 'inputSqlServer'];
export const OUTPUT_NODE_KINDS: readonly NodeKind[] = ['outputCsv', 'outputExcel', 'outputSqlServer'];

export interface InputRef {
  nodeId: string;
  name: string;
  kind: NodeKind;
  originalRef: string;
  binding: 'file' | 'connection';
}
export interface OutputRef {
  nodeId: string;
  name: string;
  kind: NodeKind;
  originalRef: string;
}

export class WorkflowParseError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}

function assertNodeShape(n: unknown, index: number): asserts n is WorkflowNode {
  if (!n || typeof n !== 'object') throw new WorkflowParseError(`第 ${index} 个节点不是对象`);
  const node = n as Record<string, unknown>;
  for (const key of ['id', 'kind', 'name'] as const) {
    if (typeof node[key] !== 'string' || !node[key]) throw new WorkflowParseError(`节点缺少字段 ${key}`, `index=${index}`);
  }
  if (!NODE_KIND_WHITELIST.includes(node.kind as NodeKind)) {
    throw new WorkflowParseError(`未知节点类型 ${String(node.kind)}`, `nodeId=${String(node.id)}`);
  }
  if (!node.position || typeof node.position !== 'object') throw new WorkflowParseError(`节点缺少 position`, `nodeId=${String(node.id)}`);
  if (!node.config || typeof node.config !== 'object') throw new WorkflowParseError(`节点缺少 config`, `nodeId=${String(node.id)}`);
}

function assertEdgeShape(e: unknown, index: number): asserts e is WorkflowEdge {
  if (!e || typeof e !== 'object') throw new WorkflowParseError(`第 ${index} 条连线不是对象`);
  const edge = e as Record<string, unknown>;
  for (const key of ['id', 'source', 'target'] as const) {
    if (typeof edge[key] !== 'string' || !edge[key]) throw new WorkflowParseError(`连线缺少字段 ${key}`, `index=${index}`);
  }
}

function refOf(node: WorkflowNode): string {
  const cfg = node.config as Record<string, unknown>;
  if (typeof cfg.path === 'string') return cfg.path;
  if (node.kind === 'inputSqlServer' || node.kind === 'outputSqlServer') {
    const conn = cfg.connection as Record<string, unknown> | undefined;
    return conn && typeof conn.server === 'string' ? `${conn.server}:${String(conn.port ?? '')}/${String(conn.database ?? '')}` : '';
  }
  return '';
}

export function parseWorkflowPayload(text: string): { workflow: Workflow; inputs: InputRef[]; outputs: OutputRef[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WorkflowParseError('工作流不是合法 JSON');
  }
  if (!raw || typeof raw !== 'object') throw new WorkflowParseError('工作流根节点必须是对象');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new WorkflowParseError('工作流缺少 name/nodes/edges');
  }

  const nodes = obj.nodes as unknown[];
  const edges = obj.edges as unknown[];
  const ids = new Set<string>();
  nodes.forEach((n, i) => {
    assertNodeShape(n, i);
    if (ids.has(n.id)) throw new WorkflowParseError(`节点 id 重复：${n.id}`);
    ids.add(n.id);
  });
  edges.forEach((e, i) => {
    assertEdgeShape(e, i);
    if (!ids.has(e.source) || !ids.has(e.target)) {
      throw new WorkflowParseError(`连线引用了不存在的节点`, `${e.source} -> ${e.target}`);
    }
  });

  const typedNodes = nodes as WorkflowNode[];
  const inputs: InputRef[] = typedNodes
    .filter((n) => INPUT_NODE_KINDS.includes(n.kind))
    .map((n) => ({
      nodeId: n.id, name: n.name, kind: n.kind, originalRef: refOf(n),
      binding: n.kind === 'inputSqlServer' ? 'connection' : 'file',
    }));
  const outputs: OutputRef[] = typedNodes
    .filter((n) => OUTPUT_NODE_KINDS.includes(n.kind))
    .map((n) => ({ nodeId: n.id, name: n.name, kind: n.kind, originalRef: refOf(n) }));

  const now = Date.now();
  const workflow: Workflow = {
    id: typeof obj.id === 'string' ? obj.id : `wf-${now}`,
    name: obj.name,
    nodes: typedNodes,
    edges: edges as WorkflowEdge[],
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : now,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : now,
  };
  return { workflow, inputs, outputs };
}
```
> 说明：若 `packages/engine` 尚未导出这些类型（Task 13 之前），本任务的测试 import 改为相对路径 `../../../packages/engine/src/types.js`；Task 13 完成后统一恢复为 `@hustserver/engine`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-parse.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/workflows/parse.ts apps/server/test/workflow-parse.test.ts apps/server/test/fixtures/sample-workflow.json
git commit -m "feat: 新增工作流 JSON 解析与结构校验"
```

## Task 9: 工作流仓储、上传存储与路径映射仓储

**Files:**
- Create: `apps/server/src/modules/workflows/repo.ts`
- Create: `apps/server/src/modules/workflows/storage.ts`
- Test: `apps/server/test/workflow-repo.test.ts`

**Interfaces:**
- Produces:
  - `interface WorkflowRow { id; owner_id; name; payload; created_at; updated_at }`
  - `workflowsRepo(db)`：`create({ ownerId, name, payload })`、`findById`、`listForOwner(ownerId)`、`listAll()`、`remove(id)`、`updatePayload(id, payload)`
  - `interface WorkflowFileRow { id; workflow_id; node_id: string | null; original_ref; stored_name; size; created_at }`
  - `workflowFilesRepo(db)`：`add(input)`、`listByWorkflow(workflowId)`、`findByNode(workflowId, nodeId)`、`remove(id)`
  - `interface PathMappingRow { id?; workflow_id; node_id; direction: 'input' | 'output'; original_ref; target_type: 'uploaded_file'|'server_path'|'connection'|'output_dir'; target_ref: string | null }`
  - `pathMappingsRepo(db)`：`replaceForWorkflow(workflowId, mappings)`、`listByWorkflow(workflowId)`
  - `storage.ts`：`sanitizeName(name: string): string`、`storeUpload(dir: string, originalName: string, data: Buffer): { storedName: string; size: number }`

- [ ] **Step 1: 写失败测试**

`apps/server/test/workflow-repo.test.ts`
```ts
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo, workflowFilesRepo, pathMappingsRepo } from '../src/modules/workflows/repo.js';
import { sanitizeName, storeUpload } from '../src/modules/workflows/storage.js';

let db: Database.Database;
let ownerId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  ownerId = usersRepo(db).create({ username: 'alice', passwordHash: 'x', role: 'user' }).id;
});

describe('workflowsRepo', () => {
  it('创建并按 owner 过滤，管理员可见全部', () => {
    const repo = workflowsRepo(db);
    const w1 = repo.create({ ownerId, name: 'A', payload: '{"nodes":[],"edges":[]}' });
    expect(repo.findById(w1.id)?.name).toBe('A');
    expect(repo.listForOwner(ownerId)).toHaveLength(1);
    expect(repo.listAll()).toHaveLength(1);
    repo.updatePayload(w1.id, '{"nodes":[1],"edges":[]}');
    expect(repo.findById(w1.id)?.payload).toContain('[1]');
    expect(repo.remove(w1.id)).toBe(true);
    expect(repo.findById(w1.id)).toBeNull();
  });

  it('删除工作流级联清理文件与映射', () => {
    const w = workflowsRepo(db).create({ ownerId, name: 'A', payload: '{}' });
    workflowFilesRepo(db).add({ workflowId: w.id, nodeId: 'n1', originalRef: '/a.csv', storedName: 'f.csv', size: 3 });
    pathMappingsRepo(db).replaceForWorkflow(w.id, [
      { workflow_id: w.id, node_id: 'n1', direction: 'input', original_ref: '/a.csv', target_type: 'uploaded_file', target_ref: 'f.csv' },
    ]);
    workflowsRepo(db).remove(w.id);
    expect(workflowFilesRepo(db).listByWorkflow(w.id)).toHaveLength(0);
    expect(pathMappingsRepo(db).listByWorkflow(w.id)).toHaveLength(0);
  });
});

describe('pathMappingsRepo', () => {
  it('replaceForWorkflow 为幂等覆盖', () => {
    const w = workflowsRepo(db).create({ ownerId, name: 'A', payload: '{}' });
    const repo = pathMappingsRepo(db);
    repo.replaceForWorkflow(w.id, [
      { workflow_id: w.id, node_id: 'n1', direction: 'input', original_ref: '/a.csv', target_type: 'uploaded_file', target_ref: 'x.csv' },
      { workflow_id: w.id, node_id: 'n2', direction: 'output', original_ref: '/o.csv', target_type: 'output_dir', target_ref: null },
    ]);
    repo.replaceForWorkflow(w.id, [
      { workflow_id: w.id, node_id: 'n1', direction: 'input', original_ref: '/a.csv', target_type: 'server_path', target_ref: '/data/a.csv' },
    ]);
    const rows = repo.listByWorkflow(w.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].target_type).toBe('server_path');
  });
});

describe('storage', () => {
  it('文件名去穿越并加时间戳，落盘成功', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeName('订单 数据.csv')).toMatch(/\.csv$/);
    const dir = mkdtempSync(join(tmpdir(), 'hs-up-'));
    const { storedName, size } = storeUpload(dir, 'data.csv', Buffer.from('a,b\n1,2\n'));
    expect(size).toBe(8);
    expect(readFileSync(join(dir, storedName), 'utf8')).toBe('a,b\n1,2\n');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-repo.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 repo.ts 与 storage.ts**

`apps/server/src/modules/workflows/storage.ts`
```ts
import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

export function sanitizeName(name: string): string {
  const base = basename(name).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^\.+/, '');
  return base || 'upload.bin';
}

export function storeUpload(dir: string, originalName: string, data: Buffer): { storedName: string; size: number } {
  mkdirSync(dir, { recursive: true });
  const storedName = `${Date.now()}_${sanitizeName(originalName)}`;
  writeFileSync(join(dir, storedName), data);
  return { storedName, size: data.byteLength };
}
```

`apps/server/src/modules/workflows/repo.ts`
```ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface WorkflowRow {
  id: string;
  owner_id: string;
  name: string;
  payload: string;
  created_at: number;
  updated_at: number;
}

export interface WorkflowsRepo {
  create(input: { ownerId: string; name: string; payload: string }): WorkflowRow;
  findById(id: string): WorkflowRow | null;
  listForOwner(ownerId: string): WorkflowRow[];
  listAll(): WorkflowRow[];
  remove(id: string): boolean;
  updatePayload(id: string, payload: string): WorkflowRow | null;
}

export function workflowsRepo(db: Database): WorkflowsRepo {
  const insert = db.prepare('INSERT INTO workflows (id, owner_id, name, payload, created_at, updated_at) VALUES (?,?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM workflows WHERE id = ?');
  const byOwner = db.prepare('SELECT * FROM workflows WHERE owner_id = ? ORDER BY updated_at DESC');
  const all = db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC');
  const del = db.prepare('DELETE FROM workflows WHERE id = ?');
  const update = db.prepare('UPDATE workflows SET payload = ?, updated_at = ? WHERE id = ?');
  const get = (id: string) => (byId.get(id) as WorkflowRow | undefined) ?? null;

  return {
    create({ ownerId, name, payload }) {
      const now = Date.now();
      const id = nanoid(12);
      insert.run(id, ownerId, name, payload, now, now);
      return get(id)!;
    },
    findById: get,
    listForOwner: (ownerId) => byOwner.all(ownerId) as WorkflowRow[],
    listAll: () => all.all() as WorkflowRow[],
    remove: (id) => del.run(id).changes > 0,
    updatePayload(id, payload) {
      update.run(payload, Date.now(), id);
      return get(id);
    },
  };
}

export interface WorkflowFileRow {
  id: string;
  workflow_id: string;
  node_id: string | null;
  original_ref: string;
  stored_name: string;
  size: number;
  created_at: number;
}

export interface WorkflowFilesRepo {
  add(input: { workflowId: string; nodeId: string | null; originalRef: string; storedName: string; size: number }): WorkflowFileRow;
  listByWorkflow(workflowId: string): WorkflowFileRow[];
  findByNode(workflowId: string, nodeId: string): WorkflowFileRow | null;
  remove(id: string): void;
}

export function workflowFilesRepo(db: Database): WorkflowFilesRepo {
  const insert = db.prepare('INSERT INTO workflow_files (id, workflow_id, node_id, original_ref, stored_name, size, created_at) VALUES (?,?,?,?,?,?,?)');
  const byWf = db.prepare('SELECT * FROM workflow_files WHERE workflow_id = ? ORDER BY created_at ASC');
  const byNode = db.prepare('SELECT * FROM workflow_files WHERE workflow_id = ? AND node_id = ? LIMIT 1');
  const del = db.prepare('DELETE FROM workflow_files WHERE id = ?');
  return {
    add({ workflowId, nodeId, originalRef, storedName, size }) {
      const row: WorkflowFileRow = {
        id: nanoid(12), workflow_id: workflowId, node_id: nodeId,
        original_ref: originalRef, stored_name: storedName, size, created_at: Date.now(),
      };
      insert.run(row.id, row.workflow_id, row.node_id, row.original_ref, row.stored_name, row.size, row.created_at);
      return row;
    },
    listByWorkflow: (workflowId) => byWf.all(workflowId) as WorkflowFileRow[],
    findByNode: (workflowId, nodeId) => (byNode.get(workflowId, nodeId) as WorkflowFileRow | undefined) ?? null,
    remove: (id) => {
      del.run(id);
    },
  };
}

export type MappingDirection = 'input' | 'output';
export type MappingTargetType = 'uploaded_file' | 'server_path' | 'connection' | 'output_dir';

export interface PathMappingRow {
  id: string;
  workflow_id: string;
  node_id: string;
  direction: MappingDirection;
  original_ref: string;
  target_type: MappingTargetType;
  target_ref: string | null;
}
export type PathMappingInput = Omit<PathMappingRow, 'id'>;

export interface PathMappingsRepo {
  replaceForWorkflow(workflowId: string, mappings: PathMappingInput[]): void;
  listByWorkflow(workflowId: string): PathMappingRow[];
}

export function pathMappingsRepo(db: Database): PathMappingsRepo {
  const del = db.prepare('DELETE FROM path_mappings WHERE workflow_id = ?');
  const insert = db.prepare('INSERT INTO path_mappings (id, workflow_id, node_id, direction, original_ref, target_type, target_ref) VALUES (?,?,?,?,?,?,?)');
  const byWf = db.prepare('SELECT * FROM path_mappings WHERE workflow_id = ? ORDER BY direction ASC, node_id ASC');
  return {
    replaceForWorkflow(workflowId, mappings) {
      const tx = db.transaction(() => {
        del.run(workflowId);
        for (const m of mappings) {
          insert.run(nanoid(12), workflowId, m.node_id, m.direction, m.original_ref, m.target_type, m.target_ref);
        }
      });
      tx();
    },
    listByWorkflow: (workflowId) => byWf.all(workflowId) as PathMappingRow[],
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-repo.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/workflows/repo.ts apps/server/src/modules/workflows/storage.ts apps/server/test/workflow-repo.test.ts
git commit -m "feat: 新增工作流/文件/路径映射仓储与上传存储"
```

## Task 10: 路径与连接重映射（PathMapper）

**Files:**
- Create: `apps/server/src/modules/workflows/mapper.ts`
- Test: `apps/server/test/workflow-mapper.test.ts`

**Interfaces:**
- Consumes: `Workflow`（引擎类型）、`PathMappingRow`、`WorkflowFileRow`、`AppConfig`
- Produces:
  - `interface ResolvedConnection { id: string; config: Record<string, unknown> }`
  - `interface MapperDeps { uploadDir: string; outputDir: string; resolveServerPath(rel: string): string; connections: Map<string, ResolvedConnection> }`
  - `buildRuntimeWorkflow(input: { workflow: Workflow; mappings: PathMappingRow[]; files: WorkflowFileRow[]; deps: MapperDeps; workflowId: string; runId: string }): Workflow`
  - 规则：`input`+`uploaded_file` → 绝对路径 `uploadDir/<workflowId>/<storedName>`；`server_path` → `resolveServerPath(target_ref)`；`connection` → 用 `deps.connections.get(target_ref)` 覆盖节点 `config.connection`；`output`+`output_dir` → `outputDir/<workflowId>/<runId>/<basename(original_ref)>`

- [ ] **Step 1: 写失败测试**

`apps/server/test/workflow-mapper.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import type { Workflow } from '@hustserver/engine';
import { buildRuntimeWorkflow } from '../src/modules/workflows/mapper.js';
import type { PathMappingRow } from '../src/modules/workflows/repo.js';

const workflow: Workflow = {
  id: 'wf1', name: 'demo', createdAt: 0, updatedAt: 0,
  nodes: [
    { id: 'in1', kind: 'inputCsv', name: 'A', position: { x: 0, y: 0 }, config: { path: '/Users/me/a.csv' } },
    { id: 'in2', kind: 'inputSqlServer', name: 'B', position: { x: 0, y: 0 }, config: { connection: { server: 'old', port: 1433, database: 'd', user: 'sa', password: 'plain' }, query: 'select 1' } },
    { id: 'out1', kind: 'outputCsv', name: 'C', position: { x: 0, y: 0 }, config: { path: '/Users/me/out.csv' } },
  ],
  edges: [],
};

const mappings: PathMappingRow[] = [
  { id: 'm1', workflow_id: 'wf1', node_id: 'in1', direction: 'input', original_ref: '/Users/me/a.csv', target_type: 'uploaded_file', target_ref: '171_ a.csv' },
  { id: 'm2', workflow_id: 'wf1', node_id: 'in2', direction: 'input', original_ref: 'old:1433/d', target_type: 'connection', target_ref: 'conn1' },
  { id: 'm3', workflow_id: 'wf1', node_id: 'out1', direction: 'output', original_ref: '/Users/me/out.csv', target_type: 'output_dir', target_ref: null },
];

describe('buildRuntimeWorkflow', () => {
  it('重写输入路径、替换连接、重定向输出，且不改原对象', () => {
    const runtime = buildRuntimeWorkflow({
      workflow, mappings, files: [], workflowId: 'wf1', runId: 'run9',
      deps: {
        uploadDir: '/data/uploads', outputDir: '/data/outputs',
        resolveServerPath: (rel) => `/srv/${rel}`,
        connections: new Map([['conn1', { id: 'conn1', config: { server: 'db.internal', port: 1433, database: 'prod', user: 'app', password: 'enc' } }]]),
      },
    });
    const byId = Object.fromEntries(runtime.nodes.map((n) => [n.id, n]));
    expect((byId.in1.config as { path: string }).path).toBe('/data/uploads/wf1/171_ a.csv');
    expect((byId.in2.config as { connection: { server: string } }).connection.server).toBe('db.internal');
    expect((byId.out1.config as { path: string }).path).toBe('/data/outputs/wf1/run9/out.csv');
    // 原工作流未受影响
    expect((workflow.nodes[0].config as { path: string }).path).toBe('/Users/me/a.csv');
  });

  it('未提供映射的节点保持原样', () => {
    const runtime = buildRuntimeWorkflow({
      workflow, mappings: [], files: [], workflowId: 'wf1', runId: 'run9',
      deps: { uploadDir: '/u', outputDir: '/o', resolveServerPath: (r) => r, connections: new Map() },
    });
    expect((runtime.nodes[0].config as { path: string }).path).toBe('/Users/me/a.csv');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-mapper.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 mapper.ts**

`apps/server/src/modules/workflows/mapper.ts`
```ts
import { basename, join } from 'node:path';
import type { Workflow, WorkflowNode } from '@hustserver/engine';
import type { PathMappingRow, WorkflowFileRow } from './repo.js';

export interface ResolvedConnection {
  id: string;
  config: Record<string, unknown>;
}

export interface MapperDeps {
  uploadDir: string;
  outputDir: string;
  resolveServerPath(rel: string): string;
  connections: Map<string, ResolvedConnection>;
}

export interface BuildInput {
  workflow: Workflow;
  mappings: PathMappingRow[];
  files: WorkflowFileRow[];
  deps: MapperDeps;
  workflowId: string;
  runId: string;
}

export function buildRuntimeWorkflow(input: BuildInput): Workflow {
  const byNode = new Map<string, PathMappingRow>();
  for (const m of input.mappings) byNode.set(`${m.direction}:${m.node_id}`, m);

  const nodes: WorkflowNode[] = input.workflow.nodes.map((node) => {
    const config = { ...(node.config as Record<string, unknown>) };

    const inMap = byNode.get(`input:${node.id}`);
    if (inMap) {
      if (inMap.target_type === 'uploaded_file') {
        const stored = input.files.find((f) => f.node_id === node.id)?.stored_name ?? inMap.target_ref ?? '';
        config.path = join(input.deps.uploadDir, input.workflowId, stored);
      } else if (inMap.target_type === 'server_path') {
        config.path = input.deps.resolveServerPath(inMap.target_ref ?? '');
      } else if (inMap.target_type === 'connection') {
        const conn = input.deps.connections.get(inMap.target_ref ?? '');
        if (conn) config.connection = conn.config;
      }
    }

    const outMap = byNode.get(`output:${node.id}`);
    if (outMap && outMap.target_type === 'output_dir') {
      const name = basename(outMap.original_ref || 'output.csv');
      config.path = join(input.deps.outputDir, input.workflowId, input.runId, name);
    }

    return { ...node, config };
  });

  return { ...input.workflow, nodes };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-mapper.test.ts`
Expected: PASS（2 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/workflows/mapper.ts apps/server/test/workflow-mapper.test.ts
git commit -m "feat: 新增运行时路径与连接重映射（PathMapper）"
```

## Task 11: 工作流路由（上传/创建/列表/详情/删除/文件/映射）

**Files:**
- Create: `apps/server/src/modules/workflows/routes.ts`
- Modify: `apps/server/src/server.ts`（注册 `@fastify/multipart` 与 `workflowRoutes`）
- Test: `apps/server/test/workflow-routes.test.ts`

**Interfaces:**
- Consumes: `parseWorkflowPayload`、`workflowsRepo`、`workflowFilesRepo`、`pathMappingsRepo`、`storeUpload`、`requireAuth`、`requireAdmin`、`AppConfig`
- Produces: `workflowRoutes(app: FastifyInstance, deps: { db; config; users; sessions }): void`；端点按 Spec §8 `workflows` 组；`stripEmbeddedConnections(workflow)` 内部工具（保存前剥离 `config.connection`）

- [ ] **Step 1: 写失败测试**

`apps/server/test/workflow-routes.test.ts`
```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-wf-'));
const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'a'.repeat(64), HUSTSERVER_DATA_DIR: dataDir });

let app: FastifyInstance;
let db: Database.Database;
let aliceCookie: string;
let bobCookie: string;
let adminCookie: string;

async function login(u: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

function multipart(file: { filename: string; content: string }, fields: Record<string, string> = {}) {
  const boundary = '----hstest' + Math.random().toString(16).slice(2);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/json\r\n\r\n${file.content}\r\n--${boundary}--\r\n`);
  return { payload: Buffer.from(parts.join(''), 'utf8'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const sampleJson = JSON.stringify({
  id: 'w', name: '样例', createdAt: 0, updatedAt: 0,
  nodes: [
    { id: 'n1', kind: 'inputCsv', name: '读', position: { x: 0, y: 0 }, config: { path: '/me/a.csv' } },
    { id: 'n3', kind: 'outputCsv', name: '写', position: { x: 200, y: 0 }, config: { path: '/me/out.csv' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n3' }],
});

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), role: 'user' });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');
});

async function createWorkflow(cookie: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/workflows', headers: { cookie },
    payload: { workflow: JSON.parse(sampleJson), mappings: [
      { node_id: 'n1', direction: 'input', original_ref: '/me/a.csv', target_type: 'uploaded_file', target_ref: null },
      { node_id: 'n3', direction: 'output', original_ref: '/me/out.csv', target_type: 'output_dir', target_ref: null },
    ] },
  });
  return res.json().id;
}

describe('workflow routes', () => {
  it('上传解析返回输入/输出引用', async () => {
    const mp = multipart({ filename: 'wf.json', content: sampleJson });
    const res = await app.inject({ method: 'POST', url: '/api/workflows/upload', headers: { ...mp.headers, cookie: aliceCookie }, payload: mp.payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().inputs).toHaveLength(1);
    expect(res.json().outputs).toHaveLength(1);
  });

  it('上传非法 JSON 返回 400', async () => {
    const mp = multipart({ filename: 'bad.json', content: '{oops' });
    const res = await app.inject({ method: 'POST', url: '/api/workflows/upload', headers: { ...mp.headers, cookie: aliceCookie }, payload: mp.payload });
    expect(res.statusCode).toBe(400);
  });

  it('创建后可列表；普通用户互不可见，管理员可见全部', async () => {
    await createWorkflow(aliceCookie);
    await createWorkflow(bobCookie);
    const a = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie: aliceCookie } });
    expect(a.json()).toHaveLength(1);
    const admin = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie: adminCookie } });
    expect(admin.json()).toHaveLength(2);
  });

  it('越权访问详情返回 403，管理员可访问', async () => {
    const id = await createWorkflow(aliceCookie);
    const forbidden = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: bobCookie } });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: adminCookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('保存的 payload 已剥离明文连接', async () => {
    const withConn = JSON.stringify({
      id: 'w', name: 'sql', createdAt: 0, updatedAt: 0,
      nodes: [{ id: 's1', kind: 'inputSqlServer', name: '库', position: { x: 0, y: 0 }, config: { connection: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' }, query: 'select 1' } }],
      edges: [],
    });
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(withConn) } });
    const id = created.json().id;
    const detail = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    expect(JSON.stringify(detail.json())).not.toContain('secret');
  });

  it('上传数据文件并绑定节点，写入映射', async () => {
    const id = await createWorkflow(aliceCookie);
    const mp = multipart({ filename: 'a.csv', content: 'a,b\n1,2\n' }, { nodeId: 'n1' });
    const up = await app.inject({ method: 'POST', url: `/api/workflows/${id}/files`, headers: { ...mp.headers, cookie: aliceCookie }, payload: mp.payload });
    expect(up.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: `/api/workflows/${id}/files`, headers: { cookie: aliceCookie } });
    expect(list.json()).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    const inputMap = (detail.json().mappings as Array<{ node_id: string; target_type: string }>).find((m) => m.node_id === 'n1');
    expect(inputMap?.target_type).toBe('uploaded_file');
  });

  it('更新映射与删除工作流', async () => {
    const id = await createWorkflow(aliceCookie);
    const put = await app.inject({ method: 'PUT', url: `/api/workflows/${id}/mappings`, headers: { cookie: aliceCookie }, payload: { mappings: [
      { node_id: 'n1', direction: 'input', original_ref: '/me/a.csv', target_type: 'server_path', target_ref: 'shared/a.csv' },
    ] } });
    expect(put.statusCode).toBe(200);
    const del = await app.inject({ method: 'DELETE', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    expect(gone.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-routes.test.ts`
Expected: FAIL（路由 404/模块不存在）。

- [ ] **Step 3: 实现 workflows/routes.ts 并注册**

`apps/server/src/modules/workflows/routes.ts`
```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from 'better-sqlite3';
import { basename } from 'node:path';
import { requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { parseWorkflowPayload, WorkflowParseError } from './parse.js';
import { pathMappingsRepo, workflowFilesRepo, workflowsRepo, type PathMappingInput, type WorkflowRow } from './repo.js';
import { storeUpload } from './storage.js';

const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;
const MAX_DATA_BYTES = 200 * 1024 * 1024;

export interface WorkflowRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

function stripEmbeddedConnections(workflow: { nodes: Array<Record<string, unknown>> }) {
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) => {
      const config = { ...(n.config as Record<string, unknown> | undefined) };
      if (config.connection !== undefined) delete config.connection;
      return { ...n, config };
    }),
  };
}

export function workflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const workflows = workflowsRepo(deps.db);
  const files = workflowFilesRepo(deps.db);
  const mappings = pathMappingsRepo(deps.db);

  const canAccess = (req: FastifyRequest, wf: WorkflowRow): boolean =>
    req.auth!.role === 'admin' || wf.owner_id === req.auth!.userId;

  async function loadChecked(req: FastifyRequest, reply: FastifyReply): Promise<WorkflowRow | null> {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) {
      await reply.code(404).send({ error: '工作流不存在' });
      return null;
    }
    if (!canAccess(req, wf)) {
      await reply.code(403).send({ error: '无权访问该工作流' });
      return null;
    }
    return wf;
  }

  app.post('/api/workflows/upload', { preHandler: auth }, async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: '缺少上传文件' });
    const buf = await part.toBuffer();
    if (buf.byteLength > MAX_WORKFLOW_BYTES) return reply.code(413).send({ error: '工作流文件过大' });
    try {
      const parsed = parseWorkflowPayload(buf.toString('utf8'));
      return {
        name: parsed.workflow.name,
        workflow: stripEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> }),
        inputs: parsed.inputs,
        outputs: parsed.outputs,
      };
    } catch (err) {
      if (err instanceof WorkflowParseError) return reply.code(400).send({ error: err.message, detail: err.detail });
      throw err;
    }
  });

  app.post('/api/workflows', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; workflow?: unknown; mappings?: Array<PathMappingInput> };
    let parsed;
    try {
      parsed = parseWorkflowPayload(JSON.stringify(body.workflow ?? {}));
    } catch (err) {
      if (err instanceof WorkflowParseError) return reply.code(400).send({ error: err.message, detail: err.detail });
      throw err;
    }
    const stripped = stripEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> });
    const payload = JSON.stringify({ nodes: stripped.nodes, edges: parsed.workflow.edges });
    const wf = workflows.create({
      ownerId: req.auth!.userId,
      name: body.name?.trim() || parsed.workflow.name,
      payload,
    });
    if (Array.isArray(body.mappings) && body.mappings.length) {
      mappings.replaceForWorkflow(wf.id, body.mappings.map((m) => ({ ...m, workflow_id: wf.id })));
    }
    return reply.code(201).send({ id: wf.id, name: wf.name });
  });

  app.get('/api/workflows', { preHandler: auth }, async (req) => {
    const rows = req.auth!.role === 'admin' ? workflows.listAll() : workflows.listForOwner(req.auth!.userId);
    return rows.map((w) => ({ id: w.id, name: w.name, owner_id: w.owner_id, updated_at: w.updated_at }));
  });

  app.get('/api/workflows/:id', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    return {
      id: wf.id, name: wf.name, owner_id: wf.owner_id,
      workflow: JSON.parse(wf.payload),
      files: files.listByWorkflow(wf.id),
      mappings: mappings.listByWorkflow(wf.id),
      updated_at: wf.updated_at,
    };
  });

  app.delete('/api/workflows/:id', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    workflows.remove(wf.id);
    return { ok: true };
  });

  app.put('/api/workflows/:id/mappings', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const { mappings: items } = (req.body ?? {}) as { mappings?: Array<PathMappingInput> };
    if (!Array.isArray(items)) return reply.code(400).send({ error: 'mappings 必须为数组' });
    mappings.replaceForWorkflow(wf.id, items.map((m) => ({ ...m, workflow_id: wf.id })));
    return { ok: true, mappings: mappings.listByWorkflow(wf.id) };
  });

  app.post('/api/workflows/:id/files', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: '缺少数据文件' });
    const nodeId = String((part.fields.nodeId as { value?: string } | undefined)?.value ?? '');
    if (!nodeId) return reply.code(400).send({ error: '缺少 nodeId 字段' });
    const buf = await part.toBuffer();
    if (buf.byteLength > MAX_DATA_BYTES) return reply.code(413).send({ error: '数据文件过大' });

    const uploaded = storeUpload(deps.config.uploadDir, part.filename || 'data.csv', buf);
    const dir = `${wf.id}`;
    const { mkdirSync, renameSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(deps.config.uploadDir, dir), { recursive: true });
    renameSync(join(deps.config.uploadDir, uploaded.storedName), join(deps.config.uploadDir, dir, uploaded.storedName));

    const existing = files.findByNode(wf.id, nodeId);
    if (existing) files.remove(existing.id);
    const row = files.add({
      workflowId: wf.id, nodeId,
      originalRef: existing?.original_ref ?? part.filename ?? 'data.csv',
      storedName: uploaded.storedName, size: uploaded.size,
    });

    const current = mappings.listByWorkflow(wf.id).filter((m) => !(m.direction === 'input' && m.node_id === nodeId));
    current.push({
      id: '', workflow_id: wf.id, node_id: nodeId, direction: 'input',
      original_ref: row.original_ref, target_type: 'uploaded_file', target_ref: uploaded.storedName,
    });
    mappings.replaceForWorkflow(wf.id, current.map(({ id: _id, ...rest }) => rest));

    return reply.code(201).send({ id: row.id, stored_name: row.stored_name, size: row.size, original_ref: row.original_ref });
  });

  app.get('/api/workflows/:id/files', { preHandler: auth }, async (req, reply) => {
    const wf = await loadChecked(req, reply);
    if (!wf) return;
    return files.listByWorkflow(wf.id);
  });
}
```
> 说明：`basename` import 若未使用请删除；`storeUpload` 先落临时目录再移动，确保每个工作流独立子目录。

`apps/server/src/server.ts`（在 `cookie` 注册后增加 multipart，并注册工作流路由）
```ts
import multipart from '@fastify/multipart';
import { workflowRoutes } from './modules/workflows/routes.js';
// ...
  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
// ...
  workflowRoutes(app, { db: deps.db, config: deps.config, users, sessions });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/workflow-routes.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/workflows/routes.ts apps/server/src/server.ts apps/server/test/workflow-routes.test.ts
git commit -m "feat: 新增工作流上传/创建/列表/详情/删除与文件绑定路由"
```

## Task 12: 连接管理（加解密 / 仓储 / 路由 / 连通性测试）

**Files:**
- Create: `apps/server/src/modules/connections/crypto.ts`
- Create: `apps/server/src/modules/connections/repo.ts`
- Create: `apps/server/src/modules/connections/probe.ts`
- Create: `apps/server/src/modules/connections/routes.ts`
- Modify: `apps/server/src/server.ts`（注册 `connectionRoutes`）
- Test: `apps/server/test/connections.test.ts`

**Interfaces:**
- Produces:
  - `interface SqlServerConfig { server: string; port: number; database: string; user: string; password: string; [k: string]: unknown }`
  - `encryptConfig(config: Record<string, unknown>, keyHex: string): string`
  - `decryptConfig(payload: string, keyHex: string): Record<string, unknown>`
  - `maskConnection(config: Record<string, unknown>): Record<string, unknown>`（`password` → `******`）
  - `connectionsRepo(db)`：`create/findById/listForOwner/listAll/update/remove`
  - `testTcp(host: string, port: number, timeoutMs?): Promise<{ ok: boolean; error?: string }>`
  - `connectionRoutes(app, { db; config; users; sessions }): void`

- [ ] **Step 1: 写失败测试**

`apps/server/test/connections.test.ts`
```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { encryptConfig, decryptConfig, maskConnection } from '../src/modules/connections/crypto.js';

const KEY = 'b'.repeat(64);
const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: KEY, HUSTSERVER_DATA_DIR: '/tmp/hustserver-test' });

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let aliceCookie: string;
let bobCookie: string;

async function login(u: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), role: 'user' });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');
});

describe('crypto', () => {
  it('加解密往返一致，密文不含明文', () => {
    const plain = { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'p@ss' };
    const ct = encryptConfig(plain, KEY);
    expect(ct).not.toContain('p@ss');
    expect(decryptConfig(ct, KEY)).toEqual(plain);
  });

  it('maskConnection 脱敏密码', () => {
    expect(maskConnection({ server: 'db', password: 'p@ss' })).toEqual({ server: 'db', password: '******' });
  });

  it('密钥非法时抛错', () => {
    expect(() => encryptConfig({ a: 1 }, 'short')).toThrow();
  });
});

describe('connection routes', () => {
  it('创建后列表返回脱敏配置，不泄露密码', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie },
      payload: { name: '本地库', config: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' } },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: aliceCookie } });
    expect(JSON.stringify(list.json())).not.toContain('secret');
    expect(list.json()[0].config.password).toBe('******');
  });

  it('普通用户彼此不可见；管理员共享连接对所有人可见', async () => {
    await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'a', config: { server: 'x', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const shared = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: adminCookie }, payload: { name: '公共', shared: true, config: { server: 'y', port: 1, database: 'd', user: 'u', password: 'p' } } });
    expect(shared.statusCode).toBe(201);
    const bobList = await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: bobCookie } });
    expect(bobList.json()).toHaveLength(1);
    expect(bobList.json()[0].name).toBe('公共');
  });

  it('越权修改他人连接返回 403', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'a', config: { server: 'x', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const id = created.json().id;
    const res = await app.inject({ method: 'PUT', url: `/api/connections/${id}`, headers: { cookie: bobCookie }, payload: { name: 'hack' } });
    expect(res.statusCode).toBe(403);
  });

  it('连通性测试对不可达地址返回 ok=false', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'bad', config: { server: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const id = created.json().id;
    const res = await app.inject({ method: 'POST', url: `/api/connections/${id}/test`, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });

  it('删除连接', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/connections', headers: { cookie: aliceCookie }, payload: { name: 'a', config: { server: 'x', port: 1, database: 'd', user: 'u', password: 'p' } } });
    const id = created.json().id;
    const del = await app.inject({ method: 'DELETE', url: `/api/connections/${id}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/connections.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 crypto.ts / repo.ts / probe.ts / routes.ts**

`apps/server/src/modules/connections/crypto.ts`
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const MASKED = '******';

export function deriveKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('ENCRYPTION_KEY 必须是 64 位十六进制字符串（32 字节）');
  }
  return Buffer.from(keyHex, 'hex');
}

export function encryptConfig(config: Record<string, unknown>, keyHex: string): string {
  const key = deriveKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

export function decryptConfig(payload: string, keyHex: string): Record<string, unknown> {
  const key = deriveKey(keyHex);
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('密文格式非法');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
}

export function maskConnection(config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...config };
  if (masked.password !== undefined) masked.password = MASKED;
  return masked;
}
```

`apps/server/src/modules/connections/probe.ts`
```ts
import { createConnection } from 'node:net';

export function testTcp(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, '连接超时'));
    socket.once('error', (err) => finish(false, (err as Error).message));
  });
}
```

`apps/server/src/modules/connections/repo.ts`
```ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface ConnectionRow {
  id: string;
  owner_id: string | null;
  name: string;
  type: string;
  config_encrypted: string;
  shared: number;
  created_at: number;
  updated_at: number;
}

export interface ConnectionsRepo {
  create(input: { ownerId: string | null; name: string; type: string; configEncrypted: string; shared: boolean }): ConnectionRow;
  findById(id: string): ConnectionRow | null;
  listForOwner(ownerId: string): ConnectionRow[];
  listAll(): ConnectionRow[];
  update(id: string, patch: { name?: string; configEncrypted?: string; shared?: boolean }): ConnectionRow | null;
  remove(id: string): boolean;
}

export function connectionsRepo(db: Database): ConnectionsRepo {
  const insert = db.prepare('INSERT INTO connections (id, owner_id, name, type, config_encrypted, shared, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM connections WHERE id = ?');
  const visible = db.prepare("SELECT * FROM connections WHERE shared = 1 OR owner_id = ? ORDER BY created_at DESC");
  const all = db.prepare('SELECT * FROM connections ORDER BY created_at DESC');
  const del = db.prepare('DELETE FROM connections WHERE id = ?');
  const get = (id: string) => (byId.get(id) as ConnectionRow | undefined) ?? null;

  return {
    create({ ownerId, name, type, configEncrypted, shared }) {
      const now = Date.now();
      const id = nanoid(12);
      insert.run(id, ownerId, name, type, configEncrypted, shared ? 1 : 0, now, now);
      return get(id)!;
    },
    findById: get,
    listForOwner: (ownerId) => visible.all(ownerId) as ConnectionRow[],
    listAll: () => all.all() as ConnectionRow[],
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      db.prepare('UPDATE connections SET name = ?, config_encrypted = ?, shared = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? cur.name, patch.configEncrypted ?? cur.config_encrypted, patch.shared ? 1 : patch.shared === false ? 0 : cur.shared, Date.now(), id);
      return get(id);
    },
    remove: (id) => del.run(id).changes > 0,
  };
}
```

`apps/server/src/modules/connections/routes.ts`
```ts
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { requireAdmin, requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { decryptConfig, encryptConfig, maskConnection } from './crypto.js';
import { testTcp } from './probe.js';
import { connectionsRepo, type ConnectionRow } from './repo.js';

export interface ConnectionRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

function toDto(row: ConnectionRow, cfg: AppConfig) {
  return {
    id: row.id, name: row.name, type: row.type, shared: row.shared === 1,
    owner_id: row.owner_id, updated_at: row.updated_at,
    config: maskConnection(decryptConfig(row.config_encrypted, cfg.encryptionKey)),
  };
}

export function connectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = connectionsRepo(deps.db);
  const canManage = (req: Parameters<typeof auth>[0], row: ConnectionRow) =>
    req.auth!.role === 'admin' || row.owner_id === req.auth!.userId;

  app.get('/api/connections', { preHandler: auth }, async (req) => {
    const rows = req.auth!.role === 'admin' ? repo.listAll() : repo.listForOwner(req.auth!.userId);
    return rows.map((r) => toDto(r, deps.config));
  });

  app.post('/api/connections', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; type?: string; config?: Record<string, unknown>; shared?: boolean };
    if (!body.name?.trim()) return reply.code(400).send({ error: '缺少连接名称' });
    if (!body.config || typeof body.config !== 'object') return reply.code(400).send({ error: '缺少连接配置' });
    const shared = body.shared === true && req.auth!.role === 'admin';
    const row = repo.create({
      ownerId: shared ? null : req.auth!.userId,
      name: body.name.trim(),
      type: body.type ?? 'sqlserver',
      configEncrypted: encryptConfig(body.config, deps.config.encryptionKey),
      shared,
    });
    return reply.code(201).send(toDto(row, deps.config));
  });

  app.put('/api/connections/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权修改该连接' });
    const body = (req.body ?? {}) as { name?: string; config?: Record<string, unknown>; shared?: boolean };
    const updated = repo.update(id, {
      name: body.name?.trim(),
      configEncrypted: body.config ? encryptConfig(body.config, deps.config.encryptionKey) : undefined,
      shared: req.auth!.role === 'admin' ? body.shared : undefined,
    });
    return toDto(updated!, deps.config);
  });

  app.delete('/api/connections/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权删除该连接' });
    repo.remove(id);
    return { ok: true };
  });

  app.post('/api/connections/:id/test', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权测试该连接' });
    const cfg = decryptConfig(row.config_encrypted, deps.config.encryptionKey);
    const server = String(cfg.server ?? '');
    const port = Number(cfg.port ?? 1433);
    if (!server) return reply.code(400).send({ error: '连接缺少 server' });
    return testTcp(server, port);
  });
}
```
> 说明：`requireAdmin` 在上方 import 但未使用时可删除；共享连接仅管理员可创建/变更。

`apps/server/src/server.ts`（追加注册）
```ts
import { connectionRoutes } from './modules/connections/routes.js';
// ...
  connectionRoutes(app, { db: deps.db, config: deps.config, users, sessions });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/connections.test.ts`
Expected: PASS（8 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/connections apps/server/src/server.ts apps/server/test/connections.test.ts
git commit -m "feat: 新增连接管理（AES-256-GCM 存取、脱敏、连通性测试）"
```

---

# 里程碑 M3：引擎集成与运行日志

## Task 13: Vendored 引擎与事件 sink

**Files:**
- Modify: `packages/engine/package.json`（补 `mssql` 依赖、`test` 脚本、`exports.types`）
- Create: `packages/engine/vitest.config.ts`
- Create（**从 HUSTERYX 复制**，原样）: `packages/engine/src/types.ts`、`packages/engine/src/engine/{duckdb,graph,registry,executor}.ts`、`packages/engine/src/nodes/*.ts`、`packages/engine/src/util/*.ts`
- Create（复制后**受控改造**）: `packages/engine/src/engine/runStore.ts`（改造 1：事件 sink）、`packages/engine/src/config.ts`（改造 2：`HUSTSERVER_*` 变量）
- Create: `packages/engine/src/index.ts`（桶导出）
- Modify: `apps/server/src/modules/workflows/{parse,mapper,repo}.ts`（相对导入切换为 `@hustserver/engine`）
- Test: `packages/engine/test/runStoreSink.test.ts`

**Interfaces:**
- Consumes: HUSTERYX 基线源码（`backend/src/{types.ts,config.ts,engine/,nodes/,util/}`）。
- Produces:
  - `@hustserver/engine` 包，导出：`createRun(workflow, targetNodeId?, options?) => Promise<RunContext>`、`executeWorkflow(runId: string) => Promise<void>`、`registerEventSink(sink: RunEventSink) => () => void`、`nodeRegistry`、`compileGraph`、`ancestorNodeIds`、`createSession/closeSession` 及全部类型。
  - `type RunEventSink = (ctx: RunContext, event: SseEvent) => void`。

> **基线固定**：复制时以 HUSTERYX `main` 分支为准，并把当时的 commit 记录进 `packages/engine/package.json` 的 `"husteryxBaseline"` 字段，便于日后 diff 同步。除下方两处 diff 外，其余文件**逐字节原样**复制，不得改动。

- [ ] **Step 1: 复制上游引擎源码**

从 HUSTERYX 仓库（本地 clone 或 `git clone https://github.com/microsoftbi/HUSTERYX`）复制以下文件到 `packages/engine/src/`，保持相对目录结构不变：

```
backend/src/types.ts            → packages/engine/src/types.ts
backend/src/config.ts           → packages/engine/src/config.ts     # 稍后改造 2
backend/src/engine/duckdb.ts    → packages/engine/src/engine/duckdb.ts
backend/src/engine/graph.ts     → packages/engine/src/engine/graph.ts
backend/src/engine/registry.ts  → packages/engine/src/engine/registry.ts
backend/src/engine/executor.ts  → packages/engine/src/engine/executor.ts
backend/src/engine/runStore.ts  → packages/engine/src/engine/runStore.ts  # 稍后改造 1
backend/src/nodes/*.ts          → packages/engine/src/nodes/
backend/src/util/*.ts           → packages/engine/src/util/
```

引擎内部各文件之间使用相对路径 + `.js` 后缀导入，目录结构不变即可直接编译，无需改动 import。

- [ ] **Step 2: 受控改造 1 —— `runStore.ts` 增加可注册事件 sink**

在 `packages/engine/src/engine/runStore.ts` 顶部（`const runs = new Map...` 之前）加入：

```ts
/** 外部事件 sink：本平台用于 Recorder 落库；不改变原有内存语义与 SSE 行为。 */
export type RunEventSink = (ctx: RunContext, event: SseEvent) => void;
const eventSinks = new Set<RunEventSink>();
/** 注册一个事件 sink，返回取消注册的函数。 */
export function registerEventSink(sink: RunEventSink): () => void {
  eventSinks.add(sink);
  return () => {
    eventSinks.delete(sink);
  };
}
```

再把 `publishEvent` 改造为在广播给 SSE 订阅者之外，同步通知所有 sink（放在 `ctx.events.push(event)` 之后、遍历 `ctx.subscribers` 之前）：

```ts
export function publishEvent(ctx: RunContext, event: SseEvent): void {
  ctx.lastAccess = Date.now();
  ctx.events.push(event);
  if (ctx.events.length > MAX_BUFFERED_EVENTS) {
    ctx.events.splice(0, ctx.events.length - MAX_BUFFERED_EVENTS);
  }
  for (const sink of eventSinks) {
    try {
      sink(ctx, event);
    } catch {
      /* sink 异常不得影响运行 */
    }
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of ctx.subscribers) {
    try {
      res.write(payload);
    } catch {
      ctx.subscribers.delete(res);
    }
  }
}
```

- [ ] **Step 3: 受控改造 2 —— `config.ts` 改读 `HUSTSERVER_*`**

用以下内容整体替换 `packages/engine/src/config.ts`：

```ts
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** 运行期数据目录：SQLite、spill、上传文件都落在这里（与 apps/server 共用同一数据目录）。 */
export const APP_DATA_DIR =
  process.env.HUSTSERVER_DATA_DIR || path.join(os.homedir(), '.hustserver');
export const SPILL_DIR = path.join(APP_DATA_DIR, 'spill');
export const UPLOAD_DIR = path.join(APP_DATA_DIR, 'uploads');
export const OUTPUT_DIR = path.join(APP_DATA_DIR, 'outputs');
export const DB_FILE = path.join(APP_DATA_DIR, 'metadata.sqlite');
export const HOST = process.env.HUSTSERVER_HOST || '127.0.0.1';
export const PORT = Number(process.env.HUSTSERVER_PORT || 8787);
/** 预览默认返回行数上限 */
export const PREVIEW_DEFAULT_LIMIT = 10000;
export const PREVIEW_MAX_LIMIT = 10000;
/** 运行上下文保留时长（毫秒），用于运行后查看阶段缓存 */
export const RUN_TTL_MS = 30 * 60 * 1000;
/** DuckDB 内存上限，超出后自动 spill 到 SPILL_DIR 的 Parquet */
export const DUCKDB_MEMORY_LIMIT = process.env.DUCKDB_MEMORY_LIMIT || '2GB';
export function ensureDirs(): void {
  for (const dir of [APP_DATA_DIR, SPILL_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
```

- [ ] **Step 4: 编写引擎桶导出 `src/index.ts`**

`packages/engine/src/index.ts`
```ts
export * from './types.js';
export {
  createRun,
  getRun,
  disposeRun,
  subscribe,
  registerEventSink,
} from './engine/runStore.js';
export type {
  RunContext,
  RunEventSink,
  CreateRunOptions,
  NodeResultState,
} from './engine/runStore.js';
export { executeWorkflow } from './engine/executor.js';
export { nodeRegistry } from './engine/registry.js';
export { compileGraph, ancestorNodeIds } from './engine/graph.js';
export type { CompiledGraph } from './engine/graph.js';
export {
  createSession,
  closeSession,
  describeTable,
  countRows,
  runSql,
} from './engine/duckdb.js';
export type { DuckSession } from './engine/duckdb.js';
export type { NodeContext, NodeResult, NodeExecutor } from './nodes/context.js';
```

- [ ] **Step 5: 更新 `packages/engine/package.json`**

```json
{
  "name": "@hustserver/engine",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "husteryxBaseline": "microsoftbi/HUSTERYX@<复制时的 main commit>",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": {
    "@duckdb/node-api": "1.5.6-r.1",
    "mssql": "^11.0.1",
    "nanoid": "^6.0.2",
    "xlsx": "^0.18.5"
  },
  "devDependencies": { "vitest": "^2.1.8" }
}
```
> `mssql` / `xlsx` / `nanoid` / `@duckdb/node-api` 的版本以被 vendored 的 HUSTERYX `backend/package.json` 为准；上方为参考值，若与基线冲突以基线为准。`<复制时的 main commit>` 替换为实际 commit 短哈希。

`packages/engine/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 6: 写 sink 失败测试**

`packages/engine/test/runStoreSink.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import {
  publishEvent,
  registerEventSink,
  type RunContext,
} from '../src/engine/runStore.js';
import type { RunLogEvent } from '../src/types.js';

function fakeCtx(): RunContext {
  return {
    runId: 'engine-run-1',
    workflow: { id: 'w1', name: 'w', nodes: [], edges: [], createdAt: 0, updatedAt: 0 },
    session: {} as RunContext['session'],
    status: 'running',
    nodeStatus: new Map(),
    nodeResults: new Map(),
    subscribers: new Set(),
    events: [],
    createdAt: 0,
    lastAccess: 0,
    ownsSession: false,
  };
}

describe('runStore 事件 sink', () => {
  it('注册的 sink 能收到 publishEvent 广播，取消后不再收到', () => {
    const ctx = fakeCtx();
    const seen: string[] = [];
    const off = registerEventSink((_ctx, event) => {
      seen.push(event.runId);
    });
    const event: RunLogEvent = { runId: 'engine-run-1', level: 'info', message: 'hi', ts: 1 };
    publishEvent(ctx, event);
    off();
    publishEvent(ctx, event);
    expect(seen).toEqual(['engine-run-1']);
  });

  it('sink 抛错不影响事件缓冲', () => {
    const ctx = fakeCtx();
    const off = registerEventSink(() => {
      throw new Error('boom');
    });
    publishEvent(ctx, { runId: 'engine-run-1', level: 'info', message: 'x', ts: 2 });
    off();
    expect(ctx.events).toHaveLength(1);
  });
});
```

- [ ] **Step 7: 运行测试确认失败，再实现**

Run: `pnpm install && pnpm --filter @hustserver/engine exec vitest run test/runStoreSink.test.ts`
Expected: 首次 FAIL（`registerEventSink` 未导出）；完成 Step 2 后 PASS（2 passed）。

- [ ] **Step 8: 切换 apps/server 的引擎导入**

把此前（Task 8/9/10 中）指向引擎类型的相对导入改为包名：

- `apps/server/src/modules/workflows/parse.ts`
- `apps/server/src/modules/workflows/repo.ts`
- `apps/server/src/modules/workflows/mapper.ts`

```ts
// 旧：import type { Workflow } from '../../../packages/engine/src/types.js';
import type { Workflow } from '@hustserver/engine';
```

Run: `pnpm install && pnpm --filter @hustserver/server exec vitest run`
Expected: PASS（M1+M2 全部用例仍通过）。

- [ ] **Step 9: 构建校验**

Run: `pnpm --filter @hustserver/engine build && pnpm --filter @hustserver/server build`
Expected: 两包 `tsc` 均无错误。

- [ ] **Step 10: 提交**

```bash
git add packages/engine apps/server/src/modules/workflows
git commit -m "feat: vendored HUSTERYX 引擎（事件 sink + HUSTSERVER 环境变量）"
```

## Task 14: 运行仓储与 Recorder（事件落库）

**Files:**
- Create: `apps/server/src/modules/runs/repo.ts`
- Create: `apps/server/src/modules/runs/recorder.ts`
- Test: `apps/server/test/recorder.test.ts`

**Interfaces:**
- Consumes: `Database`、`migrate`（Task 3）、`registerEventSink` / `SseEvent` / `Workflow`（Task 13）。
- Produces:
  - `runsRepo(db): RunsRepo`、`runNodeResultsRepo(db): RunNodeResultsRepo`、`runLogsRepo(db): RunLogsRepo`（行类型 `RunRow` / `RunNodeResultRow` / `RunLogRow`）。
  - `createRecorder(db): Recorder`，方法：`attach(runId, engineRunId, workflow)`、`detach(engineRunId)`、`subscribe(runId, onEvent, onDone?)`、`isActive(runId)`、`dispose()`。

- [ ] **Step 1: 写失败测试**

`apps/server/test/recorder.test.ts`
```ts
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { publishEvent, type RunContext, type Workflow } from '@hustserver/engine';
import {
  runLogsRepo,
  runNodeResultsRepo,
  runsRepo,
} from '../src/modules/runs/repo.js';
import { createRecorder, type Recorder } from '../src/modules/runs/recorder.js';

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(
    'INSERT INTO users (id,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('u1', 'admin', 'x', 'admin', 'active', 0, 0);
  db.prepare(
    'INSERT INTO workflows (id,owner_id,name,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('w1', 'u1', 'wf', '{"nodes":[],"edges":[]}', 0, 0);
  return db;
}

function fakeCtx(engineRunId: string): RunContext {
  return {
    runId: engineRunId,
    workflow: { id: 'w1', name: 'wf', nodes: [], edges: [], createdAt: 0, updatedAt: 0 },
    session: {} as RunContext['session'],
    status: 'running',
    nodeStatus: new Map(),
    nodeResults: new Map(),
    subscribers: new Set(),
    events: [],
    createdAt: 0,
    lastAccess: 0,
    ownsSession: false,
  };
}

const workflow: Workflow = {
  id: 'w1',
  name: 'wf',
  nodes: [{ id: 'n1', kind: 'select', name: '选择', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
  createdAt: 0,
  updatedAt: 0,
};

let recorder: Recorder | null = null;
afterEach(() => {
  recorder?.dispose();
  recorder = null;
});

describe('Recorder 事件落库', () => {
  it('日志、节点结果与运行状态均持久化', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'manual', triggeredBy: 'u1' });
    recorder = createRecorder(db);
    recorder.attach(run.id, 'er1', workflow);
    const ctx = fakeCtx('er1');

    publishEvent(ctx, { runId: 'er1', level: 'info', message: '开始执行', ts: 1000 });
    publishEvent(ctx, { runId: 'er1', type: 'node-result', nodeId: 'n1', status: 'running', rowCount: 0, durationMs: 0 });
    publishEvent(ctx, { runId: 'er1', type: 'node-result', nodeId: 'n1', status: 'success', rowCount: 5, durationMs: 12 });
    publishEvent(ctx, { runId: 'er1', type: 'run-status', status: 'success' });

    expect(runLogsRepo(db).listByRun(run.id, { after: 0, limit: 10 })).toHaveLength(1);

    const nodes = runNodeResultsRepo(db).listByRun(run.id);
    expect(nodes).toHaveLength(1); // upsert 后仅一行
    expect(nodes[0]).toMatchObject({ node_id: 'n1', name: '选择', kind: 'select', status: 'success', row_count: 5 });

    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('success');
    expect(detail.started_at).not.toBeNull();
    expect(detail.finished_at).not.toBeNull();
    expect(detail.duration_ms).toBeGreaterThanOrEqual(0);
    expect(detail.error).toBeNull();
  });

  it('失败运行写入 error 与 error 文案', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'schedule' });
    recorder = createRecorder(db);
    recorder.attach(run.id, 'er2', workflow);
    const ctx = fakeCtx('er2');

    publishEvent(ctx, { runId: 'er2', type: 'run-status', status: 'error', message: '上游节点未成功' });

    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('error');
    expect(detail.error).toBe('上游节点未成功');
  });

  it('订阅者可收到事件，detach 触发 onDone', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'manual' });
    recorder = createRecorder(db);
    recorder.attach(run.id, 'er3', workflow);
    const seen: string[] = [];
    let done = false;
    recorder.subscribe(run.id, (event) => seen.push(event.runId), () => {
      done = true;
    });

    publishEvent(fakeCtx('er3'), { runId: 'er3', level: 'info', message: 'x', ts: 1 });
    expect(seen).toEqual(['er3']);
    recorder.detach('er3');
    expect(done).toBe(true);
    expect(recorder.isActive(run.id)).toBe(false);
  });

  it('已结束的运行 subscribe 返回 null', () => {
    const db = setupDb();
    const run = runsRepo(db).create({ workflowId: 'w1', triggerType: 'manual' });
    recorder = createRecorder(db);
    expect(recorder.subscribe(run.id, () => {})).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/recorder.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/runs/repo.js'`。

- [ ] **Step 3: 实现 runs/repo.ts**

`apps/server/src/modules/runs/repo.ts`
```ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { NodeRunStatus } from '@hustserver/engine';

export type RunStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';
export type TriggerType = 'manual' | 'schedule';
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface RunRow {
  id: string;
  workflow_id: string;
  schedule_id: string | null;
  trigger_type: TriggerType;
  triggered_by: string | null;
  status: RunStatus;
  engine_run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}

export interface RunNodeResultRow {
  id: number;
  run_id: string;
  node_id: string;
  name: string | null;
  kind: string | null;
  status: NodeRunStatus;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  updated_at: number;
}

export interface RunLogRow {
  id: number;
  run_id: string;
  ts: number;
  level: LogLevel;
  node_id: string | null;
  message: string;
}

export interface RunsRepo {
  create(input: {
    workflowId: string;
    scheduleId?: string | null;
    triggerType: TriggerType;
    triggeredBy?: string | null;
    status?: RunStatus;
  }): RunRow;
  findById(id: string): RunRow | null;
  listByWorkflow(workflowId: string, opts: { limit: number; offset: number }): RunRow[];
  countByWorkflow(workflowId: string): number;
  listOlderThan(cutoff: number): RunRow[];
  setEngineRunId(id: string, engineRunId: string): void;
  markRunning(id: string, startedAt: number): void;
  finish(
    id: string,
    patch: { status: RunStatus; finishedAt: number; durationMs: number | null; error: string | null },
  ): void;
  remove(id: string): boolean;
}

export function runsRepo(db: Database): RunsRepo {
  const getStmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO runs (id,workflow_id,schedule_id,trigger_type,triggered_by,status,engine_run_id,started_at,finished_at,duration_ms,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const listStmt = db.prepare(
    'SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE workflow_id = ?');
  const olderStmt = db.prepare('SELECT * FROM runs WHERE created_at < ? ORDER BY created_at ASC');
  const setEngineStmt = db.prepare('UPDATE runs SET engine_run_id = ? WHERE id = ?');
  const markRunningStmt = db.prepare(
    "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
  );
  const finishStmt = db.prepare(
    'UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, error = ? WHERE id = ?',
  );
  const deleteStmt = db.prepare('DELETE FROM runs WHERE id = ?');
  const get = (id: string): RunRow | null => (getStmt.get(id) as RunRow | undefined) ?? null;

  return {
    create({ workflowId, scheduleId = null, triggerType, triggeredBy = null, status = 'queued' }) {
      const id = nanoid(12);
      insertStmt.run(id, workflowId, scheduleId, triggerType, triggeredBy, status, null, null, null, null, null, Date.now());
      return get(id)!;
    },
    findById: get,
    listByWorkflow: (workflowId, { limit, offset }) =>
      listStmt.all(workflowId, limit, offset) as RunRow[],
    countByWorkflow: (workflowId) => Number((countStmt.get(workflowId) as { c: number }).c),
    listOlderThan: (cutoff) => olderStmt.all(cutoff) as RunRow[],
    setEngineRunId: (id, engineRunId) => {
      setEngineStmt.run(engineRunId, id);
    },
    markRunning: (id, startedAt) => {
      markRunningStmt.run(startedAt, id);
    },
    finish: (id, patch) => {
      finishStmt.run(patch.status, patch.finishedAt, patch.durationMs, patch.error, id);
    },
    remove: (id) => deleteStmt.run(id).changes > 0,
  };
}

export interface RunNodeResultsRepo {
  upsert(input: {
    runId: string;
    nodeId: string;
    name?: string | null;
    kind?: string | null;
    status: NodeRunStatus;
    rowCount?: number | null;
    durationMs?: number | null;
    error?: string | null;
    updatedAt?: number;
  }): void;
  listByRun(runId: string): RunNodeResultRow[];
}

export function runNodeResultsRepo(db: Database): RunNodeResultsRepo {
  const upsertStmt = db.prepare(
    `INSERT INTO run_node_results (run_id,node_id,name,kind,status,row_count,duration_ms,error,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id,node_id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       status = excluded.status,
       row_count = excluded.row_count,
       duration_ms = excluded.duration_ms,
       error = excluded.error,
       updated_at = excluded.updated_at`,
  );
  const listStmt = db.prepare('SELECT * FROM run_node_results WHERE run_id = ? ORDER BY id ASC');
  return {
    upsert(input) {
      upsertStmt.run(
        input.runId,
        input.nodeId,
        input.name ?? null,
        input.kind ?? null,
        input.status,
        input.rowCount ?? null,
        input.durationMs ?? null,
        input.error ?? null,
        input.updatedAt ?? Date.now(),
      );
    },
    listByRun: (runId) => listStmt.all(runId) as RunNodeResultRow[],
  };
}

export interface RunLogsRepo {
  append(input: { runId: string; ts: number; level: LogLevel; nodeId?: string | null; message: string }): number;
  listByRun(runId: string, opts?: { after?: number; limit?: number }): RunLogRow[];
  countByRun(runId: string): number;
}

export function runLogsRepo(db: Database): RunLogsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO run_logs (run_id,ts,level,node_id,message) VALUES (?,?,?,?,?)',
  );
  const listStmt = db.prepare(
    'SELECT * FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
  );
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM run_logs WHERE run_id = ?');
  return {
    append({ runId, ts, level, nodeId = null, message }) {
      return Number(insertStmt.run(runId, ts, level, nodeId, message).lastInsertRowid);
    },
    listByRun: (runId, opts = {}) =>
      listStmt.all(runId, opts.after ?? 0, opts.limit ?? 1000) as RunLogRow[],
    countByRun: (runId) => Number((countStmt.get(runId) as { c: number }).c),
  };
}
```

- [ ] **Step 4: 实现 runs/recorder.ts**

`apps/server/src/modules/runs/recorder.ts`
```ts
import type { Database } from 'better-sqlite3';
import {
  registerEventSink,
  type SseEvent,
  type Workflow,
} from '@hustserver/engine';
import { runLogsRepo, runNodeResultsRepo, runsRepo } from './repo.js';

export type RunEventListener = (event: SseEvent) => void;

interface ActiveRun {
  runId: string;
  engineRunId: string;
  workflow: Workflow;
  startedAt: number;
  listeners: Set<RunEventListener>;
  doneListeners: Set<() => void>;
}

export interface Recorder {
  attach(runId: string, engineRunId: string, workflow: Workflow): void;
  detach(engineRunId: string): void;
  subscribe(runId: string, onEvent: RunEventListener, onDone?: () => void): (() => void) | null;
  isActive(runId: string): boolean;
  dispose(): void;
}

export function createRecorder(db: Database): Recorder {
  const runs = runsRepo(db);
  const nodeResults = runNodeResultsRepo(db);
  const logs = runLogsRepo(db);
  const byEngine = new Map<string, ActiveRun>();
  const byRun = new Map<string, ActiveRun>();

  function persist(a: ActiveRun, event: SseEvent): void {
    if ('type' in event && event.type === 'node-result') {
      const node = a.workflow.nodes.find((n) => n.id === event.nodeId);
      nodeResults.upsert({
        runId: a.runId,
        nodeId: event.nodeId,
        name: node?.name ?? null,
        kind: node?.kind ?? null,
        status: event.status,
        rowCount: event.rowCount,
        durationMs: event.durationMs,
        error: event.error ?? null,
      });
      return;
    }
    if ('type' in event && event.type === 'run-status') {
      if (event.status === 'running') {
        runs.markRunning(a.runId, a.startedAt);
        return;
      }
      const finishedAt = Date.now();
      runs.finish(a.runId, {
        status: event.status,
        finishedAt,
        durationMs: finishedAt - a.startedAt,
        error: event.status === 'error' ? event.message ?? '执行失败' : null,
      });
      return;
    }
    logs.append({
      runId: a.runId,
      ts: event.ts,
      level: event.level,
      nodeId: event.nodeId ?? null,
      message: event.message,
    });
  }

  const off = registerEventSink((ctx, event) => {
    const a = byEngine.get(ctx.runId);
    if (!a) return;
    persist(a, event);
    for (const listener of a.listeners) {
      try {
        listener(event);
      } catch {
        /* 单个订阅者异常不影响其他订阅者 */
      }
    }
  });

  return {
    attach(runId, engineRunId, workflow) {
      const a: ActiveRun = {
        runId,
        engineRunId,
        workflow,
        startedAt: Date.now(),
        listeners: new Set(),
        doneListeners: new Set(),
      };
      byEngine.set(engineRunId, a);
      byRun.set(runId, a);
      runs.markRunning(runId, a.startedAt);
    },
    detach(engineRunId) {
      const a = byEngine.get(engineRunId);
      if (!a) return;
      byEngine.delete(engineRunId);
      byRun.delete(a.runId);
      for (const done of a.doneListeners) {
        try {
          done();
        } catch {
          /* ignore */
        }
      }
      a.listeners.clear();
      a.doneListeners.clear();
    },
    subscribe(runId, onEvent, onDone) {
      const a = byRun.get(runId);
      if (!a) return null;
      a.listeners.add(onEvent);
      if (onDone) a.doneListeners.add(onDone);
      return () => {
        a.listeners.delete(onEvent);
        if (onDone) a.doneListeners.delete(onDone);
      };
    },
    isActive: (runId) => byRun.has(runId),
    dispose() {
      off();
      byEngine.clear();
      byRun.clear();
    },
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/recorder.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/modules/runs apps/server/test/recorder.test.ts
git commit -m "feat: 新增运行仓储与 Recorder（引擎事件落库）"
```

## Task 15: RunService 与并发队列

**Files:**
- Create: `apps/server/src/modules/runs/queue.ts`
- Create: `apps/server/src/modules/runs/service.ts`
- Test: `apps/server/test/run-queue.test.ts`
- Test: `apps/server/test/run-service.test.ts`

**Interfaces:**
- Consumes: `AppConfig`、`Database`、`Recorder`、`runsRepo`、`workflowsRepo`/`workflowFilesRepo`/`pathMappingsRepo`、`connectionsRepo`/`decryptConfig`、`buildRuntimeWorkflow`/`MapperDeps`、引擎 `createRun`/`executeWorkflow`/`Workflow`/`WorkflowNode`/`WorkflowEdge`
- Produces:
  - `type Release = () => void`
  - `interface Semaphore { acquire(): Promise<Release>; run<T>(fn: () => Promise<T>): Promise<T>; active(): number; waiting(): number }`
  - `createSemaphore(limit: number): Semaphore`
  - `interface RunExecutorInput { runId: string; workflow: Workflow; onEngineRunId(engineRunId: string): void }`
  - `type RunExecutor = (input: RunExecutorInput) => Promise<void>`
  - `interface RunServiceDeps { db: Database; config: AppConfig; recorder: Recorder; executor?: RunExecutor; concurrency?: number }`
  - `interface RunService { trigger(workflowId: string, opts?: { triggerType?: TriggerType; scheduleId?: string | null; triggeredBy?: string | null }): RunRow; whenIdle(): Promise<void> }`
  - `createRunService(deps: RunServiceDeps): RunService`

**设计要点**
- `trigger` 只做两件事：落 `runs` 行（`queued`）并入队，立即返回 `RunRow`（供路由返回 `runId`）。
- 获得信号量槽位后：`markRunning` → `buildRuntimeWorkflow`（重写路径/连接/输出）→ 执行（默认走引擎 `createRun` + `executeWorkflow`）→ 结束写 `success`/`error`。
- 执行失败按 `config.runMaxRetries` 重试（默认 1 次，即最多执行 2 次）。
- `executor` 可注入：单元测试用桩，避免拉起 DuckDB 原生模块；未来子进程隔离也从这里替换（与 spec §10 一致）。

- [ ] **Step 1: 写失败测试（信号量）**

`apps/server/test/run-queue.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import { createSemaphore } from '../src/modules/runs/queue.js';

describe('createSemaphore', () => {
  it('并发不超过 limit，且峰值正确', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        sem.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(sem.active()).toBe(0);
    expect(sem.waiting()).toBe(0);
  });

  it('release 后把槽位交给等待者', async () => {
    const sem = createSemaphore(1);
    const order: string[] = [];
    const p1 = sem.run(async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a:end');
    });
    const p2 = sem.run(async () => {
      order.push('b:start');
    });
    await new Promise((r) => setTimeout(r, 1));
    expect(sem.waiting()).toBe(1);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('fn 抛错时也会释放槽位', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sem.active()).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/run-queue.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/runs/queue.js'`。

- [ ] **Step 3: 实现 queue.ts**

`apps/server/src/modules/runs/queue.ts`
```ts
export type Release = () => void;

export interface Semaphore {
  acquire(): Promise<Release>;
  run<T>(fn: () => Promise<T>): Promise<T>;
  active(): number;
  waiting(): number;
}

export function createSemaphore(limit: number): Semaphore {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const release: Release = () => {
    const next = queue.shift();
    if (next) {
      // 槽位直接移交给等待者，active 保持不变
      next();
      return;
    }
    active -= 1;
  };

  const acquire = (): Promise<Release> =>
    new Promise<Release>((resolve) => {
      const grant = (): void => {
        active += 1;
        resolve(release);
      };
      if (active < max) grant();
      else queue.push(grant);
    });

  return {
    acquire,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const rel = await acquire();
      try {
        return await fn();
      } finally {
        rel();
      }
    },
    active: () => active,
    waiting: () => queue.length,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/run-queue.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 写失败测试（RunService）**

`apps/server/test/run-service.test.ts`
```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createRecorder } from '../src/modules/runs/recorder.js';
import { runsRepo } from '../src/modules/runs/repo.js';
import { createRunService, type RunExecutor } from '../src/modules/runs/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const PAYLOAD = JSON.stringify({
  nodes: [{ id: 'n1', kind: 'inputCsv', name: 'A', position: { x: 0, y: 0 }, config: { path: '/o/a.csv' } }],
  edges: [],
});

let db: Database.Database;
let workflowId: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  const owner = usersRepo(db).create({ username: 'alice', passwordHash: 'x', role: 'user' });
  workflowId = workflowsRepo(db).create({ ownerId: owner.id, name: 'A', payload: PAYLOAD }).id;
});

describe('createRunService', () => {
  it('触发后落库为 queued，执行成功置 success 并记录 engineRunId', async () => {
    const recorder = createRecorder(db);
    const service = createRunService({
      db,
      config: cfg,
      recorder,
      executor: async ({ onEngineRunId }) => onEngineRunId('eng-1'),
    });
    const run = service.trigger(workflowId, { triggerType: 'manual' });
    expect(run.status).toBe('queued');
    await service.whenIdle();
    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('success');
    expect(detail.engine_run_id).toBe('eng-1');
    expect(detail.finished_at).not.toBeNull();
    recorder.dispose();
  });

  it('执行失败按 runMaxRetries 重试后置 error', async () => {
    const recorder = createRecorder(db);
    let calls = 0;
    const executor: RunExecutor = async () => {
      calls += 1;
      throw new Error(`失败第 ${calls} 次`);
    };
    const service = createRunService({ db, config: cfg, recorder, executor });
    const run = service.trigger(workflowId);
    await service.whenIdle();
    const detail = runsRepo(db).findById(run.id)!;
    expect(detail.status).toBe('error');
    expect(detail.error).toBe(`失败第 ${calls} 次`);
    expect(calls).toBe(cfg.runMaxRetries + 1);
    recorder.dispose();
  });

  it('并发受 concurrency 限制', async () => {
    const recorder = createRecorder(db);
    let active = 0;
    let peak = 0;
    const executor: RunExecutor = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    const service = createRunService({ db, config: cfg, recorder, executor, concurrency: 2 });
    for (let i = 0; i < 5; i += 1) service.trigger(workflowId);
    await service.whenIdle();
    expect(peak).toBe(2);
    expect(runsRepo(db).countByWorkflow(workflowId)).toBe(5);
    expect(runsRepo(db).listByWorkflow(workflowId, { limit: 10, offset: 0 }).every((r) => r.status === 'success')).toBe(true);
    recorder.dispose();
  });

  it('工作流不存在时抛错', () => {
    const service = createRunService({ db, config: cfg, recorder: createRecorder(db), executor: async () => {} });
    expect(() => service.trigger('missing')).toThrow('工作流不存在');
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/run-service.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/runs/service.js'`。

- [ ] **Step 7: 实现 service.ts**

`apps/server/src/modules/runs/service.ts`
```ts
import { createRun, executeWorkflow, type Workflow, type WorkflowEdge, type WorkflowNode } from '@hustserver/engine';
import type { Database } from 'better-sqlite3';
import { join, resolve, sep } from 'node:path';
import type { AppConfig } from '../../config.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { buildRuntimeWorkflow, type MapperDeps, type ResolvedConnection } from '../workflows/mapper.js';
import { pathMappingsRepo, workflowFilesRepo, workflowsRepo, type PathMappingRow, type WorkflowRow } from '../workflows/repo.js';
import { createSemaphore } from './queue.js';
import type { Recorder } from './recorder.js';
import { runsRepo, type RunRow, type TriggerType } from './repo.js';

export interface RunExecutorInput {
  runId: string;
  workflow: Workflow;
  onEngineRunId(engineRunId: string): void;
}

export type RunExecutor = (input: RunExecutorInput) => Promise<void>;

export interface RunServiceDeps {
  db: Database;
  config: AppConfig;
  recorder: Recorder;
  executor?: RunExecutor;
  concurrency?: number;
}

export interface RunService {
  trigger(
    workflowId: string,
    opts?: { triggerType?: TriggerType; scheduleId?: string | null; triggeredBy?: string | null },
  ): RunRow;
  whenIdle(): Promise<void>;
}

/** 默认执行器：走 vendored 引擎（createRun + executeWorkflow）。 */
const defaultExecutor: RunExecutor = async ({ workflow, onEngineRunId }) => {
  const ctx = await createRun(workflow);
  onEngineRunId(ctx.runId);
  await executeWorkflow(ctx.runId);
};

/** 把共享目录内的相对/绝对引用解析为绝对路径，越界即拒绝。 */
export function resolveServerPath(sharedDirs: string[], rel: string): string {
  const bases = sharedDirs.map((d) => resolve(d));
  const candidates = rel.startsWith('/') ? [resolve(rel)] : bases.map((b) => join(b, rel));
  for (const abs of candidates) {
    if (bases.some((b) => abs === b || abs.startsWith(b + sep))) return abs;
  }
  throw new Error(`路径不在允许的共享目录内：${rel}`);
}

function loadWorkflow(row: WorkflowRow): Workflow {
  const payload = JSON.parse(row.payload) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  return {
    id: row.id,
    name: row.name,
    nodes: payload.nodes ?? [],
    edges: payload.edges ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createRunService(deps: RunServiceDeps): RunService {
  const { db, config, recorder } = deps;
  const runs = runsRepo(db);
  const workflows = workflowsRepo(db);
  const files = workflowFilesRepo(db);
  const mappings = pathMappingsRepo(db);
  const connections = connectionsRepo(db);
  const executor = deps.executor ?? defaultExecutor;
  const sem = createSemaphore(deps.concurrency ?? config.maxConcurrentRuns);

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

  function resolveConnections(rows: PathMappingRow[]): Map<string, ResolvedConnection> {
    const map = new Map<string, ResolvedConnection>();
    for (const r of rows) {
      if (r.target_type !== 'connection' || !r.target_ref) continue;
      const conn = connections.findById(r.target_ref);
      if (!conn) continue;
      map.set(conn.id, {
        id: conn.id,
        config: decryptConfig(conn.config_encrypted, config.encryptionKey.toString('hex')),
      });
    }
    return map;
  }

  function buildRuntime(run: RunRow): Workflow {
    const row = workflows.findById(run.workflow_id);
    if (!row) throw new Error('工作流不存在');
    const workflow = loadWorkflow(row);
    const maps = mappings.listByWorkflow(run.workflow_id);
    const mapperDeps: MapperDeps = {
      uploadDir: config.uploadDir,
      outputDir: config.outputDir,
      resolveServerPath: (rel) => resolveServerPath(config.sharedDirs, rel),
      connections: resolveConnections(maps),
    };
    return buildRuntimeWorkflow({
      workflow,
      mappings: maps,
      files: files.listByWorkflow(run.workflow_id),
      deps: mapperDeps,
      workflowId: run.workflow_id,
      runId: run.id,
    });
  }

  async function worker(run: RunRow): Promise<void> {
    const startedAt = Date.now();
    let runtime: Workflow;
    try {
      runtime = buildRuntime(run);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runs.finish(run.id, { status: 'error', finishedAt: startedAt, durationMs: 0, error: message });
      return;
    }

    runs.markRunning(run.id, startedAt);
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= config.runMaxRetries; attempt += 1) {
      let engineRunId: string | null = null;
      try {
        await executor({
          runId: run.id,
          workflow: runtime,
          onEngineRunId: (id) => {
            engineRunId = id;
            runs.setEngineRunId(run.id, id);
            recorder.attach(run.id, id, runtime);
          },
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        if (engineRunId) {
          recorder.detach(engineRunId);
          engineRunId = null;
        }
      }
    }

    const finishedAt = Date.now();
    runs.finish(run.id, {
      status: lastError === null ? 'success' : 'error',
      finishedAt,
      durationMs: finishedAt - startedAt,
      error: lastError,
    });
  }

  return {
    trigger(workflowId, opts = {}) {
      const workflow = workflows.findById(workflowId);
      if (!workflow) throw new Error('工作流不存在');
      const run = runs.create({
        workflowId,
        scheduleId: opts.scheduleId ?? null,
        triggerType: opts.triggerType ?? 'manual',
        triggeredBy: opts.triggeredBy ?? null,
        status: 'queued',
      });
      pending += 1;
      void sem
        .run(() => worker(run))
        .catch(() => {
          /* worker 已把失败落库，此处仅防未捕获拒绝 */
        })
        .finally(settle);
      return run;
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

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/run-queue.test.ts test/run-service.test.ts`
Expected: PASS（7 passed）。

- [ ] **Step 9: 提交**

```bash
git add apps/server/src/modules/runs/queue.ts apps/server/src/modules/runs/service.ts apps/server/test/run-queue.test.ts apps/server/test/run-service.test.ts
git commit -m "feat: 新增 RunService 与全局并发队列（含失败重试）"
```

## Task 16: 运行路由与 SSE

**Files:**
- Create: `apps/server/src/modules/runs/sse.ts`
- Create: `apps/server/src/modules/runs/routes.ts`
- Modify: `apps/server/src/server.ts`（构建 `recorder` + `runService`，注册 `runRoutes`，新增 `overrides`）
- Test: `apps/server/test/run-routes.test.ts`

**Interfaces:**
- Consumes: `WorkflowRow`/`workflowsRepo`、`runsRepo`/`runNodeResultsRepo`/`runLogsRepo`、`Recorder`、`RunService`、`requireAuth`、`SseEvent`
- Produces:
  - `openSse(reply: FastifyReply): void`、`writeEvent(reply, event: string, data: unknown): void`、`endSse(reply): void`、`eventName(e: SseEvent): string`
  - `interface RunRoutesDeps { db; config; users; sessions; recorder; runService }`
  - `runRoutes(app: FastifyInstance, deps: RunRoutesDeps): void`
  - `AppDeps` 新增可选 `overrides?: { recorder?: Recorder; runService?: RunService }`

- [ ] **Step 1: 写失败测试**

`apps/server/test/run-routes.test.ts`
```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { createRecorder } from '../src/modules/runs/recorder.js';
import { runLogsRepo, runsRepo } from '../src/modules/runs/repo.js';
import { createRunService } from '../src/modules/runs/service.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowsRepo } from '../src/modules/workflows/repo.js';
import { buildServer } from '../src/server.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

const PAYLOAD = JSON.stringify({ nodes: [], edges: [] });

let app: FastifyInstance;
let db: Database.Database;
let recorder: ReturnType<typeof createRecorder>;
let ownerCookie: string;
let otherCookie: string;
let workflowId: string;

async function login(u: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  const owner = await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), role: 'user' });
  workflowId = workflowsRepo(db).create({ ownerId: owner.id, name: 'A', payload: PAYLOAD }).id;
  recorder = createRecorder(db);
  const runService = createRunService({ db, config: cfg, recorder, executor: async ({ onEngineRunId }) => onEngineRunId('eng-1') });
  app = await buildServer({ db, config: cfg, logger: false, overrides: { recorder, runService } });
  await app.ready();
  ownerCookie = await login('alice', 'alice123');
  otherCookie = await login('bob', 'bob12345');
});

describe('runRoutes', () => {
  it('手动运行返回 runId，随后可查详情与日志', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs`, headers: { cookie: ownerCookie } });
    expect(start.statusCode).toBe(202);
    const { runId } = start.json() as { runId: string };

    // 等待队列跑完（executor 为同步桩）
    await new Promise((r) => setTimeout(r, 20));

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: ownerCookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.status).toBe('success');

    const logs = await app.inject({ method: 'GET', url: `/api/runs/${runId}/logs`, headers: { cookie: ownerCookie } });
    expect(logs.statusCode).toBe(200);
    expect(Array.isArray(logs.json().items)).toBe(true);
  });

  it('非属主不可访问（管理员可）', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs`, headers: { cookie: ownerCookie } });
    const { runId } = start.json() as { runId: string };
    const forbidden = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: otherCookie } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('运行历史分页', async () => {
    await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs`, headers: { cookie: ownerCookie } });
    const res = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/runs?limit=10&offset=0`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThanOrEqual(1);
  });

  it('已结束运行的 SSE 立即回 done', async () => {
    const run = runsRepo(db).create({ workflowId, triggerType: 'manual', status: 'success' });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/events`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: done');
  });

  it('未登录返回 401', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/workflows/${workflowId}/runs` });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/run-routes.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/runs/routes.js'`。

- [ ] **Step 3: 实现 sse.ts**

`apps/server/src/modules/runs/sse.ts`
```ts
import type { SseEvent } from '@hustserver/engine';
import type { FastifyReply } from 'fastify';

/** 接管响应并写入 SSE 头。调用后必须自行 end()。 */
export function openSse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders?.();
  reply.raw.write(': connected\n\n');
}

export function writeEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function endSse(reply: FastifyReply): void {
  reply.raw.end();
}

/** 日志事件无 type 字段，统一命名为 'log'；其余用其 type。 */
export function eventName(event: SseEvent): string {
  return 'type' in event ? event.type : 'log';
}
```

- [ ] **Step 4: 实现 routes.ts**

`apps/server/src/modules/runs/routes.ts`
```ts
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { Role, UsersRepo } from '../users/repo.js';
import { workflowsRepo } from '../workflows/repo.js';
import type { Recorder } from './recorder.js';
import { runLogsRepo, runNodeResultsRepo, runsRepo } from './repo.js';
import type { RunService } from './service.js';
import { endSse, eventName, openSse, writeEvent } from './sse.js';

export interface RunRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  recorder: Recorder;
  runService: RunService;
}

export function runRoutes(app: FastifyInstance, deps: RunRoutesDeps): void {
  const runs = runsRepo(deps.db);
  const nodes = runNodeResultsRepo(deps.db);
  const logs = runLogsRepo(deps.db);
  const workflows = workflowsRepo(deps.db);
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });

  const canAccess = (ownerId: string, role: Role, userId: string): boolean =>
    role === 'admin' || ownerId === userId;

  /** 校验 run 归属，返回 run 及其工作流；不通过时已发送错误响应。 */
  function authorizeRun(runId: string, role: Role, userId: string): { run: ReturnType<typeof runs.findById>; ok: boolean } {
    const run = runs.findById(runId);
    if (!run) return { run: null, ok: false };
    const wf = workflows.findById(run.workflow_id);
    return { run, ok: !!wf && canAccess(wf.owner_id, role, userId) };
  }

  app.post('/api/workflows/:id/runs', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) return reply.code(404).send({ error: '工作流不存在' });
    if (!canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const run = deps.runService.trigger(id, { triggerType: 'manual', triggeredBy: req.auth!.userId });
    return reply.code(202).send({ runId: run.id });
  });

  app.get('/api/workflows/:id/runs', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const wf = workflows.findById(id);
    if (!wf) return reply.code(404).send({ error: '工作流不存在' });
    if (!canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    const q = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = Math.max(Number(q.offset) || 0, 0);
    return {
      total: runs.countByWorkflow(id),
      items: runs.listByWorkflow(id, { limit, offset }),
    };
  });

  app.get('/api/runs/:runId', { preHandler: guard }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.role, req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });
    return { run: authorized.run, nodes: nodes.listByRun(runId) };
  });

  app.get('/api/runs/:runId/logs', { preHandler: guard }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.role, req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });
    const q = req.query as { after?: string; limit?: string };
    const after = Math.max(Number(q.after) || 0, 0);
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 2000);
    return { items: logs.listByRun(runId, { after, limit }) };
  });

  app.get('/api/runs/:runId/events', { preHandler: guard }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const authorized = authorizeRun(runId, req.auth!.role, req.auth!.userId);
    if (!authorized.run) return reply.code(404).send({ error: '运行不存在' });
    if (!authorized.ok) return reply.code(403).send({ error: '无权访问' });

    openSse(reply);
    const off = deps.recorder.subscribe(
      runId,
      (event) => writeEvent(reply, eventName(event), event),
      () => {
        writeEvent(reply, 'done', { runId });
        endSse(reply);
      },
    );
    if (!off) {
      // 运行已结束：让前端回退到 /runs/:id 与 /logs
      writeEvent(reply, 'done', { runId, finished: true });
      endSse(reply);
      return reply;
    }
    req.raw.on('close', () => off());
    return reply;
  });
}
```

- [ ] **Step 5: 修改 server.ts**

`apps/server/src/server.ts`（完整替换为以下内容）
```ts
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { sessionsRepo } from './modules/auth/sessions.js';
import { connectionRoutes } from './modules/connections/routes.js';
import { createRecorder, type Recorder } from './modules/runs/recorder.js';
import { runRoutes } from './modules/runs/routes.js';
import { createRunService, type RunService } from './modules/runs/service.js';
import { userAdminRoutes } from './modules/users/routes.js';
import { usersRepo } from './modules/users/repo.js';
import { workflowRoutes } from './modules/workflows/routes.js';

export interface AppOverrides {
  recorder?: Recorder;
  runService?: RunService;
}

export interface AppDeps {
  db: Database;
  config: AppConfig;
  logger?: boolean;
  overrides?: AppOverrides;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });

  const users = usersRepo(deps.db);
  const sessions = sessionsRepo(deps.db);

  const recorder = deps.overrides?.recorder ?? createRecorder(deps.db);
  const runService =
    deps.overrides?.runService ?? createRunService({ db: deps.db, config: deps.config, recorder });

  authRoutes(app, { users, sessions, sessionTtlMs: deps.config.sessionTtlMs });
  userAdminRoutes(app, { users, sessions });
  workflowRoutes(app, { db: deps.db, config: deps.config, users, sessions });
  connectionRoutes(app, { db: deps.db, config: deps.config, users, sessions });
  runRoutes(app, { db: deps.db, config: deps.config, users, sessions, recorder, runService });

  return app;
}
```

> 说明：`multipart` 已在 Task 11 注册；此处需补上 import：`import multipart from '@fastify/multipart';`。保留 Task 11/12 中对 `workflowRoutes` / `connectionRoutes` 的注册。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/run-routes.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/modules/runs/sse.ts apps/server/src/modules/runs/routes.ts apps/server/src/server.ts apps/server/test/run-routes.test.ts
git commit -m "feat: 新增运行路由与 SSE 实时事件（含运行历史与日志查询）"
```

---

# 里程碑 M4：调度

> 目标：让用户为工作流配置运行周期（预设 + Cron）并由进程内 Scheduler 按 `cron_expr` + `timezone` 触发 `RunService`。
> 依据 Spec §10「预设↔Cron：`daily`/`weekly`/`monthly` 映射为标准 cron 表达式，统一存 `cron_expr`」「进程内调度（`node-cron` 类库）：启动时从 schedules 重建全部任务，增删改热更新」。

## Task 17: 调度时间工具（预设 ↔ Cron）

**Files:**
- Create: `apps/server/src/modules/schedules/cron.ts`
- Test: `apps/server/test/schedule-cron.test.ts`

**Interfaces:**
- Consumes: `cron-parser`（`^4.9.0`）。
- Produces:
  - `type FreqType = 'daily' | 'weekly' | 'monthly' | 'cron'`
  - `const FREQ_TYPES: readonly FreqType[]`
  - `isFreqType(value: unknown): value is FreqType`
  - `interface PresetInput { freqType: FreqType; time?: string; weekday?: number; monthDay?: number; cronExpr?: string }`
  - `class CronFormatError extends Error`
  - `presetToCron(input: PresetInput): string`
  - `validateCron(expr: string, timezone: string): boolean`
  - `nextRunAt(expr: string, timezone: string, from?: number): number | null`

**设计要点**
- `time` 统一为 `HH:MM`（24 小时制，两位补零）；`weekday` 为 `0–6`（0=周日）；`monthDay` 为 `1–31`。
- `freqType === 'cron'` 时原样返回 `cronExpr`（仅 trim），不做预设校验。
- 非法输入抛 `CronFormatError`（路由层据此返回 400）。
- 时区透传给 `cron-parser`，由其完成 DST 与偏移处理。

- [ ] **Step 1: 写失败测试**

`apps/server/test/schedule-cron.test.ts`
```ts
import { describe, expect, it } from 'vitest';
import {
  CronFormatError,
  isFreqType,
  nextRunAt,
  presetToCron,
  validateCron,
} from '../src/modules/schedules/cron.js';

describe('presetToCron', () => {
  it('daily / weekly / monthly 映射为标准 cron', () => {
    expect(presetToCron({ freqType: 'daily', time: '09:30' })).toBe('30 9 * * *');
    expect(presetToCron({ freqType: 'weekly', time: '08:00', weekday: 1 })).toBe('0 8 * * 1');
    expect(presetToCron({ freqType: 'monthly', time: '12:00', monthDay: 15 })).toBe('0 12 15 * *');
  });

  it('cron 类型原样返回并去除首尾空格', () => {
    expect(presetToCron({ freqType: 'cron', cronExpr: '  */5 * * * *  ' })).toBe('*/5 * * * *');
  });

  it('非法输入抛 CronFormatError', () => {
    expect(() => presetToCron({ freqType: 'daily', time: '9:30' })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'daily', time: '25:00' })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'weekly', time: '08:00', weekday: 9 })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'monthly', time: '08:00', monthDay: 0 })).toThrow(CronFormatError);
    expect(() => presetToCron({ freqType: 'cron', cronExpr: '   ' })).toThrow(CronFormatError);
  });
});

describe('validateCron 与 nextRunAt', () => {
  it('isFreqType 仅接受四种取值', () => {
    expect(isFreqType('daily')).toBe(true);
    expect(isFreqType('cron')).toBe(true);
    expect(isFreqType('hourly')).toBe(false);
    expect(isFreqType(undefined)).toBe(false);
  });

  it('校验合法与非法表达式', () => {
    expect(validateCron('0 9 * * *', 'Asia/Shanghai')).toBe(true);
    expect(validateCron('not a cron', 'Asia/Shanghai')).toBe(false);
    expect(validateCron('', 'Asia/Shanghai')).toBe(false);
  });

  it('按指定时区计算下次触发时间', () => {
    // 2026-10-14T03:00:00Z = 北京时间 11:00，已过当日 09:00，故下次为次日 09:00（= 01:00Z）
    const ts = nextRunAt('0 9 * * *', 'Asia/Shanghai', Date.parse('2026-10-14T03:00:00Z'));
    expect(ts).not.toBeNull();
    expect(new Date(ts!).toISOString()).toBe('2026-10-15T01:00:00.000Z');
  });

  it('非法表达式返回 null', () => {
    expect(nextRunAt('bad expr', 'Asia/Shanghai')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/schedule-cron.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/schedules/cron.js'`。

- [ ] **Step 3: 实现 cron.ts**

`apps/server/src/modules/schedules/cron.ts`
```ts
import { CronExpressionParser } from 'cron-parser';

export type FreqType = 'daily' | 'weekly' | 'monthly' | 'cron';

export const FREQ_TYPES: readonly FreqType[] = ['daily', 'weekly', 'monthly', 'cron'];

export function isFreqType(value: unknown): value is FreqType {
  return typeof value === 'string' && (FREQ_TYPES as readonly string[]).includes(value);
}

export class CronFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronFormatError';
  }
}

export interface PresetInput {
  freqType: FreqType;
  /** HH:MM，24 小时制 */
  time?: string;
  /** 0–6，0=周日 */
  weekday?: number;
  /** 1–31 */
  monthDay?: number;
  cronExpr?: string;
}

function parseTime(time: string | undefined): { hour: number; minute: number } {
  const matched = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  if (!matched) throw new CronFormatError('时间格式应为 HH:MM');
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) throw new CronFormatError('时间超出范围');
  return { hour, minute };
}

/** 预设（daily/weekly/monthly）或原生 cron 统一归一为 5 段标准 cron 表达式。 */
export function presetToCron(input: PresetInput): string {
  switch (input.freqType) {
    case 'daily': {
      const { hour, minute } = parseTime(input.time);
      return `${minute} ${hour} * * *`;
    }
    case 'weekly': {
      const { hour, minute } = parseTime(input.time);
      const weekday = input.weekday;
      if (weekday === undefined || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new CronFormatError('weekday 应为 0–6 的整数');
      }
      return `${minute} ${hour} * * ${weekday}`;
    }
    case 'monthly': {
      const { hour, minute } = parseTime(input.time);
      const monthDay = input.monthDay;
      if (monthDay === undefined || !Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
        throw new CronFormatError('monthDay 应为 1–31 的整数');
      }
      return `${minute} ${hour} ${monthDay} * *`;
    }
    case 'cron': {
      const expr = (input.cronExpr ?? '').trim();
      if (!expr) throw new CronFormatError('cron 表达式不能为空');
      return expr;
    }
  }
}

export function validateCron(expr: string, timezone: string): boolean {
  try {
    CronExpressionParser.parse(expr, { tz: timezone });
    return true;
  } catch {
    return false;
  }
}

/** 返回 from 之后的下一次触发时间戳（毫秒）；表达式非法或时区无效时返回 null。 */
export function nextRunAt(expr: string, timezone: string, from: number = Date.now()): number | null {
  try {
    const it = CronExpressionParser.parse(expr, { currentDate: new Date(from), tz: timezone });
    return it.next().toDate().getTime();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/schedule-cron.test.ts`
Expected: PASS（6 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/schedules/cron.ts apps/server/test/schedule-cron.test.ts
git commit -m "feat: 新增调度时间工具（预设与 Cron 互转、校验与下次触发计算）"
```

## Task 18: 调度仓储与进程内 Scheduler

**Files:**
- Modify: `apps/server/package.json`（devDependencies 新增 `@types/node-cron`）
- Create: `apps/server/src/modules/schedules/repo.ts`
- Create: `apps/server/src/modules/schedules/scheduler.ts`
- Test: `apps/server/test/schedule-repo.test.ts`
- Test: `apps/server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `Database`、`migrate`（Task 3）、`FreqType`（Task 17）、`node-cron`（`^3.0.3`）、`schedules` 表（Task 3 DDL）。
- Produces:
  - `interface ScheduleRow { id; workflow_id; enabled: number; freq_type: FreqType; cron_expr; timezone; created_at; updated_at }`
  - `schedulesRepo(db): SchedulesRepo`，方法：`create`、`findById`、`listByWorkflow`、`listEnabled`、`update`、`remove`。
  - `interface CronTask { stop(): void; destroy(): void }`、`interface CronImpl { schedule(expr, timezone, fn): CronTask | null }`
  - `interface SchedulerDeps { schedules: SchedulesRepo; triggerRun: (workflowId: string, scheduleId: string) => void; cronImpl?: CronImpl; onError?: (err: unknown) => void }`
  - `interface Scheduler { start(): void; stop(): void; reload(): void; registeredIds(): string[] }`
  - `createScheduler(deps: SchedulerDeps): Scheduler`

**设计要点**
- Scheduler 只负责「注册/销毁定时任务」，触发动作通过 `triggerRun` 回调注入，从而与 `RunService` 解耦（测试可注入桩）。
- `cronImpl` 抽象一层 `node-cron`：默认实现用 `cron.validate` 过滤非法表达式，非法者不注册。
- `start()` 与 `reload()` 语义相同（全量重建）：先 `destroy` 现有任务，再按 `schedules.listEnabled()` 重建 —— 满足「启动时重建、增删改热更新」。
- 触发回调内 `try/catch`，异常交由 `onError`，不让定时器崩溃。

- [ ] **Step 1: 新增 node-cron 类型依赖**

修改 `apps/server/package.json` 的 `devDependencies`，追加：
```json
    "@types/node-cron": "^3.0.11",
```
然后执行：
```bash
pnpm install
```

> 说明：`node-cron@3` 不自带类型定义，需 `@types/node-cron`。

- [ ] **Step 2: 写失败测试（仓储）**

`apps/server/test/schedule-repo.test.ts`
```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { schedulesRepo, type SchedulesRepo } from '../src/modules/schedules/repo.js';

let db: Database.Database;
let repo: SchedulesRepo;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.prepare(
    'INSERT INTO users (id,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run('u1', 'alice', 'x', 'user', 'active', 0, 0);
  db.prepare(
    'INSERT INTO workflows (id,owner_id,name,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
  ).run('w1', 'u1', 'wf', '{"nodes":[],"edges":[]}', 0, 0);
  repo = schedulesRepo(db);
});

describe('schedulesRepo', () => {
  it('创建返回完整行，默认时区与启用状态', () => {
    const row = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    expect(row).toMatchObject({
      workflow_id: 'w1',
      enabled: 1,
      freq_type: 'daily',
      cron_expr: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    });
    expect(repo.findById(row.id)).toEqual(row);
  });

  it('按工作流列出，按启用状态筛选', () => {
    const a = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    repo.create({ workflowId: 'w1', freqType: 'cron', cronExpr: '*/5 * * * *', enabled: false });
    expect(repo.listByWorkflow('w1')).toHaveLength(2);
    expect(repo.listEnabled()).toHaveLength(1);
    expect(repo.listEnabled()[0].id).toBe(a.id);
  });

  it('更新可启停与改表达式，未提供的字段保持原值', () => {
    const row = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    const off = repo.update(row.id, { enabled: false })!;
    expect(off.enabled).toBe(0);
    expect(off.cron_expr).toBe('0 9 * * *');
    const changed = repo.update(row.id, { freqType: 'cron', cronExpr: '0 3 * * *', enabled: true })!;
    expect(changed).toMatchObject({ enabled: 1, freq_type: 'cron', cron_expr: '0 3 * * *' });
    expect(changed.updated_at).toBeGreaterThanOrEqual(row.updated_at);
  });

  it('更新不存在的调度返回 null；删除返回布尔', () => {
    expect(repo.update('nope', { enabled: false })).toBeNull();
    const row = repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    expect(repo.remove(row.id)).toBe(true);
    expect(repo.remove(row.id)).toBe(false);
    expect(repo.findById(row.id)).toBeNull();
  });

  it('删除工作流级联删除其调度', () => {
    repo.create({ workflowId: 'w1', freqType: 'daily', cronExpr: '0 9 * * *' });
    db.prepare('DELETE FROM workflows WHERE id = ?').run('w1');
    expect(repo.listByWorkflow('w1')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/schedule-repo.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/schedules/repo.js'`。

- [ ] **Step 4: 实现 repo.ts**

`apps/server/src/modules/schedules/repo.ts`
```ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import type { FreqType } from './cron.js';

export interface ScheduleRow {
  id: string;
  workflow_id: string;
  enabled: number;
  freq_type: FreqType;
  cron_expr: string;
  timezone: string;
  created_at: number;
  updated_at: number;
}

export interface SchedulesRepo {
  create(input: {
    workflowId: string;
    freqType: FreqType;
    cronExpr: string;
    timezone?: string;
    enabled?: boolean;
  }): ScheduleRow;
  findById(id: string): ScheduleRow | null;
  listByWorkflow(workflowId: string): ScheduleRow[];
  listEnabled(): ScheduleRow[];
  update(
    id: string,
    patch: { freqType?: FreqType; cronExpr?: string; timezone?: string; enabled?: boolean },
  ): ScheduleRow | null;
  remove(id: string): boolean;
}

export function schedulesRepo(db: Database): SchedulesRepo {
  const getStmt = db.prepare('SELECT * FROM schedules WHERE id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO schedules (id,workflow_id,enabled,freq_type,cron_expr,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const byWorkflowStmt = db.prepare(
    'SELECT * FROM schedules WHERE workflow_id = ? ORDER BY created_at ASC',
  );
  const enabledStmt = db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at ASC');
  const updateStmt = db.prepare(
    'UPDATE schedules SET enabled=?, freq_type=?, cron_expr=?, timezone=?, updated_at=? WHERE id=?',
  );
  const deleteStmt = db.prepare('DELETE FROM schedules WHERE id = ?');
  const get = (id: string): ScheduleRow | null => (getStmt.get(id) as ScheduleRow | undefined) ?? null;

  return {
    create({ workflowId, freqType, cronExpr, timezone = 'Asia/Shanghai', enabled = true }) {
      const id = nanoid(12);
      const now = Date.now();
      insertStmt.run(id, workflowId, enabled ? 1 : 0, freqType, cronExpr, timezone, now, now);
      return get(id)!;
    },
    findById: get,
    listByWorkflow: (workflowId) => byWorkflowStmt.all(workflowId) as ScheduleRow[],
    listEnabled: () => enabledStmt.all() as ScheduleRow[],
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      const enabled = patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0;
      const freqType = patch.freqType ?? cur.freq_type;
      const cronExpr = patch.cronExpr ?? cur.cron_expr;
      const timezone = patch.timezone ?? cur.timezone;
      updateStmt.run(enabled, freqType, cronExpr, timezone, Date.now(), id);
      return get(id);
    },
    remove: (id) => deleteStmt.run(id).changes > 0,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/schedule-repo.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 6: 写失败测试（Scheduler）**

`apps/server/test/scheduler.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import type { ScheduleRow, SchedulesRepo } from '../src/modules/schedules/repo.js';
import { createScheduler, type CronImpl } from '../src/modules/schedules/scheduler.js';

function row(over: Partial<ScheduleRow> & { id: string }): ScheduleRow {
  return {
    workflow_id: 'w1',
    enabled: 1,
    freq_type: 'daily',
    cron_expr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

/** 捕获注册信息的桩 CronImpl。 */
function stubCron() {
  const registered: Array<{ expr: string; tz: string; fire: () => void }> = [];
  const impl: CronImpl = {
    schedule(expr, timezone, fn) {
      if (expr === 'INVALID') return null;
      registered.push({ expr, tz: timezone, fire: fn });
      return { stop: () => {}, destroy: () => {} };
    },
  };
  return { registered, impl };
}

describe('createScheduler', () => {
  it('start 注册全部启用调度', () => {
    const { registered, impl } = stubCron();
    const schedules = {
      listEnabled: () => [row({ id: 's1' }), row({ id: 's2', cron_expr: '0 3 * * *' })],
    } as unknown as SchedulesRepo;
    const s = createScheduler({ schedules, triggerRun: vi.fn(), cronImpl: impl });

    s.start();
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(registered.map((r) => r.expr)).toEqual(['0 9 * * *', '0 3 * * *']);
    expect(registered[0].tz).toBe('Asia/Shanghai');
  });

  it('定时回调触发 triggerRun(workflowId, scheduleId)', () => {
    const { registered, impl } = stubCron();
    const schedules = {
      listEnabled: () => [row({ id: 's1', workflow_id: 'w9' })],
    } as unknown as SchedulesRepo;
    const triggerRun = vi.fn();
    const s = createScheduler({ schedules, triggerRun, cronImpl: impl });

    s.start();
    registered[0].fire();
    expect(triggerRun).toHaveBeenCalledWith('w9', 's1');
  });

  it('triggerRun 抛错时交由 onError，不向外抛出', () => {
    const { registered, impl } = stubCron();
    const schedules = { listEnabled: () => [row({ id: 's1' })] } as unknown as SchedulesRepo;
    const onError = vi.fn();
    const s = createScheduler({
      schedules,
      triggerRun: () => {
        throw new Error('boom');
      },
      cronImpl: impl,
      onError,
    });

    s.start();
    expect(() => registered[0].fire()).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('reload 反映最新启用集合并销毁旧任务；stop 清空', () => {
    const { impl } = stubCron();
    let rows: ScheduleRow[] = [row({ id: 's1' })];
    const destroyed: string[] = [];
    const implWithSpy: CronImpl = {
      schedule: (expr, tz, fn) => {
        const task = impl.schedule(expr, tz, fn)!;
        return {
          stop: () => task.stop(),
          destroy: () => {
            destroyed.push(expr);
            task.destroy();
          },
        };
      },
    };
    const schedules = { listEnabled: () => rows } as unknown as SchedulesRepo;
    const s = createScheduler({ schedules, triggerRun: vi.fn(), cronImpl: implWithSpy });

    s.start();
    expect(s.registeredIds()).toEqual(['s1']);
    rows = [row({ id: 's1' }), row({ id: 's2' }), row({ id: 's3', enabled: 0 })];
    s.reload();
    expect(s.registeredIds().sort()).toEqual(['s1', 's2']);
    expect(destroyed.length).toBeGreaterThanOrEqual(1); // 旧任务被销毁

    s.stop();
    expect(s.registeredIds()).toEqual([]);
  });

  it('非法 cron 表达式不注册', () => {
    const { impl } = stubCron();
    const schedules = {
      listEnabled: () => [row({ id: 's1', cron_expr: 'INVALID' })],
    } as unknown as SchedulesRepo;
    const s = createScheduler({ schedules, triggerRun: vi.fn(), cronImpl: impl });
    s.start();
    expect(s.registeredIds()).toEqual([]);
  });
});
```

> 说明：`listEnabled()` 在真实仓储中已只返回 `enabled = 1` 的行；此处第三个用例显式给一个 `enabled: 0` 的桩行，用于断言 Scheduler **不**自行二次过滤（过滤职责在仓储），因此期望 `s1`、`s2` 被注册、`s3` 不注册的前提是桩 `listEnabled` 已做过滤——故该用例改为在桩内过滤，见 Step 8 修正版。

- [ ] **Step 7: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/scheduler.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/schedules/scheduler.js'`。

- [ ] **Step 8: 实现 scheduler.ts（并修正上一步用例的桩）**

`apps/server/src/modules/schedules/scheduler.ts`
```ts
import cron from 'node-cron';
import type { ScheduleRow, SchedulesRepo } from './repo.js';

/** 对 node-cron 定时任务的最小抽象。 */
export interface CronTask {
  stop(): void;
  destroy(): void;
}

/** 对 node-cron 的最小抽象，便于测试注入。 */
export interface CronImpl {
  schedule(expr: string, timezone: string, fn: () => void): CronTask | null;
}

export interface SchedulerDeps {
  schedules: SchedulesRepo;
  triggerRun: (workflowId: string, scheduleId: string) => void;
  cronImpl?: CronImpl;
  onError?: (err: unknown) => void;
}

export interface Scheduler {
  /** 启动：全量重建全部启用调度 */
  start(): void;
  /** 停止并销毁全部任务 */
  stop(): void;
  /** 热更新：等价于 stop + start */
  reload(): void;
  /** 当前已注册的调度 id（测试与诊断用） */
  registeredIds(): string[];
}

const defaultCronImpl: CronImpl = {
  schedule(expr, timezone, fn) {
    if (!cron.validate(expr)) return null;
    return cron.schedule(expr, fn, { scheduled: true, timezone });
  },
};

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const impl = deps.cronImpl ?? defaultCronImpl;
  const tasks = new Map<string, CronTask>();

  const stopAll = (): void => {
    for (const task of tasks.values()) task.destroy();
    tasks.clear();
  };

  const register = (schedule: ScheduleRow): void => {
    const task = impl.schedule(schedule.cron_expr, schedule.timezone, () => {
      try {
        deps.triggerRun(schedule.workflow_id, schedule.id);
      } catch (err) {
        deps.onError?.(err);
      }
    });
    if (task) tasks.set(schedule.id, task);
  };

  const reload = (): void => {
    stopAll();
    for (const schedule of deps.schedules.listEnabled()) register(schedule);
  };

  return {
    start: reload,
    stop: stopAll,
    reload,
    registeredIds: () => [...tasks.keys()],
  };
}
```

将 `test/scheduler.test.ts` 中第四个用例的桩 `listEnabled` 改为按 `enabled` 过滤，以贴合真实仓储语义：
```ts
    const schedules = { listEnabled: () => rows.filter((r) => r.enabled === 1) } as unknown as SchedulesRepo;
```
并把该用例断言调整为 `expect(s.registeredIds().sort()).toEqual(['s1', 's2']);`（保持既有断言即可）。

- [ ] **Step 9: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/scheduler.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 10: 提交**

```bash
git add apps/server/package.json apps/server/src/modules/schedules/repo.ts apps/server/src/modules/schedules/scheduler.ts apps/server/test/schedule-repo.test.ts apps/server/test/scheduler.test.ts pnpm-lock.yaml
git commit -m "feat: 新增调度仓储与进程内 Scheduler（node-cron，热更新）"
```

## Task 19: 调度路由与 server 装配

**Files:**
- Create: `apps/server/src/modules/schedules/routes.ts`
- Modify: `apps/server/src/server.ts`（构建 `scheduler` 并注册 `scheduleRoutes`）
- Test: `apps/server/test/schedule-routes.test.ts`

**Interfaces:**
- Consumes: `AppConfig`（`tz`）、`Database`、`UsersRepo`/`SessionsRepo`、`requireAuth`、`workflowsRepo`、`schedulesRepo`、`Scheduler`、`presetToCron`/`validateCron`/`nextRunAt`/`isFreqType`/`CronFormatError`。
- Produces:
  - `scheduleRoutes(app: FastifyInstance, deps: ScheduleRoutesDeps): void`
  - `interface ScheduleRoutesDeps { db; config; users; sessions; scheduler: Pick<Scheduler, 'reload'> }`
  - 端点按 Spec §8 `schedules` 组：`GET/POST /api/workflows/:id/schedules`、`PUT/DELETE /api/schedules/:id`。

**设计要点**
- 请求体统一为 camelCase 预设入参：`{ freqType, time?, weekday?, monthDay?, cronExpr?, timezone?, enabled? }`；服务端用 `presetToCron` 归一为 `cron_expr` 后落库（前端无需自己拼 cron）。
- `timezone` 缺省取 `config.tz`（默认 `Asia/Shanghai`）。
- 响应在行数据基础上附加 `nextRunAt`（由 `nextRunAt(cron_expr, timezone)` 计算，便于前端展示“下次运行”）。
- 任何写操作后调用 `deps.scheduler.reload()`，实现「增删改热更新」。
- 权限：`admin` 或工作流属主；越权 403、未登录 401（由守卫处理）。

- [ ] **Step 1: 写失败测试**

`apps/server/test/schedule-routes.test.ts`
```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { hashPassword } from '../src/modules/auth/password.js';
import type { Recorder } from '../src/modules/runs/recorder.js';
import type { RunService } from '../src/modules/runs/service.js';
import type { Scheduler } from '../src/modules/schedules/scheduler.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-sched-routes-'));
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
const reload = vi.fn();

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  reload.mockClear();
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), role: 'user' });

  const recorder = {} as Recorder;
  const runService = { trigger: vi.fn(), whenIdle: async () => {} } as unknown as RunService;
  const scheduler = { reload } as unknown as Scheduler;

  app = await buildServer({
    db,
    config: cfg,
    logger: false,
    overrides: { recorder, runService, scheduler },
  });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');

  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    headers: { cookie: aliceCookie },
    payload: { workflow: { id: 'w', name: '样例', createdAt: 0, updatedAt: 0, nodes: [], edges: [] }, mappings: [] },
  });
  workflowId = created.json().id;
});

describe('schedule routes', () => {
  it('预设 daily 自动生成 cron_expr 并返回 nextRunAt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'daily', time: '09:30' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.cron_expr).toBe('30 9 * * *');
    expect(body.timezone).toBe('Asia/Shanghai');
    expect(typeof body.nextRunAt).toBe('number');
    expect(reload).toHaveBeenCalled();

    const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: aliceCookie } });
    expect(list.json().items).toHaveLength(1);
  });

  it('非法预设时间与非法 cron 返回 400', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'daily', time: '25:00' },
    });
    expect(bad.statusCode).toBe(400);

    const badCron = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'cron', cronExpr: 'not a cron' },
    });
    expect(badCron.statusCode).toBe(400);
  });

  it('未登录 401，非属主 403，管理员可读', async () => {
    const anon = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules` });
    expect(anon.statusCode).toBe(401);

    const forbidden = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: bobCookie } });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: adminCookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('PUT 可启停并改表达式，联动 scheduler.reload', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'weekly', time: '08:00', weekday: 1 },
    });
    const id = created.json().id;
    expect(created.json().cron_expr).toBe('0 8 * * 1');
    reload.mockClear();

    const off = await app.inject({
      method: 'PUT',
      url: `/api/schedules/${id}`,
      headers: { cookie: aliceCookie },
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().enabled).toBe(0);
    expect(off.json().cron_expr).toBe('0 8 * * 1');
    expect(reload).toHaveBeenCalledTimes(1);

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/schedules/${id}`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'cron', cronExpr: '0 3 * * *', enabled: true },
    });
    expect(changed.json()).toMatchObject({ enabled: 1, freq_type: 'cron', cron_expr: '0 3 * * *' });
  });

  it('DELETE 删除后列表为空', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: aliceCookie },
      payload: { freqType: 'daily', time: '09:00' },
    });
    const id = created.json().id;
    reload.mockClear();

    const del = await app.inject({ method: 'DELETE', url: `/api/schedules/${id}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    expect(reload).toHaveBeenCalledTimes(1);

    const list = await app.inject({ method: 'GET', url: `/api/workflows/${workflowId}/schedules`, headers: { cookie: aliceCookie } });
    expect(list.json().items).toHaveLength(0);
  });

  it('对不存在的调度 PUT/DELETE 返回 404', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/schedules/nope', headers: { cookie: aliceCookie }, payload: { enabled: false } });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: '/api/schedules/nope', headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/schedule-routes.test.ts`
Expected: FAIL，`Cannot find module '../src/modules/schedules/routes.js'`。

- [ ] **Step 3: 实现 routes.ts**

`apps/server/src/modules/schedules/routes.ts`
```ts
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import { requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { Role, UsersRepo } from '../users/repo.js';
import { workflowsRepo } from '../workflows/repo.js';
import { CronFormatError, isFreqType, nextRunAt, presetToCron, validateCron } from './cron.js';
import { schedulesRepo } from './repo.js';
import type { Scheduler } from './scheduler.js';

export interface ScheduleRoutesDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  scheduler: Pick<Scheduler, 'reload'>;
}

interface ScheduleBody {
  freqType?: unknown;
  time?: unknown;
  weekday?: unknown;
  monthDay?: unknown;
  cronExpr?: unknown;
  timezone?: unknown;
  enabled?: unknown;
}

export function scheduleRoutes(app: FastifyInstance, deps: ScheduleRoutesDeps): void {
  const schedules = schedulesRepo(deps.db);
  const workflows = workflowsRepo(deps.db);
  const guard = requireAuth({ users: deps.users, sessions: deps.sessions });
  const defaultTimezone = deps.config.tz;

  const canAccess = (ownerId: string, role: Role, userId: string): boolean =>
    role === 'admin' || ownerId === userId;

  const asString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

  const runAt = (cronExpr: string, timezone: string): number | null => nextRunAt(cronExpr, timezone);

  /** 按工作流校验归属；不通过时已发送响应并返回 null。 */
  function loadWorkflow(workflowId: string, role: Role, userId: string, reply: never): never | null {
    const wf = workflows.findById(workflowId);
    if (!wf) {
      (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(404).send({ error: '工作流不存在' });
      return null;
    }
    if (!canAccess(wf.owner_id, role, userId)) {
      (reply as { code: (n: number) => { send: (b: unknown) => unknown } }).code(403).send({ error: '无权访问' });
      return null;
    }
    return wf as unknown as null;
  }

  app.get('/api/workflows/:id/schedules', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loadWorkflow(id, req.auth!.role, req.auth!.userId, reply as never)) return reply;
    const items = schedules.listByWorkflow(id).map((row) => ({
      ...row,
      nextRunAt: row.enabled ? runAt(row.cron_expr, row.timezone) : null,
    }));
    return { items };
  });

  app.post('/api/workflows/:id/schedules', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loadWorkflow(id, req.auth!.role, req.auth!.userId, reply as never)) return reply;

    const body = (req.body ?? {}) as ScheduleBody;
    const freqType = isFreqType(body.freqType) ? body.freqType : null;
    if (!freqType) return reply.code(400).send({ error: 'freqType 无效' });
    const timezone = asString(body.timezone) ?? defaultTimezone;

    let cronExpr: string;
    try {
      cronExpr = presetToCron({
        freqType,
        time: asString(body.time),
        weekday: asNumber(body.weekday),
        monthDay: asNumber(body.monthDay),
        cronExpr: asString(body.cronExpr),
      });
    } catch (err) {
      if (err instanceof CronFormatError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    if (!validateCron(cronExpr, timezone)) {
      return reply.code(400).send({ error: 'cron 表达式或时区无效' });
    }

    const row = schedules.create({
      workflowId: id,
      freqType,
      cronExpr,
      timezone,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
    });
    deps.scheduler.reload();
    return reply.code(201).send({ ...row, nextRunAt: row.enabled ? runAt(row.cron_expr, row.timezone) : null });
  });

  app.put('/api/schedules/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = schedules.findById(id);
    if (!cur) return reply.code(404).send({ error: '调度不存在' });
    const wf = workflows.findById(cur.workflow_id);
    if (!wf || !canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }

    const body = (req.body ?? {}) as ScheduleBody;
    const hasFreqField =
      body.freqType !== undefined ||
      body.time !== undefined ||
      body.weekday !== undefined ||
      body.monthDay !== undefined ||
      body.cronExpr !== undefined;

    const timezone = asString(body.timezone) ?? cur.timezone;
    const freqType = isFreqType(body.freqType) ? body.freqType : cur.freq_type;
    let cronExpr = cur.cron_expr;
    if (hasFreqField) {
      try {
        cronExpr = presetToCron({
          freqType,
          time: asString(body.time),
          weekday: asNumber(body.weekday),
          monthDay: asNumber(body.monthDay),
          cronExpr: asString(body.cronExpr) ?? cur.cron_expr,
        });
      } catch (err) {
        if (err instanceof CronFormatError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    }
    if (!validateCron(cronExpr, timezone)) {
      return reply.code(400).send({ error: 'cron 表达式或时区无效' });
    }

    const updated = schedules.update(id, {
      freqType: hasFreqField ? freqType : undefined,
      cronExpr: hasFreqField ? cronExpr : undefined,
      timezone: body.timezone !== undefined ? timezone : undefined,
      enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
    })!;
    deps.scheduler.reload();
    return { ...updated, nextRunAt: updated.enabled ? runAt(updated.cron_expr, updated.timezone) : null };
  });

  app.delete('/api/schedules/:id', { preHandler: guard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = schedules.findById(id);
    if (!cur) return reply.code(404).send({ error: '调度不存在' });
    const wf = workflows.findById(cur.workflow_id);
    if (!wf || !canAccess(wf.owner_id, req.auth!.role, req.auth!.userId)) {
      return reply.code(403).send({ error: '无权访问' });
    }
    schedules.remove(id);
    deps.scheduler.reload();
    return { ok: true };
  });
}
```

> 说明：`loadWorkflow` 的 `reply` 参数为避免循环依赖（仅用到 `code/send`）而采用最小结构断言；也可直接传入 `FastifyReply` 类型并去掉断言，二者等价。实施时优先使用 `FastifyReply` 直接类型标注（更清晰）：
> ```ts
> import type { FastifyReply } from 'fastify';
> function loadWorkflow(workflowId: string, role: Role, userId: string, reply: FastifyReply): boolean {
>   const wf = workflows.findById(workflowId);
>   if (!wf) { reply.code(404).send({ error: '工作流不存在' }); return false; }
>   if (!canAccess(wf.owner_id, role, userId)) { reply.code(403).send({ error: '无权访问' }); return false; }
>   return true;
> }
> ```
> 并相应把调用点改为 `if (!loadWorkflow(id, req.auth!.role, req.auth!.userId, reply)) return reply;`。**以该简化版为准。**

- [ ] **Step 4: 修改 server.ts**

`apps/server/src/server.ts`（完整替换为以下内容）
```ts
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { sessionsRepo } from './modules/auth/sessions.js';
import { connectionRoutes } from './modules/connections/routes.js';
import { createRecorder, type Recorder } from './modules/runs/recorder.js';
import { runRoutes } from './modules/runs/routes.js';
import { createRunService, type RunService } from './modules/runs/service.js';
import { schedulesRepo } from './modules/schedules/repo.js';
import { scheduleRoutes } from './modules/schedules/routes.js';
import { createScheduler, type Scheduler } from './modules/schedules/scheduler.js';
import { userAdminRoutes } from './modules/users/routes.js';
import { usersRepo } from './modules/users/repo.js';
import { workflowRoutes } from './modules/workflows/routes.js';

export interface AppOverrides {
  recorder?: Recorder;
  runService?: RunService;
  scheduler?: Scheduler;
}

export interface AppDeps {
  db: Database;
  config: AppConfig;
  logger?: boolean;
  overrides?: AppOverrides;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024 } });

  const users = usersRepo(deps.db);
  const sessions = sessionsRepo(deps.db);

  const recorder = deps.overrides?.recorder ?? createRecorder(deps.db);
  const runService =
    deps.overrides?.runService ?? createRunService({ db: deps.db, config: deps.config, recorder });

  const scheduler =
    deps.overrides?.scheduler ??
    createScheduler({
      schedules: schedulesRepo(deps.db),
      triggerRun: (workflowId, scheduleId) => {
        runService.trigger(workflowId, { triggerType: 'schedule', scheduleId });
      },
      onError: (err) => app.log.error({ err }, '调度触发失败'),
    });

  authRoutes(app, { users, sessions, sessionTtlMs: deps.config.sessionTtlMs });
  userAdminRoutes(app, { users, sessions });
  workflowRoutes(app, { db: deps.db, config: deps.config, users, sessions });
  connectionRoutes(app, { db: deps.db, config: deps.config, users, sessions });
  runRoutes(app, { db: deps.db, config: deps.config, users, sessions, recorder, runService });
  scheduleRoutes(app, { db: deps.db, config: deps.config, users, sessions, scheduler });

  return app;
}
```

> 说明：本步相对 Task 16 的 `server.ts` 仅新增 `multipart` import、`scheduler` 装配与 `scheduleRoutes` 注册。`scheduler.start()` 在入口 `index.ts`（Task 25）调用，`buildServer` 只构建不启动，避免测试启动真实定时器。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/schedule-routes.test.ts`
Expected: PASS（6 passed）。

- [ ] **Step 6: 回归既有服务端测试**

Run: `pnpm --filter @hustserver/server exec vitest run`
Expected: 全部 PASS（新增用例不破坏 Task 11/12/16 既有用例）。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/modules/schedules/routes.ts apps/server/src/server.ts apps/server/test/schedule-routes.test.ts
git commit -m "feat: 新增调度路由（预设/Cron 配置、启停、热更新）并装配 server"
```

---

# 里程碑 M5：部署与加固

> 目标：补齐日志保留清理、系统设置（管理员可调参数）、前端应用、服务入口与 macOS launchd 常驻脚本，并做端到端冒烟与安全复查。
> 依据 Spec §13「`LOG_RETENTION_DAYS=90`」、§16「M5 = 部署与加固：launchd 安装脚本、日志保留清理、前端完善、测试补齐、安全复查」、§10「进程内调度：启动时重建、增删改热更新」。

## Task 20: 日志保留清理

**Files:**
- Create: `apps/server/src/modules/runs/retention.ts`
- Test: `apps/server/test/retention.test.ts`

**Interfaces:**
- Consumes: `RunsRepo`（Task 14 `apps/server/src/modules/runs/repo.ts`，方法 `listOlderThan(cutoff: number): RunRow[]`、`remove(id: string): boolean`）、`AppConfig.logRetentionDays`（Task 2）。
- Produces:
  - `pruneRuns(deps: RetentionDeps): number` — 删除 `created_at < now() - logRetentionDays*24h` 的运行，返回删除条数（`runs` 的 `ON DELETE CASCADE` 会级联清掉 `run_node_results` 与 `run_logs`）。
  - `createRetention(deps: RetentionRuntimeDeps): Retention`，`Retention = { run(): number; start(intervalMs?: number): void; stop(): void }`。
  - 在入口 `index.ts`（Task 25）调用 `retention.start()`，进程退出时 `retention.stop()`。

- [ ] **Step 1: 编写失败测试**

Create `apps/server/test/retention.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRetention,
  pruneRuns,
  type RetentionDeps,
} from '../src/modules/runs/retention.js';
import type { RunRow } from '../src/modules/runs/repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function row(id: string, createdAt: number): RunRow {
  return {
    id,
    workflow_id: 'wf1',
    schedule_id: null,
    trigger_type: 'manual',
    triggered_by: null,
    status: 'success',
    engine_run_id: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    error: null,
    created_at: createdAt,
  };
}

function stubRuns(rows: RunRow[]) {
  const removed: string[] = [];
  const listOlderThan = vi.fn((cutoff: number) => rows.filter((r) => r.created_at < cutoff));
  const remove = vi.fn((id: string) => {
    removed.push(id);
    return true;
  });
  return {
    repo: {
      create: vi.fn(),
      findById: vi.fn(),
      listByWorkflow: vi.fn(),
      countByWorkflow: vi.fn(),
      listOlderThan,
      setEngineRunId: vi.fn(),
      markRunning: vi.fn(),
      finish: vi.fn(),
      remove,
    },
    listOlderThan,
    remove,
    removed,
  };
}

describe('pruneRuns', () => {
  it('删除超过保留期的运行并保留新运行', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const { repo, removed } = stubRuns([
      row('old', now - 100 * DAY_MS),
      row('edge', now - 89 * DAY_MS),
      row('fresh', now - 1 * DAY_MS),
    ]);
    const deps: RetentionDeps = { runs: repo as never, logRetentionDays: 90, now: () => now };

    expect(pruneRuns(deps)).toBe(1);
    expect(removed).toEqual(['old']);
  });

  it('按 logRetentionDays 计算截止时间', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    const { repo, listOlderThan } = stubRuns([]);
    const deps: RetentionDeps = { runs: repo as never, logRetentionDays: 30, now: () => now };

    pruneRuns(deps);
    expect(listOlderThan).toHaveBeenCalledWith(now - 30 * DAY_MS);
  });
});

describe('createRetention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('run 返回删除数量', () => {
    const now = Date.now();
    const { repo } = stubRuns([row('old', now - 100 * DAY_MS)]);
    const retention = createRetention({ runs: repo as never, logRetentionDays: 90, now: () => now });

    expect(retention.run()).toBe(1);
  });

  it('start 后按间隔触发清理', () => {
    const now = Date.now();
    const { repo, remove } = stubRuns([row('old', now - 100 * DAY_MS)]);
    const retention = createRetention({
      runs: repo as never,
      logRetentionDays: 90,
      now: () => now,
      intervalMs: 1000,
    });

    retention.start();
    vi.advanceTimersByTime(3000);
    expect(remove).toHaveBeenCalledTimes(3);
    retention.stop();
  });

  it('stop 后不再触发', () => {
    const now = Date.now();
    const { repo, remove } = stubRuns([row('old', now - 100 * DAY_MS)]);
    const retention = createRetention({
      runs: repo as never,
      logRetentionDays: 90,
      now: () => now,
      intervalMs: 1000,
    });

    retention.start();
    vi.advanceTimersByTime(1000);
    retention.stop();
    vi.advanceTimersByTime(5000);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('清理出错时交 onError 且不抛出', () => {
    const onError = vi.fn();
    const failing = { listOlderThan: () => { throw new Error('boom'); } };
    const retention = createRetention({
      runs: failing as never,
      logRetentionDays: 90,
      onError,
    });

    expect(() => retention.run()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/retention.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `retention.ts`**

Create `apps/server/src/modules/runs/retention.ts`：

```ts
import type { RunsRepo } from './repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 保留期清理依赖：运行仓储 + 保留天数 + 可注入时钟（测试用）。 */
export interface RetentionDeps {
  runs: RunsRepo;
  logRetentionDays: number;
  now?: () => number;
}

/**
 * 删除创建时间早于 `now - logRetentionDays` 的运行记录。
 * runs 表对 run_node_results / run_logs 均为 ON DELETE CASCADE，删除主记录即级联清理。
 * @returns 实际删除的运行条数
 */
export function pruneRuns(deps: RetentionDeps): number {
  const now = deps.now ?? Date.now;
  const cutoff = now() - deps.logRetentionDays * DAY_MS;
  const stale = deps.runs.listOlderThan(cutoff);
  let removed = 0;
  for (const run of stale) {
    if (deps.runs.remove(run.id)) removed += 1;
  }
  return removed;
}

/** 可运行的保留期清理器：手动 run 或按固定间隔 start。 */
export interface Retention {
  run(): number;
  start(intervalMs?: number): void;
  stop(): void;
}

export interface RetentionRuntimeDeps extends RetentionDeps {
  /** 默认 24h 触发一次 */
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

export function createRetention(deps: RetentionRuntimeDeps): Retention {
  let timer: NodeJS.Timeout | null = null;

  const run = (): number => {
    try {
      return pruneRuns(deps);
    } catch (err) {
      deps.onError?.(err);
      return 0;
    }
  };

  return {
    run,
    start(intervalMs = deps.intervalMs ?? DAY_MS) {
      if (timer) return;
      timer = setInterval(run, intervalMs);
      // 定时器不阻塞进程退出（与 Scheduler 一致）
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/retention.test.ts`
Expected: PASS（6 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/runs/retention.ts apps/server/test/retention.test.ts
git commit -m "feat: 新增运行日志保留期清理（级联删除过期运行）"
```

## Task 21: 系统设置（仓储 + 管理员设置路由）

**Files:**
- Create: `apps/server/src/modules/settings/repo.ts`
- Create: `apps/server/src/modules/settings/routes.ts`
- Modify: `apps/server/src/server.ts`（注册 `settingsRoutes`）
- Test: `apps/server/test/settings-repo.test.ts`
- Test: `apps/server/test/settings-routes.test.ts`

**Interfaces:**
- Consumes: `Database`、`AppConfig`（`maxConcurrentRuns`/`logRetentionDays`/`sharedDirs`/`tz`）、`UsersRepo`、`SessionsRepo`、`requireAuth`/`requireAdmin`（Task 6）、`settings` 表（Task 3 DDL：`key TEXT PRIMARY KEY, value TEXT NOT NULL`）。
- Produces:
  - `settingsRepo(db: Database): SettingsRepo`，`SettingsRepo = { get(key): string | null; all(): Record<string,string>; set(key,value): void; setMany(entries: Record<string,string>): void }`。
  - `readSettings(config: AppConfig, settings: SettingsRepo): AdminSettings`，`AdminSettings = { maxConcurrentRuns: number; logRetentionDays: number; sharedDirs: string[]; tz: string }`（DB 覆盖优先，缺省回退 `config`）。
  - `settingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): void`，端点 `GET/PUT /api/admin/settings`。
  - 设置以字符串存表：数值存十进制文本，`sharedDirs` 存 JSON 数组。生效方式：入口 `index.ts`（Task 25）启动时用 `readSettings` 覆盖 `config` 中对应字段。

- [ ] **Step 1: 写仓储测试（先失败）**

`apps/server/test/settings-repo.test.ts`
```ts
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { settingsRepo } from '../src/modules/settings/repo.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('settingsRepo', () => {
  it('set/get 往返，缺失返回 null', () => {
    const repo = settingsRepo(db);
    expect(repo.get('maxConcurrentRuns')).toBeNull();
    repo.set('maxConcurrentRuns', '4');
    expect(repo.get('maxConcurrentRuns')).toBe('4');
  });

  it('set 覆盖已存在键（upsert）', () => {
    const repo = settingsRepo(db);
    repo.set('tz', 'UTC');
    repo.set('tz', 'Asia/Shanghai');
    expect(repo.get('tz')).toBe('Asia/Shanghai');
  });

  it('all 返回全部键值', () => {
    const repo = settingsRepo(db);
    repo.set('a', '1');
    repo.set('b', '2');
    expect(repo.all()).toEqual({ a: '1', b: '2' });
  });

  it('setMany 原子写入多条', () => {
    const repo = settingsRepo(db);
    repo.setMany({ maxConcurrentRuns: '3', logRetentionDays: '30' });
    expect(repo.all()).toEqual({ maxConcurrentRuns: '3', logRetentionDays: '30' });
  });
});
```

- [ ] **Step 2: 运行仓储测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/settings-repo.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `settings/repo.ts`**

Create `apps/server/src/modules/settings/repo.ts`：

```ts
import type { Database } from 'better-sqlite3';

/** settings 表的键值访问；值统一为字符串，数值/数组由调用方序列化。 */
export interface SettingsRepo {
  get(key: string): string | null;
  all(): Record<string, string>;
  set(key: string, value: string): void;
  setMany(entries: Record<string, string>): void;
}

export function settingsRepo(db: Database): SettingsRepo {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const allStmt = db.prepare('SELECT key, value FROM settings');
  const upsertStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  return {
    get: (key) => (getStmt.get(key) as { value: string } | undefined)?.value ?? null,
    all: () => {
      const rows = allStmt.all() as Array<{ key: string; value: string }>;
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },
    set: (key, value) => {
      upsertStmt.run(key, value);
    },
    setMany: (entries) => {
      const tx = db.transaction((obj: Record<string, string>) => {
        for (const [k, v] of Object.entries(obj)) upsertStmt.run(k, v);
      });
      tx(entries);
    },
  };
}
```

- [ ] **Step 4: 运行仓储测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/settings-repo.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 5: 写路由测试（先失败）**

`apps/server/test/settings-routes.test.ts`
```ts
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { settingsRepo } from '../src/modules/settings/repo.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

let app: FastifyInstance;
let db: Database.Database;
let adminCookie: string;
let userCookie: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  userCookie = await login('alice', 'alice123');
});

describe('admin settings routes', () => {
  it('普通用户访问被拒 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: userCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('未登录返回 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET 缺省回退 config 默认值', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.maxConcurrentRuns).toBe(cfg.maxConcurrentRuns);
    expect(body.logRetentionDays).toBe(cfg.logRetentionDays);
    expect(body.tz).toBe(cfg.tz);
    expect(Array.isArray(body.sharedDirs)).toBe(true);
  });

  it('PUT 持久化并覆盖默认值', async () => {
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { maxConcurrentRuns: 5, logRetentionDays: 30, sharedDirs: ['/data/a'], tz: 'UTC' },
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as Record<string, unknown>).maxConcurrentRuns).toBe(5);

    const repo = settingsRepo(db);
    expect(repo.get('maxConcurrentRuns')).toBe('5');
    expect(JSON.parse(repo.get('sharedDirs')!)).toEqual(['/data/a']);

    const get = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    const body = get.json() as Record<string, unknown>;
    expect(body.sharedDirs).toEqual(['/data/a']);
    expect(body.tz).toBe('UTC');
  });

  it('PUT 校验失败返回 400', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie },
      payload: { maxConcurrentRuns: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
```

- [ ] **Step 6: 运行路由测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/settings-routes.test.ts`
Expected: FAIL（端点未注册 / 模块不存在）。

- [ ] **Step 7: 实现 `settings/routes.ts`**

Create `apps/server/src/modules/settings/routes.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { UsersRepo } from '../users/repo.js';
import type { SessionsRepo } from '../auth/sessions.js';
import { requireAuth, requireAdmin } from '../../plugins/guards.js';
import type { SettingsRepo } from './repo.js';

export interface AdminSettings {
  maxConcurrentRuns: number;
  logRetentionDays: number;
  sharedDirs: string[];
  tz: string;
}

export interface SettingsRoutesDeps {
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
  settings: SettingsRepo;
  /** 设置变更后回调（例如让调度器重读），可选 */
  onSettingsChanged?: () => void;
}

/** 合并 DB 覆盖与 config 默认值，得到对外暴露的系统设置视图。 */
export function readSettings(config: AppConfig, settings: SettingsRepo): AdminSettings {
  const raw = settings.all();
  const num = (key: string, fallback: number): number => {
    const v = raw[key];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  let sharedDirs = config.sharedDirs;
  if (raw.sharedDirs !== undefined) {
    try {
      const parsed = JSON.parse(raw.sharedDirs) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) sharedDirs = parsed;
    } catch {
      /* 保留默认 */
    }
  }
  return {
    maxConcurrentRuns: num('maxConcurrentRuns', config.maxConcurrentRuns),
    logRetentionDays: num('logRetentionDays', config.logRetentionDays),
    sharedDirs,
    tz: raw.tz ?? config.tz,
  };
}

const POSITIVE_INT_KEYS = ['maxConcurrentRuns', 'logRetentionDays'] as const;

export function settingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });

  app.get('/api/admin/settings', { preHandler: [auth, requireAdmin] }, async () =>
    readSettings(deps.config, deps.settings),
  );

  app.put('/api/admin/settings', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, string> = {};

    for (const key of POSITIVE_INT_KEYS) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        return reply.code(400).send({ error: 'invalid_settings', detail: `${key} 必须为正整数` });
      }
      updates[key] = String(value);
    }

    if (body.sharedDirs !== undefined) {
      const dirs = body.sharedDirs;
      if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string' && d.length > 0)) {
        return reply.code(400).send({ error: 'invalid_settings', detail: 'sharedDirs 必须为非空字符串数组' });
      }
      updates.sharedDirs = JSON.stringify(dirs);
    }

    if (body.tz !== undefined) {
      if (typeof body.tz !== 'string' || body.tz.trim() === '') {
        return reply.code(400).send({ error: 'invalid_settings', detail: 'tz 必须为非空字符串' });
      }
      updates.tz = body.tz;
    }

    if (Object.keys(updates).length > 0) {
      deps.settings.setMany(updates);
      deps.onSettingsChanged?.();
    }
    return readSettings(deps.config, deps.settings);
  });
}
```

> 说明：`requireAuth`/`requireAdmin` 来自 Task 6 `apps/server/src/plugins/guards.ts`（`userAdminRoutes` 亦从此导入，用法见 Task 7）；`SessionsRepo` 来自 `apps/server/src/modules/auth/sessions.ts`。

- [ ] **Step 8: 注册到 `server.ts`**

在 `buildServer` 内新增 `import { settingsRepo } from './modules/settings/repo.js';`、`import { settingsRoutes } from './modules/settings/routes.js';`，并在 `scheduleRoutes(...)` 之后追加：

```ts
  const settings = settingsRepo(deps.db);
  settingsRoutes(app, { config: deps.config, users, sessions, settings });
```

> 说明：若需要测试注入，可在 `AppOverrides` 增加 `settings?: SettingsRepo` 并按 `deps.overrides?.settings ?? settingsRepo(deps.db)` 取用；本任务默认直接用真实仓储（settings 无原生依赖）。

- [ ] **Step 9: 运行路由测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/settings-repo.test.ts test/settings-routes.test.ts`
Expected: PASS（4 + 5 passed）。

- [ ] **Step 10: 回归既有服务端测试并提交**

Run: `pnpm --filter @hustserver/server exec vitest run`
Expected: 全部 PASS。

```bash
git add apps/server/src/modules/settings/repo.ts apps/server/src/modules/settings/routes.ts apps/server/src/server.ts apps/server/test/settings-repo.test.ts apps/server/test/settings-routes.test.ts
git commit -m "feat: 新增系统设置仓储与管理员设置路由（并发/保留天数/共享目录/时区）"
```

## Task 22: 前端骨架（构建链 / API 客户端 / 认证 / 路由布局 / 登录页）

**Files:**
- Modify: `apps/web/package.json`（新增 `react-router-dom`、`tailwindcss`、`@tailwindcss/vite`；`build` 增加类型检查）
- Modify: `apps/web/vite.config.ts`（接入 Tailwind v4 插件）
- Create: `apps/web/src/index.css`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/auth.tsx`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/components/Layout.tsx`
- Create: `apps/web/src/pages/LoginPage.tsx`
- Create: `apps/web/src/pages/HomePage.tsx`
- Test: `apps/web/test/api.test.ts`

**Interfaces:**
- Consumes: 后端 `/api/auth/login`、`/api/auth/logout`、`/api/auth/me`（Task 6）。
- Produces:
  - `createApiClient(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }): ApiClient`，`ApiClient = { request<T>(method, path, opts?): Promise<T>; get; post; put; del }`；失败抛 `ApiClientError { status; code; detail? }`。请求统一 `credentials: 'include'`。
  - `ApiClient`、`ApiClientError`、`ApiClientOptions`、`SessionUser`、`ApiClient.request` 的 `RequestOptions = { body?: unknown; form?: FormData }`。
  - `AuthProvider`、`useAuth(): { user: SessionUser | null; loading: boolean; login(u,p): Promise<void>; logout(): Promise<void>; refresh(): Promise<void> }`、`RequireAuth`。
  - `Layout`（顶部导航 + 退出）、`LoginPage`、`HomePage`。
  - 后续任务：Task 23 在此基础新增工作流页面与路由；Task 24 新增运行/连接/用户/设置页面与路由。

- [ ] **Step 1: 更新 `apps/web` 依赖与构建脚本**

Modify `apps/web/package.json`（在 Task 1 基础上）：

```json
{
  "name": "@hustserver/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json && vite build",
    "dev": "vite",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.1"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.3",
    "vite": "^6.0.5"
  }
}
```

Run: `pnpm install`

- [ ] **Step 2: 接入 Tailwind v4 插件**

Modify `apps/web/vite.config.ts`：

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
```

Create `apps/web/src/index.css`：

```css
@import "tailwindcss";
```

- [ ] **Step 3: 写 API 客户端测试（先失败）**

`apps/web/test/api.test.ts`
```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient } from '../src/api.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient', () => {
  it('GET 返回解析后的 JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'u1', role: 'admin' })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: 'http://x', fetchImpl });

    await expect(api.get('/api/auth/me')).resolves.toEqual({ id: 'u1', role: 'admin' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x/api/auth/me');
    expect(init.credentials).toBe('include');
  });

  it('POST 发送 JSON 请求体', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });

    await api.post('/api/auth/login', { body: { username: 'a', password: 'b' } });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ username: 'a', password: 'b' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('FormData 上传不设置 content-type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: 'w1' })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });
    const form = new FormData();
    form.append('file', 'x');

    await api.post('/api/workflows', { form });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('非 2xx 抛出带 status/code 的 ApiClientError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'forbidden' })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });

    await expect(api.get('/api/admin/users')).rejects.toBeInstanceOf(ApiClientError);
    await api.get('/api/admin/users').catch((err: ApiClientError) => {
      expect(err.status).toBe(403);
      expect(err.code).toBe('forbidden');
    });
  });

  it('204 返回 undefined', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });
    await expect(api.del('/api/schedules/s1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm exec vitest run apps/web/test/api.test.ts`
Expected: FAIL（`../src/api.js` 不存在）。

- [ ] **Step 5: 实现 `api.ts`**

Create `apps/web/src/api.ts`：

```ts
export interface SessionUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface RequestOptions {
  body?: unknown;
  form?: FormData;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, detail?: string) {
    super(`${status} ${code}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface ApiClient {
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, opts?: RequestOptions): Promise<T>;
  put<T>(path: string, opts?: RequestOptions): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? '';
  const doFetch = opts.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;
    if (options.form) {
      body = options.form; // 浏览器自动带 multipart 边界，勿手动设置 content-type
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const res = await doFetch(baseUrl + path, { method, headers, body, credentials: 'include' });
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const payload = (data ?? {}) as { error?: string; detail?: string };
      throw new ApiClientError(res.status, payload.error ?? 'request_failed', payload.detail);
    }
    return data as T;
  }

  return {
    request,
    get: (path) => request('GET', path),
    post: (path, options) => request('POST', path, options),
    put: (path, options) => request('PUT', path, options),
    del: (path) => request('DELETE', path),
  };
}

/** 全局默认客户端（同源部署，浏览器 Cookie 自动携带）。 */
export const api = createApiClient();
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm exec vitest run apps/web/test/api.test.ts`
Expected: PASS（5 passed）。

- [ ] **Step 7: 实现认证上下文 `auth.tsx`**

Create `apps/web/src/auth.tsx`：

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, type SessionUser } from './api.js';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<SessionUser>('/api/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const me = await api.post<SessionUser>('/api/auth/login', { body: { username, password } });
    setUser(me);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout');
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-6 text-slate-500">加载中…</div>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}
```

- [ ] **Step 8: 实现布局、登录页与首页**

Create `apps/web/src/components/Layout.tsx`：

```tsx
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1.5 rounded ${isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`;

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="flex items-center gap-4 border-b bg-white px-6 py-3">
        <span className="font-semibold">HUSTServer</span>
        <nav className="flex items-center gap-1 text-sm">
          <NavLink to="/workflows" className={linkClass}>工作流</NavLink>
          <NavLink to="/connections" className={linkClass}>连接</NavLink>
          {user?.role === 'admin' && (
            <>
              <NavLink to="/users" className={linkClass}>用户</NavLink>
              <NavLink to="/settings" className={linkClass}>设置</NavLink>
            </>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-slate-500">{user?.username}（{user?.role === 'admin' ? '管理员' : '普通用户'}）</span>
          <button
            className="rounded border px-3 py-1 text-slate-600 hover:bg-slate-100"
            onClick={() => void logout().then(() => navigate('/login'))}
          >
            退出
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

Create `apps/web/src/pages/LoginPage.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.js';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/workflows" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate('/workflows', { replace: true });
    } catch {
      setError('用户名或密码错误');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <form onSubmit={onSubmit} className="w-80 space-y-4 rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold">登录 HUSTServer</h1>
        <label className="block text-sm">
          用户名
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="block text-sm">
          密码
          <input
            type="password"
            className="mt-1 w-full rounded border px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-60"
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
```

Create `apps/web/src/pages/HomePage.tsx`：

```tsx
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';

export function HomePage() {
  const { user } = useAuth();
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">欢迎，{user?.username}</h1>
      <p className="text-slate-600">请从左侧导航进入 <Link className="text-blue-600 underline" to="/workflows">工作流</Link>。</p>
    </div>
  );
}
```

- [ ] **Step 9: 实现 `App.tsx` 与 `main.tsx`**

Create `apps/web/src/App.tsx`：

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.js';
import { Layout } from './components/Layout.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<HomePage />} />
            {/* Task 23/24 在此追加工作流 / 运行 / 连接 / 用户 / 设置路由 */}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

Create `apps/web/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 10: 类型检查并构建**

Run: `pnpm --filter @hustserver/web build`
Expected: 成功（`tsc` 无错误，`vite build` 产出 `dist/`）。

- [ ] **Step 11: 提交**

```bash
git add apps/web/package.json apps/web/vite.config.ts apps/web/src apps/web/test/api.test.ts pnpm-lock.yaml
git commit -m "feat(web): 前端骨架（Tailwind/路由/API 客户端/认证上下文/登录页）"
```

---

## Task 23: 前端工作流页面（列表 / 上传绑定 / 详情）

**Files:**
- Create: `apps/web/src/types.ts`
- Create: `apps/web/src/workflowMappings.ts`
- Test: `apps/web/test/workflow-mappings.test.ts`
- Create: `apps/web/src/pages/WorkflowListPage.tsx`
- Create: `apps/web/src/pages/WorkflowUploadPage.tsx`
- Create: `apps/web/src/pages/WorkflowDetailPage.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `api`/`ApiClientError`（`apps/web/src/api.ts`，Task 22）、`useAuth`（`apps/web/src/auth.tsx`，Task 22）、工作流端点（Task 11：`POST /api/workflows/upload`、`POST /api/workflows`、`GET /api/workflows`、`GET /api/workflows/:id`、`DELETE /api/workflows/:id`、`POST /api/workflows/:id/files`、`POST /api/workflows/:id/runs`、`GET /api/workflows/:id/runs`）、连接列表端点（Task 12：`GET /api/connections`）
- Produces:
  - `types.ts`：`InputRef`、`OutputRef`、`WorkflowSummary`、`WorkflowFileRow`、`MappingTargetType`、`PathMappingRow`、`WorkflowDetail`、`RunSummary`
  - `workflowMappings.ts`：`interface MappingDraft`、`interface InputBinding`、`buildMappingInputs(inputs, outputs, bindings): MappingDraft[]`
  - 页面组件：`WorkflowListPage`、`WorkflowUploadPage`、`WorkflowDetailPage`
- 复用规则：前端提交的 mappings **不带 `workflow_id`**（服务端 `POST /api/workflows` 会回填）；`input` 绑定的四种 `target_type` 语义见 Task 10 mapper：`uploaded_file`→`stored_name`、`server_path`→绝对路径、`connection`→`connectionId`；`output` 一律 `output_dir` + `target_ref: null`。

- [ ] **Step 1: 定义前端 DTO 类型**

Create `apps/web/src/types.ts`：

```ts
/** 与后端 parse.ts 的 InputRef/OutputRef 对齐（kind 在前端不做穷举，用 string）。 */
export interface InputRef {
  nodeId: string;
  name: string;
  kind: string;
  originalRef: string;
  binding: 'file' | 'connection';
}

export interface OutputRef {
  nodeId: string;
  name: string;
  kind: string;
  originalRef: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  owner_id: string;
  updated_at: number;
}

export interface WorkflowFileRow {
  id: string;
  workflow_id: string;
  node_id: string | null;
  original_ref: string;
  stored_name: string;
  size: number;
  created_at: number;
}

export type MappingTargetType = 'uploaded_file' | 'server_path' | 'connection' | 'output_dir';

export interface PathMappingRow {
  id: string;
  workflow_id: string;
  node_id: string;
  direction: 'input' | 'output';
  original_ref: string;
  target_type: MappingTargetType;
  target_ref: string | null;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  owner_id: string;
  workflow: unknown;
  files: WorkflowFileRow[];
  mappings: PathMappingRow[];
  updated_at: number;
}

export interface RunSummary {
  id: string;
  workflow_id: string;
  schedule_id: string | null;
  trigger_type: string;
  status: string;
  engine_run_id: string | null;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: number;
}
```

- [ ] **Step 2: 写映射构造的失败测试**

`apps/web/test/workflow-mappings.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { buildMappingInputs } from '../src/workflowMappings.js';
import type { InputRef, OutputRef } from '../src/types.js';

const inputs: InputRef[] = [
  { nodeId: 'n1', name: '读取订单', kind: 'inputCsv', originalRef: '/Users/me/a.csv', binding: 'file' },
  { nodeId: 'n2', name: '读库', kind: 'inputSqlServer', originalRef: 'db:1433/d', binding: 'connection' },
];
const outputs: OutputRef[] = [
  { nodeId: 'n3', name: '导出', kind: 'outputCsv', originalRef: '/Users/me/out.csv' },
];

describe('buildMappingInputs', () => {
  it('上传文件与连接分别生成正确 target，输出固定为 output_dir', () => {
    const drafts = buildMappingInputs(inputs, outputs, {
      n1: { targetType: 'uploaded_file', targetRef: '171_a.csv' },
      n2: { targetType: 'connection', targetRef: 'conn1' },
    });
    expect(drafts).toEqual([
      { node_id: 'n1', direction: 'input', original_ref: '/Users/me/a.csv', target_type: 'uploaded_file', target_ref: '171_a.csv' },
      { node_id: 'n2', direction: 'input', original_ref: 'db:1433/d', target_type: 'connection', target_ref: 'conn1' },
      { node_id: 'n3', direction: 'output', original_ref: '/Users/me/out.csv', target_type: 'output_dir', target_ref: null },
    ]);
  });

  it('server_path 绑定使用服务端绝对路径', () => {
    const drafts = buildMappingInputs(inputs, [], {
      n1: { targetType: 'server_path', targetRef: '/srv/data/a.csv' },
    });
    expect(drafts[0]).toMatchObject({ target_type: 'server_path', target_ref: '/srv/data/a.csv' });
  });

  it('未绑定或绑定为空的输入被跳过，不产生不完整映射', () => {
    const drafts = buildMappingInputs(inputs, [], {
      n1: { targetType: 'uploaded_file', targetRef: '   ' },
    });
    expect(drafts).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run apps/web/test/workflow-mappings.test.ts`
Expected: FAIL（`../src/workflowMappings.js` 不存在）。

- [ ] **Step 4: 实现 `workflowMappings.ts` 并通过测试**

Create `apps/web/src/workflowMappings.ts`：

```ts
import type { InputRef, MappingTargetType, OutputRef } from './types.js';

/** 提交给 POST /api/workflows 的映射草稿（不含 workflow_id，服务端回填）。 */
export interface MappingDraft {
  node_id: string;
  direction: 'input' | 'output';
  original_ref: string;
  target_type: MappingTargetType;
  target_ref: string | null;
}

export interface InputBinding {
  targetType: 'uploaded_file' | 'server_path' | 'connection';
  /** 文件绑定存 stored_name；服务端路径存绝对路径；连接存 connectionId。 */
  targetRef: string;
}

/**
 * 依据解析出的输入/输出引用与用户绑定，生成提交给后端的 mappings：
 * - 输入：有非空 targetRef 才生成；target_type 取用户选择。
 * - 输出：一律 output_dir + target_ref: null（落到服务端 output 目录）。
 */
export function buildMappingInputs(
  inputs: InputRef[],
  outputs: OutputRef[],
  bindings: Record<string, InputBinding>,
): MappingDraft[] {
  const drafts: MappingDraft[] = [];
  for (const input of inputs) {
    const binding = bindings[input.nodeId];
    if (!binding || !binding.targetRef.trim()) continue;
    drafts.push({
      node_id: input.nodeId,
      direction: 'input',
      original_ref: input.originalRef,
      target_type: binding.targetType,
      target_ref: binding.targetRef,
    });
  }
  for (const output of outputs) {
    drafts.push({
      node_id: output.nodeId,
      direction: 'output',
      original_ref: output.originalRef,
      target_type: 'output_dir',
      target_ref: null,
    });
  }
  return drafts;
}
```

Run: `pnpm exec vitest run apps/web/test/workflow-mappings.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: 实现工作流列表页**

Create `apps/web/src/pages/WorkflowListPage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import type { WorkflowSummary } from '../types.js';

export function WorkflowListPage() {
  const [items, setItems] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.get<WorkflowSummary[]>('/api/workflows'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string, name: string) {
    if (!window.confirm(`确定删除工作流「${name}」？其运行记录将一并删除。`)) return;
    await api.del(`/api/workflows/${id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">工作流</h1>
        <Link className="rounded bg-blue-600 px-3 py-1.5 text-white" to="/workflows/new">
          上传工作流
        </Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">更新时间</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => (
            <tr key={w.id} className="border-t">
              <td className="p-2">
                <Link className="text-blue-600 underline" to={`/workflows/${w.id}`}>
                  {w.name}
                </Link>
              </td>
              <td className="p-2">{new Date(w.updated_at).toLocaleString()}</td>
              <td className="p-2">
                <button className="text-red-600" onClick={() => void remove(w.id, w.name)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={3}>
                暂无工作流，点击右上角「上传工作流」。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: 实现上传绑定页**

Create `apps/web/src/pages/WorkflowUploadPage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import type { InputRef, OutputRef } from '../types.js';
import { buildMappingInputs, type InputBinding } from '../workflowMappings.js';

interface ParsedUpload {
  name: string;
  workflow: unknown;
  inputs: InputRef[];
  outputs: OutputRef[];
}

interface ConnectionOption {
  id: string;
  name: string;
}

export function WorkflowUploadPage() {
  const navigate = useNavigate();
  const [parsed, setParsed] = useState<ParsedUpload | null>(null);
  const [name, setName] = useState('');
  const [bindings, setBindings] = useState<Record<string, InputBinding>>({});
  const [dataFiles, setDataFiles] = useState<Record<string, File>>({});
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<ConnectionOption[]>('/api/connections')
      .then(setConnections)
      .catch(() => undefined);
  }, []);

  async function parseJson(file: File) {
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await api.post<ParsedUpload>('/api/workflows/upload', { form });
      setParsed(res);
      setName(res.name);
      const initial: Record<string, InputBinding> = {};
      for (const input of res.inputs) {
        initial[input.nodeId] =
          input.binding === 'connection'
            ? { targetType: 'connection', targetRef: connections[0]?.id ?? '' }
            : { targetType: 'server_path', targetRef: input.originalRef };
      }
      setBindings(initial);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function setBinding(nodeId: string, patch: Partial<InputBinding>) {
    setBindings((prev) => ({ ...prev, [nodeId]: { ...prev[nodeId], ...patch } }));
  }

  async function submit() {
    if (!parsed) return;
    for (const input of parsed.inputs) {
      const binding = bindings[input.nodeId];
      if (binding?.targetType === 'uploaded_file' && !dataFiles[input.nodeId]) {
        setError(`输入「${input.name}」选择了上传数据文件，但未选择文件。`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const nonFileInputs = parsed.inputs.filter((i) => bindings[i.nodeId]?.targetType !== 'uploaded_file');
      const created = await api.post<{ id: string; name: string }>('/api/workflows', {
        body: {
          name: name.trim() || parsed.name,
          workflow: parsed.workflow,
          mappings: buildMappingInputs(nonFileInputs, parsed.outputs, bindings),
        },
      });
      for (const input of parsed.inputs) {
        const file = dataFiles[input.nodeId];
        if (bindings[input.nodeId]?.targetType !== 'uploaded_file' || !file) continue;
        const form = new FormData();
        form.append('nodeId', input.nodeId);
        form.append('file', file);
        await api.post(`/api/workflows/${created.id}/files`, { form });
      }
      navigate(`/workflows/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!parsed) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">上传工作流</h1>
        <p className="text-sm text-slate-600">选择 HUSTERYX 导出的工作流 JSON 文件（.json）。</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void parseJson(file);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">配置输入绑定</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <label className="block space-y-1">
        <span className="text-sm text-slate-600">工作流名称</span>
        <input className="w-full border px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <section className="space-y-2">
        <h2 className="font-medium">输入</h2>
        {parsed.inputs.length === 0 && <p className="text-sm text-slate-500">该工作流无输入节点。</p>}
        {parsed.inputs.map((input) => {
          const binding = bindings[input.nodeId];
          return (
            <div key={input.nodeId} className="space-y-2 rounded border p-3">
              <div className="text-sm">
                <span className="font-medium">{input.name}</span>
                <span className="ml-2 text-slate-500">{input.originalRef}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={binding?.targetType === 'uploaded_file'}
                    onChange={() => setBinding(input.nodeId, { targetType: 'uploaded_file', targetRef: '' })}
                  />
                  上传数据文件
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={binding?.targetType === 'server_path'}
                    onChange={() => setBinding(input.nodeId, { targetType: 'server_path', targetRef: input.originalRef })}
                  />
                  服务端路径
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    checked={binding?.targetType === 'connection'}
                    onChange={() => setBinding(input.nodeId, { targetType: 'connection', targetRef: connections[0]?.id ?? '' })}
                  />
                  连接
                </label>
              </div>

              {binding?.targetType === 'server_path' && (
                <input
                  className="w-full border px-2 py-1 text-sm"
                  placeholder="/absolute/path/data.csv"
                  value={binding.targetRef}
                  onChange={(e) => setBinding(input.nodeId, { targetRef: e.target.value })}
                />
              )}

              {binding?.targetType === 'connection' && (
                <select
                  className="w-full border px-2 py-1 text-sm"
                  value={binding.targetRef}
                  onChange={(e) => setBinding(input.nodeId, { targetRef: e.target.value })}
                >
                  <option value="">请选择连接…</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}

              {binding?.targetType === 'uploaded_file' && (
                <input
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setDataFiles((prev) => ({ ...prev, [input.nodeId]: file }));
                  }}
                />
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-1">
        <h2 className="font-medium">输出</h2>
        {parsed.outputs.length === 0 && <p className="text-sm text-slate-500">该工作流无输出节点。</p>}
        {parsed.outputs.map((output) => (
          <p key={output.nodeId} className="text-sm text-slate-600">
            {output.name} → 运行结果写入服务端输出目录（{output.originalRef} 的文件名）
          </p>
        ))}
      </section>

      <button
        className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? '提交中…' : '创建工作流'}
      </button>
    </div>
  );
}
```

- [ ] **Step 7: 实现工作流详情页**

Create `apps/web/src/pages/WorkflowDetailPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { MappingTargetType, RunSummary, WorkflowDetail } from '../types.js';

const TARGET_LABEL: Record<MappingTargetType, string> = {
  uploaded_file: '上传的数据文件',
  server_path: '服务端路径',
  connection: '连接',
  output_dir: '服务端输出目录',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  success: '成功',
  failed: '失败',
};

export function WorkflowDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, r] = await Promise.all([
        api.get<WorkflowDetail>(`/api/workflows/${id}`),
        api.get<{ items: RunSummary[] }>(`/api/workflows/${id}/runs?limit=20`),
      ]);
      setDetail(d);
      setRuns(r.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    setBusy(true);
    try {
      const res = await api.post<{ runId: string }>(`/api/workflows/${id}/runs`);
      navigate(`/runs/${res.runId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadData(nodeId: string, file: File) {
    const form = new FormData();
    form.append('nodeId', nodeId);
    form.append('file', file);
    try {
      await api.post(`/api/workflows/${id}/files`, { form });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error && !detail) return <p className="text-sm text-red-600">{error}</p>;
  if (!detail) return <p className="text-sm text-slate-500">加载中…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{detail.name}</h1>
        <button
          className="rounded bg-green-600 px-4 py-1.5 text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void runNow()}
        >
          {busy ? '提交中…' : '立即运行'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2">
        <h2 className="font-medium">输入绑定</h2>
        {detail.mappings.filter((m) => m.direction === 'input').length === 0 && (
          <p className="text-sm text-slate-500">无输入绑定。</p>
        )}
        {detail.mappings
          .filter((m) => m.direction === 'input')
          .map((m) => {
            const file = detail.files.find((f) => f.node_id === m.node_id);
            return (
              <div key={m.node_id} className="space-y-1 rounded border p-3 text-sm">
                <div>
                  <span className="text-slate-500">{m.original_ref}</span>
                  <span className="mx-2">→</span>
                  <span className="font-medium">{TARGET_LABEL[m.target_type]}</span>
                  {m.target_type === 'uploaded_file' && file && (
                    <span className="ml-2 text-slate-500">
                      {file.stored_name}（{file.size} 字节）
                    </span>
                  )}
                  {m.target_type !== 'uploaded_file' && m.target_ref && (
                    <span className="ml-2 text-slate-500">{m.target_ref}</span>
                  )}
                </div>
                <label className="block text-slate-600">
                  重新上传数据文件：
                  <input
                    className="ml-2"
                    type="file"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadData(m.node_id, f);
                    }}
                  />
                </label>
              </div>
            );
          })}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">输出</h2>
        {detail.mappings.filter((m) => m.direction === 'output').length === 0 && (
          <p className="text-sm text-slate-500">无输出绑定。</p>
        )}
        {detail.mappings
          .filter((m) => m.direction === 'output')
          .map((m) => (
            <p key={m.node_id} className="text-sm text-slate-600">
              {m.original_ref} → {TARGET_LABEL[m.target_type]}
            </p>
          ))}
      </section>

      {/* Task 24: 在此插入 <ScheduleSection workflowId={id} /> */}

      <section className="space-y-2">
        <h2 className="font-medium">运行历史</h2>
        <table className="w-full border text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">时间</th>
              <th className="p-2">触发</th>
              <th className="p-2">状态</th>
              <th className="p-2">耗时</th>
              <th className="p-2">详情</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} className="border-t">
                <td className="p-2">{new Date(run.created_at).toLocaleString()}</td>
                <td className="p-2">{run.trigger_type}</td>
                <td className="p-2">{STATUS_LABEL[run.status] ?? run.status}</td>
                <td className="p-2">{run.duration_ms != null ? `${run.duration_ms} ms` : '-'}</td>
                <td className="p-2">
                  <Link className="text-blue-600 underline" to={`/runs/${run.id}`}>
                    查看日志
                  </Link>
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td className="p-2 text-slate-500" colSpan={5}>
                  暂无运行记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 8: 在 `App.tsx` 追加路由**

Modify `apps/web/src/App.tsx`（完整替换为以下内容）：

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.js';
import { Layout } from './components/Layout.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { WorkflowDetailPage } from './pages/WorkflowDetailPage.js';
import { WorkflowListPage } from './pages/WorkflowListPage.js';
import { WorkflowUploadPage } from './pages/WorkflowUploadPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<HomePage />} />
            <Route path="/workflows" element={<WorkflowListPage />} />
            <Route path="/workflows/new" element={<WorkflowUploadPage />} />
            <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
            {/* Task 24 在此追加 运行详情 / 连接 / 用户 / 设置 路由 */}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 9: 类型检查并构建**

Run: `pnpm --filter @hustserver/web build`
Expected: 成功（`tsc` 无错误，`vite build` 产出 `dist/`）。

- [ ] **Step 10: 提交**

```bash
git add apps/web/src/types.ts apps/web/src/workflowMappings.ts apps/web/src/pages apps/web/src/App.tsx apps/web/test/workflow-mappings.test.ts
git commit -m "feat(web): 工作流列表/上传绑定/详情页面与路由"
```

---

## Task 24: 前端运行/调度/连接/用户/设置页面

**Files:**
- Create: `apps/web/src/pages/RunDetailPage.tsx`
- Create: `apps/web/src/components/ScheduleSection.tsx`
- Create: `apps/web/src/pages/ConnectionsPage.tsx`
- Create: `apps/web/src/pages/UsersPage.tsx`
- Create: `apps/web/src/pages/SettingsPage.tsx`
- Modify: `apps/web/src/pages/WorkflowDetailPage.tsx`（插入调度区）
- Modify: `apps/web/src/App.tsx`（追加路由）

**Interfaces:**
- Consumes:
  - `api`/`ApiClientError`（`apps/web/src/api.ts`，Task 22）、`useAuth`（`apps/web/src/auth.tsx`，Task 22）、`types.ts` 的 `RunSummary`（Task 23）
  - 运行端点（Task 16）：`GET /api/runs/:runId` → `{ run, nodes }`；`GET /api/runs/:runId/logs?after=&limit=` → `{ items: [{ id, ts, level, node_id, message }] }`；SSE `GET /api/runs/:runId/events`（事件名 `log`/`node-result`/`run-status`/`done`）
  - 调度端点（Task 19）：`GET|POST /api/workflows/:id/schedules`、`PUT|DELETE /api/schedules/:id`（`GET` 每项含 `nextRunAt`）
  - 连接端点（Task 12）：`GET|POST /api/connections`、`PUT|DELETE /api/connections/:id`、`POST /api/connections/:id/test` → `{ ok, error? }`
  - 用户管理端点（Task 7）：`GET|POST /api/admin/users`、`PUT /api/admin/users/:id`、`POST /api/admin/users/:id/reset-password`、`DELETE /api/admin/users/:id`
  - 设置端点（Task 21）：`GET|PUT /api/admin/settings`
- Produces: 页面组件 `RunDetailPage`、`ConnectionsPage`、`UsersPage`、`SettingsPage`；组件 `ScheduleSection`。
- 路由约定：与 `Layout.tsx`（Task 22）已有导航保持一致 —— `/runs/:id`、`/connections`、`/users`、`/settings`（**前端路由名与后端 `/api/admin/*` 路径无关**，请勿改成 `/admin/users`，否则导航高亮失效）。管理员专属页面自行兜底：`user?.role !== 'admin'` 时渲染「无权访问」。

- [ ] **Step 1: 实现运行详情页（SSE 实时日志 + 节点结果）**

Create `apps/web/src/pages/RunDetailPage.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import type { RunSummary } from '../types.js';

interface RunNodeResult {
  id: number;
  run_id: string;
  node_id: string;
  name: string | null;
  kind: string | null;
  status: string;
  row_count: number | null;
  duration_ms: number | null;
  error: string | null;
  updated_at: number;
}

interface LogItem {
  id: number;
  ts: number;
  level: string;
  node_id: string | null;
  message: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  success: '成功',
  failed: '失败',
};

export function RunDetailPage() {
  const { id = '' } = useParams();
  const [run, setRun] = useState<RunSummary | null>(null);
  const [nodes, setNodes] = useState<RunNodeResult[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // SSE 的 log 事件无自增 id，前端用本地计数器生成稳定 key
  const nextLogId = useRef(0);

  const loadSnapshot = useCallback(async () => {
    try {
      const [detail, logRes] = await Promise.all([
        api.get<{ run: RunSummary; nodes: RunNodeResult[] }>(`/api/runs/${id}`),
        api.get<{ items: LogItem[] }>(`/api/runs/${id}/logs?limit=1000`),
      ]);
      setRun(detail.run);
      setNodes(detail.nodes);
      setLogs(logRes.items);
      nextLogId.current = logRes.items.reduce((max, l) => Math.max(max, l.id), 0) + 1;
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  const refreshDetail = useCallback(async () => {
    try {
      const detail = await api.get<{ run: RunSummary; nodes: RunNodeResult[] }>(`/api/runs/${id}`);
      setRun(detail.run);
      setNodes(detail.nodes);
    } catch {
      /* 忽略瞬时错误，done 时会再拉一次完整快照 */
    }
  }, [id]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  // 无论运行是否已结束都订阅：已结束时服务端立即下发 done 并关闭连接。
  useEffect(() => {
    const es = new EventSource(`/api/runs/${id}/events`);
    setLive(true);

    es.addEventListener('log', (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as {
        level: string;
        nodeId?: string;
        message: string;
        ts: number;
      };
      setLogs((prev) => [
        ...prev,
        { id: nextLogId.current++, ts: e.ts, level: e.level, node_id: e.nodeId ?? null, message: e.message },
      ]);
    });
    // node-result / run-status 的具体字段由引擎定义，直接回拉快照最稳妥
    es.addEventListener('node-result', () => void refreshDetail());
    es.addEventListener('run-status', () => void refreshDetail());
    es.addEventListener('done', () => {
      setLive(false);
      es.close();
      void loadSnapshot();
    });
    es.onerror = () => {
      setLive(false);
      es.close();
    };

    return () => es.close();
  }, [id, loadSnapshot, refreshDetail]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">运行详情</h1>
        <span className="text-sm text-slate-500">
          {run ? STATUS_LABEL[run.status] ?? run.status : '加载中…'}
        </span>
        {live && <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">实时</span>}
        <Link className="ml-auto text-sm text-blue-600 underline" to={`/workflows/${run?.workflow_id ?? ''}`}>
          返回工作流
        </Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {run?.error && <p className="text-sm text-red-600">错误：{run.error}</p>}

      <section className="space-y-2">
        <h2 className="font-medium">节点结果</h2>
        <table className="w-full border text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">节点</th>
              <th className="p-2">类型</th>
              <th className="p-2">状态</th>
              <th className="p-2">行数</th>
              <th className="p-2">耗时</th>
              <th className="p-2">错误</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.node_id} className="border-t">
                <td className="p-2">{n.name ?? n.node_id}</td>
                <td className="p-2 text-slate-500">{n.kind ?? '-'}</td>
                <td className="p-2">{STATUS_LABEL[n.status] ?? n.status}</td>
                <td className="p-2">{n.row_count ?? '-'}</td>
                <td className="p-2">{n.duration_ms != null ? `${n.duration_ms} ms` : '-'}</td>
                <td className="p-2 text-red-600">{n.error ?? ''}</td>
              </tr>
            ))}
            {nodes.length === 0 && (
              <tr>
                <td className="p-2 text-slate-500" colSpan={6}>暂无节点结果。</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">日志</h2>
        <div className="max-h-96 overflow-auto rounded border bg-slate-900 p-3 font-mono text-xs text-slate-100">
          {logs.map((l) => (
            <div key={l.id}>
              <span className="text-slate-400">[{new Date(l.ts).toLocaleTimeString()}]</span>{' '}
              <span className={l.level === 'error' ? 'text-red-400' : 'text-slate-300'}>{l.level}</span>{' '}
              {l.node_id && <span className="text-blue-300">{l.node_id} </span>}
              <span>{l.message}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="text-slate-500">暂无日志。</div>}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: 实现调度区组件**

Create `apps/web/src/components/ScheduleSection.tsx`：

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';

type FreqType = 'daily' | 'weekly' | 'monthly' | 'cron';

interface ScheduleRow {
  id: string;
  workflow_id: string;
  enabled: number;
  freq_type: FreqType;
  cron_expr: string;
  timezone: string;
  created_at: number;
  updated_at: number;
  nextRunAt: number | null;
}

const FREQ_LABEL: Record<FreqType, string> = {
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  cron: 'Cron 表达式',
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function ScheduleSection({ workflowId }: { workflowId: string }) {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [freqType, setFreqType] = useState<FreqType>('daily');
  const [time, setTime] = useState('08:00');
  const [weekday, setWeekday] = useState(1);
  const [monthDay, setMonthDay] = useState(1);
  const [cronExpr, setCronExpr] = useState('0 8 * * *');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ items: ScheduleRow[] }>(`/api/workflows/${workflowId}/schedules`);
      setRows(res.items);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/workflows/${workflowId}/schedules`, {
        body: { freqType, time, weekday, monthDay, cronExpr, timezone, enabled: true },
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: ScheduleRow) {
    try {
      await api.put(`/api/schedules/${row.id}`, { body: { enabled: row.enabled !== 1 } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(row: ScheduleRow) {
    if (!window.confirm('确认删除该调度？')) return;
    try {
      await api.del(`/api/schedules/${row.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-medium">运行周期</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">频率</th>
            <th className="p-2">Cron</th>
            <th className="p-2">时区</th>
            <th className="p-2">下次运行</th>
            <th className="p-2">状态</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">{FREQ_LABEL[row.freq_type]}</td>
              <td className="p-2 font-mono">{row.cron_expr}</td>
              <td className="p-2">{row.timezone}</td>
              <td className="p-2">{row.nextRunAt ? new Date(row.nextRunAt).toLocaleString() : '-'}</td>
              <td className="p-2">{row.enabled === 1 ? '启用' : '停用'}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600 underline" onClick={() => void toggle(row)}>
                  {row.enabled === 1 ? '停用' : '启用'}
                </button>
                <button className="text-red-600 underline" onClick={() => void remove(row)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={6}>暂无调度。</td>
            </tr>
          )}
        </tbody>
      </table>

      <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded border p-3 text-sm">
        <label className="block">
          频率
          <select
            className="mt-1 block rounded border px-2 py-1"
            value={freqType}
            onChange={(e) => setFreqType(e.target.value as FreqType)}
          >
            {(Object.keys(FREQ_LABEL) as FreqType[]).map((f) => (
              <option key={f} value={f}>{FREQ_LABEL[f]}</option>
            ))}
          </select>
        </label>
        {freqType !== 'cron' && (
          <label className="block">
            时间
            <input
              type="time"
              className="mt-1 block rounded border px-2 py-1"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
            />
          </label>
        )}
        {freqType === 'weekly' && (
          <label className="block">
            星期
            <select
              className="mt-1 block rounded border px-2 py-1"
              value={weekday}
              onChange={(e) => setWeekday(Number(e.target.value))}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={i} value={i}>{d}</option>
              ))}
            </select>
          </label>
        )}
        {freqType === 'monthly' && (
          <label className="block">
            日期
            <input
              type="number"
              min={1}
              max={31}
              className="mt-1 block w-20 rounded border px-2 py-1"
              value={monthDay}
              onChange={(e) => setMonthDay(Number(e.target.value))}
            />
          </label>
        )}
        {freqType === 'cron' && (
          <label className="block">
            Cron 表达式
            <input
              className="mt-1 block rounded border px-2 py-1 font-mono"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              required
            />
          </label>
        )}
        <label className="block">
          时区
          <input
            className="mt-1 block rounded border px-2 py-1"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? '保存中…' : '新增调度'}
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 3: 在工作流详情页插入调度区**

Modify `apps/web/src/pages/WorkflowDetailPage.tsx`：

1) 在顶部 import 区追加：

```tsx
import { ScheduleSection } from '../components/ScheduleSection.js';
```

2) 将占位注释 `{/* Task 24: 在此插入 <ScheduleSection workflowId={id} /> */}` 替换为：

```tsx
      <ScheduleSection workflowId={id} />
```

- [ ] **Step 4: 实现连接管理页**

Create `apps/web/src/pages/ConnectionsPage.tsx`：

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';

interface ConnectionDto {
  id: string;
  name: string;
  type: string;
  shared: boolean;
  owner_id: string | null;
  updated_at: number;
  config: Record<string, unknown>;
}

interface ConnectionForm {
  name: string;
  server: string;
  port: string;
  user: string;
  password: string;
  database: string;
  shared: boolean;
}

const EMPTY: ConnectionForm = { name: '', server: '', port: '1433', user: '', password: '', database: '', shared: false };

export function ConnectionsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [rows, setRows] = useState<ConnectionDto[]>([]);
  const [form, setForm] = useState<ConnectionForm>(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<ConnectionDto[]>('/api/connections'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit(row: ConnectionDto) {
    setEditId(row.id);
    setNotice(null);
    setForm({
      name: row.name,
      server: String(row.config.server ?? ''),
      port: String(row.config.port ?? '1433'),
      user: String(row.config.user ?? ''),
      password: '',
      database: String(row.config.database ?? ''),
      shared: row.shared,
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const config: Record<string, unknown> = {
      server: form.server,
      port: Number(form.port) || 1433,
      user: form.user,
      database: form.database,
    };
    // 留空表示不修改密码（编辑时）
    if (form.password) config.password = form.password;
    try {
      if (editId) {
        await api.put(`/api/connections/${editId}`, {
          body: { name: form.name, config, shared: form.shared },
        });
      } else {
        await api.post('/api/connections', {
          body: { name: form.name, type: 'sqlserver', config, shared: form.shared },
        });
      }
      setForm(EMPTY);
      setEditId(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test(row: ConnectionDto) {
    setNotice(null);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; error?: string }>(`/api/connections/${row.id}/test`);
      setNotice(res.ok ? `连接「${row.name}」可达` : `连接「${row.name}」不可达：${res.error ?? '未知错误'}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(row: ConnectionDto) {
    if (!window.confirm(`确认删除连接「${row.name}」？`)) return;
    try {
      await api.del(`/api/connections/${row.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">数据连接</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-green-700">{notice}</p>}

      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">类型</th>
            <th className="p-2">服务器</th>
            <th className="p-2">库</th>
            <th className="p-2">共享</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">{row.name}</td>
              <td className="p-2 text-slate-500">{row.type}</td>
              <td className="p-2">{String(row.config.server ?? '')}</td>
              <td className="p-2">{String(row.config.database ?? '')}</td>
              <td className="p-2">{row.shared ? '是' : '否'}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600 underline" onClick={() => void test(row)}>测试</button>
                <button className="text-blue-600 underline" onClick={() => startEdit(row)}>编辑</button>
                <button className="text-red-600 underline" onClick={() => void remove(row)}>删除</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={6}>暂无连接。</td>
            </tr>
          )}
        </tbody>
      </table>

      <form onSubmit={submit} className="grid max-w-2xl grid-cols-2 gap-3 rounded border p-4 text-sm">
        <label className="col-span-2 block">
          名称
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="block">
          服务器
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.server}
            onChange={(e) => setForm({ ...form, server: e.target.value })}
            required
          />
        </label>
        <label className="block">
          端口
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
          />
        </label>
        <label className="block">
          用户
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.user}
            onChange={(e) => setForm({ ...form, user: e.target.value })}
          />
        </label>
        <label className="block">
          密码
          <input
            type="password"
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder={editId ? '留空则不修改' : ''}
          />
        </label>
        <label className="block">
          数据库
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            value={form.database}
            onChange={(e) => setForm({ ...form, database: e.target.value })}
          />
        </label>
        {isAdmin && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.shared}
              onChange={(e) => setForm({ ...form, shared: e.target.checked })}
            />
            共享给所有用户
          </label>
        )}
        <div className="col-span-2 flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
          >
            {editId ? '保存修改' : '新增连接'}
          </button>
          {editId && (
            <button
              type="button"
              className="rounded border px-4 py-1.5"
              onClick={() => {
                setEditId(null);
                setForm(EMPTY);
              }}
            >
              取消编辑
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 5: 实现用户管理页（仅管理员）**

Create `apps/web/src/pages/UsersPage.tsx`：

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';

interface UserDto {
  id: string;
  username: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
}

export function UsersPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<UserDto[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<UserDto[]>('/api/admin/users'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') void load();
  }, [user, load]);

  if (user?.role !== 'admin') return <p className="text-sm text-slate-500">无权访问。</p>;

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/admin/users', { body: { username, password, role } });
      setUsername('');
      setPassword('');
      setRole('user');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(row: UserDto) {
    const status = row.status === 'active' ? 'disabled' : 'active';
    try {
      await api.put(`/api/admin/users/${row.id}`, { body: { status } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetPassword(row: UserDto) {
    const next = window.prompt(`为「${row.username}」设置新密码（至少 8 位）：`);
    if (!next) return;
    try {
      await api.post(`/api/admin/users/${row.id}/reset-password`, { body: { password: next } });
      setError(null);
      window.alert('密码已重置');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(row: UserDto) {
    if (!window.confirm(`确认删除用户「${row.username}」？`)) return;
    try {
      await api.del(`/api/admin/users/${row.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">用户管理</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">用户名</th>
            <th className="p-2">角色</th>
            <th className="p-2">状态</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">{row.username}</td>
              <td className="p-2">{row.role === 'admin' ? '管理员' : '普通用户'}</td>
              <td className="p-2">{row.status === 'active' ? '正常' : '已禁用'}</td>
              <td className="space-x-2 p-2">
                <button className="text-blue-600 underline" onClick={() => void toggleStatus(row)}>
                  {row.status === 'active' ? '禁用' : '启用'}
                </button>
                <button className="text-blue-600 underline" onClick={() => void resetPassword(row)}>重置密码</button>
                <button className="text-red-600 underline" onClick={() => void remove(row)}>删除</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={4}>暂无用户。</td>
            </tr>
          )}
        </tbody>
      </table>

      <form onSubmit={create} className="flex flex-wrap items-end gap-3 rounded border p-4 text-sm">
        <label className="block">
          用户名
          <input
            className="mt-1 block rounded border px-2 py-1"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="block">
          初始密码
          <input
            type="password"
            className="mt-1 block rounded border px-2 py-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="block">
          角色
          <select
            className="mt-1 block rounded border px-2 py-1"
            value={role}
            onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
          >
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? '创建中…' : '创建用户'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 6: 实现系统设置页（仅管理员）**

Create `apps/web/src/pages/SettingsPage.tsx`：

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.js';

interface AdminSettings {
  maxConcurrentRuns: number;
  logRetentionDays: number;
  sharedDirs: string[];
  tz: string;
}

export function SettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [sharedDirsText, setSharedDirsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.get<AdminSettings>('/api/admin/settings');
      setSettings(s);
      setSharedDirsText(s.sharedDirs.join('\n'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') void load();
  }, [user, load]);

  if (user?.role !== 'admin') return <p className="text-sm text-slate-500">无权访问。</p>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setBusy(true);
    setNotice(null);
    try {
      const body: AdminSettings = {
        ...settings,
        sharedDirs: sharedDirsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      const next = await api.put<AdminSettings>('/api/admin/settings', { body });
      setSettings(next);
      setSharedDirsText(next.sharedDirs.join('\n'));
      setNotice('已保存（并发数与保留期在服务重启后完全生效）');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <p className="text-sm text-slate-500">加载中…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">系统设置</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-green-700">{notice}</p>}

      <form onSubmit={submit} className="max-w-xl space-y-3 rounded border p-4 text-sm">
        <label className="block">
          最大并发运行数
          <input
            type="number"
            min={1}
            className="mt-1 block w-32 rounded border px-2 py-1"
            value={settings.maxConcurrentRuns}
            onChange={(e) => setSettings({ ...settings, maxConcurrentRuns: Number(e.target.value) })}
          />
        </label>
        <label className="block">
          日志保留天数
          <input
            type="number"
            min={1}
            className="mt-1 block w-32 rounded border px-2 py-1"
            value={settings.logRetentionDays}
            onChange={(e) => setSettings({ ...settings, logRetentionDays: Number(e.target.value) })}
          />
        </label>
        <label className="block">
          共享目录（每行一个，允许服务端路径输入引用）
          <textarea
            className="mt-1 block h-28 w-full rounded border px-2 py-1 font-mono"
            value={sharedDirsText}
            onChange={(e) => setSharedDirsText(e.target.value)}
          />
        </label>
        <label className="block">
          默认时区
          <input
            className="mt-1 block w-64 rounded border px-2 py-1"
            value={settings.tz}
            onChange={(e) => setSettings({ ...settings, tz: e.target.value })}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-1.5 text-white disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存设置'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 7: 在 `App.tsx` 追加路由**

Modify `apps/web/src/App.tsx`（完整替换为以下内容）：

```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth.js';
import { Layout } from './components/Layout.js';
import { ConnectionsPage } from './pages/ConnectionsPage.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { RunDetailPage } from './pages/RunDetailPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { WorkflowDetailPage } from './pages/WorkflowDetailPage.js';
import { WorkflowListPage } from './pages/WorkflowListPage.js';
import { WorkflowUploadPage } from './pages/WorkflowUploadPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<HomePage />} />
            <Route path="/workflows" element={<WorkflowListPage />} />
            <Route path="/workflows/new" element={<WorkflowUploadPage />} />
            <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/connections" element={<ConnectionsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 8: 类型检查并构建**

Run: `pnpm --filter @hustserver/web build`
Expected: 成功（`tsc` 无错误，`vite build` 产出 `dist/`）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/pages apps/web/src/components/ScheduleSection.tsx apps/web/src/App.tsx
git commit -m "feat(web): 运行详情/调度/连接/用户/设置页面与路由"
```

## Task 25: 服务入口、静态托管与 macOS launchd 常驻脚本

**Files:**
- Modify: `apps/server/package.json`（新增 `@fastify/static`）
- Modify: `apps/server/src/server.ts`（暴露 `app.scheduler` 装饰器）
- Create: `apps/server/src/index.ts`
- Create: `scripts/install-macos-service.sh`
- Test: `apps/server/test/e2e-smoke.test.ts`

**Interfaces:**
- Consumes:
  - `loadConfig(env?): AppConfig`、`ensureDirs(cfg)`（Task 2 `apps/server/src/config.ts`）
  - `openDatabase(file)`、`migrate(db)`（Task 3 `apps/server/src/db/{index,migrate}.ts`）
  - `buildServer(deps: AppDeps): Promise<FastifyInstance>`、`AppOverrides { recorder?; runService?; scheduler? }`（Task 21 `apps/server/src/server.ts`）
  - `ensureBootstrapAdmin(db, cfg, log)`（Task 6 `apps/server/src/bootstrap.ts`）
  - `settingsRepo(db)`、`readSettings(config, settings)`（Task 21 `apps/server/src/modules/settings/{repo,routes}.ts`）
  - `createRetention(deps): Retention`（Task 20 `apps/server/src/modules/runs/retention.ts`）、`runsRepo(db)`（Task 14）
  - `Scheduler = { start(): void; stop(): void; reload(): void; registeredIds(): string[] }`（Task 18）、`Recorder`（Task 15）、`RunService`（Task 15）
- Produces:
  - `apps/server/src/index.ts`：可执行入口（`node dist/index.js`）。流程：`loadConfig → ensureDirs → openDatabase → migrate → readSettings 覆盖 config → buildServer → ensureBootstrapAdmin → 静态托管 + SPA 回退 → listen → app.scheduler.start() → retention.start() → 优雅退出`。
  - `FastifyInstance.scheduler`（通过 `app.decorate` 暴露，供入口启动/停止调度器）。
  - `scripts/install-macos-service.sh`：生成并加载 LaunchAgent `com.hustserver.app`（`RunAtLoad` + `KeepAlive`，日志到 `~/Library/Logs/HUSTServer/`）。

> 依据 Spec §13「环境变量：`HUSTSERVER_*` / `SESSION_SECRET` / `ENCRYPTION_KEY` …」、§16「M5 = 部署与加固：launchd 安装脚本、日志保留清理、前端完善、测试补齐、安全复查」、§10「进程内调度：启动时重建」，以及关键决策「部署形态 = macOS 单进程（API + 前端静态 + 调度器），无 Docker」。

- [ ] **Step 1: 新增静态托管依赖**

Modify `apps/server/package.json`，在 `dependencies` 中新增一行（保持字母序）：

```json
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/multipart": "^10.1.3",
    "@fastify/static": "^8.0.4",
    "@hustserver/engine": "workspace:*",
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^13.0.3",
    "cron-parser": "^4.9.0",
    "fastify": "^5.12.5",
    "nanoid": "^6.0.2",
    "node-cron": "^3.0.3"
  },
```

Run: `pnpm install`
Expected: 安装成功（`@fastify/static@8.x`，与 Fastify 5 兼容）。

- [ ] **Step 2: 写端到端冒烟测试（先失败）**

Create `apps/server/test/e2e-smoke.test.ts`：

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBootstrapAdmin } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createRecorder, type Recorder } from '../src/modules/runs/recorder.js';
import { runsRepo } from '../src/modules/runs/repo.js';
import type { RunService } from '../src/modules/runs/service.js';
import type { Scheduler } from '../src/modules/schedules/scheduler.js';
import { buildServer } from '../src/server.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hustserver-e2e-'));

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: dataDir,
  BOOTSTRAP_ADMIN_USER: 'root',
  BOOTSTRAP_ADMIN_PASSWORD: 'root12345',
});

/** 从 inject 响应中取出会话 Cookie 的 name=value 部分。 */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const value = Array.isArray(raw) ? String(raw[0]) : String(raw);
  return value.split(';')[0];
}

describe('端到端冒烟：建号 → 工作流 → 调度 → 运行 → 设置权限', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let adminCookie = '';
  let userCookie = '';
  let workflowId = '';
  let stubScheduler: Scheduler;

  beforeAll(async () => {
    db = new Database(path.join(dataDir, 'e2e.sqlite'));
    db.pragma('foreign_keys = ON');
    migrate(db);
    await ensureBootstrapAdmin(db, cfg, { info() {}, warn() {} });

    // 注入桩：真实 recorder（无原生依赖）+ 直接落库的 runService（不拉起 DuckDB）+ 空 scheduler（不起真实定时器）
    const recorder: Recorder = createRecorder(db);
    const runService: RunService = {
      trigger(workflowIdArg, opts) {
        return runsRepo(db).create({
          workflowId: workflowIdArg,
          scheduleId: opts?.scheduleId ?? null,
          triggerType: opts?.triggerType ?? 'manual',
          triggeredBy: opts?.triggeredBy ?? null,
          status: 'success',
        });
      },
      async whenIdle() {},
    };
    stubScheduler = { start() {}, stop() {}, reload() {}, registeredIds: () => [] };

    app = await buildServer({
      db,
      config: cfg,
      overrides: { recorder, runService, scheduler: stubScheduler },
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'root', password: 'root12345' },
    });
    expect(login.statusCode).toBe(200);
    adminCookie = cookieFrom(login);
  });

  afterAll(async () => {
    await app.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('buildServer 暴露注入的 scheduler 装饰器', () => {
    expect(app.scheduler).toBe(stubScheduler);
  });

  it('管理员创建普通用户', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { username: 'alice', password: 'password1', role: 'user' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('普通用户登录并完成连接/工作流/调度/运行闭环', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'password1' },
    });
    expect(login.statusCode).toBe(200);
    userCookie = cookieFrom(login);

    const conn = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: { cookie: userCookie },
      payload: {
        name: '本地库',
        config: { server: '127.0.0.1', port: 1433, database: 'demo', user: 'sa', password: 'p' },
      },
    });
    expect(conn.statusCode).toBe(201);

    const workflow = {
      id: 'wf-e2e',
      name: '订单清洗',
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        { id: 'n1', kind: 'inputCsv', name: '读取订单', position: { x: 0, y: 0 }, config: { path: '/data/orders.csv' } },
        { id: 'n2', kind: 'outputCsv', name: '导出结果', position: { x: 200, y: 0 }, config: { path: '/data/out.csv' } },
      ],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      headers: { cookie: userCookie },
      payload: { name: '订单清洗', workflow, mappings: [] },
    });
    expect(created.statusCode).toBe(201);
    workflowId = (created.json() as { id: string }).id;

    const list = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie: userCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json() as Array<{ name: string }>).toHaveLength(1);

    const schedule = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/schedules`,
      headers: { cookie: userCookie },
      payload: { freqType: 'daily', time: '08:30', timezone: 'Asia/Shanghai' },
    });
    expect(schedule.statusCode).toBe(201);
    expect(typeof (schedule.json() as { nextRunAt: number }).nextRunAt).toBe('number');

    const started = await app.inject({
      method: 'POST',
      url: `/api/workflows/${workflowId}/runs`,
      headers: { cookie: userCookie },
    });
    expect(started.statusCode).toBe(202);
    const runId = (started.json() as { runId: string }).runId;

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: userCookie } });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { run: { status: string } }).run.status).toBe('success');
  });

  it('系统设置仅管理员可读写', async () => {
    const adminGet = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
    expect(adminGet.statusCode).toBe(200);

    const adminPut = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: adminCookie },
      payload: { maxConcurrentRuns: 3, logRetentionDays: 30, tz: 'Asia/Shanghai' },
    });
    expect(adminPut.statusCode).toBe(200);
    expect((adminPut.json() as { maxConcurrentRuns: number }).maxConcurrentRuns).toBe(3);

    const userGet = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: userCookie } });
    expect(userGet.statusCode).toBe(403);
  });
});
```

> 说明：本测试只依赖 `buildServer`，用 `overrides` 注入桩以避免拉起 DuckDB 原生模块（`runService`）与真实定时器（`scheduler`）；`recorder` 用真实实现（仅 better-sqlite3）。`app.scheduler` 断言要求 Step 3 的装饰器改造。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @hustserver/server exec vitest run test/e2e-smoke.test.ts`
Expected: FAIL —— `app.scheduler` 为 `undefined`（`TypeError: Cannot read properties of undefined` 或断言 `expected undefined to be {...}`）。

- [ ] **Step 4: 在 `server.ts` 暴露 `scheduler` 装饰器**

Modify `apps/server/src/server.ts`（两处增量，其余保持 Task 21 版本不变）：

1）在文件顶部 import 区域之后（`import { workflowRoutes } ...` 之后）追加类型声明合并：

```ts
declare module 'fastify' {
  interface FastifyInstance {
    scheduler: Scheduler;
  }
}
```

2）在 `buildServer` 内 `const scheduler = ...;` 语句之后、`authRoutes(...)` 之前，追加装饰器注册：

```ts
  app.decorate('scheduler', scheduler);
```

> 说明：`Scheduler` 已由 `import { createScheduler, type Scheduler } from './modules/schedules/scheduler.js';` 引入。`buildServer` 仍只构建不启动；`scheduler.start()` 由入口 `index.ts` 调用（测试里注入桩后调 `start()` 也是空操作）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @hustserver/server exec vitest run test/e2e-smoke.test.ts`
Expected: PASS（4 passed）。

- [ ] **Step 6: 回归既有服务端测试**

Run: `pnpm --filter @hustserver/server exec vitest run`
Expected: 全部 PASS（新增装饰器不影响既有用例）。

- [ ] **Step 7: 实现服务入口 `index.ts`**

Create `apps/server/src/index.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { ensureDirs, loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createRetention } from './modules/runs/retention.js';
import { runsRepo } from './modules/runs/repo.js';
import { settingsRepo } from './modules/settings/repo.js';
import { readSettings } from './modules/settings/routes.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureDirs(cfg);

  // 引擎（@hustserver/engine/config.ts）在模块求值时读取 HUSTSERVER_* 环境变量；
  // server.ts 静态导入引擎，故先补齐环境变量，再用动态 import 延迟其求值。
  process.env.HUSTSERVER_DATA_DIR ??= cfg.dataDir;
  process.env.HUSTSERVER_HOST ??= cfg.host;
  process.env.HUSTSERVER_PORT ??= String(cfg.port);
  process.env.DUCKDB_MEMORY_LIMIT ??= cfg.duckdbMemoryLimit;

  const db = openDatabase(cfg.dbFile);
  migrate(db);

  // 系统设置（DB 覆盖）优先于环境变量默认值。
  const settings = settingsRepo(db);
  const effective = readSettings(cfg, settings);
  const runtimeConfig: AppConfig = {
    ...cfg,
    maxConcurrentRuns: effective.maxConcurrentRuns,
    logRetentionDays: effective.logRetentionDays,
    sharedDirs: effective.sharedDirs,
    tz: effective.tz,
  };

  const { buildServer } = await import('./server.js');
  const app = await buildServer({ db, config: runtimeConfig, logger: true });

  await ensureBootstrapAdmin(db, runtimeConfig, app.log);

  // 前端静态资源 + SPA 回退（/api/* 仍返回 JSON 404）。
  // src 与 dist 下此处均解析到 apps/web/dist。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = path.resolve(here, '../../web/dist');
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`未找到前端产物 ${webDir}，仅提供 API 服务（请先执行 pnpm --filter @hustserver/web build）`);
  }

  const retention = createRetention({
    runs: runsRepo(db),
    logRetentionDays: runtimeConfig.logRetentionDays,
    onError: (err) => app.log.error({ err }, '日志保留清理失败'),
  });

  await app.listen({ host: cfg.host, port: cfg.port });
  app.scheduler.start();
  retention.start();
  app.log.info(`HUSTServer 已启动：http://${cfg.host}:${cfg.port}`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`收到 ${signal}，正在优雅退出…`);
    app.scheduler.stop();
    retention.stop();
    try {
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('HUSTServer 启动失败：', err);
  process.exit(1);
});
```

> 说明：`app.log`（Fastify Logger）已有 `info/warn/error`，满足 `ensureBootstrapAdmin` 的 `BootstrapLogger` 结构。`runtimeConfig` 是环境变量默认值被 DB 设置覆盖后的最终配置；`RunService` 内部并发上限亦读取 `runtimeConfig.maxConcurrentRuns`。

- [ ] **Step 8: 类型检查并构建后端**

Run: `pnpm --filter @hustserver/server build`
Expected: 成功（`tsc` 无错误，产出 `dist/index.js`）。

- [ ] **Step 9: 编写 macOS launchd 安装脚本**

Create `scripts/install-macos-service.sh`：

```bash
#!/usr/bin/env bash
# HUSTServer macOS LaunchAgent 安装脚本（无 Docker）
#
# 用法：
#   bash scripts/install-macos-service.sh             # 安装并启动（开机自启 + 崩溃自拉起）
#   bash scripts/install-macos-service.sh --uninstall  # 停止并卸载
#
# 前置：已执行 `pnpm install && pnpm -r build`（需要 apps/server/dist/index.js 与 apps/web/dist）。
set -euo pipefail

LABEL="com.hustserver.app"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENTRY="$REPO_ROOT/apps/server/dist/index.js"
WEB_INDEX="$REPO_ROOT/apps/web/dist/index.html"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/HUSTServer"

uninstall() {
  launchctl unload "$PLIST_FILE" >/dev/null 2>&1 || true
  rm -f "$PLIST_FILE"
  echo "已卸载 $LABEL（.env 与数据目录保持不变）"
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "错误：未找到 node，请先安装 Node >= 20" >&2
  exit 1
fi
if [[ ! -f "$ENTRY" ]]; then
  echo "错误：缺少 $ENTRY，请先执行 pnpm -r build" >&2
  exit 1
fi
if [[ ! -f "$WEB_INDEX" ]]; then
  echo "警告：未找到前端产物 $WEB_INDEX，服务将只提供 API" >&2
fi

# 1) 首次安装生成 .env（含随机密钥），已存在则复用
if [[ ! -f "$ENV_FILE" ]]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  umask 077
  cat > "$ENV_FILE" <<EOF
HUSTSERVER_HOST=127.0.0.1
HUSTSERVER_PORT=8787
HUSTSERVER_DATA_DIR=$HOME/.hustserver
HUSTSERVER_SHARED_DIRS=
SESSION_SECRET=$SESSION_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
SESSION_TTL_MS=$((7 * 24 * 60 * 60 * 1000))
MAX_CONCURRENT_RUNS=2
RUN_MAX_RETRIES=1
LOG_RETENTION_DAYS=90
DUCKDB_MEMORY_LIMIT=2GB
TZ=Asia/Shanghai
BOOTSTRAP_ADMIN_USER=admin
BOOTSTRAP_ADMIN_PASSWORD=
EOF
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE（权限 600）"
else
  echo "复用已有 $ENV_FILE"
fi

# 2) 把 .env 的 KEY=VALUE 转为 plist 的 EnvironmentVariables 片段（XML 转义）
ENV_XML=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  [[ -z "$key" ]] && continue
  value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"
  ENV_XML+="        <key>$key</key>"$'\n'"        <string>$value</string>"$'\n'
done < "$ENV_FILE"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

# 3) 写 LaunchAgent plist（RunAtLoad 随登录启动；KeepAlive 崩溃自拉起）
cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE_BIN</string>
      <string>$ENTRY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
$ENV_XML    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
  </dict>
</plist>
EOF

# 4) 重新加载
launchctl unload "$PLIST_FILE" >/dev/null 2>&1 || true
launchctl load "$PLIST_FILE"

echo "已安装并启动 $LABEL"
echo "  日志：$LOG_DIR/stdout.log"
echo "  查看：launchctl list | grep $LABEL"
```

- [ ] **Step 10: 脚本自检（不实际加载）**

Run: `bash -n scripts/install-macos-service.sh && chmod +x scripts/install-macos-service.sh`
Expected: 语法检查通过（无输出），脚本可执行。

> 说明：`launchctl load/unload` 在新版 macOS 上已标记为废弃但仍可用；如需改用 `launchctl bootstrap gui/$(id -u) <plist>` / `bootout`，属等价替换，不影响本设计。`KeepAlive=true` 会在进程被手动 kill 后自动重启，这是常驻服务的预期行为。

- [ ] **Step 11: 构建全部产物并手动冒烟（可选，需人工确认）**

Run: `pnpm -r build`
Expected: `@hustserver/engine`、`@hustserver/server`、`@hustserver/web` 均构建成功。

Run（临时环境变量启动，验证服务可起、静态页可开）：
```bash
SESSION_SECRET=$(openssl rand -hex 24) \
ENCRYPTION_KEY=$(openssl rand -hex 32) \
HUSTSERVER_DATA_DIR=$(mktemp -d) \
BOOTSTRAP_ADMIN_USER=admin BOOTSTRAP_ADMIN_PASSWORD=admin12345 \
node apps/server/dist/index.js
```
Expected: 打印 `HUSTServer 已启动：http://127.0.0.1:8787`；浏览器打开 `http://127.0.0.1:8787` 显示登录页；用 `admin / admin12345` 登录成功。`Ctrl-C` 可优雅退出。

- [ ] **Step 12: 提交**

```bash
git add apps/server/package.json apps/server/src/index.ts apps/server/src/server.ts apps/server/test/e2e-smoke.test.ts scripts/install-macos-service.sh pnpm-lock.yaml
git commit -m "feat: 服务入口、静态托管与 macOS launchd 常驻脚本"
```

---

> **计划结束。** 覆盖里程碑 M1–M5，共 25 个任务。实施时按 Task 顺序推进；每个 Task 内的步骤为可独立验证的最小单元（先写失败测试 → 再实现 → 回归 → 提交）。

