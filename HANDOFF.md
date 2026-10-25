# HANDOFF · 个人数据工作台（HUSTServer）

> 交接文档 · 更新于 2026-10-25
> 用途：换账号 / 换电脑后，让接手的 AI 或开发者在一小时内理解项目全貌并继续开发。
> 本文件由 `HANDOVER.md` 更名而来（git 中仍显示为删除 `HANDOVER.md` + 新增 `HANDOFF.md`）。

---

## 0. 30 秒速览

| 项 | 值 |
|---|---|
| 产品名 | **个人数据工作台**（内部标识仍为 HUSTServer） |
| 仓库 | `git@github.com:microsoftbi/HUSTServer.git`（origin） |
| 当前分支 / 提交 | `main` / `bc05b3f`（已推送，与 origin/main 一致） |
| 技术栈 | pnpm monorepo · React 19 + Vite 6 + Tailwind v4 · Fastify 5 + better-sqlite3 · DuckDB · mssql · Monaco |
| 运行方式 | 无 Docker，macOS 本机运行；生产默认 `http://127.0.0.1:8787`，开发前端 `5173` |
| 代码规模 | 62 个测试文件 / 438 个用例全部通过（2026-10-25 实测，约 10s） |
| 当前状态 | 工作流、Job、数据模型、仪表板、权限、审计主线完整；最近新增 **AI 智能体（Text2SQL）**、**数据模型数据标签**、**会话长度统计与增量压缩**、**Alteryx 风格工作流节点（共 24 种）**、**Power BI 风格仪表板视图/插入能力** |

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
- Node.js ≥ 20（本机验证 `v22.23.0`）
- pnpm（本机验证 `10.33.1`）
- `pnpm install` 编译原生模块失败时先装 Xcode Command Line Tools：`xcode-select --install`
- 原生依赖：`better-sqlite3`、`@duckdb/node-api`（见 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`；esbuild 必须放在 `onlyBuiltDependencies`，放进 `ignoredBuiltDependencies` 会导致安装失败）

### 1.2 两把必须的密钥

服务启动强制校验（见 [config.ts](apps/server/src/config.ts#L31-L67)）：

| 变量 | 要求 | 影响 |
|---|---|---|
| `SESSION_SECRET` | 任意长随机串 | 登录会话签名；换值只会让现有会话失效 |
| `ENCRYPTION_KEY` | **64 位十六进制（32 字节）** | 加密 SQL Server 连接密码 **与 AI 智能体的 API Key**；**换值后旧密文全部无法解密** |

> ⚠️ 迁库必须沿用旧机器的 `ENCRYPTION_KEY`。仓库根目录**没有 `.env`**（gitignore），项目也**不加载 dotenv**。
> 本轮开发期间使用的是 `/tmp/hustserver.env`（chmod 600）保存 `SESSION_SECRET` / `ENCRYPTION_KEY` / `HUSTSERVER_HOST` / `HUSTSERVER_PORT`；这是临时文件，清理 `/tmp` 后会丢失，接手前请从旧机器或密码管理器找回密钥。

### 1.3 数据迁移（可选）

默认数据目录 `~/.hustserver`：

| 路径 | 内容 | 是否必须 |
|---|---|---|
| `~/.hustserver/metadata.sqlite` | 用户/角色/会话、工作流、Job、仪表板 payload、连接密文、运行与日志、审计、**AI 会话**、**数据标签** | 保留业务数据则必须 |
| `~/.hustserver/models.duckdb` | 所有物化数据模型（单文件） | 保留模型则必须 |
| `~/.hustserver/uploads/` | 上传的工作流数据文件 | 按需 |
| `~/.hustserver/outputs/` | 工作流输出文件 | 按需 |
| `~/.hustserver/spill/` | DuckDB 溢出临时文件 | 可不迁 |
| `apps/web/DATA/` | **资源库默认根目录**（CSV / Excel），已 gitignore | 使用资源库则必须单独拷贝 |

> `~/.hustserver/app.db`、`hustserver.db` 是 0 字节历史残留，可删。
> 全新开始：不迁数据，首次启动自动建库并创建初始管理员；资源库文件重新上传。

### 1.4 启动方式

**开发模式**：

```bash
export SESSION_SECRET=dev-secret
export ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export BOOTSTRAP_ADMIN_USER=admin
export BOOTSTRAP_ADMIN_PASSWORD=your-password
pnpm dev
```

- 前端 `http://localhost:5173`（Vite 将 `/api` 代理到 `127.0.0.1:8787`）
- 后端 `http://127.0.0.1:8787`

