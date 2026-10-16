import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient } from '../src/api.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createApiClient', () => {
  it('GET 返回解析后的 JSON', async () => {
    const body = {
      id: 'u1',
      username: 'u1',
      roles: ['admin'],
      capabilities: [
        'admin',
        'workflow',
        'job',
        'resources',
        'connection.manage',
        'connection.use',
        'dashboard.edit',
        'dashboard.view',
      ],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(200, body)) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: 'http://x', fetchImpl });

    await expect(api.get('/api/auth/me')).resolves.toEqual(body);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://x/api/auth/me');
    expect(init.credentials).toBe('include');
  });

  it('POST 发送 JSON 请求体', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });

    await api.post('/api/auth/login', { body: { username: 'a', password: 'b' } });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ username: 'a', password: 'b' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('FormData 上传不设置 content-type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: 'w1' })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });
    const form = new FormData();
    form.append('file', 'x');

    await api.post('/api/workflows', { form });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('非 2xx 抛出带 status/code 的 ApiClientError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'forbidden' })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });

    await expect(api.get('/api/admin/users')).rejects.toBeInstanceOf(ApiClientError);
    await api.get('/api/admin/users').catch((err: ApiClientError) => {
      expect(err.status).toBe(403);
      expect(err.code).toBe('forbidden');
    });
  });

  it('204 返回 undefined', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const api = createApiClient({ baseUrl: '', fetchImpl });
    await expect(api.del('/api/schedules/s1')).resolves.toBeUndefined();
  });
});
