# HUSTServer 设计文档：Job 画布化编排（拖拽式）

- 日期：2026-10-26
- 状态：待评审
- 依据：[2026-10-15-job-orchestration-design.md](./2026-10-15-job-orchestration-design.md)、[2026-10-14-web-workflow-designer-design.md](./2026-10-14-web-workflow-designer-design.md)

## 0. 结论摘要

**可行，且属于加法式改造**：现有 Job 子系统已经具备「步骤定义 → 落库 → 顺序执行 → 运行记录」的完整闭环，画布化不需要推倒重来。主要改动集中在：

1. 存储层给步骤补 `node_key / 坐标 / 运行模式`，新增 `job_edges` 存依赖；
2. 执行器从「按 `seq` 的 for 循环」升级为「按依赖的拓扑调度」；
3. 前端用基于 `@xyflow/react` 的 Job 画布**替换**现有步骤表格，复用现有表单字段做右侧属性面板（只保留画布，不保留表格视图）。

但有一个必须先讲清楚的产品判断：

> **如果只是把现有「线性步骤列表」画成一条直线，画布不会带来实际价值。**
> 要让拖拽真正有意义，连线必须承载「执行依赖」语义：允许多起点、分支、汇合等待，以及节点的跳过与禁用。

因此 v1 定为：**节点类型严格保持现有 3 类**（`workflow` / `sql` / `load_model`），图结构支持 DAG，但**执行仍保持串行**（一次只跑一个节点，按拓扑序调度）。这样既符合「组件就是现在 Job 支持的步骤类型」，又能得到 Alteryx 式的编排体验，同时把执行风险控制到最低。

另外，节点挂起分为两种互斥语义（评审确认）：

- **禁用**：本节点不执行，且**所有下游一并禁用**（整段分支下线）；
- **跳过**：仅本节点不执行，**下游照常执行**（等价于临时摘掉一个步骤）。

---

## 1. 现状核对

| 维度 | 现状 | 对画布化的影响 |
|---|---|---|
| 节点类型 | 仅 3 种：`workflow` / `sql` / `load_model`（[repo.ts](../../../apps/server/src/modules/jobs/repo.ts)） | 组件面板很小，界面不做分类树，平铺即可 |
| 存储 | `job_steps(id, job_id, seq, type, name, config, on_failure)`，无坐标、无稳定业务 key | 需要补 `node_key / pos_x / pos_y / run_mode`，并新增边表 |
| 保存方式 | `writeSteps()` 每次 `DELETE job_steps` 后全量重插，步骤 `id` 每次保存都会变 | 边不能引用 `id`，必须引用稳定的 `node_key` |
| 执行 | `worker()` 按 `seq` 顺序 for 循环；失败 `abort` 时 `skipRemaining(seq+1)` | 需替换为拓扑调度 + 后代可达性跳过 |
| 并发 | Job 级全局 `createSemaphore(1)`，所有 Job 运行串行；节点之间也完全串行 | v1 节点仍串行（`MAX_PARALLEL = 1`），DAG 只决定顺序与汇合，未来再放开并行 |
| 运行观测 | `JobRunDetailPage` 每 1s 轮询 `/api/job-runs/:id`，无取消 | 画布运行态可视化依赖轮询；取消能力需补 |
| 导入导出 | `JOB_FILE_KIND='hustserver.job'`，`JOB_FILE_VERSION=1`，只支持 `steps` 数组，严格校验版本 | 需要升 v2，且兼容读 v1 |
| 前端 | `JobEditorPage` 表单 + 步骤表格 + 弹窗编辑 | 改为画布 + 属性面板，**删除步骤表格** |
| 依赖 | `@xyflow/react` 仅存在于 `packages/workflow-designer`；其 `designer.css` 已在 `apps/web/src/index.css` 全局引入（含 React Flow 基础样式） | `apps/web` 需新增直接依赖；基础 CSS 已可用 |
| 测试 | 已有 `job-repo` / `job-routes` / `job-service` / `job-transfer` / `migrate` 等 vitest 用例 | 设计需给出对应用例扩展点 |

---

## 2. 可行性分析

### 2.1 技术可行性：高

- 图编辑能力现成：`@xyflow/react ^12.12.0` 已在 monorepo 内，交互模式（拖拽、连线、框选、MiniMap、右键菜单）在 `workflow-designer` 中已有成熟实现可借鉴。
- 数据量小：典型 Job 节点数 < 50、边数 < 100，环检测/拓扑排序/快照序列化都是毫秒级，无需引入图数据库。
- 执行语义可平滑升级：现有 `executeStep()` 的三类分支可以原样保留，只需把「谁来调用、按什么顺序调用」换成调度器。
- 迁移成本可控：SQLite 加列 + 回填 + 生成线性边即可，旧 Job 自动变成一条从左到右的直线。

### 2.2 复用评估

