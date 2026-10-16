import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { decryptConfig } from '../src/modules/connections/crypto.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';
import { workflowConnectionsRepo } from '../src/modules/workflows/repo.js';

const dataDir = mkdtempSync(join(tmpdir(), 'hs-wf-'));
const cfg = loadConfig({ SESSION_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'a'.repeat(64), HUSTSERVER_DATA_DIR: dataDir });

let app: FastifyInstance;
let db: Database.Database;
let aliceCookie: string;
let bobCookie: string;
let adminCookie: string;

async function login(u: string, p: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } });
  return res.headers['set-cookie']!.toString().split(';')[0];
}

function multipart(file: { filename: string; content: string }, fields: Record<string, string> = {}) {
  const boundary = '----hstest' + Math.random().toString(16).slice(2);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/json\r\n\r\n${file.content}\r\n--${boundary}--\r\n`);
  return { payload: Buffer.from(parts.join(''), 'utf8'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const sampleJson = JSON.stringify({
  id: 'w', name: '样例', createdAt: 0, updatedAt: 0,
  nodes: [
    { id: 'n1', kind: 'inputCsv', name: '读', position: { x: 0, y: 0 }, config: { path: '/me/a.csv' } },
    { id: 'n3', kind: 'outputCsv', name: '写', position: { x: 200, y: 0 }, config: { path: '/me/out.csv' } },
  ],
  edges: [{ id: 'e1', source: 'n1', target: 'n3' }],
});

const sqlJson = JSON.stringify({
  id: 'w', name: 'sql', createdAt: 0, updatedAt: 0,
  nodes: [
    { id: 's1', kind: 'inputSqlServer', name: '读库', position: { x: 0, y: 0 }, config: { connection: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' }, query: 'select 1' } },
    { id: 's2', kind: 'outputSqlServer', name: '写库', position: { x: 200, y: 0 }, config: { connection: { server: 'db2', port: 1433, database: 'd2', user: 'sa', password: 'secret2' } } },
  ],
  edges: [],
});

const sqlWithN5Json = JSON.stringify({
  id: 'w', name: 'sql', createdAt: 0, updatedAt: 0,
  nodes: [
    { id: 's1', kind: 'inputSqlServer', name: '读库', position: { x: 0, y: 0 }, config: { connection: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' }, query: 'select 1' } },
    { id: 's2', kind: 'outputSqlServer', name: '写库', position: { x: 200, y: 0 }, config: { connection: { server: 'db2', port: 1433, database: 'd2', user: 'sa', password: 'secret2' } } },
    { id: 'n5', kind: 'inputSqlServer', name: '待删库', position: { x: 400, y: 0 }, config: { connection: { server: 'db5', port: 1433, database: 'd5', user: 'sa', password: 'secret5' }, query: 'select 1' } },
  ],
  edges: [],
});

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), roles: ['admin'] });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), roles: ['workflow_author'] });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), roles: ['workflow_author'] });
  app = await buildServer({ db, config: cfg, logger: false });
  await app.ready();
  adminCookie = await login('admin', 'admin123');
  aliceCookie = await login('alice', 'alice123');
  bobCookie = await login('bob', 'bob12345');
});

async function createWorkflow(cookie: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/workflows', headers: { cookie },
    payload: { workflow: JSON.parse(sampleJson), mappings: [
      { node_id: 'n1', direction: 'input', original_ref: '/me/a.csv', target_type: 'uploaded_file', target_ref: null },
      { node_id: 'n3', direction: 'output', original_ref: '/me/out.csv', target_type: 'output_dir', target_ref: null },
    ] },
  });
  return res.json().id;
}

describe('workflow routes', () => {
  it('上传解析返回输入/输出引用', async () => {
    const mp = multipart({ filename: 'wf.json', content: sampleJson });
    const res = await app.inject({ method: 'POST', url: '/api/workflows/upload', headers: { ...mp.headers, cookie: aliceCookie }, payload: mp.payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().inputs).toHaveLength(1);
    expect(res.json().outputs).toHaveLength(1);
  });

  it('上传非法 JSON 返回 400', async () => {
    const mp = multipart({ filename: 'bad.json', content: '{oops' });
    const res = await app.inject({ method: 'POST', url: '/api/workflows/upload', headers: { ...mp.headers, cookie: aliceCookie }, payload: mp.payload });
    expect(res.statusCode).toBe(400);
  });

  it('创建后可列表；普通用户互不可见，管理员可见全部', async () => {
    await createWorkflow(aliceCookie);
    await createWorkflow(bobCookie);
    const a = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie: aliceCookie } });
    expect(a.json()).toHaveLength(1);
    const admin = await app.inject({ method: 'GET', url: '/api/workflows', headers: { cookie: adminCookie } });
    expect(admin.json()).toHaveLength(2);
  });

  it('越权访问详情返回 403，管理员可访问', async () => {
    const id = await createWorkflow(aliceCookie);
    const forbidden = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: bobCookie } });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: adminCookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('保存的 payload 已剥离明文连接', async () => {
    const withConn = JSON.stringify({
      id: 'w', name: 'sql', createdAt: 0, updatedAt: 0,
      nodes: [{ id: 's1', kind: 'inputSqlServer', name: '库', position: { x: 0, y: 0 }, config: { connection: { server: 'db', port: 1433, database: 'd', user: 'sa', password: 'secret' }, query: 'select 1' } }],
      edges: [],
    });
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(withConn) } });
    const id = created.json().id;
    const detail = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    expect(JSON.stringify(detail.json())).not.toContain('secret');
  });

  it('上传数据文件并绑定节点，写入映射', async () => {
    const id = await createWorkflow(aliceCookie);
    const mp = multipart({ filename: 'a.csv', content: 'a,b\n1,2\n' }, { nodeId: 'n1' });
    const up = await app.inject({ method: 'POST', url: `/api/workflows/${id}/files`, headers: { ...mp.headers, cookie: aliceCookie }, payload: mp.payload });
    expect(up.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: `/api/workflows/${id}/files`, headers: { cookie: aliceCookie } });
    expect(list.json()).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    const inputMap = (detail.json().mappings as Array<{ node_id: string; target_type: string; target_ref: string }>).find((m) => m.node_id === 'n1');
    expect(inputMap?.target_type).toBe('uploaded_file');
    expect(inputMap?.target_ref).toBe(up.json().stored_name);
  });

  it('更新映射与删除工作流', async () => {
    const id = await createWorkflow(aliceCookie);
    const put = await app.inject({ method: 'PUT', url: `/api/workflows/${id}/mappings`, headers: { cookie: aliceCookie }, payload: { mappings: [
      { node_id: 'n1', direction: 'input', original_ref: '/me/a.csv', target_type: 'server_path', target_ref: 'shared/a.csv' },
    ] } });
    expect(put.statusCode).toBe(200);
    const del = await app.inject({ method: 'DELETE', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    expect(gone.statusCode).toBe(404);
  });

  it('上传响应保留内嵌连接（供前端回传创建）', async () => {
    const mp = multipart({ filename: 'wf.htyx', content: sqlJson });
    const res = await app.inject({ method: 'POST', url: '/api/workflows/upload', headers: { ...mp.headers, cookie: aliceCookie }, payload: mp.payload });
    expect(res.statusCode).toBe(200);
    const nodes = res.json().workflow.nodes as Array<{ id: string; config: { connection?: { password?: string } } }>;
    expect(nodes.find((n) => n.id === 's1')?.config.connection?.password).toBe('secret');
  });

  it('创建时留存内嵌 SQL 连接为私有默认值：掩码返回、库中加密、payload 无明文', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
    const id = created.json().id;

    const res = await app.inject({ method: 'GET', url: `/api/workflows/${id}/connections`, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    const nodes = res.json().nodes as Array<{ node_id: string; kind: string; config: Record<string, unknown> | null }>;
    expect(nodes.map((n) => n.node_id).sort()).toEqual(['s1', 's2']);
    const s1 = nodes.find((n) => n.node_id === 's1')!;
    expect(s1.kind).toBe('inputSqlServer');
    expect(s1.config?.server).toBe('db');
    expect(s1.config?.password).toBe('******');

    const row = workflowConnectionsRepo(db).findByNode(id, 's1')!;
    expect((decryptConfig(row.config_encrypted, cfg.encryptionKey) as { password: string }).password).toBe('secret');

    const detail = await app.inject({ method: 'GET', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie } });
    expect(JSON.stringify(detail.json())).not.toContain('secret');
  });

  it('更新私有连接：密码留空沿用原值', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
    const id = created.json().id;
    const put = await app.inject({ method: 'PUT', url: `/api/workflows/${id}/connections/s1`, headers: { cookie: aliceCookie }, payload: { config: { server: 'db.new', port: 1433, user: 'sa', database: 'd', password: '' } } });
    expect(put.statusCode).toBe(200);
    expect(put.json().config.server).toBe('db.new');
    expect(put.json().config.password).toBe('******');

    const row = workflowConnectionsRepo(db).findByNode(id, 's1')!;
    const plain = decryptConfig(row.config_encrypted, cfg.encryptionKey) as { server: string; password: string };
    expect(plain.server).toBe('db.new');
    expect(plain.password).toBe('secret');
  });

  it('非 SQL 节点更新连接返回 400', async () => {
    const id = await createWorkflow(aliceCookie);
    const res = await app.inject({ method: 'PUT', url: `/api/workflows/${id}/connections/n1`, headers: { cookie: aliceCookie }, payload: { config: { server: 'x' } } });
    expect(res.statusCode).toBe(400);
  });

  it('无 SQL 节点时连接列表为空', async () => {
    const id = await createWorkflow(aliceCookie);
    const res = await app.inject({ method: 'GET', url: `/api/workflows/${id}/connections`, headers: { cookie: aliceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toEqual([]);
  });

  it('越权访问他人工作流连接返回 403', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
    const id = created.json().id;
    const res = await app.inject({ method: 'GET', url: `/api/workflows/${id}/connections`, headers: { cookie: bobCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('测试连接：不可达返回 ok=false，缺少 server 返回 400，非 SQL 节点返回 400', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
    const id = created.json().id;

    const unreachable = await app.inject({ method: 'POST', url: `/api/workflows/${id}/connections/s1/test`, headers: { cookie: aliceCookie }, payload: { config: { server: '127.0.0.1', port: 1, database: 'd', user: 'u' } } });
    expect(unreachable.statusCode).toBe(200);
    expect(unreachable.json().ok).toBe(false);

    const noServer = await app.inject({ method: 'POST', url: `/api/workflows/${id}/connections/s1/test`, headers: { cookie: aliceCookie }, payload: { config: { server: '' } } });
    expect(noServer.statusCode).toBe(400);

    const notSql = await app.inject({ method: 'POST', url: `/api/workflows/${id}/connections/n1/test`, headers: { cookie: aliceCookie }, payload: { config: { server: '127.0.0.1', port: 1 } } });
    expect(notSql.statusCode).toBe(400);
  });

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
    const body = detail.json() as { name: string; workflow: { nodes: Array<{ config: { connection?: unknown } }> } };
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

  it('PUT 回传掩码密码 ****** 时保留原密码（merge 留空沿用）', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
    const id = created.json().id;

    const wf = JSON.parse(sqlJson);
    for (const node of wf.nodes) {
      if (node.config?.connection) node.config.connection.password = '******';
    }
    const res = await app.inject({ method: 'PUT', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie }, payload: { workflow: wf } });
    expect(res.statusCode).toBe(200);

    const s1 = workflowConnectionsRepo(db).findByNode(id, 's1')!;
    expect((decryptConfig(s1.config_encrypted, cfg.encryptionKey) as { password: string }).password).toBe('secret');
    const s2 = workflowConnectionsRepo(db).findByNode(id, 's2')!;
    expect((decryptConfig(s2.config_encrypted, cfg.encryptionKey) as { password: string }).password).toBe('secret2');
  });

  it('PUT 保存对账清理：不在本次 payload 中的 SQL 节点连接行被删除', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlWithN5Json) } });
    const id = created.json().id;
    expect(workflowConnectionsRepo(db).findByNode(id, 'n5')).not.toBeNull(); // 前置：创建时已留存

    const res = await app.inject({ method: 'PUT', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
    expect(res.statusCode).toBe(200);

    const nodeIds = workflowConnectionsRepo(db).listByWorkflow(id).map((c) => c.node_id).sort();
    expect(nodeIds).toEqual(['s1', 's2']); // n5 行已被对账删除
  });

  it('PUT 复活路径：同 id 新节点无 connection 时不得继承旧连接行', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/workflows', headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlWithN5Json) } });
    const id = created.json().id;

    // 先删除持有连接的 n5 并保存
    await app.inject({ method: 'PUT', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie }, payload: { workflow: JSON.parse(sqlJson) } });
    expect(workflowConnectionsRepo(db).findByNode(id, 'n5')).toBeNull();

    // 再新增同 id n5 但未配置连接：不得继承旧行
    const revived = JSON.parse(sqlJson);
    revived.nodes.push({ id: 'n5', kind: 'inputSqlServer', name: '复活库', position: { x: 400, y: 0 }, config: { query: 'select 2' } });
    const res = await app.inject({ method: 'PUT', url: `/api/workflows/${id}`, headers: { cookie: aliceCookie }, payload: { workflow: revived } });
    expect(res.statusCode).toBe(200);

    expect(workflowConnectionsRepo(db).findByNode(id, 'n5')).toBeNull();
  });
});
