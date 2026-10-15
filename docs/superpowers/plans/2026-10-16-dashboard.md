# 实现计划：仪表板（Dashboard，融合 tinybi）

For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans

- 日期：2026-10-16
- Spec：[2026-10-16-dashboard-design.md](../specs/2026-10-16-dashboard-design.md)（commit `0dadb99`，已批准）
- 执行方式：14 个任务串行执行，每任务独立实现 + 审查 + 单独 git commit
- 参考代码源：`/tmp/tinybi/src`（若不存在则 `git clone --depth 1 https://github.com/microsoftbi/tinybi /tmp/tinybi`）

## Goal

把 tinybi 的仪表板设计器完整融入 HUSTServer：19 种视觉对象、拖拽缩放吸附画布、多页签、交叉高亮、透视表、填充地图；数据源走「连接执行 SQL」与「资源管理 CSV/Excel」两条路；仪表板持久化到后端 SQLite（只存数据源定义，不存行数据）；导航栏 + 首页卡片 + `/dashboards`（列表）/ `/dashboards/:id`（独立全屏编辑器）双入口。

## Spec 修正说明（实现时对 spec 的 10 处落地细化）

1. `lib/csv.ts` / `lib/xlsx.ts` 增加 `def: DatasetDef` 第三入参并回填 `Dataset.def`（spec 6.3「均填入 def」的实现方式；唯一调用方是 `services/dataSource.ts`）。
2. `apps/web/tsconfig.json` 必须加 `"resolveJsonModule": true`（spec 8 未提；`lib/geo.ts` 的 `import("@bi/assets/geo/china.json")` 没有它会 TS2732）。
3. `apps/web/src/index.css` **必须**追加 tinybi 的 `.vbi-handle` / `.vbi-guide-v` / `.vbi-guide-h`（spec 8 说 index.css「预期不改」，实际 `ReportCanvas.tsx` 依赖这三类；`hsl(var(--background))` 要改成 `var(--background)`，本项目 `--background` 是 oklch 值）。
4. 「添加数据集」按钮需要 `FieldsPane` 新增可选 prop `onAddDataset`，并经 `DashboardView` 新增可选 prop 透传（spec 6.1 说 FieldsPane「+ 添加数据集按钮」，透传链是隐含前提）。
5. `datasetStore` 错误态落实为 `errors: Record<string, string>` + `setError` / `clearError` / `reset`（spec 6.1 已注「+ 错误态支持」）。
6. spec 6.6「widget 渲染占位可点击重新取数」：占位文案已由 tinybi `ChartRenderer.tsx` 原文满足（`数据集已丢失，请重新配置`）；「重新取数」落实为编辑器顶部红色错误条 + 每个失败数据集一个「重试」按钮，不改 `ReportCanvas`。
7. 保存 payload 组装：以服务端返回的 `payload.datasets` 为底、再叠加运行时 `datasets` 的 `{id,name,def}`，用 `Map<id, SavedDataset>` 合并，**不做**「仅保留被 widget 引用」过滤（防丢失败数据集定义、防丢刚加未用数据集）。
8. `hydrateDataset` 末尾固定 `return { ...ds, id: saved.id }`，保证 widget.datasetId 跨保存-重开稳定。
9. 3 处引用已不存在的「数据源」页面的文案适配（ReportCanvas L281 / FieldsPane L103 / DashboardView L134 → 指向「添加数据集」按钮）。
10. spec 6.1「抄 tinybi 的 15 个基元 + card.tsx」：tinybi `components/ui/` 实有 15 个文件**已含 card.tsx**（badge/button/card/dialog/dropdown-menu/input/label/scroll-area/select/separator/switch/table/tabs/textarea/tooltip），无需额外文件。

## Architecture

```
浏览器（React 19, apps/web）
  /dashboards        DashboardListPage        （Layout 内，列表 CRUD + 共享）
  /dashboards/:id    DashboardEditorPage      （独立全屏，Layout 外）
    ├─ 加载：GET payload → setDashboards/setActive → 并行 hydrateDataset → addDataset / setError
    ├─ 保存：dashboardStore + datasetStore → DashboardPayload → PUT
    ├─ DashboardView（tinybi 原文 + 文案适配 + onAddDataset 透传）
    │    ├─ ReportCanvas（拖拽/缩放/吸附，依赖 .vbi-* 类）
    │    ├─ ChartRenderer（recharts / MapChart / PivotTable / DataTable / KPI）
    │    ├─ VisualizationsPane / FieldsPane（+ 添加数据集按钮）
    │    └─ DataSourceDialog（新：SQL 连接 / 资源库文件 两 Tab）
    ├─ stores: dashboardStore（原样）/ datasetStore（+ errors）
    └─ services/dataSource.ts（新，唯一取数出口）
后端（Fastify, apps/server）
  dashboardRoutes  /api/dashboards*（新模块 modules/dashboards/，照 connections 模式）
  dataRoutes       POST /api/data/query（新模块 modules/data/，照 probe.ts 的 mssql 模式）
SQLite
  dashboards 新表（id/owner_id/name/payload/shared/created_at/updated_at）
复用（不新增）：/api/connections、/api/resources/tree、/api/resources/files/download
```

## Tech Stack

- `@hustserver/server`：Fastify 5 + better-sqlite3 ^13.0.3 + mssql ^12.7.4（已有）；测试 vitest + `app.inject`
- `@hustserver/web`：React 19 + Vite 6 + react-router-dom 7 + Tailwind 4 + `tw-animate-css`；本次新增 recharts ^2.15.0 / zustand ^5.0.3 / papaparse ^5.4.1 / xlsx ^0.18.5 / sonner ^1.7.2 / lucide-react ^0.471.1 / cva ^0.7.1 / clsx ^2.1.1 / tailwind-merge **^3.0.0** / @radix-ui 10 个包 / @types/papaparse
- 别名：`@bi` → `apps/web/src/features/dashboard/`（vite alias + tsconfig paths）；`@` 保持指向 workflow-designer src
- 测试：**不搬** tinybi 的 `lib/*.test.ts`（web 不引入 vitest）；server 侧新增 dashboards 路由测试与 data/query 校验测试

## Global Constraints（每个任务都必须遵守）

1. **数据集只存定义**：payload.datasets 是 `SavedDataset[]`（无行数据）；运行时 `Dataset.def` 必填。
2. **id 稳定**：`hydrateDataset` 返回 `{ ...ds, id: saved.id }`；保存合并策略见修正说明 #7，不得做引用过滤。
3. **`@bi` 别名**：所有搬运文件里的 `@/` 全局替换为 `@bi/`；`@/` 继续指向 workflow-designer，不得混用。搬运目录必须是扁平结构（8 个 feature 文件在 `features/dashboard/` 根，`lib/ stores/ components/ services/ assets/` 为其子目录）。
4. **版本锁**：`recharts@^2.15.0`（勿装 3.x）、`tailwind-merge@^3.0.0`（Tailwind 4 需要 v3）。若 recharts 2.15 在 React 19 下构建/运行报错：升 `recharts@^3` 并逐项校正 ChartRenderer 中 `RadialBar`/`Treemap`/`Funnel` 的 props（备选路径，不主动走）。
5. **GeoJSON**：`china.json`(582KB)/`world.json`(257KB) 只能经 `lib/geo.ts` 的动态 `import()` 加载，禁止任何静态导入；不复制 tinybi 的测试与 `.biproj` 导入导出。
6. **预览复用**：SQL 预览一次执行（`api.post` + `datasetFromQueryResult`），「存为数据集」复用同一 Dataset，不二次取数。
7. **后端权限与 connections 完全一致**：canManage = `admin || owner_id === me`；canUse（查看/取数）= `admin || shared === 1 || owner_id === me`；`shared` 仅 admin 可置真（普通用户传 shared=true 静默忽略为 false）。
8. **payload 校验**：必须是对象（非数组/非 null）且 `JSON.stringify` 后 ≤ 8MB → 违规 400 `{error:'payload 必须是对象'}` / 413 `{error:'payload_too_large'}`。
9. **mssql 模式照 probe.ts**：`new sql.ConnectionPool(buildMssqlConfig(conn))` → `connect()` → `request().query()` → `finally pool.close()`；异常 400 `{error:'执行 SQL 失败', detail}`；limit 默认 1000、上限 10000、最小 1；**不加只读校验**。
10. **列类型推断**：按每列**首个非空值**——`number→number`、`boolean→boolean`、`Date→date`、字符串可被 `Date.parse` 解析→`date`、其余→`string`；全空→`unknown`；单元格 Date 转 ISO 字符串。
11. **样式**：`.vbi-*` 三类追加到 `apps/web/src/index.css` 末尾，`hsl(var(--background))` 改 `var(--background)`；tw-animate-css 已覆盖 `animate-in` 系列类，不改 UI 基元的动画类。
12. **平台**：派发子代理绝不传 model 参数；禁用 kill/pkill（停后端用 StopCommand 工具）；`pnpm --filter @hustserver/workflow-designer build` 会报 `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`，不要执行。
13. **提交纪律**：每任务完成并验证通过后单独 commit（`feat:`/`test:`/`chore:` + 中文一句话）；不 `git add -A`。
14. **重启纪律**：后端路由/表结构改动必须重启后端进程（环境变量：`SESSION_SECRET=please-change-me`、`ENCRYPTION_KEY=0123456789abcdef0123456789abcdef`、`HUSTSERVER_PORT=8787`、`BOOTSTRAP_ADMIN_USER=admin`、`BOOTSTRAP_ADMIN_PASSWORD=admin1234`、`ICUBE_DATABASE_BACKUP_INTERVAL=300000`、`ICUBE_ENABLE_DATABASE_BACKUP=0`；cwd=仓库根）；纯前端改动只需重新 build。
15. **导入风格**：新页面（ListPage/EditorPage）引用 `api` 用 `../../api.js`、`useAuth` 用 `../../auth.js`（沿用 web 既有相对路径 + `.js` 后缀风格）；dashboard 特性内部沿用 tinybi 的无扩展名相对导入。

