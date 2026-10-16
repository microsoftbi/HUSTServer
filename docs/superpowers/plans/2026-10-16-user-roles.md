# 实现计划：四级角色与能力守卫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- 日期：2026-10-16
- Spec：[docs/superpowers/specs/2026-10-16-user-roles-design.md](../specs/2026-10-16-user-roles-design.md)（commit `d18b64b`，已批准）
- 执行方式：11 个任务串行执行，每任务独立实现 + 审查 + 单独 git commit

## Goal

把现有的两角色模型（`admin` / `user`）升级为四角色 + 能力守卫模型：管理员（`admin`）、工作流作者（`workflow_author`）、仪表板作者（`dashboard_author`）、仪表板用户（`dashboard_viewer`）。角色存储在 `user_roles` 关联表（多角色叠加，权限取并集），路由层由 `requireCap(cap)` 守卫，前端按能力渲染导航与入口。

## Spec 修正说明（5 处落地细化）

1. **`/dashboards/:id` 前端门禁修正**：spec §7 写 `/dashboards/:id → dashboard.edit`，但与 §6.3（后端 `GET /api/dashboards/:id → dashboard.view`）、§10（「仪表板用户：仅能查看仪表板」）及需求原文（「仪表板用户只有仪表板查看的权限」）冲突。按 §7 实现会导致 `dashboard_viewer` 打不开任何仪表板页面。**修正为 `/dashboards/:id` 门禁用 `dashboard.view`**；编辑器内「保存」按钮按 `hasCap('dashboard.edit')` 门控（无该能力时禁用并隐藏保存入口），后端 `PUT /api/dashboards/:id` 仍由 `dashboard.edit` + `canEdit` 双重兜底。
2. **`PATCH /api/resources/folders`（重命名）与 `PATCH /api/resources/files`（重命名）补门禁**：spec §6.3 表遗漏这两个写端点，语义上属资源库写操作，**统一加 `requireCap('resources')`**。
3. **`requireAdmin` 保留原样**：spec §6.2 定义 `export const requireAdmin = requireCap('admin')`，故 `users/routes.ts`、`settings/routes.ts` 里既有的 `preHandler: [auth, requireAdmin]` 语义已等价于 `requireCap('admin')`，**不做无意义替换**。
4. **`repo.ts` 重新导出 `Role`**：为减少 churn，`users/repo.ts` 保留 `export type { Role } from './roles.js'`，使 `guards.ts` 等既有的 `from './repo.js'` 导入在 Task 3 不必改动；Task 4 因改造 helper 签名再顺带收敛 `Role` 导入。
5. **`auth-routes.test.ts` 的 `role` 断言分两步变更**：Task 3 先改 `expect(res.json().role).toBe('workflow_author')`（镜像列语义先落地）；Task 4 login 响应结构改为 `{ roles, capabilities }` 后再改为 `expect(res.json().roles).toEqual(['workflow_author'])`。此为必要的中间态 churn，已确认接受。

## Architecture

```
                 ┌──────────────────────────────┐
                 │  user_roles(user_id, role)   │  唯一权威存储
                 └──────────────┬───────────────┘
                                │ usersRepo.rolesOf(userId): Role[]
                                ▼
                    capabilitiesOf(roles): Set<Capability>   roles.ts 纯函数
                                │
                                ▼
        requireAuth  →  req.auth = { userId, username, roles, caps }
                                │
                    ┌───────────┴────────────┐
                    ▼                        ▼
            requireCap(cap)            requireAnyCap(...caps)
            403 需要「<能力中文名>」权限
                                │
                                ▼
        各业务路由 preHandler: [auth, requireCap('...')]

镜像列：users.role = primaryRole(roles)（降级为“最高权限角色”，仅供展示/兼容）
前端：SessionUser { id, username, roles: Role[], capabilities: Capability[] }
      useAuth().hasCap(cap) / hasRole(role) / <RequireCap cap="...">
```

## Tech Stack

- 后端：Node ≥20，TypeScript 5.6，Fastify 5.12，better-sqlite3 13（同步事务），vitest 2.1
- 前端：React 19，Vite 6，react-router-dom 7，Tailwind 4，zustand 5，vitest 2.1
- Monorepo：pnpm workspace（`@hustserver/server` / `@hustserver/web`）

## Global Constraints（每个任务都必须遵守）

1. **角色四值**：`'admin' | 'workflow_author' | 'dashboard_author' | 'dashboard_viewer'`，全部定义在 `apps/server/src/modules/users/roles.ts`（前端镜像一份在 `apps/web/src/roles.ts`）。
2. **能力八值**：`'admin' | 'workflow' | 'job' | 'resources' | 'connection.manage' | 'connection.use' | 'dashboard.edit' | 'dashboard.view'`。
3. **`ROLE_CAPS` 映射**（唯一权威，不得在别处复制）：
   - `admin`: 全部八项
   - `workflow_author`: `workflow`, `job`, `resources`, `connection.manage`, `connection.use`
   - `dashboard_author`: `connection.use`, `dashboard.edit`, `dashboard.view`
   - `dashboard_viewer`: `dashboard.view`
