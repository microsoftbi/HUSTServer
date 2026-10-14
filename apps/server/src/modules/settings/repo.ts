import type { Database } from 'better-sqlite3';

/** settings 表的键值访问；值统一为字符串，数值/数组由调用方序列化。 */
export interface SettingsRepo {
  get(key: string): string | null;
  all(): Record<string, string>;
  set(key: string, value: string): void;
  setMany(entries: Record<string, string>): void;
}

export function settingsRepo(db: Database): SettingsRepo {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const allStmt = db.prepare('SELECT key, value FROM settings');
  const upsertStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  return {
    get: (key) => (getStmt.get(key) as { value: string } | undefined)?.value ?? null,
    all: () => {
      const rows = allStmt.all() as Array<{ key: string; value: string }>;
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },
    set: (key, value) => {
      upsertStmt.run(key, value);
    },
    setMany: (entries) => {
      const tx = db.transaction((obj: Record<string, string>) => {
        for (const [k, v] of Object.entries(obj)) upsertStmt.run(k, v);
      });
      tx(entries);
    },
  };
}
