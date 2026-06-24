# 同步功能测试报告 (Phase 4)

**测试日期**: 2026-06-23
**测试人**: 测试工程师 (Claude)
**服务器**: `server/sync-server.js` (Express + multer, 进程内 Mutex)
**客户端**: `src/composables/useSync.ts` (Vue 3 + TS)
**测试环境**: Node.js v24.14.1, Linux WSL2, curl 8.x

---

## 1. Typecheck + Build

| 检查项 | 命令 | 结果 |
|--------|------|------|
| Typecheck | `npm run typecheck` | PASS (vue-tsc --noEmit, 0 errors) |
| Build | `npm run build` | PASS (vite-tsc + vite build, dist/ 产出正常) |

---

## 2. 服务器端 Happy Path 端到端

### 测试配置

```
SYNC_TOKEN=testtok
PORT=3199
DATA_DIR=/tmp/medmemory-sync-test
SYNC_LOCK_TTL_MS=10000  (场景 E 专用, 生产默认 30min)
```

### 测试 zip 构造

`zip` 命令不可用, 用 python3 zipfile 构造最小 zip (337 bytes):
- `test.db` — fake sqlite content (20 bytes)
- `manifest.json` — 最小 manifest

服务器 multer 字段名: **`snapshot`** (非 `zip`), 客户端 useSync.ts 一致。

---

### 场景 A: 冷启动 + 首次 seed — PASS

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| A1 | `GET /api/sync/state` (无 auth) | 200, `{hasSnapshot:false, lockedBy:null, version:0}` | 200, `{"lockedBy":null,"version":0,"hasSnapshot":false}` | PASS |
| A2 | `POST /api/sync/seed` (token + zip) | 200, version=1 | 200, `{"version":1,"snapshotSize":337}` | PASS |
| A3 | `GET /api/sync/state` | 200, hasSnapshot=true, version=1 | 200, `{"version":1,"hasSnapshot":true}` | PASS |

### 场景 B: checkout → heartbeat → checkin 完整流程 — PASS

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| B1 | `POST /api/sync/checkout` (A) | 200, zip binary + `X-Sync-Version:1` | 200, `Content-Type: application/zip`, `X-Sync-Version: 1`, body=337B zip | PASS |
| B2 | `GET /api/sync/state` | lockedBy.clientId=A, version=1 | `lockedBy={'clientId':'A','clientLabel':'爸爸的笔记本'}`, version=1 | PASS |
| B3 | `POST /api/sync/heartbeat` (A) | 200, 新 expiresAt | 200, `{"expiresAt":"...","version":1}` | PASS |
| B4 | `POST /api/sync/checkin` (snapshot+version=1+A) | 200, version=2 | 200, `{"version":2,"snapshotSize":337}` | PASS |
| B5 | `GET /api/sync/state` | lockedBy=null, version=2 | `lockedBy=null`, version=2 | PASS |

### 场景 C: 竞态 — A 持锁, B 拒绝 — PASS

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| C1 | A checkout | 200 | 200 | PASS |
| C2 | B checkout | 409 LOCK_HELD_BY_OTHER | 409, `{"error":{"code":"LOCK_HELD_BY_OTHER","details":{"lockedBy":{"clientId":"A",...}}}}` | PASS |

### 场景 D: version 冲突 — PASS (含补充测试)

**原题场景 (B 抢先 checkin, A 的 checkin 被拒):**

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| D1 | A checkout v=2 | 200 | 200, X-Sync-Version:2 | PASS |
| D2 | B `DELETE /lock` (force) | 200 | 200, previousHolder=A | PASS |
| D3 | B checkout v=2 | 200 | 200, X-Sync-Version:2 | PASS |
| D4 | B checkin → v=3 | 200, version=3 | 200, `{"version":3}` | PASS |
| D5 | A checkin version=2 | 409 | 409 LOCK_EXPIRED (非 VERSION_CONFLICT) | **PASS\*** |

> **\*D5 说明**: 题目期望 `VERSION_CONFLICT`, 实际返回 `LOCK_EXPIRED`。这是正确的服务器行为: checkin 校验顺序为 **锁状态 → 锁持有者 → version**。B 的 checkin 已释放锁 (`lockHolder=null`), 所以 A 撞到 LOCK_EXPIRED 先于 VERSION_CONFLICT。目标 (拒绝 A 的 checkin) 已达成。