| 资产 | 复用方式 |
|---|---|
| `FlowCanvas` 的交互模式 | 借鉴：`screenToFlowPosition` 拖放、MiniMap 尺寸回填、右键菜单、连接校验 |
| `NodeCard` 的状态视觉 | 借鉴：状态描边、运行中 loading、跳过/禁用节点置灰、配置缺失角标 |
| `workflowStore` 的撤销重做 | 借鉴快照栈 + 700ms 合并策略；Job 节点模型不同，独立实现（约 60 行） |
| `designer.css` | 复用已全局引入的 React Flow 基础样式；Job 画布自身样式用 `.job-canvas` 作用域隔离 |
| `WorkflowDesigner` 整体 | **不复用**。其 adapter 面向数据流（`probeSchema/runWorkflow/subscribeRun/loadPreview`），节点元数据、面板、校验全部是数据管道语义，硬套会导致两边都难维护 |

### 2.3 产品可行性：中高（取决于是否接受 DAG）

- 只做「线性直线」：价值 ≈ 0，反而比表格多一步操作。
- 做 DAG：用户可以获得「多分支结构清晰、汇合后再继续、某节点临时跳过、整段分支临时禁用、失败只中断该分支」等 Alteryx 式能力，这才是画布的核心价值（v1 串行执行，不承诺并行提速）。
- 节点类型仍只有 3 类，因此面板会很轻；后续新增节点类型（条件、通知、等待）时，只需扩展 `nodeMeta` 与执行器分支，不需要改图模型。

### 2.4 语义风险（最需要防的一点）

Alteryx 的连线是**数据流**（上游输出表 → 下游输入表）；Job 的连线是**控制流/依赖**（上游执行完 → 下游才开始）。两者视觉相似但含义不同。设计上必须：

- 工具栏常驻提示：「连线表示执行依赖，不表示数据流向」；
- 节点不展示输入/输出端口标签，只用单一入口/出口；
- 文档与空状态文案统一使用「前置 / 后续」而非「输入 / 输出」。

### 2.5 方案对比

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 扩展 `packages/workflow-designer` 为通用画布 | 抽出通用画布层，再挂两套节点体系 | 改动面大，回归风险高，现有设计器会被牵连 |
| B. 在 `apps/web` 内新建 Job 画布模块 | 独立 store / 节点卡 / 属性面板，复用 UI 组件与交互经验 | **推荐**。边界清晰，互不影响 |
| C. 新建 `packages/job-designer` | 独立包 | 目前只有 `apps/web` 一个消费方，先不拆包，避免过度设计 |

---

## 3. 目标与非目标

### 目标（v1）

1. 画布拖拽新增 3 类节点，连线建立依赖，节点可拖动布局；**编辑器只保留画布一种视图**。
2. 右侧属性面板完成节点配置（复用现有字段与校验），可设置失败策略、跳过、禁用。
3. 保存/运行/调度配置能力与现状一致；保存时服务端强制校验无环。
4. Job 图支持 DAG：多起点、分支、汇合、孤岛节点（v1 执行仍串行，DAG 决定顺序与汇合）。
5. 运行详情用只读画布着色展示节点状态，支持取消运行。
6. 旧 Job 自动转换为线性图；导入导出升级 v2 并兼容 v1。

### 非目标（v1 明确不做）

- 节点间数据传递、变量/参数映射（Alteryx 的数据流能力）。
- 条件分支、循环、通知、等待、人工审批等新节点类型。
- 节点级重试次数、超时、断点续跑、「运行至此/缓存至此」。
- 多人协同编辑、版本历史、画布评论。
- 调度模型变更（仍是 Job 级 1:1 调度）。

---

## 4. 概念模型

### 4.1 实体

```
JobGraph
├── nodes: JobNode[]        // 3 类，键唯一
│   ├── key                  // 稳定标识，保存/运行/边引用都用它
│   ├── type                 // workflow | sql | load_model
│   ├── name
│   ├── config               // 各类型自己的配置
│   ├── onFailure            // abort | continue
│   ├── mode                 // run | skip | disable
│   ├── seq                  // 保存顺序，仅用于同层稳定调度与展示
│   └── position {x, y}
└── edges: JobEdge[]        // source.key -> target.key，仅表达依赖
```

`mode` 三态：

| 值 | 含义 | 下游 |
|---|---|---|
| `run` | 正常运行（默认） | 正常 |
| `skip` | 跳过本节点 | **继续执行**（本节点视为满足） |
| `disable` | 禁用本节点 | **一并禁用**（所有可达后代都不执行） |

> 实现上只持久化「自身 `mode`」。下游是否被禁用由「是否存在 `mode=disable` 的祖先」实时计算（见 §7.2），不做数据级联写入，因此重新启用上游后下游会自动恢复。

### 4.2 执行语义（必须写进 UI 帮助）