---

## Task 1：后端 `dashboards` 表（TDD）

**Files**
- Modify [apps/server/src/db/migrate.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/db/migrate.ts)（`SCHEMA` 模板串末尾，`idx_run_nodes_run` 行之后、闭反引号之前，约 L126）
- Modify [apps/server/test/migrate.test.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/test/migrate.test.ts)（L15-16 数组 + 索引断言）

**Interfaces**

```sql
CREATE TABLE IF NOT EXISTS dashboards (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT REFERENCES users(id),
  name       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  shared     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards(owner_id, created_at DESC);
```

**Steps**
- [ ] 改 [migrate.test.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/test/migrate.test.ts)：L15-16 的表名数组追加 `'dashboards'`；文件末尾新增用例：

```ts
  it('dashboards 具备 (owner_id, created_at) 索引', () => {
    const db = new Database(':memory:');
    migrate(db);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dashboards'").all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_dashboards_owner');
  });
```

- [ ] 运行 `pnpm --filter @hustserver/server test -- migrate`，确认新用例**失败**（红）
- [ ] 在 [migrate.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/db/migrate.ts) `SCHEMA` 末尾（`CREATE UNIQUE INDEX IF NOT EXISTS idx_run_nodes_run ...` 行之后、闭反引号之前）插入上面的 SQL 块
- [ ] 运行 `pnpm --filter @hustserver/server test -- migrate`，确认全绿（含幂等用例）
- [ ] Commit：`feat: 新增 dashboards 表`

## Task 2：后端 `modules/dashboards/`（repo + routes + 注册，TDD）

**Files**
- Create `apps/server/src/modules/dashboards/repo.ts`
- Create `apps/server/src/modules/dashboards/routes.ts`
- Modify [apps/server/src/server.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/server.ts)（import + 注册，插在 `connectionRoutes(...)` 之后）
- Create `apps/server/test/dashboards.test.ts`

**Interfaces**

```ts
// repo.ts
export interface DashboardRow { id: string; owner_id: string | null; name: string; payload: string; shared: number; created_at: number; updated_at: number; }
export interface DashboardsRepo {
  create(input: { ownerId: string; name: string; payload: string; shared: boolean }): DashboardRow;
  findById(id: string): DashboardRow | null;
  listForOwner(ownerId: string): DashboardRow[];   // shared = 1 OR owner_id = ?，按 created_at DESC
  listAll(): DashboardRow[];
  update(id: string, patch: { name?: string; payload?: string; shared?: boolean }): DashboardRow | null;
  remove(id: string): boolean;
}
export function dashboardsRepo(db: Database): DashboardsRepo;

// routes.ts
export interface DashboardRouteDeps { db: Database; config: AppConfig; users: UsersRepo; sessions: SessionsRepo; }
export function dashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void;
// GET    /api/dashboards          → Array<{id,name,shared,owner_id,created_at,updated_at}>（不含 payload）
// POST   /api/dashboards          body {name, payload, shared?} → 201 单条（含 payload）
// GET    /api/dashboards/:id      → 单条（含 payload: JSON.parse 后的对象）
// PUT    /api/dashboards/:id      body {name?, payload?, shared?} → 单条（含 payload）
// DELETE /api/dashboards/:id      → {ok:true}
```

**Steps**
- [ ] 写 `repo.ts`（整文件照抄下方代码，结构对齐 [connections/repo.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/modules/connections/repo.ts)）：

```ts
import type { Database } from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface DashboardRow {
  id: string;
  owner_id: string | null;
  name: string;
  payload: string;
  shared: number;
  created_at: number;
  updated_at: number;
}

export interface DashboardsRepo {
  create(input: { ownerId: string; name: string; payload: string; shared: boolean }): DashboardRow;
  findById(id: string): DashboardRow | null;
  listForOwner(ownerId: string): DashboardRow[];
  listAll(): DashboardRow[];
  update(id: string, patch: { name?: string; payload?: string; shared?: boolean }): DashboardRow | null;
  remove(id: string): boolean;
}

export function dashboardsRepo(db: Database): DashboardsRepo {
  const insert = db.prepare('INSERT INTO dashboards (id, owner_id, name, payload, shared, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  const byId = db.prepare('SELECT * FROM dashboards WHERE id = ?');
  const visible = db.prepare('SELECT * FROM dashboards WHERE shared = 1 OR owner_id = ? ORDER BY created_at DESC');
  const all = db.prepare('SELECT * FROM dashboards ORDER BY created_at DESC');
  const del = db.prepare('DELETE FROM dashboards WHERE id = ?');
  const get = (id: string) => (byId.get(id) as DashboardRow | undefined) ?? null;

  return {
    create({ ownerId, name, payload, shared }) {
      const now = Date.now();
      const id = nanoid(12);
      insert.run(id, ownerId, name, payload, shared ? 1 : 0, now, now);
      return get(id)!;
    },
    findById: get,
    listForOwner: (ownerId) => visible.all(ownerId) as DashboardRow[],
    listAll: () => all.all() as DashboardRow[],
    update(id, patch) {
      const cur = get(id);
      if (!cur) return null;
      db.prepare('UPDATE dashboards SET name = ?, payload = ?, shared = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? cur.name, patch.payload ?? cur.payload, patch.shared ? 1 : patch.shared === false ? 0 : cur.shared, Date.now(), id);
      return get(id);
    },
    remove: (id) => del.run(id).changes > 0,
  };
}
```

- [ ] 写测试 `apps/server/test/dashboards.test.ts`（脚手架照抄 [connections.test.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/test/connections.test.ts) L1-36：`:memory:` + migrate + 三用户 admin/alice/bob + cookie 登录），用例：

```ts
const okPayload = { version: 2, dashboards: [{ id: 'd1', name: '仪表盘 1', widgets: [] }], activeId: 'd1', datasets: [] };

describe('dashboard routes', () => {
  it('未登录 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/dashboards' })).statusCode).toBe(401);
  });
  it('创建成功 201，GET 单条返回 payload 对象', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: '销售看板', payload: okPayload } });
    expect(created.statusCode).toBe(201);
    const one = await app.inject({ method: 'GET', url: `/api/dashboards/${created.json().id}`, headers: { cookie: aliceCookie } });
    expect(one.json().payload).toEqual(okPayload);
  });
  it('缺名称 400；payload 非对象 400；payload 超 8MB 413 payload_too_large', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: ' ', payload: okPayload } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'x', payload: 'str' } })).statusCode).toBe(400);
    const big = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'x', payload: { a: 'x'.repeat(9 * 1024 * 1024) } } });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('payload_too_large');
  });
  it('列表：普通用户只见自有+共享，admin 见全量', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: adminCookie }, payload: { name: '公共', shared: true, payload: okPayload } });
    const bobList = await app.inject({ method: 'GET', url: '/api/dashboards', headers: { cookie: bobCookie } });
    expect(bobList.json()).toHaveLength(1);
    expect(bobList.json()[0].name).toBe('公共');
    const adminList = await app.inject({ method: 'GET', url: '/api/dashboards', headers: { cookie: adminCookie } });
    expect(adminList.json()).toHaveLength(2);
    expect(a.statusCode).toBe(201);
  });
  it('他人未共享：GET 403 / PUT 403 / DELETE 403；列表不出现', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    const id = created.json().id;
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie }, payload: { name: 'hacked' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie } })).statusCode).toBe(403);
  });
  it('shared 仅 admin 可置真：alice 置真被忽略，admin 置真生效', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    const id = created.json().id;
    await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie }, payload: { shared: true } });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie } })).json().shared).toBe(false);
    await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: adminCookie }, payload: { shared: true } });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: bobCookie } })).statusCode).toBe(200);
  });
  it('PUT 更新 name/payload，DELETE 后 404', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/dashboards', headers: { cookie: aliceCookie }, payload: { name: 'a', payload: okPayload } });
    const id = created.json().id;
    const put = await app.inject({ method: 'PUT', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie }, payload: { name: 'b', payload: { ...okPayload, activeId: 'x' } } });
    expect(put.json().name).toBe('b');
    expect(put.json().payload.activeId).toBe('x');
    expect((await app.inject({ method: 'DELETE', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url: `/api/dashboards/${id}`, headers: { cookie: aliceCookie } })).statusCode).toBe(404);
  });
});
```

- [ ] 运行 `pnpm --filter @hustserver/server test -- dashboards`，确认**失败**（路由未实现）
- [ ] 写 `routes.ts`（整文件照抄下方代码，风格对齐 [connections/routes.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/modules/connections/routes.ts)）：

