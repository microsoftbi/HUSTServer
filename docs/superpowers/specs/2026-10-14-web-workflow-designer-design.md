# HUSTServer 设计文档：Web 工作流设计器（复用 HUSTERYX）

- 日期：2026-10-14
- 状态：已批准
- 依据：[2026-10-14-hustserver-design.md](./2026-10-14-hustserver-design.md)、[INIT.md](../../../INIT.md)
- 参考项目：[microsoftbi/HUSTERYX](https://github.com/microsoftbi/HUSTERYX)

## 1. 背景与目标

平台一期只做「调度托管层」：用户用 HUSTERYX 桌面工具做画布、导出 `.htyx`、上传到站点，站点负责调度、执行与日志。画布编辑被列为非目标。

本设计**逆转该非目标**：把 HUSTERYX 的前端画布设计器复用进平台 Web，让用户可以直接在站点上新建 / 编辑工作流，而不必回到桌面工具。

### 目标（第一阶段）

1. 在平台 Web 内提供**画布编辑**能力：拖拽节点、连线（含成环与端口约束）、移动、删除。
2. 提供**节点配置面板**：13 种节点的配置项编辑（含 SQL Server 连接）。
3. **保存并发布到平台**：把编辑结果写回平台工作流（覆盖 payload）。
4. 支持**新建空白画布**与**编辑已有工作流**两条入口。

### 非目标（第一阶段明确不做）

- 在线试跑、运行、阶段数据预览、SSE 实时日志、缓存（沿用平台既有「运行详情」页）。
- 多用户实时协作、工作流版本历史 / 回滚。
- 结构探测自动填充列下拉（CSV/Excel schema、SQL 列探测）——降级为手动输入 / 后续阶段。
- 桌面（Tauri）打包能力。

## 2. 范围与关键决策

| 决策项 | 结论 |
|---|---|
| 复用路线 | **B：抽 `packages/workflow-designer` 共享包**，通过适配器接口注入平台能力 |
| 复用语义 | 复制 HUSTERYX 前端设计器代码到独立 workspace 包，收敛为「同一份代码」而非分叉 |
| 第一阶段动作范围 | 画布编辑 + 节点配置 + 保存并发布；运行/日志用平台既有页面 |
| SQL Server 连接 | **在设计器节点配置面板内保留连接表单**；载入用掩码回填，发布由服务端抽取 + 合并 |
| 新建 vs 编辑 | **两者都支持**：编辑已有工作流 + 新建空白画布 |
| 保存语义 | **单一「保存并发布」**（覆盖平台 payload，无草稿态） |
| 与既有架构一致性 | 与 `packages/engine`（vendor HUSTERYX 后端引擎）同一模式 |

## 3. 与既有设计的偏离

[2026-10-14-hustserver-design.md](./2026-10-14-hustserver-design.md) 中以下条目本次修订：

- 第 26 行「非目标：画布 / DAG 编辑、工作流可视化只读渲染」→ 画布编辑不再是非目标，本设计引入。
- 第 32 行「仅调度托管层：站点不提供画布」→ 站点**提供画布**，上传外部 `.htyx` 仍保留为一种入口。
- 第 128 行「前端 `apps/web`：管理控制台，无画布」→ 新增设计器子应用（作为包被 `apps/web` 消费）。
- 第 259–282 行 API 契约 → 新增 `PUT /api/workflows/:id`（见第 8 节）。

其余（引擎 vendoring、调度、RBAC、连接加密托管等）不变。

## 4. 复用调研结论

- **后端引擎已复用**：`packages/engine` 即 HUSTERYX `backend/src` 的移植（`engine/`、`nodes/*`、`util/*`、`types.ts`）。本次无需再动引擎。
- **真正缺口是前端设计器**。HUSTERYX 前端为单页 `Workbench`（React 19 + Vite + Tailwind v4 + React Flow 12 + Zustand 5 + shadcn/radix）。
- 需要处理 **6 个硬耦合点**（三套方案都必须解决）：

| # | 耦合点 | 现状 | 处置（第一阶段） |
|---|---|---|---|
| 1 | 文件打开/保存走 Tauri | `lib/desktop.ts` 调 Tauri 对话框 | 改为「从平台读取 + 保存并发布到平台」 |
| 2 | `store.run()` 依赖本地运行语义 | `POST /api/runs`（targetNodeId/freeze/缓存令牌）+ SSE，与平台队列/调度不同源 | 移除运行相关状态与动作 |
| 3 | `api/client.ts` 不适用 | 硬编码 base、无 Cookie 凭据、含 Tauri 分支 | 改用平台 `apps/web/src/api.ts`（同源 + `credentials:'include'`） |
| 4 | 平台缺结构探测接口 | 无 CSV/Excel schema、SQL 列探测、阶段预览 | 第一阶段降级（列下拉手动输入/空） |
| 5 | 平台缺「更新工作流」路由 | 仅创建/删除，`repo.updatePayload` 未暴露 | 新增 `PUT /api/workflows/:id` |
| 6 | 缺 shadcn 主题层 | 平台 `index.css` 仅 `@import "tailwindcss"` | 主题变量与 React Flow 样式随包提供、作用域化引入 |

## 5. 方案选型

| 维度 | A. 拷贝进 `apps/web/src/designer/` | **B. `packages/workflow-designer`（选定）** | C. 独立子应用 + iframe |
|---|---|---|---|
| 边界 | 无接口，散在页面目录 | **适配器注入，与 6 个耦合点一一对应** | postMessage，脆弱 |
| 架构一致性 | 中 | **高（先例：`packages/engine`）** | 低 |
| 登录态/权限 | 同源 Cookie | 同源 Cookie | 跨 iframe 需额外处理 |
| 长期维护 | 与 HUSTERYX 分叉 | 包化后可反向同步 | 无同步但体验割裂 |
| 落地成本 | 中 | 中偏高 | 低 |

选 **B**：把 6 个耦合点收敛成一组显式适配器接口，长期保持「同一份代码」；C 仅为应用拼接、登录态/主题割裂，不采用。

## 6. 包结构与公共契约

```
packages/workflow-designer/
  src/
    components/
      canvas/{FlowCanvas,NodeCard,NodePalette,Toolbar}.tsx
      panels/{InputPanels,TransformPanels,OutputPanels,NodeConfigPanel,fields,SqlConnectionForm}.tsx
      ui/*                       # shadcn 原子组件
    lib/{nodeMeta,graph,format,utils}.ts
    store/workflowStore.ts       # 裁剪自 HUSTERYX workflowStore
    WorkflowDesigner.tsx         # 公共组件入口
    adapters.ts                  # DesignerAdapter 接口
    types.ts                     # Workflow / WorkflowNode / WorkflowEdge / ColumnMeta ...
    designer.css                 # shadcn 变量 + react-flow 样式（作用域化）
    index.ts                     # 导出 WorkflowDesigner / types / adapters
  package.json                   # name: @hustserver/workflow-designer；含 husteryxBaseline 基线标记
  tsconfig.json
```

包名沿用 workspace 约定 `@hustserver/*`（对齐 `@hustserver/engine`）。`package.json` 记录 `husteryxBaseline`（如 `microsoftbi/HUSTERYX@<commit>`），便于后续与上游 diff 同步——与 `packages/engine` 的做法一致。

**从 HUSTERYX 裁剪掉**：`lib/desktop.ts`、`api/{client,sse}.ts`、`components/preview/*`、`components/settings/*`、`store` 中的 `run/cacheTo/clearCache/loadPreview/fetchSchemas` 与全部运行态（`runId/runStatus/nodeStatus/nodeResults/logs/runScope/cacheToken/...`）、`subscribeRun` 依赖、`Toolbar` 的运行/缓存按钮。

**保留**：画布操作（`addNode/updateNodeName/updateNodeConfig/setNodePosition/removeNode/addEdge/removeEdge/selectNode`，含成环检测与 union 多输入例外）、`NODE_META`、`graph`/`format`/`utils`、节点配置面板全部、`SqlConnectionForm`。

### 公共契约

```ts
export interface ColumnMeta { name: string; type: string }

/** 平台能力注入：隔离运行时差异。 */
export interface DesignerAdapter {
  /** 保存并发布到平台（覆盖 payload）。 */
  onSave(workflow: Workflow): Promise<void>;
  /** 结构探测（第一阶段可省略，返回空数组即可）。 */
  probeSchema?: (
    kind: NodeKind,
    config: Record<string, unknown>,
  ) => Promise<ColumnMeta[]>;
}

export interface WorkflowDesignerProps {
  initialWorkflow: Workflow;
  adapter: DesignerAdapter;
  /** 返回列表/详情的导航回调（由宿主页提供，包内不依赖 router）。 */
  onExit?: () => void;
}

export function WorkflowDesigner(props: WorkflowDesignerProps): JSX.Element;
```

设计约束：

- 包内**不 import** `react-router-dom`、平台 `api.ts`、Tauri；一切外部能力经由 props/`adapter` 注入。
- 包内 store 为**受控**：初始值来自 `initialWorkflow`，变更后由宿主决定何时调用 `adapter.onSave`。
- `onExit` 由宿主传入，包内不假设路由形态。

## 7. 前端接入（`apps/web`）

- **依赖**：`apps/web` 增加 workspace 依赖 `@hustserver/workflow-designer`。
- **路由**：新增 `/workflows/:id/designer`（编辑）与 `/workflows/new/designer`（新建）。
- **页面** `WorkflowDesignerPage`：
  - 编辑：`GET /api/workflows/:id` 取 payload → 再 `GET /api/workflows/:id/connections` 取掩码连接，合并回 `nodes[].config.connection` → 交给 `<WorkflowDesigner initialWorkflow=... />`。
  - 新建：构造空白 `Workflow`（`nodes: []`, `edges: []`）。
  - `adapter.onSave`：编辑 → `PUT /api/workflows/:id`；新建 → `POST /api/workflows`。
  - `onExit`：`navigate(-1)` 或回列表。
- **入口**：
  - [WorkflowListPage.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/pages/WorkflowListPage.tsx) 操作列加「编辑画布」+ 顶部「新建画布」。
  - [WorkflowDetailPage.tsx](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/pages/WorkflowDetailPage.tsx) 顶部加「编辑画布」。

## 8. 服务端改动

新增一个路由（复用请求 A 已建逻辑，保持安全不变量）：

| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | `/api/workflows/:id` | 保存并发布：`{ name?, workflow }` |

处理流程：

1. `loadChecked` 权限校验（管理员或 owner）。
2. `parseWorkflowPayload(JSON.stringify(workflow))` 校验结构。
3. `extractEmbeddedConnections(workflow)` → `wfConnections.upsert`（密码缺省沿用原值，复用 `mergeConnectionConfig`）。
4. `stripEmbeddedConnections` → `update(id, { name?, payload? })`（实现含 `******` 哨兵归一 + `mergeConnectionConfig` 留空沿用，见 `apps/server/src/modules/workflows/routes.ts` 的 PUT 路由）。
5. 返回 `{ ok: true, id, name }`。

非 SQL 节点的 `config` 原样保留（含 `path` 等作者本机路径，与既有上传流程一致）。

## 9. 样式与构建

- 包内 `designer.css`：引入 shadcn CSS 变量（`:root` + `.dark`）+ `@xyflow/react/dist/style.css` + React Flow 主题覆盖。
  - **去除全局 `body { overflow: hidden }`**（原 HUSTERYX 全局样式），改由设计器根容器约束高度，避免污染平台其余页面。
  - 外层用专用容器类（如 `.hust-designer`）承载高度与滚动，变量与 React Flow 覆盖尽量收敛在该类下，降低与平台样式的相互影响。
- 宿主 [index.css](file:///Users/wadesong/Desktop/TEST/HUSTServer/apps/web/src/index.css) 增加 `@source "../../../packages/workflow-designer/src"`，使 Tailwind v4 扫描到包内 class。
- 包以 **TS/TSX 源码**形式导出（`exports: { ".": "./src/index.ts" }`），由宿主 Vite 直接编译（UI 包含 JSX 与 Tailwind class，源码消费最简）。`apps/web` 的 `tsconfig` 需能解析该入口（必要时加 `paths` 映射），并确保 `tsc` 类型检查覆盖包内文件。
- 依赖挂到包：`@xyflow/react`、`zustand`、`@radix-ui/react-{dialog,dropdown-menu,label,scroll-area,select,separator,slot,switch,tabs,tooltip}`、`lucide-react`、`class-variance-authority`、`clsx`、`tailwind-merge`；`react`/`react-dom` 为 peer。`tw-animate-css` 视使用情况引入。

## 10. 安全与数据不变量（保持不变）

- `workflows.payload` **绝不包含明文连接**；SQL 连接由服务端加密存入 `workflow_connections`（`stripEmbeddedConnections` 保证）。
- 载入设计器时连接经 `GET /api/workflows/:id/connections` 返回**掩码**（password = `******`）；发布时密码留空 = 沿用原值。
- 设计器与发布接口均受会话 Cookie 与 RBAC 约束（`requireAuth` + owner/admin）。

## 11. 关键流程

### 11.1 编辑并发布

1. 用户从列表/详情进入 `/workflows/:id/designer`。
2. 页面并行取 `GET /api/workflows/:id` 与 `GET /api/workflows/:id/connections`，合并后渲染设计器。
3. 用户拖拽 / 配置 → 点「保存并发布」。
4. `adapter.onSave` → `PUT /api/workflows/:id`。
5. 服务端抽取内嵌连接 → 加密留存 → 剥离 → 覆盖 payload。
6. 返回成功，页面提示并（可选）跳回详情；后续调度/运行使用最新 payload。

### 11.2 新建并发布

1. 用户进入 `/workflows/new/designer`（空白画布）。
2. 编辑完成后「保存并发布」→ `POST /api/workflows` → 跳转到 `/workflows/:id/designer` 或详情。

## 12. 测试策略

- **包单元测试**（vitest）：`workflowStore` 画布操作（`addNode`、`addEdge` 端口占用 / union 多输入 / 成环拒绝、`removeNode` 级联删边）、序列化产物结构。
- **服务端测试**：`PUT /api/workflows/:id` —— 越权 403、结构非法 400、内嵌连接抽取 + payload 无明文、密码留空沿用、名称更新。
- **Web 冒烟**：`/workflows/:id/designer` 渲染、保存按钮触发 `PUT`（可用 mock fetch）。
- 回归：既有 `workflow-routes` / `workflow-mapper` 测试保持通过。

## 13. 风险与待定

| 项 | 说明 | 应对 |
|---|---|---|
| 样式污染 | 包内全局样式（body overflow、变量）可能影响平台其它页面 | 作用域化到 `.hust-designer`；去全局 body 规则 |
| 依赖膨胀 | `apps/web` 新增 React Flow / radix / zustand | 只挂在设计器包，宿主按需消费；可后续做懒加载分包 |
| 上游同步 | HUSTERYX 更新需人工同步到包 | 固定基线，集中适配层（`adapters.ts`），便于 diff |
| 列下拉缺失 | 一阶段无结构探测，配置面板列选择退化 | 允许手输；后续接入平台 schema 接口补齐 |
| 路径语义 | 设计器内的输入文件路径仍是作者本机路径 | 沿用既有「上传/绑定数据文件」流程（`mappings`）重映射 |

## 14. 里程碑

- **P1 包骨架与适配层**：建 `packages/workflow-designer`、拷贝并裁剪设计器、定义 `DesignerAdapter` 与 `WorkflowDesigner`、样式作用域化、Tailwind `@source` 接入。
- **P2 平台接入**：`WorkflowDesignerPage`、路由与入口、连接掩码合并、保存/发布调用。
- **P3 服务端发布接口**：`PUT /api/workflows/:id`（含内嵌连接抽取 + 剥离 + 测试）。
- **P4 收紧与回归**：包单测、服务端用例、Web 冒烟、全量回归。