**生产模式**（后端同时托管前端产物）：

```bash
pnpm build
node apps/server/dist/index.js
```

仅当 `apps/web/dist` 存在时才注册静态托管与 SPA 回退。

**仅重启后端**（前端热更新不影响后端节点注册；**新增工作流节点后必须重启后端**）：

```bash
pnpm --filter @hustserver/server build
node apps/server/dist/index.js
```

**macOS 开机自启 / 崩溃拉起**：

```bash
bash scripts/install-macos-service.sh          # 卸载加 --uninstall
```

脚本首次运行会生成权限 600 的 `.env`（随机密钥），写入 `~/Library/LaunchAgents/com.hustserver.app.plist`，日志在 `~/Library/Logs/HUSTServer/`。

**DuckDB 首次加载慢**：`@duckdb/node-bindings-darwin-arm64` 首次加载 `libduckdb.dylib` 约 35 秒，二次启动明显变快，属正常现象。

### 1.5 恢复后的验收

```bash
pnpm test                                  # 期望 62 files / 438 tests 全通过
pnpm --filter @hustserver/web typecheck
pnpm build
```

浏览器快速走查：登录 → 主页 → 工作流列表 → 打开设计器 → 仪表板列表 → 打开仪表板（编辑/预览）→ 模型页（数据预览 / ⋯ 菜单 / 数据标签）→ AI 智能体。

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
│   │   └── test/               # 后端 + 引擎集成测试
│   └── web/                    # React 19 控制台 + 仪表板编辑器
│       ├── src/
│       │   ├── App.tsx         # 全部路由与能力门禁
│       │   ├── api.ts          # 同源 fetch 客户端（Cookie 会话 + ApiClientError.detail）
│       │   ├── auth.tsx        # 登录态 / RequireAuth / RequireCap
│       │   ├── roles.ts        # 四角色八能力（与后端同名）
│       │   ├── pages/          # 含 AssistantPage.tsx（AI 智能体）
│       │   ├── components/     # Layout、通用 UI、sql-editor、markdown-editor、models 弹窗
│       │   └── features/dashboard/   # 仪表板自包含模块（重点，59 文件）
│       ├── DATA/               # 资源库默认根目录（gitignored）
│       └── test/               # 前端纯函数测试
├── packages/
│   ├── engine/                 # HUSTERYX 执行引擎移植（DuckDB + mssql + xlsx）
│   │   └── src/
│   │       ├── engine/         # graph、executor、registry、duckdb、model、runStore
│   │       ├── nodes/          # 24 种节点实现（registry.ts 为准）
│   │       └── util/           # schema 探测、SQL 标识符、Excel、mssql
│   └── workflow-designer/      # HUSTERYX 前端画布复用包（独立 package.json）
├── docs/
│   ├── images/                 # README / USERGUIDE 截图
│   └── superpowers/            # 历史设计文档与实施计划（很有参考价值）
├── scripts/install-macos-service.sh
├── README.md                   # 功能总览 + 架构 + 快速开始
├── USERGUIDE.md                # 用户操作手册（功能变更需同步）
├── NOTE.md                     # 需求流水（Done / TODO）
├── BLOG.md                     # 技术博客（架构与取舍叙述）
└── HANDOFF.md                  # 本文件
```

### 路径别名

| 别名 | 指向 | 配置位置 |
|---|---|---|
| `@/*` | `packages/workflow-designer/src/*` | `apps/web/tsconfig.json`、`vite.config.ts`、根 `vitest.config.ts` |
| `@bi/*` | `apps/web/src/features/dashboard/*` | 同上（vitest 未配置 `@bi`，前端测试用相对路径） |

---

## 3. 架构与数据流

### 3.1 四层架构

1. **前端层**：`apps/web`，React 19；路由与按钮按**能力**门禁（`RequireCap`）。
2. **服务层**：`apps/server`，Fastify 5；REST + SSE、Cookie 会话、RBAC、Cron 调度、运行/Job 编排、连接密码加密、模型管理、AI 智能体、静态托管。
3. **执行引擎**：`packages/engine`（HUSTERYX 基线 `39451d8`），DuckDB 计算 + mssql 读写，按拓扑序执行节点；同时把 CSV/Excel/SQL Server 数据物化进 `models.duckdb`。
4. **存储**：
   - SQLite `~/.hustserver/metadata.sqlite`：全部元数据（含 AI 会话、数据标签）；
   - DuckDB `~/.hustserver/models.duckdb`：数据模型；
   - 目录：`uploads/`、`outputs/`、`spill/`；
   - 资源库：默认 `apps/web/DATA`（`HUSTSERVER_RESOURCE_DIR` 可覆盖）。

### 3.2 启动链路（[index.ts](apps/server/src/index.ts)）

1. `loadConfig()` + `ensureDirs()`；
2. 补齐引擎模块求值所需的 `HUSTSERVER_*` 环境变量后**动态 import** `server.ts`；
3. 打开 SQLite，执行幂等 `migrate()`；
4. 读取 DB 设置覆盖环境变量默认值（含 AI 配置）；
5. `buildServer()` 装配路由 + 两套调度器；
6. `ensureBootstrapAdmin()`；
7. `apps/web/dist` 存在时注册静态托管 + SPA 回退；
8. 启动调度器、日志清理、监听端口；
9. `SIGINT`/`SIGTERM` 优雅关闭。

### 3.3 一次工作流运行

```
手动 / Cron / Job 步骤
  → runService.trigger() 写入 runs
  → 信号量排队（MAX_CONCURRENT_RUNS，默认 2，来自设置）
  → 读 workflow payload + 连接密文
  → buildRuntimeWorkflow() 注入文件映射与连接
  → engine.createRun() + executeWorkflow()
  → 节点状态/日志回写 run_node_results / run_logs
  → SSE /api/runs/:runId/events 推送运行详情页
```

引擎节点失败时**只置状态不抛异常**；[runs/service.ts](apps/server/src/modules/runs/service.ts#L57-L77) 必须显式检查 `ctx.status === 'error'` 并抛错，否则失败会被记成成功。

### 3.4 一次 Job 运行

```
Job 级 Cron / 手动
  → jobService.trigger()
  → Job 级信号量（并发固定 1，独立于 workflow 信号量）
  → 按 seq 执行步骤：workflow / sql / load_model
  → 每步写 job_step_runs；on_failure = abort / continue
```

**注意**：运行参数（`freezeToken` / `reuseToken`）目前是内存态（[runs/service.ts](apps/server/src/modules/runs/service.ts#L113-L114)），跨进程方案需要先落库。

### 3.5 仪表板取数链路

```
打开 /dashboards/:id
  → GET /api/dashboards/:id 拿 payload（仅数据集定义）
  → dashboardStore.setDashboards() 恢复画布
  → 并行 hydrateDataset()：sql / data/query · file / resources download · model / models/query
  → 单个数据集失败只显示「重试」，不影响其它图表
  → 保存 PUT /api/dashboards/:id，payload 只回写定义
```

关键文件：[DashboardEditorPage.tsx](apps/web/src/features/dashboard/DashboardEditorPage.tsx)、[services/dataSource.ts](apps/web/src/features/dashboard/services/dataSource.ts)。

### 3.6 AI 智能体（Text2SQL）链路

```
AssistantPage → POST /api/assistant/chat { conversationId?, question, modelName? }
  → 读设置 assistant.apiBase / assistant.model / assistant.apiKeyEnc（AES 解密）
  → 构建系统提示词：可用数据模型表结构（全部模型 或 仅所选模型）
                     + 所选模型的数据标签 Markdown（若存在）
                     + 最近 HISTORY_LIMIT=12 条消息 + 会话摘要
  → 调用 OpenAI 兼容接口（DeepSeek，60s 超时），要求返回 {sql, answer} 计划
  → SQL 只读校验（禁 DDL/DML）+ 表白名单校验（限定所选模型）
  → DuckDB 执行（结果上限 200 行）
  → 失败时带错误信息回灌重试（MAX_ATTEMPTS=2）
  → 消息与 SQL 持久化到 assistant_messages
```

关键文件：[service.ts](apps/server/src/modules/assistant/service.ts)、[routes.ts](apps/server/src/modules/assistant/routes.ts)、[repo.ts](apps/server/src/modules/assistant/repo.ts)、[config.ts](apps/server/src/modules/assistant/config.ts)、[AssistantPage.tsx](apps/web/src/pages/AssistantPage.tsx)。

**当前限制**：AI 只能查询 DuckDB 数据模型，**还不能直接查询 SQL Server**；模型从数据推断，不做任意工具调用。

---

## 4. 关键约定与不变量（最容易踩的坑）

1. **显示名 vs 内部标识**：界面显示「个人数据工作台」，但包名 `@hustserver/*`、环境变量前缀 `HUSTSERVER_`、数据目录 `~/.hustserver`、LaunchAgent `com.hustserver.app`、仓库名 HUSTServer 均保持不变。
2. **密钥不能丢**：`ENCRYPTION_KEY` 同时加密连接密码和 AI API Key，换值两者全失效。
3. **`.env` 不会自动加载**：开发模式必须 `export`；只有 LaunchAgent 脚本会注入 plist。
4. **资源库默认目录** `apps/web/DATA`，解析为相对 `src`/`dist` 的 `../../web/DATA`；已 gitignore，需单独备份。
5. **仪表板 payload 不存行数据**：只存 `SavedDataset.def`；源不可用时可重试。
6. **仪表板编辑权限**：`dashboard.edit` +（管理员或 owner）；`dashboard.view` 可查看全部。
7. **REST 认证**：Cookie `hs_session`；能力校验必须在后端 `requireCap`，前端门禁只是体验层。
8. **请求体上限**：Fastify 全局 16MB；仪表板 payload 单独 8MB（超限 413 `payload_too_large`）。
9. **DuckDB 单写者**：模型加载与查询串行化（进程内 `createSemaphore(1)`）；写入用 staging 表 → 原子替换，失败不破坏旧模型。**DuckDB 不支持多进程同时读写同一文件**。
10. **Job 与 Workflow 信号量必须独立**：Job 并发固定 1，复用会死锁。
11. **前端别名**：`@` = workflow-designer，`@bi` = dashboard feature。
12. **测试环境是 node**：前端只测纯函数，无 DOM 测试；根 [vitest.config.ts](vitest.config.ts) 只收集 `apps/**/test` 与 `packages/**/test`。
13. **迁移幂等**：[migrate.ts](apps/server/src/db/migrate.ts) 用 `CREATE TABLE IF NOT EXISTS` + 列级兼容；新增表/列沿用此风格。
14. **新增工作流节点固定路径**：`types.ts` 加类型 → 新建 `nodes/<name>.ts` → `engine/registry.ts` 注册 → 设计器元数据/配置面板 → **重启后端**。预览、运行日志等通用逻辑无需改动。
15. **Monaco 体积控制**：只引 `editor.api.js` + 语言 register + `editor.worker.js?worker`，并设置 `self.MonacoEnvironment`（见 [sql-editor.tsx](apps/web/src/components/sql-editor.tsx)、[markdown-editor.tsx](apps/web/src/components/markdown-editor.tsx)）。不要全量引入 `monaco-editor`。
16. **错误详情透传**：后端错误用 `{ error, detail }`；前端 `ApiClientError.detail` 优先展示（[api.ts](apps/web/src/api.ts)、[error-note.tsx](apps/web/src/components/ui/error-note.tsx)）。

---

## 5. 功能现状

| 模块 | 状态 | 关键文件 |
|---|---|---|
| 登录 / 会话 / 登录日志 | ✅ | [auth/routes.ts](apps/server/src/modules/auth/routes.ts)、[auth.tsx](apps/web/src/auth.tsx) |
| 四角色八能力 RBAC | ✅ | [users/roles.ts](apps/server/src/modules/users/roles.ts)、[plugins/guards.ts](apps/server/src/plugins/guards.ts)、[web/roles.ts](apps/web/src/roles.ts) |
| 工作流上传 / 列表 / 详情 / 删除 | ✅ | [workflows/](apps/server/src/modules/workflows)、[WorkflowListPage.tsx](apps/web/src/pages/WorkflowListPage.tsx) |
| Web 工作流设计器（24 节点，Ribbon 三 Tab） | ✅ | [WorkflowDesigner.tsx](packages/workflow-designer/src/WorkflowDesigner.tsx)、[registry.ts](packages/engine/src/engine/registry.ts) |
| 工作流运行 / 实时日志 / 预览 / 缓存 | ✅ | [runs/](apps/server/src/modules/runs)、[RunDetailPage.tsx](apps/web/src/pages/RunDetailPage.tsx) |
| Cron 调度（工作流 / Job 两套） | ✅ | [schedules/](apps/server/src/modules/schedules) |
| Job 编排（workflow / sql / load_model） | ✅ | [jobs/](apps/server/src/modules/jobs)、[JobEditorPage.tsx](apps/web/src/pages/JobEditorPage.tsx) |
| Job 日志 / 导出 / 导入 | ✅ | [JobLogPage.tsx](apps/web/src/pages/JobLogPage.tsx)、[jobs/transfer.ts](apps/server/src/modules/jobs/transfer.ts) |
| 数据模型（DuckDB，staging 原子替换） | ✅ | [models/](apps/server/src/modules/models)、[ModelsPage.tsx](apps/web/src/pages/ModelsPage.tsx) |
| 模型预览 / 透视 / 列统计 / 列类型配置 | ✅ | [models/routes.ts](apps/server/src/modules/models/routes.ts)、[PivotBuilder.tsx](apps/web/src/components/pivot/PivotBuilder.tsx) |
| **模型数据标签（Markdown，供 AI 使用）** | ✅ | [ModelLabelModal.tsx](apps/web/src/components/models/ModelLabelModal.tsx)、`model_labels` |
| 模型列表「主操作 + 更多菜单」 | ✅ | [ModelsPage.tsx](apps/web/src/pages/ModelsPage.tsx#L243-L300) |
| 资源库（文件夹树 / 上传 / 移动 / 下载） | ✅ | [resources/routes.ts](apps/server/src/modules/resources/routes.ts)、[ResourcesPage.tsx](apps/web/src/pages/ResourcesPage.tsx) |
| 数据连接（密码加密、掩码回填） | ✅ | [connections/](apps/server/src/modules/connections) |
| 数据探索（只读 SQL + SQL Guard） | ✅ | [explore/](apps/server/src/modules/explore)、[DataExplorerPage.tsx](apps/web/src/pages/DataExplorerPage.tsx) |
| 仪表板（列表 / 编辑 / 只读预览 / 多页签） | ✅ | `apps/web/src/features/dashboard/` |
| 仪表板 Power BI 风格视图/插入 Ribbon | ✅ | `features/dashboard/`（书签播放、选择窗格、筛选器窗格、网格线、锁定、缩放、同步切片器） |
| 主页看板（数量卡片 + 新建趋势，横轴时间倒序） | ✅ | [overview/routes.ts](apps/server/src/modules/overview/routes.ts)、[HomePage.tsx](apps/web/src/pages/HomePage.tsx) |
| 系统审计 + 审计入模 | ✅ | [audit/](apps/server/src/modules/audit)、[AuditPage.tsx](apps/web/src/pages/AuditPage.tsx) |
| 系统设置（并发、日志保留、AI 智能体配置） | ✅ | [settings/](apps/server/src/modules/settings)、[SettingsPage.tsx](apps/web/src/pages/SettingsPage.tsx) |
| **AI 智能体（Text2SQL，多轮 + 会话管理）** | ✅ | [assistant/](apps/server/src/modules/assistant)、[AssistantPage.tsx](apps/web/src/pages/AssistantPage.tsx) |
| **会话长度查看（弹窗）+ 历史压缩** | ✅ | `assistant/routes.ts` + `AssistantPage.tsx` |

### 5.1 工作流节点（24 种，`nodeRegistry`）

输入：`inputCsv`、`inputExcel`、`inputSqlServer`、`textInput`
转换：`select`、`filter`、`join`、`findReplace`、`union`、`aggregation`、`sort`、`formula`、`unique`、`sample`、`cleansing`、`runningTotal`、`textToColumns`、`crossTab`、`transpose`、`browser`
输出：`dataModel`、`outputCsv`、`outputExcel`、`outputSqlServer`

> 设计器菜单遵循 Alteryx：大图标 + 文字在图标下方、节点竖排、长名称折行；顶部 Ribbon 按「输入 / 转换 / 输出」三个 Tab 分组。新增节点后节点卡片会按与引擎一致的规则显示橙色缺项角标。

### 5.2 仪表板视觉对象（20 种 + 切片器）

`bar`、`stackedBar`、`stackedBar100`、`horizontalBar`、`horizontalStackedBar`、`line`、`area`、`stackedArea`、`combo`、`pie`、`donut`、`scatter`、`treemap`、`decomposition`、`funnel`、`radialBar`、`table`、`kpi`、`map`、`matrix`，外加 `filter`（切片器）。

- 常规图表用 recharts；树状图、分解树、切片器、填充地图、透视表为自绘 SVG/HTML，贴近 Power BI 行为。
- 字段拖拽协议：字段窗格 → 字段井 `application/x-bi-field`，可视化画廊 → 画布 `application/x-bi-visual`。
- 切片器状态存于 `slicer.state` 并随仪表板保存；`lib/slicer.ts` 统一翻译为 `ValueFilter[]` 作用于本页所有图表。
- 交叉筛选顺序：切片器 → 交叉筛选 → 聚合（[lib/highlight.ts](apps/web/src/features/dashboard/lib/highlight.ts)）。
- 树状图/分解树纯函数在 [lib/treemap.ts](apps/web/src/features/dashboard/lib/treemap.ts)、[lib/decomposition.ts](apps/web/src/features/dashboard/lib/decomposition.ts)。

---

## 6. AI 智能体模块（最新功能，接手重点）

### 6.1 文件与职责

| 文件 | 职责 |
|---|---|
| [assistant/config.ts](apps/server/src/modules/assistant/config.ts) | 读 `assistant.apiBase` / `assistant.model` / `assistant.apiKeyEnc`，解密 API Key |
| [assistant/repo.ts](apps/server/src/modules/assistant/repo.ts) | 会话、消息 CRUD（`assistant_conversations` / `assistant_messages`） |
| [assistant/service.ts](apps/server/src/modules/assistant/service.ts) | 提示词构建、LLM 调用、SQL 校验执行、重试、体量统计、压缩 |
| [assistant/routes.ts](apps/server/src/modules/assistant/routes.ts) | 7 个端点 |
| [AssistantPage.tsx](apps/web/src/pages/AssistantPage.tsx) | 会话列表、聊天、模型下拉、长度弹窗、压缩、错误详情 |

### 6.2 关键常量（改行为前先看这里）

```ts
RESULT_LIMIT = 200        // 返回给前端的最大行数
HISTORY_LIMIT = 12        // 下发给模型的历史消息条数
MAX_ATTEMPTS = 2          // SQL 失败后带错误回灌重试次数
LLM_TIMEOUT_MS = 60_000   // 单次调用超时
SUMMARY_MAX_CHARS = 800   // 压缩摘要目标字数
TRANSCRIPT_MESSAGE_MAX = 400 // 压缩时单条消息截断长度
```

- 会话体量按 UTF-8 字节统计，`上下文 = 摘要 + 压缩点之后的历史`，与真实下发一致。
- 压缩是**增量**的：只压缩 `compressed_until_seq` 之后、且不属于当前轮的消息；压缩后写 `summary` 并推进 `compressed_until_seq`。
- 选择数据模型后：提示词只暴露该模型表结构，SQL 表白名单也收紧为该模型；同时注入该模型的**数据标签 Markdown**（实时读取，不缓存；未选模型或标签为空则不注入）。
- 设置默认值：`https://api.deepseek.com` / `deepseek-chat`。

