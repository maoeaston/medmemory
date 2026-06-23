// ============================================================
// MedMemory Sync Server
// ============================================================
// 接力棒式 checkout/checkin 锁模型。
// 单进程 Node.js + Express, 进程内 Mutex 串行化所有写操作。
//
// 端点:
//   GET    /api/sync/state        — 查询状态 (轻量, 高频)
//   GET    /api/sync/snapshot     — 下载快照 (需 auth)
//   POST   /api/sync/checkout     — 获锁 + 拉数据 (返回 zip)
//   POST   /api/sync/checkin      — 推数据 + 释放锁 (multipart)
//   POST   /api/sync/heartbeat    — 续锁
//   DELETE /api/sync/lock         — 强制释放锁 (紧急)
//   POST   /api/sync/seed         — 首次初始化 (无锁上传)
//
// 持久化:
//   DATA_DIR/lock.json       — 锁状态
//   DATA_DIR/snapshot.zip    — 最新快照
//   DATA_DIR/version.txt     — 单行整数版本号
//
// checkin 写入顺序 (评审 S1):
//   先写 version.txt (tmp → rename 原子)
//   后写 snapshot.zip (tmp → rename 原子)
// ============================================================

import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============================================================
// 配置
// ============================================================

const PORT = parseInt(process.env.PORT || '3001', 10);
const DATA_DIR = process.env.DATA_DIR || '/var/www/medmemory-sync';
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';

// LOCK_TTL_MS 可通过 SYNC_LOCK_TTL_MS 环境变量覆盖 (测试用短 TTL),
// 生产默认 30 分钟。最小 10 秒, 防止误配成 0。
const LOCK_TTL_MS = (() => {
  const env = parseInt(process.env.SYNC_LOCK_TTL_MS || '', 10);
  if (Number.isFinite(env) && env >= 10_000) return env;
  return 30 * 60 * 1000; // 30 分钟
})();
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;    // 500 MB

// 速率限制
const RATE_LIMITS = {
  checkout:      { max: 10, windowMs: 60_000 },  // per clientId
  checkin:       { max: 10, windowMs: 60_000 },  // per clientId
  heartbeat:     { max: 20, windowMs: 60_000 },  // per clientId
  state:         { max: 60, windowMs: 60_000 },  // per IP
  lock:          { max: 3,  windowMs: 60_000 },  // per clientId
  snapshot:      { max: 5,  windowMs: 60_000 },  // per clientId
  seed:          { max: 3,  windowMs: 60_000 },  // per clientId
};

// ============================================================
// 文件路径
// ============================================================

const LOCK_FILE     = path.join(DATA_DIR, 'lock.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.zip');
const VERSION_FILE  = path.join(DATA_DIR, 'version.txt');

// 临时文件 (checkin/seed 写入时先写 tmp, 再 rename)
const SNAPSHOT_TMP  = path.join(DATA_DIR, 'snapshot.zip.tmp');
const VERSION_TMP   = path.join(DATA_DIR, 'version.txt.tmp');

// ============================================================
// Mutex — 进程内 Promise 队列, 串行化所有写操作
// ============================================================

class Mutex {
  constructor() {
    /** @type {Promise<void>} */
    this._tail = Promise.resolve();
  }

