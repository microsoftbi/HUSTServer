# HUSTServer 设计文档：用户角色与权限（User Roles & Capabilities）

- 日期：2026-10-16
- 状态：已批准
- 依据：本会话 brainstorming 决策；现有实现见 [2026-10-16-dashboard-design.md](./2026-10-16-dashboard-design.md)

## 1. 背景与目标

现状：系统只有两个角色 `admin` / `user`（[repo.ts](../../../apps/server/src/modules/users/repo.ts#L4)），且是**单值**的 `users.role` 列。除用户管理（`/api/admin/users`）与系统设置（`/api/admin/settings`）外，各业务模块只做「登录 + owner/shared」判断，没有按功能维度的授权；资源库（`/api/resources*`）更是**连登录之外的任何校验都没有**。

本次把角色细分为四种，权限按**能力**划分，并支持**一个用户同时拥有多个角色**（权限取并集）。

### 角色定义

| key | 中文 | 权限范围（需求原文） |
|---|---|---|
| `admin` | 管理员 | 全部功能 |
| `workflow_author` | 工作流作者 | 工作流、资源管理、连接、Job 编排 |
| `dashboard_author` | 仪表板作者 | 仪表板 |
| `dashboard_viewer` | 仪表板用户 | 仅仪表板查看 |

### 非目标

- 不做逐资源的 ACL / 角色继承树；能力集是静态常量。
- 不做自定义角色或角色管理界面（角色集合固定为上述四个）。
- 不改动 `owner_id` / `shared` 的资源归属模型，仅在其上叠加能力门禁，并调整仪表板的读取范围。

## 2. 范围与关键决策

| 决策项 | 结论 |
|---|---|
| 角色模型 | **多角色叠加**，权限取并集 |
| 存储 | 新增 `user_roles(user_id, role)` 关联表；`users.role` 降级为「最高权限角色」镜像列 |
| 老数据迁移 | `role='user'` → `workflow_author`；新库默认值同步改为 `workflow_author` |
| 仪表板查看范围 | **全部可见**（拥有 `dashboard.view` 即可浏览所有仪表板） |
| 仪表板编辑范围 | 自己创建的 + 被共享的；管理员可编辑全部 |
| 资源库 | 页面仅管理员 + 工作流作者（导航隐藏 + 写接口 403）；**读接口额外对 `dashboard.edit` 开放**，以支持仪表板的「文件数据集」 |
| 连接粒度 | 拆为 `connection.manage`（管理）与 `connection.use`（使用） |
| 鉴权写法 | **能力守卫** `requireCap`（+ `requireAnyCap`） |

### 被否决的方案

- **保持单一角色**：用户明确要求多角色叠加。
- **`users.roles` 单列存 JSON**：语义弱、无法按角色检索；改用关联表。
- **角色守卫 `requireRole(['workflow_author','admin'])`**：同一能力会在多条路由重复罗列；改用能力守卫。
- **给仪表板单独做一套「取文件」接口**：与资源库重复实现；改为把资源库读接口放开给 `dashboard.edit`。

## 3. 角色与能力矩阵

新增 `apps/server/src/modules/users/roles.ts`（纯常量与纯函数，不依赖 DB，避免与 `repo.ts` 循环引用）：

```ts
export type Role = 'admin' | 'workflow_author' | 'dashboard_author' | 'dashboard_viewer';

export const ROLES: readonly Role[] = ['admin', 'workflow_author', 'dashboard_author', 'dashboard_viewer'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  workflow_author: '工作流作者',
  dashboard_author: '仪表板作者',
  dashboard_viewer: '仪表板用户',
};

export type Capability =
  | 'admin' | 'workflow' | 'job' | 'resources'
  | 'connection.manage' | 'connection.use'
  | 'dashboard.edit' | 'dashboard.view';

export const ROLE_CAPS: Record<Role, Capability[]> = {
  admin: ['admin', 'workflow', 'job', 'resources', 'connection.manage', 'connection.use', 'dashboard.edit', 'dashboard.view'],
  workflow_author: ['workflow', 'job', 'resources', 'connection.manage', 'connection.use'],
  dashboard_author: ['connection.use', 'dashboard.edit', 'dashboard.view'],
  dashboard_viewer: ['dashboard.view'],
};

export function capabilitiesOf(roles: Role[]): Set<Capability>;   // 多角色并集
export function primaryRole(roles: Role[]): Role;                 // admin > workflow_author > dashboard_author > dashboard_viewer
export function isRole(v: unknown): v is Role;
```

矩阵：

| 能力 | 管理员 | 工作流作者 | 仪表板作者 | 仪表板用户 |
|---|:-:|:-:|:-:|:-:|
| `admin`（用户/设置） | ✓ | | | |
| `workflow` | ✓ | ✓ | | |
| `job` | ✓ | ✓ | | |
| `resources` | ✓ | ✓ | | |
| `connection.manage` | ✓ | ✓ | | |
| `connection.use` | ✓ | ✓ | ✓ | |
| `dashboard.edit` | ✓ | | ✓ | |
| `dashboard.view` | ✓ | | ✓ | ✓ |

## 4. 架构

在「角色」与「路由」之间引入**能力层**：

```
user_roles ──> Role[] ──(capabilitiesOf)──> Set<Capability> ──> requireCap() 断言
```

- `req.auth` 由 `{ userId, role, username }` 扩展为 `{ userId, username, roles: Role[], caps: Set<Capability> }`。
- 守卫：`requireCap(cap)`（必须含该能力）；`requireAnyCap(...caps)`（含其一即可，用于资源库读接口）；`requireAdmin` 收敛为 `requireCap('admin')`。
- 前端 `SessionUser` 同步扩展为 `{ id, username, roles, capabilities }`。

## 5. 数据模型与迁移

### 5.1 新增表（[migrate.ts](../../../apps/server/src/db/migrate.ts) 的 `SCHEMA` 内追加）

```sql
CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);
```

`users.role` 的 `DEFAULT 'user'` 改为 `DEFAULT 'workflow_author'`（`CREATE TABLE IF NOT EXISTS` 只影响新库；老库保持原样，由回填处理）。

### 5.2 回填迁移（`migrate(db)` 内，建表之后）

```ts
const roleCount = Number(
  (db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number }).c,
);
if (roleCount === 0) {
  const rows = db.prepare('SELECT id, role FROM users').all() as Array<{ id: string; role: string }>;
  const ins = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)');
  for (const r of rows) ins.run(r.id, r.role === 'admin' ? 'admin' : 'workflow_author');
}
```

- 老值 `user` 及任何非 `admin` 值统一映射为 `workflow_author`。
- 以「`user_roles` 为空」为幂等条件，重复启动不会重复插入。

### 5.3 `users.role` 的定位

`user_roles` 是**唯一权威来源**；`users.role` 保留为 `primaryRole(roles)` 的镜像，供尚未改造的列读取点使用。用户增删改角色时，同时写 `user_roles` 与镜像列。

## 6. 后端设计

### 6.1 `UsersRepo` 扩展（[users/repo.ts](../../../apps/server/src/modules/users/repo.ts)）

- `Role` 类型定义**移出**到 `roles.ts`，`repo.ts` 与 `guards.ts` 改为从 `roles.ts` 引入（`roles.ts` 无依赖，不产生循环）。
- 新增方法：

```ts
rolesOf(userId: string): Role[];                 // 按 user_roles 读
setRoles(userId: string, roles: Role[]): void;   // 覆盖写：先删后插 + 更新镜像列
```

- 签名调整：`create({ username, passwordHash, roles: Role[] })`、`update(id, { roles?, status?, passwordHash? })`。
- `remove(id)` 不变（`user_roles` 由外键 `ON DELETE CASCADE` 随用户删除级联清理）。

### 6.2 守卫（[plugins/guards.ts](../../../apps/server/src/plugins/guards.ts)）

```ts
export interface AuthContext {
  userId: string;
  username: string;
  roles: Role[];
  caps: Set<Capability>;
}

// requireAuth：校验会话与状态后
const roles = deps.users.rolesOf(user.id);
req.auth = { userId: user.id, username: user.username, roles, caps: capabilitiesOf(roles) };

export function requireCap(cap: Capability) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth?.caps.has(cap)) {
      await reply.code(403).send({ error: `需要「${CAP_LABELS[cap]}」权限` });
    }
  };
}

export function requireAnyCap(...caps: Capability[]) { /* 命中其一即通过，否则 403 */ }

export const requireAdmin = requireCap('admin');
```

`CAP_LABELS` 为能力的中文名（同样放在 `roles.ts`）。

### 6.3 各模块门禁映射

| 路由 | 现在 | 改为 | 行级规则调整 |
|---|---|---|---|
| `workflows/*` | `requireAuth` | `requireCap('workflow')` | 不变（admin \| owner） |
| `jobs/*` `runs/*` `schedules/*` | `requireAuth` | `requireCap('job')` | 不变 |
| resources 读：`GET /api/resources`、`/tree`、`/sheets`、`/folders/tree`、`/files/download` | `requireAuth` | `requireAnyCap('resources', 'dashboard.edit')` | 不变 |
| resources 写：`POST /move`、`POST\|DELETE /folders`、`POST\|DELETE /files` | `requireAuth` | `requireCap('resources')` | 不变 |
| `GET /api/connections` | `requireAuth` | `requireCap('connection.use')` | 非 admin 返回共享 + 自有（现有 `listForOwner`） |
| `POST /api/connections`、`PUT\|DELETE /:id`、`POST /test`、`POST /:id/test` | `requireAuth` | `requireCap('connection.manage')` | `canManage` = admin \| owner（不变） |
| `GET /api/connections/:id/objects` | `requireAuth` | `requireCap('connection.use')` | `canUse` = admin \| shared \| owner（不变） |
| `GET /api/dashboards`、`GET /:id` | `requireAuth` | `requireCap('dashboard.view')` | 列表改为**全部可见**（`listAll`）；查看不再做 owner/shared 过滤 |
| `POST /api/dashboards`、`PUT\|DELETE /:id` | `requireAuth` | `requireCap('dashboard.edit')` | `canEdit` = admin \| owner \| shared；`shared` 仅 admin 可置 |
| `POST /api/data/query`、`POST /api/data/tables` | `requireAuth` | `requireCap('connection.use')` | 内联 `canUse` 不变 |
| `POST /api/schema/sqlserver` | `requireAuth` | `requireCap('connection.use')` | 现有 `connectionId` 分支 `canUse` 不变 |
| `POST /api/schema/csv`、`POST /api/schema/excel` | `requireAuth` | `requireCap('resources')` | 不变 |
| `users/*`、`settings/*` | `requireAdmin` | `requireCap('admin')` | 不变 |

> 说明：仪表板数据集（`SavedDataset`）随仪表板 `payload` 一起持久化，其创建/修改由 `PUT /api/dashboards/:id` 承担，已被 `dashboard.edit` 覆盖；`data` 模块只提供取数，故仅需 `connection.use`。

**行级判断同步改造**：各路由内所有 `req.auth!.role === 'admin'` 一律替换为 `req.auth!.caps.has('admin')`（涉及 workflows、connections、dashboards、jobs、runs、schedules 的 `canManage`/`canAccess`/列表分流等处）。

### 6.4 用户管理路由（[users/routes.ts](../../../apps/server/src/modules/users/routes.ts)）

- `isRole` 改用 `roles.ts` 的版本（四值集合）。
- `publicUser` 返回 `{ id, username, roles, status, created_at, updated_at }`（`roles` 来自 `repo.rolesOf`；不再返回单值 `role`）。
- `POST /api/admin/users`：body 为 `{ username, password, roles: Role[] }`；校验 `roles` 为非空数组且每项合法，否则 400。
- `PUT /api/admin/users/:id`：body 为 `{ roles?, status? }`。
- 其余行为不变：禁止禁用/删除自己、禁用清会话、重置密码清会话。
- 全部 `preHandler: [auth, requireCap('admin')]`。

### 6.5 引导与认证

- [bootstrap.ts](../../../apps/server/src/bootstrap.ts)：`users.create({ username, passwordHash, roles: ['admin'] })`。
- [auth/routes.ts](../../../apps/server/src/modules/auth/routes.ts)：`login` 与 `me` 返回 `{ id, username, roles, capabilities }`（`me` 取自 `req.auth`，`capabilities` 序列化为数组）。

## 7. 前端设计

- [api.ts](../../../apps/web/src/api.ts)：`SessionUser` 改为 `{ id, username, roles: Role[]; capabilities: Capability[] }`。
- 新增 `apps/web/src/roles.ts`：`Role` / `Capability` 类型与 `ROLE_LABELS`（与后端保持一致的四值中文名）。
- [auth.tsx](../../../apps/web/src/auth.tsx)：`AuthContextValue` 增加 `hasCap(cap: Capability): boolean` 与 `hasRole(role: Role): boolean`。
- [Layout.tsx](../../../apps/web/src/components/Layout.tsx)：导航按能力显隐——工作流 `workflow`、仪表板 `dashboard.view`、资源管理 `resources`、连接 `connection.manage`、Job编排 `job`、用户/设置 `admin`；右上角显示多角色中文标签（`roles.map(r => ROLE_LABELS[r]).join('、')`）。
- [App.tsx](../../../apps/web/src/App.tsx)：新增 `RequireCap` 包装组件，为各路由加能力门禁，无权时渲染「无权访问」并**不发起**数据请求：
  - `/workflows*` → `workflow`；`/jobs*`、`/job-runs/:id`、`/runs/:id` → `job`
  - `/connections` → `connection.manage`；`/resources` → `resources`
  - `/dashboards` → `dashboard.view`；`/dashboards/:id` → `dashboard.view`（编辑器保存按钮另由 `dashboard.edit` 门禁）
  - `/users`、`/settings` → `admin`
- [UsersPage.tsx](../../../apps/web/src/pages/UsersPage.tsx)：角色由下拉改为**多选**（复选框组），列表展示多角色标签；页面门槛改 `hasCap('admin')`。
- [ConnectionsPage.tsx](../../../apps/web/src/pages/ConnectionsPage.tsx)：`isAdmin` 改为 `hasCap('connection.manage')`（共享勾选与页面门槛均用能力判断）。
- [DashboardListPage.tsx](../../../apps/web/src/features/dashboard/DashboardListPage.tsx)：共享按钮的 `role === 'admin'` 改为 `hasCap('admin')`。
- [SettingsPage.tsx](../../../apps/web/src/pages/SettingsPage.tsx)：门槛改 `hasCap('admin')`。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 未登录 / 会话失效 / 账号禁用 | 401（沿用现有文案） |
| 缺能力 | 403，`{ error: '需要「<能力中文名>」权限' }` |
| 前端越权访问 | 路由级 `RequireCap` 拦截为「无权访问」，不发起请求；导航项隐藏 |
| 兜底 | 后端接口为唯一权威，前端隐藏仅为体验优化；写操作即使前端漏判也由接口 403 兜底 |
| 禁用 / 删除用户 | 沿用「禁用即清会话」；`user_roles` 由外键级联删除 |

## 9. 测试

- **新增** `apps/server/test/roles.test.ts`：`capabilitiesOf` 各角色映射与多角色并集；`primaryRole` 优先级；`isRole` 边界。
- **users 路由**：创建多角色用户、更新角色集合、非法角色 400、非管理员 403、`publicUser` 含 `roles`。
- **迁移**：模拟老库（`users.role='user'`）执行 `migrate` 后 `user_roles` 回填为 `workflow_author`；重复执行保持幂等。
- **各业务路由**：按「角色 × 端点」断言 200 / 403，重点覆盖：
  - `resources` 读对 `dashboard.edit` 开放、写对 `dashboard.edit` 403、对 `workflow_author` 放行；
  - `connections` 的 `manage` vs `use` 分流（仪表板作者可用 `/objects`、不可 `POST/PUT/DELETE`）；
  - `dashboards` 的 `view` vs `edit` 分流、列表全部可见、`shared` 仅 admin；
  - `dashboard_viewer` 只读。
- **存量测试更新**：以内联 `role: 'admin' | 'user'` 构造会话的用例需改为 `roles: [...]`（约 13 个 server 测试文件 + [apps/web/test/api.test.ts](../../../apps/web/test/api.test.ts)）。

## 10. 验证计划

1. `pnpm --filter @hustserver/server build`、`pnpm --filter @hustserver/server test` 全绿（既有 171 项不回归）。
2. `pnpm --filter @hustserver/web build` exit 0。
3. 重启后端，浏览器端到端（管理员账号先建四个角色各一个用户 + 一个多角色用户）：
   - **工作流作者**：可见 工作流 / 资源管理 / 连接 / Job编排；不可见 仪表板 / 用户 / 设置；直连 `/api/dashboards` 返回 403。
   - **仪表板作者**：可见 仪表板；不可见 工作流 / 连接 / 资源管理 / Job / 用户 / 设置；在仪表板中可选用共享连接建 SQL 数据集、可从资源库读文件建文件数据集；直连 `POST /api/connections` 返回 403。
   - **仪表板用户**：仅能查看仪表板；新建 / 编辑接口返回 403。
   - **多角色用户**（如 `workflow_author + dashboard_viewer`）：同时具备两侧入口。
   - **老数据**：原 `role='user'` 用户登录后，能力等同工作流作者。