### 6.3 已知问题

1. **额度耗尽时调用失败**：DeepSeek 额度用尽会返回 429 `AccountQuotaExceeded`（每周额度，周一 00:00 +08:00 重置）。页面现在会展示该原始错误详情，可据此继续做错误分支开发。
2. 无 server 端单测覆盖数据标签路由（`GET/PUT /api/models/:name/label`）；assistant 有 11 个用例。
3. 目前仅支持查询 DuckDB 数据模型，不支持 SQL Server 直查。

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
| `runs` / `run_node_results` / `run_logs` | 运行、节点结果、日志（含 `job_run_id`） |
| `jobs` / `job_steps` / `job_runs` / `job_step_runs` | Job 定义、步骤、运行、步骤运行 |
| `dashboards` | 仪表板名称与 payload |
| `login_logs` / `audit_logs` | 登录日志、管理操作审计 |
| `data_models` / `model_column_configs` | 模型元数据、列类型覆盖 |
| **`model_labels`** | 每个模型一段 Markdown 数据标签（`model_name` 主键 / `content` / `updated_at`） |
| **`assistant_conversations`** | AI 会话（`title`、`summary`、`compressed_until_seq`） |
| **`assistant_messages`** | AI 消息（`seq` 唯一，含 `role`、`content`、SQL、结果 JSON） |
| `settings` | 系统设置键值（覆盖环境变量），含 `assistant.*` |