```ts
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { dashboardsRepo, type DashboardRow } from './repo.js';

export interface DashboardRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

function validatePayload(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'payload 必须是对象';
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_PAYLOAD_BYTES) return 'payload_too_large';
  return null;
}

function toDto(row: DashboardRow, withPayload: boolean) {
  return {
    id: row.id,
    name: row.name,
    shared: row.shared === 1,
    owner_id: row.owner_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(withPayload ? { payload: JSON.parse(row.payload) } : {}),
  };
}

export function dashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = dashboardsRepo(deps.db);
  const canManage = (req: Parameters<typeof auth>[0], row: DashboardRow) =>
    req.auth!.role === 'admin' || row.owner_id === req.auth!.userId;
  const canView = (req: Parameters<typeof auth>[0], row: DashboardRow) =>
    req.auth!.role === 'admin' || row.shared === 1 || row.owner_id === req.auth!.userId;

  app.get('/api/dashboards', { preHandler: auth }, async (req) => {
    const rows = req.auth!.role === 'admin' ? repo.listAll() : repo.listForOwner(req.auth!.userId);
    return rows.map((r) => toDto(r, false));
  });

  app.post('/api/dashboards', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; payload?: unknown; shared?: boolean };
    if (!body.name?.trim()) return reply.code(400).send({ error: '缺少仪表板名称' });
    const payloadErr = validatePayload(body.payload);
    if (payloadErr) return reply.code(payloadErr === 'payload_too_large' ? 413 : 400).send({ error: payloadErr });
    const row = repo.create({
      ownerId: req.auth!.userId,
      name: body.name.trim(),
      payload: JSON.stringify(body.payload),
      shared: body.shared === true && req.auth!.role === 'admin',
    });
    return reply.code(201).send(toDto(row, true));
  });

  app.get('/api/dashboards/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '仪表板不存在' });
    if (!canView(req, row)) return reply.code(403).send({ error: '无权查看该仪表板' });
    return toDto(row, true);
  });

  app.put('/api/dashboards/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '仪表板不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权修改该仪表板' });
    const body = (req.body ?? {}) as { name?: string; payload?: unknown; shared?: boolean };
    let payloadText: string | undefined;
    if (body.payload !== undefined) {
      const payloadErr = validatePayload(body.payload);
      if (payloadErr) return reply.code(payloadErr === 'payload_too_large' ? 413 : 400).send({ error: payloadErr });
      payloadText = JSON.stringify(body.payload);
    }
    const updated = repo.update(id, {
      name: body.name?.trim(),
      payload: payloadText,
      shared: req.auth!.role === 'admin' ? body.shared : undefined,
    });
    return toDto(updated!, true);
  });

  app.delete('/api/dashboards/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = repo.findById(id);
    if (!row) return reply.code(404).send({ error: '仪表板不存在' });
    if (!canManage(req, row)) return reply.code(403).send({ error: '无权删除该仪表板' });
    repo.remove(id);
    return { ok: true };
  });
}
```

- [ ] [server.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/server.ts)：import 区加 `import { dashboardRoutes } from './modules/dashboards/routes.js';`；在 `connectionRoutes(app, {...})` 调用之后加 `dashboardRoutes(app, { db, config, users, sessions });`
- [ ] 运行 `pnpm --filter @hustserver/server test -- dashboards`，确认全绿；再跑 `pnpm --filter @hustserver/server test` 确认无回归
- [ ] Commit：`feat: 仪表板 CRUD 接口`

## Task 3：后端 `modules/data/`（POST /api/data/query，TDD）

**Files**
- Create `apps/server/src/modules/data/query.ts`
- Create `apps/server/src/modules/data/routes.ts`
- Modify [apps/server/src/server.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/server.ts)（import + 注册，紧跟 dashboardRoutes 之后）
- Create `apps/server/test/data-query.test.ts`

**Interfaces**

```ts
// query.ts
export type QueryCell = string | number | boolean | null;
export interface QueryColumn { name: string; type: 'string' | 'number' | 'boolean' | 'date' | 'unknown' }
export interface QueryResult { columns: QueryColumn[]; rows: QueryCell[][]; truncated: boolean }
export async function runQuery(conn: SqlServerConnection, query: string, limit?: number): Promise<QueryResult>;
// 抛错由 routes 统一转 400 {error:'执行 SQL 失败', detail}

// routes.ts
export interface DataRouteDeps { db: Database; config: AppConfig; users: UsersRepo; sessions: SessionsRepo; }
export function dataRoutes(app: FastifyInstance, deps: DataRouteDeps): void;
// POST /api/data/query  body {connectionId, query, limit?} → QueryResult
```

**Steps**
- [ ] 写 `query.ts`（整文件照抄下方代码，mssql 模式对齐 [probe.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/modules/connections/probe.ts)）：

```ts
import sql from 'mssql';
import { buildMssqlConfig, type SqlServerConnection } from '@hustserver/engine';

export type QueryCell = string | number | boolean | null;

export interface QueryColumn {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'unknown';
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: QueryCell[][];
  truncated: boolean;
}

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

/** 按列的首个非空值推断类型（mssql 已返回强类型值；字符串仅识别日期）。 */
function inferColumnType(values: unknown[]): QueryColumn['type'] {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (v instanceof Date) return 'date';
    if (typeof v === 'string') return Number.isNaN(Date.parse(v)) ? 'string' : 'date';
    return 'string';
  }
  return 'unknown';
}

function toCell(v: unknown): QueryCell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

export async function runQuery(conn: SqlServerConnection, query: string, limit?: number): Promise<QueryResult> {
  const cap = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const pool = new sql.ConnectionPool(buildMssqlConfig(conn));
  try {
    await pool.connect();
    const result = await pool.request().query(query);
    const recordset = (result.recordset ?? []) as Array<Record<string, unknown>>;
    const names = Object.keys(result.recordset?.columns ?? recordset[0] ?? {});
    return {
      columns: names.map((name) => ({ name, type: inferColumnType(recordset.map((r) => r[name])) })),
      rows: recordset.slice(0, cap).map((r) => names.map((n) => toCell(r[n]))),
      truncated: recordset.length > cap,
    };
  } finally {
    await pool.close().catch(() => undefined);
  }
}
```

- [ ] 写测试 `apps/server/test/data-query.test.ts`（同款脚手架 + alice 建一个假连接；不依赖真实 SQL Server）：

```ts
async function createConnection(cookie: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/connections', headers: { cookie },
    payload: { name: '测试库', config: { server: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' } },
  });
  return res.json().id as string;
}

describe('POST /api/data/query', () => {
  it('未登录 401', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/data/query', payload: {} })).statusCode).toBe(401);
  });
  it('缺少 connectionId 400 / 缺少 SQL 400', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: aliceCookie }, payload: { query: 'SELECT 1' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: aliceCookie }, payload: { connectionId: 'x' } })).statusCode).toBe(400);
  });
  it('连接不存在 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: aliceCookie }, payload: { connectionId: 'nope', query: 'SELECT 1' } });
    expect(res.statusCode).toBe(404);
  });
  it('他人未共享连接 403', async () => {
    const id = await createConnection(aliceCookie);
    const res = await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: bobCookie }, payload: { connectionId: id, query: 'SELECT 1' } });
    expect(res.statusCode).toBe(403);
  });
  it('共享连接：SQL 执行失败 → 400 执行 SQL 失败（连不上 127.0.0.1:1）', async () => {
    const id = await createConnection(aliceCookie);
    await app.inject({ method: 'PUT', url: `/api/connections/${id}`, headers: { cookie: adminCookie }, payload: { shared: true } });
    const res = await app.inject({ method: 'POST', url: '/api/data/query', headers: { cookie: bobCookie }, payload: { connectionId: id, query: 'SELECT 1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('执行 SQL 失败');
    expect(typeof res.json().detail).toBe('string');
  });
});
```

- [ ] 运行 `pnpm --filter @hustserver/server test -- data-query`，确认失败（红）
- [ ] 写 `routes.ts`：

```ts
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { buildMssqlConfig, type SqlServerConnection } from '@hustserver/engine';
import { requireAuth } from '../../plugins/guards.js';
import type { AppConfig } from '../../config.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { decryptConfig } from '../connections/crypto.js';
import { connectionsRepo } from '../connections/repo.js';
import { runQuery } from './query.js';

export interface DataRouteDeps {
  db: Database;
  config: AppConfig;
  users: UsersRepo;
  sessions: SessionsRepo;
}

export function dataRoutes(app: FastifyInstance, deps: DataRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const repo = connectionsRepo(deps.db);

  // 仪表板专用取数：可见即可用（admin / 共享 / 自有连接）；不做只读校验，仅做行数截断。
  app.post('/api/data/query', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as { connectionId?: string; query?: string; limit?: number };
    if (!body.connectionId) return reply.code(400).send({ error: '缺少连接 ID' });
    if (!body.query?.trim()) return reply.code(400).send({ error: '缺少 SQL 语句' });
    const row = repo.findById(body.connectionId);
    if (!row) return reply.code(404).send({ error: '连接不存在' });
    const canUse = req.auth!.role === 'admin' || row.shared === 1 || row.owner_id === req.auth!.userId;
    if (!canUse) return reply.code(403).send({ error: '无权使用该连接' });
    const conn = decryptConfig(row.config_encrypted, deps.config.encryptionKey) as SqlServerConnection;
    try {
      return await runQuery(conn, body.query.trim(), body.limit);
    } catch (err) {
      return reply.code(400).send({ error: '执行 SQL 失败', detail: (err as Error).message });
    }
  });
}
```

