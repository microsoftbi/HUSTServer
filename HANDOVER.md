# HANDOVER · 个人数据工作台（HUSTServer）

> 交接文档 · 更新于 2026-10-22
> 用途：在新电脑上快速恢复开发环境，并让接手的 AI / 开发者在一小时内理解项目全貌。

---

## 0. 30 秒速览

| 项 | 值 |
|---|---|
| 产品名 | **个人数据工作台**（内部标识仍为 HUSTServer） |
| 仓库 | `git@github.com:microsoftbi/HUSTServer.git`（origin） |
| 当前分支 / 提交 | `main` / `f578466`（已推送，与 origin/main 一致） |
| 技术栈 | pnpm monorepo · React 19 + Vite 6 + Tailwind v4 · Fastify 5 + better-sqlite3 · DuckDB · mssql |
| 运行方式 | 无 Docker，macOS 本机运行；默认 `http://127.0.0.1:8787` |
| 代码规模 | 360 个受版本控制文件；61 个测试文件 / 426 个用例全部通过 |
| 当前状态 | 工作流、Job、数据模型、仪表板、权限、审计等主线功能完整；最近完成 Power BI 风格「切片器 / 树状图 / 分解树」 |

**新电脑最短恢复路径**（详见第 1 节）：

```bash
git clone https://github.com/microsoftbi/HUSTServer.git
cd HUSTServer
pnpm install
pnpm build
SESSION_SECRET=$(openssl rand -hex 32) \
ENCRYPTION_KEY=$(openssl rand -hex 32) \
BOOTSTRAP_ADMIN_PASSWORD=your-password \
node apps/server/dist/index.js
```

---

## 1. 新电脑恢复清单

### 1.1 环境要求

- macOS
- Node.js ≥ 20（本机验证版本 `v22.23.0`）
- pnpm（本机验证版本 `10.33.1`）
- 若 `pnpm install` 编译原生模块失败，先安装 Xcode Command Line Tools：`xcode-select --install`
- 原生依赖：`better-sqlite3`、`@duckdb/node-api`（见 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`）

### 1.2 两把必须的密钥

服务启动时强制校验以下环境变量（见 [config.ts](apps/server/src/config.ts#L31-L67)）：

| 变量 | 要求 | 影响 |
|---|---|---|
| `SESSION_SECRET` | 任意长随机串 | 登录会话签名；换值只会让现有会话失效 |
| `ENCRYPTION_KEY` | **64 位十六进制（32 字节）** | 加密 SQL Server 连接密码；**换值后旧连接密码无法解密** |

> ⚠️ **如果要迁走旧数据**，必须沿用旧机器上的 `ENCRYPTION_KEY`。当前仓库根目录**没有 `.env`**（已被 `.gitignore` 忽略），如果旧机器也没保存，迁库后需要重新录入所有数据连接密码。
>
> `SESSION_SECRET` / `ENCRYPTION_KEY` 不会被提交到 Git，请从旧机器的密码管理器、LaunchAgent plist 或启动命令中找回。

### 1.3 数据迁移（可选，想保留旧数据时）

默认数据目录是 `~/.hustserver`，旧机器上实际内容：

| 路径 | 内容 | 是否必须 |
|---|---|---|
| `~/.hustserver/metadata.sqlite` | 用户/角色/会话、工作流、Job、仪表板 payload、连接密文、运行与日志、审计 | 保留业务数据则必须 |
| `~/.hustserver/models.duckdb` | 所有物化后的数据模型（单文件） | 保留模型则必须 |
| `~/.hustserver/uploads/` | 上传的工作流数据文件 | 按需 |
| `~/.hustserver/outputs/` | 工作流输出文件 | 按需 |
| `~/.hustserver/spill/` | DuckDB 溢出临时文件 | 可不迁 |
| `apps/web/DATA/` | **资源库默认根目录**（CSV / Excel），已被 `.gitignore` 忽略 | 使用资源库则必须单独拷贝 |
| `.env` | 密钥与启动参数（若旧机器存在） | 建议一并拷走 |

> 旧目录里的 `app.db`、`hustserver.db` 是 0 字节历史遗留文件，可忽略/删除。
>
> 全新开始也可以：删掉/不迁 `~/.hustserver`，首次启动会自动建库并创建初始管理员。资源库文件需要自行放入 `apps/web/DATA`，或通过页面重新上传。

### 1.4 启动方式

**开发模式**（server 用 `tsx watch`，web 用 Vite）：

```bash
export SESSION_SECRET=dev-secret
export ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export BOOTSTRAP_ADMIN_USER=admin
export BOOTSTRAP_ADMIN_PASSWORD=your-password
pnpm dev
```

- 前端：`http://localhost:5173`（Vite 把 `/api` 代理到 `127.0.0.1:8787`，见 [vite.config.ts](apps/web/vite.config.ts)）
- 后端：`http://127.0.0.1:8787`