---

## 8. API 索引

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
| 数据模型 | `POST /api/models`、`GET /api/models`、`GET/PUT /api/models/:name/column-config`、**`GET/PUT /api/models/:name/label`**、`POST /api/models/query`、`POST /api/models/pivot`、`POST /api/models/distinct`、`POST /api/models/stats`、`PATCH/DELETE /api/models/:name` |
| 数据探索 | `GET /api/explore/models`、`POST /api/explore/columns`、`POST /api/explore/query` |
| 资源库 | `GET /api/resources`、`GET /api/resources/tree`、`GET /api/resources/sheets`、`GET /api/resources/folders/tree`、`POST /api/resources/move`、`POST /api/resources/folders`、`POST /api/resources/files`、`PATCH/DELETE /api/resources/folders`、`PATCH/DELETE /api/resources/files`、`GET /api/resources/files/download` |
| 结构探测 | `POST /api/schema/csv`、`POST /api/schema/excel`、`POST /api/schema/sqlserver` |
| 仪表板 | `GET/POST /api/dashboards`、`GET/PUT/DELETE /api/dashboards/:id` |
| AI 智能体 | `GET /api/assistant/status`、`POST /api/assistant/chat`、`GET /api/assistant/conversations`、`GET /api/assistant/conversations/:id/messages`、`GET /api/assistant/conversations/:id/stats`、`POST /api/assistant/conversations/:id/compress`、`DELETE /api/assistant/conversations/:id` |
| 主页 / 审计 / 设置 | `GET /api/admin/overview`、`GET /api/admin/audit-logs`、`POST /api/admin/audit-logs/load-model`、`GET/PUT /api/admin/settings` |

