import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { auditRepo, type AuditAction, type AuditRepo, type AuditResource } from '../src/modules/audit/repo.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { encryptConfig } from '../src/modules/connections/crypto.js';
import { connectionsRepo } from '../src/modules/connections/repo.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { buildServer } from '../src/server.js';

const cfg = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  HUSTSERVER_DATA_DIR: '/tmp/hustserver-test',
});

interface AuditItem {
  id: string;
  username: string;
  action: AuditAction;
  resource: AuditResource;
  resource_name: string | null;
  description: string;
  created_at: number;
}

interface AuditBody {
  total: number;
  limit: number;
  offset: number;
  items: AuditItem[];
}

let app: FastifyInstance;
let db: Database.Database;
let audit: AuditRepo;
let adminCookie: string;
let authorCookie: string;
let adminId: string;

/** 登录并返回会话 cookie */
async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

/** 请求审计接口；cookie 为 null 表示未登录 */
function auditRequest(query = '', cookie: string | null = adminCookie) {
  return app.inject({
    method: 'GET',
    url: `/api/admin/audit-logs${query}`,
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  const users = usersRepo(db);
  const admin = await users.create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  adminId = admin.id;
  await users.create({ username: 'author', passwordHash: await hashPassword('author123'), roles: ['workflow_author'] });
  audit = auditRepo(db);
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  authorCookie = await login('author', 'author123');
  // 登录本身也会写入审计记录（见「登录事件合并」），清空以保证各用例的断言基线为 0
  db.prepare('DELETE FROM audit_logs').run();
});

afterEach(async () => {
  await app.close();
});

describe('审计记录字段与查询', () => {
  it('record 写入后接口返回完整字段，username 由 userId 反查得到', async () => {
    audit.record({
      userId: adminId,
      action: 'create',
      resource: 'workflow',
      resourceName: '季度报表',
      description: '创建了工作流「季度报表」',
    });

    const res = await auditRequest();
    expect(res.statusCode).toBe(200);
    const body = res.json() as AuditBody;
    expect(body.total).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    expect(body.items).toHaveLength(1);

    const item = body.items[0];
    expect(typeof item.id).toBe('string');
    expect(item.id.length).toBeGreaterThan(0);
    expect(item.username).toBe('admin');
    expect(item.action).toBe('create');
    expect(item.resource).toBe('workflow');
    expect(item.resource_name).toBe('季度报表');
    expect(item.description).toBe('创建了工作流「季度报表」');
    expect(typeof item.created_at).toBe('number');
    // 响应不暴露内部 user_id
    expect(item).not.toHaveProperty('user_id');
  });

  it('用户被删除后仍返回冗余存储的原用户名', async () => {
    const users = usersRepo(db);
    const temp = await users.create({ username: 'temp1', passwordHash: 'x', roles: ['workflow_author'] });
    audit.record({
      userId: temp.id,
      action: 'update',
      resource: 'model',
      resourceName: 'sales_model',
      description: '修改了模型「sales_model」',
    });
    expect(users.remove(temp.id)).toBe(true);

    const body = (await auditRequest()).json() as AuditBody;
    expect(body.items[0].username).toBe('temp1');
    expect(body.items[0].username).not.toBe('未知用户');
  });

  it('userId 为 null 时 username 记为「未知用户」', async () => {
    audit.record({ userId: null, action: 'other', resource: 'resource', description: '匿名操作' });

    const body = (await auditRequest()).json() as AuditBody;
    expect(body.total).toBe(1);
    expect(body.items[0].username).toBe('未知用户');
  });

  it('userId 不存在时记「未知用户」且不抛错（user_id 写 NULL）', async () => {
    expect(() =>
      audit.record({ userId: 'no-such-user', action: 'other', resource: 'resource', description: '幽灵操作' }),
    ).not.toThrow();

    const body = (await auditRequest()).json() as AuditBody;
    expect(body.total).toBe(1);
    expect(body.items[0].username).toBe('未知用户');
  });
});

describe('排序 / 筛选 / 分页', () => {
  it('按创建时间倒序（created_at 相同则 rowid 兜底），最新在前', async () => {
    audit.record({ userId: adminId, action: 'create', resource: 'job', description: '第一条' });
    audit.record({ userId: adminId, action: 'create', resource: 'job', description: '第二条' });

    const body = (await auditRequest()).json() as AuditBody;
    expect(body.items.map((i) => i.description)).toEqual(['第二条', '第一条']);
  });

  it('按 action 筛选、按 resource 筛选、两者组合，均返回正确 total', async () => {
    audit.record({ userId: adminId, action: 'create', resource: 'workflow', description: 'wf-create' });
    audit.record({ userId: adminId, action: 'update', resource: 'workflow', description: 'wf-update' });
    audit.record({ userId: adminId, action: 'create', resource: 'connection', description: 'conn-create' });
    audit.record({ userId: adminId, action: 'delete', resource: 'job', description: 'job-delete' });
    audit.record({ userId: adminId, action: 'other', resource: 'model', description: 'model-other' });

    const byAction = (await auditRequest('?action=create')).json() as AuditBody;
    expect(byAction.total).toBe(2);
    expect(byAction.items.every((i) => i.action === 'create')).toBe(true);

    const byResource = (await auditRequest('?resource=workflow')).json() as AuditBody;
    expect(byResource.total).toBe(2);
    expect(byResource.items.every((i) => i.resource === 'workflow')).toBe(true);

    const both = (await auditRequest('?action=create&resource=workflow')).json() as AuditBody;
    expect(both.total).toBe(1);
    expect(both.items[0].description).toBe('wf-create');

    const combo2 = (await auditRequest('?action=delete&resource=job')).json() as AuditBody;
    expect(combo2.total).toBe(1);
    expect(combo2.items[0].description).toBe('job-delete');

    // 空字符串视为未提供
    const empty = (await auditRequest('?action=&resource=')).json() as AuditBody;
    expect(empty.total).toBe(5);
  });

  it('分页：limit/offset 生效，offset 超界时 items 为空但 total 不变', async () => {
    for (let i = 1; i <= 5; i += 1) {
      audit.record({ userId: adminId, action: 'create', resource: 'job', description: `第${i}条` });
    }

    const page1 = (await auditRequest('?limit=2&offset=0')).json() as AuditBody;
    expect(page1.total).toBe(5);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    expect(page1.items).toHaveLength(2);

    const page2 = (await auditRequest('?limit=2&offset=2')).json() as AuditBody;
    expect(page2.total).toBe(5);
    expect(page2.items).toHaveLength(2);

    const page3 = (await auditRequest('?offset=4')).json() as AuditBody;
    expect(page3.total).toBe(5);
    expect(page3.items).toHaveLength(1);
    expect(page3.items[0].description).toBe('第1条');

    const beyond = (await auditRequest('?offset=10')).json() as AuditBody;
    expect(beyond.total).toBe(5);
    expect(beyond.items).toHaveLength(0);

    // 三页拼接无重叠
    const ids = [...page1.items, ...page2.items, ...page3.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('非法参数返回 400', async () => {
    for (const q of [
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      '?offset=-1',
      '?offset=abc',
      '?action=foo',
      '?resource=foo',
    ]) {
      const res = await auditRequest(q);
      expect(res.statusCode, `期望 ${q} 返回 400`).toBe(400);
    }
  });
});

describe('权限', () => {
  it('非管理员 403，未登录 401', async () => {
    const forbidden = await auditRequest('', authorCookie);
    expect(forbidden.statusCode).toBe(403);

    const anonymous = await auditRequest('', null);
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('端到端埋点', () => {
  /** 直接在库中造一条可用连接，避免额外审计噪声 */
  function seedConnection(): string {
    return connectionsRepo(db).create({
      ownerId: adminId,
      name: '审计测试连接',
      type: 'sqlserver',
      configEncrypted: encryptConfig({ server: '127.0.0.1', database: 'd' }, cfg.encryptionKey),
      shared: false,
    }).id;
  }

  it('创建 Job 产生 create/job 记录', async () => {
    const connectionId = seedConnection();
    const res = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { cookie: adminCookie },
      payload: {
        name: '每日对账',
        description: 'd',
        steps: [{ type: 'sql', name: 's1', connectionId, sql: 'SELECT 1', onFailure: 'abort' }],
      },
    });
    expect(res.statusCode).toBe(201);

    const body = (await auditRequest('?action=create&resource=job')).json() as AuditBody;
    expect(body.total).toBe(1);
    expect(body.items[0].username).toBe('admin');
    expect(body.items[0].resource_name).toBe('每日对账');
    expect(body.items[0].description).toBe('创建了 Job「每日对账」');
  });

  it('创建用户产生 create/user 记录，删除 Job 产生 delete/job 记录', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { username: 'newbie', password: 'newbie123', roles: ['workflow_author'] },
    });
    expect(created.statusCode).toBe(201);

    const afterCreate = (await auditRequest('?action=create&resource=user')).json() as AuditBody;
    expect(afterCreate.total).toBe(1);
    expect(afterCreate.items[0].resource_name).toBe('newbie');
    expect(afterCreate.items[0].description).toBe('创建了用户「newbie」');

    // 用 admin 造一个 Job 再删除
    const connectionId = seedConnection();
    const job = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { cookie: adminCookie },
      payload: {
        name: '待删除Job',
        steps: [{ type: 'sql', name: 's1', connectionId, sql: 'SELECT 1', onFailure: 'abort' }],
      },
    });
    const jobId = (job.json() as { id: string }).id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/jobs/${jobId}`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(200);

    const afterDelete = (await auditRequest('?action=delete&resource=job')).json() as AuditBody;
    expect(afterDelete.total).toBe(1);
    expect(afterDelete.items[0].resource_name).toBe('待删除Job');
    expect(afterDelete.items[0].description).toBe('删除了 Job「待删除Job」');
  });

  it('失败的操作不产生审计记录', async () => {
    // 先创建一次用户
    await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { username: 'dupuser', password: 'dupuser123', roles: ['workflow_author'] },
    });
    const before = (await auditRequest()).json() as AuditBody;

    // 重复用户名 → 409，不应新增记录
    const dup = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
      payload: { username: 'dupuser', password: 'dupuser123', roles: ['workflow_author'] },
    });
    expect(dup.statusCode).toBe(409);

    // 非法 Job（空 steps）→ 400，不应新增记录
    const badJob = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: { cookie: adminCookie },
      payload: { name: '坏Job', steps: [] },
    });
    expect(badJob.statusCode).toBe(400);

    const after = (await auditRequest()).json() as AuditBody;
    expect(after.total).toBe(before.total);
  });
});

describe('登录事件合并到审计列表', () => {
  it('登录成功写入 action=login、resource=auth 的记录，描述含来源 IP', async () => {
    await login('admin', 'admin123');

    const body = (await auditRequest()).json() as AuditBody;
    expect(body.total).toBe(1);
    const item = body.items[0];
    expect(item.action).toBe('login');
    expect(item.resource).toBe('auth');
    expect(item.username).toBe('admin');
    expect(item.resource_name).toBe('admin');
    expect(item.description).toMatch(/^登录成功（.+）$/);
  });

  it('密码错误写入 login_failed，描述含失败原因', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-pass' },
    });

    const body = (await auditRequest('?action=login_failed')).json() as AuditBody;
    expect(body.total).toBe(1);
    expect(body.items[0].resource).toBe('auth');
    expect(body.items[0].resource_name).toBe('admin');
    expect(body.items[0].description).toContain('登录失败（密码错误）');
  });

  it('用户名不存在时显示输入的用户名，而非「未知用户」', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost', password: 'whatever' },
    });

    const body = (await auditRequest()).json() as AuditBody;
    expect(body.total).toBe(1);
    expect(body.items[0].action).toBe('login_failed');
    expect(body.items[0].username).toBe('ghost');
    expect(body.items[0].resource_name).toBe('ghost');
    expect(body.items[0].description).toContain('登录失败（用户不存在）');
  });

  it('账号被禁用时记为登录失败并标注原因', async () => {
    const users = usersRepo(db);
    const frozen = await users.create({
      username: 'frozen',
      passwordHash: await hashPassword('frozen123'),
      roles: ['workflow_author'],
    });
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', frozen.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'frozen', password: 'frozen123' },
    });
    expect(res.statusCode).toBe(401);

    const body = (await auditRequest()).json() as AuditBody;
    expect(body.items[0].action).toBe('login_failed');
    expect(body.items[0].description).toContain('登录失败（账号已禁用）');
  });

  it('可按 action 与 resource=auth 筛选登录事件', async () => {
    await login('admin', 'admin123'); // 成功 1 条
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-pass' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ghost', password: 'whatever' },
    });

    const all = (await auditRequest('?resource=auth')).json() as AuditBody;
    expect(all.total).toBe(3);

    const ok = (await auditRequest('?action=login')).json() as AuditBody;
    expect(ok.total).toBe(1);
    expect(ok.items[0].action).toBe('login');

    const failed = (await auditRequest('?action=login_failed&resource=auth')).json() as AuditBody;
    expect(failed.total).toBe(2);
    expect(failed.items.every((i) => i.action === 'login_failed')).toBe(true);

    // 登录事件不会被其它资源筛选带出
    const workflows = (await auditRequest('?resource=workflow')).json() as AuditBody;
    expect(workflows.total).toBe(0);
  });
});
