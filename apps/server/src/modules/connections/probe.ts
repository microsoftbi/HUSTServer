import { createConnection } from 'node:net';

export function testTcp(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, '连接超时'));
    socket.once('error', (err) => finish(false, (err as Error).message));
  });
}
