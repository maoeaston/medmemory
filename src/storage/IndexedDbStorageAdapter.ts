// ============================================================
// MedMemory — IndexedDB Storage Adapter 实现
// ============================================================
// 对应 ADR-004: 存储抽象 Storage Adapter 模式
// 分层位置: Storage Adapter 接口的默认实现，管原件文件 Blob
//
// 设计要点:
//   1. 单数据库（medmemory-files）+ 单 object store（blobs）
//      —— 简单、够用；附件量级是家庭医疗档案（百~千张图片/PDF），单 store 游标遍历足够
//   2. keyPath 用 storage_key 字符串（与数据库表的 storage_key 完全一致）
//   3. 原生 IndexedDB API 封装成 Promise，不引入 idb-keyval 等库
//   4. 只持有 Blob（原件），SQLite 数据库走 OPFS 是另一条线，互不交叉
// ============================================================

import type { StorageAdapter } from '@/storage/StorageAdapter';
import { StorageAdapterError } from '@/storage/StorageAdapter';

/**
 * IndexedDbStorageAdapter 构造选项。
 */
export interface IndexedDbStorageAdapterOptions {
  /**
   * IndexedDB 数据库名。默认 `'medmemory-files'`。
   * 与 SQLite 数据库（`medmemory.sqlite3`）是两个完全独立的数据库，命名上隔开。
   */
  dbName?: string;

  /**
   * Object store 名（存放 Blob 原件）。默认 `'blobs'`。
   */
  storeName?: string;
}

/**
 * 默认数据库名。与 sqlite-wasm 的 OPFS 数据库（`medmemory.sqlite3`）分开命名，
 * 避免日后误清理。
 */
const DEFAULT_DB_NAME = 'medmemory-files';

/**
 * 默认 object store 名。
 */
const DEFAULT_STORE_NAME = 'blobs';

/**
 * 当前数据库版本。仅用于触发 `onupgradeneeded` 建表。
 * 未来需要加索引/拆 store 时递增。
 */
const DB_VERSION = 1;

/**
 * 基于 IndexedDB 的 Storage Adapter 实现。
 *
 * ## Schema
 *
 * - 单数据库：`medmemory-files`（version 1）
 * - 单 object store：`blobs`，keyPath 是传入的 storage_key（字符串）
 * - 不建额外索引（列表查询靠游标遍历 + 前缀过滤；附件量级有限，不为此加索引）
 *
 * ## 并发与标签页
 *
 * IndexedDB 天然支持多标签页读写（同一 origin）。唯一需要注意的并发场景是
 * **数据库版本升级**——此时其他标签页未关闭旧连接会触发 `onblocked`。本实现
 * 在 `onblocked` 时抛 `StorageAdapterError(code='BLOCKED')`，提示用户关闭其他标签页后重试。
 *
 * ## 生命周期
 *
 * 构造时即尝试 `open` 数据库；`onupgradeneeded` 中自动建 store。
 * 不提供显式 `close()` —— 浏览器在页面卸载时自动关闭连接，Domain 层无需管理生命周期。
 *
 * @example
 * ```ts
 * const adapter: StorageAdapter = new IndexedDbStorageAdapter();
 * await adapter.saveFile('attachment/3/20260621-220315-a1b2c3d4.jpg', blob);
 * const file = await adapter.getFile('attachment/3/20260621-220315-a1b2c3d4.jpg');
 * ```
 */
export class IndexedDbStorageAdapter implements StorageAdapter {
  private readonly dbName: string;
  private readonly storeName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(options: IndexedDbStorageAdapterOptions = {}) {
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
  }

  /**
   * 懒初始化 + 缓存 IDBDatabase 连接。
   *
   * 第一次调用时打开数据库并触发 `onupgradeneeded`（首次必然建 store）。
   * 同一实例后续调用复用同一个 Promise（避免重复 open）。
   */
  private getDb(): Promise<IDBDatabase> {
    if (this.dbPromise === null) {
      this.dbPromise = this.openDb();
    }
    return this.dbPromise;
  }

