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

## 5. 已知未覆盖的测试

以下场景需要真实浏览器环境, 留给手动验证:

1. **sqlite-wasm OPFS 真实 import/export 流程**: `exportAllData()` / `importAllData()` 涉及 OPFS + sqlite-wasm, 只能在浏览器跑
2. **SyncIndicator UI 交互**: 状态切换动画、toast 提示、按钮 disabled 逻辑
3. **beforeunload 提示弹窗**: 浏览器原生 `beforeunload` dialog 行为
4. **并发请求下的 Mutex 竞态**: 进程内 Mutex 在高并发下的表现 (curl 单线程无法模拟)
5. **大文件上传**: 500MB zip 的 multipart 上传 ( multer memoryStorage 内存压力)

---

## 6. 总结

| 类别 | 通过 | 失败 | 总计 |
|------|------|------|------|
| 场景 A-G | 7 | 0 | 7 |
| 客户端集成 | 9 | 0 | 9 |
| typecheck/build | 2 | 0 | 2 |
| **总计** | **18** | **0** | **18** |

**结论**: 全部通过, 无 BLOCKING 问题。发现 1 个可测试性改进点 (LOCK_TTL_MS 环境变量), 已修复。
