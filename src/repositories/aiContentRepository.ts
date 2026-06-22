// ============================================================
// MedMemory — AiContentRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L352-366)
// 表: ai_contents（schema L150-159）
//
// 实现要点:
//   1. 无 update 操作（AI 产出不可变, 重新生成=create 新版本）
//   2. 无 updated_at（只有 created_at）
//   3. getLatestByAttachment 走 idx_ai_attachment（attachment_id, content_type, created_at DESC）
//   4. listVersionsByAttachment 同一索引, 可选 content_type 过滤
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  AiContent,
  AiContentCreateInput,
  AiContentRepository,
  AiContentType,
} from '@/repositories/interfaces';
import {
  executeInsertReturningId,
  executeWrite,
  RepositoryError,
  selectMany,
  selectOne,
} from '@/repositories/base';

const TABLE = 'ai_contents';

interface AiContentRow {
  id: number;
  attachment_id: number | null;
  event_id: number | null;
  content_type: AiContentType;
  model: string;
  prompt_version: string;
  content: string;
  created_at: string;
}

function toEntity(row: AiContentRow): AiContent {
  return { ...row };
}

export class AiContentRepositoryImpl implements AiContentRepository {
  constructor(private readonly db: DbHandle) {}

  async create(input: AiContentCreateInput): Promise<AiContent> {
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO ai_contents (attachment_id, event_id, content_type, model, prompt_version, content)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.attachment_id,
        input.event_id,
        input.content_type,
        input.model,
        input.prompt_version,
        input.content,
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

  async getById(id: number): Promise<AiContent | null> {
    const row = await selectOne<AiContentRow>(
      this.db,
      `SELECT * FROM ai_contents WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async getLatestByAttachment(
    attachmentId: number,
    contentType: AiContentType,
  ): Promise<AiContent | null> {
    // 走 idx_ai_attachment（attachment_id, content_type, created_at DESC）
    const row = await selectOne<AiContentRow>(
      this.db,
      `SELECT * FROM ai_contents
        WHERE attachment_id = ? AND content_type = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [attachmentId, contentType],
    );
    return row ? toEntity(row) : null;
  }

  async listVersionsByAttachment(
    attachmentId: number,
    contentType?: AiContentType,
  ): Promise<AiContent[]> {
    // 同一索引, contentType 可选
    if (contentType !== undefined) {
      const rows = await selectMany<AiContentRow>(
        this.db,
        `SELECT * FROM ai_contents
          WHERE attachment_id = ? AND content_type = ?
          ORDER BY created_at DESC`,
        [attachmentId, contentType],
      );
      return rows.map(toEntity);
    }
    const rows = await selectMany<AiContentRow>(
      this.db,
      `SELECT * FROM ai_contents
        WHERE attachment_id = ?
        ORDER BY content_type, created_at DESC`,
      [attachmentId],
    );
    return rows.map(toEntity);
  }

  /**
   * 查 event 下所有待确认的 AI 推荐健康问题。
   *
   * 两路 OR (migration 004 后):
   *   - 附件级 AI 推荐: ai_contents.attachment_id IN (该 event 的附件)
   *   - 纯文本事件 AI 推荐: ai_contents.event_id = 该 event
   *
   * 走 idx_ai_event (event_id, content_type) + attachments.event_id 索引。
   * 返回原始行, 由应用层解析 content JSON。
   */
  async listPendingSuggestionsByEvent(
    eventId: number,
  ): Promise<AiContent[]> {
    const rows = await selectMany<AiContentRow>(
      this.db,
      `SELECT ai.*
         FROM ai_contents ai
        WHERE ai.content_type = 'suggested_health_problems'
          AND (ai.event_id = ?
               OR ai.attachment_id IN (SELECT id FROM attachments WHERE event_id = ?))
        ORDER BY ai.created_at DESC`,
      [eventId, eventId],
    );
    return rows.map(toEntity);
  }

  async delete(id: number): Promise<void> {
    const changes = await executeWrite(
      this.db,
      `DELETE FROM ai_contents WHERE id = ?`,
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }
}
