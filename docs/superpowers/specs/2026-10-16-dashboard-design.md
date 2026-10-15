# HUSTServer 设计文档：仪表板（Dashboard）

- 日期：2026-10-16
- 状态：已批准
- 依据：参考项目 [microsoftbi/tinybi](https://github.com/microsoftbi/tinybi)；[2026-10-15-job-orchestration-design.md](./2026-10-15-job-orchestration-design.md)

## 1. 背景与目标

平台已有「工作流」「Job 编排」「连接」「资源管理」，能把数据搬来搬去，但没有**把数据看出来的最后一公里**。本次引入 **仪表板**：用户把数据集拖到一张画布上，用 19 种视觉对象呈现，并可多页签组织、保存、复用。

功能与代码实现**完全照搬**参考项目 tinybi 的仪表板设计器，仅改造其桌面壳（Tauri）耦合部分。

### 目标（本阶段）

1. 顶部导航与主页新增「仪表板」入口。
2. `/dashboards` 列表页：新建 / 打开 / 重命名 / 删除 / 共享 仪表板。
3. `/dashboards/:id` 编辑器（独立全屏）：Power BI 风格绝对像素画布（拖拽移动 / 8 向缩放 / 吸附对齐线 / 最小尺寸）。
4. 19 种视觉对象：`bar` `stackedBar` `stackedBar100` `horizontalBar` `horizontalStackedBar` `line` `area` `stackedArea` `combo` `pie` `donut` `scatter` `treemap` `funnel` `radialBar` `table` `kpi` `map` `matrix`。
5. 右侧「可视化」窗格（图表类型栅格 + 字段井 + 格式设置）与「数据」窗格（数据集选择 + 字段搜索 + 拖拽/点击入井）。
6. 多页签（一个仪表板文件内含多个 Dashboard 页签）、交叉高亮、数据透视表、中国/世界填充地图、Power BI 式自动标题。
7. 数据源两条路：**从连接执行 SQL**、**从资源管理读取 CSV/Excel**。
8. 仪表板持久化到后端。

### 非目标（本阶段明确不做）

- 不搬 tinybi 的 Tauri / Rust 层（`src-tauri/`、`services/ipc.ts` 的 `invoke`、`services/files.ts` 的对话框）。
- 不做 `.biproj` 文件的本地导入 / 导出（改用后端持久化）。
- 不搬 tinybi 的 `lib/*.test.ts` 单元测试（不给 `apps/web` 引入 vitest）。
- 不新增「工作流运行结果」作数据源。
- 不做多人协同编辑、乐观锁、版本历史。
- 不做「导入本地文件成数据集」（要先用资源管理上传）。

## 2. 范围与关键决策

| 决策项 | 结论 |
|---|---|
| 范围 | **全部照搬**：19 种视觉对象 + 拖拽缩放画布 + 吸附 + 多页签 + 交叉高亮 + 透视表 + 中国/世界填充地图 |
| 代码放置 | **apps/web 内自包含**：`apps/web/src/features/dashboard/`，自带 `lib/` `stores/` `components/ui/` |
| 数据源 | **两条路**：① 复用「连接」+ 新增取数接口；② 读「资源管理」的 CSV/Excel |
| 持久化 | **后端建表 + REST CRUD** |
| 数据集落库 | **只存数据源定义**，不存行数据；打开时按定义重新取数 |
| 页面形态 | 列表页套顶部导航；编辑器**独立全屏路由** |
| 单元测试 | **不搬** |
| 入口 | 导航栏 + 首页卡片 + 独立路由 |

### 被否决的方案

- **代码放新建 `packages/bi-designer/` 包（与 workflow-designer 对称）**：收益是形式对称；代价是要为 UI 基元设计导出面、要配包构建脚本，为一个页面付包管理的税。YAGNI。
- **把 tinybi 整个嵌成独立子应用**：会引入第二套构建与路由，最重。
- **数据集连行数据一起落库（与 tinybi 的 `.biproj` 一致）**：好处是打开即用、源不可用也能看；代价是 DB 存冗余行、易膨胀。用户选择只存定义。

## 3. 架构

```
                       ┌────────────────────────────┐
   浏览器（React 19）   │  features/dashboard/*       │
                       │   DashboardListPage (列表)   │
                       │   DashboardEditorPage (全屏) │
                       │   ├─ DashboardView           │
                       │   ├─ ReportCanvas / ChartRenderer / MapChart / PivotTable
                       │   ├─ VisualizationsPane / FieldsPane
                       │   └─ DataSourceDialog（新）  │
                       │   stores: dashboardStore / datasetStore
                       │   services/dataSource.ts（新）
                       └───────┬──────────────┬───────┘
              /api/dashboards* │              │ /api/data/query
                               │              │ /api/resources/files/download
                               │              │ /api/connections
                       ┌───────▼──────────────▼───────┐
                       │  Fastify                     │
                       │   dashboardRoutes（新）       │
                       │   dataRoutes（新）            │
                       │   resourceRoutes（已有）      │
                       │   connectionRoutes（已有）    │
                       └───────┬──────────────────────┘
                               │
                       ┌───────▼────────┐
                       │  SQLite        │
                       │   dashboards（新表）
                       └────────────────┘
```

### 组件职责与边界

| 单元 | 职责 | 依赖 |
|---|---|---|
| `DashboardListPage` | 仪表板 CRUD 入口（列表 + 弹窗） | `api` |
| `DashboardEditorPage` | 拉 payload → hydrate 数据集 → 全屏壳 → 保存 | `dashboardStore` `datasetStore` `dataSource` |
| `DashboardView` | 页签、工具栏、选中态、字段入井、交叉高亮编排 | stores、`ReportCanvas`、两个 Pane |
| `ReportCanvas` | 绝对像素布局：拖拽 / 缩放 / 吸附 / 渲染 widget | `lib/canvas`、`ChartRenderer` |
| `ChartRenderer` | 按 `ChartType` 渲染（Recharts / MapChart / PivotTable / DataTable / KPI） | `lib/aggregate` `lib/chart` `lib/highlight` |
| `VisualizationsPane` | 图表类型栅格 + 字段井 + 格式设置 | `lib/chart` |
| `FieldsPane` | 数据集选择 + 字段搜索 + 拖拽源（含「添加数据集」入口） | `datasetStore` |
| `DataSourceDialog` | 从连接执行 SQL / 从资源库读文件 → 生成数据集 | `services/dataSource` |
| `services/dataSource.ts` | 定义 → 运行时 `Dataset` 的唯一入口 | `api`、`lib/csv`、`lib/xlsx` |

## 4. 数据模型

### 4.1 运行时模型（沿用 tinybi，一字不改）

```ts
export type CellValue = string | number | boolean | null;
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'unknown';
export interface Column { name: string; type: ColumnType }

export type ChartType =
  | 'bar' | 'stackedBar' | 'stackedBar100' | 'horizontalBar' | 'horizontalStackedBar'
  | 'line' | 'area' | 'stackedArea' | 'combo' | 'pie' | 'donut' | 'scatter'
  | 'treemap' | 'funnel' | 'radialBar' | 'table' | 'kpi' | 'map' | 'matrix';

export type MapRegion = 'auto' | 'china' | 'world';
export type AggregateFn = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'none';

export interface Measure { field: string; agg: AggregateFn }
export interface WidgetEncoding { dimension?: string; measures: Measure[]; series?: string }
export interface WidgetLayout { x: number; y: number; w: number; h: number }

export interface ChartWidget {
  id: string; type: ChartType; title: string; datasetId: string;
  encoding: WidgetEncoding; layout: WidgetLayout;
  showTitle?: boolean; showLegend?: boolean; mapRegion?: MapRegion; showTotals?: boolean;
}

export interface Dashboard { id: string; name: string; widgets: ChartWidget[] }

export interface QueryColumn { name: string; type: ColumnType }
export interface QueryResult { columns: QueryColumn[]; rows: CellValue[][]; truncated: boolean }
```

### 4.2 新增：数据源定义（可持久化）

```ts
export type DatasetSource = 'csv' | 'excel' | 'sql';

export type DatasetDef =
  | { kind: 'sql'; connectionId: string; query: string }
  | { kind: 'file'; resourcePath: string; format: 'csv' | 'excel' };

/** 落库的最小单元：只有定义，没有行。 */
export interface SavedDataset { id: string; name: string; def: DatasetDef }

/** 运行时数据集：在 tinybi 的 Dataset 上多带 def，便于回写定义。 */
export interface Dataset {
  id: string; name: string; source: DatasetSource;
  columns: Column[]; rows: CellValue[][];
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

**丢弃** tinybi 的 `SqlServerConfig` / `SavedConnection` / `PersistedConnection` / `BiProject`，以及 `stores/connectionStore.ts`、`stores/viewStore.ts`（连接由「连接」模块管，仪表板不再有「数据源视图」这一层）。

## 5. 后端设计

### 5.1 新增表

追加到 [migrate.ts](../../../apps/server/src/db/migrate.ts) 的 `SCHEMA`：

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

`payload` 为 `DashboardPayload` 的 JSON 字符串。

### 5.2 新模块 `apps/server/src/modules/dashboards/`

按 `modules/connections/` 的组织方式（`repo.ts` + `routes.ts`）。

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/dashboards` | — | `Array<{id,name,shared,owner_id,updated_at}>` |
| POST | `/api/dashboards` | `{name, payload, shared?}` | 201 同 GET 单条 |
| GET | `/api/dashboards/:id` | — | `{id,name,shared,owner_id,updated_at,payload}` |
| PUT | `/api/dashboards/:id` | `{name?, payload?, shared?}` | 同 GET 单条 |
| DELETE | `/api/dashboards/:id` | — | `{ok:true}` |

**权限**（与 connections 一致）：
- 列表：admin 全量，其他人 `shared = 1 OR owner_id = me`。
- 查看：`admin || shared === 1 || owner_id === me`。
- 修改 / 删除 / 共享：`admin || owner_id === me`。
- `shared` 仅 admin 可置真。

**校验**：`name` 非空；`payload` 必须是对象且 `JSON.stringify` 后 ≤ 8MB（`payload_too_large`）。

### 5.3 新模块 `apps/server/src/modules/data/`（本次唯一新增能力）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/api/data/query` | `{connectionId, query, limit?}` | `{columns, rows, truncated}` |

**实现**：照 [probe.ts](../../../apps/server/src/modules/connections/probe.ts) 的 mssql `ConnectionPool` 模式。
1. `repo.findById(connectionId)`，权限用 `canUse`（admin / shared / owner）；不存在 → 404，无权 → 403。
2. `decryptConfig` 得到 `SqlServerConnection`。
3. `new sql.ConnectionPool(buildMssqlConfig(conn))` → `request().query(query)`。
4. 列名 `result.recordset.columns`（或首批行的 key）；列类型按**首个非空值**推断（`number → number`、`boolean → boolean`、可解析日期 → `date`、其余 → `string`）。
5. `rows` 截断到 `limit`（默认 1000，上限 10000），`truncated` 标记。
6. 异常 → 400 `{error:'执行 SQL 失败', detail}`；`finally` 关闭 pool。

**不加只读校验**：与 tinybi 一致，用户对自己的连接负责；仅做行数截断。

### 5.4 复用（不新增）

- `GET /api/connections` —— 连接下拉。
- `GET /api/resources/tree` —— 资源文件选择。
- `GET /api/resources/files/download?path=` —— 取文件字节。

### 5.5 注册

在 [server.ts](../../../apps/server/src/server.ts) 依次注册 `dashboardRoutes(app, {db, config, users, sessions})` 与 `dataRoutes(app, {db, config, users, sessions})`。

## 6. 前端设计

### 6.1 目录（`apps/web/src/features/dashboard/`，自包含）

```
types.ts                        改：+DatasetDef/SavedDataset/DashboardPayload/Dataset.def；-连接相关
DashboardListPage.tsx           新
DashboardEditorPage.tsx         新
DashboardView.tsx               抄
ReportCanvas.tsx                抄
ChartRenderer.tsx               抄
VisualizationsPane.tsx          抄
FieldsPane.tsx                  抄（+「添加数据集」按钮）
MapChart.tsx                    抄
PivotTable.tsx                  抄
chartIcons.tsx                  抄
DataSourceDialog.tsx            新（替代 tinybi 的 DataSourceView + SqlView）
components/DataTable.tsx        抄
components/ui/*.tsx             抄 tinybi 的 15 个基元 + card.tsx
lib/aggregate.ts                抄
lib/canvas.ts                   抄
lib/chart.ts                    抄
lib/columns.ts                  抄
lib/datatable.ts                抄
lib/format.ts                   抄
lib/highlight.ts                抄
lib/pivot.ts                    抄
lib/utils.ts                    抄
lib/csv.ts                      抄
lib/xlsx.ts                     抄
lib/geo.ts                      抄
lib/project.ts                  **不抄**
services/dataSource.ts          新（替代 ipc.ts + files.ts）
stores/dashboardStore.ts        抄（纯状态；持久化由页面负责）
stores/datasetStore.ts          抄（+ 错误态支持）
assets/geo/china.json           抄
assets/geo/world.json           抄
```

### 6.2 导入改写

新增别名 `@bi/` → `apps/web/src/features/dashboard/`：
- [vite.config.ts](../../../apps/web/vite.config.ts) `resolve.alias` 增加 `'@bi': fileURLToPath(new URL('./src/features/dashboard', import.meta.url))`。
- [tsconfig.json](../../../apps/web/tsconfig.json) `paths` 增加 `"@bi/*": ["src/features/dashboard/*"]`。

把搬运文件里的 `@/` **全局替换**为 `@bi/`（web 的 `@` 已指向 `packages/workflow-designer/src`，不可复用）。

### 6.3 `services/dataSource.ts`

```ts
// 唯一取数出口；三个函数都返回可直接入 datasetStore 的 Dataset
export async function querySqlDataset(name: string, connectionId: string, query: string): Promise<Dataset>;
export async function loadFileDataset(name: string, resourcePath: string): Promise<Dataset>;
export async function hydrateDataset(saved: SavedDataset): Promise<Dataset>;   // 按 def 分发到上面两个
```

- `querySqlDataset`：`api.post('/api/data/query', {connectionId, query})` → `buildColumns`/`coerceRows`（复用 `lib/columns`）。
- `loadFileDataset`：`fetch('/api/resources/files/download?path=…', {credentials:'include'})` → `arrayBuffer()`；扩展名 `.csv` 走 `parseCsv(text, name)`，`.xlsx/.xls` 走 `parseExcel(bytes, name)`。
- 均填入 `def` 字段。

### 6.4 页面

**`DashboardListPage`**（`/dashboards`，套 Layout）：卡片/表格列出仪表板；「新建仪表板」弹窗（输入名称）→ `POST` → 跳 `/dashboards/:id`；每条支持 打开 / 重命名 / 删除 / 共享（admin）。

**`DashboardEditorPage`**（`/dashboards/:id`，独立全屏，同 `/workflows/:id/designer`）：顶部自建 header（返回列表、名称、保存、保存状态）；主体挂载 tinybi 的 `DashboardView`；左下挂 `<Toaster />`。

加载流程：
1. `GET /api/dashboards/:id` → `payload`。
2. `setDashboards(payload.dashboards)`、`setActive(payload.activeId)`。
3. 并行 `hydrateDataset` 每个 `payload.datasets[i]` → 成功的 `addDataset`，失败的记入 `datasetStore.errors`。
4. 渲染；引用失败数据集的 widget 显示占位。

保存流程：从 `dashboardStore`（`dashboards`/`activeId`）+ `datasetStore`（每个 `{id,name,def}`）组装 `DashboardPayload` → `PUT /api/dashboards/:id`。提供显式「保存」按钮 + `Ctrl/Cmd+S`。

### 6.5 数据源对话框 `DataSourceDialog`

两个 Tab（替代 tinybi 的 DataSourceView + SqlView）：

1. **从连接（SQL）**：选 `GET /api/connections` 的项 → SQL 文本域（默认 `SELECT TOP 100 * FROM `）→「执行」→ `POST /api/data/query` → `DataTable` 预览（含行数/是否截断）→ 填名称 →「存为数据集」。失败用本地手写遮罩弹窗（与 [ConnectionsPage](../../../apps/web/src/pages/ConnectionsPage.tsx) 的 `msgBox` 同风格，含 Esc 关闭）显示 `detail`。
2. **从资源库（CSV/Excel）**：`GET /api/resources/tree` 列出文件 → 选中 →「载入」→ 下载并解析 → 预览 → 填名称 →「存为数据集」。

入口：`FieldsPane` 顶部数据集下拉旁的「添加数据集」按钮。

### 6.6 错误与降级

| 场景 | 行为 |
|---|---|
| 数据集 hydrate 失败（连接被删 / SQL 报错 / 文件被删） | 数据集标红；引用它的 widget 渲染占位「数据集不可用」，可点击重新取数 |
| SQL 执行失败 | 对话框内用一个本地手写遮罩弹窗（与 [ConnectionsPage](../../../apps/web/src/pages/ConnectionsPage.tsx) 的 `msgBox` 同风格，含 Esc 关闭）显示 `detail` |
| 保存失败（网络 / 413 / 403） | 顶部状态条 + toast |
| 地图 GeoJSON | 动态 `import()` 懒加载，不进主包 |

## 7. 入口与路由

- [Layout.tsx](../../../apps/web/src/components/Layout.tsx)：`<NavLink to="/dashboards">仪表板</NavLink>`（放在「工作流」之后）。
- [HomePage.tsx](../../../apps/web/src/pages/HomePage.tsx)：新增「仪表板」卡片 → `/dashboards`。
- [App.tsx](../../../apps/web/src/App.tsx)：
  - Layout 内：`<Route path="/dashboards" element={<DashboardListPage />} />`
  - Layout 外（独立全屏）：`<Route path="/dashboards/:id" element={<RequireAuth><DashboardEditorPage /></RequireAuth>} />`

## 8. 依赖与配置改动

- `apps/web/package.json` 新增依赖：
  - 运行时：`recharts`、`papaparse`、`xlsx`、`sonner`、`zustand`、`lucide-react`、`class-variance-authority`、`clsx`、`tailwind-merge`、`@radix-ui/react-{dialog,dropdown-menu,label,scroll-area,select,separator,slot,switch,tabs,tooltip}`
  - 开发：`@types/papaparse`
- `vite.config.ts` / `tsconfig.json`：加 `@bi` 别名（见 6.2）。
- `index.css`：dashboard 代码位于 `apps/web/src` 下，Tailwind 4 默认扫描覆盖，预期不改；实测样式缺失再补 `@source`。
- 后端改动需**重启后端进程**（带齐既有环境变量）；前端改动只需重新 build 前端。

### 风险

- **React 19 + recharts 2.15**：recharts 2.15 的 peer 声明为 `^16.8 || ^17 || ^18`，不含 19。先按 2.15 安装（必要时用 pnpm 的 peer 配置），若运行时/构建报错则升 **recharts 3.x**（`RadialBar` / `Treemap` / `Funnel` 的部分 props 有差异，需逐项校正）。
- **Tailwind 4 vs 3**：tinybi 用 Tailwind 3 + `tailwindcss-animate`，本项目用 Tailwind 4 + `tw-animate-css`。类名基本兼容（`animate-in` / `fade-in-0` / `zoom-in-95` / `slide-in-from-*` 同名），实测异常则逐点修。
- **GeoJSON 体积**：`china.json` 582KB + `world.json` 257KB，必须动态 import 保持主包体积。

## 9. 验证计划

1. `pnpm --filter @hustserver/server build` + `pnpm --filter @hustserver/web build` 均 exit 0。
2. `pnpm --filter @hustserver/server test` 全绿（既有 153 项不回归）。
3. 重启后端，浏览器端到端：
   - 导航出现「仪表板」；首页出现入口卡片。
   - 新建仪表板 → 进编辑器 → 「添加数据集」→ 从资源库选一个 CSV → 预览 → 存为数据集。
   - 拖字段入井 → 切换若干图表类型（至少含柱形 / 折线 / 饼图 / KPI / 表格 / 透视表 / 地图）→ 拖拽移动与缩放 widget → 出现吸附线。
   - 多页签新建第二个 Dashboard。
   - 保存 → 返回列表 → 重新打开 → 页签 / widget / 数据集定义均恢复，数据重新取到。
   - 交叉高亮：点某图元 → 其它 widget 变暗 → Esc 清除。
   - （若存在 SQL Server 连接）从连接执行 SQL 生成数据集。
4. 检查保存 payload **不含连接密码、不含行数据**。