- [ ] [server.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/server/src/server.ts)：import `dataRoutes`，并在 `dashboardRoutes(...)` 之后注册 `dataRoutes(app, { db, config, users, sessions });`
- [ ] 运行 `pnpm --filter @hustserver/server test` 全绿（含全部既有用例）
- [ ] Commit：`feat: 仪表板 SQL 取数接口 /api/data/query`

## Task 4：web 依赖 + `@bi` 别名 + resolveJsonModule

**Files**
- Modify [apps/web/package.json](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/package.json)（pnpm add 生成）
- Modify [apps/web/vite.config.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/vite.config.ts)（resolve.alias 加 `@bi`）
- Modify [apps/web/tsconfig.json](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/tsconfig.json)（paths 加 `@bi/*`；加 `resolveJsonModule: true`）

**Interfaces**

```ts
// vite.config.ts resolve.alias 最终形态
alias: {
  '@': fileURLToPath(new URL('../../packages/workflow-designer/src', import.meta.url)),
  '@bi': fileURLToPath(new URL('./src/features/dashboard', import.meta.url)),
},
// tsconfig.json compilerOptions.paths 最终形态
"paths": {
  "@/*": ["../../packages/workflow-designer/src/*"],
  "@bi/*": ["src/features/dashboard/*"]
}
```

**Steps**
- [ ] 安装依赖（版本必须照抄，勿让 pnpm 自选）：

```bash
pnpm --filter @hustserver/web add "recharts@^2.15.0" "papaparse@^5.4.1" "xlsx@^0.18.5" "sonner@^1.7.2" "zustand@^5.0.3" "lucide-react@^0.471.1" "class-variance-authority@^0.7.1" "clsx@^2.1.1" "tailwind-merge@^3.0.0" "@radix-ui/react-dialog@^1.1.4" "@radix-ui/react-dropdown-menu@^2.1.4" "@radix-ui/react-label@^2.1.1" "@radix-ui/react-scroll-area@^1.2.2" "@radix-ui/react-select@^2.1.4" "@radix-ui/react-separator@^1.1.1" "@radix-ui/react-slot@^1.1.1" "@radix-ui/react-switch@^1.1.2" "@radix-ui/react-tabs@^1.1.2" "@radix-ui/react-tooltip@^1.1.6"
pnpm --filter @hustserver/web add -D "@types/papaparse@^5.3.15"
```

- [ ] 确认 `apps/web/package.json` 中 `tailwind-merge` 为 `^3.x`、`recharts` 为 `^2.15.x`（不符则手改后 `pnpm install`）
- [ ] [vite.config.ts](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/vite.config.ts)：`resolve.alias` 对象内加一行 `'@bi': fileURLToPath(new URL('./src/features/dashboard', import.meta.url)),`（其余不动）
- [ ] [tsconfig.json](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/tsconfig.json)：`paths` 加 `"@bi/*": ["src/features/dashboard/*"]`；`compilerOptions` 加 `"resolveJsonModule": true`
- [ ] 运行 `pnpm --filter @hustserver/web typecheck`，确认 exit 0
- [ ] Commit：`chore: web 引入 BI 依赖并新增 @bi 别名`

## Task 5：搬运基础层（types + lib + assets/geo）并改造

**Files**
- Create `apps/web/src/features/dashboard/types.ts`（**手工重写**，非照抄）
- Create `apps/web/src/features/dashboard/lib/`（aggregate/canvas/chart/columns/csv/datatable/format/geo/highlight/pivot/utils/csv/xlsx，照抄 + 2 个文件小改）
- Create `apps/web/src/features/dashboard/assets/geo/china.json`、`world.json`（照抄）

**Interfaces**

```ts
// csv.ts 改后签名
export function parseCsv(text: string, name: string, def: DatasetDef): Dataset;
// xlsx.ts 改后签名
export function parseExcel(bytes: Uint8Array, name: string, def: DatasetDef): Dataset;
// 其余 lib 文件签名不变
```

**Steps**
- [ ] 若 `/tmp/tinybi` 不存在：`git clone --depth 1 https://github.com/microsoftbi/tinybi /tmp/tinybi`
- [ ] 复制（注意：**不复制** `lib/project.ts`、任何 `*.test.ts`）：

```bash
SRC=/tmp/tinybi/src
DST=/Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/features/dashboard
mkdir -p "$DST/lib" "$DST/assets/geo"
cp "$SRC/types.ts" "$DST/"
cp "$SRC"/lib/aggregate.ts "$SRC"/lib/canvas.ts "$SRC"/lib/chart.ts "$SRC"/lib/columns.ts "$SRC"/lib/datatable.ts "$SRC"/lib/format.ts "$SRC"/lib/geo.ts "$SRC"/lib/highlight.ts "$SRC"/lib/pivot.ts "$SRC"/lib/utils.ts "$SRC"/lib/csv.ts "$SRC"/lib/xlsx.ts "$DST/lib/"
cp "$SRC"/assets/geo/china.json "$SRC"/assets/geo/world.json "$DST/assets/geo/"
# 全局替换 @/ → @bi/（tinybi 源码统一双引号，只处理 " 形式）
grep -rl '"@/' "$DST" | xargs sed -i '' 's|"@/|"@bi/|g'
```

- [ ] **重写** `types.ts` 为以下内容（丢弃 tinybi 的 SqlServerConfig/SavedConnection/PersistedConnection/BiProject/PROJECT_VERSION，见 spec §4）：

```ts
export type CellValue = string | number | boolean | null;
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';

export interface Column {
  name: string;
  type: ColumnType;
}

export type ChartType =
  | 'bar'
  | 'stackedBar'
  | 'stackedBar100'
  | 'horizontalBar'
  | 'horizontalStackedBar'
  | 'line'
  | 'area'
  | 'stackedArea'
  | 'combo'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'treemap'
  | 'funnel'
  | 'radialBar'
  | 'table'
  | 'kpi'
  | 'map'
  | 'matrix';

export type MapRegion = 'auto' | 'china' | 'world';
export type AggregateFn = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'none';

export interface Measure {
  field: string;
  agg: AggregateFn;
}

export interface WidgetEncoding {
  dimension?: string;
  measures: Measure[];
  series?: string;
}

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChartWidget {
  id: string;
  type: ChartType;
  title: string;
  datasetId: string;
  encoding: WidgetEncoding;
  layout: WidgetLayout;
  showTitle?: boolean;
  showLegend?: boolean;
  mapRegion?: MapRegion;
  showTotals?: boolean;
}

export interface Dashboard {
  id: string;
  name: string;
  widgets: ChartWidget[];
}

export interface QueryColumn {
  name: string;
  type: ColumnType;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: CellValue[][];
  truncated: boolean;
}

export type DatasetSource = 'csv' | 'excel' | 'sql';

export type DatasetDef =
  | { kind: 'sql'; connectionId: string; query: string }
  | { kind: 'file'; resourcePath: string; format: 'csv' | 'excel' };

/** 落库的最小单元：只有定义，没有行数据。 */
export interface SavedDataset {
  id: string;
  name: string;
  def: DatasetDef;
}

/** 运行时数据集：在 tinybi 的 Dataset 上多带 def，便于回写定义。 */
export interface Dataset {
  id: string;
  name: string;
  source: DatasetSource;
  columns: Column[];
  rows: CellValue[][];
  createdAt: string;
  def: DatasetDef;
}

/** 落库的 JSON 结构。 */
export interface DashboardPayload {
  version: 2;
  dashboards: Dashboard[];
  activeId: string;
  datasets: SavedDataset[];
}
```

- [ ] 改 `lib/csv.ts`：import 区加 `import type { DatasetDef } from '../types';`（若原文件已有 `import type { Dataset } from '../types';` 则并入该行）；签名改 `export function parseCsv(text: string, name: string, def: DatasetDef): Dataset`；返回对象追加 `def` 字段：

```ts
  return {
    id: uid('ds'),
    name,
    source: 'csv',
    columns,
    rows,
    createdAt: new Date().toISOString(),
    def,
  };
```

- [ ] 改 `lib/xlsx.ts`：同上——加 `import type { DatasetDef } from '../types';`；签名改 `export function parseExcel(bytes: Uint8Array, name: string, def: DatasetDef): Dataset`；返回对象追加 `def` 字段（结构与 csv 相同，`source: 'excel'`）
- [ ] 确认 `lib/geo.ts` 中动态导入已是 `import('@bi/assets/geo/china.json')` / `import('@bi/assets/geo/world.json')`（sed 已替换；grep 验证）
- [ ] 验证：`grep -rn '"@/' apps/web/src/features/dashboard` 无输出；`pnpm --filter @hustserver/web typecheck` exit 0
- [ ] Commit：`feat: 搬运 tinybi 基础层（types/lib/geo 资源）并接入数据集定义`

## Task 6：搬运 UI 基元（components/ui 15 个 + DataTable）

