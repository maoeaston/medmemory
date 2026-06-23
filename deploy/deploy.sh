#!/usr/bin/env bash
set -euo pipefail

# ===== 配置 =====
SERVER_IP="<填你的服务器公网 IP>"
SERVER_USER="ubuntu"        # 腾讯轻量 Ubuntu 默认用户; 如果是 lighthouse 就改这里
REMOTE_DIR="/var/www/medmemory"
# ================

echo "📦 Building..."
npm run build

echo "📤 Uploading to ${SERVER_USER}@${SERVER_IP}:${REMOTE_DIR}/ ..."
rsync -avz --delete dist/ "${SERVER_USER}@${SERVER_IP}:${REMOTE_DIR}/"

echo "✅ Done! Visit: https://maohedong.top"
