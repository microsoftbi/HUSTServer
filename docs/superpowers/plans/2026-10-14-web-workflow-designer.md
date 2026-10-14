# Web 版工作流设计器（复用 HUSTERYX 前端）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 HUSTERYX 桌面端的前端设计器（React Flow 画布 + 节点配置面板）抽取为共享包 `packages/workflow-designer`，接入 HUSTServer Web 端，支持在浏览器里「新建画布 / 编辑画布」，保存时发布到平台（复用内嵌连接抽取 + 加密留存机制）。运行与日志沿用现有「运行详情」页。

**Architecture:** pnpm workspace 新增包 `@hustserver/workflow-designer`（TS/TSX 源码直接导出，不预编译）。包内组件通过 `DesignerAdapter` 接口与宿主解耦（保存回调 + 4 个可选探测能力），通过 `DesignerHostContext` 注入。宿主 `apps/web` 提供 `@/` 路径别名、Tailwind 主题层（`@theme inline` / `@custom-variant dark` / base 层）与全屏路由，页面 `WorkflowDesignerPage` 负责加载工作流 + 合并掩码连接 + 保存发布（新建 POST / 编辑 PUT）。服务端新增 `PUT /api/workflows/:id`。

**Tech Stack:** React 19 + @xyflow/react 12 + Zustand 5 + Tailwind v4 + radix/shadcn 原子组件；Fastify 5 + better-sqlite3（服务端增量）；vitest（测试）。

**Spec:** [docs/superpowers/specs/2026-10-14-web-workflow-designer-design.md](../specs/2026-10-14-web-workflow-designer-design.md)

## Global Constraints

- **本轮全程不执行 `git commit`**（用户明确要求；此约束覆盖主计划「每个任务结束时必须提交」的要求。所有变更保留在工作区）。
- 源克隆固定为本地路径 `/Users/wadesong/Desktop/TEST/HUSTERYX`（HEAD = `836b22a733dc569f7721ebda566e9009b9f9cc01`，已实测确认）。所有「拷贝」均指从该路径复制。
- 包内文件**尽量与上游逐字节一致**：只删不改、能拷贝不重写；`@/` 路径别名保留原样。
- 安全不变量：`workflows.payload` 绝不落明文连接（服务端 `stripEmbeddedConnections`）；掩码密码哨兵 `******` 不得作为新密码落库；密码留空 = 沿用原值（`mergeConnectionConfig`）。
- 不改引擎（`packages/engine`）与既有运行链路；不动 HUSTERYX 克隆仓库。
- 平台适配：派发子代理**绝不传 model 参数**；禁用 `find`/`cat`/`sed`，用 Read/Glob/Grep/Edit 专用工具。

## 与 Spec 的实现细化（不改变语义）

1. **`@/` 别名保留**：宿主 `apps/web/vite.config.ts` 加 `resolve.alias['@']`；`apps/web/tsconfig.json` 加 `paths`；包自身 `tsconfig.json` 加 `paths`；根 `vitest.config.ts` 加 `resolve.alias`（包内测试经 `@/` 导入时需要）。
2. **CSS 变量全局 + dark 类挂 `documentElement`**：Radix 弹层 portal 到 `document.body`，故 `:root`/`.dark` 变量在 designer.css 中全局生效；`WorkflowDesignerPage` 挂载时给 `document.documentElement` 加 `dark` 类；设计器路由放在 `<Layout>` 之外（全屏）。
3. **designer.css 不含 Tailwind 指令**：`@import 'tailwindcss'`、`@import 'tw-animate-css'`、`@custom-variant dark`、`@theme inline`、`@layer base` 全部放在宿主 `apps/web/src/index.css`；designer.css 仅保留 `@import '@xyflow/react/dist/style.css'` + 变量 + 作用域化的 ReactFlow 覆盖。
4. **DesignerAdapter 补 4 个可选能力**：`uploadFile?` / `listSheets?` / `listSqlDatabases?` / `listSqlObjects?`。一阶段平台均不提供 → 面板自动降级（隐藏上传/刷新/连接按钮，保留手动输入分支）。
5. **能力注入**：包内新增 `context.tsx`（`DesignerHostProvider` / `useDesignerHost`，承载 `{ adapter, onExit }`），替代面板中的 `api` 直连。
6. **列下拉降级**：`ColumnSelect` 在无候选列时渲染可编辑 `Input`；store 保留 `inputSchemas` / `nodeColumns` 恒空字段，`fields.tsx` 与 `lib/schema.ts` 零改动。
7. **服务端**：`workflowsRepo.updatePayload` 改造为 `update(id, { name?, payload? })`，同步 `workflow-repo.test.ts:27`；新增 `PUT /api/workflows/:id`。
8. **掩码密码哨兵清洗**：`WorkflowDesignerPage.onSave` 发送前把 `config.connection.password === '******'` 改写为 `''`（走「留空=沿用原值」分支）。
9. **store 文件名保留 `workflowStore.ts`**（导出名 `useWorkflowStore` 不变），仅内容裁剪——最大化与上游的逐字节一致性（spec §6 中的 `designerStore.ts` 命名据此调整）。
10. **新增拷贝 `lib/schema.ts`**（spec §6 未列出）：`fields.tsx` 的 `deriveNodeColumns` 来自该文件，必须随包拷贝（纯函数，无 api 耦合，已验证）。
11. **时间戳保持 number（执行裁决）**：包内 `Workflow` 类型与上游逐字节一致（`id: string; createdAt: number; updatedAt: number`），store 的 `workflowId`/`workflowCreatedAt` 维持上游 `string | null`/`number | null`；`snapshot()` 以 `?? ''`/`?? 0` 收敛空值并返回 `updatedAt: Date.now()`；页面 `blankWorkflow()` 用 `Date.now()`。服务端 `parseWorkflowPayload` 会把时间戳归一为自身值，引擎侧 number 形态不受影响。

## File Structure