**VERSION_CONFLICT 路径补充测试 (A 持锁 + version 不匹配):**

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| D6 | A checkout v=3 | 200 | 200 | PASS |
| D7 | A checkin version=99 | 409 VERSION_CONFLICT | 409, `{"error":{"code":"VERSION_CONFLICT","details":{"currentVersion":3,"sentVersion":99}}}` | PASS |

### 场景 E: TTL 过期 — PASS

> 测试用 `SYNC_LOCK_TTL_MS=10000` (10 秒 TTL), 生产默认 30 分钟。

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| E1 | A checkout | 200 | 200 | PASS |
| E2 | 确认 A 持锁 | lockedBy=A | lockedBy=A, expiresAt=+10s | PASS |
| E3 | 等 11 秒 | — | — | — |
| E4 | B checkout | 200 (惰性清理过期锁) | 200, X-Sync-Version:1 | PASS |
| E5 | A heartbeat | 403 NOT_LOCK_HOLDER | 403, `{"error":{"code":"NOT_LOCK_HOLDER"}}` | PASS |
| E6 | 确认 B 持锁 | lockedBy=B | lockedBy=B | PASS |

### 场景 F: 认证 — PASS

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| F1 | checkout 无 token | 401 | 401 AUTH_REQUIRED | PASS |
| F2 | checkout 错误 token | 401 | 401 AUTH_INVALID | PASS |
| F3 | GET /state 无 token | 200 (公开端点) | 200 | PASS |

### 场景 G: CORP 头 — PASS

| 步骤 | 命令 | 期望 | 实际 | 结果 |
|------|------|------|------|------|
| G1 | `GET /api/sync/state` headers | `Cross-Origin-Resource-Policy: same-origin` | Present | PASS |
| G2 | `POST /api/sync/checkout` headers | `Cross-Origin-Resource-Policy: same-origin` | Present | PASS |
| G3 | 404 响应 headers | `Cross-Origin-Resource-Policy: same-origin` | Present | PASS |

---

## 3. 客户端集成检查

| 检查项 | 结果 | 位置 |
|--------|------|------|
| `npm run build` 绿 (vue-tsc 类型检查) | PASS | — |
| SyncIndicator 已挂载 | PASS | `src/App.vue:34` |
| `initOnAppStart()` 在 `onMounted` 调用 | PASS | `src/App.vue:16` |
| SettingsView 同步 section 已加 | PASS | `src/views/SettingsView.vue:891-1040` |
| 错误处理用 SyncError 类型 | PASS | `useSync.ts:34-38`, 全程使用 |
| heartbeat 阈值 = 2 (评审 M2) | PASS | `useSync.ts:51` `HEARTBEAT_FAIL_THRESHOLD = 2` |
| beforeunload 只提示不 fetch (评审 S4) | PASS | `useSync.ts:486-492` 仅设 `e.returnValue` |
| 无 `fetch keepalive` (评审 S4) | PASS | grep 确认无 `keepalive` |
| checkout/checkin 用 `snapshot` 字段名 | PASS | `useSync.ts:285,804` 与服务器一致 |

---

## 4. 修复内容

### 修复 1: LOCK_TTL_MS 环境变量支持

**文件**: `server/sync-server.js` (第 41 行)

**改动**: 将硬编码的 `LOCK_TTL_MS = 30 * 60 * 1000` 改为支持 `SYNC_LOCK_TTL_MS` 环境变量覆盖。

**原因**: 场景 E (TTL 过期) 需要 TTL 真实过期才能验证惰性清理逻辑。生产默认 30 分钟不变, 测试可用短 TTL (如 10 秒) 加速验证。

**Diff**:
```diff
-const LOCK_TTL_MS = 30 * 60 * 1000;          // 30 分钟
+// LOCK_TTL_MS 可通过 SYNC_LOCK_TTL_MS 环境变量覆盖 (测试用短 TTL),
+// 生产默认 30 分钟。最小 10 秒, 防止误配成 0。
+const LOCK_TTL_MS = (() => {
+  const env = parseInt(process.env.SYNC_LOCK_TTL_MS || '', 10);
+  if (Number.isFinite(env) && env >= 10_000) return env;
+  return 30 * 60 * 1000; // 30 分钟
+})();
```

**影响**: 无 (生产默认值不变, 纯增量可测试性改进)。

---

## 5. 浏览器端 E2E 测试 (Playwright)

