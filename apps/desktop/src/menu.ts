import { app, dialog, Menu, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface MenuOptions {
  getWindow: () => BrowserWindow | null;
  dataDir: string;
  resourceDir: string;
  logFile: string;
  serverUrl: string;
}

export function buildMenu(opts: MenuOptions): Menu {
  const reload = (): void => {
    const win = opts.getWindow();
    if (!win) return;
    win.loadURL(opts.serverUrl);
  };

  const openDir = (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: reload },
        { type: 'separator' },
        { label: '打开数据目录', click: () => openDir(opts.dataDir) },
        { label: '打开资源库目录', click: () => openDir(opts.resourceDir) },
        { label: '打开服务日志', click: () => void shell.openPath(path.resolve(opts.logFile)) },
        { type: 'separator' },
        {
          label: '在浏览器中打开',
          click: () => void shell.openExternal(opts.serverUrl),
        },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重载界面' },
        { role: 'forceReload', label: '强制重载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于个人数据工作台',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: '个人数据工作台',
              detail: [
                `版本：${app.getVersion()}`,
                `Electron：${process.versions.electron}`,
                `本地服务：${opts.serverUrl}`,
                `数据目录：${opts.dataDir}`,
              ].join('\n'),
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
