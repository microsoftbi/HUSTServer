import path from 'node:path';

/** 资源库允许上传/管理的文件扩展名。 */
export const RESOURCE_EXTENSIONS = new Set(['.csv', '.xlsx', '.xls']);

/**
 * 把资源库内的相对路径解析为绝对路径；任何越界（含 `..`、绝对路径）都抛错。
 * 空字符串返回资源库根目录本身。
 */
export function resolveResourcePath(root: string, rel: string | null | undefined): string {
  const base = path.resolve(root);
  const normalized = (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const abs = path.resolve(base, normalized);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`资源路径越界：${rel ?? ''}`);
  }
  return abs;
}

/** 把绝对路径转回资源库内的相对路径（统一用 `/` 分隔）。 */
export function toResourceRel(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), abs);
  return rel.split(path.sep).join('/');
}

/** 校验文件名扩展名是否属于允许的资源类型。 */
export function isAllowedResourceFile(name: string): boolean {
  return RESOURCE_EXTENSIONS.has(path.extname(name).toLowerCase());
}
