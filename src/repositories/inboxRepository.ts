// ============================================================
// MedMemory — InboxRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L259-268)
// 表: inbox_items（schema L65-75）
//
// 实现要点:
//   1. inbox_items 没有 updated_at（只有 created_at）—— archive 用裸 SQL,
//      不走 buildUpdateQuery（避免误注入 updated_at 列）
//   2. listPending / countPending 走 idx_inbox_status（status, created_at DESC）
//   3. archive 把 status 置 'archived' + 关联 event_id（媒体转 attachment 由 Domain 层做）
//   4. storage_key / text_content 均可空（photo/voice 用 storage_key, text 用 text_content）
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  InboxItem,
  InboxItemCreateInput,
  InboxRepository,
} from '@/repositories/interfaces';
import {
  executeInsertReturningId,
  executeWrite,
  RepositoryError,
  selectMany,
  selectOne,
} from '@/repositories/base';

const TABLE = 'inbox_items';

interface InboxItemRow {
  id: number;
  capture_type: 'photo' | 'voice' | 'text';
  storage_key: string | null;
  text_content: string | null;
  created_at: string;
  status: 'pending' | 'archived';
  archived_event_id: number | null;
}

function toEntity(row: InboxItemRow): InboxItem {
  return { ...row };
}

export class InboxRepositoryImpl implements InboxRepository {
  constructor(private readonly db: DbHandle) {}

  async create(input: InboxItemCreateInput): Promise<InboxItem> {
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO inbox_items (capture_type, storage_key, text_content)
       VALUES (?, ?, ?) RETURNING id`,
      [input.capture_type, input.storage_key, input.text_content],
    );
    if (id === null) {
      throw new RepositoryError('create', TABLE, 'INSERT RETURNING 未返回 id');
    }
    const created = await this.getById(id);
    if (created === null) {
      throw new RepositoryError('create', TABLE, `id=${id} INSERT 后未查到`);
    }
    return created;
  }

  async getById(id: number): Promise<InboxItem | null> {
    const row = await selectOne<InboxItemRow>(
      this.db,
      `SELECT * FROM inbox_items WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async listPending(): Promise<InboxItem[]> {
    // Dashboard "📥 N 条待整理": 按 created_at 倒序（最新的在最前）
    const rows = await selectMany<InboxItemRow>(
      this.db,
      `SELECT * FROM inbox_items WHERE status = 'pending' ORDER BY created_at DESC`,
    );
    return rows.map(toEntity);
  }

  async countPending(): Promise<number> {
    const row = await selectOne<{ cnt: number }>(
      this.db,
      `SELECT count(*) as cnt FROM inbox_items WHERE status = 'pending'`,
    );
    return row?.cnt ?? 0;
  }

  async archive(id: number, archivedEventId: number): Promise<void> {
    // inbox_items 无 updated_at 字段, 直接写 SQL
    const changes = await executeWrite(
      this.db,
      `UPDATE inbox_items
          SET status = 'archived', archived_event_id = ?
        WHERE id = ?`,
      [archivedEventId, id],
      'update',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }

  async delete(id: number): Promise<void> {
    const changes = await executeWrite(
      this.db,
      `DELETE FROM inbox_items WHERE id = ?`,
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }
}
