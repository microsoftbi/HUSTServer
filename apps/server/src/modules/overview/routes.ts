import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../../plugins/guards.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';

export interface OverviewRouteDeps {
  db: Database;
  users: UsersRepo;
  sessions: SessionsRepo;
}

/** 按天统计「新建数量」的来源（键为对外字段名，值为受控表名，不接受外部输入） */
const SOURCES = {
  workflows: 'workflows',
  dashboards: 'dashboards',
  models: 'data_models',
  connections: 'connections',
  jobs: 'jobs',
  users: 'users',
  audits: 'audit_logs',
} as const;

type Source = keyof typeof SOURCES;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 升序的最近 N 个本地日期（YYYY-MM-DD，末项为今天） */
function lastNDates(days: number): string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  }
  return out;
}

export function overviewRoutes(app: FastifyInstance, deps: OverviewRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });

  /** 管理员概览：各类资源按天的新建数量（首页折线图用） */
  app.get('/api/admin/overview', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    const q = req.query as { days?: string };
    const raw = q.days === undefined || q.days === '' ? DEFAULT_DAYS : Number(q.days);
    if (!Number.isInteger(raw) || raw < 1 || raw > MAX_DAYS) {
      return reply.code(400).send({ error: `days 必须为 1–${MAX_DAYS} 的整数` });
    }

    // 按服务端本地时区切天；起点 = 今天往前 days-1 天的 00:00
    const dates = lastNDates(raw);
    const startMs = new Date(`${dates[0]}T00:00:00`).getTime();
    const index = new Map(dates.map((date, i) => [date, i]));

    const counts = {} as Record<Source, number[]>;
    for (const key of Object.keys(SOURCES) as Source[]) {
      const rows = deps.db
        .prepare(
          `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS c
           FROM ${SOURCES[key]} WHERE created_at >= ? GROUP BY d`,
        )
        .all(startMs) as Array<{ d: string; c: number }>;
      const series = new Array<number>(raw).fill(0);
      for (const row of rows) {
        const i = index.get(row.d);
        if (i !== undefined) series[i] = row.c;
      }
      counts[key] = series;
    }

    return { days: raw, dates, counts };
  });
}