> 注意：项目**没有引入 dotenv**。`pnpm dev` 不会自动读取 `.env`，需要先 `export`，或用 `env $(cat .env | xargs) pnpm dev`。

**生产模式**（后端同时托管前端产物）：

```bash
pnpm build   # 递归构建 server / web / engine / workflow-designer
node apps/server/dist/index.js
```

访问 `http://127.0.0.1:8787`。只有 `apps/web/dist` 存在时才会注册静态托管与 SPA 回退；否则仅提供 API。

**macOS 开机自启 / 崩溃拉起**：

```bash
bash scripts/install-macos-service.sh
# 卸载：bash scripts/install-macos-service.sh --uninstall
```

脚本会在首次运行时生成权限 600 的 `.env`（含随机密钥），并写入 `~/Library/LaunchAgents/com.hustserver.app.plist`，日志在 `~/Library/Logs/HUSTServer/`。详见 [install-macos-service.sh](scripts/install-macos-service.sh)。

### 1.5 恢复后的验收

```bash
pnpm test                                  # 期望 61 files / 426 tests 全通过
pnpm --filter @hustserver/web typecheck    # 前端类型检查
pnpm build                                 # 全量构建
```

浏览器登录后快速点一遍：主页看板 → 工作流列表 → 仪表板列表 → 打开一个仪表板（编辑/预览）→ 模型页。

---

## 2. 目录结构地图

```
HUSTServer/
├── apps/
│   ├── server/                 # Fastify 5 API + 调度 + 运行编排 + 静态托管
│   │   ├── src/
│   │   │   ├── index.ts        # 启动入口（建库、迁移、静态托管、优雅退出）
│   │   │   ├── server.ts       # buildServer：装配所有路由与调度器
│   │   │   ├── config.ts       # 环境变量解析与数据目录
│   │   │   ├── bootstrap.ts    # 初始管理员
│   │   │   ├── db/             # SQLite 连接与 migrate()
│   │   │   ├── plugins/        # requireAuth / requireCap 能力守卫
│   │   │   └── modules/        # 按领域拆分的 repo + routes + service
│   │   └── test/               # 50+ 个 vitest 测试
│   └── web/                    # React 19 控制台 + 仪表板编辑器
│       ├── src/
│       │   ├── App.tsx         # 全部路由与能力门禁
│       │   ├── api.ts          # 同源 fetch 客户端（Cookie 会话）
│       │   ├── auth.tsx        # 登录态 / RequireAuth / RequireCap
│       │   ├── roles.ts        # 四角色八能力（与后端同名）
│       │   ├── pages/          # 工作流 / Job / 模型 / 资源 / 用户 / 审计等
│       │   ├── components/     # Layout、通用 UI、模型与透视组件
│       │   └── features/dashboard/   # 仪表板自包含模块（重点）
│       ├── DATA/               # 资源库默认根目录（gitignored）
│       └── test/               # 前端纯函数测试
├── packages/
│   ├── engine/                 # HUSTERYX 执行引擎移植（DuckDB + mssql + xlsx）
│   │   └── src/
│   │       ├── engine/         # 图编译、执行器、DuckDB 会话、模型物化
│   │       ├── nodes/          # 13 种节点实现
│   │       └── util/           # schema 探测、SQL 标识符、Excel、mssql 等
│   └── workflow-designer/      # HUSTERYX 前端画布复用包
│       └── src/
│           ├── WorkflowDesigner.tsx
│           ├── adapters.ts     # 平台注入的唯一契约
│           ├── components/     # 画布、节点面板、预览、设置
│           └── store/          # zustand 画布状态
├── docs/
│   ├── images/                 # README / USERGUIDE 截图
│   └── superpowers/            # 历史设计文档与实施计划（很有参考价值）
├── scripts/install-macos-service.sh
├── README.md                   # 功能总览 + 架构 + 快速开始
├── USERGUIDE.md                # 面向用户的操作手册（功能变更时需同步）
├── NOTE.md                     # 需求流水（Done / TODO）
└── HANDOVER.md                 # 本文件
```