**测试日期**: 2026-06-23 (Phase 4 之后追加)
**工具**: Playwright (sync API, headless chromium)
**测试脚本**: `/tmp/e2e_sync.py` (一次性脚本, 未入库; 关键逻辑见下文)
**测试环境**: vite dev server :5173 + sync-server :3199, vite proxy `/api/* → :3199` (见 `vite.config.ts`), `SYNC_TOKEN=testtok`

### 5.1 测试流程

**Device A** (Playwright browser context 1, fresh OPFS/IDB):
1. 打开 http://localhost:5173, 验证 `crossOriginIsolated=true` (COEP/COOP 生效)
2. localStorage 直接写 `medmemory:sync:serverUrl/token/clientLabel` + reload (绕过 UI 配置不确定性)
3. UI /members 添加家庭成员 "张三" + "李四"
4. UI /settings "导出数据" 按钮 → Playwright `expect_download` 拦截 → 保存 `/tmp/seed.zip` (~7.4KB)
5. curl `POST /api/sync/seed` 上传 zip → 服务器 v=1, hasSnapshot=true
6. UI "立即拉取 (checkout)" → 服务器给 A 分配锁, indicator="编辑中 剩30分钟"
7. UI "立即推送 (checkin)" → 服务器 v=1→v=2, 锁释放

**Device B** (Playwright 全新 browser context, fresh OPFS/IDB):
1. 打开 http://localhost:5173, 验证 `crossOriginIsolated=true`
2. 验证 /members 为空 (设备隔离)
3. localStorage 配置同步 + reload
4. UI "立即拉取 (checkout)" → 服务器给 B 分配锁 (v=2)
5. **关键验证**: pageB.evaluate 读 OPFS `medmemory.sqlite3` 整个文件, base64 编码, Python decode 写本地, 用 `sqlite3` 命令行查 `family_members` 表
6. UI /members 显示张三李四
7. 清理: "强制释放锁"

### 5.2 测试结果 (16/16 PASS)

| # | 检查项 | 期望 | 实际 | 结果 |
|---|--------|------|------|------|
| 1 | Device A `crossOriginIsolated` | true | true | PASS |
| 2 | 服务器初始状态干净 | v=0, snap=false, lock=null | v=0, snap=false, lock=null | PASS |
| 3 | Device A 添加 张三 | UI 列表显示 | 张三可见 | PASS |
| 4 | Device A 添加 李四 | UI 列表显示 | 李四可见 | PASS |
| 5 | Device A 本地看到两成员 | 都在 | 张三+李四可见 | PASS |
| 6 | 导出 zip (UI expect_download) | 拿到 zip | 7402-7406 bytes | PASS |
| 7 | seed 上传后服务器状态 | v=1, snap=true | v=1, snap=true | PASS |
| 8 | Device A checkout 获锁 | lockedBy=A | `lockedBy={'clientId':'...','clientLabel':'设备A-测试'}` | PASS |
| 9 | Device A indicator 状态 | 编辑中 | "编辑中 剩30分钟" | PASS |
| 10 | Device A checkin | v=1→v=2, lock 释放 | v=1→v=2, lockedBy=null | PASS |
| 11 | Device B `crossOriginIsolated` | true | true | PASS |
| 12 | Device B fresh (无成员) | 空 | 张三李四都不在 | PASS |
| 13 | Device B checkout 获锁 | lockedBy=B | `lockedBy={'clientId':'...','clientLabel':'设备B-测试'}` | PASS |
| 14 | **Device B OPFS sqlite 含数据 (sqlite3 直接验证)** | family_members 有张三李四 | `1\|张三\|` + `2\|李四\|` | PASS |
| 15 | Device B UI /members 显示成员 | 张三+李四 | 张三=True, 李四=True (1st try, 无需二次刷新) | PASS |
| 16 | Device B indicator 状态 | 编辑中 | "编辑中 剩30分钟" | PASS |

**Console / pageerror**: Device A 0 pageerrors, Device B 0 pageerrors (只有 vite HMR connecting 日志)

### 5.3 发现并修复的真 bug

E2E 第一次跑发现 2 个真 bug (commit `fa6d457` + `3ddf7f2`):

#### Bug 1: `closeDb()` 不容错 (`src/db/connection.ts`)

**症状**: B checkout 时 `importAllData` 抛 `SqliteConnectionError: [SqliteConnection/close] 关闭数据库失败`, B 没拉到数据, 但 indicator 仍显示 "编辑中" (误导).

**根因**: sqlite-wasm 的 `promiser('close')` 在 OPFS proxy worker 过渡态偶发抛错. 原实现直接 propagate, 导致 importAllData 整个失败.

