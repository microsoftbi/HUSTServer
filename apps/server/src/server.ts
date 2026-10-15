import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { sessionsRepo } from './modules/auth/sessions.js';
import { connectionRoutes } from './modules/connections/routes.js';
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
  }
}

export interface AppOverrides {
  recorder?: Recorder;
  runService?: RunService;
  scheduler?: Scheduler;
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
    createScheduler({
      schedules: schedulesRepo(deps.db),
      triggerRun: (workflowId, scheduleId) => {
        runService.trigger(workflowId, { triggerType: 'schedule', scheduleId });
      },
      onError: (err) => app.log.error({ err }, '调度触发失败'),
    });

  app.decorate('scheduler', scheduler);

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
  scheduleRoutes(app, { db: deps.db, config: deps.config, users, sessions, scheduler });

  const settings = settingsRepo(deps.db);
  settingsRoutes(app, { config: deps.config, users, sessions, settings });

  return app;
}
