import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMenu } from './menu';
import { startServer, type ServerHandle } from './server';

// Electron 从源码目录启动时 app.isPackaged 也可能为 true，改用显式环境变量区分。
const isDev = process.env.HUSTSERVER_DESKTOP_DEV === '1';

interface Layout {
  entry: string;
  webDir: string;
  resourceDir: string;
  electronNode: boolean;
}

/** 开发态复用仓库构建产物与系统 Node；打包态读取 Resources 下的服务与前端。 */
function resolveLayout(): Layout {
  // 资源库统一放在数据目录内，网页端与桌面版共用。
  const resourceDir = path.join(os.homedir(), '.hustserver/resources');
  if (isDev) {
    const repoRoot = path.resolve(app.getAppPath(), '../..');
    return {
      entry: path.join(repoRoot, 'apps/server/dist/index.js'),
      webDir: path.join(repoRoot, 'apps/web/dist'),
      resourceDir,
      electronNode: false,
    };
  }
  return {
    entry: path.join(process.resourcesPath, 'runtime/server/dist/index.js'),
    webDir: path.join(process.resourcesPath, 'runtime/web'),
    resourceDir,
    electronNode: true,
  };
}

function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    show: true,
    backgroundColor: '#0f1115',
    webPreferences: { sandbox: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#0f1115;color:#e6e9ef;
      font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
      display:flex;align-items:center;justify-content:center;user-select:none}
    .box{text-align:center}
    .name{font-size:17px;font-weight:600;letter-spacing:.5px}
    .hint{margin-top:10px;font-size:12px;color:#8b93a7}
    .bar{margin:22px auto 0;width:180px;height:3px;border-radius:2px;background:#1e2430;overflow:hidden}
    .bar span{display:block;width:60px;height:100%;border-radius:2px;background:#4c8dff;
      animation:slide 1.1s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-60px)}100%{transform:translateX(180px)}}
  </style></head><body><div class="box">
    <div class="name">个人数据工作台</div>
    <div class="hint">正在启动本地服务…</div>
    <div class="bar"><span></span></div>
  </div></body></html>`;
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

function createMainWindow(serverUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#0f1115',
    title: '个人数据工作台',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 外链一律交给系统浏览器，避免在应用窗口内跳出业务页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => win.show());
  void win.loadURL(serverUrl);
  return win;
}

let server: ServerHandle | undefined;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

async function bootstrap(): Promise<void> {
  const layout = resolveLayout();
  const splash = createSplash();

  try {
    if (!fs.existsSync(layout.webDir)) {
      throw new Error(`缺少前端产物：${layout.webDir}\n请先执行 pnpm build。`);
    }
    server = await startServer({
      entry: layout.entry,
      webDir: layout.webDir,
      resourceDir: layout.resourceDir,
      electronNode: layout.electronNode,
      onExit: (code) => {
        if (quitting) return;
        dialog.showErrorBox(
          '本地服务已退出',
          `服务进程意外退出（code=${code}）。\n\n日志：${server?.logFile ?? ''}`,
        );
        app.quit();
      },
    });
  } catch (err) {
    splash.destroy();
    dialog.showErrorBox('启动失败', (err as Error).message);
    app.quit();
    return;
  }

  mainWindow = createMainWindow(server.url);
  mainWindow.once('ready-to-show', () => splash.destroy());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  buildMenu({
    getWindow: () => mainWindow,
    dataDir: server.dataDir,
    resourceDir: layout.resourceDir,
    logFile: server.logFile,
    serverUrl: server.url,
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    void bootstrap();
  });

  app.on('activate', () => {
    if (mainWindow) mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // 先关服务再退出，确保 SQLite/DuckDB 正常落盘
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (server ? server.stop() : Promise.resolve()).finally(() => app.exit(0));
  });
}
