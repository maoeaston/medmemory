// ============================================================
// MedMemory — 数据备份/恢复/重置编排（Domain 层）
// ============================================================
// 分层位置: 不涉及 UI, 在 connection.ts / IndexedDbStorageAdapter /
// useRepositories 之上做编排, 给 SettingsView 调用。
//
// 三件事:
//   1. exportAllData(): sqlite + 所有 Blob → zip Blob
//   2. importAllData(zip): zip → 覆盖 sqlite + Blob, 清 orphans
//   3. resetAllData(): 清空 OPFS sqlite + 所有 Blob, 不 reload（由 UI 决定）
//
// 设计约定:
//   - 进度回调 onProgress: 用于 UI 显示 "3/42 张附件..." 具体数字
//   - 不在这里 location.reload(): 由 UI 层决定（导入/重置成功后都建议 reload）
//   - 错误抛出: UI 层 try/catch 显示 errorMessage
//   - 不做 schema 迁移: manifest.schema_version !== 1 直接抛错
//   - blob 路径在 zip 里加 'blobs/' 前缀, 避免和 manifest.json 等保留名冲突
// ============================================================

import JSZip from 'jszip';
import { closeDb, getDb } from '@/db/connection';
import { resetRepositories } from '@/composables/useRepositories';
import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';

// ============================================================
// 类型
// ============================================================

export type ExportPhase =
  | 'sqlite'
  | 'enumerate-blobs'
  | 'read-blobs'
  | 'zip-generate';

export interface ExportProgress {
  phase: ExportPhase;
  /** 当前处理到的索引（从 1 开始） */
  current?: number;
  /** 总数 */
  total?: number;
}

export interface ExportResult {
  /** 生成的 zip Blob（可直接 createObjectURL 下载） */
  blob: Blob;
  /** 建议的文件名: medmemory-backup-YYYY-MM-DD.zip */
  filename: string;
  /** 包含的附件数 */
  blobCount: number;
  /** sqlite 文件字节数 */
  sqliteBytes: number;
}

export type ImportPhase =
  | 'parse-zip'
  | 'validate-manifest'
  | 'write-sqlite'
  | 'cleanup-orphans'
  | 'write-blobs';

export interface ImportProgress {
  phase: ImportPhase;
  current?: number;
  total?: number;
}

export interface ImportSummary {
  sqliteBytes: number;
  /** 成功写入的附件数 */
  blobImported: number;
  /** 删除的孤儿附件数（存在于当前 IDB 但不在 zip 里） */
  blobDeletedOrphans: number;
  /** 从 config.json 应用到 localStorage 的配置项数 (0 = zip 里没 config.json) */
  configApplied: number;
}

interface BackupManifest {
  schema_version: number;
  exported_at: string; // ISO 8601 UTC
  sqlite_bytes: number;
  blob_count: number;
  app_version: string;
}

// ============================================================
// 常量
// ============================================================

const APP_VERSION = '0.1.0';
const SCHEMA_VERSION = 1;
const SQLITE_OPFS_FILENAME = 'medmemory.sqlite3';
const SQLITE_ZIP_PATH = 'medmemory.sqlite3';
const MANIFEST_ZIP_PATH = 'manifest.json';
const BLOB_ZIP_PREFIX = 'blobs/';
const CONFIG_ZIP_PATH = 'config.json';

/**
 * 备份范围内 localStorage 配置 key 白名单。
 *
 * 用户决策 (PRD 取舍 #?): "全加" — AI 配置 + sync 配置随 zip 明文流转, 跨设备/换浏览器不重填。
 *
 * 排除 medmemory:sync:clientId:
 *   clientId 是 crypto.randomUUID() 生成的 per-device UUID (useSyncConfig.ts)。
 *   如果设备 B 导入设备 A 的 clientId, 服务器看到两端 clientId 相同,
 *   checkout 时把 A 已持有的锁误判为 "B 自己已持有", 直接破坏多端互斥语义。
 *   clientId 必须每设备独立, 不在备份范围。
 *
 * 注: clientLabel 是用户填的显示名 (如 "爸爸的手机"), 跨设备导入后用户可能要重填
 *     以反映新设备身份, 但它不是机器标识, 列入备份。
 */
