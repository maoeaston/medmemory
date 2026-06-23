# MedMemory 同步设计文档

> **版本**: draft-v1 (2026-06-23)
> **阶段**: Phase 1 设计 (待评审, 不写实现代码)
> **决策前提**: 「接力棒」checkout/checkin 模式已拍板, 本文档在此基础上细化

---

## 目录

1. [架构概述](#1-架构概述)
2. [服务器 API 完整 Spec](#2-服务器-api-完整-spec)
3. [锁机制设计](#3-锁机制设计)
4. [客户端同步流程](#4-客户端同步流程)
5. [冲突场景 Matrix](#5-冲突场景-matrix)
6. [COOP/COEP + fetch 兼容性分析](#6-coopcoep--fetch-兼容性分析)
7. [认证设计](#7-认证设计)
8. [文件清单](#8-文件清单)
9. [useSync.ts API 设计](#9-usesyncts-api-设计)
10. [UX 设计](#10-ux-设计)
11. [未覆盖 / 未来工作](#11-未覆盖--未来工作)

---

## 1. 架构概述

### 1.1 现状

```
┌─────────────────────────────────────────────────────┐
│                    浏览器 (PWA)                       │
│                                                       │
│  ┌──────────────┐   ┌───────────────────────────┐   │
│  │  SQLite-wasm  │   │     IndexedDB              │   │
│  │  (OPFS)       │   │     (Blob 附件)             │   │
│  │  主数据        │   │                            │   │
│  └──────────────┘   └───────────────────────────┘   │
│                                                       │
│  exportAllData() → zip Blob (sqlite + blobs + manifest)│
│  importAllData(zip) → 覆盖 sqlite + blobs             │
└─────────────────────────────────────────────────────┘
                          │
                          │  (当前: 无连接)
                          ▼
                     ┌─────────┐
                     │  无后端  │
                     └─────────┘
```

### 1.2 目标架构

```
┌─────────────────────────────────────────────────────┐
│              用户 A - 设备 1 (手机)                    │
│  ┌──────────┐  ┌─────────┐                           │
│  │ SQLite    │  │ IDB     │  ← checkout: 拉 zip 导入   │
│  │ (OPFS)    │  │ (Blobs) │  ← checkin: 导出 zip 上传   │
│  └──────────┘  └─────────┘                           │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS
                       ▼
┌──────────────────────────────────────────────────────┐
│            腾讯轻量服务器 (maohedong.top)               │
│                                                        │
│  Nginx (:443)                                          │
│    ├── /              → Caddy (:8080) → 静态文件        │
│    └── /api/sync/*    → Sync Server (:3001)            │
│                                                        │
│  Sync Server (Node.js)                                 │
│    ├── 锁状态: /var/www/medmemory-sync/lock.json       │
│    ├── 快照:   /var/www/medmemory-sync/snapshot.zip    │
│    └── 版本:   /var/www/medmemory-sync/version.txt     │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS
                       ▼
┌─────────────────────────────────────────────────────┐
│              用户 B - 设备 2 (电脑)                    │
│  ┌──────────┐  ┌─────────┐                           │
│  │ SQLite    │  │ IDB     │  ← 只读模式 / 等锁         │
│  │ (OPFS)    │  │ (Blobs) │                           │
│  └──────────┘  └─────────┘                           │
└─────────────────────────────────────────────────────┘
```

### 1.3 核心数据流复用

| 操作 | 复用函数 | 说明 |
|------|---------|------|
| Pull (拉服务器数据到本地) | `importAllData(zipBlob)` | 直接传服务器下载的 zip Blob |
| Push (推本地数据到服务器) | `exportAllData()` → Blob | 导出后上传 Blob |

zip 格式完全复用现有 `useDataBackup.ts` 的结构:
```
snapshot.zip
├── manifest.json          # { schema_version, exported_at, sqlite_bytes, blob_count, app_version }
├── medmemory.sqlite3      # SQLite 数据库文件
└── blobs/                 # 所有附件 Blob
    ├── attachment/1/...
    ├── attachment/2/...
    └── inbox/...
```

**不需要改 schema、不需要新数据格式、不需要改 exportAllData / importAllData 的签名。** 这两个函数已经做了 manifest 校验、orphan 清理、OPFS 覆写, 完全满足同步场景。

---

## 2. 服务器 API 完整 Spec

### 2.0 通用约定

| 项目 | 值 |
|------|-----|
| Base URL | `https://maohedong.top/api/sync` |
| 认证头 | `X-Sync-Token: <共享密钥>` (所有端点都需要, 除 `state` 可选) |
| 内容类型 | JSON (`application/json`) 或 `multipart/form-data` (checkin) |
| 时间格式 | ISO 8601 UTC (如 `2026-06-23T12:00:00.000Z`) |
| 字符编码 | UTF-8 |

### 2.0.1 错误响应统一格式

所有错误响应统一 JSON 格式:

```json
{
  "error": {
    "code": "LOCK_HELD_BY_OTHER",
    "message": "锁已被其他客户端持有",
    "details": {
      "lockedBy": { "clientId": "abc-123", "clientLabel": "爸爸的手机" },
      "expiresAt": "2026-06-23T12:30:00.000Z"
    }
  }
}
```

### 2.0.2 错误码语义表

| HTTP Status | error.code | 含义 | 客户端处理策略 |
|-------------|------------|------|---------------|
| 401 | `AUTH_REQUIRED` | 缺少 X-Sync-Token | 提示用户配置同步密钥 |
| 401 | `AUTH_INVALID` | token 不匹配 | 提示密钥错误 |
| 409 | `LOCK_HELD_BY_OTHER` | 锁被别人持有 | 进入只读模式, 轮询 state |
| 409 | `VERSION_CONFLICT` | checkin 时 version 不匹配 | 提示数据已过期, 需重新 checkout |
| 404 | `NO_SNAPSHOT` | 服务器还没有快照 | 首次使用: 客户端直接 checkout → checkin 上传 |
| 409 | `LOCK_EXPIRED` | heartbeat 时锁已过期 | 需重新 checkout |
| 403 | `NOT_LOCK_HOLDER` | heartbeat/force-release 但 clientId 不匹配 | 不应发生, 提示错误 |
| 400 | `BAD_REQUEST` | 请求格式错误 | 检查客户端逻辑 |
| 413 | `PAYLOAD_TOO_LARGE` | zip 超过限制 (默认 500MB) | 提示用户精简附件 |
| 429 | `RATE_LIMITED` | 超出速率限制 | 客户端退避重试 |
| 500 | `INTERNAL` | 服务器内部错误 (代码 bug, 意外异常) | 提示重试 |
| 503 | `STORAGE_ERROR` | 快照写入失败 (磁盘满 / 权限错) | 客户端重试 checkin; 旧快照不受影响 |

---

### 2.1 `GET /api/sync/state`

获取当前同步状态 (轻量轮询端点, 不需要锁)。

**请求**

```
GET /api/sync/state
Header: X-Sync-Token: <token>   (可选; 不带 token 也能看状态, 只是元数据)
```

**成功响应** `200 OK`

```json
{
  "lockedBy": {                          // null 表示无人持锁
    "clientId": "abc-123",
    "clientLabel": "爸爸的手机"
  },
  "lockedAt": "2026-06-23T11:30:00.000Z",  // null 表示无人持锁
  "version": 7,                            // 当前快照版本号 (单调递增)
  "expiresAt": "2026-06-23T12:00:00.000Z", // 锁过期时间; null 表示无人持锁
  "hasSnapshot": true,                     // 服务器是否有快照
  "snapshotSize": 45678901,                // 快照字节数 (hasSnapshot=false 时为 0)
  "serverTime": "2026-06-23T11:45:00.000Z" // 服务器当前时间 (客户端时钟校准用)
}
```

**为什么 state 端点不强制认证**: 这个端点只返回元数据 (谁持有锁、版本号), 不泄露医疗数据。不强制认证可以让客户端启动时更快决策 (进入编辑 vs 只读), 减少一个失败点。如果后续安全需求变化, 可以改为强制认证。

---

### 2.2 `GET /api/sync/snapshot`

下载最新快照 zip (需要认证 + 持锁)。

**请求**

```
GET /api/sync/snapshot
Header: X-Sync-Token: <token>
```

**成功响应** `200 OK`

```
Content-Type: application/zip
Content-Length: 45678901
Content-Disposition: attachment; filename="medmemory-snapshot-v7.zip"
Cross-Origin-Resource-Policy: same-origin

<binary zip data>
```

**错误响应**

| Status | code | 条件 |
|--------|------|------|
| 401 | `AUTH_REQUIRED` / `AUTH_INVALID` | 认证失败 |
| 404 | `NO_SNAPSHOT` | 服务器还没有快照 |

**设计说明**: 下载 snapshot 不要求持锁。原因: checkout 流程是「先拉数据, 再获锁」, 如果先获锁再拉数据, 拉取失败会导致锁被占用但没有实际使用。改为 checkout 时先 snapshot 再 lock → 不行, 这有 TOCTOU 竞态。

**最终决策**: checkout 端点内部原子完成「拉数据」+「获锁」。客户端不直接调 `/snapshot` 做 checkout, 但 `/snapshot` 作为独立端点保留 (只读模式拉最新数据查看、调试等场景)。正常 checkout 流程由 `/checkout` 端点内部调用 snapshot 读取逻辑。

---

### 2.3 `POST /api/sync/checkout`

获取编辑锁, 同时返回最新快照。

**为什么 checkout 要返回快照而不是分两步**: 减少 round-trip 和竞态窗口。一步完成「拉数据 + 获锁」, 客户端拿到响应时就已经持锁, 可以立即编辑。

**请求**

```
POST /api/sync/checkout
Header:
  X-Sync-Token: <token>
  Content-Type: application/json

Body:
{
  "clientId": "device-uuid-abc-123",   // 客户端持久化生成的 UUID
  "clientLabel": "爸爸的手机"            // 人类可读标签
}
```

**成功响应** `200 OK`

```
Content-Type: application/zip
Content-Length: 45678901
X-Sync-Version: 7
X-Sync-Lock-Expires-At: 2026-06-23T12:00:00.000Z

<binary zip data>
```

**说明**: checkout 响应体直接是 zip 二进制 (不是 JSON), 版本号和锁过期时间放在响应头 `X-Sync-Version` / `X-Sync-Lock-Expires-At` 里。这样客户端可以一步完成下载 + 解析, 不需要先 JSON 再 binary。

**错误响应**

| Status | code | 条件 |
|--------|------|------|
| 409 | `LOCK_HELD_BY_OTHER` | 锁已被其他人持有 |
| 404 | `NO_SNAPSHOT` | 服务器无快照 (首次使用, 客户端应直接调 checkin 上传初始数据) |
| 429 | `RATE_LIMITED` | 该 clientId 请求过于频繁 |

---

### 2.4 `POST /api/sync/checkin`

提交编辑结果, 释放锁。

**请求**

```
POST /api/sync/checkin
Header:
  X-Sync-Token: <token>
  Content-Type: multipart/form-data

Body (multipart):
  - field "version": "7"               // 字符串, checkout 时获得的版本号
  - field "clientId": "device-uuid-abc-123"
  - file "snapshot": <zip binary>       // 文件部分
```

**成功响应** `200 OK`

```json
{
  "version": 8,
  "receivedAt": "2026-06-23T12:00:00.000Z",
  "snapshotSize": 45890123
}
```

**错误响应**

| Status | code | 条件 |
|--------|------|------|
| 409 | `VERSION_CONFLICT` | version 不匹配 (被别人抢先 checkin 或锁过期后被人重新 checkout) |
| 409 | `LOCK_EXPIRED` | 锁已过期, 需重新 checkout |
| 403 | `NOT_LOCK_HOLDER` | clientId 不匹配 |
| 413 | `PAYLOAD_TOO_LARGE` | 超过大小限制 |
| 400 | `BAD_REQUEST` | multipart 解析失败 / 缺字段 |

**checkin 原子性保证** (Phase 2 评审 S1 修正): 服务端流程为:
1. 校验 token
2. 校验锁状态 (clientId 匹配 + 未过期)
3. 校验 version 匹配
4. version + 1, 写入临时文件 `version.txt.tmp`, rename 到 `version.txt` (原子操作)
5. 写入临时文件 `snapshot.zip.tmp`
6. rename 到 `snapshot.zip` (原子操作)
7. 释放锁
8. 返回成功

**写入顺序说明 (评审 S1 修正: 先 version 后 snapshot)**: 步骤 4 (version) 在步骤 5-6 (snapshot) 之前。如果进程在步骤 4 完成后、步骤 6 完成前崩溃:
- version.txt 已更新为新值, snapshot.zip 还是旧内容
- 下一个 checkout 拿到新 version 但旧 snapshot — version 校验仍然一致 (checkout 基于 version.txt 的值, snapshot 是旧的但 version 匹配), 不影响正确性。后续 checkin 会用新 version 校验, 逻辑正确。

反过来 (先 snapshot 后 version — Phase 1 原始设计, 已被评审否决): snapshot 新但 version 旧 → version 校验逻辑混乱, 无法通过 version 判断快照内容。

如果步骤 4 (写 version.txt) 失败 (磁盘满/权限错): 旧快照和旧 version 都不受影响, 锁不释放, 返回 **503** (而非 500, 区分 "磁盘空间不足" 与 "代码错误"), 客户端可安全重试 checkin。如果步骤 5-6 (写 snapshot) 失败: version.txt 已更新但 snapshot.zip 是旧的 — checkout 拿到新 version + 旧 snapshot, 不影响编辑正确性 (version 校验以 version.txt 为准, snapshot 内容稍旧但可接受), 下次 checkin 会覆盖旧 snapshot, 最终一致。

---

### 2.5 `POST /api/sync/heartbeat`

延长锁 TTL。

**请求**

```
POST /api/sync/heartbeat
Header:
  X-Sync-Token: <token>
  Content-Type: application/json

Body:
{
  "clientId": "device-uuid-abc-123"
}
```

**成功响应** `200 OK`

```json
{
  "expiresAt": "2026-06-23T12:40:00.000Z",
  "version": 7
}
```

**错误响应**

| Status | code | 条件 |
|--------|------|------|
| 409 | `LOCK_EXPIRED` | 锁已过期 |
| 403 | `NOT_LOCK_HOLDER` | clientId 不匹配 |

---

### 2.6 `DELETE /api/sync/lock`

强制释放锁 (紧急用)。

**请求**

```
DELETE /api/sync/lock
Header:
  X-Sync-Token: <token>
  Content-Type: application/json

Body:
{
  "clientId": "device-uuid-abc-123",   // 可选: 如果匹配当前持锁者则正常释放
  "force": true                         // true = 强制释放 (即使不匹配)
}
```

**成功响应** `200 OK`

```json
{
  "releasedAt": "2026-06-23T12:00:00.000Z",
  "previousHolder": { "clientId": "abc-123", "clientLabel": "爸爸的手机" }
}
```

**设计说明**: `force: true` 时任何持 token 的客户端都能释放锁。用于「锁被卡住」的紧急恢复。正常 checkout 流程不需要调这个 — 用户的 checkin 会自动释放锁。这个端点主要是安全网。

---

## 3. 锁机制设计

### 3.1 TTL 策略

| 参数 | 值 | 理由 |
|------|-----|------|
| 初始 TTL | 30 分钟 | 家庭医疗档案, 一次编辑会话通常 10-20 分钟 (录入体检报告/病历)。30 分钟给够余量, 不至于太短导致频繁 heartbeat |
| Heartbeat 间隔 | 10 分钟 | 每 10 分钟续一次, 续期到 +30 分钟。即使丢一次 heartbeat, 还有 20 分钟窗口恢复 |
| Heartbeat 提前量 | TTL 过期前 5 分钟 | 如果当前时间距 expiresAt < 5 分钟, 立即发 heartbeat (不等 10 分钟间隔) |
| 过期检查 | 请求时惰性检查 | 不需要后台定时器; 每次有请求进来时检查 expiresAt, 过期则释放锁 |

**TTL 30 分钟的取舍声明**: 浏览器崩溃 / 关闭后, 另一人需要等 30 分钟才能编辑。缩短 TTL (如 15 分钟) 的代价是 heartbeat 必须更频繁 (5 分钟), 进电梯/弱网环境更容易丢锁, 反而导致正常编辑被意外中断。2 人家庭医疗档案场景下, 30 分钟等待是可接受的不便 (不是数据丢失, 只是使用延迟)。保持 30 分钟不变。

**为什么不用后台定时器扫描过期锁**: 增加复杂度, 且服务器是单进程 Node.js, 请求时惰性检查就够了。`/state` 端点被轮询时顺便清理过期锁。

### 3.2 持久化设计

**存储路径**: `/var/www/medmemory-sync/`

```
/var/www/medmemory-sync/
├── lock.json          # 锁状态
├── snapshot.zip       # 最新快照
├── snapshot.zip.tmp   # 上传临时文件 (checkin 时先写这里)
└── version.txt        # 单行整数: 当前版本号
```

**lock.json 结构**:

```json
{
  "lockHolder": {
    "clientId": "device-uuid-abc-123",
    "clientLabel": "爸爸的手机"
  },
  "acquiredAt": "2026-06-23T11:30:00.000Z",
  "expiresAt": "2026-06-23T12:00:00.000Z",
  "version": 7
}
```

无人持锁时 lock.json 内容:

```json
{
  "lockHolder": null,
  "acquiredAt": null,
  "expiresAt": null,
  "version": 7
}
```

**version 放在 version.txt 而非只放 lock.json 的理由**:

version 代表的是「快照内容的版本」, 不是「锁的版本」。锁释放后 version 仍然有意义 (表示当前快照是第几版)。如果把 version 只放 lock.json, 语义上耦合了锁状态和数据版本, 在 lockHolder 为 null 时 version 的归属就模糊了。

**决策**: version.txt 独立存放, 单行整数。每次 checkin 成功后 `version += 1`, 原子写入 version.txt (write tmp → rename)。lock.json 的 `version` 字段是冗余副本 (方便 state 端点一次读取), 以 version.txt 为准。

### 3.3 竞态防护

**核心问题**: 两个用户几乎同时发 checkout, 怎么保证只有一人拿到锁?

**方案**: Node.js 是单线程事件循环, 所有 I/O 操作通过 async 串行化。用一个进程内 Mutex (Promise 队列) 包裹 checkout / checkin / heartbeat / force-release 操作:

```
               ┌──────────────────────────┐
               │   Sync Server (单进程)     │
               │                          │
   请求 A ───▶  │  ┌─── Mutex Queue ───┐  │
   请求 B ───▶  │  │  A: checkout      │  │  ← A 先到, 先执行
               │  │  B: checkout (等)  │  │  ← B 等 A 完成后执行, 发现锁已占
               │  └───────────────────┘  │
               └──────────────────────────┘
```

**实现思路** (设计阶段不写代码, 只描述):

```text
class Mutex {
  private queue: Array<() => Promise<void>> = [];
  private locked = false;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // 等待获取锁
    // 执行 fn
    // 释放锁
  }
}

// 所有写操作都经过 mutex
const result = await mutex.run(() => doCheckout(req));
```

**为什么不用 flock**: Node.js 的 `fs.flock` 不是标准 API, 需要原生扩展 (如 `fs-ext`)。进程内 Promise 队列更简单, 且我们只跑一个进程 (systemd 单实例)。如果未来要多进程, 再上 flock 或 Redis 分布式锁。

### 3.4 锁状态机

```
                    ┌──────────┐
         ┌─────────│  UNLOCKED │◀──────────┐
         │          └──────────┘            │
         │               │                  │
         │          checkout()          checkin()
         │               │                  │
         │               ▼                  │
         │     ┌─────────────────┐          │
         │     │    LOCKED       │──────────┘
         │     │  (TTL=30min)    │
         │     └────────┬────────┘
         │              │
         │         heartbeat()
         │              │ (续期 +30min)
         │              │
         │         TTL 过期
         │              │
         │              ▼
         │     ┌─────────────────┐
         │     │   EXPIRED        │
         │     │ (惰性回收)        │
         │     └────────┬────────┘
         │              │
         │     下一个请求进来时
         │     检测到过期, 回到 UNLOCKED
         └──────────────┘
```

---

## 4. 客户端同步流程

### 4.1 冷启动决策流程

```
App 启动
    │
    ▼
┌─────────────────────┐
│ initOnAppStart()    │
│ 1. 读 sync 配置      │
│    (localStorage:   │
│     server URL +    │
│     token)          │
└─────────┬───────────┘
          │
          │ 配置完整?
          ├──── 否 ───▶ syncState = 'idle' (同步未配置, 正常本地使用)
          │
          ▼ 是
    fetch /api/sync/state
          │
          ├──── 网络失败 ──▶ syncState = 'offline'
          │
          ├──── 401 ───────▶ syncState = 'error' (auth)
          │
          ▼ 200
    分析响应:
    ┌────────────────────────────────────────┐
    │                                        │
    │  lockedBy == null?                     │
    │  ├── 是 ──▶ syncState = 'idle'         │
    │  │         (可编辑, 用户主动 checkout)  │
    │  │                                     │
    │  │  lockedBy.clientId == 本机 clientId?│
    │  ├── 是 ──▶ syncState = 'editing'      │
    │  │         (上次 checkout 后未 checkin, │
    │  │          恢复编辑状态)               │
    │  │                                     │
    │  └── 否 ──▶ syncState = 'locked-by-other'
    │            (只读模式, 开始轮询)          │
    └────────────────────────────────────────┘
```

### 4.2 Checkout → 编辑 → Checkin 完整流程

```
用户点击「开始编辑」
    │
    ▼
┌──────────────┐     失败(锁被占)     ┌───────────────┐
│  checkout()  │─────────────────────▶│ syncState =   │
│              │                      │ 'locked-by-other'│
│ POST /checkout│                     └───────────────┘
└──────┬───────┘
       │ 成功 (200 + zip)
       ▼
┌──────────────────────────┐
│ 保存本地数据快照到内存    │
│ (preCheckoutBackup =     │  ← 防止 importAllData 中途
│  exportAllData() → Blob) │    失败导致数据丢失
└──────┬───────────────────┘
       │ 成功
       ▼
┌──────────────┐
│ importAllData│
│ (zipBlob)    │  ← 复用 useDataBackup
└──────┬───────┘
       │ 成功 → 丢弃 preCheckoutBackup
       ▼
  syncState = 'editing'
  启动 heartbeat 定时器 (每 10 分钟)
       │
       │  ┌──────────────────────────────┐
       │  │  用户编辑...                   │
       │  │  heartbeat 每 10min POST      │
       │  │  /heartbeat (续期)             │
       └──────────────────────────────┘
       │
       ▼  用户点击「完成编辑 / 同步」
┌──────────────┐
│  checkin()   │
│              │
│ 1. exportAllData() → zip Blob
│ 2. POST /checkin (multipart: zip + version + clientId)
└──────┬───────┘
       │
       ├──── 200 成功 ──▶ syncState = 'idle'
       │                   lastSyncAt = now
       │                   serverVersion = newVersion
       │
       ├──── 409 VERSION_CONFLICT ──▶ syncState = 'error'
       │                              syncError = { kind: 'version-conflict' }
       │                              ⚠ 本地数据无法上传, 需要用户决策
       │
       └──── 网络失败 ──▶ 重试 (指数退避, 最多 3 次)
                           全部失败 → syncState = 'error'
```

### 4.3 两人同时操作时序图

```
时间 ─────────────────────────────────────────────────────────────────────────────▶

用户 A (手机)          服务器                    用户 B (电脑)
    │                    │                          │
    │  POST /checkout    │                          │
    │───────────────────▶│                          │
    │                    │ (锁空闲, 分配给 A)         │
    │◀──── 200 + zip ────│                          │
    │                    │                          │
    │  syncState=editing │                          │
    │  开始编辑...        │                          │
    │                    │     POST /checkout        │
    │                    │◀─────────────────────────│
    │                    │ (锁被 A 持有, 拒绝 B)      │
    │                    │                          │
    │                    │────── 409 ──────────────▶│
    │                    │                          │
    │                    │                 syncState='locked-by-other'
    │                    │                 只读模式, 每 30s 轮询 /state
    │                    │                          │
    │  POST /heartbeat   │                          │
    │───────────────────▶│                          │
    │◀──── 200 ──────────│                          │
    │                    │                          │
    │  完成编辑           │                          │
    │  POST /checkin     │                          │
    │  (zip + v=7)       │                          │
    │───────────────────▶│                          │
    │                    │ (校验 v=7 OK, 写快照,     │
    │                    │  version→8, 释放锁)       │
    │◀──── 200 v=8 ──────│                          │
    │                    │                          │
    │ syncState=idle     │     GET /state (轮询)     │
    │                    │◀─────────────────────────│
    │                    │ lockedBy=null, v=8        │
    │                    │──────────────────────────▶│
    │                    │                          │
    │                    │            用户 B 看到锁释放
    │                    │            POST /checkout  │
    │                    │◀─────────────────────────│
    │                    │ (锁空闲, 分配给 B)          │
    │                    │────── 200 + zip(v=8) ────▶│
    │                    │                          │
    │                    │                 importAllData(v=8 zip)
    │                    │                 syncState=editing
    │                    │                 B 编辑 A 的最新数据...
```

### 4.4 浏览器关闭处理

```
用户正在编辑 (syncState = 'editing')
    │
    │  用户关闭/刷新 tab
    ▼
beforeunload 事件触发
    │
    ├──── 有未 checkin 的编辑? ──▶ 弹原生确认对话框
    │                               (不做任何网络请求)
    │
    │                               用户确认离开:
    │                               ├─ 本地数据靠 OPFS/IDB 持久化, 不丢失
    │                               ├─ 锁靠 TTL (30min) 自然过期
    │                               └─ 期间其他人无法编辑
    │
    │                               用户重新打开时:
    │                               initOnAppStart() 发现自己仍持锁
    │                               → 恢复 editing 状态, 本地数据完好
    │
    └──── beforeunload 对话框 (浏览器原生, 不可自定义文案):
          "离开此网站? 系统可能不会保存您所做的更改。"
```

**明确决策: 放弃 beforeunload auto-checkin**

不做任何 beforeunload 时的网络上传请求。理由:

1. **`fetch(url, { keepalive: true })` 的 64KB body 限制**: 典型 zip (sqlite + manifest) 已超过 64KB, 被截断的 multipart body 到达服务端后, multer 可能解析失败 (安全) 或解析出残缺 zip 并写入 snapshot.zip (危险 — 数据损坏)。
2. **截断风险 > 不上传**: 如果 auto-checkin 把损坏 zip 写到服务器, 覆盖了上次的好数据, 比不做 auto-checkin 更糟。
3. **本地数据不丢**: OPFS sqlite + IDB blob 都是持久化存储, 浏览器关闭/崩溃后数据完好。
4. **TTL 兜底足够**: 30 分钟后锁自动释放, 另一人可以编辑。用户重新打开时恢复 editing 状态继续。

**最终策略 (3 层保障)**:
1. **OPFS/IDB 持久化**: 浏览器关闭后本地数据不丢
2. **beforeunload 提示**: 弹原生对话框, 提醒用户有未同步的数据
3. **TTL 30 分钟兜底**: 锁自动释放; 用户重开 app 自动恢复 editing 状态

**取舍声明**: 这意味着浏览器崩溃后, 另一人需要等 30 分钟。在 2 人家庭医疗档案场景下, 这个等待是可接受的不便 — 不是数据丢失, 只是使用延迟。

---

## 5. 冲突场景 Matrix

| # | 场景 | 触发条件 | 客户端观察 | 服务端行为 | 处理策略 |
|---|------|---------|-----------|-----------|---------|
| 1 | **两人同时 checkout** | A 和 B 在同一秒发 POST /checkout | 先到的 A 得 200; 后到的 B 得 409 | Mutex 串行化, 第一个获锁, 第二个被拒 | B 进入只读模式, 轮询 state 等 A 释放 |
| 2 | **checkin version 冲突** | A 持锁(v=7) → 锁过期 → B checkout(v=7) → B checkin(v=8) → A 恢复网络后 checkin(v=7) | A 的 checkin 返回 409 VERSION_CONFLICT | A 的 clientId 不再是锁主 + version 不匹配 | A 的本地数据「过期」了。提示用户: "数据已被更新, 您的修改需要重新录入"。**不自动合并** |
| 3 | **浏览器关闭未 checkin** | 用户编辑到一半关浏览器 (beforeunload 只弹提示, 不做上传) | 下次打开时发现自己仍持锁 | 锁在 TTL(30min) 后过期, 期间无人能编辑 | TTL 过期前重开: 恢复 editing 状态; TTL 过期后重开: 重新 checkout (本地数据仍在, 但与服务端可能不一致) |
| 4 | **上传中断 (zip 半传)** | checkin 时网络断开, zip 只传了一半 | fetch 抛 AbortError / TypeError | 服务端 multipart 解析失败 → 不写 snapshot.zip.tmp, 不释放锁, 返回 400。旧 snapshot.zip 完全不受影响 | 客户端重试 checkin (本地数据未变, 重新 export + upload)。如果多次失败, 锁靠 TTL 过期。**关键**: 服务端只在 multipart 完整解析后才写 tmp 文件, 半传请求不会碰任何持久化文件 |
| 5 | **首次启用: 本地有数据, 服务器空** | 用户一直本地用, 刚配好同步 | GET /state → hasSnapshot=false | 服务器无 snapshot | 客户端走「首次推送」: exportAllData → POST /checkin (无锁校验首次特例)。服务器存快照, version=1 |
| 6 | **首次启用: 本地有数据, 服务器也有数据** | 两台设备各自有不同数据, 同时开启同步 | GET /state → hasSnapshot=true, version>0 | 服务器已有数据 | 弹 modal 引导: "服务器已有数据(版本 N)。您本地也有数据。选择: [拉取服务器覆盖本地] 或 [上传本地覆盖服务器]" |
| 7 | **服务器重启** | systemd restart 或崩溃恢复 | 短暂 offline, 重连后正常 | 从 lock.json 恢复锁状态, 从 version.txt 恢复版本号。如果锁已过期(根据 acquiredAt + TTL < now), 标记为 UNLOCKED | 客户端短暂报 offline, 轮询恢复后正常。锁状态完整恢复 |
| 8 | **schema_version 不匹配** | 客户端应用升级后 manifest.schema_version 与服务器快照不一致 | checkout 拉回 zip → importAllData → 抛错("schema_version=X, 当前应用只支持 Y") | 服务器不校验 schema_version (只存 zip) | 客户端拦截 importAllData 的错误, 提示 "服务器数据版本不兼容, 请升级应用" |
| 9 | **客户端时钟漂移** | 设备时间不准, 导致 heartbeat 判断错误 | 客户端本地时间与服务端不同步 | **完全不依赖客户端时间**。所有 TTL 判断用服务端 `Date.now()`。state 响应包含 serverTime, 客户端可计算时钟偏差 | 客户端用服务端返回的 expiresAt 判断锁状态, 不用本地时间 |

### 5.1 场景 2 (version 冲突) 的详细处理

这是最棘手的场景, 因为 A 的本地数据已经修改了, 但被服务器拒绝:

```
时间线:
  T0: A checkout (v=7), 获锁
  T1: A 开始编辑 (添加了新的化验报告)
  T2: A 网络断开 (进电梯)
  T3: A 的锁 TTL 过期 (30min 后)
  T4: B checkout (v=7), 获锁
  T5: B 编辑 + checkin (v=8), 释放锁
  T6: A 网络恢复, 尝试 checkin (v=7)
  T7: 服务器拒绝: VERSION_CONFLICT (当前 v=8, A 的 v=7)
```

**客户端处理**:
1. syncState → 'error', syncError = { kind: 'version-conflict', message: '...' }
2. UI 显示: "同步冲突: 服务器数据已被更新到版本 8。您的本地修改 (T1-T2 之间) 无法自动合并。"
3. 提供两个选项:
   - **「拉取最新覆盖本地」**: 重新 checkout (拉 v=8), **本地 T1-T2 的修改会丢失**。建议用户手动记下新增内容
   - **「导出本地备份」**: 调 exportAllData() 下载 zip, 人工对比后重新录入

**为什么不自动合并**: 已明确不做 record-level merge。家庭医疗数据, 合并出错的风险远大于让用户手动处理。明确告知 + 用户决策 > 静默数据丢失。

### 5.2 场景 5 (首次推送) 的 checkout 特例

首次使用时服务器无 snapshot, 正常 checkout 会返回 404 NO_SNAPSHOT。此时需要一个「无锁上传」路径:

**方案**: 新增 `POST /api/sync/seed` 端点 (或复用 checkin 但允许 version=0):

```
POST /api/sync/seed   (首次初始化专用)
Body: multipart (zip + clientId)

服务端逻辑:
  if (version.txt exists && version > 0) → 409 "已有数据, 用 checkout/checkin"
  else → 存 snapshot.zip, version=1, 不需要锁
```

**为什么单独端点而不是复用 checkin**: checkin 的语义是「我有锁, 提交修改」, 需要先 checkout。首次推送没有 checkout 可做 (服务器无数据), 语义不匹配。seed 端点明确「初始化」语义。

---

## 6. COOP/COEP + fetch 兼容性分析

> **这是本设计文档最重要的章节。** COOP/COEP 配置错误会导致 SharedArrayBuffer 不可用, sqlite-wasm OPFS 直接挂掉。

### 6.1 背景: COEP 的工作原理

当前页面通过 Caddy 设置了:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

这使得 `window.crossOriginIsolated === true`, 从而 `SharedArrayBuffer` 可用, sqlite-wasm 的 OPFS 后端才能工作。

**COEP: require-corp 的核心约束**: 页面上**所有** subresource 响应必须满足以下条件之一, 否则被浏览器拦截:

1. **同源响应**: 请求 URL 的 origin 与页面 origin 相同
2. **跨源响应带 CORP 头**: 响应包含 `Cross-Origin-Resource-Policy: same-origin` (或 `cross-origin` + CORS)
3. **通过 CORS opt-in**: 请求使用了 `mode: 'cors'`, 响应有正确的 `Access-Control-Allow-Origin`

### 6.2 同源 fetch 在 COEP 页面是否受限?

**结论: 同源 fetch 本身不受 COEP 限制, 但实际取决于浏览器实现细节。**

根据 [COEP 规范 (W3C)](https://w3c.github.io/webappsec-cross-origin-embedder-policy/):

> When COEP is `require-corp`, the browser checks every response's CORP (Cross-Origin-Resource-Policy) header regardless of whether it's same-origin or cross-origin.

**翻译**: COEP `require-corp` 模式下, 浏览器会对**所有**响应 (包括同源) 检查 CORP 头。但是:

- 同源响应如果**没有** CORP 头, 浏览器默认**允许** (CORP 的默认值是 `same-origin` for same-origin responses in most browsers)
- Chrome 的实际实现: 同源无 CORP 头 → 允许; 跨源无 CORP 头 → 拦截

**实测验证**: 在 Chrome/ Firefox 中, 同源 `fetch('/api/sync/state')` 在 COEP 页面上可以正常工作, **即使响应不带 CORP 头**。这是因为 COEP 规范定义的 CORP 检查对于同源响应有隐式允许。

**明确结论**: 同源 fetch **不需要** CORP 头。浏览器规范中, COEP `require-corp` 对同源响应有隐式放行。但**仍然加 `Cross-Origin-Resource-Policy: same-origin` 作为保险**, 原因:
1. 消除浏览器实现差异的不确定性 (规范 vs 实际实现可能有偏差)
2. 明确表达意图, 代码自文档化
3. 如果未来引入 Service Worker 导致请求看起来像跨源, 也不会出问题
4. 成本极低 (一个 header), 收益是确定性

### 6.3 需要分析的每个 fetch 类型

| Fetch 类型 | URL | COEP 影响? | 需要的处理 |
|-----------|-----|-----------|-----------|
| JSON GET (state, heartbeat) | `/api/sync/state` | 同源, 理论上不受限 | 加 CORP 头保险 |
| Binary GET (snapshot/checkout) | `/api/sync/checkout` | 同源, 大 binary | 加 CORP + Content-Length |
| Multipart POST (checkin) | `/api/sync/checkin` | 同源, 上传 | 加 CORP |
| DELETE (lock) | `/api/sync/lock` | 同源 | 加 CORP |
| 轮询 fetch (每 30s state) | `/api/sync/state` | 同源, 高频 | 加 CORP |

### 6.4 下载大 binary (zip) 的处理

checkout 响应体是 zip binary (可能几十 MB)。需要考虑:

1. **Content-Length**: 服务端必须设置, 让浏览器显示下载进度
2. **流式传输 vs 缓冲**: Node.js 应该用 `fs.createReadStream` pipe 到 response, 不全量读入内存
3. **fetch 响应处理**: 客户端用 `response.blob()` 收集完整 zip, 再传给 `importAllData()`
4. **内存占用**: zip 几十 MB + JSZip 解析, 内存峰值可能达 100-200MB。移动设备需注意, 但家庭医疗数据量可控

**不需要 stream / chunked processing**: importAllData 接受 Blob, JSZip 内部处理。fetch → blob → JSZip → OPFS 的管线已经够用。

### 6.5 上传 multipart/form-data 的处理

```js
const formData = new FormData();
formData.append('version', String(version));
formData.append('clientId', clientId);
formData.append('snapshot', zipBlob, 'snapshot.zip');

fetch('/api/sync/checkin', {
  method: 'POST',
  headers: { 'X-Sync-Token': token },
  body: formData,   // 浏览器自动设置 Content-Type: multipart/form-data; boundary=...
});
```

**注意**: 不要手动设置 `Content-Type` header, 让浏览器自动生成 boundary。

**COEP 对上传无影响**: COEP 检查的是**响应**, 不是请求。上传的请求体不受 COEP 约束。但 checkin 的**响应** (JSON 确认) 需要带 CORP 头 (已在 Nginx 全局配置)。

### 6.6 最终方案: 给 /api/ 响应统一加 CORP 头

**决策**: 选择「给所有 `/api/` 响应加 `Cross-Origin-Resource-Policy: same-origin` 头」方案。

**为什么不给 `/api/` 路径排除 COEP**: COEP 是页面级 (per-page) 的 header, 不是 per-path。当前 COEP 在 Caddy 层面对整个域名设置。要做 per-path 排除, 需要:
- 把 `/api/` 代理到不同 origin (不同端口/域名) — 增加复杂度 + 证书管理
- 或者用 service worker 拦截 — 过于复杂

统一加 CORP 头更简单, 且不改变现有 COOP/COEP 配置。

### 6.7 配置方案: 去掉 Caddy, Nginx 一层管全部

**明确决策: 去掉 Caddy 层。**

当前架构 `浏览器 → Nginx :443 → Caddy :8080 → 静态文件` 中, Caddy 的唯一作用是静态文件服务 + COOP/COEP header。Nginx 完全可以做这两件事。

去掉 Caddy 的理由:
1. 减少一层代理 = 减少一个 COOP/COEP 配置出错点
2. 减少一个需要维护的 systemd 进程
3. Nginx 静态文件服务性能优于 Caddy 反代
4. Caddy 的自动 HTTPS 在此架构中无用 (Nginx 已经终结 SSL)

新架构: `浏览器 → Nginx (:443) → 静态文件 / Sync Server (:3001)`

#### 6.7.1 Nginx 配置 (唯一方案)

```nginx
# /etc/nginx/sites-available/maohedong.top

server {
    listen 443 ssl http2;
    server_name maohedong.top;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # COOP/COEP/CORP 全局 (静态 + API 都带)
    # always = 确保 4xx/5xx 错误响应也带头 (COEP 兼容)
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
    add_header Cross-Origin-Resource-Policy "same-origin" always;

    # 静态文件
    root /var/www/medmemory;
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 反代 → Sync Server
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        client_max_body_size 500M;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

**关键点**:
- COOP/COEP/CORP 全局设置在 `server` 级别, 静态文件和 API 响应都带
- `always` 确保错误响应 (4xx/5xx) 也带 CORP 头, 否则 COEP 页面连错误 JSON 都读不到
- `proxy_request_buffering off` 流式上传 zip, 不在 Nginx 缓冲
- `proxy_read_timeout 300s` 慢网络下载 zip 不超时

#### 6.7.2 Caddy 停用步骤

```bash
# 1. 在 Nginx 配置好静态文件 + API 反代后, 测试 Nginx 配置
sudo nginx -t

# 2. 重载 Nginx
sudo nginx -s reload

# 3. 停用 Caddy
sudo systemctl stop caddy
sudo systemctl disable caddy

# 4. 验证 crossOriginIsolated
# 在浏览器控制台执行: window.crossOriginIsolated
# 预期: true
```

#### 6.7.3 curl 验证 COEP 兼容性

部署后用 curl 验证响应头:

```bash
# 验证静态文件带 COOP/COEP/CORP
curl -I https://maohedong.top/
# 预期: 200 + Cross-Origin-Opener-Policy: same-origin
#        + Cross-Origin-Embedder-Policy: require-corp
#        + Cross-Origin-Resource-Policy: same-origin

# 验证 API 响应带 CORP (即使错误响应)
curl -I https://maohedong.top/api/sync/state
# 预期: 200 或 401 + Cross-Origin-Resource-Policy: same-origin

# 验证 COEP 不影响上传
curl -X POST https://maohedong.top/api/sync/checkout \
  -H "X-Sync-Token: test" \
  -H "Content-Type: application/json" \
  -d '{"clientId":"test","clientLabel":"test"}'
# 预期: 200 (zip binary) 或 409 (锁被占), 都带 CORP 头
```

### 6.8 心跳/轮询的 COEP 影响

轮询 `/api/sync/state` 每 30 秒一次 (只读模式), heartbeat 每 10 分钟一次 (编辑模式)。都是同源 fetch, 加了 CORP 头后不受 COEP 限制。与普通 fetch 无差异。

**频率限制提醒**: 30 秒轮询一天 = 2880 次请求, 对轻量服务器完全可控。如果未来用户增加, 可以改为长轮询或 SSE (但当前不做)。

---

## 7. 认证设计

### 7.1 共享密钥方案

| 项目 | 设计 |
|------|------|
| Token 类型 | 随机字符串 (32 字节 hex), 如 `a1b2c3d4e5f6...` (64 字符) |
| 传输方式 | 请求头 `X-Sync-Token: <token>` |
| 客户端存储 | localStorage (与 AI 配置同模式) |
| 服务端存储 | 环境变量 `SYNC_TOKEN` |
| 验证方式 | 时间固定比较 (防 timing attack) |

**为什么不用 per-user 账号**: 家庭 2 人共用, 没有独立账号需求。一个共享 token 最简单, 符合自用场景。

**为什么不用 JWT**: 过度设计。只有一个 endpoint 集群, 一个 token, 不需要签名/过期/刷新机制。

**CORS / Origin 校验**: 服务端**不配置** CORS, 不设置 `Access-Control-Allow-Origin`, 不处理 OPTIONS preflight 请求。所有 API 请求都是同源 (页面在 `maohedong.top`, API 在 `maohedong.top/api/`)。同源请求不触发 CORS 检查。

如果恶意网页 (不同 origin) 尝试调 API:
- 带 `X-Sync-Token` 自定义 header 的请求 (checkout/checkin/heartbeat/lock) 会触发 preflight OPTIONS
- 服务端不响应 OPTIONS → 浏览器自动拦截实际请求
- 这是**期望行为**, 不需要修复

`/api/sync/state` 虽然允许不带 token 的 GET, 但跨源 fetch 的响应会被 CORP `same-origin` 头阻止读取。攻击者只能知道"服务器存在", 无法获取任何数据。

### 7.2 客户端存储 (复用 useAiConfig 模式)

localStorage key:
```
medmemory:sync:serverUrl     → "https://maohedong.top"
medmemory:sync:token         → "a1b2c3d4..."
medmemory:sync:clientId      → "device-uuid-abc-123" (首次生成, 永久)
medmemory:sync:clientLabel   → "爸爸的手机" (用户填写)
```

**clientId 生成策略**: `crypto.randomUUID()` (浏览器原生, uuid v4), 首次启用同步时生成, 存 localStorage。用于 checkout/heartbeat/checkin 的身份标识。

**为什么 clientId 存 localStorage 而非 sessionStorage**: 同一设备的多个 tab/会话应共享 clientId (代表设备, 不是会话)。

### 7.3 服务端验证

时间固定比较 (防止 timing attack 泄露 token 长度信息):

```text
import crypto from 'crypto';

function validateToken(received: string, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

### 7.4 速率限制

| 端点 | 限制 | 理由 |
|------|------|------|
| `POST /checkout` | 每 clientId 10 次/分钟 | 防暴力 checkout 尝试 |
| `POST /checkin` | 每 clientId 10 次/分钟 | 大文件上传, 10/min 已很宽松 |
| `POST /heartbeat` | 每 clientId 20 次/分钟 | 10 分钟一次正常, 20/min 给余量 |
| `GET /state` | 每 IP 60 次/分钟 | 30s 轮询 = 2/min, 60/min 给 30 倍余量 |
| `DELETE /lock` | 每 clientId 3 次/分钟 | 紧急操作, 不应高频 |
| `GET /snapshot` | 每 clientId 5 次/分钟 | 大文件下载, 限流 |

**实现思路**: 进程内 Map<key, {count, resetAt}>。每个 key (clientId 或 IP) 对应一个计数器, 滑动窗口或固定窗口均可。超出返回 429 + `Retry-After` 头。

**为什么不用 Redis**: 单进程 + 2 用户, 进程内 Map 完全够。Redis 增加运维负担。

---

## 8. 文件清单

### 8.1 新建文件

#### `server/package.json`

**职责**: Node.js 项目描述, 声明依赖。

**技术选型决策: Node.js + Express**

| 候选 | 优势 | 劣势 | 决策 |
|------|------|------|------|
| **Node.js + Express** | 与前端同语言; multipart/文件操作生态成熟; 2 人用户场景性能无忧 | 需要额外进程管理 | **选这个** |
| Python Flask | 文件操作简洁 | 又引入一种语言; Python 异步文件操作不如 Node | 不选 |
| Go | 单二进制部署, 性能好 | 语言切换成本高; 过度设计 | 不选 |
| Cloudflare Workers | 无服务器 | zip 几十 MB 超出 Workers 限制; 不适合大文件 | 不选 |

**选 Node.js + Express 的核心理由**: 与前端同语言 (降低维护成本), 文件流处理能力强 (pipe), 生态成熟 (multer/multipart), 2 用户场景下性能完全够用。

**主要依赖**:
- `express` — HTTP 服务
- `multer` — multipart/form-data 解析 (checkin 上传 zip)
- 不需要 `cors` (同源, 不需要 CORS)
- 不需要数据库 (文件系统存储)

**签名**:
```json
{
  "name": "medmemory-sync-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node sync-server.js",
    "dev": "node --watch sync-server.js"
  },
  "dependencies": {
    "express": "^4.x",
    "multer": "^1.x"
  }
}
```

---

#### `server/sync-server.js`

**职责**: 同步服务主体, 实现 6 个 API 端点 + 锁管理 + 持久化。

**导出/主要结构** (设计签名, 不写实现):

```text
// === 配置 ===
const PORT = 3001;
const DATA_DIR = '/var/www/medmemory-sync';
const SYNC_TOKEN = process.env.SYNC_TOKEN;
const LOCK_TTL_MS = 30 * 60 * 1000;     // 30 分钟
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500MB

// === 锁管理器 ===
class LockManager {
  private mutex: Mutex;
  private state: LockState;       // lock.json 内容
  private version: number;        // version.txt 内容

  // 原子操作 (经 mutex 保护)
  async acquireLock(clientId, clientLabel): Promise<{ version, expiresAt }>
  async releaseLock(clientId): Promise<void>
  async heartbeat(clientId): Promise<{ expiresAt, version }>
  async forceRelease(): Promise<{ previousHolder }>
  async checkVersion(expected): boolean  // 乐观锁校验
  async getState(): SyncStateResponse     // 含惰性过期清理
  async saveSnapshot(zipBuffer): void     // tmp → rename
}

// === Express app ===
// GET  /api/sync/state
// GET  /api/sync/snapshot
// POST /api/sync/checkout
// POST /api/sync/checkin
// POST /api/sync/heartbeat
// DELETE /api/sync/lock
// POST /api/sync/seed          (首次初始化)

// === 中间件 ===
// authMiddleware        — X-Sync-Token 校验
// rateLimitMiddleware   — 速率限制
// corpHeaderMiddleware  — 给所有响应加 Cross-Origin-Resource-Policy: same-origin

// === 启动 ===
app.listen(PORT)
```

---

#### `server/README.md`

**职责**: 部署/启动/配置说明, 给 AI 助手「龙虾」操作服务器用。

**内容大纲**:
1. 前置条件 (Node.js 版本, 目录权限)
2. 环境变量 (SYNC_TOKEN, PORT, DATA_DIR)
3. 安装步骤 (npm install)
4. 启动 (npm start / systemd)
5. Nginx 配置
6. 常见问题 (端口占用, 权限, COEP)

---

#### `deploy/sync-nginx.conf.example`

**职责**: Nginx 反代配置示例, 包含 `/api/` 路径 + CORP 头 + 大文件设置。

**内容**: 即本文档 6.7.1 的 Nginx 配置片段, 作为独立文件方便复制。

---

#### `deploy/deploy-sync.sh`

**职责**: 部署脚本, rsync server/ 到服务器 + systemd 重启。

**签名**:
```bash
#!/usr/bin/env bash
# deploy/deploy-sync.sh
# 用法: ./deploy/deploy-sync.sh

# 1. rsync server/ → 服务器:/opt/medmemory-sync/
# 2. ssh npm install (production)
# 3. ssh systemctl restart medmemory-sync
# 4. 验证: curl https://maohedong.top/api/sync/state
```

---

#### `deploy/medmemory-sync.service`

**职责**: systemd unit 文件, 管理 sync-server 进程。

**签名**:
```ini
[Unit]
Description=MedMemory Sync Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/medmemory-sync
Environment=SYNC_TOKEN=<token>
Environment=PORT=3001
Environment=DATA_DIR=/var/www/medmemory-sync
ExecStart=/usr/bin/node sync-server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

---

#### `src/composables/useSync.ts`

**职责**: 客户端同步 composable, 封装所有同步逻辑。详见第 9 章。

---

#### `src/components/SyncIndicator.vue`

**职责**: 全局同步状态指示器, 挂载在 App.vue 导航栏。

**Props/状态**: 从 useSync() 获取 reactive state。

**显示文案**:

| syncState | 图标 | 文案 | 颜色 |
|-----------|------|------|------|
| `idle` | 同步图标 | "已同步 v{N}" | 绿色 |
| `pulling` | 转圈 | "拉取数据中..." | 蓝色 |
| `pushing` | 上传图标 | "上传数据中..." | 蓝色 |
| `editing` | 编辑图标 | "编辑中 (剩 {min}分钟)" | 橙色 |
| `locked-by-other` | 锁图标 | "{label}编辑中" | 灰色 |
| `offline` | 断网图标 | "离线" | 红色 |
| `error` | 警告图标 | "同步错误" | 红色 |

**交互**: 点击展开详情 (最后同步时间, 服务器版本, 锁状态, 操作按钮)。

---

#### 测试文件 (Phase 4 才写, 设计阶段先列出)

| 文件 | 职责 |
|------|------|
| `server/test/sync-server.test.js` | API 端点测试 (state/checkout/checkin/heartbeat/seed) |
| `server/test/lock.test.js` | 锁状态机测试 (acquire/release/expire/heartbeat) |
| `server/test/concurrency.test.js` | 并发 checkout 竞态测试 |
| `src/composables/__tests__/useSync.test.ts` | 客户端 composable 测试 |

---

### 8.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/views/SettingsView.vue` | 新增「数据同步」section: server URL, token, clientId, clientLabel 输入 + testConnection 按钮 + 当前同步状态展示 |
| `src/App.vue` | 导航栏挂载 `<SyncIndicator />`, 调用 `useSync().initOnAppStart()` |
| `deploy/Caddyfile` | 停用 Caddy (文档 §6.7 已决策), Nginx 接管静态文件 + COOP/COEP/CORP |
| Nginx 配置 | 新增 `/api/` location block + CORP 头 |

---

## 9. useSync.ts API 设计

### 9.1 类型定义

```typescript
type SyncState =
  | 'idle'              // 已同步, 无锁, 本地数据 = 服务器数据
  | 'pulling'           // 正在拉取快照 (checkout/import)
  | 'pushing'           // 正在上传快照 (export/checkin)
  | 'editing'           // 持有编辑锁, 用户可编辑
  | 'locked-by-other'   // 锁被别人持有, 只读模式
  | 'offline'           // 网络不可用 / 服务器不可达
  | 'error';            // 同步错误 (auth/version/server)

type SyncError = {
  kind: 'auth' | 'version-conflict' | 'network' | 'server';
  message: string;
  details?: Record<string, unknown>;
};

type LockHolder = {
  clientId: string;
  clientLabel: string;
};

type SyncConfig = {
  serverUrl: string;     // 'https://maohedong.top'
  token: string;         // 共享密钥
  clientId: string;      // 设备 UUID
  clientLabel: string;   // '爸爸的手机'
};
```

### 9.2 导出 API

```typescript
export function useSync(): {
  // === 顶层 reactive state ===
  syncState: Readonly<Ref<SyncState>>;
  syncError: Readonly<Ref<SyncError | null>>;
  serverVersion: Readonly<Ref<number | null>>;
  lockHolder: Readonly<Ref<LockHolder | null>>;
  lastSyncAt: Readonly<Ref<Date | null>>;
  lockExpiresAt: Readonly<Ref<Date | null>>;

  // === 配置 ===
  config: Readonly<Ref<SyncConfig | null>>;
  saveConfig(partial: Partial<SyncConfig>): void;
  clearConfig(): void;

  // === 生命周期 ===
  initOnAppStart(): Promise<void>;

  // === 操作 ===
  checkout(): Promise<void>;
  checkin(): Promise<void>;
  forceReleaseLock(): Promise<void>;

  // === 工具 ===
  testConnection(): Promise<{ ok: boolean; message: string }>;

  // === 内部 (测试用) ===
  _heartbeat(): Promise<void>;
  _pollState(): Promise<void>;
}
```

### 9.3 方法详细语义

#### `initOnAppStart(): Promise<void>`

App.vue `onMounted` 时调用。

流程:
1. 读 localStorage 获取 config (serverUrl + token + clientId + clientLabel)
2. 如果 config 不完整 → syncState = 'idle', 返回 (同步未配置)
3. fetch `GET /api/sync/state`
4. 根据 state 响应更新 syncState / serverVersion / lockHolder / lockExpiresAt
5. 如果 lockedBy.clientId === 本机 clientId → syncState = 'editing' (上次 checkout 未正常 checkin)
6. 如果 lockedBy 且 clientId 不匹配 → syncState = 'locked-by-other', 启动轮询
7. 注册 `online` / `offline` / `beforeunload` 事件监听
8. 如果 syncState = 'editing', 启动 heartbeat 定时器

#### `checkout(): Promise<void>`

用户主动点击「开始编辑」时调用。

流程:
1. syncState = 'pulling'
2. fetch `POST /api/sync/checkout` (body: clientId + clientLabel)
3. 如果 409 LOCK_HELD_BY_OTHER → syncState = 'locked-by-other', 抛 SyncError
4. 如果 200 → 拿到 zip blob + version + expiresAt
5. 调 `importAllData(zipBlob)` (复用 useDataBackup)
6. importAllData 成功 → syncState = 'editing', serverVersion = version, lockExpiresAt = expiresAt
7. 启动 heartbeat 定时器
8. importAllData 失败 → syncState = 'error', 抛 SyncError

#### `checkin(): Promise<void>`

用户主动点击「完成编辑」/「同步」时调用。

流程:
1. syncState = 'pushing'
2. 调 `exportAllData()` → zip Blob
3. 构造 FormData: version + clientId + zip
4. fetch `POST /api/sync/checkin`
5. 如果 200 → syncState = 'idle', serverVersion = newVersion, lastSyncAt = now
6. 如果 409 VERSION_CONFLICT → syncState = 'error', syncError = { kind: 'version-conflict' }
7. 停止 heartbeat 定时器
8. 网络失败 → 重试 3 次 (指数退避 1s/2s/4s), 全部失败 → syncState = 'error'

#### `forceReleaseLock(): Promise<void>`

紧急释放锁 (设置页/调试用)。

流程:
1. fetch `DELETE /api/sync/lock` (body: clientId + force: true)
2. 200 → syncState = 'idle'
3. 停止 heartbeat

#### `testConnection(): Promise<{ ok: boolean; message: string }>`

设置页「测试连接」按钮用。

流程:
1. fetch `GET /api/sync/state` (带 token)
2. 200 → { ok: true, message: `已连接, 服务器版本 ${version}` }
3. 401 → { ok: false, message: '密钥错误' }
4. 网络失败 → { ok: false, message: '无法连接服务器' }

### 9.4 事件钩子管理

```text
onMounted (initOnAppStart 内部):
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  window.addEventListener('beforeunload', handleBeforeUnload)

onUnmount (或 App 卸载):
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('beforeunload', handleBeforeUnload)
  clearInterval(heartbeatTimer)
  clearInterval(pollTimer)
```

### 9.5 Heartbeat 定时器管理

```text
// checkout 成功后启动
let heartbeatFailCount = 0;
heartbeatTimer = setInterval(() => {
  if (syncState.value !== 'editing') {
    clearInterval(heartbeatTimer);
    return;
  }
  // 距 expiresAt < 5 分钟时立即续期 (不等 10 分钟间隔)
  _heartbeat()
    .then(() => { heartbeatFailCount = 0; })
    .catch(() => {
      heartbeatFailCount++;
      if (heartbeatFailCount === 1) {
        // 首次失败: 弹非阻塞 toast, 不中断编辑
        showToast('网络异常, 编辑锁可能丢失, 请检查网络');
      }
      if (heartbeatFailCount >= 2) {
        // 连续 2 次失败: 进入 error 状态
        // (不再等第 3 次, 让用户尽早知道)
        syncState.value = 'error';
        syncError.value = {
          kind: 'network',
          message: 'heartbeat 连续失败, 编辑锁可能已被释放',
        };
      }
    });
}, 10 * 60 * 1000); // 10 分钟
```

### 9.6 只读模式轮询

```text
// 进入 locked-by-other 状态时启动
pollTimer = setInterval(() => {
  _pollState().catch(() => {});
}, 30 * 1000); // 30 秒

// _pollState 内部:
//   GET /api/sync/state
//   如果 lockedBy 变为 null → syncState = 'idle' (锁释放了)
//   如果 lockedBy.clientId 变为本机 → syncState = 'editing' (异常恢复)
//   停止 pollTimer 当离开 locked-by-other 状态
```

### 9.7 状态转换图 (useSync 内部)

```
                          initOnAppStart()
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
                idle    locked-by-other    editing
                    │           │           │
                checkout()  (轮询发现锁释放)  │
                    │           │           │
                    ▼           ▼           │
                pulling ←──────┘           │
                    │                       │
                    ▼                       │
                editing ←───────────────────┘
                    │
                checkin()
                    │
                    ▼
                pushing
                    │
              ┌─────┼─────┐
              ▼     ▼     ▼
            idle  error  (重试)
                  │
            (用户处理冲突)
```

### 9.8 错误状态恢复

| syncError.kind | 进入条件 | 恢复方式 |
|----------------|---------|---------|
| `auth` | 401 AUTH_INVALID | 用户在设置页修改 token |
| `version-conflict` | 409 VERSION_CONFLICT | 用户选择: 重新 checkout (丢本地修改) 或 导出本地备份 |
| `network` | fetch 抛 TypeError | 网络恢复后自动重试 (online 事件) |
| `server` | 500 INTERNAL | 重试, 或联系管理员 |

---

## 10. UX 设计

### 10.1 同步指示器状态文案

SyncIndicator.vue 在导航栏右侧常驻:

```
┌─────────────────────────────────────────────────────────────┐
│  家庭医疗记忆  | 首页 待整理 +记录 成员 ... 设置  [● 已同步 v7] │
└─────────────────────────────────────────────────────────────┘
                                                  ↑ SyncIndicator
```

各状态:

| 状态 | 指示器显示 | 悬浮提示 | 点击展开 |
|------|-----------|---------|---------|
| idle | 绿色圆点 + "已同步 v7" | "最后同步: 2 小时前" | 详情 + 「开始编辑」按钮 |
| pulling | 蓝色转圈 + "拉取中..." | "正在从服务器拉取数据" | 进度 |
| pushing | 蓝色转圈 + "上传中..." | "正在上传到服务器" | 进度 |
| editing | 橙色圆点 + "编辑中 剩 18分钟" | "点击完成编辑并同步" | 详情 + 「完成编辑」按钮 + 剩余时间 |
| locked-by-other | 灰色锁 + "妈妈编辑中" | "只读模式" | 详情: 锁主 + 过期时间 + 「刷新状态」 |
| offline | 红色断网 + "离线" | "无法连接服务器" | 重试按钮 |
| error | 红色警告 + "同步错误" | 错误简述 | 详情 + 操作建议 |

### 10.2 锁过期前 5 分钟提醒

当 `editing` 状态下距 `lockExpiresAt` < 5 分钟时:

1. SyncIndicator 变为闪烁橙色 + "编辑中 剩 4分钟!"
2. 如果 heartbeat 还在工作, 自动续期 (不需要用户操作)
3. 如果 heartbeat 连续失败 (网络问题), 弹 toast: "编辑锁即将过期 (剩 4 分钟), 请检查网络或尽快完成编辑"

**实现**: 在 heartbeat 定时器中检查 `lockExpiresAt - now`, 如果 < 5 分钟, 触发 UI 提醒。

### 10.3 首次同步引导

#### 场景 A: 本地有数据 + 服务器空 (hasSnapshot=false)

```
┌─────────────────────────────────────────────┐
│  首次同步                                    │
├─────────────────────────────────────────────┤
│                                             │
│  服务器上还没有数据。                         │
│  您本地有: 3 名成员, 42 条事件, 128 个附件    │
│                                             │
│  点击「上传」将本地数据推送到服务器。          │
│                                             │
│  ┌──────────┐  ┌──────────┐                 │
│  │  上传     │  │  取消    │                 │
│  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────┘
```

点击上传 → `POST /api/sync/seed`

#### 场景 B: 本地有数据 + 服务器也有数据

```
┌─────────────────────────────────────────────────┐
│  数据冲突                                       │
├─────────────────────────────────────────────────┤
│                                                 │
│  服务器已有数据 (版本 7)。                        │
│  您本地也有不同的数据。                           │
│                                                 │
│  ⚠ 无法自动合并, 请选择:                         │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │ ○ 拉取服务器覆盖本地                        │ │
│  │   服务器: 3 成员, 50 事件                   │ │
│  │   本地将被覆盖 (建议先导出本地备份)          │ │
│  │                                           │ │
│  │ ○ 上传本地覆盖服务器                        │ │
│  │   本地: 2 成员, 42 事件                    │ │
│  │   服务器数据将丢失                          │ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │  确认     │  │ 导出本地  │  │  取消    │     │
│  └──────────┘  └──────────┘  └──────────┘     │
└─────────────────────────────────────────────────┘
```

**二次确认**: 用户选择任一覆盖选项并点击「确认」后, 弹二次确认对话框:

```
┌─────────────────────────────────────────────────┐
│  最后确认                                       │
├─────────────────────────────────────────────────┤
│                                                 │
│  ⚠ 您选择的是「上传本地覆盖服务器」              │
│                                                 │
│  服务器版本 7 的数据将被永久覆盖, 不可撤销。      │
│                                                 │
│  确定要继续吗?                                  │
│                                                 │
│  ┌──────────┐         ┌──────────┐             │
│  │  覆盖     │         │  取消    │             │
│  └──────────┘         └──────────┘             │
└─────────────────────────────────────────────────┘
```

二次确认后才执行覆盖操作。防止用户误点导致数据立即丢失。

### 10.4 编辑期间关闭页面的提示

```js
// beforeunload handler — 只弹提示, 不做网络请求
function handleBeforeUnload(e: BeforeUnloadEvent): void {
  if (syncState.value === 'editing') {
    // 标准方式: 设置 returnValue 触发原生对话框
    e.preventDefault();
    e.returnValue = '';

    // 不做 auto-checkin:
    // - fetch keepalive 限制 64KB body, zip 几乎不可能这么小
    // - 截断的 multipart 可能导致服务端写入损坏 zip, 风险 > 收益
    // - 本地数据靠 OPFS/IDB 持久化, 关闭浏览器不会丢失
    // - 锁靠 TTL 30 分钟自然过期
  }
}
```

浏览器原生弹窗 (不可自定义文案):

```
┌─────────────────────────────────────────────────┐
│  离开此网站?                                    │
│                                                 │
│  系统可能不会保存您所做的更改。                   │
│                                                 │
│  [离开]  [取消]                                 │
└─────────────────────────────────────────────────┘
```

**用户重新打开时的体验**:
- `initOnAppStart()` 发现 lockedBy.clientId === 本机 clientId → syncState = 'editing'
- 恢复编辑状态, 本地数据完好 (OPFS + IDB)
- 用户可以继续编辑或主动 checkin

---

## 11. 未覆盖 / 未来工作

### 11.1 本文档未覆盖的边缘场景

| 场景 | 当前处理 | 未来改进 |
|------|---------|---------|
| 多设备同时 checkout (3+ 设备) | Mutex 串行化, 第一个获锁, 其余 409 | 无需改进, 当前方案已正确处理 |
| 附件超大 (> 500MB 总量) | checkin 返回 413 | 考虑增量同步 / 分块上传 |
| 服务器磁盘满 | checkin 写 snapshot.zip.tmp 失败 → 返回 503 `STORAGE_ERROR`。旧 snapshot.zip 完全不受影响 (tmp→rename 保护)。锁不释放 (设计如此)。客户端重试 3 次仍失败 → syncState='error', 本地数据完好。管理员清理磁盘后客户端可重新 checkin | 监控告警 (磁盘使用率 > 80%); 未来可自动清理历史快照 |
| Token 泄露 | 手动更换环境变量 + 客户端更新 | 支持 token 轮换 (新旧 token 并行期) |
| 多个 tab 同时打开 | clientId 相同, 都认为自己持锁 | 用 BroadcastChannel 协调 tab |
| Service Worker 离线缓存 | 不涉及 (SW 目前不做) | 未来可用 SW 缓存只读快照 |
| 数据加密 at rest | 服务器存明文 zip | 如需要, 客户端加密后上传 (服务器无法解密) |

### 11.2 未来优化方向

1. **增量快照**: 只传 sqlite diff + 新增 blob, 减少传输量。当前全量 zip 对 2 人家庭可控, 数据量增大后值得做。
2. **WebSocket 状态推送**: 替代 30s 轮询, 锁状态变化实时推送。当前轮询足够, 未来用户增多时考虑。
3. **自动 checkin 提醒**: 编辑 20 分钟后弹 toast "您已编辑较长时间, 要不要同步一下?"
4. **多版本回溯**: 服务端保留最近 N 个 snapshot.zip (如 5 个), 支持回滚到任意版本。当前只保留最新版。
5. **Service Worker offline-first**: SW 缓存上次 checkout 的 zip, 离线时可查看 (只读)。需要解决 OPFS 访问的 SW 限制。

### 11.3 设计阶段的已知取舍

| 取舍 | 选择了 | 代价 |
|------|--------|------|
| 全量 zip vs 增量同步 | 全量 zip | 数据量大时 checkout/checkin 慢 |
| TTL 锁 vs 显式释放 | TTL + heartbeat | 浏览器崩溃后锁占用 30 分钟 |
| 单进程 vs 多进程 | 单进程 (Mutex) | 服务器重启期间不可用 (~1s) |
| 文件系统 vs 数据库 | 文件系统 (lock.json + zip) | 并发写可能竞争 (Mutex 已解决) |
| 共享 token vs 用户账号 | 共享 token | 无法区分用户身份 (靠 clientLabel) |
| 无 SW 缓存 vs SW offline | 无 SW | 离线时无法查看数据 (本地 OPFS 仍有) |

---

## 附录 A: 服务器部署一键脚本 (给「龙虾」用)

```bash
# === 在服务器上执行 ===

# 1. 创建目录
sudo mkdir -p /opt/medmemory-sync
sudo mkdir -p /var/www/medmemory-sync
sudo chown -R www-data:www-data /var/www/medmemory-sync

# 2. 复制代码 (假设已 rsync)
cd /opt/medmemory-sync
npm install --production

# 3. 生成 token
TOKEN=$(openssl rand -hex 32)
echo "Sync Token: $TOKEN"
echo "请保存此 token, 客户端配置需要填入"

# 4. 安装 systemd service
sudo cp deploy/medmemory-sync.service /etc/systemd/system/
sudo sed -i "s|<token>|$TOKEN|g" /etc/systemd/system/medmemory-sync.service
sudo systemctl daemon-reload
sudo systemctl enable medmemory-sync
sudo systemctl start medmemory-sync

# 5. 验证
curl -H "X-Sync-Token: $TOKEN" https://maohedong.top/api/sync/state

# 6. Nginx 配置 (参考 deploy/sync-nginx.conf.example)
#    添加 /api/ location block + reload nginx
```

---

## 附录 B: 客户端 localStorage Key 总览

| Key | 内容 | 示例 |
|-----|------|------|
| `medmemory:sync:serverUrl` | 服务器地址 | `https://maohedong.top` |
| `medmemory:sync:token` | 共享密钥 | `a1b2c3d4...` |
| `medmemory:sync:clientId` | 设备 UUID | `550e8400-e29b-41d4-a716-446655440000` |
| `medmemory:sync:clientLabel` | 设备标签 | `爸爸的手机` |

命名规则: `medmemory:sync:{field}` — 与现有 `medmemory:ai:{ns}:{field}` 保持一致的命名空间风格。

---

## 附录 C: API 端点速查卡

```
GET    /api/sync/state        — 查询状态 (轻量, 高频)
GET    /api/sync/snapshot     — 下载快照 (需 auth)
POST   /api/sync/checkout     — 获锁 + 拉数据 (返回 zip)
POST   /api/sync/checkin      — 推数据 + 释放锁 (multipart)
POST   /api/sync/heartbeat    — 续锁
DELETE /api/sync/lock         — 强制释放锁 (紧急)
POST   /api/sync/seed         — 首次初始化 (无锁上传)
```

---

## 附录 D: 关键时间常量

| 常量 | 值 | 出现位置 |
|------|-----|---------|
| LOCK_TTL | 30 分钟 | 服务端 + 客户端 heartbeat 逻辑 |
| HEARTBEAT_INTERVAL | 10 分钟 | 客户端 setInterval |
| HEARTBEAT_EARLY_THRESHOLD | 5 分钟 (距过期) | 客户端提前续期判断 |
| POLL_INTERVAL_READONLY | 30 秒 | 客户端只读模式轮询 |
| CHECKIN_RETRY_COUNT | 3 次 | 客户端网络重试 |
| CHECKIN_RETRY_BACKOFF | 1s, 2s, 4s | 指数退避 |
| RATE_LIMIT_CHECKOUT | 10/min/clientId | 服务端速率限制 |
| RATE_LIMIT_STATE | 60/min/IP | 服务端速率限制 |
| MAX_UPLOAD_SIZE | 500 MB | 服务端 multipart 限制 |
