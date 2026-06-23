#!/usr/bin/env bash
# ============================================================
# deploy/deploy-sync.sh — 部署 sync-server 到远程服务器
# ============================================================
# 用法: ./deploy/deploy-sync.sh [user@host]
#
# 步骤:
#   1. rsync server/ → 远程:/opt/medmemory-sync/
#   2. ssh npm install --production
#   3. ssh systemctl restart medmemory-sync
#   4. curl 验证 /api/sync/state
# ============================================================

set -euo pipefail

REMOTE="${1:-root@maohedong.top}"
REMOTE_DIR="/opt/medmemory-sync"
DATA_DIR="/var/www/medmemory-sync"

echo "==> 1/4 rsync server/ → ${REMOTE}:${REMOTE_DIR}/"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  "$(dirname "$0")/../server/" \
  "${REMOTE}:${REMOTE_DIR}/"

echo "==> 2/4 npm install (production)"
ssh "${REMOTE}" "cd ${REMOTE_DIR} && npm install --production"

echo "==> 3/4 systemctl restart medmemory-sync"
ssh "${REMOTE}" "systemctl restart medmemory-sync"

echo "==> 4/4 验证"
sleep 1
TOKEN=$(ssh "${REMOTE}" "systemctl show medmemory-sync --property=Environment | grep -oP 'SYNC_TOKEN=\K[^ ]+' || true")
if [ -z "$TOKEN" ]; then
  echo "WARNING: 无法自动读取 SYNC_TOKEN, 跳过带认证的验证"
  curl -s "https://maohedong.top/api/sync/state" | head -1
else
  curl -s -H "X-Sync-Token: ${TOKEN}" "https://maohedong.top/api/sync/state" | head -1
fi

echo ""
echo "部署完成。"