| 情形 | 语义 |
|---|---|
| 一条入线 | 前置成功后执行 |
| 多条入线 | **AND 汇合**：所有前置都「满足」后才执行 |
| 多条出线 | 后续节点各自等待本节点完成；互不阻塞 |
| 无入线 | 起点，Job 开始即进入就绪队列 |
| 多个起点 / 多条分支 | 按拓扑序依次调度（v1 串行，`MAX_PARALLEL = 1`） |
| 节点跳过（`skip`） | 本节点不执行，记 `skipped` 并视为「满足」，后续照常执行 |
| 节点禁用（`disable`） | 本节点及其**所有可达后代**都不执行，均记 `skipped` |
| 失败 + `continue` | 本节点记 `error`，并视为「满足」，后续照常执行；Job 最终为失败 |
| 失败 + `abort` | 本节点记 `error`，**所有后代**置 `skipped`；无依赖关系的其它分支继续；Job 最终为失败 |
| 取消 | 不再调度新节点；正在执行的节点尽力取消；未执行节点置 `skipped`；Job 终态 `canceled` |
| 环 | 保存与连接时都拒绝 |

> `abort` 的「后代」按可达性计算，而非按 `seq`。菱形结构 `A→B, A→C, B→D, C→D` 中 B 失败后 D 被跳过，C 即使成功也不会让 D 执行（AND 汇合语义）。

### 4.3 状态机

```
JobRun:  queued → running → success | error | canceled
NodeRun: pending → running → success | error | skipped | canceled
```

`skipped` 用于「跳过」「禁用链」「abort 后代」「取消后未执行」；`canceled` 用于「执行中被取消」。

---

## 5. 数据模型与迁移

### 5.1 表结构变更

```sql
-- 步骤升级为节点
ALTER TABLE job_steps ADD COLUMN node_key TEXT;
ALTER TABLE job_steps ADD COLUMN pos_x    REAL    NOT NULL DEFAULT 0;
ALTER TABLE job_steps ADD COLUMN pos_y    REAL    NOT NULL DEFAULT 0;
ALTER TABLE job_steps ADD COLUMN run_mode TEXT    NOT NULL DEFAULT 'run';  -- run | skip | disable

-- 依赖边（只引用 node_key，不引用易变的 step.id）
CREATE TABLE IF NOT EXISTS job_edges (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_edges_pair ON job_edges(job_id, source_key, target_key);
CREATE INDEX IF NOT EXISTS idx_job_edges_job ON job_edges(job_id);

-- 运行快照：运行时冻结图结构，避免编辑影响正在跑的运行
ALTER TABLE job_runs ADD COLUMN graph_snapshot TEXT;

-- 运行记录按 node_key 关联（历史记录允许为空）
ALTER TABLE job_step_runs ADD COLUMN node_key TEXT;
CREATE INDEX IF NOT EXISTS idx_job_step_runs_key ON job_step_runs(job_run_id, node_key);

-- 节点在 Job 内唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_steps_key ON job_steps(job_id, node_key);
```

> `job_steps.seq` 保留：作为拓扑序的展示序号与旧数据兼容字段，不再决定执行顺序。

### 5.2 迁移步骤（`apps/server/src/db/migrate.ts`）

沿用现有幂等风格：`db.pragma('table_info(...)')` 判断列是否存在后再 `ALTER TABLE`。

```ts
const stepCols = db.pragma('table_info(job_steps)') as Array<{ name: string }>;
if (!stepCols.some((c) => c.name === 'node_key')) {
  db.exec(`
    ALTER TABLE job_steps ADD COLUMN node_key TEXT;
    ALTER TABLE job_steps ADD COLUMN pos_x REAL NOT NULL DEFAULT 0;
    ALTER TABLE job_steps ADD COLUMN pos_y REAL NOT NULL DEFAULT 0;
    ALTER TABLE job_steps ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'run';
    UPDATE job_steps SET pos_x = seq * 260, pos_y = 0 WHERE node_key IS NULL;
    UPDATE job_steps SET node_key = id WHERE node_key IS NULL;
  `);
}
// job_runs / job_step_runs 同理按列判断后 ALTER
```

线性边回填（仅对没有任何边的 Job，执行一次）：

```sql
INSERT INTO job_edges (id, job_id, source_key, target_key, created_at)
SELECT lower(hex(randomblob(6))), s.job_id, s.prev_key, s.node_key,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM (
  SELECT job_id, node_key,
         LAG(node_key) OVER (PARTITION BY job_id ORDER BY seq) AS prev_key
  FROM job_steps
) AS s
WHERE s.prev_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM job_edges e WHERE e.job_id = s.job_id);
```

### 5.3 运行快照格式

`job_runs.graph_snapshot`（JSON 字符串）：

```json
{
  "version": 1,
  "nodes": [
    {
      "key": "n_a1",
      "seq": 0,
      "type": "workflow",
      "name": "日结",
      "onFailure": "abort",
      "mode": "run",
      "x": 80,
      "y": 120,
      "config": { "workflowId": "wf_1" }
    }
  ],
  "edges": [{ "source": "n_a1", "target": "n_b2" }]
}
```

---

## 6. 服务端 API 设计

### 6.1 仓储层（`jobs/repo.ts`）