```
packages/workflow-designer/            # 新建
  package.json                         # name/husteryxBaseline/exports（TS 源码）
  tsconfig.json                        # Bundler + DOM + @/ paths
  src/
    types.ts                           # 拷贝上游后裁剪（删运行/设置类型）
    adapters.ts                        # DesignerAdapter + WorkflowDesignerProps（新写）
    context.tsx                        # DesignerHostProvider / useDesignerHost（新写）
    WorkflowDesigner.tsx               # 公共组件入口（新写）
    index.ts                           # 导出面（新写）
    designer.css                       # 由上游 index.css 转换（删 Tailwind 指令、作用域化）
    store/workflowStore.ts             # 拷贝上游后裁剪 + 新增 loadWorkflow/markSaved/snapshot
    lib/{nodeMeta,schema,graph,format,utils}.ts   # 拷贝上游（verbatim）
    components/ui/*.tsx                # 拷贝上游全部 14 个 shadcn 原子组件（verbatim）
    components/panels/TransformPanels.tsx   # verbatim
    components/panels/OutputPanels.tsx      # verbatim
    components/panels/fields.tsx            # 拷贝后：ColumnSelect 无列降级
    components/panels/FilePicker.tsx        # 拷贝后：api → useDesignerHost
    components/panels/InputPanels.tsx       # 拷贝后：api → useDesignerHost
    components/panels/SqlConnectionForm.tsx # 拷贝后：api → useDesignerHost
    components/panels/NodeConfigPanel.tsx   # 拷贝后：删运行/冻结态
    components/canvas/NodeCard.tsx          # verbatim（无 store/api 耦合，已验证）
    components/canvas/Toolbar.tsx           # 拷贝后：保存走 adapter、加返回、删运行
    components/canvas/NodePalette.tsx       # 拷贝后：删运行锁与设置/关于
    components/canvas/FlowCanvas.tsx        # 拷贝后：删运行态/右键菜单
  test/designerStore.test.ts          # P4 包单测
apps/web/
  package.json                        # + @hustserver/workflow-designer、tw-animate-css
  vite.config.ts                      # + resolve.alias['@']
  tsconfig.json                       # + baseUrl/paths
  src/index.css                       # + designer.css import、@source、@theme inline、dark、base
  src/pages/WorkflowDesignerPage.tsx  # 新建（加载/合并/清洗/发布/全屏 dark）
  src/App.tsx                         # + /workflows/:id/designer 路由（Layout 外）
  src/pages/WorkflowListPage.tsx      # + 「编辑画布」「新建画布」入口
  src/pages/WorkflowDetailPage.tsx    # + 「编辑画布」入口
apps/server/
  src/modules/workflows/repo.ts       # updatePayload → update(id,{name?,payload?})
  src/modules/workflows/routes.ts     # + PUT /api/workflows/:id
  test/workflow-repo.test.ts          # 同步 update 签名
  test/workflow-routes.test.ts        # + PUT 用例
vitest.config.ts                      # + resolve.alias['@']
docs/superpowers/specs/2026-10-14-hustserver-design.md   # P4 修订第 26/32/128/259–282 行
```

---

# 里程碑 P1：包骨架与适配层

## Task 1: 新建 packages/workflow-designer 包骨架

**Files:** `packages/workflow-designer/package.json`、`packages/workflow-designer/tsconfig.json`

- [ ] **Step 1:** 创建 `packages/workflow-designer/package.json`：

```json
{
  "name": "@hustserver/workflow-designer",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "husteryxBaseline": "microsoftbi/HUSTERYX@836b22a",
  "exports": {
    ".": "./src/index.ts",
    "./designer.css": "./src/designer.css"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.3.0",
    "@radix-ui/react-dropdown-menu": "^2.2.0",
    "@radix-ui/react-label": "^2.1.17",
    "@radix-ui/react-scroll-area": "^1.4.0",
    "@radix-ui/react-select": "^2.4.0",
    "@radix-ui/react-separator": "^1.2.0",
    "@radix-ui/react-slot": "^1.5.0",
    "@radix-ui/react-switch": "^1.4.0",
    "@radix-ui/react-tabs": "^1.2.0",
    "@radix-ui/react-tooltip": "^1.4.0",
    "@xyflow/react": "^12.12.0",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.55.0",
    "tailwind-merge": "^3.7.0",
    "zustand": "^5.0.15"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.2",
    "@types/react-dom": "^19.0.2",
    "typescript": "^5.6.3"
  }
}
```

（依赖版本全部取自 HUSTERYX `frontend/package.json` 实测值；不直接依赖 react/react-dom，避免与宿主双实例。）