  /**
   * 串行执行 fn, 所有调用排队。
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    const prev = this._tail;
    let release;
    this._tail = new Promise((resolve) => { release = resolve; });

    await prev.catch(() => {}); // 前一个即使失败也不阻塞
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const mutex = new Mutex();

// ============================================================
// 持久化: lock.json / version.txt
// ============================================================

/**
 * @typedef {{ clientId: string, clientLabel: string }} LockHolder
 * @typedef {{
 *   lockHolder: LockHolder | null,
 *   acquiredAt: string | null,
 *   expiresAt: string | null,
 *   version: number
 * }} LockState
 */

/** @type {LockState} */
let lockState = {
  lockHolder: null,
  acquiredAt: null,
  expiresAt: null,
  version: 0,
};

// version.txt 是权威来源, lockState.version 是内存副本 (方便 state 端点一次读取)

/**
 * 原子写入: 先写 tmp, 再 rename。
 * @param {string} filePath
 * @param {string} tmpPath
 * @param {Buffer | string} data
 */
async function atomicWrite(filePath, tmpPath, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  await fs.promises.writeFile(tmpPath, buf);
  await fs.promises.rename(tmpPath, filePath);
}

/**
 * 从磁盘恢复 lock.json + version.txt。
 * 在服务器启动时调用。
 */
async function loadPersistentState() {
  // 确保 DATA_DIR 存在
  await fs.promises.mkdir(DATA_DIR, { recursive: true });

  // version.txt
  try {
    const raw = (await fs.promises.readFile(VERSION_FILE, 'utf8')).trim();
    const v = parseInt(raw, 10);
    if (Number.isFinite(v) && v >= 0) {
      lockState.version = v;
    }
  } catch {
    // version.txt 不存在, version=0
  }

  // lock.json
  try {
    const raw = await fs.promises.readFile(LOCK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      lockState.lockHolder  = parsed.lockHolder  ?? null;
      lockState.acquiredAt  = parsed.acquiredAt  ?? null;
      lockState.expiresAt   = parsed.expiresAt   ?? null;
      // lock.json 里的 version 是冗余副本, 以 version.txt 为准
      lockState.version     = lockState.version || parsed.version || 0;
    }
  } catch {
    // lock.json 不存在, 使用默认空状态
  }

  // 惰性检查: 如果锁已过期, 标记为 UNLOCKED
  expireLockIfStale();

  await persistLock();
}

/**
 * 将 lockState 写入 lock.json。
 */
async function persistLock() {
  await atomicWrite(LOCK_FILE, LOCK_FILE + '.tmp', JSON.stringify(lockState, null, 2));
}

/**
 * 将 version 写入 version.txt (原子)。
 * 同时更新 lockState.version。
 */
async function persistVersion(newVersion) {
  await atomicWrite(VERSION_FILE, VERSION_TMP, String(newVersion) + '\n');
  lockState.version = newVersion;
}

// ============================================================
// 锁操作 (均在 mutex.run 内调用)
// ============================================================

/**
 * 惰性过期检查: 如果锁已过期, 释放它。
 * @returns {boolean} true 如果锁被惰性释放了
 */
function expireLockIfStale() {
  if (lockState.lockHolder && lockState.expiresAt) {
    const expiresAtMs = Date.parse(lockState.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
      // 过期了
      lockState.lockHolder = null;
      lockState.acquiredAt = null;
      lockState.expiresAt  = null;
      return true;
    }
  }
  return false;
}

/**
 * @returns {{ hasSnapshot: boolean, snapshotSize: number }}
 */
function getSnapshotInfo() {
  try {
    const stat = fs.statSync(SNAPSHOT_FILE);
    return { hasSnapshot: true, snapshotSize: stat.size };
  } catch {
    return { hasSnapshot: false, snapshotSize: 0 };
  }
}

// ============================================================
// 速率限制 (进程内 Map)
// ============================================================

/**
 * @type {Map<string, { count: number, resetAt: number }>}
 */
const rateLimitMap = new Map();

/**
 * @param {string} key  — clientId 或 IP
 * @param {number} max
 * @param {number} windowMs
 * @returns {boolean} true = 允许, false = 超限
 */
function rateLimitCheck(key, max, windowMs) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) {
    return false;
  }
  entry.count++;
  return true;
}

// 定期清理过期条目 (每 5 分钟)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (entry.resetAt < now) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

// ============================================================
// 中间件
// ============================================================

/**
 * CORP header — 给所有响应加 Cross-Origin-Resource-Policy: same-origin。
 * COEP require-corp 页面下, 确保 API 响应不被浏览器拦截。
 */