```ts
export interface JobNodeInput {
  key: string;
  type: JobStepType;
  name: string;
  config: string;          // JSON 字符串，保持现有存储方式
  onFailure: JobOnFailure;
  mode: JobNodeMode;        // 'run' | 'skip' | 'disable'
  x: number;
  y: number;
}
export interface JobEdgeInput { source: string; target: string }

create(input: { ...原有字段; nodes: JobNodeInput[]; edges: JobEdgeInput[] }): JobRow;
update(id, input: { ...; nodes: JobNodeInput[]; edges: JobEdgeInput[] }): JobRow | null;
listNodes(jobId): JobStepRow[];
listEdges(jobId): JobEdgeRow[];
```

`writeGraph()` 替换 `writeSteps()`：同一事务内先删边、再删节点、再插入节点与边。节点 `id` 仍由服务端生成，但**边与运行记录只认 `node_key`**，因此全量重插不再影响引用关系。

新增运行期方法：

```ts
// 替代 skipRemaining(fromSeq)
markSkipped(jobRunId: string, keys: string[], status: 'skipped' | 'canceled'): void;
```

### 6.2 请求 / 响应

**GET `/api/jobs/:id`**

```json
{
  "id": "j_1",
  "name": "每日数据准备",
  "description": null,
  "nodes": [
    {
      "key": "n_a1",
      "seq": 0,
      "type": "workflow",
      "name": "日结",
      "onFailure": "abort",
      "mode": "run",
      "x": 80,
      "y": 120,
      "config": { "workflowId": "wf_1" }
    }
  ],
  "edges": [{ "source": "n_a1", "target": "n_b2" }],
  "schedule": { "enabled": false, "freqType": null, "cronExpr": null, "timezone": "Asia/Shanghai" },
  "nextRunAt": null
}
```

**POST `/api/jobs` / PUT `/api/jobs/:id`**（请求保持现有「配置平铺」风格）

```json
{
  "name": "每日数据准备",
  "description": "",
  "nodes": [
    { "key": "n_a1", "type": "workflow", "name": "日结", "onFailure": "abort",
      "mode": "run", "x": 80, "y": 120, "workflowId": "wf_1" },
    { "key": "n_b2", "type": "sql", "name": "归档", "onFailure": "continue",
      "mode": "skip", "x": 380, "y": 120, "connectionId": "c_1", "sql": "DELETE FROM t" }
  ],
  "edges": [{ "source": "n_a1", "target": "n_b2" }],
  "schedule": { "enabled": true, "freqType": "daily", "time": "08:00", "timezone": "Asia/Shanghai" }
}
```

**列表 `GET /api/jobs`**：`stepCount` 改为 `nodeCount` + `edgeCount`（前端同步更新）。

**运行详情 `GET /api/job-runs/:id`**：

```json
{
  "jobRun": { "...": "..." },
  "graph": { "version": 1, "nodes": [], "edges": [] },
  "steps": [{ "node_key": "n_a1", "status": "success", "output": "..." }]
}
```

`graph` 为快照解析结果；旧运行没有快照时为 `null`，运行详情页只显示步骤结果表格（不渲染画布）。

**取消 `POST /api/job-runs/:id/cancel`**：校验 Job 归属与 `job` 能力；终态返回 409；成功返回 `{ ok: true }`。

### 6.3 校验规则（服务端强制）

| 规则 | 错误信息示例 |
|---|---|
| `nodes` 1..200，`edges` 0..400 | `节点数量需在 1-200 之间` |
| key 唯一且匹配 `^[A-Za-z0-9_-]{1,64}$` | `节点标识不合法或重复` |
| 边的两端必须存在 | `连线引用了不存在的节点` |
| 禁止自环、重复边 | `不能连接到自身` |
| 禁止环（Kahn） | `存在循环依赖：A → B → A` |
| `mode` 只能是 `run / skip / disable` | `节点运行模式不合法` |
| 坐标必须是有限数 | `节点坐标不合法` |
| 各类型原校验（工作流/连接可访问、SQL 非空、模型名、资源文件） | 保持现有文案 |

实现建议：

- 新建 `apps/server/src/modules/jobs/config.ts`，抽出 `parseNodeConfig(type, raw, ctx)`，由 `routes.parseBody()` 与 `transfer.parseStep()` 共用，避免两套校验漂移。
- 新建 `apps/server/src/modules/jobs/graph.ts`，提供 `assertAcyclic(keys, edges)`、`topoOrder(keys, edges)`；前端 `lib/graph.ts` 独立实现同样的环检测（约 30 行，重复可接受）。
- 请求体兼容：当没有 `nodes` 但有 `steps` 时，按数组顺序自动成链（坐标 `x = i*260, y = 0`，key 由服务端生成），便于旧脚本/旧前端过渡；同时 `GET` 仍返回 `edges`。
- 保存与运行分开校验：保存时允许「全部节点为 `skip`/`disable`」（便于临时下线整条流程）；触发运行时若有效可执行节点为 0，返回 400 `没有可执行的节点`，前端在点击「运行」时也做同样前置提示。

---

## 7. 执行引擎设计

### 7.1 触发与快照

`trigger(jobId)`：