- [ ] **Step 2:** 创建 `packages/workflow-designer/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "noEmit": true,
    "types": [],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3:** 在仓库根执行 `pnpm install`，确认 workspace 链接成功（无报错、`pnpm ls --depth -1` 可见 `@hustserver/workflow-designer`）。

## Task 2: 拷贝 HUSTERYX 源文件子集

**Files:** `packages/workflow-designer/src/**`（lib / ui / verbatim 面板与画布）

- [ ] **Step 1:** 创建目录并执行拷贝（源固定 `/Users/wadesong/Desktop/TEST/HUSTERYX/frontend/src`）：

```bash
SRC=/Users/wadesong/Desktop/TEST/HUSTERYX/frontend/src
DST=/Users/wadesong/Desktop/TEST/HUSTServer/packages/workflow-designer/src

mkdir -p "$DST/lib" "$DST/store" "$DST/components/ui" "$DST/components/panels" "$DST/components/canvas" "$DST/test"

# lib（verbatim；graph.ts 含 ancestorNodeIds 也照拷，未引用不报错）
cp "$SRC/lib/nodeMeta.ts" "$SRC/lib/schema.ts" "$SRC/lib/format.ts" "$SRC/lib/utils.ts" "$SRC/lib/graph.ts" "$DST/lib/"

# ui 原子组件（verbatim，共 14 个）
cp "$SRC"/components/ui/*.tsx "$DST/components/ui/"

# 无耦合面板/画布（verbatim）
cp "$SRC/components/panels/TransformPanels.tsx" "$DST/components/panels/"
cp "$SRC/components/panels/OutputPanels.tsx" "$DST/components/panels/"
cp "$SRC/components/canvas/NodeCard.tsx" "$DST/components/canvas/"

# 待改造文件（后续 Task 裁剪）
cp "$SRC/types.ts" "$DST/types.ts"
cp "$SRC/store/workflowStore.ts" "$DST/store/workflowStore.ts"
cp "$SRC/components/panels/fields.tsx" "$DST/components/panels/"
cp "$SRC/components/panels/FilePicker.tsx" "$DST/components/panels/"
cp "$SRC/components/panels/InputPanels.tsx" "$DST/components/panels/"
cp "$SRC/components/panels/SqlConnectionForm.tsx" "$DST/components/panels/"
cp "$SRC/components/panels/NodeConfigPanel.tsx" "$DST/components/panels/"
cp "$SRC/components/canvas/Toolbar.tsx" "$DST/components/canvas/"
cp "$SRC/components/canvas/NodePalette.tsx" "$DST/components/canvas/"
cp "$SRC/components/canvas/FlowCanvas.tsx" "$DST/components/canvas/"
```

- [ ] **Step 2:** 用 Grep 验证拷贝完整性：`packages/workflow-designer/src` 下 `from '@/lib/schema'`、`from '@/lib/nodeMeta'`、`from '@/components/ui/'` 的导入目标文件均存在；`Grep pattern "from '@/api"` 应仅命中 store/Toolbar/SqlConnectionForm/FilePicker/InputPanels 五个待改造文件（无遗漏的 api 耦合）。

## Task 3: 裁剪 types.ts

**Files:** `packages/workflow-designer/src/types.ts`

- [ ] **Step 1:** 在拷贝好的 `types.ts` 中**删除以下类型定义**（运行/事件/设置相关，逐一 Grep 确认包内无引用后删除）：`PreviewResult`、`RunNodeState`、`RunDetail`、`ServerConfig`、`AppSettings`、`ApiError`。若这些类型被 `subscribeRun`/运行态字段引用，随 Task 4 一并消失。
- [ ] **Step 2:** **保留**以下类型（逐一确认仍在文件中）：`NodeKind`、`Position`、`WorkflowNode`、`WorkflowEdge`、`Workflow`、`SqlServerConnection`、`InputCsvConfig`、`InputExcelConfig`、`SqlObjectType`、`SqlObjectRef`、`InputSqlServerConfig`、`SelectField`/`SelectConfig`、`FilterConfig`、`JoinType`/`JoinSelectField`/`JoinConfig`、`UnionMatchMode`/`UnionSelectField`/`UnionConfig`、`AggregationFn`/`AggregationItem`/`AggregationConfig`、`OutputCsvConfig`、`OutputExcelConfig`、`OutputSqlServerConfig`、`NodeRunStatus`、`ColumnMeta`、`FileUploadResult`。
- [ ] **Step 3:** `cd packages/workflow-designer && pnpm exec tsc --noEmit`——此阶段 store 尚未裁剪会报运行态类型错误，属预期；本步仅确认 types.ts 自身无孤立 import（如有 import 指向已删类型，一并清理）。

## Task 4: 裁剪 store/workflowStore.ts

**Files:** `packages/workflow-designer/src/store/workflowStore.ts`

- [ ] **Step 1:** **删除 import**：`import { api, ApiRequestError } from '@/api/client';` 与 `import { subscribeRun } from '@/api/sse';`（第 2–3 行）。确认文件不再引用 `@/api`。
- [ ] **Step 2:** **删除模块级** `let unsubscribe` 变量及其赋值/调用点。
- [ ] **Step 3:** **删除以下状态字段**（及接口声明中对应项）：`previews`、`settings`、`workflowFilePath`、`inputSchemaSignatures`、`logs`、`runStatus`、`nodeStatus`、`nodeResults`、`runScope`、`cacheToken`、`cachedNodeIds`。
- [ ] **Step 4:** **删除以下动作**（函数体一并删）：`subscribeRun`、`ancestorNodeIds`、`openWorkflowFile`、`saveWorkflowFile`、`buildProbePlan`、`run`、`cacheTo`、`clearCache`、`loadPreview`、`fetchSchemas`、`probeInputNode`、`probeAllInputs`、`loadSettings`、`updateSettings`、`newWorkflow`、`openWorkflow`、`saveWorkflow`、`clearLogs`、`clearRunState`。
- [ ] **Step 5:** **保留**（逐项确认）：辅助函数 `nextNodeId` / `nextEdgeId` / `buildAdjacency` / `reachable`；字段 `workflowId` / `workflowName` / `workflowCreatedAt` / `nodes` / `edges` / `selectedNodeId` / `dirty` / `inputSchemas: {}` / `nodeColumns: {}`（后两者保留为恒空字段，支撑 fields.tsx 零改动）；动作 `addNode` / `addEdge` / `removeNode` / `removeEdge` / `setNodePosition` / `selectNode` / `updateNodeName` / `updateNodeConfig` / `setWorkflowName`（`addEdge` 的完整校验链——自环、端口存在性、union 单端口多连、普通端口单连、`reachable` 阻环——**原样保留，不得简化**）。
- [ ] **Step 6:** **新增三个动作**（加在接口声明与实现中，代码如下）：

```ts
loadWorkflow: (wf: Workflow) => {
  set({
    workflowId: wf.id ?? '',
    workflowName: wf.name || '未命名工作流',
    workflowCreatedAt: wf.createdAt ?? '',
    nodes: wf.nodes,
    edges: wf.edges.map((edge) => ({
      ...edge,
      sourceHandle: edge.sourceHandle ?? 'out',
      targetHandle: edge.targetHandle ?? 'in',
    })),
    selectedNodeId: null,
    dirty: false,
    inputSchemas: {},
    nodeColumns: {},
  });
},

markSaved: () => set({ dirty: false }),

snapshot: () => ({
  id: get().workflowId ?? '',
  name: get().workflowName,
  nodes: get().nodes,
  edges: get().edges,
  createdAt: get().workflowCreatedAt ?? 0,
  updatedAt: Date.now(),
}),
```

（接口签名：`loadWorkflow(wf: Workflow): void`、`markSaved(): void`、`snapshot(): Workflow`；`get`/`set` 用法与文件内既有动作一致。）

- [ ] **Step 7:** `pnpm exec tsc --noEmit`（包目录）应无 store 相关错误（其余面板因引用未删净的运行态可能仍报错，属预期，下一任务消除）。

## Task 5: 新建 adapters.ts 与 context.tsx

**Files:** `packages/workflow-designer/src/adapters.ts`、`packages/workflow-designer/src/context.tsx`

- [ ] **Step 1:** 创建 `src/adapters.ts`：

```ts
import type { ColumnMeta, FileUploadResult, SqlObjectRef, SqlServerConnection, Workflow } from './types';

/**
 * 设计器与宿主的唯一契约。
 * onSave：宿主决定写入平台（新建 POST / 编辑 PUT）。
 * 可选能力：平台一阶段均不提供，面板自动降级为手动输入。
 */
