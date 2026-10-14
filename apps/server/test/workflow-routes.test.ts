import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { usersRepo } from '../src/modules/users/repo.js';

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

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  await usersRepo(db).create({ username: 'admin', passwordHash: await hashPassword('admin123'), role: 'admin' });
  await usersRepo(db).create({ username: 'alice', passwordHash: await hashPassword('alice123'), role: 'user' });
  await usersRepo(db).create({ username: 'bob', passwordHash: await hashPassword('bob12345'), role: 'user' });
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
});