4. **多角色取并集**：`capabilitiesOf(roles)` 返回 `Set<Capability>`，为各角色能力并集。
5. **`primaryRole(roles)`** 优先级 `admin > workflow_author > dashboard_author > dashboard_viewer`；**空数组回退 `'dashboard_viewer'`**。仅用于写 `users.role` 镜像列。
6. **`user_roles` 是唯一权威**：权限判定一律走 `rolesOf` → `capabilitiesOf`，禁止再读 `users.role` 做判定。
7. **403 文案**：`需要「<能力中文名>」权限`（`CAP_LABELS`）；401 文案沿用现有三段（『未登录』/『会话无效或已过期』/『账号不可用』）。
8. **测试构造模式**：`db = new Database(':memory:'); migrate(db); ...; app = await buildServer({ db, config: cfg, logger: false }); await app.ready();`，`cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'a'.repeat(64), HUSTSERVER_DATA_DIR: '/tmp/hustserver-test' })`。
9. **导入扩展名**：web 与 server 一律 `.js` 后缀（测试 `from '../src/...js'`）。
10. **测试命令**：`pnpm --filter @hustserver/server test`（= `vitest run`）；构建 `pnpm --filter @hustserver/server build`（= `tsc -p tsconfig.json`）。
11. **前端构建**：`pnpm --filter @hustserver/web build`（= `tsc -p tsconfig.json && vite build`）。
12. **禁止执行** `pnpm --filter @hustserver/workflow-designer build`（该包无 build 脚本，会报 `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`）。
13. **Git 纪律**：每任务结束单独 commit（`feat:` / `fix:` / `docs:` / `chore:` + 中文一句话）；不使用 `git add -A`；不更新 git config；不主动 push。
14. **派发子代理绝不传 `model` 参数**（Trae 平台会报 4023）；停进程用 `StopCommand`，禁止 `kill` / `pkill`。
15. **Range/类型检查边界**：server tsconfig `include: ["src/**/*.ts"]`、web tsconfig `include: ["src"]`，均**不含 test**，故测试文件不做类型检查，但测试代码仍须正确编译运行。

---

## Task 1：角色与能力常量模块

**Files**
- 新增：`apps/server/src/modules/users/roles.ts`
- 新增：`apps/server/test/roles.test.ts`

**Interfaces**
```ts
// apps/server/src/modules/users/roles.ts
export type Role = 'admin' | 'workflow_author' | 'dashboard_author' | 'dashboard_viewer';
export const ROLES: readonly Role[];
export const ROLE_LABELS: Record<Role, string>;
export type Capability =
  | 'admin' | 'workflow' | 'job' | 'resources'
  | 'connection.manage' | 'connection.use'
  | 'dashboard.edit' | 'dashboard.view';
export const CAPABILITIES: readonly Capability[];
export const ROLE_CAPS: Record<Role, Capability[]>;
export const CAP_LABELS: Record<Capability, string>;
export function isRole(v: unknown): v is Role;
export function capabilitiesOf(roles: readonly Role[]): Set<Capability>;
export function primaryRole(roles: readonly Role[]): Role;
```

**Steps**

- [ ] 写失败测试 `apps/server/test/roles.test.ts`：断言 `ROLES` 含四值；`isRole('admin')===true`、`isRole('user')===false`、`isRole(1)===false`；`[...capabilitiesOf(['dashboard_viewer'])].sort()` 等于 `['dashboard.view']`；`capabilitiesOf(['dashboard_author','dashboard_viewer'])` 含 `dashboard.edit` 与 `dashboard.view` 且大小为 3；`capabilitiesOf(['admin'])` 大小为 8；`primaryRole(['dashboard_viewer','admin'])==='admin'`、`primaryRole(['dashboard_author','workflow_author'])==='workflow_author'`、`primaryRole([])==='dashboard_viewer'`；`CAP_LABELS['connection.manage']` 非空字符串。
- [ ] 运行 `pnpm --filter @hustserver/server test -- roles` 确认失败（模块不存在）。
- [ ] 新建 `apps/server/src/modules/users/roles.ts`，实现：

```ts
export type Role = 'admin' | 'workflow_author' | 'dashboard_author' | 'dashboard_viewer';

export const ROLES: readonly Role[] = [
  'admin',
  'workflow_author',
  'dashboard_author',
  'dashboard_viewer',
];

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  workflow_author: '工作流作者',
  dashboard_author: '仪表板作者',
  dashboard_viewer: '仪表板用户',
};

export type Capability =
  | 'admin'
  | 'workflow'
  | 'job'
  | 'resources'
  | 'connection.manage'
  | 'connection.use'
  | 'dashboard.edit'
  | 'dashboard.view';

export const CAPABILITIES: readonly Capability[] = [
  'admin',
  'workflow',
  'job',
  'resources',
  'connection.manage',
  'connection.use',
  'dashboard.edit',
  'dashboard.view',
];

export const CAP_LABELS: Record<Capability, string> = {
  admin: '管理员',
  workflow: '工作流',
  job: 'Job 编排',
  resources: '资源管理',
  'connection.manage': '连接管理',
  'connection.use': '连接使用',
  'dashboard.edit': '仪表板编辑',
  'dashboard.view': '仪表板查看',
};

export const ROLE_CAPS: Record<Role, Capability[]> = {
  admin: [...CAPABILITIES],
  workflow_author: ['workflow', 'job', 'resources', 'connection.manage', 'connection.use'],
  dashboard_author: ['connection.use', 'dashboard.edit', 'dashboard.view'],
  dashboard_viewer: ['dashboard.view'],
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function capabilitiesOf(roles: readonly Role[]): Set<Capability> {
  const out = new Set<Capability>();
  for (const role of roles) {
    for (const cap of ROLE_CAPS[role] ?? []) out.add(cap);
  }
  return out;
}

const PRIMARY_ORDER: readonly Role[] = [
  'admin',
  'workflow_author',
  'dashboard_author',
  'dashboard_viewer',
];

export function primaryRole(roles: readonly Role[]): Role {
  for (const role of PRIMARY_ORDER) {
    if (roles.includes(role)) return role;
  }
  return 'dashboard_viewer';
}
```

- [ ] 运行 `pnpm --filter @hustserver/server test -- roles` 确认通过。
- [ ] Commit：`feat: 新增角色与能力常量模块（四角色八能力）`

