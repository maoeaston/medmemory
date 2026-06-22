// ============================================================
// MedMemory — AttachmentRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L321-345)
// 表: attachments（schema L119-139）
//
// 实现要点:
//   1. ai_generated: SQLite INTEGER 0/1 ↔ TS boolean（fromDbBoolean/toDbBoolean）
//   2. tags: JSON TEXT, NULL → [] 兜底（readJsonArray/writeJsonArray）
//   3. attachments 没有 updated_at（只有 created_at）, updateTags / updateProcessingStatus
//      用裸 SQL, 不走 buildUpdateQuery
//   4. delete 仅删 metadata 行, **不**调 StorageAdapter.deleteFile
//      原件 Blob 删除由 Domain 层显式编排（interfaces.ts:335 注释约定）
//   5. findLatestByMember JOIN medical_events 取 member_id（用 idx_attachments_event_doc 索引）
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  Attachment,
  AttachmentCreateInput,
  AttachmentRepository,
  DocType,
  ProcessingStatus,
} from '@/repositories/interfaces';
import {
  executeInsertReturningId,
  executeWrite,
  fromDbBoolean,
  readJsonArray,
  RepositoryError,
  selectMany,
  selectOne,
  writeJsonArray,
} from '@/repositories/base';

const TABLE = 'attachments';

interface AttachmentRow {
  id: number;
  event_id: number | null;
  file_name: string;
  file_type: 'jpg' | 'png' | 'pdf';
  storage_key: string;
  doc_type: DocType | null;
  subtype: string | null;
  tags: string | null; // JSON TEXT
  processing_status: ProcessingStatus;
  processing_error: string | null;
  ai_generated: number; // INTEGER 0/1
  created_at: string;
}

function toEntity(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    event_id: row.event_id,
    file_name: row.file_name,
    file_type: row.file_type,
    storage_key: row.storage_key,
    doc_type: row.doc_type,
    subtype: row.subtype,
    tags: readJsonArray<string>(row.tags, []),
    processing_status: row.processing_status,
    processing_error: row.processing_error,
    ai_generated: fromDbBoolean(row.ai_generated),
    created_at: row.created_at,
  };
}

export class AttachmentRepositoryImpl implements AttachmentRepository {
  constructor(private readonly db: DbHandle) {}

  async create(input: AttachmentCreateInput): Promise<Attachment> {
    // ai_generated 默认 false（schema DEFAULT 0）, 不显式 INSERT
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO attachments (
        event_id, file_name, file_type, storage_key,
        doc_type, subtype, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.event_id,
        input.file_name,
        input.file_type,
        input.storage_key,
        input.doc_type,
        input.subtype,
        writeJsonArray(input.tags),
      ],
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

  async getById(id: number): Promise<Attachment | null> {
    const row = await selectOne<AttachmentRow>(
      this.db,
      `SELECT * FROM attachments WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async listByEvent(eventId: number): Promise<Attachment[]> {
    // 走 idx_attachments_event（event_id）
    const rows = await selectMany<AttachmentRow>(
      this.db,
      `SELECT * FROM attachments WHERE event_id = ? ORDER BY created_at DESC`,
      [eventId],
    );
    return rows.map(toEntity);
  }

  async getByStorageKey(storageKey: string): Promise<Attachment | null> {
    // 无索引（storage_key 是 NOT NULL 但未建索引）, 附件量级有限可接受
    const row = await selectOne<AttachmentRow>(
      this.db,
      `SELECT * FROM attachments WHERE storage_key = ? LIMIT 1`,
      [storageKey],
    );
    return row ? toEntity(row) : null;
  }

  async updateTags(id: number, tags: string[]): Promise<Attachment> {
    const changes = await executeWrite(
      this.db,
      `UPDATE attachments SET tags = ? WHERE id = ?`,
      [writeJsonArray(tags), id],
      'update',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
    const updated = await this.getById(id);
    if (updated === null) {
      throw new RepositoryError('not-found', TABLE, `id=${id} UPDATE 后未查到`);
    }
    return updated;
  }

  async updateDocType(
    id: number,
    docType: DocType | null,
    subtype?: string | null,
  ): Promise<Attachment> {
    // subtype 未传 (undefined) → 保留原值; 显式 null → 清空
    const includeSubtype = subtype !== undefined;
    const sql = includeSubtype
      ? `UPDATE attachments SET doc_type = ?, subtype = ? WHERE id = ?`
      : `UPDATE attachments SET doc_type = ? WHERE id = ?`;
    const bind = includeSubtype ? [docType, subtype, id] : [docType, id];
    const changes = await executeWrite(this.db, sql, bind, 'update');
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
    const updated = await this.getById(id);
    if (updated === null) {
      throw new RepositoryError('not-found', TABLE, `id=${id} UPDATE 后未查到`);
    }
    return updated;
  }

  async updateProcessingStatus(
    id: number,
    status: ProcessingStatus,
    processingError?: string | null,
  ): Promise<Attachment> {
    // processingError 默认 null（FAILED 之外的状态不应保留旧 error）
    const errorValue = processingError === undefined ? null : processingError;
    const changes = await executeWrite(
      this.db,
      `UPDATE attachments
          SET processing_status = ?, processing_error = ?
        WHERE id = ?`,
      [status, errorValue, id],
      'update',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
    const updated = await this.getById(id);
    if (updated === null) {
      throw new RepositoryError('not-found', TABLE, `id=${id} UPDATE 后未查到`);
    }
    return updated;
  }

  async delete(id: number): Promise<void> {
    // 只删 metadata 行; 原件 Blob 由 Domain 层显式调 StorageAdapter.deleteFile
    const changes = await executeWrite(
      this.db,
      `DELETE FROM attachments WHERE id = ?`,
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }

  async findLatestByMember(
    memberId: number,
    filter: { docType?: DocType; subtype?: string },
  ): Promise<Attachment | null> {
    // JOIN medical_events 拿 member_id; 动态拼 doc_type / subtype 过滤
    const where: string[] = ['me.member_id = ?'];
    const bind: unknown[] = [memberId];

    if (filter.docType !== undefined) {
      where.push('a.doc_type = ?');
      bind.push(filter.docType);
    }
    if (filter.subtype !== undefined) {
      where.push('a.subtype = ?');
      bind.push(filter.subtype);
    }

    const row = await selectOne<AttachmentRow>(
      this.db,
      `SELECT a.*
         FROM attachments a
         JOIN medical_events me ON me.id = a.event_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.created_at DESC
        LIMIT 1`,
      bind,
    );
    return row ? toEntity(row) : null;
  }

  async listPendingAi(): Promise<Attachment[]> {
    // 处理待办: UPLOADED (从未处理) + FAILED (可重试). 按 created_at ASC 早者优先.
    // 不含 OCR_PROCESSING (理论上不应出现在待办列表, 即使卡死也由用户手动重试).
    // 不含 OCR_DONE / SUMMARY_DONE (已完成).
    const rows = await selectMany<AttachmentRow>(
      this.db,
      `SELECT * FROM attachments
        WHERE processing_status IN ('UPLOADED', 'FAILED')
        ORDER BY created_at ASC`,
      [],
    );
    return rows.map(toEntity);
  }
}
