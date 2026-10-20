import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { auditRepo } from './modules/audit/repo.js';
import { auditRoutes } from './modules/audit/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { loginLogsRepo } from './modules/auth/loginLogs.js';
import { sessionsRepo } from './modules/auth/sessions.js';
import { connectionRoutes } from './modules/connections/routes.js';
import { dataRoutes } from './modules/data/routes.js';
import { dashboardRoutes } from './modules/dashboards/routes.js';
import { exploreRoutes } from './modules/explore/routes.js';
import { jobsRepo } from './modules/jobs/repo.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { createJobService, type JobService } from './modules/jobs/service.js';
import { modelRoutes } from './modules/models/routes.js';
import { createModelStore, type ModelStore } from './modules/models/service.js';
import { overviewRoutes } from './modules/overview/routes.js';
import { createRecorder, type Recorder } from './modules/runs/recorder.js';
import { runRoutes } from './modules/runs/routes.js';
import { createRunService, type RunService } from './modules/runs/service.js';
import { resourceRoutes } from './modules/resources/routes.js';
import { schemaRoutes } from './modules/schema/routes.js';
import { schedulesRepo } from './modules/schedules/repo.js';
import { scheduleRoutes } from './modules/schedules/routes.js';
import { createScheduler, type Scheduler } from './modules/schedules/scheduler.js';
import { settingsRepo } from './modules/settings/repo.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { userAdminRoutes } from './modules/users/routes.js';
import { usersRepo } from './modules/users/repo.js';
import { workflowRoutes } from './modules/workflows/routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    scheduler: Scheduler;
    jobScheduler: Scheduler;
  }
}

export interface AppOverrides {
  recorder?: Recorder;
  runService?: RunService;
  scheduler?: Scheduler;
  jobService?: JobService;
  jobScheduler?: Scheduler;
  modelStore?: ModelStore;
}

export interface AppDeps {
  db: Database;
  config: AppConfig;
  logger?: boolean;
  overrides?: AppOverrides;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  // bodyLimit 高于仪表板 payload 上限（8MB），让路由层自己返回 payload_too_large
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 * 1024 });
  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

  const users = usersRepo(deps.db);
  const sessions = sessionsRepo(deps.db);
  const loginLogs = loginLogsRepo(deps.db);
  const audit = auditRepo(deps.db, {
    // 审计写入失败只记日志，不影响业务响应
    onError: (err) => app.log.warn({ err }, '审计日志写入失败'),
  });

  const recorder = deps.overrides?.recorder ?? createRecorder(deps.db);
  const runService =
    deps.overrides?.runService ?? createRunService({ db: deps.db, config: deps.config, recorder });

  const modelStore =
    deps.overrides?.modelStore ?? createModelStore({ db: deps.db, config: deps.config });
  if (!deps.overrides?.modelStore) {
    // 优雅退出时关闭由 buildServer 自行创建的 DuckDB 模型库连接（注入的实例由调用方负责）
    app.addHook('onClose', async () => {
      modelStore.close();
    });
  }

  const scheduler =
    deps.overrides?.scheduler ??
    createScheduler({ onError: (err) => app.log.error({ err }, '调度触发失败') });
  const jobScheduler =
    deps.overrides?.jobScheduler ??
    createScheduler({ onError: (err) => app.log.error({ err }, 'Job 调度触发失败') });

  app.decorate('scheduler', scheduler);
  app.decorate('jobScheduler', jobScheduler);

  const schedules = schedulesRepo(deps.db);
  const fireWorkflow = (scheduleId: string): void => {
    const row = schedules.findById(scheduleId);
    if (!row) return;
    runService.trigger(row.workflow_id, { triggerType: 'schedule', scheduleId });
  };
  const syncWorkflowScheduler = (): void => {
    scheduler.sync(
      schedules.listEnabled().map((s) => ({ id: s.id, expr: s.cron_expr, timezone: s.timezone })),
      fireWorkflow,
    );
  };
  syncWorkflowScheduler();

  const jobService =
    deps.overrides?.jobService ?? createJobService({ db: deps.db, config: deps.config, runService, modelStore });
  const jobs = jobsRepo(deps.db);
  const syncJobScheduler = (): void => {
    jobScheduler.sync(
      jobs.listEnabledScheduled().map((j) => ({ id: j.id, expr: j.cron_expr ?? '', timezone: j.timezone })),
      (jobId) => {
        jobService.trigger(jobId, { triggerType: 'schedule' });
      },
    );
  };
  syncJobScheduler();

  authRoutes(app, { users, sessions, loginLogs, audit, sessionTtlMs: deps.config.sessionTtlMs });
  userAdminRoutes(app, { users, sessions, loginLogs, audit });
  workflowRoutes(app, { db: deps.db, config: deps.config, users, sessions, audit });
  connectionRoutes(app, { db: deps.db, config: deps.config, users, sessions, audit });
  dashboardRoutes(app, { db: deps.db, config: deps.config, users, sessions, audit });
  dataRoutes(app, { db: deps.db, config: deps.config, users, sessions });
  modelRoutes(app, { db: deps.db, config: deps.config, users, sessions, modelStore, audit });
  resourceRoutes(app, {
    resourceDir: deps.config.resourceDir,
    uploadDir: deps.config.uploadDir,
    users,
    sessions,
    audit,
  });
  schemaRoutes(app, {
    db: deps.db,
    config: deps.config,
    resourceDir: deps.config.resourceDir,
    uploadDir: deps.config.uploadDir,
    users,
    sessions,
  });
  runRoutes(app, { db: deps.db, config: deps.config, users, sessions, recorder, runService, audit });
  scheduleRoutes(app, { db: deps.db, config: deps.config, users, sessions, resync: syncWorkflowScheduler });
  jobRoutes(app, {
    db: deps.db,
    config: deps.config,
    users,
    sessions,
    jobService,
    resync: syncJobScheduler,
    audit,
  });

  const settings = settingsRepo(deps.db);
  settingsRoutes(app, { config: deps.config, users, sessions, settings });

  overviewRoutes(app, { db: deps.db, users, sessions });

  auditRoutes(app, { audit, users, sessions, models: modelStore });

  exploreRoutes(app, { db: deps.db, config: deps.config, users, sessions, modelStore });

  return app;
}
