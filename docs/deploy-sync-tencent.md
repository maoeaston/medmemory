# 腾讯云部署 sync-server 执行清单（给龙虾）

> 目标：在已部署 MedMemory 前端的腾讯服务器（124.220.104.199）上加挂 sync-server，让多端同步可用。
>
> 现状（2026-06-24 龙虾首次部署后修订）：
> - 前端 PWA 已通过 `cp -r dist/* /var/www/medmemory/` 部署
> - Web Server 实际是 **Caddy**（不是 Nginx），监听 8080 (HTTP) / 8443 (HTTPS)
> - Node 22 通过 nvm 安装在 `/root/.nvm/...`
>
> 本清单**只加 sync 后端**，不动前端文件。
>
> 执行人：龙虾（root 或 sudo 权限）。所有命令在服务器本地执行。

---

## 0. 前置检查

```bash
# Node 18+ 必须（sync-server 用 ESM + Express 4.21 + multer 2.0）
node -v
# 期望: v18.x 或更高。本服务器实测 v22.22.2 (nvm 安装)

# npm
npm -v

# /opt/medmemory 必须已存在（前端部署时已 clone）
ls /opt/medmemory/server/sync-server.js
# 期望: 文件存在。若否: cd /opt/medmemory && git pull

# 端口 3001 未占用（sync-server 内部端口）
ss -lnt | grep :3001 || echo "3001 空闲, OK"

# 确认 Web Server 是 Caddy (不是 Nginx)
sudo systemctl status caddy --no-pager | head -5
# 期望: active (running)。若实际是 Nginx, 参考 deploy/sync-nginx.conf.example
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

# npm install 用 root 跑（www-data 的 PATH 没有 npm，尤其 nvm 安装的 Node）
cd /opt/medmemory-sync
sudo npm install --omit=dev
sudo chown -R www-data:www-data /opt/medmemory-sync
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

### 4.1 处理 Node 二进制路径（nvm 场景必做）

模板里 `ExecStart=/usr/bin/node`，但 nvm 装的 Node 在 `/root/.nvm/versions/node/vXX.X.X/bin/node`，`www-data` 无法访问 `/root/`（权限 700）。两种解法二选一：

```bash
# 解法 A（推荐, 简单）: 复制 node 二进制到 /usr/local/bin
sudo cp "$(which node)" /usr/local/bin/node
sudo chmod 755 /usr/local/bin/node
# 之后 service 里 ExecStart 用 /usr/local/bin/node

# 解法 B: 系统级安装 Node（apt 或 nodesource），让 /usr/bin/node 真存在
```

### 4.2 拷贝模板 + 替换占位符

```bash
sudo cp /opt/medmemory/deploy/medmemory-sync.service /etc/systemd/system/

# 替换 token
sudo sed -i "s|CHANGE_ME_TO_YOUR_TOKEN|$TOKEN|" /etc/systemd/system/medmemory-sync.service

# 替换 Node 路径（如果走解法 A）
sudo sed -i "s|/usr/bin/node|/usr/local/bin/node|" /etc/systemd/system/medmemory-sync.service

# 验证替换（应显示实际 token + 实际 node 路径）
grep -E "SYNC_TOKEN|ExecStart" /etc/systemd/system/medmemory-sync.service
```

### 4.3 启动

```bash
sudo systemctl daemon-reload
sudo systemctl enable medmemory-sync
sudo systemctl start medmemory-sync