1. 读取当前节点与边，构造快照并写入 `job_runs.graph_snapshot`；
2. 计算拓扑序，按序创建 `job_step_runs`（写 `node_key` 与 `seq`）；
3. 交给 Job 级信号量执行 `worker(jobRun, snapshot)`。

运行期间编辑 Job 不会影响本次运行（快照隔离）。

### 7.2 调度算法

```ts
const MAX_PARALLEL = 1; // v1 串行：一次只跑一个节点。常量保留，将来放开并行只需调大

async function worker(jobRun: JobRunRow, graph: JobGraphSnapshot): Promise<void> {
  const nodes = new Map(graph.nodes.map((n) => [n.key, n]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const n of graph.nodes) { indegree.set(n.key, 0); children.set(n.key, []); }
  for (const e of graph.edges) {
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    children.get(e.source)!.push(e.target);
  }

  // 1) 禁用传播：mode=disable 的节点及其所有可达后代都进入 disabled
  const disabled = new Set<string>();
  for (const n of graph.nodes) {
    if (n.mode === 'disable') {
      disabled.add(n.key);
      for (const k of descendantsOf(n.key)) disabled.add(k);
    }
  }

  // 2) 就绪队列：无入线且未被禁用；同层按 seq 稳定排序
  const ready: string[] = [];
  const bySeq = (a: string, b: string): number => (nodes.get(a)!.seq ?? 0) - (nodes.get(b)!.seq ?? 0);
  const pushReady = (key: string): void => { ready.push(key); ready.sort(bySeq); };

  for (const [k, d] of indegree) if (d === 0 && !disabled.has(k)) pushReady(k);

  const release = (key: string): void => {
    for (const child of children.get(key) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0 && !disabled.has(child)) pushReady(child);
    }
  };

  // 3) 禁用节点：记 skipped，不释放下游（下游已在 disabled 中）
  //    跳过节点：记 skipped，但视为「满足」，释放下游
  for (const key of disabled) markSkipped([key]);
  for (const n of graph.nodes) {
    if (!disabled.has(n.key) && n.mode === 'skip') {
      markSkipped([n.key]);
      release(n.key);
    }
  }

  const running = new Set<Promise<void>>();
  let anyError = false;

  while (ready.length > 0 || running.size > 0) {
    while (!cancelled && ready.length > 0 && running.size < MAX_PARALLEL) {
      const key = ready.shift()!;
      const node = nodes.get(key)!;
      const task = executeStep(...).then((result) => {
        if (result.ok || node.onFailure === 'continue') {
          if (!result.ok) anyError = true;
          release(key);                    // 成功 / 失败但继续：下游照常
        } else {
          anyError = true;
          const dead = descendantsOf(key).filter((k) => !disabled.has(k));
          markSkipped(dead);               // 失败且中止：只跳过本节点的可达后代
        }
      });
      running.add(task);
      task.finally(() => running.delete(task));
    }
    if (running.size > 0) await Promise.race(running);
  }

  finish(cancelled ? 'canceled' : anyError ? 'error' : 'success');
}
```

要点：

- `descendantsOf(key)` 用 BFS 求可达后代；`markSkipped` 只更新 `pending` 的记录，可重复调用（幂等）。
- 被跳过/禁用的节点不进入 `ready`；`abort` 跳过后代时不再触碰其它分支，被跳过节点的下游若只由它支撑，会被同一次 BFS 一并覆盖。
- **串行执行下 DAG 仍有价值**：汇合节点必须等所有前置完成；`abort` 只中断受影响分支；禁用可以整段下线。只是同一时刻不会有两个节点在跑。
- 执行顺序 = 拓扑序的一个合法线性化；同层按 `seq`（保存顺序）稳定排序，保证同一张图多次运行顺序一致。
- `executeStep()` 保留现有三分支；`workflow` 步骤仍 `trigger` + `awaitRun`，`sql` 仍直连，`load_model` 仍走 `modelStore`。
- 运行期把 `nodeKey → runId` 记在内存，供取消时调用 `runService.cancel(runId)`。

### 7.3 最终状态

| 条件 | Job 状态 | error 文案 |
|---|---|---|
| 全部成功或跳过 | `success` | `null` |
| 任一节点 error（含 continue） | `error` | 首个失败节点的错误 |
| 收到取消 | `canceled` | `用户取消` |

### 7.4 取消

- `JobService` 增加 `cancel(jobRunId): boolean`，内存维护 `Map<jobRunId, { cancelled: boolean; runIds: Set<string> }>`。
- 取消时：
  1. 置 `cancelled`；
  2. 对正在执行的 `workflow` 步骤调用 `runService.cancel(runId)`；
  3. 未开始节点 `markSkipped(keys, 'canceled')`；
  4. `jobRuns.finish(status='canceled')`。
- 对仍在 Job 信号量队列中排队的运行：直接落 `canceled`；worker 启动时检查状态，非 `running` 直接退出。

### 7.5 并发与信号量

