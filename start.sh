#!/bin/sh
# Healthy · 启动脚本（macOS / Linux）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node.js 22.5 或更高版本"
  exit 1
fi

echo "正在启动 Healthy ... 打开 http://localhost:3000"
node --experimental-sqlite --no-warnings server/app.js