### 路径别名

| 别名 | 指向 | 配置位置 |
|---|---|---|
| `@/*` | `packages/workflow-designer/src/*` | `apps/web/tsconfig.json`、`vite.config.ts`、根 `vitest.config.ts` |
| `@bi/*` | `apps/web/src/features/dashboard/*` | 同上（vitest 未配置 `@bi`，前端测试用相对路径） |

---

## 3. 架构与数据流

### 3.1 四层架构

1. **前端层**：`apps/web`，React 19 控制台；路由与按钮按**能力**门禁（`RequireCap`）。
2. **服务层**：`apps/server`，Fastify 5；REST + SSE、Cookie 会话、RBAC、Cron 调度、运行/Job 编排、连接密码加密、模型管理、静态托管。
3. **执行引擎**：`packages/engine`（HUSTERYX 基线 `39451d8`），DuckDB 计算 + mssql 读写，按拓扑序执行 13 种节点；同时负责把 CSV/Excel/SQL Server 数据物化进 `models.duckdb`。
4. **存储**：
   - SQLite 单文件 `~/.hustserver/metadata.sqlite`：全部元数据；
   - DuckDB 单文件 `~/.hustserver/models.duckdb`：数据模型；
   - 文件目录：`uploads/`、`outputs/`、`spill/`；
   - 资源库：默认 `apps/web/DATA`（`HUSTSERVER_RESOURCE_DIR` 可覆盖）。

### 3.2 启动链路

[apps/server/src/index.ts](apps/server/src/index.ts)：

1. `loadConfig()` 读取环境变量，`ensureDirs()` 建目录；
2. 先补齐引擎模块求值所需的 `HUSTSERVER_*` 环境变量，再**动态 import** `server.ts`（避免引擎在模块加载时读到空配置）；
3. 打开 SQLite、执行 `migrate()`（幂等）；
4. 读取数据库中的系统设置覆盖环境变量默认值；
5. `buildServer()` 装配路由与两套调度器（工作流 / Job）；
6. `ensureBootstrapAdmin()` 创建初始管理员；
7. 若 `apps/web/dist` 存在，注册 `@fastify/static` + SPA 回退（`/api/*` 仍返回 JSON 404）；
8. 启动调度器与日志保留清理任务，监听端口；
9. `SIGINT` / `SIGTERM` 优雅关闭。

### 3.3 一次工作流运行

```
手动 / Cron / Job 步骤
  → runService.trigger() 写入 runs
  → 信号量排队（MAX_CONCURRENT_RUNS，默认 2）
  → 从 SQLite 读 workflow payload + 连接密文
  → buildRuntimeWorkflow() 注入文件映射与连接
  → engine.createRun() + executeWorkflow()（DuckDB 流式执行 13 种节点）
  → 节点状态/日志回写 run_node_results / run_logs
  → SSE（/api/runs/:runId/events）实时推送到运行详情页
```

