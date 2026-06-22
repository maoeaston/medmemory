// ============================================================
// MedMemory — sqlite-wasm 加载层与连接管理
// ============================================================
// 分层位置: 基础设施层（infra），独立于 Storage Adapter / Repository
// 对应 ADR: ADR-001（sqlite-wasm + OPFS 持久化）
//
// 加载方式: sqlite3Worker1Promiser v2（ESM import，返回 Promise<function>）
//   - Worker1/Promiser API 自 2026-04 起标记 deprecated，但官方承诺不移除
//   - 对于 PoC 阶段足够；后续 Repository 如需更强表达力可迁移到 oo1 API
//   - v2 接口从 ESM import 出来后返回 Promise，resolve 后才拿到 promiser function
//
// OPFS 策略:
//   - 首选: file:medmemory.sqlite3?vfs=opfs（跨源隔离环境下持久化）
//   - 降级: :memory:（非隔离环境下跑非持久版本，console.warn 提示）
//
// 约定（schema 顶部）:
//   每次连接执行 PRAGMA foreign_keys = ON;
// ============================================================

import { sqlite3Worker1Promiser } from '@sqlite.org/sqlite-wasm';

// schema 文件用 Vite ?raw 后缀以字符串形式 import（编译期内联，无运行时 fetch）
// @/../ 跳出 src 是因为 migrations 在项目根 db/ 下，不属于 src 树；路径别名 @ 只映射 src/
import schemaSql from '@/../db/migrations/001_initial.sql?raw';

// ============================================================
// 类型定义
// ============================================================
// @sqlite.org/sqlite-wasm 的 Worker1Promiser 类型导出不完整（见 issue #53/#155）
// 这里用最小化 interface 描述 PoC 实际用到的能力，不写 any

/** promiser('open', ...) 返回的 result 部分 */
interface OpenResult {
  filename: string;
  dbId: string;
  persistent: boolean;
  vfs: string;
}

/** promiser('exec', ...) 的 args 选项（简版） */
interface ExecArgs {
  sql: string;
  /** 绑定参数，按 ? 位置或 $name 命名 */
  bind?: unknown[];
  /** 行模式: 'array' | 'object' | 'stmt' | bigint 变体；PoC 用 'object' */
  rowMode?: 'array' | 'object';
  /** exec 会把结果行推入此数组（若提供） */
  resultRows?: Record<string, unknown>[];
  /** exec 会把列名推入此数组（若提供） */
  columnNames?: string[];
  /** 若 truthy，result.changeCount 记录变更行数 */
  countChanges?: boolean | number;
}

/** promiser('exec', ...) 返回的完整 response */
interface ExecResponse {
  type: 'exec';
  result: ExecArgs & {
    changeCount?: number;
  };
  dbId: string;
}

/** promiser('export', ...) 返回的 result 部分 */
interface ExportResult {
  /** 整个数据库文件的字节序列 */
  byteArray: Uint8Array;
  filename: string;
  mimetype: 'application/x-sqlite3';
}

/** promiser('export', ...) 返回的完整 response */
interface ExportResponse {
  type: 'export';
  result: ExportResult;
  dbId: string;
}

/** promiser('close', ...) 的 args（支持 unlink 删除 OPFS 文件） */
interface CloseArgs {
  /** 若 truthy, 关闭后从 OPFS 删除数据库文件 */
  unlink?: boolean;
}

/** promiser 函数的调用签名 */
interface PromiserFn {
  (type: 'open', args: { filename: string }): Promise<{
    type: 'open';
    result: OpenResult;
    dbId: string;
  }>;
  (type: 'exec', args: ExecArgs | string): Promise<ExecResponse>;
  (type: 'export', args?: Record<string, never>): Promise<ExportResponse>;
  (type: 'close', args?: CloseArgs): Promise<{
    type: 'close';
    result: { filename?: string };
  }>;
  (type: 'config-get'): Promise<{
    type: 'config-get';
    result: {
      version: { libVersion: string };
      bigIntEnabled: boolean;
      vfsList: { name: string }[];
    };
  }>;
}

// ============================================================
// 结构化错误
// ============================================================

export class SqliteConnectionError extends Error {
  readonly phase: string;
  readonly causeDetail: unknown;

  constructor(phase: string, message: string, cause?: unknown) {
    super(`[SqliteConnection/${phase}] ${message}`);
    this.name = 'SqliteConnectionError';
    this.phase = phase;
    this.causeDetail = cause;
  }
}

// ============================================================
// 单例状态
// ============================================================

/** 已初始化的 promiser 函数（v2 resolve 后获得） */
let promiserInstance: PromiserFn | null = null;

/** 打开的数据库 ID（open 返回，后续 exec 需要） */
let activeDbId: string | null = null;

/** 当前是否走 OPFS 持久化（false = 降级到 :memory:） */
let usingOpfs = false;

/** 初始化进行中的 Promise（防止并发重复初始化） */
let initPromise: Promise<PromiserFn> | null = null;

// ============================================================
// 内部：初始化 promiser（v2 ESM 模式）
// ============================================================