export interface DesignerAdapter {
  onSave(workflow: Workflow): Promise<void>;
  uploadFile?: (file: File) => Promise<FileUploadResult>;
  listSheets?: (path: string) => Promise<string[]>;
  listSqlDatabases?: (connection: SqlServerConnection) => Promise<string[]>;
  listSqlObjects?: (connection: SqlServerConnection, kind: SqlObjectType) => Promise<SqlObjectRef[]>;
  probeSchema?: (kind: string, config: Record<string, unknown>) => Promise<ColumnMeta[]>;
}

export interface WorkflowDesignerProps {
  initialWorkflow: Workflow;
  adapter: DesignerAdapter;
  onExit?: () => void;
}
```

（若上游 `SqlObjectType` 的实际取值与 `listSqlObjects` 调用点不匹配，以 `InputPanels.tsx` 中 `api.listSqlObjects` 的原参数类型为准对齐。）

- [ ] **Step 2:** 创建 `src/context.tsx`：

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import type { DesignerAdapter } from './adapters';

export interface DesignerHost {
  adapter: DesignerAdapter;
  onExit?: () => void;
}

const DesignerHostContext = createContext<DesignerHost | null>(null);

export function DesignerHostProvider({ value, children }: { value: DesignerHost; children: ReactNode }) {
  return <DesignerHostContext.Provider value={value}>{children}</DesignerHostContext.Provider>;
}

export function useDesignerHost(): DesignerHost {
  const ctx = useContext(DesignerHostContext);
  if (!ctx) throw new Error('useDesignerHost 必须在 WorkflowDesigner 内使用');
  return ctx;
}
```

## Task 6: 裁剪 panels（fields / FilePicker / SqlConnectionForm / InputPanels / NodeConfigPanel）

**Files:** `packages/workflow-designer/src/components/panels/*`

- [ ] **Step 1: fields.tsx — ColumnSelect 降级**。在文件 import 区加 `import { Input } from '@/components/ui/input';`；`ColumnSelect`（约 134–173 行）函数体开头加无列分支，其余逻辑不动：

```tsx
export function ColumnSelect({ value, onChange, columns, placeholder = '选择列', hasFallback }: {
  value: string;
  onChange: (value: string) => void;
  columns: ColumnMeta[];
  placeholder?: string;
  hasFallback?: boolean;
}) {
  if (columns.length === 0) {
    return (
      <Input
        value={value === NONE_VALUE ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="手动输入列名"
      />
    );
  }
  /* ——原有 Select 渲染逻辑保持原样—— */
}
```

（props 形状以上游实际签名为准，仅新增开头分支，不改动其余 props。）

- [ ] **Step 2: FilePicker.tsx — api → host**。删除 `import { api } from '@/api/client';`，加 `import { useDesignerHost } from '@/context';`；组件内 `const { adapter } = useDesignerHost();`；原 `handleFile` 中 `api.uploadFile(file)` 替换为：

```tsx
if (!adapter.uploadFile) return;
const uploaded = await adapter.uploadFile(file);
onChange(uploaded.path);
onUploaded?.(uploaded);
```

上传按钮以 `{adapter.uploadFile && ( …原按钮… )}` 条件渲染；`adapter.uploadFile` 缺失时保留纯路径 `Input`（原 `FilePathField` 的路径输入框本身就是无上传时的完整形态）。

- [ ] **Step 3: SqlConnectionForm.tsx — api → host**。删 `import { api } from '@/api/client';`，加 `import { useDesignerHost } from '@/context';`；`const { adapter } = useDesignerHost();`；「连接」按钮以 `{adapter.listSqlDatabases && ( … )}` 条件渲染；原点击处理中 `api.listSqlDatabases(connection)` 替换为 `await adapter.listSqlDatabases!(connection)`。数据库的 Select（候选）/ Input（手动）双分支保持原样。
- [ ] **Step 4: InputPanels.tsx — api → host**。删 `import { api } from '@/api/client';`，加 `import { useDesignerHost } from '@/context';`；三个面板组件内各加 `const { adapter } = useDesignerHost();`，按以下映射替换（共两处调用）：

| 上游调用 | 替换为 |
| --- | --- |
| `api.listSheets(path)`（InputExcelPanel 的 loadSheets） | `adapter.listSheets?.(path)`；`adapter.listSheets` 为空时跳过加载并保留手动写 sheet 分支；RefreshCw 按钮以 `{adapter.listSheets && (…)}` 条件渲染 |
| `api.listSqlObjects(connection, kind)`（InputSqlServerPanel 的 loadObjects） | `adapter.listSqlObjects?.(connection)`——**执行裁决：上游 InputPanels.tsx:206 实际为单参调用（无 kind），adapter 签名已按 Task 5 注脚对齐为 `(connection: SqlServerConnection) => Promise<SqlObjectRef[]>`**；缺失时同上降级；RefreshCw 按钮条件渲染 |

`InputCsvPanel` 无 api 调用，不动。

- [ ] **Step 5: NodeConfigPanel.tsx — 删运行/冻结态**。删除：`STATUS_BADGE` 常量、`runStatus` / `nodeStatus` / `cachedNodeIds` 三个 selector（约 70–75 行中的三行）、`const locked = running || frozen` 及 `running` / `frozen` 的所有派生、运行/冻结提示条与锁样式（`pointer-events-none`/`opacity` 之类随锁逻辑而来的 className）。header 保留：分类图标（`CATEGORY_ACCENT[meta.category]`）、改名 `Input`、`{meta.label} · {node.id}` 标题、删除按钮、关闭按钮。`ConfigForm` 的 12 种面板 switch 分发保持原样。
- [ ] **Step 6:** `pnpm exec tsc --noEmit`（包目录）。此步后 panels 应无错误；剩余错误应仅来自 canvas 三件（下一任务）。

## Task 7: 裁剪 canvas（Toolbar / NodePalette / FlowCanvas）

**Files:** `packages/workflow-designer/src/components/canvas/*`

- [ ] **Step 1: Toolbar.tsx**。删除：`import { api } from '@/api/client';`；`runStatus` / `run` / `saveWorkflow` / `newWorkflow` / `openWorkflow` 五个 selector；「新建」「打开」「运行」按钮（`FilePlus2` / `FolderOpen` / `Play` 图标及 handler）；`api.health()` 后端指示灯；运行 success/error Badge。替换保存逻辑（新增 selector 与 handler）：

