export interface SessionUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface RequestOptions {
  body?: unknown;
  form?: FormData;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, detail?: string) {
    super(`${status} ${code}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface ApiClient {
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, opts?: RequestOptions): Promise<T>;
  put<T>(path: string, opts?: RequestOptions): Promise<T>;
  del<T>(path: string): Promise<T>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? '';
  const doFetch = opts.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;
    if (options.form) {
      body = options.form; // 浏览器自动带 multipart 边界，勿手动设置 content-type
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const res = await doFetch(baseUrl + path, { method, headers, body, credentials: 'include' });
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const payload = (data ?? {}) as { error?: string; detail?: string };
      throw new ApiClientError(res.status, payload.error ?? 'request_failed', payload.detail);
    }
    return data as T;
  }

  return {
    request,
    get: (path) => request('GET', path),
    post: (path, options) => request('POST', path, options),
    put: (path, options) => request('PUT', path, options),
    del: (path) => request('DELETE', path),
  };
}

/** 全局默认客户端（同源部署，浏览器 Cookie 自动携带）。 */
export const api = createApiClient();
