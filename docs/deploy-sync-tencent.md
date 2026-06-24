# 腾讯云部署 sync-server 执行清单（给龙虾）

> 目标：在已部署 MedMemory 前端的腾讯服务器（124.220.104.199）上加挂 sync-server，让多端同步可用。
>
> 现状：前端 PWA 已通过 `cp -r dist/* /var/www/medmemory/` 部署，Nginx 监听 8080 (HTTP) / 8443 (HTTPS)。本清单**只加 sync 后端**，不动前端文件。
>
> 执行人：龙虾（root 或 sudo 权限）。所有命令在服务器本地执行。

---

## 0. 前置检查

```bash
# Node 18+ 必须（sync-server 用 ESM + Express 4.21 + multer 2.0）
node -v
# 期望: v18.x 或更高。若低于 18 或未装:
#   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
#   sudo apt install -y nodejs

# npm
npm -v

# /opt/medmemory 必须已存在（前端部署时已 clone）
ls /opt/medmemory/server/sync-server.js
# 期望: 文件存在。若否: cd /opt/medmemory && git pull

# 端口 3001 未占用（sync-server 内部端口）
ss -lnt | grep :3001 || echo "3001 空闲, OK"
```

---

## 1. 建数据目录

```bash
sudo mkdir -p /var/www/medmemory-sync
sudo chown -R www-data:www-data /var/www/medmemory-sync
sudo chmod 750 /var/www/medmemory-sync
```

这个目录存 `lock.json` + `snapshot.zip` + `version.txt`。家庭 2 人场景，zip 通常几十 MB，磁盘占用可忽略。

---

## 2. 部署 sync-server 代码

代码已在 `/opt/medmemory/server/`（前端 repo 一部分）。**不要**把 server 跑在 git 工作区里——`git pull` 时可能撞到 `node_modules`。复制到独立目录：

```bash
sudo mkdir -p /opt/medmemory-sync
sudo cp -r /opt/medmemory/server/* /opt/medmemory-sync/
sudo chown -R www-data:www-data /opt/medmemory-sync
cd /opt/medmemory-sync
sudo -u www-data npm install --omit=dev
```

依赖只有 `express` + `multer`，约 70 个包，几秒装完。

---

## 3. 生成 Sync Token

客户端和服务器共享的认证 token。**生成后必须保存**，客户端配置要填：

```bash
TOKEN=$(openssl rand -hex 32)
echo "=========================================="
echo "保存这个 token, 客户端配置需要填入:"
echo "$TOKEN"
echo "=========================================="
# 写到只有 root 可读的文件备份
echo "$TOKEN" | sudo tee /opt/medmemory-sync/.sync-token > /dev/null
sudo chmod 600 /opt/medmemory-sync/.sync-token
```

---

## 4. 安装 systemd service

```bash
# 4.1 拷贝模板（repo 自带）
sudo cp /opt/medmemory/deploy/medmemory-sync.service /etc/systemd/system/

# 4.2 用步骤 3 生成的 token 替换占位符
sudo sed -i "s|CHANGE_ME_TO_YOUR_TOKEN|$TOKEN|" /etc/systemd/system/medmemory-sync.service
# 验证替换成功 (应显示实际 token, 不是 CHANGE_ME):
grep SYNC_TOKEN /etc/systemd/system/medmemory-sync.service

# 4.3 启动
sudo systemctl daemon-reload
sudo systemctl enable medmemory-sync
sudo systemctl start medmemory-sync

# 4.4 检查运行状态
sudo systemctl status medmemory-sync --no-pager
# 期望: active (running)。若 failed, 看:
#   sudo journalctl -u medmemory-sync -n 50 --no-pager
```

**常见失败**：
- `Permission denied: /var/www/medmemory-sync` → `www-data` 没有该目录写权限，回步骤 1
- `Cannot find module 'express'` → 步骤 2 的 `npm install` 没在 `/opt/medmemory-sync/` 里跑
- `EADDRINUSE :::3001` → 3001 被占，回步骤 0 检查

---

## 5. 改 Nginx 配置（关键，**编辑不替换**）

Nginx 当前已有监听 8080 + 8443 的 server block。**只加两段内容**：COEP 头 + `/api/` 反代。

### 5.1 先找配置文件位置

```bash
# 主配置
sudo nginx -T 2>/dev/null | grep -E "server_name|listen|root " | head -20
# 常见位置:
#   /etc/nginx/sites-available/maohedong.top
#   /etc/nginx/conf.d/medmemory.conf
#   /etc/nginx/nginx.conf (单文件场景)
```

### 5.2 编辑对应 server block

打开步骤 5.1 找到的配置文件，**在 HTTPS server block 内**（`listen 8443` 那个）加两段：