- 保持 **Job 运行全局串行**（`createSemaphore(1)`），不改变既有资源模型。
- **单次运行内的节点也串行**（`MAX_PARALLEL = 1`）：同一时刻只有一个节点在执行，总耗时约等于各节点耗时之和。
- 不并行的理由：`workflow` 节点会进入 `RunService` 自己的并发队列，节点并行会与之叠加，出现不可预期的排队与资源争用；而步骤之间没有数据依赖，并行只缩短墙钟时间，收益不足以抵消首版复杂度。
- 预留放开路径：调度循环已用 `running` 集合承载多任务，把 `MAX_PARALLEL` 调大即可并行；届时需一并评估 `RunService` 并发上限与 SQL 连接池大小。
- Job 信号量与 Run 信号量相互独立（现有注释已明确不可复用），串行执行下不存在死锁。

---

## 8. 前端设计

### 8.1 页面结构

```
/jobs/:id  JobEditorPage（路由不变）
┌──────────────────────────────────────────────────────────────┐
│ JobToolbar: 返回 | 名称 | 撤销 重做 | 整理布局 | 保存 | 运行      │
├────────────┬────────────────────────────────────┬────────────┤
│ JobPalette │            JobCanvas               │ JobInspector│
│ 运行工作流  │   ┌──────┐      ┌──────┐           │ 名称        │
│ 运行 SQL    │   │ 日结 │─────►│ 归档 │           │ 工作流 ▾    │
│ 加载成模型  │   └──────┘      └──────┘           │ 失败策略    │
│            │        └────► ┌──────┐              │ 运行模式    │
│            │               │ 建模 │              │ [删除节点]  │
├────────────┴────────────────────────────────────┴────────────┤
│ 运行历史抽屉（最近 10 次，点击进入运行详情）                        │
└──────────────────────────────────────────────────────────────┘
```

- 未选中节点时，右侧面板显示 Job 级设置：名称、描述、调度（打开现有调度弹窗）。
- **只有画布一种视图**：节点顺序完全由连线决定，不提供「上移/下移」，也不保留步骤表格。批量信息（类型、状态）通过节点卡 + 属性面板呈现。

### 8.2 文件清单

```
apps/web/src/features/jobs/
├── JobEditorView.tsx           # 画布装配、保存、运行、未保存拦截
├── JobScheduleDialog.tsx       # 从 JobEditorPage 抽出的调度表单
├── canvas/
│   ├── JobCanvas.tsx           # ReactFlow 容器：拖放、连线、选择、快捷键
│   ├── JobNodeCard.tsx         # 节点卡：类型图标/名称/摘要/状态/失败策略角标
│   ├── JobPalette.tsx          # 3 类节点平铺面板
│   ├── JobToolbar.tsx          # 保存/运行/撤销重做/整理布局
│   ├── JobInspector.tsx        # 右侧属性面板（含 Job 级设置空态）
│   └── JobRunCanvas.tsx        # 运行详情只读画布（按状态着色）
├── config/
│   ├── WorkflowNodeForm.tsx
│   ├── SqlNodeForm.tsx
│   └── LoadModelNodeForm.tsx
├── store/
│   └── jobEditorStore.ts       # zustand：图状态 + 选中 + 脏标记 + 撤销重做
└── lib/
    ├── graph.ts                # 环检测、拓扑序、分层自动布局、后代计算
    ├── api.ts                  # toBody() / fromDetail()
    └── nodeMeta.ts             # 3 类节点：图标、配色、默认名、摘要生成
```

改动文件：

- [JobEditorPage.tsx](../../../apps/web/src/pages/JobEditorPage.tsx)：瘦身为数据加载 + `<JobEditorView />`；删除步骤弹窗与表格编辑逻辑。
- [JobRunDetailPage.tsx](../../../apps/web/src/pages/JobRunDetailPage.tsx)：顶部增加只读画布，保留原步骤表格；运行中显示「取消运行」。
- [JobListPage.tsx](../../../apps/web/src/pages/JobListPage.tsx)：`stepCount` → `nodeCount`，可选展示 `edgeCount`。
- [types.ts](../../../apps/web/src/types.ts)：新增 `JobNode / JobEdge / JobGraph`，`JobRunStatus` 加 `canceled`。
- [package.json](../../../apps/web/package.json)：新增 `@xyflow/react": "^12.12.0"`。

### 8.3 画布交互细节

| 交互 | 行为 |
|---|---|
| 从面板拖入 | `onDrop` + `screenToFlowPosition` 创建节点，key 用 `n_` + nanoid(8) |
| 点击面板项 | 在视口中心偏移放置，连续点击阶梯错位 |
| 连线 | 仅 source→target；自环、重复、成环时拒绝并 toast 原因 |
| 删除节点 | 同时删除相连边；Delete/Backspace 支持多选删除 |
| 右键节点 | 配置、设为跳过、设为禁用、恢复为正常、复制、删除 |
| 复制粘贴 | ⌘C/⌘V，粘贴生成新 key、不带边、偏移 40px |
| 撤销重做 | ⌘Z / ⇧⌘Z；拖动位置在 `onNodeDragStop` 提交一次快照 |
| 保存 | ⌘S；客户端先跑环检测与必填校验，失败时选中问题节点并高亮 |
| 整理布局 | 分层布局：rank = 最长前置链，`x = rank*280`，同层按 `y` 居中排列 |
| 首次打开 | 所有坐标均为 0 时自动整理布局 |
| 运行中 | 锁定编辑；当前节点转圈，已完成节点绿色描边，跳过/禁用节点置灰，边在源节点执行中显示流动动画 |
| 空画布 | 中央提示「从左侧拖入组件开始编排」 |