function corpHeaderMiddleware(_req, res, next) {
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

/**
 * 认证: 校验 X-Sync-Token (timingSafeEqual 防 timing attack)。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authMiddleware(req, res, next) {
  if (!SYNC_TOKEN) {
    return res.status(500).json({
      error: { code: 'INTERNAL', message: 'SYNC_TOKEN 环境变量未设置' },
    });
  }
  const received = req.headers['x-sync-token'];
  if (!received || typeof received !== 'string') {
    return res.status(401).json({
      error: { code: 'AUTH_REQUIRED', message: '缺少 X-Sync-Token 头' },
    });
  }
  const a = Buffer.from(received);
  const b = Buffer.from(SYNC_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      error: { code: 'AUTH_INVALID', message: 'token 不匹配' },
    });
  }
  next();
}

/**
 * 可选认证: state 端点用。token 正确时通过, 不正确时返回 401,
 * 但不强制要求 token (没有 token 也允许, 只看元数据)。
 */
function optionalAuthMiddleware(req, res, next) {
  const received = req.headers['x-sync-token'];
  if (!received) {
    // 没 token 也允许, 只是看元数据
    return next();
  }
  if (!SYNC_TOKEN || typeof received !== 'string') {
    return next(); // 让后续逻辑处理
  }
  const a = Buffer.from(received);
  const b = Buffer.from(SYNC_TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return next();
  }
  // token 提供了但不匹配
  return res.status(401).json({
    error: { code: 'AUTH_INVALID', message: 'token 不匹配' },
  });
}

/**
 * 速率限制中间件工厂。
 * @param {'checkout'|'checkin'|'heartbeat'|'state'|'lock'|'snapshot'|'seed'} endpoint
 */
function rateLimitMiddleware(endpoint) {
  const cfg = RATE_LIMITS[endpoint];
  return (req, res, next) => {
    // state 用 IP, 其余用 clientId (body 或 query)
    let key;
    if (endpoint === 'state') {
      key = req.ip || req.socket.remoteAddress || 'unknown';
    } else {
      // 从 body 或 query 取 clientId; multer 可能还没解析, 从 req.body 试
      key = (req.body?.clientId) || req.query?.clientId || req.ip || 'unknown';
    }
    const rateKey = `${endpoint}:${key}`;
    if (!rateLimitCheck(rateKey, cfg.max, cfg.windowMs)) {
      const retryAfter = Math.ceil(cfg.windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: `超出速率限制 (${cfg.max}/${cfg.windowMs / 1000}s)` },
      });
    }
    next();
  };
}

// ============================================================
// multer 配置 — checkin/seed 上传 zip
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(), // 先全量读入内存, 校验后再写 tmp→rename
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    // multipart 总大小略大于 zip (加上 version + clientId 字段)
    fields: 5,
    fieldSize: 1024,
  },
});

// ============================================================
// 错误响应 helper
// ============================================================

function errorResponse(code, message, status, details) {
  const body = { error: { code, message } };
  if (details) body.error.details = details;
  return { status, body };
}

// ============================================================
// Express App
// ============================================================

const app = express();

// 解析 JSON body (checkout/heartbeat/lock 端点)
app.use(express.json({ limit: '1mb' }));

// 全局 CORP header
app.use(corpHeaderMiddleware);

// -------------------------------------------------------
// GET /api/sync/state
// -------------------------------------------------------
app.get('/api/sync/state', optionalAuthMiddleware, rateLimitMiddleware('state'), async (req, res) => {
  // 惰性过期检查: 如果锁已过期, 释放它并持久化
  await mutex.run(async () => {
    const expired = expireLockIfStale();
    if (expired) await persistLock();
  });

  const { hasSnapshot, snapshotSize } = getSnapshotInfo();

  res.json({
    lockedBy: lockState.lockHolder,
    lockedAt: lockState.acquiredAt,
    version: lockState.version,
    expiresAt: lockState.expiresAt,
    hasSnapshot,
    snapshotSize,
    serverTime: new Date().toISOString(),
  });
});

// -------------------------------------------------------
// GET /api/sync/snapshot
// -------------------------------------------------------
app.get('/api/sync/snapshot', authMiddleware, rateLimitMiddleware('snapshot'), async (req, res) => {
  const { hasSnapshot, snapshotSize } = getSnapshotInfo();
  if (!hasSnapshot) {
    return res.status(404).json(
      errorResponse('NO_SNAPSHOT', '服务器还没有快照', 404).body,
    );
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(snapshotSize));
  res.setHeader('Content-Disposition', `attachment; filename="medmemory-snapshot-v${lockState.version}.zip"`);

  // 流式传输, 不全量读入内存
  const stream = fs.createReadStream(SNAPSHOT_FILE);
  stream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json(
        errorResponse('INTERNAL', '读取快照失败', 500).body,
      );
    }
  });
  stream.pipe(res);
});