  /**
   * 打开数据库，返回 Promise<IDBDatabase>。
   * 失败时 Promise reject 为 StorageAdapterError。
   */
  private openDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      // indexedDB 在非浏览器环境 / 私有模式可能为 undefined
      if (typeof indexedDB === 'undefined') {
        reject(
          new StorageAdapterError(
            'IO_ERROR',
            'IndexedDB is not available in this environment (private mode or non-browser?)',
          ),
        );
        return;
      }

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.dbName, DB_VERSION);
      } catch (e) {
        reject(
          new StorageAdapterError(
            'IO_ERROR',
            `Failed to open IndexedDB: ${this.toMessage(e)}`,
          ),
        );
        return;
      }

      // 首次创建 / 版本升级：建 object store
      request.onupgradeneeded = (_event: IDBVersionChangeEvent) => {
        const db = request.result;
        // 幂等：升级期间可能已存在（如从旧版本升级），只在不存在时建
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
          // keyPath 省略 —— 我们用 out-of-line key（put 时显式传 storage_key）
          // 这样 key 与 attachments.storage_key 字段完全一致，方便排查
        }
      };

      // 其他标签页持有旧连接，版本升级被阻塞
      request.onblocked = (_event: IDBVersionChangeEvent) => {
        reject(
          new StorageAdapterError(
            'BLOCKED',
            'IndexedDB upgrade is blocked by another tab. Close other tabs of this app and try again.',
          ),
        );
      };

      request.onsuccess = () => {
        const db = request.result;
        // 连接意外断开（如用户清除站点数据）—— 让后续操作重新 open
        db.onversionchange = () => {
          db.close();
          // 重置缓存，下次 getDb 会重试
          this.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        // DOMException 上常没有有用 message，用 errorCode 兜底
        const err = request.error;
        const msg = err ? this.toMessage(err) : 'Unknown IndexedDB open error';
        reject(new StorageAdapterError('IO_ERROR', msg));
      };
    });
  }

  /**
   * 在 IDBDatabase 上跑一个事务，返回结果。统一处理事务生命周期和错误转换。
   *
   * @param mode  'readonly' | 'readwrite'
   * @param fn    接收 object store，返回一个 IDBRequest（或直接返回值）
   */
  private runRequest<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | T,
  ): Promise<T> {
    return this.getDb().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          // 健壮性检查：store 在异常升级后可能短暂消失
          if (!db.objectStoreNames.contains(this.storeName)) {
            reject(
              new StorageAdapterError(
                'IO_ERROR',
                `Object store '${this.storeName}' not found. Database may be in an inconsistent state.`,
              ),
            );
            return;
          }

          const tx = db.transaction(this.storeName, mode);
          const store = tx.objectStore(this.storeName);

          let result: IDBRequest<T> | T;
          try {
            result = fn(store);
          } catch (e) {
            reject(this.wrapError(e));
            return;
          }

          // 调用方直接返回值（不走 request）的场景：用事务 oncomplete 兜底
          if (!(result instanceof IDBRequest)) {
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(this.wrapError(tx.error));
            tx.onabort = () =>
              reject(this.wrapError(tx.error ?? new Error('Transaction aborted')));
            return;
          }

          const request = result;
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(this.wrapError(request.error));
        }),
    );
  }

  /**
   * 把底层 DOMException / Error 转换成 StorageAdapterError。
   * 根据 name 做一次配额错误识别，其余统一兜底为 IO_ERROR。
   */
  private wrapError(e: unknown): StorageAdapterError {
    // QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED
    const name = (e as DOMException | null)?.name ?? '';
    if (
      name === 'QuotaExceededError' ||
      name === 'NS_ERROR_DOM_QUOTA_REACHED'
    ) {
      return new StorageAdapterError(
        'QUOTA_EXCEEDED',
        `Storage quota exceeded. Free up space or remove unused files. (${this.toMessage(e)})`,
      );
    }
    if (e instanceof StorageAdapterError) {
      return e;
    }
    return new StorageAdapterError(
      'IO_ERROR',
      `IndexedDB operation failed: ${this.toMessage(e)}`,
    );
  }

  /** 把任意 unknown 错误安全转成字符串，避免 [object Object] */
  private toMessage(e: unknown): string {
    if (e instanceof Error) {
      return e.message || e.name;
    }
    if (typeof e === 'string') {
      return e;
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }

  /** 校验 key 非空，空 key 是逻辑错误而非 I/O 问题 */
  private validateKey(key: string): void {
    if (key === '') {
      throw new StorageAdapterError(
        'INVALID_KEY',
        'storage_key must be a non-empty string',
      );
    }
  }

  // ============================================================
  // StorageAdapter 接口实现
  // ============================================================

  async saveFile(key: string, blob: Blob): Promise<void> {
    this.validateKey(key);
    // store.put 返回 IDBRequest<IDBValidKey>; T 必须与之匹配, void 会被拒收
    await this.runRequest<IDBValidKey>('readwrite', (store) =>
      store.put(blob, key),
    );
  }

  async getFile(key: string): Promise<Blob | null> {
    this.validateKey(key);
    const result = await this.runRequest<unknown>('readonly', (store) =>
      store.get(key),
    );
    // store.get 不存在时返回 undefined；这里标准化为 null
    return result instanceof Blob ? result : null;
  }

  async deleteFile(key: string): Promise<void> {
    this.validateKey(key);
    // 幂等：store.delete 不存在的 key 不报错
    await this.runRequest<undefined>('readwrite', (store) =>
      store.delete(key),
    );
  }

  async listFiles(prefix?: string): Promise<string[]> {
    const db = await this.getDb();
    if (!db.objectStoreNames.contains(this.storeName)) {
      throw new StorageAdapterError(
        'IO_ERROR',
        `Object store '${this.storeName}' not found. Database may be in an inconsistent state.`,
      );
    }

    return new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const keys: string[] = [];

      // 用 openKeyCursor 遍历 key（不读 value，省内存）
      // 旧浏览器不支持 openKeyCursor 的情况退到 openCursor。
      // openKeyCursor/openCursor 返回的 cursor 类型不同（IDBCursor vs IDBCursorWithValue）,
      // 但我们只消费共有的 .key 和 .continue() —— 统一 cast 到 IDBCursor|null 即可。
      // 显式 cast 两边避免三元表达式类型不兼容（IDBCursorWithValue 不能赋给 IDBCursor）。
      const cursorRequest: IDBRequest<IDBCursor | null> =
        typeof store.openKeyCursor === 'function'
          ? (store.openKeyCursor() as IDBRequest<IDBCursor | null>)
          : (store.openCursor() as IDBRequest<IDBCursor | null>);

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor === null) {
          return;
        }
        // out-of-line key 永远是字符串（由 saveFile 保证）
        const key = cursor.key;
        if (typeof key === 'string') {
          if (prefix === undefined || key.startsWith(prefix)) {
            keys.push(key);
          }
        }
        cursor.continue();
      };

      cursorRequest.onerror = () => reject(this.wrapError(cursorRequest.error));
      tx.onerror = () => reject(this.wrapError(tx.error));
      tx.onabort = () =>
        reject(this.wrapError(tx.error ?? new Error('Transaction aborted')));

      tx.oncomplete = () => resolve(keys);
    });
  }
}
