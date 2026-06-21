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

/** promiser 函数的调用签名 */
interface PromiserFn {
  (type: 'open', args: { filename: string }): Promise<{
    type: 'open';
    result: OpenResult;
    dbId: string;
  }>;
  (type: 'exec', args: ExecArgs | string): Promise<ExecResponse>;
  (type: 'close', args?: { unlink?: boolean }): Promise<{
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
// 公开 API：getDb（单例）
// ============================================================

/**
 * 对外暴露的连接句柄。
 * Repository 实现层将通过此对象执行 SQL。
 */
export interface DbHandle {
  /** promiser 函数，用于 exec / close 等 Worker1 命令 */
  exec: (sql: string, args?: Omit<ExecArgs, 'sql'>) => Promise<ExecResponse>;
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
  };
}

// ============================================================
// 公开 API：关闭（测试/清理用）
// ============================================================

/**
 * 关闭当前数据库连接并重置单例状态。
 * PoC 和测试场景用；生产代码一般不调用。
 */
export async function closeDb(): Promise<void> {
  if (promiserInstance === null || activeDbId === null) {
    return;
  }

  try {
    await promiserInstance('close');
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