**Files**
- Create `apps/web/src/features/dashboard/components/ui/`：badge/button/card/dialog/dropdown-menu/input/label/scroll-area/select/separator/switch/table/tabs/textarea/tooltip（15 个 .tsx，照抄）
- Create `apps/web/src/features/dashboard/components/DataTable.tsx`（照抄）

**Interfaces**

- 全部为 tinybi 原文签名（Button/Input/Label/Dialog*/Select*/Tabs*/…）；唯一改动是 import 路径 `@/lib/utils` → `@bi/lib/utils`（sed 完成）

**Steps**
- [ ] 复制 + sed：

```bash
SRC=/tmp/tinybi/src
DST=/Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/features/dashboard
mkdir -p "$DST/components/ui"
cp "$SRC"/components/ui/badge.tsx "$SRC"/components/ui/button.tsx "$SRC"/components/ui/card.tsx "$SRC"/components/ui/dialog.tsx "$SRC"/components/ui/dropdown-menu.tsx "$SRC"/components/ui/input.tsx "$SRC"/components/ui/label.tsx "$SRC"/components/ui/scroll-area.tsx "$SRC"/components/ui/select.tsx "$SRC"/components/ui/separator.tsx "$SRC"/components/ui/switch.tsx "$SRC"/components/ui/table.tsx "$SRC"/components/ui/tabs.tsx "$SRC"/components/ui/textarea.tsx "$SRC"/components/ui/tooltip.tsx "$DST/components/ui/"
cp "$SRC"/components/DataTable.tsx "$DST/components/"
grep -rl '"@/' "$DST/components" | xargs sed -i '' 's|"@/|"@bi/|g'
```

- [ ] 验证：`grep -rn '"@/' apps/web/src/features/dashboard/components` 无输出；`pnpm --filter @hustserver/web typecheck` exit 0
- [ ] Commit：`feat: 搬运 tinybi UI 基元与 DataTable`

## Task 7：stores（dashboardStore 原样 / datasetStore + 错误态）+ services/dataSource.ts

**Files**
- Create `apps/web/src/features/dashboard/stores/dashboardStore.ts`（照抄 + sed）
- Create `apps/web/src/features/dashboard/stores/datasetStore.ts`（**重写**）
- Create `apps/web/src/features/dashboard/services/dataSource.ts`（**新写**）

**Interfaces**

```ts
// datasetStore.ts（在 tinybi 基础上加错误态与 reset）
export interface DatasetStoreState {
  datasets: Dataset[];
  /** hydrate 失败的数据集：savedDataset.id → 错误消息（本体不在 datasets 里） */
  errors: Record<string, string>;
  setDatasets(datasets: Dataset[]): void;
  addDataset(dataset: Dataset): void;      // 同 id 覆盖（重试成功后回填）
  removeDataset(id: string): void;
  setError(id: string, message: string): void;
  clearError(id: string): void;
  reset(): void;                            // datasets: [], errors: {}
}
export const useDatasetStore = create<DatasetStoreState>(...);

// services/dataSource.ts（唯一取数出口）
export function datasetFromQueryResult(name: string, connectionId: string, query: string, result: QueryResult): Dataset;
export async function querySqlDataset(name: string, connectionId: string, query: string): Promise<Dataset>;
export async function loadFileDataset(name: string, resourcePath: string): Promise<Dataset>;
export async function hydrateDataset(saved: SavedDataset): Promise<Dataset>; // 返回 {...ds, id: saved.id}
```

**Steps**
- [ ] 复制 dashboardStore 并 sed：

```bash
SRC=/tmp/tinybi/src
DST=/Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/features/dashboard
mkdir -p "$DST/stores" "$DST/services"
cp "$SRC"/stores/dashboardStore.ts "$DST/stores/"
grep -l '"@/' "$DST/stores/dashboardStore.ts" | xargs sed -i '' 's|"@/|"@bi/|g'
```

- [ ] **重写** `datasetStore.ts` 为：

```ts
import { create } from 'zustand';
import type { Dataset } from '../types';

interface DatasetStoreState {
  datasets: Dataset[];
  /** hydrate 失败的数据集：savedDataset.id → 错误消息（本体不在 datasets 里） */
  errors: Record<string, string>;
  setDatasets: (datasets: Dataset[]) => void;
  addDataset: (dataset: Dataset) => void;
  removeDataset: (id: string) => void;
  setError: (id: string, message: string) => void;
  clearError: (id: string) => void;
  reset: () => void;
}

export const useDatasetStore = create<DatasetStoreState>((set) => ({
  datasets: [],
  errors: {},
  setDatasets: (datasets) => set({ datasets }),
  // 同 id 覆盖：hydrate 重试成功后回填同一份数据集
  addDataset: (dataset) =>
    set((s) => ({ datasets: [...s.datasets.filter((d) => d.id !== dataset.id), dataset] })),
  removeDataset: (id) =>
    set((s) => ({ datasets: s.datasets.filter((d) => d.id !== id) })),
  setError: (id, message) => set((s) => ({ errors: { ...s.errors, [id]: message } })),
  clearError: (id) =>
    set((s) => {
      const errors = { ...s.errors };
      delete errors[id];
      return { errors };
    }),
  reset: () => set({ datasets: [], errors: {} }),
}));
```

- [ ] **新写** `services/dataSource.ts`：

```ts
import { api } from '../../api.js';
import { buildColumns, coerceRows, dedupeHeaders } from '../lib/columns';
import { uid } from '../lib/utils';
import { parseCsv } from '../lib/csv';
import { parseExcel } from '../lib/xlsx';
import type { Dataset, DatasetDef, QueryResult, SavedDataset } from '../types';

/**
 * 把一次 SQL 查询结果转成数据集（供对话框预览复用，避免二次执行查询）。
 */
export function datasetFromQueryResult(
  name: string,
  connectionId: string,
  query: string,
  result: QueryResult,
): Dataset {
  const headers = dedupeHeaders(result.columns.map((c) => c.name));
  const columns = buildColumns(headers, result.rows);
  const rows = coerceRows(result.rows, columns);
  return {
    id: uid('ds'),
    name,
    source: 'sql',
    columns,
    rows,
    createdAt: new Date().toISOString(),
    def: { kind: 'sql', connectionId, query },
  };
}

export async function querySqlDataset(name: string, connectionId: string, query: string): Promise<Dataset> {
  const result = await api.post<QueryResult>('/api/data/query', {
    body: { connectionId, query },
  });
  return datasetFromQueryResult(name, connectionId, query, result);
}

export async function loadFileDataset(name: string, resourcePath: string): Promise<Dataset> {
  const res = await fetch(`/api/resources/files/download?path=${encodeURIComponent(resourcePath)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`读取资源文件失败（${res.status}）`);
  const lower = resourcePath.toLowerCase();
  let def: DatasetDef;
  if (lower.endsWith('.csv')) {
    def = { kind: 'file', resourcePath, format: 'csv' };
    return parseCsv(await res.text(), name, def);
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    def = { kind: 'file', resourcePath, format: 'excel' };
    return parseExcel(new Uint8Array(await res.arrayBuffer()), name, def);
  }
  throw new Error('仅支持 CSV / Excel 文件');
}

/** 打开仪表板时按落库定义重新取数；固定回写 saved.id，保证 widget.datasetId 引用稳定。 */
export async function hydrateDataset(saved: SavedDataset): Promise<Dataset> {
  const ds =
    saved.def.kind === 'sql'
      ? await querySqlDataset(saved.name, saved.def.connectionId, saved.def.query)
      : await loadFileDataset(saved.name, saved.def.resourcePath);
  return { ...ds, id: saved.id };
}
```

- [ ] 验证：`pnpm --filter @hustserver/web typecheck` exit 0
- [ ] Commit：`feat: 仪表板状态存储与取数服务`

## Task 8：index.css 追加 `.vbi-*` 画布样式

**Files**
- Modify [apps/web/src/index.css](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/index.css)（文件末尾追加）

**Interfaces**

- ReportCanvas.tsx 依赖的三类：`.vbi-handle`（含 8 个 `[data-dir]` 变体）、`.vbi-guide-v`、`.vbi-guide-h`

**Steps**
- [ ] 在 [index.css](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/index.css) 末尾追加（照抄 tinybi `src/index.css` L68-147，仅 `hsl(var(--background))` → `var(--background)`）：

```css
/* 报表画布：选中视觉对象的 8 向缩放手柄（源自 tinybi，对齐 Power BI） */
.vbi-handle {
  position: absolute;
  width: 9px;
  height: 9px;
  background: var(--background);
  border: 1.5px solid #2563eb;
  border-radius: 2px;
  z-index: 30;
}
.vbi-handle[data-dir='n'] {
  left: 50%;
  top: 0;
  transform: translate(-50%, -50%);
  cursor: n-resize;
}
.vbi-handle[data-dir='s'] {
  left: 50%;
  bottom: 0;
  transform: translate(-50%, 50%);
  cursor: s-resize;
}
.vbi-handle[data-dir='e'] {
  top: 50%;
  right: 0;
  transform: translate(50%, -50%);
  cursor: e-resize;
}
.vbi-handle[data-dir='w'] {
  top: 50%;
  left: 0;
  transform: translate(-50%, -50%);
  cursor: w-resize;
}
.vbi-handle[data-dir='ne'] {
  right: 0;
  top: 0;
  transform: translate(50%, -50%);
  cursor: ne-resize;
}
.vbi-handle[data-dir='nw'] {
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  cursor: nw-resize;
}
.vbi-handle[data-dir='se'] {
  right: 0;
  bottom: 0;
  transform: translate(50%, 50%);
  cursor: se-resize;
}
.vbi-handle[data-dir='sw'] {
  left: 0;
  bottom: 0;
  transform: translate(-50%, 50%);
  cursor: sw-resize;
}

