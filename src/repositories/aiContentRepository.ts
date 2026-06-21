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
  attachment_id: number;
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
      `INSERT INTO ai_contents (attachment_id, content_type, model, prompt_version, content)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [
        input.attachment_id,
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
