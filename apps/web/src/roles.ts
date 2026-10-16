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

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}