```tsx
const { adapter, onExit } = useDesignerHost();
const snapshot = useWorkflowStore((s) => s.snapshot);
const markSaved = useWorkflowStore((s) => s.markSaved);
const [saving, setSaving] = useState(false);
const [saveError, setSaveError] = useState<string | null>(null);

async function handleSave() {
  setSaving(true);
  setSaveError(null);
  try {
    await adapter.onSave(snapshot());
    markSaved();
  } catch (err) {
    setSaveError(err instanceof Error ? err.message : '保存失败');
  } finally {
    setSaving(false);
  }
}
```

保存按钮保留（`Save` 图标，`disabled={saving}`，`saving` 时 `Loader2` 旋转，沿用上游写法）；dirty Badge（`variant="warning"`「未保存」）保留；`saveError` 非空时在工具栏右侧以红色文案展示；`onExit` 存在时在最左侧渲染「返回」按钮（`onClick={() => onExit?.()}`）。文件名/工作流名 Input 与 Tooltip 保持原样。加 `import { useDesignerHost } from '@/context';`。

- [ ] **Step 2: NodePalette.tsx**。删除：`runStatus` selector 与 running 锁定逻辑（running 时禁用拖拽/置灰）；`SettingsDialog` / `AboutDialog` 的 import 与 `settingsOpen` / `aboutOpen` state、「配置」「关于」按钮。保留：分类分组（`CATEGORIES`）、ribbon 拖拽源 `event.dataTransfer.setData('application/husteryx-node', meta.kind)`（常量名与 FlowCanvas `onDrop` 的 `getData` 保持一致，不得改名）。
- [ ] **Step 3: FlowCanvas.tsx**。删除：`nodeStatus` / `nodeResults` / `runStatus` / `run` / `runScope` / `cacheTo` / `clearCache` / `cacheToken` / `cachedNodeIds` 共 9 个 selector；右键菜单（`menu` state、`onNodeContextMenu`、菜单 JSX、对应 Escape useEffect）。`rfNodes` 的 `data` 固定为：

```tsx
data: { node, status: 'pending', rowCount: 0, durationMs: 0, runActive: false, inScope: true, frozen: false }
```

`rfEdges` 简化为：

```tsx
const rfEdges = useMemo(() => edges.map((edge) => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  sourceHandle: edge.sourceHandle ?? 'out',
  targetHandle: edge.targetHandle ?? 'in',
})), [edges]);
```

（多输出节点的 `rowLabel` 隐藏逻辑、`animated` 属性随运行态一并删除。）保留：节点 dimensions 回填（`onNodesChange` 中 `change.type === 'dimensions'` 收集）、`onConnect`、`onDrop`/`onDragOver`（`application/husteryx-node`）、`colorMode="dark"`、`fitView`、`minZoom 0.2` / `maxZoom 2`、MiniMap 配色、空画布 Panel 提示。`HusterNodeData` 类型若定义于 NodeCard.tsx 则 import 保持原样。
- [ ] **Step 4:** `pnpm exec tsc --noEmit`（包目录）通过（WorkflowDesigner.tsx / index.ts 尚未创建，不影响；tsc 只检查已存在文件）。

## Task 8: WorkflowDesigner 组件、designer.css、index.ts、根 vitest 别名

**Files:** `packages/workflow-designer/src/WorkflowDesigner.tsx`、`src/index.ts`、`src/designer.css`、根 `vitest.config.ts`

- [ ] **Step 1:** 创建 `src/WorkflowDesigner.tsx`：

```tsx
import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toolbar } from '@/components/canvas/Toolbar';
import { NodePalette } from '@/components/canvas/NodePalette';
import { FlowCanvas } from '@/components/canvas/FlowCanvas';
import { NodeConfigPanel } from '@/components/panels/NodeConfigPanel';
import { DesignerHostProvider } from '@/context';
import { useWorkflowStore } from '@/store/workflowStore';
import type { WorkflowDesignerProps } from '@/adapters';

export function WorkflowDesigner({ initialWorkflow, adapter, onExit }: WorkflowDesignerProps) {
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);

  useEffect(() => {
    loadWorkflow(initialWorkflow);
  }, [initialWorkflow, loadWorkflow]);

  return (
    <DesignerHostProvider value={{ adapter, onExit }}>
      <TooltipProvider delayDuration={200}>
        <ReactFlowProvider>
          <div className="hust-designer flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
            <Toolbar />
            <NodePalette />
            <div className="flex min-h-0 flex-1">
              <NodeConfigPanel />
              <main className="flex min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1">
                  <FlowCanvas />
                </div>
              </main>
            </div>
          </div>
        </ReactFlowProvider>
      </TooltipProvider>
    </DesignerHostProvider>
  );
}
```

（若 TooltipProvider 的导出形态与上游 tooltip.tsx 不符，以上游实际导出为准。）

- [ ] **Step 2:** 创建 `src/designer.css` —— 从上游 `frontend/src/index.css`（143 行）拷贝全文后做以下转换：
  1. 删除 `@import 'tailwindcss';` 与 `@import 'tw-animate-css';` 两行。
  2. 保留 `@import '@xyflow/react/dist/style.css';`。
  3. 删除 `@custom-variant dark (&:is(.dark *));`（移宿主）。
  4. 删除整个 `@theme inline { … }` 块（原样移入宿主 index.css，见 Task 9）。
  5. 删除整个 `@layer base { … }` 块（其内容处理见 Task 9 Step 4；其中 `body { overflow: hidden }` 直接丢弃，不得移入宿主）。
  6. 保留 `:root { … }` 与 `.dark { … }` 两个 OKLCH 变量块（全局生效，供 Radix portal 使用）。
  7. `::-webkit-scrollbar*` 规则全部加 `.hust-designer ` 前缀（避免影响宿主其它页面）。
  8. ReactFlow 覆盖规则（`.react-flow__attribution`、`.react-flow__handle`、`.react-flow__edge-path`、`.react-flow__controls-button` 及其 `:hover`）全部加 `.hust-designer ` 前缀。

- [ ] **Step 3:** 创建 `src/index.ts`：

