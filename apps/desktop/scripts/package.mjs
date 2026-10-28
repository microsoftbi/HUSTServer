import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '../..');
const stage = path.join(appDir, 'build/stage');
const bin = (name) => path.join(appDir, 'node_modules/.bin', name);

const run = (cmd, args, cwd = repoRoot) => execFileSync(cmd, args, { stdio: 'inherit', cwd });
const step = (msg) => console.log(`\n▶ ${msg}`);

step('构建 engine / server / web');
run('pnpm', ['--filter', '@hustserver/engine', 'build']);
run('pnpm', ['--filter', '@hustserver/server', 'build']);
run('pnpm', ['--filter', '@hustserver/web', 'build']);

step('组装服务端运行时（pnpm deploy）');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
run('pnpm', ['--filter', '@hustserver/server', 'deploy', '--prod', '--legacy', path.join(stage, 'server')]);
for (const name of ['src', 'test', 'tsconfig.json', 'vitest.config.ts', 'apps']) {
  fs.rmSync(path.join(stage, 'server', name), { recursive: true, force: true });
}

step('复制前端产物');
fs.cpSync(path.join(repoRoot, 'apps/web/dist'), path.join(stage, 'web'), { recursive: true });

step('编译 Electron 主进程');
run('node', [path.join(here, 'build-main.mjs')], appDir);

step('打包 macOS 应用');
run(bin('electron-builder'), ['--mac', 'dmg', '--arm64'], appDir);
