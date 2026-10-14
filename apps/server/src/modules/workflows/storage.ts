import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

export function sanitizeName(name: string): string {
  const base = basename(name).replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^\.+/, '');
  return base || 'upload.bin';
}

export function storeUpload(dir: string, originalName: string, data: Buffer): { storedName: string; size: number } {
  mkdirSync(dir, { recursive: true });
  const storedName = `${Date.now()}_${sanitizeName(originalName)}`;
  writeFileSync(join(dir, storedName), data);
  return { storedName, size: data.byteLength };
}