```ts
export { WorkflowDesigner } from './WorkflowDesigner';
export type { DesignerAdapter, WorkflowDesignerProps } from './adapters';
export type {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  NodeKind,
  ColumnMeta,
  SqlServerConnection,
} from './types';
```

- [ ] **Step 4:** 根 `vitest.config.ts` 加别名（保留原 test 配置不变）：

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./packages/workflow-designer/src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
  },
});
```

- [ ] **Step 5:** `pnpm exec tsc --noEmit`（包目录）全部通过。

---

# 里程碑 P2：平台接入（apps/web）

## Task 9: web 端依赖、别名与主题层

**Files:** `apps/web/package.json`、`apps/web/vite.config.ts`、`apps/web/tsconfig.json`、`apps/web/src/index.css`

- [ ] **Step 1:** `apps/web/package.json`：dependencies 加 `"@hustserver/workflow-designer": "workspace:*"`；devDependencies 加 `"tw-animate-css": "^1.4.0"`。根目录 `pnpm install`。
- [ ] **Step 2:** `apps/web/vite.config.ts` 全文改为：

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../packages/workflow-designer/src', import.meta.url)),
    },
  },
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
```

- [ ] **Step 3:** `apps/web/tsconfig.json` 的 `compilerOptions` 加：

```json
"baseUrl": ".",
"paths": { "@/*": ["../../packages/workflow-designer/src/*"] }
```

- [ ] **Step 4:** `apps/web/src/index.css` 在 `@import "tailwindcss";` 之后追加（顺序：全部 `@import` 在最前，Tailwind 指令随后）：

```css
@import "tw-animate-css";
@import "@hustserver/workflow-designer/designer.css";

@custom-variant dark (&:is(.dark *));

@source "../../../packages/workflow-designer/src";
```

并把上游 `index.css` 的 `@theme inline { … }` 块**原样整块**粘贴进来（含 `--radius-sm/md/lg/xl` 与全部 `--color-*` 映射，勿手抄漏项）；再补 base 层（取自 designer.css 转换时删除的 `@layer base`，去掉 `body{overflow:hidden}`）：

```css
@layer base {
  * { border-color: var(--border); }
  html, body, #root { height: 100%; }
  body {
    background-color: var(--background);
    color: var(--foreground);
    font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  }
}
```

（font-family 以上游 `@layer base` 中 body 的实际值为准；`--radius` 等 `:root` 变量已由 designer.css 全局提供，宿主勿重复声明。）

## Task 10: 新建 WorkflowDesignerPage

**Files:** `apps/web/src/pages/WorkflowDesignerPage.tsx`（新建）

- [ ] **Step 1:** 创建完整页面：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { WorkflowConnectionNode, WorkflowDetail } from '../types';
import { WorkflowDesigner, type DesignerAdapter } from '@hustserver/workflow-designer';
import type { Workflow } from '@hustserver/workflow-designer';

const MASKED = '******';
const SQL_KINDS = new Set(['inputSqlServer', 'outputSqlServer']);

function blankWorkflow(): Workflow {
  const now = Date.now();
  return { id: '', name: '未命名工作流', nodes: [], edges: [], createdAt: now, updatedAt: now };
}

/** 把平台留存的（掩码）连接合并进 SQL 节点配置；补 name 兜底。 */
function hydrateWorkflow(raw: unknown, name: string, connections: WorkflowConnectionNode[]): Workflow {
  const wf = raw as Workflow;
  const byNode = new Map(connections.map((c) => [c.node_id, c]));
  return {
    ...wf,
    name: wf.name || name || '未命名工作流',
    nodes: wf.nodes.map((node) => {
      if (!SQL_KINDS.has(node.kind)) return node;
      const remote = byNode.get(node.id);
      if (!remote?.config) return node;
      const config = node.config as Record<string, unknown>;
      return {
        ...node,
        config: { ...config, connection: { ...((config.connection as object) ?? {}), ...remote.config } },
      };
    }),
  };
}

/** 发送前清洗掩码密码哨兵：'******' → ''（空 = 沿用原值，服务端 mergeConnectionConfig 处理）。 */
function stripMaskedPasswords(wf: Workflow): Workflow {
  return {
    ...wf,
    nodes: wf.nodes.map((node) => {
      if (!SQL_KINDS.has(node.kind)) return node;
      const config = { ...(node.config as Record<string, unknown>) };
      const conn = { ...((config.connection as Record<string, unknown>) ?? {}) };
      if (conn.password === MASKED) conn.password = '';
      config.connection = conn;
      return { ...node, config };
    }),
  };
}

export function WorkflowDesignerPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('dark');
    return () => document.documentElement.classList.remove('dark');
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (isNew) {
      setWorkflow(blankWorkflow());
      return;
    }
    Promise.all([
      api.get<WorkflowDetail>(`/api/workflows/${id}`),
      api.get<WorkflowConnectionNode[]>(`/api/workflows/${id}/connections`),
    ])
      .then(([detail, connections]) => {
        if (!cancelled) setWorkflow(hydrateWorkflow(detail.workflow, detail.name, connections));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  const adapter = useMemo<DesignerAdapter>(
    () => ({
      onSave: async (wf) => {
        const payload = stripMaskedPasswords(wf);
        if (isNew) {
          const created = await api.post<{ id: string }>('/api/workflows', {
            body: { name: wf.name, workflow: payload },
          });
          navigate(`/workflows/${created.id}/designer`, { replace: true });
        } else {
          await api.put(`/api/workflows/${id}`, { body: { name: wf.name, workflow: payload } });
        }
      },
    }),
    [id, isNew, navigate],
  );

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center gap-3 text-sm">
        <span className="text-red-500">{error}</span>
        <button className="underline" onClick={() => navigate('/workflows')}>返回列表</button>
      </div>
    );
  }
  if (!workflow) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <WorkflowDesigner
      initialWorkflow={workflow}
      adapter={adapter}
      onExit={() => navigate(isNew ? '/workflows' : `/workflows/${id}`)}
    />
  );
}
```

（`api.post` / `api.put` 签名以 `apps/web/src/api.ts` 实际定义为准；`api.put` 已存在。）

## Task 11: 路由与入口

**Files:** `apps/web/src/App.tsx`、`apps/web/src/pages/WorkflowListPage.tsx`、`apps/web/src/pages/WorkflowDetailPage.tsx`

- [ ] **Step 1:** `App.tsx`：import `WorkflowDesignerPage`；在包裹 `<Layout>` 的路由**之外**（与 `/login` 平级处）加：

```tsx
<Route
  path="/workflows/:id/designer"
  element={<RequireAuth><WorkflowDesignerPage /></RequireAuth>}
