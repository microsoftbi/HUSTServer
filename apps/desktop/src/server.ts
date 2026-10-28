import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface StartOptions {
  /** 服务入口 dist/index.js 绝对路径。 */
  entry: string;
  /** 前端产物目录，传给 HUSTSERVER_WEB_DIR。 */
  webDir: string;
  /** 资源库目录，传给 HUSTSERVER_RESOURCE_DIR。 */
  resourceDir: string;
  /** 数据目录，默认 ~/.hustserver，与命令行版共用。 */
  dataDir?: string;
  /** 打包态使用 Electron 自带 Node，native 模块已按 Electron ABI 重建。 */
  electronNode: boolean;
  onLog?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

export interface ServerHandle {
  url: string;
  port: number;
  dataDir: string;
  logFile: string;
  stop: () => Promise<void>;
}

interface Secrets {
  sessionSecret: string;
  encryptionKey: string;
}

/** 首次启动生成并持久化会话/加密密钥，保证重启后登录态与连接密码可解密。 */
function ensureSecrets(dataDir: string): Secrets {
  const file = path.join(dataDir, 'desktop-secrets.json');
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Secrets>;
    if (raw.sessionSecret && raw.encryptionKey) {
      return { sessionSecret: raw.sessionSecret, encryptionKey: raw.encryptionKey };
    }
  }
  const secrets: Secrets = {
    sessionSecret: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('hex'),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

/** 交由系统分配空闲端口，避免固定 8787 被占用导致启动失败。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('未能获取空闲端口'))));
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // 服务尚未监听，继续轮询
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`本地服务在 ${Math.round(timeoutMs / 1000)} 秒内未就绪`);
}

export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  const dataDir = opts.dataDir ?? path.join(os.homedir(), '.hustserver');
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(opts.resourceDir, { recursive: true });
  const logFile = path.join(logDir, 'desktop.log');

  const secrets = ensureSecrets(dataDir);
  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUSTSERVER_DATA_DIR: dataDir,
    HUSTSERVER_HOST: '127.0.0.1',
    HUSTSERVER_PORT: String(port),
    HUSTSERVER_WEB_DIR: opts.webDir,
    HUSTSERVER_RESOURCE_DIR: opts.resourceDir,
    SESSION_SECRET: secrets.sessionSecret,
    ENCRYPTION_KEY: secrets.encryptionKey,
  };

  const args = [opts.entry];
  if (opts.electronNode) {
    // Electron 二进制以 Node 模式运行服务子进程，ABI 与重建后的 native 模块一致
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} 启动 ${url} ===\n`);

  const child: ChildProcess = spawn(opts.electronNode ? process.execPath : 'node', args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const forward = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    logStream.write(text);
    for (const line of text.split('\n')) {
      if (line.trim()) opts.onLog?.(line);
    }
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);

  let exited = false;
  child.once('exit', (code) => {
    exited = true;
    logStream.write(`=== 服务退出，code=${code} ===\n`);
    logStream.end();
    opts.onExit?.(code);
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 8000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  };

  await waitForHealth(url, 60_000);
  return { url, port, dataDir, logFile, stop };
}
