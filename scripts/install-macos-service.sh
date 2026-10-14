#!/usr/bin/env bash
# HUSTServer macOS LaunchAgent 安装脚本（无 Docker）
#
# 用法：
#   bash scripts/install-macos-service.sh             # 安装并启动（开机自启 + 崩溃自拉起）
#   bash scripts/install-macos-service.sh --uninstall  # 停止并卸载
#
# 前置：已执行 `pnpm install && pnpm -r build`（需要 apps/server/dist/index.js 与 apps/web/dist）。
set -euo pipefail
umask 077

LABEL="com.hustserver.app"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENTRY="$REPO_ROOT/apps/server/dist/index.js"
WEB_INDEX="$REPO_ROOT/apps/web/dist/index.html"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/HUSTServer"

uninstall() {
  launchctl unload "$PLIST_FILE" >/dev/null 2>&1 || true
  rm -f "$PLIST_FILE"
  echo "已卸载 $LABEL（.env 与数据目录保持不变）"
}

if [[ "${1:-}" == "--uninstall" ]]; then
  uninstall
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "错误：未找到 node，请先安装 Node >= 20" >&2
  exit 1
fi
if [[ ! -f "$ENTRY" ]]; then
  echo "错误：缺少 $ENTRY，请先执行 pnpm -r build" >&2
  exit 1
fi
if [[ ! -f "$WEB_INDEX" ]]; then
  echo "警告：未找到前端产物 $WEB_INDEX，服务将只提供 API" >&2
fi

# 1) 首次安装生成 .env（含随机密钥），已存在则复用
if [[ ! -f "$ENV_FILE" ]]; then
  SESSION_SECRET="$(openssl rand -hex 32)"
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
HUSTSERVER_HOST=127.0.0.1
HUSTSERVER_PORT=8787
HUSTSERVER_DATA_DIR=$HOME/.hustserver
HUSTSERVER_SHARED_DIRS=
SESSION_SECRET=$SESSION_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY
SESSION_TTL_MS=$((7 * 24 * 60 * 60 * 1000))
MAX_CONCURRENT_RUNS=2
RUN_MAX_RETRIES=1
LOG_RETENTION_DAYS=90
DUCKDB_MEMORY_LIMIT=2GB
TZ=Asia/Shanghai
BOOTSTRAP_ADMIN_USER=admin
BOOTSTRAP_ADMIN_PASSWORD=
EOF
  chmod 600 "$ENV_FILE"
  echo "已生成 $ENV_FILE（权限 600）"
else
  echo "复用已有 $ENV_FILE"
fi

# 2) 把 .env 的 KEY=VALUE 转为 plist 的 EnvironmentVariables 片段（XML 转义）
ENV_XML=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  [[ -z "$key" ]] && continue
  value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"
  ENV_XML+="        <key>$key</key>"$'\n'"        <string>$value</string>"$'\n'
done < "$ENV_FILE"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

# 3) 写 LaunchAgent plist（RunAtLoad 随登录启动；KeepAlive 崩溃自拉起）
cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
      <string>$NODE_BIN</string>
      <string>$ENTRY</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
$ENV_XML    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>
  </dict>
</plist>
EOF

chmod 600 "$PLIST_FILE"

# 4) 重新加载
launchctl unload "$PLIST_FILE" >/dev/null 2>&1 || true
launchctl load "$PLIST_FILE"

echo "已安装并启动 $LABEL"
echo "  日志：$LOG_DIR/stdout.log"
echo "  查看：launchctl list | grep $LABEL"