/* 拖动/缩放时的对齐辅助线 */
.vbi-guide-v {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  margin-left: -0.5px;
  background: #e11d48;
  z-index: 40;
  pointer-events: none;
}
.vbi-guide-h {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  margin-top: -0.5px;
  background: #e11d48;
  z-index: 40;
  pointer-events: none;
}
```

- [ ] 验证：`pnpm --filter @hustserver/web build` exit 0
- [ ] Commit：`feat: 补充仪表板画布手柄与对齐线样式`

## Task 9：搬运 features/dashboard 8 文件 + 适配（文案 / onAddDataset 透传）

**Files**
- Create `apps/web/src/features/dashboard/`：DashboardView.tsx / ReportCanvas.tsx / ChartRenderer.tsx / VisualizationsPane.tsx / FieldsPane.tsx / MapChart.tsx / PivotTable.tsx / chartIcons.tsx（照抄 + sed + 指定小改）

**Interfaces**

```ts
// DashboardView 改后签名（新增可选 prop 透传给 FieldsPane）
export function DashboardView({ onAddDataset }: { onAddDataset?: () => void } = {}): JSX.Element;
// FieldsPane 改后签名（新增可选 prop）
export function FieldsPane({ datasets, datasetId, onSelectDataset, onPickField, onAddDataset, grow = 2, className }: FieldsPaneProps): JSX.Element;
// 其余 6 文件签名不变
```

**Steps**
- [ ] 复制 + sed：

```bash
SRC=/tmp/tinybi/src
DST=/Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/features/dashboard
cp "$SRC"/features/dashboard/DashboardView.tsx "$SRC"/features/dashboard/ReportCanvas.tsx "$SRC"/features/dashboard/ChartRenderer.tsx "$SRC"/features/dashboard/VisualizationsPane.tsx "$SRC"/features/dashboard/FieldsPane.tsx "$SRC"/features/dashboard/MapChart.tsx "$SRC"/features/dashboard/PivotTable.tsx "$SRC"/features/dashboard/chartIcons.tsx "$DST/"
grep -rl '"@/' "$DST" --include='*.tsx' | xargs sed -i '' 's|"@/|"@bi/|g'
```

- [ ] 文案适配 3 处（原文引用已删除的「数据源」页面）：
  - [ ] `DashboardView.tsx` L134：`toast.error("请先在「数据源」导入数据")` → `toast.error("请先点击「数据」窗格的 ＋ 添加数据集")`
  - [ ] `ReportCanvas.tsx` L281：`"请先在「数据源」导入数据，再新建图表"` → `"请先点击「数据」窗格的 ＋ 添加数据集，再新建图表"`
  - [ ] `FieldsPane.tsx` L103：`尚未导入数据，请先在「数据源」导入 CSV / Excel。` → `尚无数据集，点击上方「＋ 添加数据集」导入。`
- [ ] `FieldsPane.tsx` 三处小改：
  - [ ] lucide 导入列表加 `Plus`（加进 `Calendar, ChevronDown, Hash, Search, ToggleLeft, Type` 中）
  - [ ] `FieldsPaneProps` 加一行 `onAddDataset?: () => void;`，解构参数列表同步加 `onAddDataset,`
  - [ ] header（`<span className="flex-1 text-sm font-semibold">数据</span>` 之后、行数 `<span>` 之前）插入：

```tsx
        <button
          type="button"
          aria-label="添加数据集"
          title="添加数据集"
          onClick={() => onAddDataset?.()}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <Plus className="h-4 w-4" />
        </button>
```

- [ ] `DashboardView.tsx` 两处小改：
  - [ ] 签名 L43：`export function DashboardView() {` → `export function DashboardView({ onAddDataset }: { onAddDataset?: () => void } = {}) {`
  - [ ] FieldsPane 用法（L288-295）加一行 prop：`onAddDataset={onAddDataset}`
- [ ] 验证：`grep -rn '"数据源"' apps/web/src/features/dashboard` 无输出；`pnpm --filter @hustserver/web typecheck` exit 0（若 recharts 相关类型报错，见 Global Constraints #4 的备选路径）
- [ ] Commit：`feat: 搬运 tinybi 仪表板核心组件并适配数据集入口`

## Task 10：数据源对话框 DataSourceDialog（新写）

**Files**
- Create `apps/web/src/features/dashboard/DataSourceDialog.tsx`

**Interfaces**

```ts
export interface DataSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 存为数据集回调（父级负责 addDataset + 关闭 + toast） */
  onSaved: (dataset: Dataset) => void;
}
```

**Steps**
- [ ] 新写 `DataSourceDialog.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Textarea } from './components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { DataTable } from './components/DataTable';
import { api, ApiClientError } from '../../api.js';
import { datasetFromQueryResult, loadFileDataset } from './services/dataSource';
import type { Dataset, QueryResult } from './types';

interface DataSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (dataset: Dataset) => void;
}

interface ResourceFile {
  name: string;
  path: string;
  size: number;
}

function errText(err: unknown): string {
  if (err instanceof ApiClientError && err.detail) return err.detail;
  return (err as Error).message;
}

