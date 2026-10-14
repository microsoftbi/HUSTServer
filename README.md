# HUSTServer

HUSTServer 是一个基于 [HUSTERYX](https://github.com/microsoftbi/HUSTERYX) 引擎的**数据集成工作流托管平台**：在工作站用 HUSTERYX 桌面工具设计的 ETL 工作流（`.htyx`）可以上传到服务端统一托管，也可以直接在浏览器里用内置的 **Web 工作流设计器** 从零搭建；平台负责调度执行、运行日志、数据连接与权限管理。

## 功能总览

- 上传 `.htyx` 工作流并绑定数据文件，托管运行
- **Web 工作流设计器**：浏览器内拖拽搭建 / 编辑工作流，保存即发布
- 手动运行 + Cron 调度，节点级状态与实时日志
- SQL Server / MySQL 连接管理（密码加密存储、界面掩码显示）
- 用户与角色（admin / user）、会话认证
- 系统设置（并发数、日志保留期、共享目录、时区）

## 界面一览

### 登录

所有页面均需登录访问；首次启动自动创建初始管理员。

![登录页](docs/images/login.png)

### 控制台首页

登录后进入首页，从左侧导航前往各功能页面。

![控制台首页](docs/images/home.png)

### 工作流列表

查看全部工作流，支持删除，并可从「上传工作流」「新建画布」两个入口创建。

![工作流列表](docs/images/workflow-list.png)

### 上传工作流与数据绑定

上传 HUSTERYX 导出的 `.htyx` 工作流文件，为输入节点上传 CSV / Excel 数据文件并建立路径映射，使作者本机路径在服务端重新落地。

![上传工作流](docs/images/workflow-upload.png)

### 工作流详情与调度

查看工作流信息与运行历史，支持手动立即运行，并可配置 Cron 调度自动执行。

![工作流详情](docs/images/workflow-detail.png)

### Web 工作流设计器

内置完整画布设计器（复用 HUSTERYX 前端）：支持 **13 种节点**（CSV / Excel / SQL Server 输入，Select / Filter / Join / Union / Aggregation / Sort 转换，CSV / Excel / SQL Server / Browser 输出），拖拽连线、成环检测与端口约束、节点配置面板编辑；既可从「新建画布」从零搭建，也可从列表 / 详情进入编辑既有工作流，保存即发布到平台。

![Web 工作流设计器](docs/images/designer.png)

### 数据连接管理

平台级共享连接库；工作流内 SQL Server 节点的连接可在「数据连接」页按工作流单独维护。连接密码**加密存储**，界面仅显示掩码（`******`），留空表示沿用原值。

![连接管理](docs/images/connections.png)

![工作流数据连接](docs/images/workflow-connections.png)

### 运行详情与日志

每次运行按拓扑顺序执行各节点，页面展示节点级状态（成功 / 失败 / 行数 / 耗时）与完整执行日志，日志通过 SSE 实时推送。

![运行详情](docs/images/run-detail.png)

### 用户管理

管理员可创建用户、重置密码、停用 / 启用账号；普通用户只能访问自己拥有的工作流。

![用户管理](docs/images/users.png)

### 系统设置

调整最大并发运行数、日志保留天数、共享目录与时区，数据库配置优先于环境变量默认值。

![系统设置](docs/images/settings.png)

## 项目结构

```
HUSTServer/
├── apps/
│   ├── server/            # Fastify 5 + better-sqlite3（API、调度、运行编排、静态托管）
│   └── web/               # React 19 + Vite + Tailwind v4 管理控制台
├── packages/
│   ├── engine/            # HUSTERYX 执行引擎移植（DuckDB + mssql，基线 39451d8）
│   └── workflow-designer/ # HUSTERYX 前端画布复用包（基线 836b22a，适配器注入平台能力）
└── docs/                  # 设计文档与截图
```

## 快速开始

环境要求：Node.js ≥ 20、pnpm。

```bash
pnpm install
pnpm build          # 构建全部包（server / web / engine / workflow-designer）
```

启动服务（需提供会话密钥与 32 字节加密密钥）：

```bash
SESSION_SECRET=please-change-me \
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
BOOTSTRAP_ADMIN_USER=admin \
BOOTSTRAP_ADMIN_PASSWORD=your-password \
node apps/server/dist/index.js
```

访问 `http://127.0.0.1:8787` 即可使用。常用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HUSTSERVER_HOST` / `HUSTSERVER_PORT` | `127.0.0.1` / `8787` | 监听地址与端口 |
| `HUSTSERVER_DATA_DIR` | `~/.hustserver` | 数据目录（SQLite、上传、输出） |
| `SESSION_SECRET` | 必填 | 会话签名密钥 |
| `ENCRYPTION_KEY` | 必填 | 64 位十六进制（32 字节）连接密码加密密钥 |
| `BOOTSTRAP_ADMIN_USER` / `BOOTSTRAP_ADMIN_PASSWORD` | `admin` / 随机生成 | 初始管理员；未设置密码时随机密码仅打印一次到日志 |
| `MAX_CONCURRENT_RUNS` | `2` | 最大并发运行数 |
| `LOG_RETENTION_DAYS` | `90` | 运行日志保留天数 |

开发模式：

```bash
pnpm dev            # 并行启动 server（tsx watch）与 web（vite，/api 代理到 8787）
pnpm test           # 运行全部单元测试
```

## 安全设计

- SQL Server 连接密码使用 `ENCRYPTION_KEY` 加密落库，工作流 payload 中**绝不包含明文连接**
- 设计器载入时连接以掩码回填，保存发布时密码留空表示沿用原值，防止掩码覆盖真实密码
- 全部 API 经会话 Cookie 认证 + 工作流级属主 / 管理员（RBAC）授权
- 保存发布采用事务化连接对账，删除节点后遗留的连接配置同步清理，避免节点 ID 复用时旧配置「复活」

## 相关项目

- [HUSTERYX](https://github.com/microsoftbi/HUSTERYX) —— 本项目的MacOS Desktop Designer。