const BACKUP_CONFIG_KEYS = [
  'medmemory:ai:ocr:apiKey',
  'medmemory:ai:ocr:baseUrl',
  'medmemory:ai:ocr:model',
  'medmemory:ai:health-agent:apiKey',
  'medmemory:ai:health-agent:baseUrl',
  'medmemory:ai:health-agent:model',
  'medmemory:sync:serverUrl',
  'medmemory:sync:token',
  'medmemory:sync:clientLabel',
] as const;

// ============================================================
// 辅助
// ============================================================

/** 当前日期 YYYY-MM-DD（本地时区, 用于文件名, 不走 UTC） */
function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 从 zip 路径还原 storage_key: 'blobs/attachment/3/x.png' → 'attachment/3/x.png' */
function zipPathToStorageKey(zipPath: string): string {
  return zipPath.slice(BLOB_ZIP_PREFIX.length);
}

/** 当前 UTC ISO 时间戳 */
function nowUtcIso(): string {
  return new Date().toISOString();
}

/**
 * 从 localStorage 收集白名单内的非空配置。
 * 返回 key→value 字典; 任何 key 缺失或空串都跳过。
 */
function collectConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const key of BACKUP_CONFIG_KEYS) {
      const v = localStorage.getItem(key);
      if (v && v.trim()) out[key] = v;
    }
  } catch {
    // localStorage 不可用 (隐私模式): 返回空对象, 备份继续 (不含 config.json)
  }
  return out;
}

/**
 * 把 config 字典应用回 localStorage, 只写白名单内 + 非空的项。
 * 返回成功写入的项数。
 */
function applyConfig(config: unknown): number {
  if (typeof config !== 'object' || config === null) return 0;
  const obj = config as Record<string, unknown>;
  let applied = 0;
  try {
    for (const key of BACKUP_CONFIG_KEYS) {
      const v = obj[key];
      if (typeof v === 'string' && v) {
        localStorage.setItem(key, v);
        applied++;
      }
    }
  } catch {
    // localStorage 不可用: 静默 (导入主体依然成功, 但配置未应用)
  }
  return applied;
}

// ============================================================
// exportAllData
// ============================================================

/**
 * 导出 sqlite 数据库 + 所有附件 Blob 为 zip。
 *
 * 流程: 导出 sqlite 字节 → 列出所有 storage_key → 逐个读 Blob → zip 打包。
 *
 * @throws 当 sqlite 导出失败或 Blob 读取失败时抛 Error
 */
export async function exportAllData(
  onProgress?: (p: ExportProgress) => void,
): Promise<ExportResult> {
  // 1. sqlite 字节
  onProgress?.({ phase: 'sqlite' });
  const db = await getDb();
  const sqliteBytes = await db.exportBytes();

  // 2. 枚举 Blob keys
  onProgress?.({ phase: 'enumerate-blobs' });
  const storage = new IndexedDbStorageAdapter();
  const keys = await storage.listFiles();

  // 3. 逐个读 Blob + 加入 zip
  const zip = new JSZip();
  onProgress?.({ phase: 'read-blobs', current: 0, total: keys.length });
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const blob = await storage.getFile(key);
    if (blob !== null) {
      // key 已含 'attachment/...' / 'inbox/...' 前缀, 加 'blobs/' 统一归类
      zip.file(BLOB_ZIP_PREFIX + key, blob);
    }
    onProgress?.({ phase: 'read-blobs', current: i + 1, total: keys.length });
  }

  // 4. 加 sqlite + config + manifest
  zip.file(SQLITE_ZIP_PATH, sqliteBytes);
  const config = collectConfig();
  if (Object.keys(config).length > 0) {
    zip.file(CONFIG_ZIP_PATH, JSON.stringify(config, null, 2));
  }
  const manifest: BackupManifest = {
    schema_version: SCHEMA_VERSION,
    exported_at: nowUtcIso(),
    sqlite_bytes: sqliteBytes.byteLength,
    blob_count: keys.length,
    app_version: APP_VERSION,
  };
  zip.file(MANIFEST_ZIP_PATH, JSON.stringify(manifest, null, 2));

  // 5. 生成 zip Blob
  onProgress?.({ phase: 'zip-generate' });
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return {
    blob,
    filename: `medmemory-backup-${todayLocalIso()}.zip`,
    blobCount: keys.length,
    sqliteBytes: sqliteBytes.byteLength,
  };
}