**修复**: 始终先 reset module-level 单例 (`promiserInstance/activeDbId/usingOpfs`), promiser close 失败时 `console.warn` 不抛错. 后续写 OPFS sqlite 不会被旧 worker 干扰.

#### Bug 2: `useSync.checkout` 在 importAllData 失败时不释放锁 (`src/composables/useSync.ts`)

**症状**: B checkout 时 importAllData 失败, 但服务器仍认为 B 持锁 30 分钟, A 等不到锁.

**根因**: downloadSnapshot 成功 = 服务器已分配锁给 B. 但后续 backupLocalBeforeCheckout / importAllData 在同一个 try 内, 任一失败 catch 把它当网络错误设 `syncState='offline'`. SettingsView 的 reload 触发后, `initOnAppStart` 看到 "锁主是我" 又把 syncState 重置为 'editing', **掩盖失败 + 卡住对方编辑权 30 分钟**.

**修复**: 在 acquireLock 之后的子 try 内捕获 importAllData 失败, 调新增的 `releaseLockSilently` helper (`DELETE /api/sync/lock force=true`, 不改 state), 再抛原错误. catch 块新增分支: 含 'close'/'SqliteConnection' 等关键字的 Error 归类为 `kind='server'` (本地数据问题) 而非 network/offline.

#### Bug 3 (改进): `handleSyncCheckout` 的 setTimeout(reload, 400) 竞态 (`src/views/SettingsView.vue`)

**症状**: checkout 后第一次看 /members 偶发显示空, 二次刷新才正常.

**根因**: 400ms 窗口内 Vue app 的 sqlite-wasm connection 还指向旧 OPFS inode (importAllData 用 FileSystemFileHandle 覆写了文件字节, 但旧 connection 缓存的 page 不变). 此窗口内任何 query 拿到旧数据.

**修复**: 删 setTimeout, `await syncCheckout()` 完成立即 `window.location.reload()`. reload 让 useRepositories 在新页面重新打开, 直接读到新数据, 无中间窗口. E2E 验证后 Device B 第一次 /members 就看到张三李四.

### 5.4 dev proxy 配置 (`vite.config.ts`)

为了让浏览器从 :5173 同源访问 sync-server :3199 (避开 CORS), 加了 dev-only proxy:

```typescript
'/api': {
  target: 'http://127.0.0.1:3199',
  changeOrigin: true,
},
```

参考已有 `/llm-proxy/*` 模式. 生产环境仍由 Nginx 反代, 不受影响.

---

## 6. 已知未覆盖的测试

E2E 已覆盖了原列表的 1-3 项 (sqlite-wasm 真实 import/export, SyncIndicator 状态, beforeunload 注册), 剩余:

1. **beforeunload 提示弹窗的真实渲染**: Playwright headless 不弹原生 dialog, 只能验证 `e.returnValue` 被设. 真实 dialog UX 需手动验证.
2. **并发请求下的 Mutex 竞态**: 进程内 Mutex 在高并发下的表现 (curl/Playwright 单线程无法模拟, 但 2 人家庭场景不会触发).
3. **大文件上传**: 500MB zip 的 multipart 上传 (multer memoryStorage 内存压力). 测试 zip 是 7.4KB, 真实家庭档案可能 50-200MB.
4. **网络抖动下的 heartbeat 失败恢复**: 模拟弱网连续 2 次 heartbeat 失败进 error 状态的 UX. 需要网络模拟工具.

---

## 7. 总结

| 类别 | 通过 | 失败 | 总计 |
|------|------|------|------|
| Phase 4 场景 A-G (curl) | 7 | 0 | 7 |
| Phase 4 客户端集成 | 9 | 0 | 9 |
| Phase 4 typecheck/build | 2 | 0 | 2 |
| **浏览器 E2E (Playwright)** | **16** | **0** | **16** |
| **总计** | **34** | **0** | **34** |

**结论**: 全部通过, 无 BLOCKING 问题.

**Phase 4 (curl)**: 发现 1 个可测试性改进 (LOCK_TTL_MS 环境变量), 已修复.
**E2E (Playwright)**: 发现 3 个真问题 (closeDb 容错 / checkout 失败释放锁 / reload 时序), 全部已修复并 commit (`fa6d457` + `3ddf7f2`).

**数据完整性验证**: B 的 OPFS sqlite 用 `sqlite3` 命令行直接查询 `family_members` 表, 确认 `1|张三|` + `2|李四|` 完整从 A 经服务器流到 B, 数据无损.
