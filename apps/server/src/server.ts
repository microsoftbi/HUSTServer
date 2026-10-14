import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { authRoutes } from './modules/auth/routes.js';
import { sessionsRepo } from './modules/auth/sessions.js';
import { usersRepo } from './modules/users/repo.js';
import { userAdminRoutes } from './modules/users/routes.js';

export interface AppDeps {
  db: Database;
  config: AppConfig;
  logger?: boolean;
}

export async function buildServer(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cookie, { secret: deps.config.sessionSecret });

  const users = usersRepo(deps.db);
  const sessions = sessionsRepo(deps.db);

  authRoutes(app, { users, sessions, sessionTtlMs: deps.config.sessionTtlMs });
  userAdminRoutes(app, { users, sessions });

  return app;
}
