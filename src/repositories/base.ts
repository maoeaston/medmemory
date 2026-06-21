// ============================================================
// MedMemory — Repository 共享基础设施
// ============================================================
// 分层位置: Repository 实现层的公共依赖, 被 8 个表 Repository + SearchRepository 共用
//
// 内容:
//   1. RepositoryError         — 统一错误类型, 包装 SQLite 错误
//   2. selectOne/selectMany    — 类型化查询 helper（自动转换 Promiser 错误）
//   3. executeWrite            — INSERT/UPDATE/DELETE, 返回 changeCount
//   4. executeInsertReturning  — INSERT ... RETURNING, 直接拿回自增 id
//   5. readJsonArray/writeJsonArray — JSON TEXT 字段序列化（含 NULL → [] 兜底）
//   6. toBoolean/fromBoolean   — INTEGER ↔ boolean 转换（attachments.ai_generated）
//   7. buildUpdateQuery        — 动态 UPDATE 构造（白名单防注入, 可选注入 updated_at）
//   8. NOW_SQL                 — 与 schema DEFAULT 完全一致的时间戳 SQL 表达式
// ============================================================

import type { DbHandle } from '@/db/connection';

// ============================================================
// 1. 时间戳 SQL 表达式（与 schema DEFAULT 对齐）
// ============================================================

/**
 * 与 `db/migrations/001_initial.sql` 的 DEFAULT 表达式完全一致。
 * 用 SQL 而非 JS new Date().toISOString() 的原因:
 *   - sqlite-wasm 在 Worker 线程执行, JS 在主线程; 跨线程时间戳对齐用 SQL 最安全
 *   - 与 schema DEFAULT 同源, 避免格式漂移
 * 格式: YYYY-MM-DDTHH:MM:SSZ（秒精度, UTC）
 */