---

## Task 2：user_roles 迁移与老数据回填

**Files**
- 修改：`apps/server/src/db/migrate.ts`（`SCHEMA` 追加 `user_roles` 表与索引；`users.role` DEFAULT 改 `workflow_author`；`migrate()` 末尾加回填）
- 修改：`apps/server/test/migrate.test.ts`（表名数组加 `'user_roles'`）
- 新增：`apps/server/test/user-roles-migration.test.ts`

**Interfaces**
```ts
// migrate.ts 新增导出（供测试直接用）
export function backfillUserRoles(db: Database): void;
```
`user_roles` 表结构（写入 `SCHEMA`）：
```sql
CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);
```

**Steps**

- [ ] 修改 `apps/server/test/migrate.test.ts`：把 `'user_roles'` 加入表名数组（第 15-16 行）；新增一条断言 `idx_user_roles_role` 存在（照抄 `idx_dashboards_owner` 的查询写法）。
- [ ] 新增 `apps/server/test/user-roles-migration.test.ts`，三个用例：
  1. **老库回填**：手工 `CREATE TABLE users (... role TEXT NOT NULL DEFAULT 'user')` 建旧结构 → 插一行 `role='admin'`、一行 `role='user'` → 调 `migrate(db)` → 断言 `user_roles` 中 admin 用户只有 `('admin')`、普通用户只有 `('workflow_author')`；且 `users.role` 普通用户仍为 `'user'`（回填不重写镜像列）。
  2. **幂等**：对已迁移库再调一次 `migrate(db)`，`SELECT COUNT(*) FROM user_roles` 不变。
  3. **新库默认值**：`migrate(db)` 后不指定 `role` 插入 users，断言 `users.role` 为 `'workflow_author'`。
- [ ] 运行 `pnpm --filter @hustserver/server test -- user-roles-migration` 确认失败。
- [ ] 改 `apps/server/src/db/migrate.ts`：
  - `SCHEMA` 中 `users.role TEXT NOT NULL DEFAULT 'user'` → `DEFAULT 'workflow_author'`。
  - `SCHEMA` 末尾（`idx_dashboards_owner` 之后、闭反引号之前）追加 `user_roles` 表与 `idx_user_roles_role` 索引。
  - 新增并导出：

```ts
export function backfillUserRoles(db: Database): void {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM user_roles').get() as { c: number };
  if (c > 0) return;
  const rows = db.prepare('SELECT id, role FROM users').all() as { id: string; role: string }[];
  const insert = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const row of rows) {
      insert.run(row.id, row.role === 'admin' ? 'admin' : 'workflow_author');
    }
  });
  tx();
}
```
  - 在 `migrate(db)` 里，`db.exec(SCHEMA)` 之后调用 `backfillUserRoles(db)`（须在 `JOB_INDEXES` 之前或之后均可，放 `db.exec(JOB_TABLES)` 之后即与增量迁移同段）。
- [ ] 运行 `pnpm --filter @hustserver/server test -- migrate user-roles-migration` 确认通过。
- [ ] Commit：`feat: 新增 user_roles 表与老数据回填迁移`

---

## Task 3：多角色存储贯通（原子任务）

**Files**
- 修改：`apps/server/src/modules/users/repo.ts`（新增 `rolesOf` / `setRoles`；`create` 收 `roles`；`update` 收 `roles?`；重新导出 `Role`）
- 修改：`apps/server/src/bootstrap.ts`（`role: 'admin'` → `roles: ['admin']`）
- 修改：`apps/server/src/modules/users/routes.ts`（POST/PUT 用 `roles: Role[]`；`publicUser` 返回 `roles`）
- 修改测试适配（45 处 `role:` + 1 处 `update({role})`）：`auth-routes.test.ts`、`settings-routes.test.ts`、`job-repo.test.ts`、`e2e-smoke.test.ts`、`data-query.test.ts`、`job-routes.test.ts`、`job-service.test.ts`、`dashboards.test.ts`、`run-executor-failure.test.ts`、`run-routes.test.ts`、`connections.test.ts`、`workflow-repo.test.ts`、`schedule-routes.test.ts`、`run-service.test.ts`、`repo-users-sessions.test.ts`、`admin-users-routes.test.ts`、`schema-routes.test.ts`、`workflow-routes.test.ts`
- 新增用例：`apps/server/test/repo-users-sessions.test.ts`（`rolesOf` / `setRoles`）、`apps/server/test/admin-users-routes.test.ts`（多角色 / 非法 400）

**Interfaces**
```ts
// repo.ts
import type { Role } from './roles.js';
export type { Role } from './roles.js';          // 重新导出，减少 churn
export type UserStatus = 'active' | 'disabled';
export interface UserRow {
  id: string; username: string; password_hash: string;
  role: Role; status: UserStatus; created_at: number; updated_at: number;
}
export interface UsersRepo {
  findById(id: string): UserRow | undefined;
  findByUsername(username: string): UserRow | undefined;
  list(): UserRow[];
  rolesOf(userId: string): Role[];
  setRoles(userId: string, roles: Role[]): void;
  create(input: { username: string; passwordHash: string; roles: Role[] }): UserRow;
  update(id: string, patch: { roles?: Role[]; status?: UserStatus; passwordHash?: string }): UserRow | undefined;
  remove(id: string): void;
  count(): number;
}
```