/>
```

（`:id` 动态段天然匹配 `new`，无需单独新建路由。）

- [ ] **Step 2:** `WorkflowListPage.tsx`：顶部「上传工作流」Link 旁加「新建画布」：

```tsx
<Link to="/workflows/new/designer" className="…与既有按钮同款样式…">新建画布</Link>
```

操作列「数据连接」旁加：

```tsx
<Link to={`/workflows/${wf.id}/designer`} className="…同款…">编辑画布</Link>
```

- [ ] **Step 3:** `WorkflowDetailPage.tsx`：页面顶部操作区加「编辑画布」：

```tsx
<Link to={`/workflows/${id}/designer`} className="…与「立即运行」按钮同款样式…">编辑画布</Link>
```

- [ ] **Step 4:** `pnpm --filter @hustserver/web exec tsc -p tsconfig.json --noEmit` 通过。

---

# 里程碑 P3：服务端发布接口

## Task 12: repo.update 签名改造

**Files:** `apps/server/src/modules/workflows/repo.ts`、`apps/server/test/workflow-repo.test.ts`

- [ ] **Step 1:** `repo.ts` 中把第 19 行附近的 `const update = db.prepare('UPDATE workflows SET payload = ?, updated_at = ? WHERE id = ?');` 改为：

```ts
const update = db.prepare('UPDATE workflows SET name = COALESCE(?, name), payload = COALESCE(?, payload), updated_at = ? WHERE id = ?');
```

- [ ] **Step 2:** `updatePayload(id, payload)` 方法（约 42–45 行）改为：

```ts
update(id: string, patch: { name?: string; payload?: string }) {
  update.run(patch.name ?? null, patch.payload ?? null, Date.now(), id);
  return get(id);
},
```

（`WorkflowsRepo` 接口声明同步改为 `update(id: string, patch: { name?: string; payload?: string }): WorkflowRow | undefined;`，返回类型与原 `updatePayload` 一致。）

- [ ] **Step 3:** 全仓 Grep `updatePayload` 确认仅剩 `workflow-repo.test.ts:27`；把该行改为：

```ts
repo.update(w1.id, { payload: '{"nodes":[1],"edges":[]}' });
```

- [ ] **Step 4:** `pnpm --filter @hustserver/server exec vitest run test/workflow-repo.test.ts` 通过。

## Task 13: PUT /api/workflows/:id

**Files:** `apps/server/src/modules/workflows/routes.ts`、`apps/server/test/workflow-routes.test.ts`

- [ ] **Step 1:** `routes.ts` 中在既有 `GET /api/workflows/:id` 路由附近新增（完全复用 POST 范式与既有辅助函数 `stripEmbeddedConnections` / `extractEmbeddedConnections` / `mergeConnectionConfig` / `loadChecked`）：

```ts
app.put('/api/workflows/:id', { preHandler: auth }, async (req, reply) => {
  const wf = loadChecked(req, reply);
  if (!wf) return;
  const body = (req.body ?? {}) as { name?: string; workflow?: unknown };
  let parsed;
  try {
    parsed = parseWorkflowPayload(JSON.stringify(body.workflow ?? {}));
  } catch (err) {
    if (err instanceof WorkflowParseError) return reply.code(400).send({ error: err.message, detail: err.detail });
    throw err;
  }
  const stripped = stripEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> });
  const payload = JSON.stringify({ nodes: stripped.nodes, edges: parsed.workflow.edges });
  const name = body.name?.trim() || parsed.workflow.name || wf.name;
  const updated = workflows.update(wf.id, { name, payload });
  for (const { nodeId, config } of extractEmbeddedConnections(parsed.workflow as unknown as { nodes: Array<Record<string, unknown>> })) {
    wfConnections.upsert({ workflowId: wf.id, nodeId, configEncrypted: encryptConfig(config, deps.config.encryptionKey) });
  }
  return { ok: true, id: updated!.id, name: updated!.name };
});
```

（`workflows` / `wfConnections` / `deps` 等标识符与文件内既有 POST 路由所用名称一致；`loadChecked` 为同步函数时直接调用，若为 async 则 `await`——以文件内 `GET /:id` 路由的现行走法为准。）

- [ ] **Step 2:** `workflow-routes.test.ts` 追加用例（复用文件内已有的 `sqlJson` 样例、`login`、`createWorkflow` 辅助）：

```ts
it('PUT /api/workflows/:id 更新名称与画布，连接加密留存且 payload 剥离明文', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
  const id = created.json().id;

  const res = await app.inject({
    method: 'PUT', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie },
    payload: { name: '改名后', workflow: JSON.parse(sqlJson) },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true, name: '改名后' });

  const detail = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
  const body = detail.json();
  expect(body.name).toBe('改名后');
  for (const node of body.workflow.nodes) {
    expect(node.config.connection).toBeUndefined(); // payload 不落明文连接
  }

  const conns = workflowConnectionsRepo(db).listByWorkflow(id);
  expect(conns).toHaveLength(2);
});

it('PUT 拒绝非属主（403）', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
  const id = created.json().id;
  const res = await app.inject({ method: 'PUT', url: `/api/workflows/${id}`, headers: { cookie: bobCookie }, payload: { name: 'x', workflow: { nodes: [], edges: [] } } });
  expect(res.statusCode).toBe(403);
});