export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`;

// ============================================================
// 2. RepositoryError
// ============================================================

export type RepositoryPhase =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'not-found';

/**
 * Repository 层抛出的统一错误类型。
 *
 * - `phase` 区分操作阶段, 便于上层（Domain/UI）针对性处理
 * - `tableName` 标记出错的表, 加快排错
 * - `causeDetail` 保留底层 SQLite 错误对象（含 errorClass/message/stack）
 */
export class RepositoryError extends Error {
  readonly phase: RepositoryPhase;
  readonly tableName: string;
  readonly causeDetail: unknown;

  constructor(
    phase: RepositoryPhase,
    tableName: string,
    message: string,
    cause?: unknown,
  ) {
    super(`[Repository/${phase}/${tableName}] ${message}`);
    this.name = 'RepositoryError';
    this.phase = phase;
    this.tableName = tableName;
    this.causeDetail = cause;
  }
}

// ============================================================
// 3. Promiser 错误响应形状识别
// ============================================================

/**
 * Promiser ('exec', ...) 失败时 reject 的对象形状（见 sqlite3-worker1.mjs）:
 *   {
 *     type: 'error',
 *     dbId, messageId,
 *     result: {
 *       errorClass: 'SQLite3Error',
 *       message: 'SQLITE_ERROR: sqlite3 result code X: ...',
 *       operation: 'exec',
 *       stack: [...],
 *       input: { type:'exec', args, dbId, messageId }
 *     },
 *     workerReceivedTime, workerRespondTime
 *   }
 *
 * 这里用最小 interface + 类型守卫识别, 不引入 any。
 */
interface PromiserErrorResponse {
  type: 'error';
  result?: {
    errorClass?: string;
    message?: string;
    operation?: string;
  };
}

function isPromiserError(e: unknown): e is PromiserErrorResponse {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as PromiserErrorResponse).type === 'error'
  );
}

/** 从 unknown 错误中提取人类可读 message, 用于 RepositoryError 包装 */
function describeError(e: unknown): string {
  if (isPromiserError(e)) {
    const r = e.result;
    if (r?.message) return r.message;
    if (r?.errorClass) return `${r.errorClass} (no message)`;
    return 'Promiser returned error response with no message';
  }
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ============================================================
// 4. 查询 helper
// ============================================================

/**
 * 单行查询: SELECT ... LIMIT 1 场景。未命中返回 null。
 *
 * @example
 * const member = await selectOne<FamilyMemberRow>(
 *   db, 'SELECT * FROM family_members WHERE id = ?', [id]
 * );
 */
export async function selectOne<T>(
  db: DbHandle,
  sql: string,
  bind?: unknown[],
): Promise<T | null> {
  try {
    const resp = await db.exec(sql, {
      bind,
      rowMode: 'object',
      resultRows: [],
    });
    const row = resp.result.resultRows?.[0];
    return row ? (row as unknown as T) : null;
  } catch (e) {
    throw new RepositoryError(
      'read',
      '(unknown)', // selectOne 无表上下文, 调用方应优先用各 Repository 内的包装
      `Query failed: ${describeError(e)}`,
      e,
    );
  }
}

/**
 * 多行查询: SELECT 场景。空结果返回 []。
 */
export async function selectMany<T>(
  db: DbHandle,
  sql: string,
  bind?: unknown[],
): Promise<T[]> {
  try {
    const resp = await db.exec(sql, {
      bind,
      rowMode: 'object',
      resultRows: [],
    });
    const rows = resp.result.resultRows ?? [];
    return rows as unknown as T[];
  } catch (e) {
    throw new RepositoryError(
      'read',
      '(unknown)',
      `Query failed: ${describeError(e)}`,
      e,
    );
  }
}

/**
 * 写入（无 RETURNING）: 返回受影响行数。
 * 用于 UPDATE / DELETE / 无 RETURNING 的 INSERT。
 *
 * @param phase  错误时 RepositoryError.phase 的默认值（'update' 通用写入, 'delete' 删除场景）
 */
export async function executeWrite(
  db: DbHandle,
  sql: string,
  bind?: unknown[],
  phase: Exclude<RepositoryPhase, 'read' | 'not-found'> = 'update',
): Promise<number> {
  try {
    const resp = await db.exec(sql, {
      bind,
      countChanges: true,
    });
    const changes = resp.result.changeCount;
    return typeof changes === 'number' ? changes : 0;
  } catch (e) {
    throw new RepositoryError(phase, '(unknown)', `Write failed: ${describeError(e)}`, e);
  }
}

/**
 * INSERT ... RETURNING id: 拿回自增 PK。
 *
 * @example
 * const id = await executeInsertReturningId(
 *   db,
 *   'INSERT INTO family_members (name) VALUES (?) RETURNING id',
 *   [name],
 * );
 *
 * 要求 SQL 必须形如 `... RETURNING id`（sqlite-wasm 3.35+ 支持, 当前 3.53 满足）。
 * 未命中返回 null（理论上 INSERT 一定命中, 仅作兜底）。
 */
export async function executeInsertReturningId(
  db: DbHandle,
  sql: string,
  bind?: unknown[],
): Promise<number | null> {
  try {
    const resp = await db.exec(sql, {
      bind,
      rowMode: 'object',
      resultRows: [],
    });
    const row = resp.result.resultRows?.[0] as { id?: number } | undefined;
    return row?.id ?? null;
  } catch (e) {
    throw new RepositoryError(
      'create',
      '(unknown)',
      `Insert failed: ${describeError(e)}`,
      e,
    );
  }
}

// ============================================================
// 5. JSON 字段序列化（allergies / chronic_conditions / current_medications / tags）
// ============================================================

/**
 * 从 SQLite TEXT 字段（可为 NULL）读取 JSON 数组。
 *
 * - null / undefined / 空字符串 → fallback（通常传 []）
 * - JSON.parse 失败 → fallback + console.warn 出原始文本（便于发现数据损坏）
 * - 解析成非数组 → fallback + console.warn（schema 约定这些字段是数组）
 */
export function readJsonArray<T>(text: string | null | undefined, fallback: T[]): T[] {
  if (text === null || text === undefined || text === '') {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      console.warn(
        `[Repository/base] readJsonArray: parsed value is not an array, falling back. Raw:`,
        text,
      );
      return fallback;
    }
    return parsed as T[];
  } catch (e) {
    console.warn(
      `[Repository/base] readJsonArray: JSON.parse failed, falling back. Raw:`,
      text,
      `Error:`,
      e,
    );
    return fallback;
  }
}

/**
 * 将 TS 数组写入 SQLite TEXT 字段。
 *
 * - undefined → null（让 SQLite 存 NULL）
 * - 其他（含 []）→ JSON.stringify
 *
 * 读取时 null 又会被 readJsonArray 兜底为 [], 语义等价, 存储更紧凑。
 */
export function writeJsonArray<T>(value: T[] | undefined): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

// ============================================================
// 6. 布尔字段转换（attachments.ai_generated: INTEGER 0/1 ↔ boolean）
// ============================================================

/** SQLite INTEGER（0/1/null）→ boolean。null 视为 false（ai_generated DEFAULT 0）。 */
export function fromDbBoolean(value: unknown): boolean {
  return value === 1 || value === true;
}

/** boolean → SQLite INTEGER（0/1）。 */
export function toDbBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

// ============================================================
// 7. 动态 UPDATE 构造器
// ============================================================

/**
 * 构造 `UPDATE table SET col1=?, col2=?, ... WHERE ...` 语句。
 *
 * 特性:
 *   1. **白名单防护**: 只接受 allowedFields 内的字段名; 非白名单 key 静默丢弃 + warn
 *      防止 input 里混入未知字段造成 SQL 注入（字段名无法用 ? 参数化）
 *   2. **updated_at 注入**: 对 family_members / medical_events / health_problems / medicines
 *      强制拼入 `updated_at = <NOW_SQL>`; inbox_items / attachments / ai_contents 无此字段,
 *      `withUpdatedAt: false`（默认 true）
 *   3. **空 input 处理**: 如果过滤后没有任何字段, 抛错（UPDATE 必须有 SET 目标）
 *
 * @param table          表名（由调用方硬编码, 不来自用户输入）
 * @param allowedFields  允许更新的字段白名单（常量数组, 编译期固定）
 * @param input          用户传入的 Patch 对象
 * @param whereClause    WHERE 子句, 如 "id = ?"（字段名硬编码, 值走 bind）
 * @param withUpdatedAt  是否自动注入 updated_at（默认 true）
 *
 * @returns `{ sql, bind }` — bind 已按字段顺序 + WHERE 值排好
 */
export interface BuildUpdateOptions {
  table: string;
  allowedFields: readonly string[];
  input: Record<string, unknown>;
  whereClause: string;
  whereBind: unknown[];
  withUpdatedAt?: boolean; // 默认 true
}

export interface BuiltQuery {
  sql: string;
  bind: unknown[];
}

export function buildUpdateQuery(opts: BuildUpdateOptions): BuiltQuery {
  const {
    table,
    allowedFields,
    input,
    whereClause,
    whereBind,
    withUpdatedAt = true,
  } = opts;

  const allowed = new Set(allowedFields);
  const setClauses: string[] = [];
  const setBind: unknown[] = [];

  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      console.warn(
        `[Repository/base] buildUpdateQuery: field '${key}' not in whitelist of table '${table}', ignored.`,
      );
      continue;
    }
    // 字段名经白名单校验, 安全拼入 SQL; 值一律走 bind 参数
    setClauses.push(`${key} = ?`);
    setBind.push(input[key]);
  }

  if (withUpdatedAt) {
    setClauses.push(`updated_at = ${NOW_SQL}`);
  }

  if (setClauses.length === 0) {
    throw new RepositoryError(
      'update',
      table,
      'No valid fields to update after whitelist filter',
    );
  }

  const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClause}`;
  const bind = [...setBind, ...whereBind];

  return { sql, bind };
}