注意：引擎在节点失败时**只置状态、不抛异常**；[runs/service.ts](apps/server/src/modules/runs/service.ts#L57-L77) 会在 `ctx.status === 'error'` 时显式抛错，否则 worker 会把失败误记为成功。

### 3.4 一次 Job 运行

```
Job 级 Cron / 手动
  → jobService.trigger()
  → Job 级信号量（并发固定 1，独立于 workflow 信号量，避免死锁）
  → 按 seq 执行步骤：
       workflow   → runService.trigger + awaitRun
       sql        → 解密连接后直接执行 SQL
       load_model → modelStore.load()（staging → 原子替换）
  → 每步写 job_step_runs；on_failure = abort / continue
```

详见 [jobs/service.ts](apps/server/src/modules/jobs/service.ts)。

### 3.5 仪表板的取数链路

```
打开 /dashboards/:id
  → GET /api/dashboards/:id 拿到 payload（仅数据集定义，无行数据）
  → 使用 dashboardStore.setDashboards() 恢复画布
  → 并行 hydrateDataset()：
       sql    → POST /api/data/query
       file   → GET /api/resources/files/download + 前端解析 CSV/Excel
       model  → POST /api/models/query
  → 某个数据集失败只记录错误并显示「重试」，不影响其它图表
  → 保存时 PUT /api/dashboards/:id，payload 只回写定义
```

关键文件：[DashboardEditorPage.tsx](apps/web/src/features/dashboard/DashboardEditorPage.tsx)、[services/dataSource.ts](apps/web/src/features/dashboard/services/dataSource.ts)。

---

## 4. 关键约定与不变量（最容易踩的坑）

1. **显示名 vs 内部标识**：界面显示「个人数据工作台」，但包名 `@hustserver/*`、环境变量前缀 `HUSTSERVER_`、数据目录 `~/.hustserver`、LaunchAgent `com.hustserver.app`、仓库名 HUSTServer 均**保持不变**。
2. **密钥不能丢**：`ENCRYPTION_KEY` 变更会导致历史连接密码无法解密；迁移数据时必须同时迁移密钥。
3. **`.env` 不会自动加载**：开发模式必须 export；只有 LaunchAgent 脚本会把 `.env` 注入 plist。
4. **资源库默认目录**是 `apps/web/DATA`，解析方式为相对 `src` / `dist` 的 `../../web/DATA`；该目录被 gitignore，需单独备份。
5. **仪表板 payload 不存行数据**：只存 `SavedDataset.def`。源不可用时打开页面会报错，但可重试。
6. **仪表板编辑权限**：`dashboard.edit` 能力 + （管理员或 owner）；`dashboard.view` 可查看全部仪表板。
7. **REST 认证**：Cookie `hs_session`；所有能力既在前端隐藏入口，也在后端 `requireCap` 校验。
8. **请求体上限**：Fastify 全局 16MB；仪表板 payload 单独限制 8MB（超出返回 413 `payload_too_large`）。
9. **DuckDB 单写者**：模型加载与查询串行化；写入用 staging 临时表 → 原子替换，失败不破坏旧模型。
10. **Job 与 Workflow 信号量必须独立**：Job 并发固定 1，复用会导致 workflow 步骤互相等待死锁。
11. **前端别名**：`@` 指 workflow-designer，`@bi` 指 dashboard feature，不要把两者混用。
12. **测试环境是 node**：前端组件本身不做 DOM 测试，测试集中在纯函数（聚合、筛选、布局、矩阵等）。根 [vitest.config.ts](vitest.config.ts) 只收集 `apps/**/test` 与 `packages/**/test`。
13. **数据库迁移幂等**：[migrate.ts](apps/server/src/db/migrate.ts) 使用 `CREATE TABLE IF NOT EXISTS`，并对 `runs.job_run_id`、`dashboards.shared` 做列级兼容处理；新增表/列时沿用这一风格。

---

## 5. 功能现状

| 模块 | 状态 | 关键文件 |
|---|---|---|
| 登录 / 会话 / 登录日志 | ✅ | [auth/routes.ts](apps/server/src/modules/auth/routes.ts)、[auth.tsx](apps/web/src/auth.tsx) |
| 四角色八能力 RBAC | ✅ | [users/roles.ts](apps/server/src/modules/users/roles.ts)、[plugins/guards.ts](apps/server/src/plugins/guards.ts)、[web/roles.ts](apps/web/src/roles.ts) |
| 工作流上传 / 列表 / 详情 / 删除 | ✅ | [workflows/](apps/server/src/modules/workflows)、[WorkflowListPage.tsx](apps/web/src/pages/WorkflowListPage.tsx) |
| Web 工作流设计器（13 节点） | ✅ | [WorkflowDesigner.tsx](packages/workflow-designer/src/WorkflowDesigner.tsx)、[adapters.ts](packages/workflow-designer/src/adapters.ts) |
| 工作流运行 / 实时日志 / 预览 / 缓存 | ✅ | [runs/](apps/server/src/modules/runs)、[RunDetailPage.tsx](apps/web/src/pages/RunDetailPage.tsx) |
| Cron 调度（工作流 / Job 两套） | ✅ | [schedules/](apps/server/src/modules/schedules) |
| Job 编排（workflow / sql / load_model） | ✅ | [jobs/](apps/server/src/modules/jobs)、[JobEditorPage.tsx](apps/web/src/pages/JobEditorPage.tsx) |
| Job 日志（全部 Job 最近一次运行） | ✅ | [JobLogPage.tsx](apps/web/src/pages/JobLogPage.tsx) |
| Job 导出 / 导入 | ✅ | [jobs/transfer.ts](apps/server/src/modules/jobs/transfer.ts) |
| 数据模型（DuckDB，staging 原子替换） | ✅ | [models/](apps/server/src/modules/models)、[ModelsPage.tsx](apps/web/src/pages/ModelsPage.tsx) |
| 模型预览 / 透视 / 列统计 / 列类型配置 | ✅ | [models/routes.ts](apps/server/src/modules/models/routes.ts)、[PivotBuilder.tsx](apps/web/src/components/pivot/PivotBuilder.tsx) |
| 资源库（文件夹树 / 上传 / 移动 / 下载） | ✅ | [resources/routes.ts](apps/server/src/modules/resources/routes.ts)、[ResourcesPage.tsx](apps/web/src/pages/ResourcesPage.tsx) |
| 数据连接（密码加密、掩码回填） | ✅ | [connections/](apps/server/src/modules/connections) |
| 数据探索（只读 SQL + SQL Guard） | ✅ | [explore/](apps/server/src/modules/explore)、[DataExplorerPage.tsx](apps/web/src/pages/DataExplorerPage.tsx) |
| 仪表板（列表 / 编辑 / 只读预览 / 多页签） | ✅ | `apps/web/src/features/dashboard/` |
| 主页看板（数量卡片 + 新建趋势） | ✅ | [overview/routes.ts](apps/server/src/modules/overview/routes.ts)、[HomePage.tsx](apps/web/src/pages/HomePage.tsx) |
| 系统审计 + 审计入模 | ✅ | [audit/](apps/server/src/modules/audit)、[AuditPage.tsx](apps/web/src/pages/AuditPage.tsx) |
| 系统设置（并发、日志保留、共享目录、时区） | ✅ | [settings/](apps/server/src/modules/settings)、[SettingsPage.tsx](apps/web/src/pages/SettingsPage.tsx) |

---

## 6. 仪表板模块（当前最活跃）

### 6.1 文件地图

| 文件 | 职责 |
|---|---|
| [types.ts](apps/web/src/features/dashboard/types.ts) | 全部运行时类型：`ChartWidget`、`SlicerConfig`、`TreemapConfig`、`DecompositionConfig`、`Dataset`、`DashboardPayload` |
| [DashboardEditorPage.tsx](apps/web/src/features/dashboard/DashboardEditorPage.tsx) | 全屏壳：加载 payload、hydrate 数据集、保存、Ctrl/Cmd+S、只读预览 |
| [DashboardView.tsx](apps/web/src/features/dashboard/DashboardView.tsx) | 页签、工具栏、选中态、新建视觉对象、字段入井、切片器筛选汇总、交叉高亮 |
| [ReportCanvas.tsx](apps/web/src/features/dashboard/ReportCanvas.tsx) | 绝对像素画布：拖动 / 8 向缩放 / 吸附辅助线 / 最小尺寸 / 只读模式 |
| [ChartRenderer.tsx](apps/web/src/features/dashboard/ChartRenderer.tsx) | 按 `ChartType` 分发；先应用仪表板筛选，再应用交叉筛选，最后聚合 |
| [VisualizationsPane.tsx](apps/web/src/features/dashboard/VisualizationsPane.tsx) | 可视化画廊 + 字段井 + 格式窗格 |
| [FieldsPane.tsx](apps/web/src/features/dashboard/FieldsPane.tsx) | 数据集选择、字段搜索、字段点击/拖拽源 |
| [stores/dashboardStore.ts](apps/web/src/features/dashboard/stores/dashboardStore.ts) | 仪表板与 widget 的 zustand 状态 |
| [stores/datasetStore.ts](apps/web/src/features/dashboard/stores/datasetStore.ts) | 运行时数据集与取数错误 |
| [services/dataSource.ts](apps/web/src/features/dashboard/services/dataSource.ts) | 定义 → 运行时数据集的唯一入口 |
| `lib/*` | 纯函数：聚合、图表元数据、筛选、切片器、画布、透视矩阵、CSV/Excel、地图、树状图、分解树 |

### 6.2 视觉对象（20 种 + 切片器）

`bar`、`stackedBar`、`stackedBar100`、`horizontalBar`、`horizontalStackedBar`、`line`、`area`、`stackedArea`、`combo`、`pie`、`donut`、`scatter`、`treemap`、`decomposition`、`funnel`、`radialBar`、`table`、`kpi`、`map`、`matrix`，外加 `filter`（切片器）。

- 常规图表主要用 **recharts**；
- **树状图、分解树、切片器、填充地图、数据透视表**为自绘 SVG / HTML，以贴近 Power BI 行为；
- 字段拖拽协议：字段窗格 → 字段井用 `application/x-bi-field`，可视化画廊 → 画布用 `application/x-bi-visual`。

### 6.3 切片器（`filter`）

- 配置：`filterFields: string[]` + `slicer: SlicerConfig`；
- 类型：列表 / 下拉 / 介于 / 之前 / 之后 / 相对日期 / 层次结构；
- 选择状态持久化在 `slicer.state`（`selections` / `ranges` / `relative`），随仪表板保存；
- 所有切片器状态经 [lib/slicer.ts](apps/web/src/features/dashboard/lib/slicer.ts) 翻译为 `ValueFilter[]`，在 `DashboardView` 汇总后作用于**本页所有图表**；
- 拖入第二个字段时自动切为「层次结构」切片器；只剩一个字段时回落为「列表」；
- 支持单选/多选、⌘/Ctrl 累加、全选、搜索、水平排列、边框、强调色、字号等格式项。

### 6.4 交叉筛选 / 高亮

- 点击图元设置瞬时的 `HighlightSelection`（不落库），源视觉对象未命中项变暗（透明度 0.25），同数据集其它图表按选中值过滤后重新聚合；
- `Esc`、点击空白、切换页签会清除；
- 与切片器筛选叠加顺序：切片器 `ValueFilter` → 交叉筛选 → 聚合。见 [lib/highlight.ts](apps/web/src/features/dashboard/lib/highlight.ts)。

### 6.5 树状图（`treemap`）

- 纯函数 [lib/treemap.ts](apps/web/src/features/dashboard/lib/treemap.ts)：两层数据构建 + squarified 布局 + 配色 + 标签适配；
- 组件 [TreemapChart.tsx](apps/web/src/features/dashboard/TreemapChart.tsx)：SVG 自绘，支持分组标题、图例、悬浮提示、点击交叉筛选；
- 格式项：配色模式（按类别 / 按值渐变 / 单色）、基础色、分组标题、值标签、边框、分组间距。

### 6.6 分解树（`decomposition`）

- 纯函数 [lib/decomposition.ts](apps/web/src/features/dashboard/lib/decomposition.ts)：根节点为度量合计；按「说明依据」字段逐层拆分；每层按值降序取前 `maxBars` 个；AI 拆分启发式（`__ai_high__` / `__ai_low__`）；
- 组件 [DecompositionTree.tsx](apps/web/src/features/dashboard/DecompositionTree.tsx)：列式布局、肘形连接线、数据条按根值归一化、`+` / `−` 展开折叠、展开菜单、悬浮提示；
- widget 字段：`encoding.measures[0]`（分析度量）、`explainBy: string[]`（可拆分维度）、`decomposition.expansions: Record<nodeKey, field>`（展开状态，随仪表板保存）；
- 节点 key 用 URI 编码的祖先条件拼接，保证路径唯一。

### 6.7 持久化结构

```ts
interface DashboardPayload {
  version: 2;
  dashboards: Dashboard[];   // 多页签，每页 widgets
  activeId: string;
  datasets: SavedDataset[];  // 仅定义：sql / file / model
}
```

- 保存：`PUT /api/dashboards/:id`，前端会把「服务端已知数据集」与「当前运行时数据集」合并，避免失败/未 hydrate 的定义丢失；
- 打开：并行 hydrate；失败的数据集显示可读错误与「重试」。

---

## 7. SQLite 表一览

定义在 [migrate.ts](apps/server/src/db/migrate.ts)。

| 表 | 用途 |
|---|---|
| `users` / `user_roles` | 账号（`role` 列保留兼容）与多角色 |
| `sessions` | 会话令牌与过期时间 |
| `workflows` / `workflow_files` / `path_mappings` | 工作流 payload、上传文件、输入输出路径映射 |
| `connections` / `workflow_connections` | 平台连接密文、按工作流节点单独维护的连接密文 |
| `schedules` | 工作流级 Cron（Job 的 Cron 存在 `jobs` 表） |
| `runs` / `run_node_results` / `run_logs` | 运行、节点结果、日志（含 `job_run_id` 关联） |
| `jobs` / `job_steps` / `job_runs` / `job_step_runs` | Job 定义、步骤、运行、步骤运行 |
| `dashboards` | 仪表板名称与 payload |
| `login_logs` | 每次登录成功/失败、IP、UA |
| `audit_logs` | 管理操作审计 |
| `data_models` / `model_column_configs` | 模型元数据、列类型覆盖 |
| `settings` | 系统设置键值（覆盖环境变量） |

---

## 8. API 索引（按能力）

| 领域 | 主要端点 |
|---|---|
| 认证 | `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me` |
| 用户 | `GET/POST /api/admin/users`、`PUT/DELETE /api/admin/users/:id`、`POST .../reset-password`、`GET .../login-logs` |
| 工作流 | `POST /api/workflows/upload`、`GET/POST /api/workflows`、`GET/PUT/DELETE /api/workflows/:id`、`PUT .../mappings`、`GET/PUT .../connections/:nodeId`、`POST .../connections/:nodeId/test`、`GET/POST .../files` |
| 运行 | `POST /api/workflows/:id/runs`、`GET /api/workflows/:id/runs`、`GET /api/runs/:runId`、`GET /api/runs/:runId/logs`、`GET /api/runs/:runId/preview`、`GET /api/runs/:runId/events`（SSE）、`DELETE /api/runs/cache/:token` |
| 调度 | `GET/POST /api/workflows/:id/schedules`、`PUT/DELETE /api/schedules/:id` |
| Job | `GET/POST /api/jobs`、`GET/PUT/DELETE /api/jobs/:id`、`POST /api/jobs/:id/runs`、`GET /api/jobs/:id/runs`、`GET /api/job-runs/:id`、`GET /api/jobs/:id/export`、`POST /api/jobs/import` |
| 连接 | `GET/POST /api/connections`、`PUT/DELETE /api/connections/:id`、`POST /api/connections/test`、`POST /api/connections/:id/test`、`GET /api/connections/:id/objects` |
| 数据取数 | `POST /api/data/query`、`POST /api/data/tables` |
| 数据模型 | `POST /api/models`（新建/加载）、`GET /api/models`、`GET/PUT /api/models/:name/column-config`、`POST /api/models/query`、`POST /api/models/pivot`、`POST /api/models/distinct`、`POST /api/models/stats`、`PATCH/DELETE /api/models/:name` |
| 数据探索 | `GET /api/explore/models`、`POST /api/explore/columns`、`POST /api/explore/query` |
| 资源库 | `GET /api/resources`、`GET /api/resources/tree`、`GET /api/resources/sheets`、`GET /api/resources/folders/tree`、`POST /api/resources/move`、`POST /api/resources/folders`、`POST /api/resources/files`、`PATCH/DELETE /api/resources/folders`、`PATCH/DELETE /api/resources/files`、`GET /api/resources/files/download` |
| 结构探测 | `POST /api/schema/csv`、`POST /api/schema/excel`、`POST /api/schema/sqlserver` |
| 仪表板 | `GET/POST /api/dashboards`、`GET/PUT/DELETE /api/dashboards/:id` |
| 主页 / 审计 / 设置 | `GET /api/admin/overview`、`GET /api/admin/audit-logs`、`POST /api/admin/audit-logs/load-model`（审计入模）、`GET/PUT /api/admin/settings` |

> 所有路由都通过 `requireAuth` + `requireCap`（或 `requireAnyCap`）做后端校验；前端 `RequireCap` 只是体验层。

---

## 9. 测试与验证

### 9.1 现状（2026-10-22 实测）

```
Test Files  61 passed (61)
Tests       426 passed (426)
Duration    ~21s
```

- 后端：认证、RBAC、工作流解析/映射、运行队列/执行失败、调度、Job、模型加载/透视/统计、连接、审计、资源、仪表板、数据查询等；
- 引擎：模型加载、runStore sink；
- 前端：纯函数（API 客户端、交叉筛选、仪表板筛选、切片器、树状图、分解树、透视矩阵、工作流映射）。

### 9.2 命令

```bash
pnpm test                                  # 全部测试
pnpm --filter @hustserver/web typecheck    # 前端类型检查
pnpm build                                 # 全量构建
```

### 9.3 浏览器验证习惯

此前使用 `browser_use` 子代理做端到端验证（登录、创建临时仪表板、检查图表/悬浮提示/控制台错误），验证后清理临时仪表板、用户与 `/tmp` 临时文件。新环境可沿用该流程，但注意不要污染正式数据。

---

## 10. 最近提交与待办

### 10.1 最近提交

| 提交 | 内容 |
|---|---|
| `f578466` | **feat(dashboard): 复刻 Power BI 切片器、树状图与分解树**（21 文件，+4966/-87） |
| `849618e` | 数据模型列类型配置 + 审计日志入模 + 左侧导航 |
| `7147dd1` | Job 配置导出 / 导入 |
| `ff0d31c` | 数据探索页 + 导航 |
| `6167563` | 系统审计并合并登录事件 |
| `4a5041b` | README / 用户手册更新 + 截图 |

### 10.2 待办 / 已知不一致

1. **NOTE.md 的 TODO**：要求「在可视化列表加入筛选器按钮，配置字段作为筛选器；预览模式点按钮弹出子窗体，一行两个筛选器」。
   - 现状：已有独立的**切片器视觉对象**（`filter`，可拖入多个字段、状态持久化、作用于全页），功能上覆盖了大部分诉求；
   - **尚未实现**的是「预览模式下点按钮弹出集中筛选器子窗体」这一交互形态。若要做，建议先确认是否仍需要，避免与现有切片器重复。
2. **README.md 略滞后**：还没提到切片器 / 树状图 / 分解树；`USERGUIDE.md` 已更新到 20 种视觉对象并含使用说明。下次改文档时顺手补 README。
3. **仓库未跟踪文件**：
   - `pnpm-lock 2.yaml`（旧锁文件副本，建议删除）；
   - `NOTE.md` 有未提交修改（把 Dashboard 交互标记为 Done、新增筛选器 TODO）；
   - `HANDOVER.md`（本文件）待提交。
4. **数据目录遗留**：`~/.hustserver/app.db`、`hustserver.db` 为 0 字节残留，可清理。

---

## 11. 给接手的 AI 的阅读顺序与工作约定

### 建议阅读顺序

1. 本文件；
2. [README.md](README.md)（功能总览 + 架构图 + 环境变量）；
3. [USERGUIDE.md](USERGUIDE.md)（用户视角的完整操作路径，改功能后需同步）；
4. [apps/server/src/server.ts](apps/server/src/server.ts)（一眼看清所有模块装配）；
5. [apps/server/src/db/migrate.ts](apps/server/src/db/migrate.ts)（数据模型全貌）；
6. 按任务进入对应 `modules/*` 或 `features/dashboard/*`；
7. 历史设计文档：`docs/superpowers/specs/` 与 `docs/superpowers/plans/`（工作流、Job、仪表板、模型、角色等决策背景）。

### 工作约定

- **界面与注释使用中文**；代码标识符保持英文。
- 修改功能时同步更新 `USERGUIDE.md`（用户手册）与必要的 `README.md`；新增截图放 `docs/images/`。
- 新增后端能力时：沿用 `modules/<domain>/{repo,routes,service}.ts` 结构；所有路由加 `requireAuth` + `requireCap`。
- 新增前端页面时：在 `App.tsx` 注册路由并套 `RequireCap`，在 `Layout.tsx` 加导航项（按能力显示）。
- 新增纯逻辑优先放 `lib/` 并补 vitest 单测（无 DOM 依赖）。
- 不要引入 Docker；macOS 本机部署是硬约束。
- 复用 HUSTERYX（前端基线 `836b22a`、引擎基线 `39451d8`），不要重写设计器或执行引擎。
- 避免过度设计：小改动直接改现有文件，不额外造抽象层。
- 改动完成后至少跑：`pnpm test` + `pnpm --filter @hustserver/web typecheck` + `pnpm build`。

---

## 12. 常用命令速查

| 目的 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 开发（前后端并行） | `pnpm dev` |
| 全量构建 | `pnpm build` |
| 启动生产服务 | `node apps/server/dist/index.js` |
| 全量测试 | `pnpm test` |
| 前端类型检查 | `pnpm --filter @hustserver/web typecheck` |
| 安装 macOS 服务 | `bash scripts/install-macos-service.sh` |
| 卸载 macOS 服务 | `bash scripts/install-macos-service.sh --uninstall` |
| 查看服务状态 | `launchctl list \| grep com.hustserver.app` |
| 服务日志 | `~/Library/Logs/HUSTServer/stdout.log` / `stderr.log` |
| 数据目录 | `~/.hustserver` |
| 资源库目录 | `apps/web/DATA` |

---

_结束。若迁移后遇到连接密码解密失败，优先检查 `ENCRYPTION_KEY` 是否与旧机器一致。_