**关键映射（测试适配原则）**
- 存量测试中非 admin 用户**统一** `role: 'user'` → `roles: ['workflow_author']`（该角色含 workflow/job/resources/connection.manage/connection.use，保证 Task 3-8 各阶段测试全绿）。
- **`dashboards.test.ts` 例外**：workflow_author 无 `dashboard.view/edit`，Task 3 阶段先改为 `roles: ['admin']` 使测试不因权限失败（Task 7 再整体重写语义）。
- `repo-users-sessions.test.ts:33` 的 `users.update(u.id, { role: 'admin', ... })` → `{ roles: ['admin'], ... }`，对应断言改 `expect(updated?.roles).toEqual(['admin'])`（`rolesOf(id)` 结果）。
- `admin-users-routes.test.ts:54` 的 payload `{role:'user'}` 必须改为 `roles: ['workflow_author']`，否则新校验先返 400 而非期望 409。
- `auth-routes.test.ts:32` 先改 `expect(res.json().role).toBe('workflow_author')`（镜像列语义先落地；Task 4 再改为 `.roles`）。
- `recorder.test.ts`、`schedule-repo.test.ts` 使用原生 SQL 显式写 `role` 列，不经 repo，**无需改动**。

**Steps**

- [ ] 写失败测试：在 `apps/server/test/repo-users-sessions.test.ts` 新增「多角色读写」用例——`create({ username:'zoe', passwordHash:'h', roles:['dashboard_author','dashboard_viewer'] })` 后 `expect(users.rolesOf(zoe.id).sort()).toEqual(['dashboard_author','dashboard_viewer'])`；调 `users.setRoles(zoe.id, ['admin'])` 后 `expect(users.rolesOf(zoe.id)).toEqual(['admin'])` 且 `expect(users.findById(zoe.id)?.role).toBe('admin')`（镜像列）。
- [ ] 在 `apps/server/test/admin-users-routes.test.ts` 新增：POST `roles:['workflow_author','dashboard_viewer']` → 201 且响应 `roles` 为该二值；POST `roles:[]` → 400；POST `roles:['bogus']` → 400；PUT `{roles:['dashboard_author']}` → 200 且 `rolesOf` 更新。
- [ ] 运行 `pnpm --filter @hustserver/server test -- repo-users-sessions admin-users-routes` 确认失败。
- [ ] 改 `apps/server/src/modules/users/repo.ts`：
  - 顶部 `import type { Role } from './roles.js'; export type { Role } from './roles.js';`，删除本地 `export type Role = 'admin' | 'user';`
  - prepared statements 增：`SELECT role FROM user_roles WHERE user_id = ?`（`rolesStmt`）、`INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)`（`insertRoleStmt`）、`DELETE FROM user_roles WHERE user_id = ?`（`deleteRolesStmt`）、`UPDATE users SET role = ? WHERE id = ?`（镜像，内联 `db.prepare` 或具名 `mirrorStmt`）。
  - 实现：

```ts
rolesOf(userId: string): Role[] {
  return (rolesStmt.all(userId) as { role: Role }[]).map((r) => r.role);
},
setRoles(userId: string, roles: Role[]): void {
  const tx = db.transaction(() => {
    deleteRolesStmt.run(userId);
    for (const role of roles) insertRoleStmt.run(userId, role);
    mirrorStmt.run(primaryRole(roles), userId);
  });
  tx();
},
```
  - `create({ username, passwordHash, roles })`：id = `nanoid(12)`，now = `Date.now()`，`db.transaction` 内 `insertUser.run(id, username, passwordHash, primaryRole(roles), 'active', now, now)` 后逐条 `insertRoleStmt.run(id, role)`。
  - `update(id, { roles, status, passwordHash })`：读现有 → 合并 → 若含 `roles` 调 `setRoles`（它会写镜像）→ 其余字段按原 UPDATE 写（注意避免镜像列被覆盖回旧值：UPDATE 语句保留 `role = ?`，值取 `roles ? primaryRole(roles) : existing.role`）。
- [ ] 改 `apps/server/src/bootstrap.ts`：`users.create({ username, passwordHash: await hashPassword(password), roles: ['admin'] })`。
- [ ] 改 `apps/server/src/modules/users/routes.ts`：
  - `import { isRole, type Role } from './roles.js';`（删本地 `isRole`）；**保留** `import type { UserRow, UsersRepo, UserStatus } from './repo.js';`（`UsersRepo` 等仍来自 repo）
  - `publicUser(u: UserRow, roles: Role[])` 返回 `{ id, username, roles, status, created_at, updated_at }`
  - 新增 `parseRoles(v: unknown): Role[] | null`（`Array.isArray` 且非空、每项 `isRole`、`Array.from(new Set(...))` 去重；否则 `null`）
  - POST：`const roles = parseRoles(body?.roles); if (!roles) 400 'roles 必须为非空且合法的角色数组';`
  - PUT：`if (body?.roles !== undefined) { const roles = parseRoles(body.roles); if (!roles) 400 ... }`
  - GET 列表：`rows.map(u => publicUser(u, deps.users.rolesOf(u.id)))`
  - `preHandler: [auth, requireAdmin]` 保持
- [ ] 批量适配 45 处 `role:` → `roles:`（见上方测试适配原则清单），`recorder.test.ts` / `schedule-repo.test.ts` 不动。
- [ ] 运行 `pnpm --filter @hustserver/server test` 确认全绿（既有 171 项 + 新增用例）。
- [ ] 运行 `pnpm --filter @hustserver/server build` 确认 `tsc` exit 0。
- [ ] Commit：`feat: 用户角色改为 user_roles 多角色存储`

---

## Task 4：能力守卫（原子任务）

**Files**
- 重写：`apps/server/src/plugins/guards.ts`
- 修改：`apps/server/src/modules/auth/routes.ts`（login/me 返回 `roles` + `capabilities`）
- 修改：`apps/server/src/modules/jobs/routes.ts`、`runs/routes.ts`、`schedules/routes.ts`（helper 签名 `role: Role` → `isAdmin: boolean`；删除 `Role` 导入）
- 修改：全部 44 处 `req.auth!.role`（见下「内联替换清单」）
- 新增：`apps/server/test/guards.test.ts`
- 修改：`apps/server/test/auth-routes.test.ts:32`

