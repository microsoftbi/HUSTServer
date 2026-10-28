import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  /** 持久化数据模型库（DuckDB 单文件）。 */
  modelDbFile: string;
  uploadDir: string;
  outputDir: string;
  spillDir: string;
  /** 资源库根目录：web 前端项目的 DATA 文件夹。 */
  resourceDir: string;
  /** 前端构建产物目录；桌面版由 HUSTSERVER_WEB_DIR 指定。 */
  webDir: string;
  sessionSecret: string;
  encryptionKey: Buffer;
  sessionTtlMs: number;
  maxConcurrentRuns: number;
  runMaxRetries: number;
  logRetentionDays: number;
  duckdbMemoryLimit: string;
  tz: string;
  bootstrapAdminUser?: string;
  bootstrapAdminPassword?: string;
  sharedDirs: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.HUSTSERVER_DATA_DIR || path.join(os.homedir(), '.hustserver');
  // 资源库默认放在数据目录内，网页端与桌面版共用同一份。
  const resourceDir = env.HUSTSERVER_RESOURCE_DIR || path.join(dataDir, 'resources');
  // 前端产物默认解析到 apps/web/dist（src 与 dist 下结果一致）。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = env.HUSTSERVER_WEB_DIR
    ? path.resolve(env.HUSTSERVER_WEB_DIR)
    : path.resolve(here, '../../web/dist');
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) throw new Error('缺少环境变量 SESSION_SECRET');
  const keyHex = env.ENCRYPTION_KEY;
  if (!keyHex || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('ENCRYPTION_KEY 必须是 64 位十六进制字符串（32 字节）');
  }
  return {
    host: env.HUSTSERVER_HOST || '127.0.0.1',
    port: Number(env.HUSTSERVER_PORT || 8787),
    dataDir,
    dbFile: path.join(dataDir, 'metadata.sqlite'),
    modelDbFile: path.join(dataDir, 'models.duckdb'),
    uploadDir: path.join(dataDir, 'uploads'),
    outputDir: path.join(dataDir, 'outputs'),
    spillDir: path.join(dataDir, 'spill'),
    resourceDir,
    webDir,
    sessionSecret,
    encryptionKey: Buffer.from(keyHex, 'hex'),
    sessionTtlMs: Number(env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000),
    maxConcurrentRuns: Number(env.MAX_CONCURRENT_RUNS || 2),
    runMaxRetries: Number(env.RUN_MAX_RETRIES || 1),
    logRetentionDays: Number(env.LOG_RETENTION_DAYS || 90),
    duckdbMemoryLimit: env.DUCKDB_MEMORY_LIMIT || '2GB',
    tz: env.TZ || 'Asia/Shanghai',
    ...(env.BOOTSTRAP_ADMIN_USER ? { bootstrapAdminUser: env.BOOTSTRAP_ADMIN_USER } : {}),
    ...(env.BOOTSTRAP_ADMIN_PASSWORD ? { bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD } : {}),
    sharedDirs: (env.HUSTSERVER_SHARED_DIRS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function ensureDirs(cfg: AppConfig): void {
  for (const dir of [cfg.dataDir, cfg.uploadDir, cfg.outputDir, cfg.spillDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
