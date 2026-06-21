// ============================================================
// MedMemory — storage_key 生成工具
// ============================================================
// 对应: attachments.storage_key / inbox_items.storage_key 字段
// 设计: 层次化路径 + 时间戳 + 随机后缀，方便按前缀过滤（listFiles(prefix)）
//
// 格式: {category}/{memberScope}/{YYYYMMDD-HHmmss}-{8hex}.{ext}
//   - category:     'attachment'（归档附件） | 'inbox'（Quick Capture 媒体）
//   - memberScope:  memberId 字符串 | 'shared'（家庭共用，memberId 缺省）
//   - 时间戳:        本地时间，方便人肉排查（同一秒内靠随机后缀去重）
//   - 随机后缀:      8 位十六进制（32 bit），crypto.getRandomValues 生成
//
// 示例:
//   attachment/3/20260621-220315-a1b2c3d4.jpg
//   inbox/shared/20260621-220315-a1b2c3d4.m4a
//   attachment/1/20260621-220315-abcdef01.pdf
// ============================================================

/**
 * storage_key 所属类别，与 schema 中两张消费 storage_key 的表一一对应：
 * - `'attachment'` → attachments.storage_key
 * - `'inbox'`      → inbox_items.storage_key（Quick Capture 的 photo/voice 媒体）
 */
export type StorageKeyCategory = 'attachment' | 'inbox';

/**
 * {@link generateStorageKey} 的入参。
 */
export interface GenerateStorageKeyOptions {
  /** key 所属类别 */
  category: StorageKeyCategory;

  /**
   * 文件扩展名（不含点号），如 `'jpg'`、`'pdf'`、`'m4a'`。
   * 调用方从 Blob.type 或原文件名解析后传入；本函数只做拼接，不做 MIME 校验。
   */
  fileExt: string;

  /**
   * 关联的家庭成员 id。**缺省**时 key 落到 `shared/`（家庭共用），如 inbox 默认。
   * attachment 通常一定有 memberId（成员的检查报告）。
   */
  memberId?: number;
}

/** 左侧补零到 2 位，用于月/日/时/分/秒 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 生成本地时间戳片段：YYYYMMDD-HHmmss
 *
 * 用本地时间而非 UTC——key 给人看（排查时一眼定位日期），UTC 偏移反而碍事。
 * 存储层只认 key 的唯一性，不关心时区。
 */
function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const h = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * 用 Web Crypto API 生成 8 位十六进制随机后缀（32 bit）。
 *
 * 浏览器原生 `crypto.getRandomValues`，无需引入 uuid 库。
 * 同一秒内并发的两次调用，32 bit 随机空间碰撞概率 ~1/4.3e9，自用场景足够。
 */
function randomSuffix(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // padStart 保证位数稳定（虽然 toString(16) 一般够长，保险起见）
  return buf[0].toString(16).padStart(8, '0').slice(-8);
}

/**
 * 规整文件扩展名：去前导点、转小写。
 * 空字符串保留为空（调用方传空时 key 以 `.` 结尾，业务层自行保证传入非空）。
 */
function normalizeExt(fileExt: string): string {
  const trimmed = fileExt.trim();
  if (trimmed === '') {
    return '';
  }
  const noDot = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
  return noDot.toLowerCase();
}

/**
 * 生成一个全局唯一的 storage_key。
 *
 * @example
 * ```ts
 * // 成员附件
 * const k1 = generateStorageKey({
 *   category: 'attachment',
 *   memberId: 3,
 *   fileExt: 'jpg',
 * });
 * // → 'attachment/3/20260621-220315-a1b2c3d4.jpg'
 *
 * // Quick Capture 语音（家庭共用，无 memberId）
 * const k2 = generateStorageKey({
 *   category: 'inbox',
 *   fileExt: 'm4a',
 * });
 * // → 'inbox/shared/20260621-220315-a1b2c3d4.m4a'
 * ```
 *
 * @param opts 见 {@link GenerateStorageKeyOptions}
 * @returns 符合格式 `{category}/{memberScope}/{ts}-{rand}.{ext}` 的字符串
 */
export function generateStorageKey(opts: GenerateStorageKeyOptions): string {
  const { category, fileExt, memberId } = opts;
  const memberScope =
    memberId !== undefined && memberId > 0 ? String(memberId) : 'shared';

  const ext = normalizeExt(fileExt);
  const ts = formatTimestamp(new Date());
  const rand = randomSuffix();

  const extPart = ext !== '' ? `.${ext}` : '';
  return `${category}/${memberScope}/${ts}-${rand}${extPart}`;
}