### 8.4 节点卡

- 顶栏色条按类型：工作流（蓝）、SQL（紫）、加载模型（绿）。
- 主行：图标 + 名称 + 类型标签。
- 摘要行：工作流名 / 连接名 + SQL 首行 / 模型名 + 来源。
- 角标：失败策略（`continue` 显示琥珀色「继续」）、运行模式（`skip` 显示琥珀色「跳过」；`disable` 显示灰色「禁用」）、配置缺失（黄色 `!`）。
- 因上游存在 `disable` 而被动不执行的节点，同样置灰并显示灰色「上游禁用」，与主动禁用区分文案。
- 状态：idle / running / success / error / skipped / canceled，与设计器一致的视觉语言。
- 端口：单个左侧入口 + 单个右侧出口，不显示端口文案。

### 8.5 状态管理

```ts
interface JobEditorState {
  name: string;
  description: string;
  nodes: JobNodeModel[];
  edges: JobEdgeModel[];
  schedule: ScheduleForm;
  selectedKey: string | null;
  dirty: boolean;
  past: Snapshot[];
  future: Snapshot[];

  addNode(type, position): string;
  updateNode(key, patch): void;
  removeNodes(keys): void;
  addEdge(source, target): { ok: true } | { ok: false; reason: string };
  removeEdges(ids): void;
  setPositions(map): void;
  undo(): void;
  redo(): void;
  load(job: JobDetail): void;
  toBody(): JobBody;
}
```

撤销策略：所有变更走 `commit(mutator)`，变更前压快照；同类轻量变更（拖动、改名输入）700ms 内合并。最多保留 50 步。

### 8.6 运行可视化

- 点击「运行」→ `POST /api/jobs/:id/runs` → 轮询 `GET /api/job-runs/:id`（1s）。
- 画布按 `steps[].node_key` 着色；边颜色取源节点状态。
- 终态停止轮询，提示成功/失败，并保留「查看运行详情」入口。
- 运行详情页复用 `JobRunCanvas`（只读、无面板），下方仍是步骤结果表格。
- 旧运行（无快照）不显示画布，只显示表格。

---

## 9. 导入导出（v2）

`transfer.ts`：

- `JOB_FILE_VERSION = 2`。
- 导出结构：

```json
{
  "kind": "hustserver.job",
  "version": 2,
  "exportedAt": 1760000000000,
  "job": {
    "name": "每日数据准备",
    "description": null,
    "schedule": { "...": "..." },
    "nodes": [
      { "key": "n_a1", "type": "workflow", "name": "日结", "onFailure": "abort",
        "mode": "run", "x": 80, "y": 120,
        "config": { "workflowId": "wf_1" },
        "refs": { "workflowName": "日结工作流" } }
    ],
    "edges": [{ "source": "n_a1", "target": "n_b2" }]
  }
}
```

- 导入：
  - `version === 2`：按 nodes/edges 解析；key 缺失或重复时重新生成；边指向不存在的节点则丢弃并告警。
  - `version === 1`：沿用现有 `steps` 解析，按顺序生成节点（`x = i*260, y = 120`，key 重新生成）与线性边。
  - 仍按名称匹配连接/工作流（现有 `refs` 机制不变）。
- 兼容性：只放宽读取，不改变 `kind`；错误版本仍拒绝并提示当前支持 `1, 2`。

---

## 10. 兼容性与影响面

| 项目 | 处理 |
|---|---|
| 旧 Job 数据 | 启动迁移补 `node_key`、坐标，并生成线性边 |
| 旧运行记录 | `job_step_runs.node_key` 为空；运行详情退回表格；不重写历史 |
| 旧导出文件 | v1 可导入，自动转线性图 |
| 旧 API 调用方 | 仅 `apps/web` 消费（已核对）；请求仍兼容 `steps` 字段 |
| 调度器 | 无改动，`jobs.enabled/cron_expr` 不变 |
| 审计 | 保存/运行/取消沿用 `job` 资源审计；取消记 `other` |
| 权限 | 沿用 `requireCap('job')` 与归属校验，无新增权限点 |
| 样式 | 新增样式限定 `.job-canvas`，避免与设计器互相污染 |

---

## 11. 测试计划

### 服务端（vitest，现有 `apps/server/test`）