// -------------------------------------------------------
// POST /api/sync/checkout
// -------------------------------------------------------
app.post('/api/sync/checkout', authMiddleware, rateLimitMiddleware('checkout'), async (req, res) => {
  const { clientId, clientLabel } = req.body || {};

  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json(
      errorResponse('BAD_REQUEST', '缺少 clientId', 400).body,
    );
  }

  const result = await mutex.run(async () => {
    // 惰性过期检查
    expireLockIfStale();

    // 锁已被别人持有?
    if (lockState.lockHolder && lockState.lockHolder.clientId !== clientId) {
      return errorResponse(
        'LOCK_HELD_BY_OTHER',
        '锁已被其他客户端持有',
        409,
        {
          lockedBy: lockState.lockHolder,
          expiresAt: lockState.expiresAt,
        },
      );
    }

    // 检查 snapshot 是否存在
    const { hasSnapshot } = getSnapshotInfo();
    if (!hasSnapshot) {
      return errorResponse(
        'NO_SNAPSHOT',
        '服务器还没有快照, 请用 seed 端点首次上传',
        404,
      );
    }

    // 获锁
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    lockState.lockHolder  = { clientId, clientLabel: clientLabel || '未命名设备' };
    lockState.acquiredAt  = now.toISOString();
    lockState.expiresAt   = expiresAt.toISOString();

    await persistLock();

    return { ok: true, expiresAt: expiresAt.toISOString() };
  });

  if ('ok' in result && result.ok) {
    // 返回 zip binary + headers
    const { snapshotSize } = getSnapshotInfo();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(snapshotSize));
    res.setHeader('X-Sync-Version', String(lockState.version));
    res.setHeader('X-Sync-Lock-Expires-At', result.expiresAt);

    const stream = fs.createReadStream(SNAPSHOT_FILE);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json(
          errorResponse('INTERNAL', '读取快照失败', 500).body,
        );
      }
    });
    stream.pipe(res);
  } else {
    res.status(result.status).json(result.body);
  }
});