sudo systemctl status medmemory-sync --no-pager
# 期望: active (running)。若 failed, 看:
#   sudo journalctl -u medmemory-sync -n 50 --no-pager
```

**常见失败**：
- `Permission denied: /var/www/medmemory-sync` → `www-data` 没有该目录写权限，回步骤 1
- `Cannot find module 'express'` → 步骤 2 的 `npm install` 没在 `/opt/medmemory-sync/` 里跑
- `EADDRINUSE :::3001` → 3001 被占，回步骤 0 检查
- `Status=203/EXEC` 或 `code=exited status=203` → Node 路径错，回 4.1

---

## 5. 改 Caddy 配置（关键，**编辑不替换**）

Caddy 当前已有监听 8080 + 8443 的配置。**只加两段内容**：COEP 头 + `/api/` 反代。

### 5.1 找 Caddyfile 位置

```bash
# 常见位置:
ls /etc/caddy/Caddyfile 2>/dev/null && echo "found"
# 或通过 systemd 看启动参数:
sudo systemctl cat caddy | grep -i "ExecStart"
```

### 5.2 编辑 site block

**⚠️ Caddy 的 `try_files` 会被编译到路由最前面**，导致 `/api/*` 在到反代前就被改写成 `/index.html`。**必须用 `handle` 块显式控制顺序**，`/api/*` 在前，兜底 `handle` 在后：

```caddyfile
maohedong.top:8443 {
    # === COOP/COEP/CORP 全局头 (sqlite-wasm OPFS 硬约束) ===
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "require-corp"
        Cross-Origin-Resource-Policy "same-origin"
    }

    # === /api/ 反代到 sync-server（必须在前）===
    handle /api/* {
        reverse_proxy 127.0.0.1:3001 {
            # 大文件上传: zip 可能几十 MB
            transport http {
                read_timeout 300s
            }
        }
        # Caddy 默认不限制 request body, 但加显式提示
        request_body {
            max_size 500MB
        }
    }

    # === 静态文件兜底（必须在后）===
    handle {
        encode gzip zstd
        root * /var/www/medmemory
        try_files {path} /index.html
        file_server
    }
}

# 8080 HTTP site block 加同样内容（COEP 是硬约束, 不加 sqlite-wasm 启动失败）
:8080 {
    # ... 同上结构 ...
}
```

**关键约束**：
- 不要把 `try_files` 写在 site 顶层（会被 Caddy 编译到路由前）
- `handle /api/*` 必须在兜底 `handle {}` 之前
- `header {}` 块对所有响应生效（含 4xx/5xx），等价于 Nginx 的 `always`

### 5.3 校验 + 重载

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
# 期望: OK

sudo systemctl reload caddy
# 不是 restart! reload 不丢连接
```

---

## 6. 端到端验证

```bash
# 6.1 state 端点（无需 auth，公开）
curl -s https://maohedong.top:8443/api/sync/state
# 期望: {"lockedBy":null,"lockedAt":null,"version":0,"expiresAt":null,
#        "hasSnapshot":false,"snapshotSize":0,"serverTime":"..."}

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

# HTTP 8080 同样验证一遍（COEP 是硬约束, HTTP 也要带）
curl -sI http://124.220.104.199:8080/ | grep -i "cross-origin"
curl -sI http://124.220.104.199:8080/api/sync/state | grep -i "cross-origin"
```

**6.1 返回 `Connection refused` 或 502**：systemd 没起来 → 回步骤 4.3
**6.3 缺头**：Caddy 没生效 → 回步骤 5.3，确认改对了 site block
**6.3 `/api/` 缺头但前端有**：`handle /api/*` 块漏了 `header` 指令 → site 级 `header {}` 应该已覆盖, 但若把 header 移进了 `handle {}` 里就会漏

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
  cd /opt/medmemory-sync && sudo npm install --omit=dev
  sudo chown -R www-data:www-data /opt/medmemory-sync
  sudo systemctl restart medmemory-sync
  echo "sync-server 已更新"
fi
```

把这段存为 `/opt/medmemory/deploy-update.sh`，以后一条命令搞定。

---

## 9. 故障排查速查

| 症状 | 排查命令 | 可能原因 |
|---|---|---|
| 客户端连不上 | `curl https://maohedong.top:8443/api/sync/state` | Caddy 没配 / 端口未放行 |
| 502 Bad Gateway | `sudo systemctl status medmemory-sync` | sync-server 挂了 |
| 401 Unauthorized | 检查客户端 Token 与 `/opt/medmemory-sync/.sync-token` 一致 | Token 不匹配 |
| sqlite-wasm 启动失败 | `curl -sI https://maohedong.top:8443/ \| grep cross-origin` | COEP 头没加（HTTP 8080 也要加） |
| `/api/` 返回 index.html | 检查 Caddyfile `handle /api/*` 是否在兜底 `handle {}` 之前 | `try_files` 被编译到路由前了 |
| 上传 zip 413 | `curl -sI https://maohedong.top:8443/api/sync/state` 看响应头 | Caddy `request_body.max_size` 太小 |
| systemd Status=203/EXEC | `grep ExecStart /etc/systemd/system/medmemory-sync.service` | Node 路径错（nvm 装的 node www-data 不可访问） |
| 锁长时间不释放 | `sudo cat /var/www/medmemory-sync/lock.json` | TTL 30 分钟，或客户端异常退出未 checkin |

---

## 10. 安全注意事项

- `/var/www/medmemory-sync/` 目录权限 750，只 `www-data` 可读写。snapshot.zip 含全家人病史，**不能让 web 直接访问**（Caddy 的 `root` 指向 `/var/www/medmemory`，不是这里，所以默认安全）。
- Token 保存在 `/opt/medmemory-sync/.sync-token`（600 权限），不要入 git，不要在聊天里贴明文。
- 服务器重启后 systemd 自动拉起 sync-server（步骤 4.3 的 `enable`）。
- 8443 证书由 Caddy 自动管理（ACME），通常不会过期。
- Node 二进制 `/usr/local/bin/node` 是 755，所有用户可执行，但只能写 root——别 chmod 777。