**Interfaces**
```ts
// guards.ts
export interface AuthContext {
  userId: string;
  username: string;
  roles: Role[];
  caps: Set<Capability>;
}
export function requireAuth(deps: { users: UsersRepo; sessions: SessionsRepo }): preHandler;
export function requireCap(cap: Capability): preHandler;        // 403 需要「<CAP_LABELS[cap]>」权限
export function requireAnyCap(...caps: Capability[]): preHandler; // 403 需要「A」或「B」权限
export const requireAdmin: preHandler;                          // = requireCap('admin')
```

**内联替换清单（`req.auth!.role === 'admin'` → `req.auth!.caps.has('admin')`）**
- `schema/routes.ts:89`；`schedules/routes.ts:59,69,109,157`；`data/routes.ts:30,46`；`runs/routes.ts:57,128,142,150,161,197`；`workflows/routes.ts:76,139`；`jobs/routes.ts:201,214,221,223,236,245,257,270`；`dashboards/routes.ts:40,42,45,58,86`；`connections/routes.ts:30,33,36,44,64`
- `auth/routes.ts:43` 改为返回结构（见 Files）
- helper 签名收敛：`jobs/routes.ts` L65-66 `canAccess(ownerId, role, userId)`、L74-85 `loadJob`、L88-93 `parseBody`；`runs/routes.ts` L42-43 `canAccess`、L46-51 `authorizeRun`；`schedules/routes.ts` L35-36 `canAccess`、L44-55 `loadWorkflow` —— 参数由 `role: Role` 改为 `isAdmin: boolean`，调用点传 `req.auth!.caps.has('admin')`。

**Steps**

- [ ] 写失败测试 `apps/server/test/guards.test.ts`：
  - 建库 + `buildServer`，seed 四用户：`admin`(`['admin']`)、`wf`(`['workflow_author']`)、`dashAuthor`(`['dashboard_author']`)、`viewer`(`['dashboard_viewer']`)。
  - `/api/auth/me` 对 viewer 返回 `{ id, username, roles: ['dashboard_viewer'], capabilities: ['dashboard.view'] }`；admin 的 `capabilities` 长度为 8。
  - 直接对该 server 已有的受保护端点断言 403 文案：以 viewer 身份 `PUT /api/workflows/:id`（需 `workflow`）应 403 `需要「工作流」权限`。
- [ ] 运行 `pnpm --filter @hustserver/server test -- guards` 确认失败。
- [ ] 重写 `apps/server/src/plugins/guards.ts`：

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionsRepo } from '../modules/auth/sessions.js';
import type { UsersRepo } from '../modules/users/repo.js';
import { capabilitiesOf, CAP_LABELS, type Capability, type Role } from '../modules/users/roles.js';

export interface AuthContext {
  userId: string;
  username: string;
  roles: Role[];
  caps: Set<Capability>;
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
    const roles = deps.users.rolesOf(user.id);
    req.auth = { userId: user.id, username: user.username, roles, caps: capabilitiesOf(roles) };
  };
}

export function requireCap(cap: Capability) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth?.caps.has(cap)) {
      await reply.code(403).send({ error: `需要「${CAP_LABELS[cap]}」权限` });
    }
  };
}

export function requireAnyCap(...caps: Capability[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!caps.some((cap) => req.auth?.caps.has(cap))) {
      await reply
        .code(403)
        .send({ error: `需要「${caps.map((c) => CAP_LABELS[c]).join('」或「')}」权限` });
    }
  };
}