export function DataSourceDialog({ open, onOpenChange, onSaved }: DataSourceDialogProps) {
  const [msgBox, setMsgBox] = useState<{ title: string; msg: string } | null>(null);
  // SQL Tab
  const [connections, setConnections] = useState<Array<{ id: string; name: string }>>([]);
  const [connectionId, setConnectionId] = useState('');
  const [sqlText, setSqlText] = useState('SELECT TOP 100 * FROM ');
  const [sqlPreview, setSqlPreview] = useState<Dataset | null>(null);
  const [sqlTruncated, setSqlTruncated] = useState(false);
  const [datasetName, setDatasetName] = useState('');
  const [running, setRunning] = useState(false);
  // 文件 Tab
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [filePreview, setFilePreview] = useState<Dataset | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileLabel, setFileLabel] = useState('');

  // msgBox 支持 Esc 关闭（与 ConnectionsPage 的 msgBox 行为一致）
  useEffect(() => {
    if (!msgBox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMsgBox(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [msgBox]);

  // 打开时拉取连接列表与资源文件列表
  useEffect(() => {
    if (!open) return;
    setSqlPreview(null);
    setSqlTruncated(false);
    setFilePreview(null);
    setDatasetName('');
    setMsgBox(null);
    void (async () => {
      try {
        const list = await api.get<Array<{ id: string; name: string }>>('/api/connections');
        setConnections(list);
        setConnectionId((cur) => cur || list[0]?.id || '');
      } catch {
        setConnections([]);
      }
      try {
        const tree = await api.get<{ files: ResourceFile[] }>('/api/resources/tree');
        setFiles(tree.files.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name)));
      } catch {
        setFiles([]);
      }
    })();
  }, [open]);

  async function runSql() {
    if (!connectionId) {
      setMsgBox({ title: '执行失败', msg: '请先选择连接' });
      return;
    }
    if (!sqlText.trim()) {
      setMsgBox({ title: '执行失败', msg: '请输入 SQL 语句' });
      return;
    }
    setRunning(true);
    try {
      const result = await api.post<QueryResult>('/api/data/query', {
        body: { connectionId, query: sqlText.trim(), limit: 100 },
      });
      setSqlPreview(datasetFromQueryResult('SQL 数据集', connectionId, sqlText.trim(), result));
      setSqlTruncated(result.truncated);
    } catch (err) {
      setSqlPreview(null);
      setMsgBox({ title: '执行失败', msg: errText(err) });
    } finally {
      setRunning(false);
    }
  }

  async function loadFile() {
    if (!selectedPath) return;
    setFileLoading(true);
    try {
      const file = files.find((f) => f.path === selectedPath);
      const ds = await loadFileDataset(file?.name ?? '文件数据集', selectedPath);
      setFilePreview(ds);
      setFileLabel(file?.name ?? selectedPath);
    } catch (err) {
      setFilePreview(null);
      setMsgBox({ title: '载入失败', msg: errText(err) });
    } finally {
      setFileLoading(false);
    }
  }

  function saveSql() {
    if (!sqlPreview) return;
    const name = datasetName.trim();
    if (!name) {
      setMsgBox({ title: '保存失败', msg: '请填写数据集名称' });
      return;
    }
    onSaved({ ...sqlPreview, name });
  }

  function saveFile() {
    if (!filePreview) return;
    const name = datasetName.trim();
    if (!name) {
      setMsgBox({ title: '保存失败', msg: '请填写数据集名称' });
      return;
    }
    onSaved({ ...filePreview, name });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>添加数据集</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="sql">
          <TabsList>
            <TabsTrigger value="sql">从连接（SQL）</TabsTrigger>
            <TabsTrigger value="file">从资源库（CSV/Excel）</TabsTrigger>
          </TabsList>

          <TabsContent value="sql" className="space-y-3">
            <div className="space-y-1.5">
              <Label>连接</Label>
              <Select value={connectionId} onValueChange={setConnectionId}>
                <SelectTrigger className="w-72">
                  <SelectValue placeholder={connections.length === 0 ? '暂无可用连接' : '选择连接'} />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>SQL</Label>
              <Textarea rows={4} value={sqlText} onChange={(e) => setSqlText(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={running} onClick={() => void runSql()}>
                {running ? '执行中…' : '执行'}
              </Button>
              {sqlTruncated ? <span className="text-xs text-slate-500">预览仅显示前 100 行</span> : null}
            </div>
            {sqlPreview ? (
              <div className="space-y-2">
                <div className="max-h-64 overflow-auto rounded border">
                  <DataTable columns={sqlPreview.columns} rows={sqlPreview.rows} />
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="ds-name">数据集名称</Label>
                    <Input id="ds-name" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
                  </div>
                  <Button onClick={saveSql}>存为数据集</Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">执行 SQL 后在此预览结果。</p>
            )}
          </TabsContent>

          <TabsContent value="file" className="space-y-3">
            <div className="space-y-1.5">
              <Label>资源文件</Label>
              <Select value={selectedPath} onValueChange={setSelectedPath}>
                <SelectTrigger className="w-72">
                  <SelectValue placeholder={files.length === 0 ? '资源库暂无 CSV/Excel' : '选择文件'} />
                </SelectTrigger>
                <SelectContent>
                  {files.map((f) => (
                    <SelectItem key={f.path} value={f.path}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" disabled={!selectedPath || fileLoading} onClick={() => void loadFile()}>
              {fileLoading ? '载入中…' : '载入'}
            </Button>
            {filePreview ? (
              <div className="space-y-2">
                <div className="max-h-64 overflow-auto rounded border">
                  <DataTable columns={filePreview.columns} rows={filePreview.rows} />
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1.5">
                    <Label htmlFor="file-ds-name">数据集名称</Label>
                    <Input id="file-ds-name" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} placeholder={fileLabel} />
                  </div>
                  <Button onClick={saveFile}>存为数据集</Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">选择文件并载入后在此预览。</p>
            )}
          </TabsContent>
        </Tabs>

        {msgBox && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setMsgBox(null)}>
            <div className="w-full max-w-sm rounded bg-white p-4 text-sm shadow-lg" onClick={(e) => e.stopPropagation()}>
              <h2 className="font-medium">{msgBox.title}</h2>
              <p className="mt-2 break-all text-red-600">{msgBox.msg}</p>
              <div className="mt-4 flex justify-end">
                <button type="button" className="rounded bg-blue-600 px-4 py-1.5 text-white" onClick={() => setMsgBox(null)}>
                  确定
                </button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] 验证：`pnpm --filter @hustserver/web typecheck` exit 0（若 DataTable props 报错，以 `apps/web/src/features/dashboard/components/DataTable.tsx` 实际 props 为准修正调用，不得改 DataTable 本体）
- [ ] Commit：`feat: 数据源对话框（SQL 连接 / 资源库文件）`

## Task 11：列表页 + 编辑器页（新写）

**Files**
- Create `apps/web/src/features/dashboard/DashboardListPage.tsx`
- Create `apps/web/src/features/dashboard/DashboardEditorPage.tsx`

**Interfaces**

```tsx
// DashboardListPage —— /dashboards，套 Layout；风格对齐 WorkflowListPage
export function DashboardListPage(): JSX.Element;
// DashboardEditorPage —— /dashboards/:id，独立全屏（Layout 外）
export function DashboardEditorPage(): JSX.Element;
```

**Steps**
- [ ] 新写 `DashboardListPage.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.js';
import { uid } from './lib/utils';
import type { DashboardPayload } from './types';

interface DashboardSummary {
  id: string;
  name: string;
  shared: boolean;
  owner_id: string | null;
  updated_at: number;
}

function makeInitialPayload(): DashboardPayload {
  const dash = { id: uid('dash'), name: '仪表盘 1', widgets: [] };
  return { version: 2, dashboards: [dash], activeId: dash.id, datasets: [] };
}

export function DashboardListPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<DashboardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renameTarget, setRenameTarget] = useState<DashboardSummary | null>(null);
  const [renameName, setRenameName] = useState('');

  async function load() {
    try {
      setItems(await api.get<DashboardSummary[]>('/api/dashboards'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    const name = createName.trim();
    if (!name) return;
    try {
      const created = await api.post<DashboardSummary & { payload: DashboardPayload }>('/api/dashboards', {
        body: { name, payload: makeInitialPayload() },
      });
      setCreateOpen(false);
      setCreateName('');
      navigate(`/dashboards/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function rename() {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) return;
    await api.put(`/api/dashboards/${renameTarget.id}`, { body: { name } });
    setRenameTarget(null);
    await load();
  }

  async function remove(row: DashboardSummary) {
    if (!window.confirm(`确定删除仪表板「${row.name}」？`)) return;
    await api.del(`/api/dashboards/${row.id}`);
    await load();
  }

  async function toggleShared(row: DashboardSummary) {
    await api.put(`/api/dashboards/${row.id}`, { body: { shared: !row.shared } });
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">仪表板</h1>
        <button className="rounded bg-blue-600 px-3 py-1.5 text-white" onClick={() => setCreateOpen(true)}>
          新建仪表板
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full border text-left text-sm">
        <thead className="bg-slate-100">
          <tr>
            <th className="p-2">名称</th>
            <th className="p-2">共享</th>
            <th className="p-2">更新时间</th>
            <th className="p-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-2">
                <Link className="text-blue-600 underline" to={`/dashboards/${row.id}`}>
                  {row.name}
                </Link>
              </td>
              <td className="p-2">{row.shared ? '是' : '否'}</td>
              <td className="p-2">{new Date(row.updated_at).toLocaleString()}</td>
              <td className="space-x-2 p-2">
                <Link className="text-blue-600 underline" to={`/dashboards/${row.id}`}>
                  打开
                </Link>
                <button
                  className="text-blue-600"
                  onClick={() => {
                    setRenameTarget(row);
                    setRenameName(row.name);
                  }}
                >
                  重命名
                </button>
                {user?.role === 'admin' && (
                  <button className="text-blue-600" onClick={() => void toggleShared(row)}>
                    {row.shared ? '取消共享' : '共享'}
                  </button>
                )}
                <button className="text-red-600" onClick={() => void remove(row)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td className="p-2 text-slate-500" colSpan={4}>
                暂无仪表板，点击右上角「新建仪表板」。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCreateOpen(false)}>
          <div className="w-full max-w-sm rounded bg-white p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-medium">新建仪表板</h2>
            <input
              className="mt-3 w-full rounded border px-3 py-1.5 text-sm"
              placeholder="仪表板名称"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border px-4 py-1.5" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button className="rounded bg-blue-600 px-4 py-1.5 text-white" onClick={() => void create()}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setRenameTarget(null)}>
          <div className="w-full max-w-sm rounded bg-white p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-medium">重命名仪表板</h2>
            <input
              className="mt-3 w-full rounded border px-3 py-1.5 text-sm"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void rename()}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border px-4 py-1.5" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button className="rounded bg-blue-600 px-4 py-1.5 text-white" onClick={() => void rename()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] 新写 `DashboardEditorPage.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { api, ApiClientError } from '../../api.js';
import { DashboardView } from './DashboardView';
import { DataSourceDialog } from './DataSourceDialog';
import { hydrateDataset } from './services/dataSource';
import { useDashboardStore } from './stores/dashboardStore';
import { useDatasetStore } from './stores/datasetStore';
import type { DashboardPayload, Dataset, SavedDataset } from './types';

export function DashboardEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [rowName, setRowName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** 服务端最近一次已知状态：保存时作为 datasets 合并的底（保留失败/未 hydrate 数据集的定义） */
  const loadedRef = useRef<DashboardPayload | null>(null);

  const errors = useDatasetStore((s) => s.errors);

  const save = useCallback(async () => {
    if (!id) return;
    try {
      setSaving(true);
      const dash = useDashboardStore.getState();
      const data = useDatasetStore.getState();
      const merged = new Map<string, SavedDataset>((loadedRef.current?.datasets ?? []).map((d) => [d.id, d]));
      for (const ds of data.datasets) merged.set(ds.id, { id: ds.id, name: ds.name, def: ds.def });
      const payload: DashboardPayload = {
        version: 2,
        dashboards: dash.dashboards,
        activeId: dash.activeId,
        datasets: [...merged.values()],
      };
      await api.put(`/api/dashboards/${id}`, { body: { payload } });
      loadedRef.current = payload;
      setSavedAt(new Date().toLocaleTimeString());
      toast.success('已保存');
    } catch (err) {
      const msg = err instanceof ApiClientError ? `${err.message}${err.detail ? `（${err.detail}）` : ''}` : (err as Error).message;
      toast.error(`保存失败：${msg}`);
    } finally {
      setSaving(false);
    }
  }, [id]);

  // 加载：payload → stores → 并行 hydrate 数据集
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      useDashboardStore.getState().reset();
      useDatasetStore.getState().reset();
      try {
        const row = await api.get<{ id: string; name: string; payload: DashboardPayload }>(`/api/dashboards/${id}`);
        if (cancelled) return;
        setRowName(row.name);
        loadedRef.current = row.payload;
        useDashboardStore.getState().setDashboards(row.payload.dashboards);
        useDashboardStore.getState().setActive(row.payload.activeId);
        await Promise.all(
          row.payload.datasets.map(async (saved) => {
            try {
              const ds = await hydrateDataset(saved);
              if (cancelled) return;
              useDatasetStore.getState().addDataset(ds);
              useDatasetStore.getState().clearError(saved.id);
            } catch (err) {
              if (cancelled) return;
              useDatasetStore.getState().setError(saved.id, (err as Error).message);
            }
          }),
        );
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Ctrl/Cmd+S 保存
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  async function retry(savedId: string) {
    const saved = loadedRef.current?.datasets.find((d) => d.id === savedId);
    if (!saved) return;
    try {
      const ds = await hydrateDataset(saved);
      useDatasetStore.getState().addDataset(ds);
      useDatasetStore.getState().clearError(savedId);
      toast.success(`数据集「${saved.name}」已重新取数`);
    } catch (err) {
      useDatasetStore.getState().setError(savedId, (err as Error).message);
    }
  }

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-50">
        <p className="text-sm text-red-600">加载失败：{loadError}</p>
        <Link className="text-sm text-blue-600 underline" to="/dashboards">
          返回列表
        </Link>
      </div>
    );
  }

  const errorEntries = Object.entries(errors);

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex shrink-0 items-center gap-3 border-b bg-white px-4 py-2">
        <Link className="text-sm text-slate-600 hover:underline" to="/dashboards">
          ← 返回列表
        </Link>
        <span className="font-medium">{rowName || '仪表板'}</span>
        {savedAt && <span className="text-xs text-slate-500">已保存于 {savedAt}</span>}
        <button
          className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </header>
      {errorEntries.length > 0 && (
        <div className="shrink-0 space-y-1 bg-red-50 px-4 py-2 text-sm text-red-700">
          {errorEntries.map(([dsId, msg]) => {
            const saved = loadedRef.current?.datasets.find((d) => d.id === dsId);
            return (
              <div key={dsId} className="flex items-center gap-2">
                <span>
                  数据集「{saved?.name ?? dsId}」不可用：{msg}
                </span>
                <button className="underline" onClick={() => void retry(dsId)}>
                  重试
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DashboardView onAddDataset={() => setDialogOpen(true)} />
      </div>
      <DataSourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={(ds: Dataset) => {
          useDatasetStore.getState().addDataset(ds);
          setDialogOpen(false);
          toast.success(`已添加数据集「${ds.name}」`);
        }}
      />
      <Toaster position="bottom-left" />
    </div>
  );
}
```

- [ ] 搬运确认：tinybi 的 `dashboardStore.ts` 原文含 `reset` 方法（`DashboardState` 接口内），编辑器加载流程依赖它清空跨仪表板的残留状态；若 grep 发现缺失则补一个 `reset: () => set({ dashboards: [makeDashboard('仪表盘 1')], activeId: ... })` 等价实现
- [ ] 验证：`pnpm --filter @hustserver/web typecheck` exit 0；`pnpm --filter @hustserver/web build` exit 0
- [ ] Commit：`feat: 仪表板列表页与全屏编辑器`

## Task 12：路由与入口（App / Layout / HomePage）

**Files**
- Modify [apps/web/src/App.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/App.tsx)
- Modify [apps/web/src/components/Layout.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/components/Layout.tsx)（L16 之后插一行）
- Modify [apps/web/src/pages/HomePage.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/pages/HomePage.tsx)（网格里加一张卡片）

**Interfaces**

- 路由：Layout 内 `/dashboards`（列表）；Layout 外 `/dashboards/:id`（编辑器，RequireAuth，与 `/workflows/:id/designer` 同款独立全屏）

**Steps**
- [ ] App.tsx：import 区加

```tsx
import { DashboardListPage } from './features/dashboard/DashboardListPage.js';
import { DashboardEditorPage } from './features/dashboard/DashboardEditorPage.js';
```

- [ ] App.tsx：在 `/workflows/:id/designer` 路由（L26-33）之后插入

```tsx
          <Route
            path="/dashboards/:id"
            element={
              <RequireAuth>
                <DashboardEditorPage />
              </RequireAuth>
            }
          />
```

- [ ] App.tsx：Layout 内子路由 `<Route path="/workflows" .../>`（L42）之后插入 `<Route path="/dashboards" element={<DashboardListPage />} />`
- [ ] Layout.tsx：L16「工作流」NavLink 之后插入 `<NavLink to="/dashboards" className={linkClass}>仪表板</NavLink>`
- [ ] HomePage.tsx：网格中「工作流」卡片（L10-13）之后插入

```tsx
        <Link className="rounded border bg-white p-4 hover:border-blue-500" to="/dashboards">
          <div className="font-medium">仪表板</div>
          <div className="text-sm text-slate-500">19 种视觉对象的数据看板</div>
        </Link>
```

- [ ] 验证：`pnpm --filter @hustserver/web build` exit 0
- [ ] Commit：`feat: 接入仪表板导航、首页卡片与路由`

## Task 13：双端构建 + 测试全绿 + 重启后端

**Files**
- 无代码改动（验证任务）

**Steps**
- [ ] `pnpm --filter @hustserver/server build` exit 0
- [ ] `pnpm --filter @hustserver/web build` exit 0（注意 tsc 前置；若 recharts 2.15 与 React 19 类型冲突在此暴露 → 走 Global Constraints #4 备选路径后重跑）
- [ ] `pnpm --filter @hustserver/server test` 全绿（既有 153 项 + 新增 dashboards/data-query 用例，零回归）
- [ ] 重启后端：用 StopCommand 停掉现有后端进程（**禁用 kill/pkill**），再于仓库根以完整环境变量启动：

```bash
SESSION_SECRET=please-change-me ENCRYPTION_KEY=0123456789abcdef0123456789abcdef HUSTSERVER_PORT=8787 BOOTSTRAP_ADMIN_USER=admin BOOTSTRAP_ADMIN_PASSWORD=admin1234 ICUBE_DATABASE_BACKUP_INTERVAL=300000 ICUBE_ENABLE_DATABASE_BACKUP=0 pnpm --filter @hustserver/server dev
```

- [ ] 浏览器访问 `http://127.0.0.1:5173`（vite dev 代理 /api → 8787）或 `http://127.0.0.1:8787`（静态托管），确认登录后无白屏
- [ ] Commit：无（纯验证；若中途有修复则修复单独 commit）

## Task 14：浏览器端到端验证（spec §9 清单）+ payload 安全检查

**Files**
- 无代码改动（验证任务）

**Steps**（用 TRAE-browseruse skill 驱动浏览器；登录 admin/admin1234）
- [ ] 准备数据：若资源库无 CSV，先经「资源管理」上传测试 CSV（首列类别 + 数值列，≥ 5 行）
- [ ] 导航栏出现「仪表板」；首页出现入口卡片；点击均可到 `/dashboards`
- [ ] `/dashboards`：新建「测试看板」→ 自动跳进 `/dashboards/:id` 编辑器（独立全屏，无顶部导航）
- [ ] 「数据」窗格点 ＋ 添加数据集 → 「从资源库」Tab → 选中 CSV → 载入 → 预览有数据 → 命名 → 存为数据集
- [ ] 新建图表（柱形）→ 拖字段入维度/度量井 → 图表渲染正确
- [ ] 依次切换图表类型验证渲染：折线、饼图、KPI、表格、透视表、地图（中国填充）
- [ ] 拖拽移动 widget → 8 向缩放 → 靠近其它 widget 时出现红色对齐线（吸附）
- [ ] 页签栏 ＋ 新建第二个「仪表盘 2」→ 在其中建一个图表 → 切回「仪表盘 1」图表仍在
- [ ] 交叉高亮：点击某图元 → 其它 widget 变暗 → Esc 清除
- [ ] 保存（点按钮与 Ctrl/Cmd+S 各试一次）→ 出现「已保存于 …」
- [ ] 返回列表 → 重新打开该仪表板 → 页签 / widget 布局 / 数据集均恢复且数据重新取到（非空）
- [ ] 失败降级：删除所用连接（若测过 SQL 数据集）或改资源文件名后重开仪表板 → 顶部红色错误条出现 + widget 占位「数据集已丢失，请重新配置」→ 点「重试」（恢复文件后）数据集恢复
- [ ] 权限抽查（可选，若建了普通用户）：普通用户看不到他人未共享仪表板；共享后可见且不可改
- [ ] payload 安全检查：浏览器 DevTools Network 抓 PUT `/api/dashboards/:id` 请求体——断言不含连接密码、`datasets[]` 内只有 `def`（无 `rows`/`columns` 行数据）
- [ ] 全部通过后 Commit：无（验证任务；若有修复则修复单独 commit）

---

## 验证清单（与 spec §9 对应）

| spec §9 | 任务 |
|---|---|
| ① 双端 build exit 0 | Task 13 |
| ② server test 全绿（153 项不回归） | Task 13 |
| ③ 浏览器端到端（导航/卡片/新建/数据集/图表/拖拽/多页签/保存恢复/交叉高亮/SQL 取数） | Task 14 |
| ④ payload 不含密码/行数据 | Task 14 最后一步 |