// ============================================================
// importAllData
// ============================================================

/**
 * 从 zip 导入: 覆盖 sqlite + Blob, 清理 orphan。
 *
 * 流程:
 *   1. 解析 zip + 校验 manifest.schema_version
 *   2. 关 sqlite 连接（不删文件, 等下覆写）
 *   3. 用 File System Access API 直接覆写 OPFS 的 medmemory.sqlite3
 *   4. 清理 IDB 里不在 zip 中的 orphan blob
 *   5. 把 zip 里的 blob 写入 IDB（PUT 覆写语义）
 *
 * 不做 location.reload(): UI 层在成功后调。
 *
 * @throws manifest 缺失/版本不符/写入失败时抛
 */
export async function importAllData(
  zipFile: File | Blob,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportSummary> {
  // 1. 解析 zip
  onProgress?.({ phase: 'parse-zip' });
  const zip = await JSZip.loadAsync(zipFile);

  // 2. 校验 manifest
  onProgress?.({ phase: 'validate-manifest' });
  const manifestFile = zip.file(MANIFEST_ZIP_PATH);
  if (manifestFile === null) {
    throw new Error(`备份文件缺少 ${MANIFEST_ZIP_PATH}, 可能不是 MedMemory 备份`);
  }
  const manifestText = await manifestFile.async('string');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(manifestText) as BackupManifest;
  } catch {
    throw new Error(`${MANIFEST_ZIP_PATH} 解析失败, 文件可能已损坏`);
  }
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `备份的 schema_version=${manifest.schema_version}, 当前应用只支持 ${SCHEMA_VERSION}. 可能需要升级应用或使用兼容版本备份。`,
    );
  }

  // 读 sqlite 字节
  const sqliteFile = zip.file(SQLITE_ZIP_PATH);
  if (sqliteFile === null) {
    throw new Error(`备份文件缺少 ${SQLITE_ZIP_PATH}, 数据不完整`);
  }
  const sqliteBytes = await sqliteFile.async('uint8array');

  // 收集 zip 里的 blob keys
  const blobKeysInZip: string[] = [];
  zip.forEach((path, file) => {
    if (!file.dir && path.startsWith(BLOB_ZIP_PREFIX) && path !== BLOB_ZIP_PREFIX) {
      blobKeysInZip.push(zipPathToStorageKey(path));
    }
  });

  // 3. 关 sqlite 连接（不 unlink, 我们要覆写）
  await closeDb();

  // 4. 覆写 OPFS 的 medmemory.sqlite3
  // sqlite-wasm 的 opfs VFS 在 OPFS root 放 medmemory.sqlite3
  onProgress?.({ phase: 'write-sqlite' });
  // FileSystemFileHandle.write 要求 ArrayBuffer（非 SharedArrayBuffer）,
  // sqlite-wasm 返回的 Uint8Array 可能是 ArrayBufferLike; 用 slice 拷贝保证类型
  const sqliteBuffer = sqliteBytes.slice().buffer;
  const opfsRoot = await navigator.storage.getDirectory();
  const fileHandle = await opfsRoot.getFileHandle(SQLITE_OPFS_FILENAME, {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(sqliteBuffer);
  await writable.close();

  // 5. 清 orphan + 写入
  const storage = new IndexedDbStorageAdapter();

  // 5a. 列出当前 IDB 的 keys, 删除不在 zip 里的
  onProgress?.({ phase: 'cleanup-orphans' });
  const existingKeys = await storage.listFiles();
  const zipKeySet = new Set(blobKeysInZip);
  let orphansDeleted = 0;
  for (const key of existingKeys) {
    if (!zipKeySet.has(key)) {
      await storage.deleteFile(key);
      orphansDeleted++;
    }
  }

  // 5b. 写入 zip 里的每个 blob
  onProgress?.({ phase: 'write-blobs', current: 0, total: blobKeysInZip.length });
  let imported = 0;
  for (let i = 0; i < blobKeysInZip.length; i++) {
    const key = blobKeysInZip[i];
    const entry = zip.file(BLOB_ZIP_PREFIX + key);
    if (entry === null) continue;
    const blob = await entry.async('blob');
    await storage.saveFile(key, blob);
    imported++;
    onProgress?.({
      phase: 'write-blobs',
      current: i + 1,
      total: blobKeysInZip.length,
    });
  }

  // 6. 应用 config.json (可选, 旧备份没有此文件 → configApplied=0)
  // 白名单 + 类型校验在 applyConfig 内, 防止 zip 里塞乱七八糟 key.
  // 不抛错: config 应用失败不阻塞主数据导入, UI reload 后用户看到旧 config 也能用.
  let configApplied = 0;
  const configFile = zip.file(CONFIG_ZIP_PATH);
  if (configFile !== null) {
    try {
      const configText = await configFile.async('string');
      const parsed = JSON.parse(configText);
      configApplied = applyConfig(parsed);
    } catch (e) {
      // config.json 解析失败: 记 console.warn 但不阻塞导入
      console.warn('[useDataBackup] config.json 解析失败, 跳过配置应用:', e);
    }
  }

  return {
    sqliteBytes: sqliteBytes.byteLength,
    blobImported: imported,
    blobDeletedOrphans: orphansDeleted,
    configApplied,
  };
}

// ============================================================
// resetAllData
// ============================================================

/**
 * 清空所有数据: OPFS sqlite 文件 + IndexedDB 所有 Blob。
 * 不做 location.reload(), UI 层在成功后调。
 *
 * 实现说明:
 *   - closeDb() 只关连接（sqlite-wasm 的 unlink:true 在 opfs VFS 上行为不稳）
 *   - 用 File System Access API 的 removeEntry 显式删 OPFS 文件, 更可靠
 *   - IndexedDB.deleteDatabase 会被打开的连接 block, 所以改走
 *     listFiles + 逐个 deleteFile（即使有其他组件持有 IDB 连接也能工作）
 *   - resetRepositories() 清单例, 下次 useRepositories() 会重建
 */
export async function resetAllData(): Promise<void> {
  // 1. 关 sqlite 连接（不依赖 unlink）
  await closeDb();

  // 2. 显式删 OPFS 文件（忽略"文件不存在"错误, 幂等）
  try {
    const opfsRoot = await navigator.storage.getDirectory();
    await opfsRoot.removeEntry(SQLITE_OPFS_FILENAME);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 找不到文件属于正常（可能首次运行还没初始化）; 其他错误抛出
    if (!/not\s*found/i.test(msg) && !/no entry/i.test(msg)) {
      throw new Error(`删除 OPFS 文件失败: ${msg}`);
    }
  }

  // 3. 清 IDB 所有 Blob（用 deleteFile 而非 deleteDatabase, 避免被 block）
  const storage = new IndexedDbStorageAdapter();
  const keys = await storage.listFiles();
  for (const key of keys) {
    await storage.deleteFile(key);
  }

  // 4. 清 Repositories 单例
  resetRepositories();
}