> 所有路由都通过 `requireAuth` + `requireCap`（或 `requireAnyCap`）；前端 `RequireCap` 只是体验层。
> 能力约定：模型读 `dashboard.view`，模型写/数据标签写 `job`。

---

## 9. 测试与验证

### 9.1 现状（2026-10-25 实测）

```
Test Files  62 passed (62)
Tests       438 passed (438)
Duration    ~10s
```

覆盖：认证、RBAC、工作流解析/映射、运行队列/执行失败、调度、Job、模型加载/透视/统计、连接、审计、资源、仪表板、数据查询、AI 智能体（11 用例：成功、只读拦截、未知表、失败重试、追问、未配置、Key 加密、指定模型、跨模型拦截、压缩等）。

### 9.2 命令

```bash
pnpm test                                  # 全部测试
pnpm --filter @hustserver/web typecheck    # 前端类型检查
npx tsc --noEmit -p apps/server/tsconfig.json   # 后端类型检查（必要时）
pnpm build                                 # 全量构建
```

### 9.3 浏览器验证习惯（TRAE-browseruse）

- 使用 `TRAE-browseruse` skill / `browser_use` 子代理，登录后走真实交互；验证完清理临时数据。
- **Radix DropdownMenu 的自动化点击不稳定**：改用 `document.querySelectorAll('button[aria-haspopup=menu]')[i].focus()` + `browser_press_key('Enter')` 打开菜单，菜单项本身可正常 pointer 点击。
- `browser_evaluate` 里避免 IIFE / `function(){}` / `outerHTML`；用顶层 `var` + 箭头函数，只返回原始值。
- 判断弹窗是否打开时，`role=dialog` 可能为 0（项目用的是自绘 Modal），用 DOM 快照更可靠。

