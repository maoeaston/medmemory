// ============================================================
// MedMemory — Storage Adapter 接口（文件持久化抽象边界）
// ============================================================
// 对应 ADR-004: 存储抽象 Storage Adapter 模式
// 分层位置: schema → Repository 接口 → sqlite-wasm → 【Storage Adapter】 → Domain → UI
//
// 设计契约:
//   1. 数据模型只持抽象 storage_key, 不关心文件实际存在哪里
//   2. 当前实现: IndexedDbStorageAdapter（原件 Blob）
//   3. 未来实现: OpfsStorageAdapter / OneDriveStorageAdapter / WebDavStorageAdapter
//   4. 所有文件操作必须走 StorageAdapter, 不绕过（PROJECT_CONTEXT 全局约束）
// ============================================================

/**
 * Storage Adapter 运行时错误的错误码。
 *
 * | code | 含义 |
 * |------|------|
 * | `QUOTA_EXCEEDED` | 存储配额不足（浏览器/网盘限制） |
 * | `NOT_OPENED` | Adapter 尚未 open 或已被 close |
 * | `BLOCKED` | 数据库被其他连接占用，无法升级/打开 |
 * | `INVALID_KEY` | storage_key 不合法（空字符串等） |
 * | `IO_ERROR` | 底层读写异常（网络错误、磁盘错误等兜底） |
 */
export type StorageAdapterErrorCode =
  | 'QUOTA_EXCEEDED'
  | 'NOT_OPENED'
  | 'BLOCKED'
  | 'INVALID_KEY'
  | 'IO_ERROR';

/**
 * 所有 StorageAdapter 实现抛出的结构化错误基类。
 *
 * 携带 `code` 字段让 Domain / Repository 层能按错误类型分支
 * （如 QUOTA_EXCEEDED → 提示用户清理空间；BLOCKED → 提示关闭其他标签页）。
 *
 * @example
 * ```ts
 * try {
 *   await adapter.saveFile(key, blob);
 * } catch (e) {
 *   if (e instanceof StorageAdapterError && e.code === 'QUOTA_EXCEEDED') {
 *     // 提示用户清理
 *   } else {
 *     throw e; // 其他错误继续向上抛
 *   }
 * }
 * ```
 */
export class StorageAdapterError extends Error {
  readonly code: StorageAdapterErrorCode;

  constructor(code: StorageAdapterErrorCode, message: string) {
    super(message);
    this.name = 'StorageAdapterError';
    this.code = code;

    // 修复 prototype 链（ES5 目标子类化 Error 的经典坑，TS 严格模式下必须维护）
    Object.setPrototypeOf(this, StorageAdapterError.prototype);
  }
}

/**
 * 文件持久化抽象接口。
 *
 * 数据模型层（`attachments.storage_key` / `inbox_items.storage_key`）
 * 只持有字符串形式的 key；实际的文件 Blob 读写由具体实现负责。
 * 当下只有 {@link IndexedDbStorageAdapter}, 未来接 OPFS / 网盘时新增实现即可,
 * 数据模型零改动。
 *
 * ## 方法契约
 *
 * | 方法 | 不存在时的行为 | 是否幂等 | 抛错场景 |
 * |------|----------------|----------|----------|
 * | `saveFile` | — | ✅ 同 key 覆盖 | I/O 错误、配额不足 |
 * | `getFile` | 返回 `null` | — | I/O 错误（文件不存在不算错误） |
 * | `deleteFile` | 静默成功 | ✅ | I/O 错误 |
 * | `listFiles` | — | — | I/O 错误 |
 *
 * @see ADR-004
 * @see IndexedDbStorageAdapter
 */
export interface StorageAdapter {
  /**
   * 写入文件。同 key 的已存在文件会被**覆盖**（PUT 语义）。
   *
   * @param key storage_key（由 `@/storage/keys` 生成，非空字符串）
   * @param blob 文件二进制内容（MIME 由调用方在 Blob.type 上设置）
   * @throws {StorageAdapterError} code=`INVALID_KEY` 当 key 为空字符串
   * @throws {StorageAdapterError} code=`QUOTA_EXCEEDED` 当存储配额不足
   * @throws {StorageAdapterError} code=`IO_ERROR` 底层 I/O 异常的兜底
   */
  saveFile(key: string, blob: Blob): Promise<void>;

  /**
   * 读取文件。**查询语义**：文件不存在时返回 `null`，不抛错
   * （区别于"磁盘坏了读不出来"那种异常）。
   *
   * @param key storage_key
   * @returns Blob 或 `null`（文件不存在）
   * @throws {StorageAdapterError} code=`IO_ERROR` 底层 I/O 异常
   */
  getFile(key: string): Promise<Blob | null>;

  /**
   * 删除文件。**幂等**：文件不存在时静默成功（不抛 NOT_FOUND）。
   *
   * @param key storage_key
   * @throws {StorageAdapterError} code=`IO_ERROR` 底层 I/O 异常
   */
  deleteFile(key: string): Promise<void>;

  /**
   * 列出所有 key，可选按前缀过滤。
   *
   * 前缀匹配（`startsWith`），不是子串匹配。例：
   * - `listFiles('attachment/3/')` 返回该成员的所有附件 key
   * - `listFiles('inbox/')` 返回所有 Quick Capture 媒体
   * - `listFiles()` 无参返回全部
   *
   * @param prefix 可选前缀；不传则返回全部 key
   * @returns 匹配到的 key 列表（顺序由实现决定）
   * @throws {StorageAdapterError} code=`IO_ERROR` 底层 I/O 异常
   */
  listFiles(prefix?: string): Promise<string[]>;
}