```nginx
server {
    listen 8443 ssl;
    server_name maohedong.top;
    # ... 现有 ssl_certificate / root / location / 等保持不动 ...

    # === 新增 1: COOP/COEP/CORP 全局头 (sqlite-wasm OPFS 硬约束) ===
    # always = 确保 4xx/5xx 错误响应也带头
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;

    # === 新增 2: /api/ 反代到 sync-server ===
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # zip 上传可能大
        client_max_body_size 500M;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    # 现有 location / 保持不动
}
```

**HTTP server block（`listen 8080`）也加同样的内容**，保证 http://124.220.104.199:8080 也能同步（COEP 是硬约束，不加会导致 sqlite-wasm 启动失败）。

### 5.3 校验 + 重载

```bash
sudo nginx -t
# 期望: syntax is ok / test is successful
sudo nginx -s reload
```

---

## 6. 端到端验证

```bash
# 6.1 state 端点（无需 auth，公开）
curl -s https://maohedong.top:8443/api/sync/state
# 期望: {"state":"idle","version":0,"lock":null}

# 6.2 带认证的 snapshot 端点（应返回 NO_SNAPSHOT, 因为还没 seed）
TOKEN=$(sudo cat /opt/medmemory-sync/.sync-token)
curl -s -H "X-Sync-Token: $TOKEN" https://maohedong.top:8443/api/sync/snapshot
# 期望: {"error":"NO_SNAPSHOT","message":"..."}

# 6.3 COEP 头验证（关键, sqlite-wasm 需要）
curl -sI https://maohedong.top:8443/ | grep -i "cross-origin"
# 期望三行:
#   cross-origin-opener-policy: same-origin
#   cross-origin-embedder-policy: require-corp
#   cross-origin-resource-policy: same-origin

curl -sI https://maohedong.top:8443/api/sync/state | grep -i "cross-origin"
# 同样三行（/api/ 也要带, 否则 fetch 会被 COEP 拦截）
```

**6.1 返回 `Connection refused` 或 502**：systemd 没起来 → 回步骤 4.4
**6.3 缺头**：Nginx 没生效 → 回步骤 5.3，确认改的是 8443 server block

---

## 7. 客户端配置

打开 MedMemory 网页 → 设置 → 多端同步：

| 字段 | 值 |
|---|---|
| Server URL | `https://maohedong.top:8443` |
| Token | 步骤 3 生成的 token |
| Client Label | 自己起名（如「我的手机」） |

点「测试连接」应返回 ok。首次点「上传覆盖」执行 seed（步骤 6.2 后就会有 snapshot）。

---

## 8. 日常更新工作流（前端 + sync 代码都改了时）

repo 现在含前端 + sync 后端。push 到 GitHub 后服务器上：

```bash
cd /opt/medmemory
git pull

# 8.1 前端构建 + 部署（原流程不变）
npm install
npm run build
sudo cp -r dist/* /var/www/medmemory/

# 8.2 sync-server 更新（仅当 server/ 下文件有变化时）
if git diff HEAD@{1} --stat -- server/ | grep -q "server/"; then
  sudo cp -r /opt/medmemory/server/* /opt/medmemory-sync/
  sudo chown -R www-data:www-data /opt/medmemory-sync
  cd /opt/medmemory-sync && sudo -u www-data npm install --omit=dev
  sudo systemctl restart medmemory-sync
  echo "sync-server 已更新"
fi
```

把这段存为 `/opt/medmemory/deploy-update.sh`，以后一条命令搞定。

---

## 9. 故障排查速查

| 症状 | 排查命令 | 可能原因 |
|---|---|---|
| 客户端连不上 | `curl https://maohedong.top:8443/api/sync/state` | Nginx 没配 / 端口未放行 |
| 502 Bad Gateway | `sudo systemctl status medmemory-sync` | sync-server 挂了 |
| 401 Unauthorized | 检查客户端 Token 与 `/opt/medmemory-sync/.sync-token` 一致 | Token 不匹配 |
| sqlite-wasm 启动失败 | `curl -sI https://maohedong.top:8443/ \| grep cross-origin` | COEP 头没加 |
| 上传 zip 413 | `curl -sI https://maohedong.top:8443/api/sync/state` 看是否有 `client_max_body_size` | Nginx `client_max_body_size` 太小 |
| 锁长时间不释放 | `sudo cat /var/www/medmemory-sync/lock.json` | TTL 30 分钟，或客户端异常退出未 checkin |

---

## 10. 安全注意事项

- `/var/www/medmemory-sync/` 目录权限 750，只 `www-data` 可读写。snapshot.zip 含全家人病史，**不能让 web 直接访问**（Nginx 的 `root` 指向 `/var/www/medmemory`，不是这里，所以默认安全）。
- Token 保存在 `/opt/medmemory-sync/.sync-token`（600 权限），不要入 git，不要在聊天里贴明文。
- 服务器重启后 systemd 自动拉起 sync-server（步骤 4.3 的 `enable`）。
- 8443 证书过期后 Nginx 会启动失败，注意续期。
