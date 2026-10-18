import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { listExcelSheets } from '@hustserver/engine';
import { requireAnyCap, requireAuth, requireCap } from '../../plugins/guards.js';
import type { AuditRecorder } from '../audit/repo.js';
import type { SessionsRepo } from '../auth/sessions.js';
import type { UsersRepo } from '../users/repo.js';
import { isAllowedResourceFile, resolveResourcePath, toResourceRel } from './paths.js';

const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface ResourceRouteDeps {
  resourceDir: string;
  /** 上传目录：相对路径的 Excel 引用按引擎语义落到此处。 */
  uploadDir: string;
  users: UsersRepo;
  sessions: SessionsRepo;
  audit: AuditRecorder;
}

interface ResourceEntry {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  size?: number;
  mtime?: number;
  /** 仅文件：绝对路径，供工作流节点直接写入 config.path。 */
  absPath?: string;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function resourceRoutes(app: FastifyInstance, deps: ResourceRouteDeps): void {
  const auth = requireAuth({ users: deps.users, sessions: deps.sessions });
  const root = path.resolve(deps.resourceDir);
  fs.mkdirSync(root, { recursive: true });

  const relOf = (abs: string): string => toResourceRel(root, abs);

  function listDir(abs: string, rel: string): ResourceEntry[] {
    const entries: ResourceEntry[] = [];
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: childRel, kind: 'folder' });
      } else if (d.isFile()) {
        const fileAbs = path.join(abs, d.name);
        const st = fs.statSync(fileAbs);
        entries.push({
          name: d.name,
          path: childRel,
          kind: 'file',
          size: st.size,
          mtime: st.mtimeMs,
          absPath: fileAbs,
        });
      }
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
    return entries;
  }

  // 列出某目录下的子文件夹与文件。
  app.get('/api/resources', { preHandler: [auth, requireAnyCap('resources', 'dashboard.edit')] }, async (req, reply) => {
    const rel = String((req.query as { path?: string }).path ?? '');
    let abs: string;
    try {
      abs = resolveResourcePath(root, rel);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      return reply.code(404).send({ error: '目录不存在' });
    }
    const cleanRel = relOf(abs);
    return { path: cleanRel, entries: listDir(abs, cleanRel) };
  });

  // 递归列出全部资源文件（供工作流输入绑定选择）。
  // absPath 为文件绝对路径，可直接写入节点 config.path（引擎对绝对路径原样读取）。
  app.get('/api/resources/tree', { preHandler: [auth, requireAnyCap('resources', 'dashboard.edit')] }, async () => {
    const files: Array<{ name: string; path: string; size: number; absPath: string }> = [];
    const walk = (abs: string, rel: string): void => {
      for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
        if (d.name.startsWith('.')) continue;
        const childAbs = path.join(abs, d.name);
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(childAbs, childRel);
        else if (d.isFile() && isAllowedResourceFile(d.name)) {
          files.push({ name: d.name, path: childRel, size: fs.statSync(childAbs).size, absPath: childAbs });
        }
      }
    };
    walk(root, '');
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files };
  });

  // 列出 Excel 文件的工作表名（供画布 Excel 输入节点选择工作表）。
  // path 语义与引擎 resolveInputPath 一致：绝对路径原样使用，相对路径落到上传目录；
  // 仅允许资源库与上传目录内的文件，防止任意路径读取。
  app.get('/api/resources/sheets', { preHandler: [auth, requireAnyCap('resources', 'dashboard.edit')] }, async (req, reply) => {
    const raw = String((req.query as { path?: string }).path ?? '').trim();
    if (!raw) return reply.code(400).send({ error: '缺少 path 参数' });
    const uploadRoot = path.resolve(deps.uploadDir);
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.join(uploadRoot, raw);
    const allowed = [root, uploadRoot].some((base) => abs === base || abs.startsWith(base + path.sep));
    if (!allowed) return reply.code(400).send({ error: '路径不在允许的目录内' });
    try {
      return { sheets: listExcelSheets(abs) };
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // 递归列出全部文件夹（供资源管理器左侧目录树使用）。
  app.get('/api/resources/folders/tree', { preHandler: [auth, requireAnyCap('resources', 'dashboard.edit')] }, async () => {
    const walk = (abs: string, rel: string): Array<{ name: string; path: string; children: unknown[] }> => {
      const out: Array<{ name: string; path: string; children: unknown[] }> = [];
      for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        out.push({ name: d.name, path: childRel, children: walk(path.join(abs, d.name), childRel) });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    };
    return { folders: walk(root, '') };
  });

  // 移动文件/文件夹到目标目录（to 为目标目录的相对路径，'' 表示根目录）。
  app.post('/api/resources/move', { preHandler: [auth, requireCap('resources')] }, async (req, reply) => {
    const { from: fromRel = '', to: toRel = '' } = (req.body ?? {}) as { from?: string; to?: string };
    let fromAbs: string;
    let toAbs: string;
    try {
      fromAbs = resolveResourcePath(root, fromRel);
      toAbs = resolveResourcePath(root, toRel);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (fromAbs === root) return reply.code(400).send({ error: '不能移动根目录' });
    if (!fs.existsSync(fromAbs)) return reply.code(404).send({ error: '源不存在' });
    if (!fs.existsSync(toAbs) || !fs.statSync(toAbs).isDirectory()) {
      return reply.code(404).send({ error: '目标目录不存在' });
    }
    if (fs.statSync(fromAbs).isDirectory() && (toAbs === fromAbs || toAbs.startsWith(fromAbs + path.sep))) {
      return reply.code(400).send({ error: '不能移动到自身或其子目录' });
    }
    const targetAbs = path.join(toAbs, path.basename(fromAbs));
    if (targetAbs === fromAbs) return { path: relOf(fromAbs) };
    if (fs.existsSync(targetAbs)) return reply.code(409).send({ error: '目标目录已存在同名项' });
    fs.renameSync(fromAbs, targetAbs);
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'update',
      resource: 'resource',
      resourceName: path.basename(targetAbs),
      description: `移动了资源「${path.basename(targetAbs)}」`,
    });
    return { path: relOf(targetAbs) };
  });

  // 新建文件夹（name 可含 `/` 以创建多级目录）。
  app.post('/api/resources/folders', { preHandler: [auth, requireCap('resources')] }, async (req, reply) => {
    const { path: rel = '', name = '' } = (req.body ?? {}) as { path?: string; name?: string };
    if (!name.trim()) return reply.code(400).send({ error: '文件夹名称不能为空' });
    let abs: string;
    try {
      abs = resolveResourcePath(root, `${rel}/${name.trim()}`);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (fs.existsSync(abs)) return reply.code(409).send({ error: '同名文件夹或文件已存在' });
    fs.mkdirSync(abs, { recursive: true });
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'create',
      resource: 'resource',
      resourceName: name.trim(),
      description: `新建了文件夹「${name.trim()}」`,
    });
    return reply.code(201).send({ path: relOf(abs) });
  });

  // 重命名文件夹（保持在同一父目录下）。
  app.patch('/api/resources/folders', { preHandler: [auth, requireCap('resources')] }, async (req, reply) => {
    const { path: rel = '', name = '' } = (req.body ?? {}) as { path?: string; name?: string };
    if (!name.trim()) return reply.code(400).send({ error: '文件夹名称不能为空' });
    const parentRel = rel.split('/').slice(0, -1).join('/');
    let from: string;
    let to: string;
    try {
      from = resolveResourcePath(root, rel);
      to = resolveResourcePath(root, parentRel ? `${parentRel}/${name.trim()}` : name.trim());
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (from === root) return reply.code(400).send({ error: '不能重命名根目录' });
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) return reply.code(404).send({ error: '目录不存在' });
    if (fs.existsSync(to)) return reply.code(409).send({ error: '同名文件夹或文件已存在' });
    fs.renameSync(from, to);
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'update',
      resource: 'resource',
      resourceName: path.basename(to),
      description: `重命名了文件夹「${path.basename(from)}」为「${path.basename(to)}」`,
    });
    return { path: relOf(to) };
  });

  // 删除文件夹（递归）。
  app.delete('/api/resources/folders', { preHandler: [auth, requireCap('resources')] }, async (req, reply) => {
    const rel = String((req.query as { path?: string }).path ?? '');
    let abs: string;
    try {
      abs = resolveResourcePath(root, rel);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (abs === root) return reply.code(400).send({ error: '不能删除根目录' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return reply.code(404).send({ error: '目录不存在' });
    fs.rmSync(abs, { recursive: true, force: true });
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'delete',
      resource: 'resource',
      resourceName: path.basename(abs),
      description: `删除了文件夹「${path.basename(abs)}」`,
    });
    return { ok: true };
  });

  // 上传 csv / xlsx / xls 文件到指定目录（path 字段须先于 file 字段提交）。
  app.post('/api/resources/files', { preHandler: [auth, requireCap('resources')] }, async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: '缺少上传文件' });
    const relDir = String((part.fields.path as { value?: string } | undefined)?.value ?? '');
    const filename = path.basename(part.filename ?? '');
    if (!filename) return reply.code(400).send({ error: '文件名无效' });
    if (!isAllowedResourceFile(filename)) return reply.code(400).send({ error: '仅支持 csv / xlsx / xls 文件' });
    const buf = await part.toBuffer();
    if (buf.byteLength > MAX_FILE_BYTES) return reply.code(413).send({ error: '文件过大' });

    let dirAbs: string;
    let fileAbs: string;
    try {
      dirAbs = resolveResourcePath(root, relDir);
      fileAbs = resolveResourcePath(root, relDir ? `${relDir}/${filename}` : filename);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    fs.mkdirSync(dirAbs, { recursive: true });
    if (fs.existsSync(fileAbs)) return reply.code(409).send({ error: '同名文件已存在' });
    fs.writeFileSync(fileAbs, buf);
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'create',
      resource: 'resource',
      resourceName: filename,
      description: `上传了资源文件「${filename}」`,
    });
    return reply.code(201).send({ name: filename, path: relOf(fileAbs), size: buf.byteLength });
  });

  // 重命名文件。
  app.patch('/api/resources/files', { preHandler: [auth, requireCap('resources')] }, async (req, reply) => {
    const { path: rel = '', name = '' } = (req.body ?? {}) as { path?: string; name?: string };
    const trimmed = name.trim();
    if (!trimmed) return reply.code(400).send({ error: '文件名不能为空' });
    if (!isAllowedResourceFile(trimmed)) return reply.code(400).send({ error: '仅支持 csv / xlsx / xls 文件' });
    const parentRel = rel.split('/').slice(0, -1).join('/');
    let from: string;
    let to: string;
    try {
      from = resolveResourcePath(root, rel);
      to = resolveResourcePath(root, parentRel ? `${parentRel}/${trimmed}` : trimmed);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return reply.code(404).send({ error: '文件不存在' });
    if (fs.existsSync(to)) return reply.code(409).send({ error: '同名文件夹或文件已存在' });
    fs.renameSync(from, to);
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'update',
      resource: 'resource',
      resourceName: path.basename(to),
      description: `重命名了资源文件「${path.basename(from)}」为「${path.basename(to)}」`,
    });
    return { path: relOf(to) };
  });

  // 删除文件。
  app.delete('/api/resources/files', { preHandler: [auth, requireCap('resources')] }, async (req, reply) => {
    const rel = String((req.query as { path?: string }).path ?? '');
    let abs: string;
    try {
      abs = resolveResourcePath(root, rel);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: '文件不存在' });
    fs.rmSync(abs, { force: true });
    deps.audit.record({
      userId: req.auth!.userId,
      action: 'delete',
      resource: 'resource',
      resourceName: path.basename(abs),
      description: `删除了资源文件「${path.basename(abs)}」`,
    });
    return { ok: true };
  });

  // 下载文件。
  app.get('/api/resources/files/download', { preHandler: [auth, requireAnyCap('resources', 'dashboard.edit')] }, async (req, reply) => {
    const rel = String((req.query as { path?: string }).path ?? '');
    let abs: string;
    try {
      abs = resolveResourcePath(root, rel);
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return reply.code(404).send({ error: '文件不存在' });
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    reply.type('application/octet-stream');
    return reply.send(fs.createReadStream(abs));
  });
}