---

## 10. 最近提交与待办

### 10.1 最近提交

| 提交 | 内容 |
|---|---|
| `bc05b3f` | **新增 AI 智能体 Text2SQL 与数据标签，补充 Alteryx 风格工作流节点**（33 文件，+3368/-56） |
| `6fd30db` | 复刻 Power BI 视图/插入能力，新增书签播放与筛选器窗格 |
| `d282030` | 仪表板补齐 Power BI 设计能力，新增 8 个 Alteryx 风格节点 |
| `af6c451` | 新增技术博客 |
| `f578466` | 复刻 Power BI 切片器、树状图与分解树 |
| `849618e` | 数据模型列类型配置 + 审计日志入模 + 左侧导航 |

### 10.2 待办 / 已知不一致

1. **`HANDOVER.md` → `HANDOFF.md` 更名未提交**（git 显示 `D HANDOVER.md` + `?? HANDOFF.md`）；提交时用 `git add -A` 让 Git 识别为改名。
2. **`pnpm-lock 2.yaml`** 未跟踪，是旧锁文件副本，建议删除。
3. **数据标签路由缺少单测**，需要时可补 `apps/server/test/models.test.ts` 风格用例。
4. **AI 智能体只支持 DuckDB 模型**，SQL Server 直查是明确的下一迭代点。
5. **NOTE.md 的 TODO**：预览模式下「点按钮弹出集中筛选器子窗体」尚未实现（已有切片器视觉对象覆盖大部分诉求，动手前先确认是否仍需要）。
6. **README.md 略滞后**：未提到切片器 / 树状图 / 分解树 / AI 智能体 / 数据标签；`USERGUIDE.md` 更新较多，改文档时顺手补。
7. **`~/.hustserver/app.db`、`hustserver.db`** 为 0 字节残留，可清理。