// -------------------------------------------------------
// POST /api/sync/checkin
// -------------------------------------------------------
//
// ★★★ 评审 S1 修正: 写入顺序为 先 version.txt, 后 snapshot.zip ★★★
//
// 理由 (摘自 sync-design-review.md S1):
//   如果崩溃在两步之间:
//   - 先 version 后 snapshot → version.txt 已更新但 snapshot.zip 没更新
//     → 下一个 checkout 拿到新 version 但旧 snapshot。version 校验仍然一致
//       (新 checkout 基于 version.txt 的值, snapshot 是旧的但 version 匹配),
//       不影响正确性。后续 checkin 会用新 version 校验, 逻辑正确。
//   - 反过来 (先 snapshot 后 version): snapshot 新但 version 旧
//     → version 校验逻辑混乱。
//
app.post(
  '/api/sync/checkin',
  authMiddleware,
  rateLimitMiddleware('checkin'),
  upload.fields([
    { name: 'snapshot', maxCount: 1 },
    { name: 'version', maxCount: 1 },
    { name: 'clientId', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = /** @type {any} */ (req).files;
    const versionStr = req.body?.version;
    const clientId   = req.body?.clientId;
    const snapshotFile = files?.snapshot?.[0];

    // 基本校验
    if (!versionStr || !clientId || !snapshotFile) {
      return res.status(400).json(
        errorResponse('BAD_REQUEST', '缺少必要字段 (version, clientId, snapshot)', 400).body,
      );
    }

    const expectedVersion = parseInt(versionStr, 10);
    if (!Number.isFinite(expectedVersion)) {
      return res.status(400).json(
        errorResponse('BAD_REQUEST', 'version 不是有效整数', 400).body,
      );
    }

    const zipBuffer = snapshotFile.buffer;

    const result = await mutex.run(async () => {
      // 惰性过期检查
      expireLockIfStale();

      // 校验锁: clientId 必须是当前持锁者
      if (!lockState.lockHolder) {
        return errorResponse(
          'LOCK_EXPIRED',
          '锁已过期或未持有, 需重新 checkout',
          409,
        );
      }
      if (lockState.lockHolder.clientId !== clientId) {
        return errorResponse(
          'NOT_LOCK_HOLDER',
          'clientId 不匹配当前锁持有者',
          403,
          { lockedBy: lockState.lockHolder },
        );
      }

      // 校验 version (乐观锁)
      if (lockState.version !== expectedVersion) {
        return errorResponse(
          'VERSION_CONFLICT',
          `version 不匹配 (期望 ${lockState.version}, 收到 ${expectedVersion})`,
          409,
          { currentVersion: lockState.version, sentVersion: expectedVersion },
        );
      }

      // ---- 写入阶段 ----
      //
      // ★ 评审 S1 正确顺序: 先 version.txt, 后 snapshot.zip ★
      //
      const newVersion = lockState.version + 1;

      // 步骤 1: 先写 version.txt (tmp → rename 原子)
      try {
        await persistVersion(newVersion);
      } catch (err) {
        // version.txt 写入失败 → 旧 version + 旧 snapshot 都不受影响
        return errorResponse(
          'STORAGE_ERROR',
          `写入 version.txt 失败: ${err.message}`,
          503,
        );
      }

      // 步骤 2: 后写 snapshot.zip (tmp → rename 原子)
      try {
        await atomicWrite(SNAPSHOT_FILE, SNAPSHOT_TMP, zipBuffer);
      } catch (err) {
        // snapshot.zip 写入失败 → version.txt 已更新但 snapshot 是旧的
        // 这是可接受的: checkout 拿到新 version + 旧 snapshot, 不影响正确性
        // (评审 S1 分析: version 校验以 version.txt 为准, snapshot 稍旧可接受)
        // 客户端可重试 checkin 覆盖旧 snapshot
        return errorResponse(
          'STORAGE_ERROR',
          `写入 snapshot.zip 失败: ${err.message}`,
          503,
        );
      }

      // 步骤 3: 释放锁
      lockState.lockHolder = null;
      lockState.acquiredAt = null;
      lockState.expiresAt  = null;
      await persistLock();

      return {
        ok: true,
        version: newVersion,
        snapshotSize: zipBuffer.length,
        receivedAt: new Date().toISOString(),
      };
    });

    if ('ok' in result && result.ok) {
      res.json({
        version: result.version,
        receivedAt: result.receivedAt,
        snapshotSize: result.snapshotSize,
      });
    } else {
      res.status(result.status).json(result.body);
    }
  },
);

// -------------------------------------------------------
// POST /api/sync/heartbeat
// -------------------------------------------------------
app.post('/api/sync/heartbeat', authMiddleware, rateLimitMiddleware('heartbeat'), async (req, res) => {
  const { clientId } = req.body || {};

  if (!clientId || typeof clientId !== 'string') {
    return res.status(400).json(
      errorResponse('BAD_REQUEST', '缺少 clientId', 400).body,
    );
  }

  const result = await mutex.run(async () => {
    expireLockIfStale();

    if (!lockState.lockHolder) {
      return errorResponse(
        'LOCK_EXPIRED',
        '锁已过期, 需重新 checkout',
        409,
      );
    }
    if (lockState.lockHolder.clientId !== clientId) {
      return errorResponse(
        'NOT_LOCK_HOLDER',
        'clientId 不匹配当前锁持有者',
        403,
      );
    }

    // 续期: +30 分钟
    const newExpiresAt = new Date(Date.now() + LOCK_TTL_MS);
    lockState.expiresAt = newExpiresAt.toISOString();
    await persistLock();

    return { ok: true, expiresAt: newExpiresAt.toISOString() };
  });

  if ('ok' in result && result.ok) {
    res.json({
      expiresAt: result.expiresAt,
      version: lockState.version,
    });
  } else {
    res.status(result.status).json(result.body);
  }
});

// -------------------------------------------------------
// DELETE /api/sync/lock
// -------------------------------------------------------
app.delete('/api/sync/lock', authMiddleware, rateLimitMiddleware('lock'), async (req, res) => {
  const { clientId, force } = req.body || {};

  const result = await mutex.run(async () => {
    expireLockIfStale();

    const previousHolder = lockState.lockHolder;

    if (!force) {
      // 非强制: clientId 必须匹配
      if (!lockState.lockHolder) {
        return errorResponse(
          'LOCK_EXPIRED',
          '锁已过期或无人持有',
          409,
        );
      }
      if (lockState.lockHolder.clientId !== clientId) {
        return errorResponse(
          'NOT_LOCK_HOLDER',
          'clientId 不匹配, 使用 force=true 强制释放',
          403,
        );
      }
    }

    lockState.lockHolder = null;
    lockState.acquiredAt = null;
    lockState.expiresAt  = null;
    await persistLock();

    return { ok: true, previousHolder };
  });

  if ('ok' in result && result.ok) {
    res.json({
      releasedAt: new Date().toISOString(),
      previousHolder: result.previousHolder,
    });
  } else {
    res.status(result.status).json(result.body);
  }
});

// -------------------------------------------------------
// POST /api/sync/seed — 首次初始化 (无锁上传)
// -------------------------------------------------------
app.post(
  '/api/sync/seed',
  authMiddleware,
  rateLimitMiddleware('seed'),
  upload.fields([
    { name: 'snapshot', maxCount: 1 },
    { name: 'clientId', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = /** @type {any} */ (req).files;
    const clientId   = req.body?.clientId;
    const snapshotFile = files?.snapshot?.[0];

    if (!clientId || !snapshotFile) {
      return res.status(400).json(
        errorResponse('BAD_REQUEST', '缺少必要字段 (clientId, snapshot)', 400).body,
      );
    }

    const zipBuffer = snapshotFile.buffer;

    const result = await mutex.run(async () => {
      // 如果已有快照且 version > 0, 拒绝 seed
      const { hasSnapshot } = getSnapshotInfo();
      if (hasSnapshot && lockState.version > 0) {
        return errorResponse(
          'VERSION_CONFLICT',
          '服务器已有数据, 请用 checkout/checkin',
          409,
          { currentVersion: lockState.version },
        );
      }

      // ---- 写入阶段 (与 checkin 相同: 先 version 后 snapshot) ----
      const newVersion = 1;

      try {
        await persistVersion(newVersion);
      } catch (err) {
        return errorResponse(
          'STORAGE_ERROR',
          `写入 version.txt 失败: ${err.message}`,
          503,
        );
      }

      try {
        await atomicWrite(SNAPSHOT_FILE, SNAPSHOT_TMP, zipBuffer);
      } catch (err) {
        return errorResponse(
          'STORAGE_ERROR',
          `写入 snapshot.zip 失败: ${err.message}`,
          503,
        );
      }

      // seed 不涉及锁
      await persistLock();

      return { ok: true, version: newVersion, snapshotSize: zipBuffer.length };
    });

    if ('ok' in result && result.ok) {
      res.json({
        version: result.version,
        snapshotSize: result.snapshotSize,
        receivedAt: new Date().toISOString(),
      });
    } else {
      res.status(result.status).json(result.body);
    }
  },
);

// -------------------------------------------------------
// 全局错误处理
// -------------------------------------------------------

// multer 文件大小超限
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json(
        errorResponse('PAYLOAD_TOO_LARGE', `文件超过限制 (${MAX_UPLOAD_SIZE} bytes)`, 413).body,
      );
    }
    return res.status(400).json(
      errorResponse('BAD_REQUEST', `上传错误: ${err.message}`, 400).body,
    );
  }
  if (err) {
    return res.status(500).json(
      errorResponse('INTERNAL', err.message || '服务器内部错误', 500).body,
    );
  }
  next();
});

// 404
app.use((req, res) => {
  res.status(404).json(
    errorResponse('NOT_FOUND', `路径不存在: ${req.method} ${req.path}`, 404).body,
  );
});

// ============================================================
// 启动
// ============================================================

async function main() {
  if (!SYNC_TOKEN) {
    console.error('[FATAL] SYNC_TOKEN 环境变量未设置。');
    console.error('  生成: openssl rand -hex 32');
    console.error('  设置: SYNC_TOKEN=<token> node sync-server.js');
    process.exit(1);
  }

  await loadPersistentState();

  app.listen(PORT, () => {
    console.log(`[MedMemory Sync Server] listening on http://127.0.0.1:${PORT}`);
    console.log(`  DATA_DIR:    ${DATA_DIR}`);
    console.log(`  version:     ${lockState.version}`);
    console.log(`  lockHolder:  ${lockState.lockHolder?.clientLabel || '(空)'}`);
    const { hasSnapshot } = getSnapshotInfo();
    console.log(`  hasSnapshot: ${hasSnapshot}`);
  });
}

main().catch((err) => {
  console.error('[FATAL] 启动失败:', err);
  process.exit(1);
});