/**
 * 初始化 sqlite3Worker1Promiser v2。
 *
 * 关键: npm 包 ESM 导出的 sqlite3Worker1Promiser 实际就是 v2 工厂函数本体,
 * 不是 v1 factory + .v2 属性. 见 @sqlite.org/sqlite-wasm/dist/index.mjs:
 *   `var sqlite3_worker1_promiser_default = sqlite3Worker1Promiser.v2;`
 *   `export { ..., sqlite3_worker1_promiser_default as sqlite3Worker1Promiser };`
 *
 * 但 .d.mts 类型声明仍按 v1 factory 标注（带 .v2 重载）, 与运行时不符——
 * 这是 npm 包的 type bug, 用 as unknown as 断言到真实签名.
 */
async function initPromiser(): Promise<PromiserFn> {
  if (promiserInstance !== null) {
    return promiserInstance;
  }

  try {
    // 直接 await 工厂调用, 返回 Promise<PromiserFn>, 无需 .v2() 属性访问
    const v2Factory =
      sqlite3Worker1Promiser as unknown as (config?: unknown) => Promise<PromiserFn>;
    promiserInstance = await v2Factory();
    return promiserInstance;
  } catch (err) {
    throw new SqliteConnectionError(
      'init-worker',
      'sqlite3Worker1Promiser v2 初始化失败（worker 启动或 wasm 加载异常）',
      err,
    );
  }
}

// ============================================================
// 内部：打开数据库（OPFS 优先，降级 :memory:）
// ============================================================

async function openDatabase(promiser: PromiserFn): Promise<string> {
  // OPFS 需要跨源隔离（COOP/COEP 头）+ 浏览器支持
  // 尝试 OPFS，失败则降级
  try {
    const openResp = await promiser('open', {
      filename: 'file:medmemory.sqlite3?vfs=opfs',
    });

    if (openResp.result.vfs === 'opfs') {
      usingOpfs = true;
      return openResp.result.dbId;
    }

    // 如果返回的 vfs 不是 opfs（某些环境静默回退），也视为非持久
    usingOpfs = false;
    console.warn(
      '[MedMemory/db] OPFS open 返回非 opfs VFS，持久化未生效。',
      `实际 VFS: ${openResp.result.vfs}`,
    );
    return openResp.result.dbId;
  } catch {
    // OPFS 不可用（cross-origin isolation 缺失 / 浏览器不支持）
    console.warn(
      '[MedMemory/db] OPFS 不可用，降级到 :memory:（数据不持久）。',
      '排查: 检查 vite.config.ts 的 COOP/COEP 头是否被浏览器接收，',
      '以及浏览器是否支持 OPFS（Chrome 86+ / Edge 86+ / Firefox 111+）。',
    );

    try {
      const fallbackResp = await promiser('open', {
        filename: ':memory:',
      });
      usingOpfs = false;
      return fallbackResp.result.dbId;
    } catch (err) {
      throw new SqliteConnectionError(
        'open-fallback',
        'OPFS 和 :memory: 均打开失败，sqlite-wasm 可能未正确加载',
        err,
      );
    }
  }
}

// ============================================================
// 内部：Schema 自动 migration（首次打开数据库时执行）
// ============================================================

/**
 * 当前 schema 目标版本。新增 migration 时递增。
 * 对应 db/migrations/001_initial.sql 的 "001" + schema_migrations.version.
 */
const SCHEMA_TARGET_VERSION = 1;

/**
 * 首次打开数据库后自动跑 schema migration。
 *
 * 流程:
 *   1. 保底建 schema_migrations 表（全新库时此表不存在, 不建的话 SELECT 会抛错）
 *   2. SELECT 当前 version
 *   3. 若 version < target, exec 完整 001_initial.sql（本身幂等: 所有 CREATE TABLE/INDEX
 *      带 IF NOT EXISTS, INSERT INTO schema_migrations 用 INSERT OR IGNORE）
 *
 * 幂等性保证:
 *   - 老用户（PoC 时代 exec 过 schema）: schema_migrations.version=1, SELECT 命中, 跳过 exec
 *   - 新用户: schema_migrations 空表, currentVersion=0, 跑 schemaSql 建表 + 写 version=1
 *   - 后续新增 002+ migration: 加版本判断分支即可, 架构已就位
 *
 * @throws SqliteConnectionError phase='migration' 当 schema SQL 执行失败
 */