### 10.3 已讨论但未实施的方向（结论可直接沿用，不必重新分析）

**A. 后端进程拆分（工作流/仪表板 vs 定时任务）**

- 诉求：前台卡死不要拖垮 cron/Job。
- 关键约束：`models.duckdb` 单文件单写者，DuckDB 不支持多进程并发读写；`maxConcurrentRuns`、Job 并发=1 都是**进程内信号量**，拆进程后失效；两套 scheduler 会重复触发；freeze/reuse token 是内存态。
- 结论：若拆，必须「API 进程纯 HTTP + 同进程独占 DuckDB 与全部 cron 的 Worker」，并用 SQLite 租约锁替代内存信号量，同时补执行超时；**不要让两个进程各自打开 DuckDB**。
- 更小成本替代：先加执行超时 + 子进程隔离 + 资源上限，再评估是否需要拆。

**B. 桌面版前端**

- 结论：在**本仓库**新增 `apps/desktop`，不要另开项目复制代码。
- 形态：Electron/Tauri 壳 + 内置 `apps/server` 作 sidecar（`utilityProcess.fork`），数据目录指应用私有目录（与 `~/.hustserver` 隔离），回环地址 + 随机端口，单实例锁，首次启动生成密钥与本地 token。
- 关键结论：仪表板/工作流的 UI 与功能改动**只改 web**（桌面壳加载同一份 web 构建产物），只有壳层能力（窗口、菜单、快捷键、自动更新、原生文件）需要单独开发。
- 需明确的产品语义：应用关闭后本地 cron 停止；若要求 7×24 调度，必须保留远程常驻服务。

