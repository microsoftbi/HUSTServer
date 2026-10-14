import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { OUTPUT_DIR, SPILL_DIR, UPLOAD_DIR, ensureDirs } from '../config.js';
import { toJsonSafe } from './values.js';

export function tempPath(ext: string): string {
  ensureDirs();
  return path.join(SPILL_DIR, `tmp_${nanoid(12)}${ext}`);
}

/** 将相对路径解析为上传目录下的绝对路径。 */
export function resolveInputPath(p: string): string {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(UPLOAD_DIR, p);
}

/** 将相对路径解析为输出目录下的绝对路径，并保证父目录存在。 */
export function resolveOutputPath(p: string): string {
  ensureDirs();
  const full = path.isAbsolute(p) ? p : path.join(OUTPUT_DIR, p);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

/** 将行对象流式写入 NDJSON 文件，供 DuckDB read_json_auto 读取。 */
export async function writeNdjson(
  filePath: string,
  rows: Iterable<Record<string, unknown>>,
): Promise<void> {
  const stream = fs.createWriteStream(filePath, { encoding: 'utf-8' });
  const finished = new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
  for (const row of rows) {
    const line = JSON.stringify(toJsonSafe(row)) + '\n';
    if (!stream.write(line)) {
      await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
    }
  }
  stream.end();
  await finished;
}

/** 读取文件并按指定编码解码为 UTF-8 文本（用于 GBK 等 DuckDB 不直接支持的编码）。 */
export function decodeFileToUtf8(filePath: string, encoding: string): string {
  const buffer = fs.readFileSync(filePath);
  const decoder = new TextDecoder(encoding as BufferEncoding);
  return decoder.decode(buffer);
}

/** 删除文件（忽略失败）。 */
export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}