export const requireAdmin = requireCap('admin');
```
- [ ] 改 `apps/server/src/modules/auth/routes.ts`：login 成功返回 `{ id, username, roles, capabilities: [...capabilitiesOf(roles)] }`（`roles = deps.users.rolesOf(user.id)`）；me 返回 `{ id: req.auth!.userId, username: req.auth!.username, roles: req.auth!.roles, capabilities: [...req.auth!.caps] }`。删 `Role` 相关无用导入。
- [ ] 改 `auth-routes.test.ts:32`：`expect(res.json().roles).toEqual(['workflow_author'])`（由 Task 3 的 `.role` 断言升级）。
- [ ] 按「内联替换清单」把全部 `req.auth!.role === 'admin'` 替换为 `req.auth!.caps.has('admin')`；jobs/runs/schedules 的 helper 签名改 `isAdmin: boolean` 并删除 `Role` 导入（同时删除各文件 `import type { Role, ... }` 中的 `Role`）。
- [ ] 运行 `pnpm --filter @hustserver/server test` 确认全绿。
- [ ] 运行 `pnpm --filter @hustserver/server build` 确认 exit 0。
- [ ] Commit：`feat: 引入能力守卫 requireCap 并替换内联管理员判断`

---

## Task 5：门禁落地 —— workflow 与 job 模块

**Files**
- 修改：`apps/server/src/modules/workflows/routes.ts`（12 处 `preHandler: auth` → `[auth, requireCap('workflow')]`）
- 修改：`apps/server/src/modules/jobs/routes.ts`（8 处 `preHandler: guard` → `[guard, requireCap('job')]`）
- 修改：`apps/server/src/modules/runs/routes.ts`（7 处 `preHandler: guard` → `[guard, requireCap('job')]`）
- 修改：`apps/server/src/modules/schedules/routes.ts`（4 处 `preHandler: guard` → `[guard, requireCap('job')]`）
- 新增：`apps/server/test/workflow-job-caps.test.ts`

**Steps**

- [ ] 写失败测试 `apps/server/test/workflow-job-caps.test.ts`：
  - seed `viewer`(`['dashboard_viewer']`)、`dashAuthor`(`['dashboard_author']`)、`wf`(`['workflow_author']`)。
  - `wf` 可 `POST /api/workflows` 201；`viewer` / `dashAuthor` 调 `GET /api/workflows` 与 `POST /api/workflows` 均 403 `需要「工作流」权限`。
  - `wf` 可 `GET /api/jobs` 200；`viewer` 调 `GET /api/jobs`、`GET /api/runs/cache/x`、`GET /api/schedules` 均 403 `需要「Job 编排」权限`。
- [ ] 运行 `pnpm --filter @hustserver/server test -- workflow-job-caps` 确认失败。
- [ ] 改 `workflows/routes.ts`：`import { requireAuth, requireCap } from '../../plugins/guards.js';`，12 处 `preHandler: auth` → `preHandler: [auth, requireCap('workflow')]`（L92/112/138/143/155/190/197/207/227/247/265/303）。
- [ ] 改 `jobs/routes.ts`：8 处 `preHandler: guard` → `[guard, requireCap('job')]`（L185/200/212/219/234/243/255/265）。
- [ ] 改 `runs/routes.ts`：7 处 `preHandler: guard` → `[guard, requireCap('job')]`（L53/119/124/140/148/159/195）。
- [ ] 改 `schedules/routes.ts`：4 处 `preHandler: guard` → `[guard, requireCap('job')]`（L57/67/104/152）。
- [ ] 运行 `pnpm --filter @hustserver/server test` 确认全绿。
- [ ] Commit：`feat: 工作流与 Job 模块启用能力门禁`

---

## Task 6：门禁落地 —— connections 管理/使用拆分

**Files**
- 修改：`apps/server/src/modules/connections/routes.ts`
- 新增：`apps/server/test/connection-caps.test.ts`

**门禁映射**
- `GET /api/connections`（L35）、`GET /api/connections/:id/objects`（L107）→ `requireCap('connection.use')`
- `POST /api/connections`（L40）、`PUT /api/connections/:id`（L55）、`DELETE /api/connections/:id`（L69）、`POST /api/connections/test`（L79）、`POST /api/connections/:id/test`（L94）→ `requireCap('connection.manage')`
- 归属判定（`canManage` L29-30 / `canUse` L32-33）：`req.auth!.role === 'admin'` → `req.auth!.caps.has('admin')`

**Steps**

- [ ] 写失败测试 `apps/server/test/connection-caps.test.ts`：
  - seed `viewer`(`['dashboard_viewer']`)、`dashAuthor`(`['dashboard_author']`)、`wf`(`['workflow_author']`)。
  - `dashAuthor` 可 `GET /api/connections` 200（有 `connection.use`），但 `POST /api/connections` 403 `需要「连接管理」权限`。
  - `viewer` 调 `GET /api/connections` 403 `需要「连接使用」权限`。
  - `wf` 调 `POST /api/connections` 201。
- [ ] 运行 `pnpm --filter @hustserver/server test -- connection-caps` 确认失败。
- [ ] 改 `connections/routes.ts`：按上表为 7 个端点加对应 `requireCap`，并把两处内联 admin 判定改为 `caps.has('admin')`（Task 4 已替换 L30/33/36/44/64，此处确认一致并补 `preHandler`）。
- [ ] 运行 `pnpm --filter @hustserver/server test` 确认全绿。
- [ ] Commit：`feat: 连接模块拆分为管理与使用能力门禁`

---

## Task 7：门禁落地 —— dashboards 查看/编辑分离

**Files**
- 修改：`apps/server/src/modules/dashboards/routes.ts`
- 重写：`apps/server/test/dashboards.test.ts`

**行为变更**
- `GET /api/dashboards` → `requireCap('dashboard.view')`，**列表统一 `repo.listAll()`（全部可见），删除按 owner 分流**。
- `GET /api/dashboards/:id` → `requireCap('dashboard.view')`，**删除 `canView` 过滤**（任何持 `dashboard.view` 的用户可查看任意仪表板）。
- `POST /api/dashboards`、`PUT /:id`、`DELETE /:id` → `requireCap('dashboard.edit')` + `canEdit`：
  - `canEdit(req, row) = req.auth!.caps.has('admin') || row.owner_id === req.auth!.userId || row.shared === 1`
  - `shared` 字段仅管理员可置（`caps.has('admin')`）
- 403 文案由守卫产出；`canEdit` 失败时 `403 '无权编辑该仪表板'`。

**Steps**

- [ ] 重写 `apps/server/test/dashboards.test.ts`（TDD 目标语义）：
  - seed：`admin`(`['admin']`)、`alice`(`['dashboard_author']`)、`carol`(`['dashboard_author']`)、`bob`(`['dashboard_viewer']`)。
  - 创建（201）与 GET payload 校验（沿用原 `okPayload`）。
  - 缺名称/非对象 400、8MB 413 `payload_too_large`。
  - **查看全部可见**：alice 创建自有 + admin 创建 shared → `bob`（viewer）`GET /api/dashboards` 可见全部；`bob` `GET /api/dashboards/:id`（他人未共享）200（viewer 可看任意）。
  - **编辑限制**：`bob` `POST/PUT/DELETE` → 403（无 `dashboard.edit`）；`alice` 编辑自有 200、编辑 carol 未共享的 → 403 `无权编辑该仪表板`；`carol` 把 shared 置真被拒（非 admin，`shared` 仍为 0）；admin 置 shared 后，`alice` 编辑 carol 的该仪表板 200。
- [ ] 运行 `pnpm --filter @hustserver/server test -- dashboards` 确认失败。
- [ ] 改 `dashboards/routes.ts`：加 `requireCap('dashboard.view')`（GET 两处）与 `requireCap('dashboard.edit')`（POST/PUT/DELETE）；列表改 `repo.listAll()`；移除 `canView`；`canManage` 重命名为 `canEdit` 并按上式实现；`shared` 判定用 `caps.has('admin')`。
- [ ] 运行 `pnpm --filter @hustserver/server test` 确认全绿。
- [ ] Commit：`feat: 仪表板拆分为查看与编辑能力门禁`

---

## Task 8：门禁落地 —— resources / schema / data

**Files**
- 修改：`apps/server/src/modules/resources/routes.ts`（读 5 处、写 7 处）
- 修改：`apps/server/src/modules/schema/routes.ts`（csv/excel → `resources`；sqlserver → `connection.use`）
- 修改：`apps/server/src/modules/data/routes.ts`（2 处 → `connection.use`）
- 新增：`apps/server/test/resource-schema-data-caps.test.ts`

**门禁映射**
- resources 读（L64 `GET /api/resources`、L81 `/tree`、L102 `/sheets`、L117 `/folders/tree`、L268 `/files/download`）→ `requireAnyCap('resources','dashboard.edit')`
- resources 写（L132 `POST /move`、L158 `POST /folders`、L173 `PATCH /folders`、L193 `DELETE /folders`、L208 `POST /files`、L233 `PATCH /files`、L254 `DELETE /files`）→ `requireCap('resources')`
- schema：L47 `POST /api/schema/csv`、L63 `/excel` → `requireCap('resources')`；L77 `POST /api/schema/sqlserver` → `requireCap('connection.use')`
- data：L24 `POST /api/data/query`、L41 `POST /api/data/tables` → `requireCap('connection.use')`（内联 `canUse` 用 `caps.has('admin')`）

**Steps**

- [ ] 写失败测试 `apps/server/test/resource-schema-data-caps.test.ts`：
  - seed `viewer`(`['dashboard_viewer']`)、`dashAuthor`(`['dashboard_author']`)、`wf`(`['workflow_author']`)。
  - resources 读：`wf` 与 `dashAuthor` 调 `GET /api/resources` 200；`viewer` 403 `需要「资源管理」或「仪表板编辑」权限`。
  - resources 写：`dashAuthor` 调 `POST /api/resources/folders` 403 `需要「资源管理」权限`；`wf` 200/201。
  - schema：`dashAuthor` 调 `POST /api/schema/sqlserver`（空 body 也应先过守卫）200/400 而非 403；`viewer` 调 `POST /api/schema/csv` 403。
  - data：`dashAuthor` 调 `POST /api/data/query` 非 403；`viewer` 调 `POST /api/data/query` 403 `需要「连接使用」权限`。
- [ ] 运行 `pnpm --filter @hustserver/server test -- resource-schema-data-caps` 确认失败。
- [ ] 按映射改三个文件（读用 `requireAnyCap`、写用 `requireCap`；导入相应守卫；内联 `canUse` 改 `caps.has('admin')`）。
- [ ] 运行 `pnpm --filter @hustserver/server test` 确认全绿。
- [ ] Commit：`feat: 资源库/schema/data 启用能力门禁`

---

## Task 9：前端角色基础（API 类型 + 守卫 + 导航 + 路由）

**Files**
- 修改：`apps/web/src/api.ts`（`SessionUser` 改 `{ id, username, roles, capabilities }`）
- 新增：`apps/web/src/roles.ts`（镜像 `Role` / `Capability` / `ROLES` / `ROLE_LABELS` / `CAP_LABELS` / `isRole`）
- 修改：`apps/web/src/auth.tsx`（`hasCap` / `hasRole` / `RequireCap`）
- 修改：`apps/web/src/components/Layout.tsx`（导航按能力；右上角多角色标签）
- 修改：`apps/web/src/App.tsx`（`RequireCap` 包裹各路由）
- 修改：`apps/web/test/api.test.ts`（断言 `{ id:'u1', roles:['admin'], capabilities:[...] }`）

**Interfaces**
```ts
// apps/web/src/api.ts
export interface SessionUser {
  id: string;
  username: string;
  roles: Role[];
  capabilities: Capability[];
}
// apps/web/src/auth.tsx
interface AuthContextValue {
  user: SessionUser | null; loading: boolean;
  login(u: string, p: string): Promise<void>; logout(): Promise<void>; refresh(): Promise<void>;
  hasCap(cap: Capability): boolean;
  hasRole(role: Role): boolean;
}
export function RequireCap(props: { cap: Capability; children: ReactNode }): JSX.Element;
```

**路由 → 能力映射（App.tsx）**
- `/workflows`、`/workflows/new`、`/workflows/:id`、`/workflows/:id/connections`、`/workflows/:id/designer` → `workflow`
- `/jobs`、`/jobs/new`、`/jobs/:id`、`/job-runs/:id`、`/runs/:id` → `job`
- `/connections` → `connection.manage`
- `/resources` → `resources`
- `/dashboards` → `dashboard.view`
- `/dashboards/:id` → `dashboard.view`（**Spec 修正 1**）
- `/users`、`/settings` → `admin`

**Steps**

- [ ] 改 `apps/web/test/api.test.ts`：mock 响应与断言改为含 `roles` / `capabilities` 的形状。
- [ ] 新增 `apps/web/src/roles.ts`（把 server 的 `roles.ts` 常量与类型原样复制；`capabilitiesOf`/`primaryRole` 前端不需要，可省略）。
- [ ] 改 `apps/web/src/api.ts` 的 `SessionUser`（`import type { Role, Capability } from './roles.js';`）。
- [ ] 改 `apps/web/src/auth.tsx`：`value` 增加 `hasCap: (cap) => !!user?.capabilities.includes(cap)`、`hasRole: (role) => !!user?.roles.includes(role)`；新增 `RequireCap`（`loading` → 加载中占位；缺能力 → `<div className="p-6 text-slate-500">无权访问。</div>`）。注意 `useMemo` 依赖数组同步更新。
- [ ] 改 `apps/web/src/components/Layout.tsx`：
  - 导航项按能力渲染：工作流（`workflow`）、仪表板（`dashboard.view`）、资源管理（`resources`）、连接（`connection.manage`）、Job 编排（`job`）、用户 / 设置（`admin`）。
  - 右上角 `{user && ROLE_LABELS 拼接}`：`user.roles.map((r) => ROLE_LABELS[r]).join('、')`（用 `useMemo` 或直接表达式，避免在 JSX 内直接 `.map().join()` 传入 `browser_evaluate` 场景——此处为源码，正常写即可）。
- [ ] 改 `apps/web/src/App.tsx`：用 `<RequireAuth>` 外层 + `<RequireCap cap="...">` 包裹上表各路由（`/login`、`/` 保持）。
- [ ] 运行 `pnpm --filter @hustserver/web build` 确认 exit 0。
- [ ] 运行 `pnpm --filter @hustserver/web test`（若配置）或 `pnpm test --filter web` 确认 api 测试通过。
- [ ] Commit：`feat: 前端引入能力类型与 RequireCap 路由守卫`

---

## Task 10：前端页面按能力改造

**Files**
- 修改：`apps/web/src/pages/UsersPage.tsx`（角色改多选复选框）
- 修改：`apps/web/src/pages/ConnectionsPage.tsx`（`isAdmin` → `hasCap('connection.manage')`）
- 修改：`apps/web/src/features/dashboard/DashboardListPage.tsx`（共享按钮 `hasCap('admin')`）
- 修改：`apps/web/src/pages/SettingsPage.tsx`（门槛 `hasCap('admin')`）
- 修改：`apps/web/src/features/dashboard/DashboardEditorPage.tsx`（保存按钮按 `hasCap('dashboard.edit')` 门控，**Spec 修正 1**）

**Steps**

- [ ] 改 `UsersPage.tsx`：
  - `UserDto.role` → `roles: Role[]`；本地 `role` state → `roles: Role[]` state。
  - 表格「角色」列渲染 `ROLE_LABELS` 拼接；表单用四角色复选框（`ROLES.map`）。
  - 提交 `api.post('/api/admin/users', { body: { username, password, roles } })`；`roles` 为空时前端拦截提示「至少选择一个角色」。
  - 页面门槛 `user?.role === 'admin'` → `hasCap('admin')`。
- [ ] 改 `ConnectionsPage.tsx`：`const { user, hasCap } = useAuth(); const canManage = hasCap('connection.manage');`，共享勾选框条件用 `canManage`。
- [ ] 改 `DashboardListPage.tsx`：共享按钮 `hasCap('admin')`；`const { hasCap } = useAuth();`。
- [ ] 改 `SettingsPage.tsx`：`const { hasCap } = useAuth();`；两处 `user?.role === 'admin'` → `hasCap('admin')`。
- [ ] 改 `DashboardEditorPage.tsx`：`const { hasCap } = useAuth(); const canEdit = hasCap('dashboard.edit');`，保存按钮 `disabled={saving || !canEdit}`，无能力时不渲染保存/自动保存提示（只读查看）。
- [ ] 运行 `pnpm --filter @hustserver/web build` 确认 exit 0。
- [ ] Commit：`feat: 前端页面按能力渲染用户/连接/仪表板/设置`

---

## Task 11：端到端验证

**Files**
- 无源码改动（仅验证；如需修复则回到相应任务补丁）

**Steps**

- [ ] `pnpm --filter @hustserver/server test` 全绿（既有 171 项不回归 + 新增用例）。
- [ ] `pnpm --filter @hustserver/server build` exit 0。
- [ ] `pnpm --filter @hustserver/web build` exit 0。
- [ ] 重启后端（`pnpm --filter @hustserver/server dev`，环境变量沿用：`SESSION_SECRET=please-change-me`、`ENCRYPTION_KEY` 64 位 hex、`HUSTSERVER_PORT=8787`、`BOOTSTRAP_ADMIN_USER=admin`、`BOOTSTRAP_ADMIN_PASSWORD=admin1234`、`ICUBE_ENABLE_DATABASE_BACKUP=0`）与前端（vite dev，代理 `/api` → `127.0.0.1:8787`）。
- [ ] 浏览器端到端（四角色各一账号 + 一个多角色账号 + 老数据）：
  - 管理员：可见全部导航，可进用户/设置，可管理连接、创建仪表板。
  - 工作流作者：可见工作流 / 资源管理 / 连接 / Job 编排；不可见用户 / 设置；仪表板页可查看。
  - 仪表板作者：可见仪表板；**可查看任意仪表板**；仅可编辑自有或被共享的（保存按钮可用态符合预期）；不可见资源管理 / 连接管理 / Job 编排。
  - 仪表板用户：**仅**可见仪表板并只读；无保存入口；其余导航全部隐藏；直接访问受保护 URL 显示「无权访问。」。
  - 多角色账号（如 `['workflow_author','dashboard_viewer']`）：导航与能力并集正确。
  - 老数据：迁移后原 `user` 用户自动成为工作流作者并可通过 `rolesOf` 读到 `['workflow_author']`。
- [ ] 如全部通过，Commit（若上一步有修复）：`chore: 角色权限端到端验证通过`
```
