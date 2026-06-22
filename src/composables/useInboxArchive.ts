// ============================================================
// MedMemory — Inbox 归档编排
// ============================================================
// 实现 PRD 7.1 的 archive path: 多条 inbox_items → 单个 medical_event
//
// 流程:
//   1. 创建 medical_event（anchor）
//   2. 逐条处理 inbox_item:
//      - photo: 迁移 Blob 到新 attachment key + 创建 attachment 行
//      - voice / text: 不创建 attachment, 仅 archive
//      - 所有类型都调 inbox.archive(id, eventId) 标记为已归档
//   3. 失败不中断, 返回 failures 数组让 UI 展示
//
// 不引入 Domain 层目录: 当前架构 UI → Repository 直接调用,
// 把编排逻辑放 composable 即可, 与 useRepositories 单例模式一致
// ============================================================

import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';
import { generateStorageKey } from '@/storage/keys';
import type {
  InboxItem,
  MedicalEventCreateInput,
} from '@/repositories';
import type { Repositories } from '@/repositories';

/**
 * 归档入参。
 * - items: 用户在 InboxView 勾选的 pending 条目
 * - eventInput: ArchiveForm 提交的事件字段（member/date/title/...）
 */
export interface ArchiveInput {
  items: InboxItem[];
  eventInput: MedicalEventCreateInput;
}

/**
 * 单条 inbox_item 处理失败的详情。
 * item 字段让 UI 可以定位是哪条失败（按 id/in capture_type 高亮）。
 */
export interface ArchiveFailure {
  item: InboxItem;
  error: string;
}

/**
 * 归档结果。
 * - eventId: 新创建的 medical_event.id（即使所有 item 都失败, event 已创建）
 * - successCount: 成功 archive 的条数
 * - failures: 失败条目列表（可能为空）
 */
export interface ArchiveResult {
  eventId: number;
  successCount: number;
  failures: ArchiveFailure[];
}

/**
 * 把多条 inbox_items 归档为一个 medical_event。
 *
 * @throws 当 medicalEvent.create 本身失败时抛出（整个归档中止, UI 显示错误）
 */
export async function archiveInboxItems(
  repos: Repositories,
  input: ArchiveInput,
): Promise<ArchiveResult> {
  const storage = new IndexedDbStorageAdapter();

  // 1. 创建 medical_event 作为归档锚点
  const event = await repos.medicalEvent.create(input.eventInput);

  // 2. 逐条处理 inbox_item, 失败不中断
  const failures: ArchiveFailure[] = [];
  let successCount = 0;

  for (const item of input.items) {
    try {
      if (item.capture_type === 'photo' && item.storage_key !== null) {
        await migratePhotoAttachment(repos, storage, {
          inboxStorageKey: item.storage_key,
          memberId: event.member_id,
          eventId: event.id,
        });
      }
      // voice / text: 不创建 attachment, 仅 archive 标记
      // photo: attachment 已创建, 现在 archive inbox_item
      await repos.inbox.archive(item.id, event.id);
      successCount++;
    } catch (e) {
      failures.push({
        item,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { eventId: event.id, successCount, failures };
}

/**
 * 迁移单张照片: inbox Blob → attachment Blob + attachments 行。
 *
 * 流程:
 *   1. getFile(oldKey) 读原件
 *   2. 生成新 attachment key（带 memberId 前缀）
 *   3. saveFile(newKey, blob)
 *   4. attachment.create(...) 写 metadata
 *   5. 成功后 deleteFile(oldKey) 清理 inbox Blob
 *      （inbox_item.storage_key 字段保留, 作为历史引用）
 *
 * 失败回滚:
 *   - getFile 失败 / 返回 null: 抛错, 不写任何东西
 *   - saveFile 失败: 抛错, 不写任何东西（newKey 未生效）
 *   - attachment.create 失败: deleteFile(newKey) 回滚 Blob, 然后抛错
 *
 * file_type 推断: schema CHECK ('jpg','png','pdf'); photo 只能 jpg/png,
 * 从 storage_key 后缀取（PhotoCapture 保证）。其他后缀兜底为 jpg。
 */
async function migratePhotoAttachment(
  repos: Repositories,
  storage: IndexedDbStorageAdapter,
  args: {
    inboxStorageKey: string;
    memberId: number;
    eventId: number;
  },
): Promise<void> {
  const fileExt = inferPhotoExt(args.inboxStorageKey);

  // 1. 读原件
  const blob = await storage.getFile(args.inboxStorageKey);
  if (blob === null) {
    throw new Error(`原件缺失: ${args.inboxStorageKey}`);
  }

  // 2. 生成新 key
  const newKey = generateStorageKey({
    category: 'attachment',
    memberId: args.memberId,
    fileExt,
  });

  // 3. 写新 Blob
  await storage.saveFile(newKey, blob);

  // 4. 写 attachment metadata（失败回滚 Blob）
  try {
    await repos.attachment.create({
      event_id: args.eventId,
      file_name:
        args.inboxStorageKey.split('/').pop() ?? `photo.${fileExt}`,
      file_type: fileExt === 'png' ? 'png' : 'jpg',
      storage_key: newKey,
      doc_type: null,
      subtype: null,
      tags: [],
    });
  } catch (e) {
    await storage.deleteFile(newKey).catch(() => {
      // 回滚失败也不阻塞主错误, 仅 swallow
      // 孤儿 Blob 后续 StorageGC 处理
    });
    throw e;
  }

  // 5. 成功: 删除旧 Blob
  await storage.deleteFile(args.inboxStorageKey).catch(() => {
    // 旧 Blob 删除失败不影响归档成功性, swallow
    // 双 Blob 共存不破坏数据一致性, 后续 StorageGC 清理
  });
}

/**
 * 从 storage_key 推断 photo 扩展名。
 *
 * PhotoCapture 存的 key 形如 `inbox/shared/20260622-143000-a1b2c3d4.jpg`,
 * 后缀保证是 jpg 或 png。其他情况兜底 jpg（schema CHECK 要求）。
 */
function inferPhotoExt(storageKey: string): string {
  const lastDot = storageKey.lastIndexOf('.');
  if (lastDot === -1) return 'jpg';
  const ext = storageKey.slice(lastDot + 1).toLowerCase();
  if (ext === 'png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  // 其他后缀（heic/webp/无）兜底为 jpg（浏览器已转码或 PhotoCapture fallback 处理）
  return 'jpg';
}
