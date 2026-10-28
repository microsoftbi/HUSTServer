import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { ensureDirs, loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { migrate } from './db/migrate.js';
import { createRetention } from './modules/runs/retention.js';
import { runsRepo } from './modules/runs/repo.js';
import { settingsRepo } from './modules/settings/repo.js';
import { readSettings } from './modules/settings/routes.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureDirs(cfg);

  // 引擎（@hustserver/engine/config.ts）在模块求值时读取 HUSTSERVER_* 环境变量；
  // server.ts 静态导入引擎，故先补齐环境变量，再用动态 import 延迟其求值。
  process.env.HUSTSERVER_DATA_DIR ??= cfg.dataDir;
  process.env.HUSTSERVER_HOST ??= cfg.host;
  process.env.HUSTSERVER_PORT ??= String(cfg.port);
  process.env.DUCKDB_MEMORY_LIMIT ??= cfg.duckdbMemoryLimit;

  const db = openDatabase(cfg.dbFile);
  migrate(db);

  // 系统设置（DB 覆盖）优先于环境变量默认值。
  const settings = settingsRepo(db);
  const effective = readSettings(cfg, settings);
  const runtimeConfig: AppConfig = {
    ...cfg,
    maxConcurrentRuns: effective.maxConcurrentRuns,
    logRetentionDays: effective.logRetentionDays,
    sharedDirs: effective.sharedDirs,
    tz: effective.tz,
  };

  const { buildServer } = await import('./server.js');
  const app = await buildServer({ db, config: runtimeConfig, logger: true });

  await ensureBootstrapAdmin(db, runtimeConfig, app.log);

  // 前端静态资源 + SPA 回退（/api/* 仍返回 JSON 404）。
  // 默认解析到 apps/web/dist；桌面版通过 HUSTSERVER_WEB_DIR 指向应用内资源目录。
  const webDir = cfg.webDir;
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`未找到前端产物 ${webDir}，仅提供 API 服务（请先执行 pnpm --filter @hustserver/web build）`);
  }

  const retention = createRetention({
    runs: runsRepo(db),
    logRetentionDays: runtimeConfig.logRetentionDays,
    onError: (err) => app.log.error({ err }, '日志保留清理失败'),
  });

  await app.listen({ host: cfg.host, port: cfg.port });
  app.scheduler.start();
  app.jobScheduler.start();
  retention.start();
  app.log.info(`个人数据工作台已启动：http://${cfg.host}:${cfg.port}`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info(`收到 ${signal}，正在优雅退出…`);
    app.scheduler.stop();
    app.jobScheduler.stop();
    retention.stop();
    try {
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('个人数据工作台启动失败：', err);
  process.exit(1);
});