---

## 11. 给接手的 AI 的阅读顺序与工作约定

### 建议阅读顺序

1. 本文件；
2. [README.md](README.md)（功能总览 + 架构 + 环境变量）；
3. [USERGUIDE.md](USERGUIDE.md)（用户视角操作路径，改功能需同步）；
4. [apps/server/src/server.ts](apps/server/src/server.ts)（所有模块装配）；
5. [apps/server/src/db/migrate.ts](apps/server/src/db/migrate.ts)（数据模型全貌）；
6. 按任务进入 `modules/*`、`features/dashboard/*` 或 `modules/assistant/*`；
7. 历史设计：`docs/superpowers/specs/`、`docs/superpowers/plans/`。

### 工作约定

- **界面与注释使用中文**；代码标识符保持英文。
- 改功能同步更新 `USERGUIDE.md`（必要时 `README.md`）；新增截图放 `docs/images/`。
- 新增后端能力：沿用 `modules/<domain>/{repo,routes,service}.ts`；所有路由加 `requireAuth` + `requireCap`。
- 新增前端页面：`App.tsx` 注册路由 + `RequireCap`，`Layout.tsx` 加导航项（按能力显示）。
- 新增纯逻辑优先放 `lib/` 并补 vitest（无 DOM 依赖）。
- 不引入 Docker；macOS 本机部署是硬约束。
- 复用 HUSTERYX（前端基线 `836b22a`、引擎基线 `39451d8`），不要重写设计器或执行引擎。
- 避免过度设计：小改动直接改现有文件，不额外造抽象层。
- 完成后至少跑：`pnpm test` + `pnpm --filter @hustserver/web typecheck` + `pnpm build`。
- 涉及 LLM 时注意额度：429 `AccountQuotaExceeded` 是每周额度，重置时间在错误详情里；开发期可用「错误详情展示」分支继续推进。

---

## 12. 常用命令速查

| 目的 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 开发（前后端并行） | `pnpm dev` |
| 全量构建 | `pnpm build` |
| 只构建后端 | `pnpm --filter @hustserver/server build` |
| 启动生产服务 | `node apps/server/dist/index.js` |
| 全量测试 | `pnpm test` |
| 前端类型检查 | `pnpm --filter @hustserver/web typecheck` |
| 安装 macOS 服务 | `bash scripts/install-macos-service.sh` |
| 卸载 macOS 服务 | `bash scripts/install-macos-service.sh --uninstall` |
| 查看服务状态 | `launchctl list \| grep com.hustserver.app` |
| 服务日志 | `~/Library/Logs/HUSTServer/stdout.log` / `stderr.log` |
| 数据目录 | `~/.hustserver` |
| 资源库目录 | `apps/web/DATA` |
| 查后端进程 | `ps -eo pid,command \| grep dist/index.js` |

---

_结束。若迁移后连接密码或 AI API Key 解密失败，优先检查 `ENCRYPTION_KEY` 是否与旧机器一致。_