async function runMigrations(promiser: PromiserFn): Promise<void> {
  // Step 1: 保底建 schema_migrations（与 001_initial.sql 同结构, IF NOT EXISTS 幂等）
  // applied_at 默认值与 001_initial.sql 一致, 避免行为分裂
  try {
    await promiser('exec', {
      sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );`,
    });
  } catch (err) {
    throw new SqliteConnectionError(
      'migration',
      '保底 CREATE schema_migrations 失败（无法跟踪 migration 版本）',
      err,
    );
  }

  // Step 2: 查当前版本
  let currentVersion = 0;
  try {
    const resp = await promiser('exec', {
      sql: 'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1;',
      rowMode: 'object',
      resultRows: [],
    });
    const row = resp.result.resultRows?.[0] as { version?: number } | undefined;
    currentVersion = row?.version ?? 0;
  } catch (err) {
    throw new SqliteConnectionError(
      'migration',
      'SELECT version FROM schema_migrations 失败（schema_migrations 状态异常）',
      err,
    );
  }

  // Step 3: 缺目标版本则跑 schema
  if (currentVersion >= SCHEMA_TARGET_VERSION) {
    return;
  }

  try {
    await promiser('exec', { sql: schemaSql });
  } catch (err) {
    throw new SqliteConnectionError(
      'migration',
      `Schema migration 到 version ${SCHEMA_TARGET_VERSION} 失败（当前 version=${currentVersion}）`,
      err,
    );
  }
}

// ============================================================
// 公开 API：getDb（单例）
// ============================================================

/**
 * 对外暴露的连接句柄。
 * Repository 实现层将通过此对象执行 SQL。
 */
export interface DbHandle {
  /** promiser 函数，用于 exec / close 等 Worker1 命令 */
  exec: (sql: string, args?: Omit<ExecArgs, 'sql'>) => Promise<ExecResponse>;
  /** 导出整个数据库为 Uint8Array（Worker1 'export' 命令） */
  exportBytes: () => Promise<Uint8Array>;
  /** 当前 dbId（Worker1 内部数据库标识） */
  readonly dbId: string;
  /** 是否走 OPFS 持久化 */
  readonly isPersistent: boolean;
}

/**
 * 获取数据库连接（单例）。
 * 首次调用: 初始化 promiser → 打开 DB → PRAGMA foreign_keys=ON → 返回句柄
 * 后续调用: 直接返回已建立的连接
 *
 * @throws SqliteConnectionError 加载/打开/pragma 失败时抛出
 */
export async function getDb(): Promise<DbHandle> {
  // 已有活跃连接
  if (promiserInstance !== null && activeDbId !== null) {
    return wrapHandle(promiserInstance, activeDbId);
  }

  // 防止并发首次调用重复初始化
  if (initPromise !== null) {
    await initPromise;
    if (promiserInstance !== null && activeDbId !== null) {
      return wrapHandle(promiserInstance, activeDbId);
    }
  }

  initPromise = (async () => {
    const promiser = await initPromiser();
    const dbId = await openDatabase(promiser);

    // 每次（首次）连接执行 PRAGMA foreign_keys = ON（schema 约定第 1 条）
    // 失败时包装成 SqliteConnectionError, 保证错误类型一致
    try {
      await promiser('exec', {
        sql: 'PRAGMA foreign_keys = ON;',
      });
    } catch (err) {
      throw new SqliteConnectionError(
        'pragma-foreign-keys',
        'PRAGMA foreign_keys = ON 执行失败（CASCADE 外键将不生效）',
        err,
      );
    }

    // Schema bootstrap: 首次打开时自动跑 migration（阻塞新用户冷启动）
    // 老路径靠 window.medmemoryPoc.runPoc() 手动建表, 已废弃; 现在任何调 getDb()
    // 的路径（生产 createRepositories / dev PoC）首次调用都会自动 migrate.
    await runMigrations(promiser);

    activeDbId = dbId;
    return promiser;
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }

  if (promiserInstance === null || activeDbId === null) {
    throw new SqliteConnectionError(
      'post-init',
      '初始化后 promiser 或 dbId 仍为空（不应发生）',
    );
  }

  return wrapHandle(promiserInstance, activeDbId);
}

/** 构造 DbHandle 包装 */
function wrapHandle(promiser: PromiserFn, dbId: string): DbHandle {
  return {
    dbId,
    isPersistent: usingOpfs,
    exec: (sql: string, args?: Omit<ExecArgs, 'sql'>) => {
      const fullArgs: ExecArgs = { sql, ...args };
      return promiser('exec', fullArgs);
    },
    exportBytes: async () => {
      const resp = await promiser('export', {});
      return resp.result.byteArray;
    },
  };
}

// ============================================================
// 公开 API：关闭（测试/清理用）
// ============================================================

/**
 * 关闭当前数据库连接并重置单例状态。
 * PoC 和测试场景用；生产代码一般不调用。
 *
 * @param options.unlink 若 true, 关闭后从 OPFS 删除数据库文件（用于"重置数据库"）
 */
export async function closeDb(options?: { unlink?: boolean }): Promise<void> {
  if (promiserInstance === null || activeDbId === null) {
    return;
  }

  try {
    await promiserInstance('close', options);
  } catch (err) {
    throw new SqliteConnectionError('close', '关闭数据库失败', err);
  } finally {
    promiserInstance = null;
    activeDbId = null;
    usingOpfs = false;
  }
}

// ============================================================
// 公开 API：获取 schema SQL（PoC 建表用）
// ============================================================

/**
 * 返回 001_initial.sql 的完整内容（编译期内联）。
 * PoC 用此字符串执行建表。
 */
export function getSchemaSql(): string {
  return schemaSql;
}
