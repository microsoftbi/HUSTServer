import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { sessionsRepo } from './modules/auth/sessions.js';
import { connectionRoutes } from './modules/connections/routes.js';
import { jobsRepo } from './modules/jobs/repo.js';
import { jobRoutes } from './modules/jobs/routes.js';
import { createJobService, type JobService } from './modules/jobs/service.js';
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
}

export interface AppDeps {
  db: Database;
  config: AppConfig;
  logger?: boolean;
  overrides?: AppOverrides;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

  const users = usersRepo(deps.db);
  const sessions = sessionsRepo(deps.db);

  const recorder = deps.overrides?.recorder ?? createRecorder(deps.db);
  const runService =
    deps.overrides?.runService ?? createRunService({ db: deps.db, config: deps.config, recorder });

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
    deps.overrides?.jobService ?? createJobService({ db: deps.db, config: deps.config, runService });
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

  authRoutes(app, { users, sessions, sessionTtlMs: deps.config.sessionTtlMs });
  userAdminRoutes(app, { users, sessions });
  workflowRoutes(app, { db: deps.db, config: deps.config, users, sessions });
  connectionRoutes(app, { db: deps.db, config: deps.config, users, sessions });
  resourceRoutes(app, {
    resourceDir: deps.config.resourceDir,
    uploadDir: deps.config.uploadDir,
    users,
    sessions,
  });
  schemaRoutes(app, {
    resourceDir: deps.config.resourceDir,
    uploadDir: deps.config.uploadDir,
    users,
    sessions,
  });
  runRoutes(app, { db: deps.db, config: deps.config, users, sessions, recorder, runService });
  scheduleRoutes(app, { db: deps.db, config: deps.config, users, sessions, resync: syncWorkflowScheduler });
  jobRoutes(app, { db: deps.db, config: deps.config, users, sessions, jobService, resync: syncJobScheduler });

  const settings = settingsRepo(deps.db);
  settingsRoutes(app, { config: deps.config, users, sessions, settings });

  return app;
}