it('PUT 非法 payload 返回 400', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
  const id = created.json().id;
  const res = await app.inject({ method: 'PUT', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie }, payload: { workflow: { nodes: 'bad', edges: [] } } });
  expect(res.statusCode).toBe(400);
});
```

（`listByWorkflow` 返回行的字段名以 `repo.ts` 的 `workflowConnectionsRepo` 定义为准；如需进一步断言解密结果，参照 `connections.test.ts` 中 `decryptConfig` 的既有用法。403 的预期基于既有 `canAccess` 语义——属主或 admin 可访问——若既有测试对 bob 的断言形态不同，以既有用例为准对齐。）

- [ ] **Step 3:** `pnpm --filter @hustserver/server exec vitest run test/workflow-routes.test.ts` 通过。

---

# 里程碑 P4：收紧与回归

## Task 14: 包单测（workflowStore）

**Files:** `packages/workflow-designer/test/workflowStore.test.ts`（新建）

- [ ] **Step 1:** 创建测试（store 为模块级单例，用 `setState` 重置）：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkflowStore } from '../src/store/workflowStore';

beforeEach(() => {
  useWorkflowStore.setState({
    workflowId: '', workflowName: '未命名工作流', workflowCreatedAt: 0,
    nodes: [], edges: [], selectedNodeId: null, dirty: false,
    inputSchemas: {}, nodeColumns: {},
  });
});

describe('workflowStore 画布操作（裁剪版）', () => {
  it('addNode 自增 id、写默认配置并选中', () => {
    useWorkflowStore.getState().addNode('inputCsv', { x: 0, y: 0 });
    const { nodes, selectedNodeId, dirty } = useWorkflowStore.getState();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('n1');
    expect(nodes[0].name.length).toBeGreaterThan(0); // 取自 getNodeMeta(kind).label
    expect(selectedNodeId).toBe('n1');
    expect(dirty).toBe(true);
  });

  it('addEdge 阻止自环、未知端口与成环', () => {
    const s = useWorkflowStore.getState();
    s.addNode('inputCsv', { x: 0, y: 0 });
    s.addNode('outputCsv', { x: 200, y: 0 });
    s.addEdge({ source: 'n1', target: 'n2' });
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
    s.addEdge({ source: 'n1', target: 'n1' });      // 自环
    s.addEdge({ source: 'n2', target: 'n1' });      // 成环
    s.addEdge({ source: 'n9', target: 'n2' });      // 未知源
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
  });

  it('loadWorkflow 归一化 handle、清 dirty 与 schemas', () => {
    useWorkflowStore.getState().loadWorkflow({
      id: 'w1', name: '示例', createdAt: '', updatedAt: '',
      nodes: [{ id: 'n1', kind: 'inputCsv', name: '读', position: { x: 0, y: 0 }, config: { path: '/a.csv' } }],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
    } as never);
    const s = useWorkflowStore.getState();
    expect(s.workflowId).toBe('w1');
    expect(s.workflowName).toBe('示例');
    expect(s.dirty).toBe(false);
    expect(s.inputSchemas).toEqual({});
    // edges 引用了不存在的 n2：loadWorkflow 不做图校验（与上游行为一致），仅归一化 handle
    expect(s.edges[0].sourceHandle).toBe('out');
    expect(s.edges[0].targetHandle).toBe('in');
  });

  it('snapshot 返回当前图，markSaved 清 dirty', () => {
    const s = useWorkflowStore.getState();
    s.addNode('inputCsv', { x: 0, y: 0 });
    const snap = useWorkflowStore.getState().snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.id).toBe('');
    expect(useWorkflowStore.getState().dirty).toBe(true);
    useWorkflowStore.getState().markSaved();
    expect(useWorkflowStore.getState().dirty).toBe(false);
  });
});
```

（`addNode` 的 kind 取值以 `lib/nodeMeta.ts` 的 `NODE_META` 实际键为准；断言 `as never` 仅为绕过示例数据缺字段，可按实际类型收紧。）

- [ ] **Step 2:** 根目录 `pnpm exec vitest run packages/workflow-designer` 通过（验证根 vitest `@` 别名生效）。

## Task 15: 全量回归与构建验证

- [ ] **Step 1:** 根目录 `pnpm test`（vitest 全量，含 apps/server 与新包）全部通过。
- [ ] **Step 2:** `pnpm --filter @hustserver/web exec tsc -p tsconfig.json --noEmit` 通过；`pnpm --filter @hustserver/web build`（tsc + vite build）成功，确认 `@/` 别名与包内 TSX 源码被正确打包。
- [ ] **Step 3:** 手动冒烟（`node apps/server/dist/index.js` 或既有启动方式 + `pnpm --filter @hustserver/web dev`，或构建后单进程 8787）：
  1. 列表页出现「新建画布」/「编辑画布」入口；
  2. 新建画布 → 拖入 inputCsv + outputCsv、连线、改名、保存 → URL 变为 `/workflows/<id>/designer`、列表页出现该工作流；
  3. 打开既有 SQL 工作流的「编辑画布」→ SQL 面板显示平台连接（密码为 ******）、改画布后保存 → 数据连接页确认密码仍生效（留空沿用）、运行详情可正常执行；
  4. Radix 下拉（节点面板中的 Select）与 Tooltip 弹层颜色正常（dark 生效）；离开设计器后其它页面滚动条/样式无回归。

## Task 16: 修订既有主规格

**Files:** `docs/superpowers/specs/2026-10-14-hustserver-design.md`

- [ ] **Step 1:** 按新规格 §3 的三处修订，更新主规格第 26 / 32 / 128 / 259–282 行（工作流编辑方式从「上传 JSON 为主」改为「上传 JSON 或 Web 画布编辑」，并引用 `packages/workflow-designer` 与 `PUT /api/workflows/:id`）。修订完成后主规格与本计划保持一致。

---

## 自审清单（计划完成后逐项核对）

- **Spec 覆盖**：P1 ↔ spec §6（包结构、契约、样式作用域）、P2 ↔ spec §7（页面/路由/入口/掩码合并/发布）、P3 ↔ spec §8（PUT 语义）、P4 ↔ spec §12/§14（测试与里程碑）；细化 10 项均不改变 spec 语义。
- **占位符扫描**：所有新文件给出完整代码；改造文件给出「拷贝来源 + 精确删除/替换清单 + 替换代码块」，无「略」「待定」「同上」类空转表述。
- **类型一致性**：`DesignerAdapter.onSave(Workflow)` ↔ store `snapshot(): Workflow` ↔ 页面 `stripMaskedPasswords(wf: Workflow)`；`FileUploadResult` / `SqlObjectRef` / `SqlObjectType` 均来自包内 types.ts；web 端 `api.put` 已存在。
- **安全不变量**：PUT 复用 `stripEmbeddedConnections`；哨兵 `******` 在客户端清洗；掩码值不会落库为明文/伪明文。
- **风险预案**：上游组件与本文描述如有出入，以「保持与上游一致、仅删不改」为最高原则，执行人可读源文件现场对齐；对 403/字段名等不确定处以既有测试与 repo 定义为准。
