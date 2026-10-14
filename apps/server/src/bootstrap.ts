import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import { hashPassword } from './modules/auth/password.js';
import { usersRepo } from './modules/users/repo.js';

export interface BootstrapLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export async function ensureBootstrapAdmin(
  db: Database,
  cfg: AppConfig,
  log: BootstrapLogger,
): Promise<void> {
  const users = usersRepo(db);
  if (users.count() > 0) return;
  const username = cfg.bootstrapAdminUser ?? 'admin';
  const generated = !cfg.bootstrapAdminPassword;
  const password = cfg.bootstrapAdminPassword ?? randomBytes(9).toString('base64url');
  users.create({ username, passwordHash: await hashPassword(password), role: 'admin' });
  if (generated) {
    log.warn(`已创建初始管理员「${username}」，随机密码：${password}（仅显示一次，请立即修改）`);
  } else {
    log.info(`已创建初始管理员「${username}」`);
  }
}