| 文件 | 新增用例 |
|---|---|
| `job-repo.test.ts` | 图 CRUD；`node_key` 在多次保存后保持；边全量替换；删除 Job 级联 |
| `job-service.test.ts` | 线性链；菱形汇合（全部成功）；多起点按 `seq` 稳定顺序执行且任意时刻最多 1 个 running；`abort` 只跳过后代不影响兄弟分支；`continue` 下游继续；`skip` 仅本节点 skipped、下游照常；`disable` 使全部后代 skipped，改回 `run` 后恢复；全部 `disable` 时触发报错；取消中途运行；快照隔离（运行中改 Job 不影响本次） |
| `job-routes.test.ts` | 新 nodes/edges 读写；环/重复 key/悬空边/非法 `mode` 400；全禁用允许保存但触发运行 400；旧 `steps` 自动成链；取消接口权限与 409 |
| `job-transfer.test.ts` | v2 导出导入往返；v1 文件升级；缺失 key/悬空边告警 |
| `migrate.test.ts` | 旧结构库迁移后列存在、坐标回填、线性边生成且幂等 |

### 前端（`apps/web/test`）

- `job-graph.test.ts`：环检测、拓扑序、后代计算（含 `disable` 向下传播）、分层布局、`toBody/fromDetail` 往返。
- `job-editor-store.test.ts`：新增/删除节点与边、撤销重做、拖动合并、粘贴新 key、`run/skip/disable` 模式切换。

### 手工验收

1. 新建 Job，拖入 4 个节点组成菱形，连线保存后刷新布局保持。
2. 运行后画布实时着色；汇合节点在两条前置都完成后才开始；任意时刻只有一个节点在转圈。
3. 将分支节点失败策略设为 `abort`，验证兄弟分支仍执行、汇合节点跳过。
4. 把一个节点设为「跳过」：该节点灰色「跳过」，下游继续执行；再设为「禁用」：该节点及全部下游灰色「上游禁用」，兄弟分支不受影响。
5. 运行中取消，状态为「已取消」。
6. 旧 Job 打开后是一条直线，可直接运行。
7. 导出 v2 → 删除 → 导入，图与坐标一致；用旧 v1 文件导入成功。

---

## 12. 分阶段实施

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| P0 数据与 API | 迁移、repo、图校验、nodes/edges 读写、旧 steps 兼容 | 服务端测试通过，旧 Job 可原样读写 |
| P1 执行器 | 拓扑调度（串行）、`abort` 后代跳过、`skip`/`disable` 双语义、快照、取消 | 图语义用例全绿；旧线性 Job 行为不变 |
| P2 画布编辑器 | 面板、画布、节点卡、属性面板、撤销重做、自动布局（纯画布，无表格视图） | 可完成「拖入-连线-配置-保存」闭环 |
| P3 运行可视化 | 画布运行态、轮询、取消按钮、运行详情只读画布 | 运行状态与取消端到端可用 |
| P4 导入导出与收尾 | v2 导出、v1 兼容、文档、类型与构建检查 | `pnpm -r typecheck` / `build` / 测试全通过 |

---

## 13. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 用户把连线误解为数据流 | 配置出错误预期 | 工具栏常驻提示 + 帮助文案，节点不显示多端口 |
| 只有 3 类节点，画布显得「没东西可拖」 | 采用率低 | 用依赖结构、跳过、禁用、失败分支体现编排价值，而非靠节点数量 |
| 「跳过」与「禁用」语义易混淆 | 用户误以为跳过会连带下游 | 角标文案区分（跳过 / 禁用 / 上游禁用），右键菜单分列两项，帮助文案与运行详情保持一致 |
| 串行执行导致总耗时为各节点之和 | 用户期望画布能提速 | UI 与文档明确 v1 串行；调度循环已支持多任务，后续调大 `MAX_PARALLEL` 即可 |
| `abort` 语义与旧「后续全部跳过」不一致 | 老用户困惑 | UI 明确「仅中断该分支」；旧线性图行为与原来完全一致 |
| 保存全量重插导致引用漂移 | 运行记录/边错乱 | 一律使用 `node_key`，`step.id` 不再被外部引用 |
| 迁移在旧库上失败 | 启动失败 | 列判断幂等 + 事务内回填；迁移前置备份提示 |
| 运行中编辑导致状态错位 | 运行详情错乱 | 使用 `graph_snapshot` 快照；运行详情只读 |
| 画布与设计器样式冲突 | UI 错乱 | `.job-canvas` 作用域 + 复用现有 CSS 变量 |

---

## 14. 已确认的产品决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 图结构 | **支持 DAG**：多起点、分支、AND 汇合、孤岛节点 |
| 2 | 节点挂起 | **拆成两个功能**：`skip` 只跳过自身、下游继续；`disable` 连同所有可达下游一起禁用 |
| 3 | 编辑器视图 | **只保留画布**，不保留步骤表格/列表视图 |
| 4 | 执行并发 | **v1 串行**，`MAX_PARALLEL = 1`；保留常量作为后续放开并行的扩展点 |

本版不做、后续可按需追加：运行至此/缓存至此、条件分支节点、节点级重试与超时、并行执行、多人协同。
