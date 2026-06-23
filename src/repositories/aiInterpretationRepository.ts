// ============================================================
// MedMemory — AiInterpretationRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (AiInterpretationRepository)
// 表: ai_interpretations（migration 005, PRD v3.2 §8 #3）
//
// 实现要点:
//   1. 无 update 操作（AI 解读不可变, 重新生成=create 新版本, 老版本保留作历史对比）
//   2. 无 updated_at（只有 created_at）
//   3. 双 FK 互斥由 DB CHECK 强制, 应用层 create 时仍要保证 kind 与 FK 一致
//   4. getLatestByXxx 走 created_at DESC LIMIT 1
//   5. deleteByAttachment 用于 lab_indicators 重跑时连带删 (invalidate 旧解读)
//      deleteByMedicine 一般不主动调 (medicine 删除走 FK CASCADE)
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  AiInterpretation,
  AiInterpretationCreateInput,
  AiInterpretationKind,
  AiInterpretationRepository,
} from '@/repositories/interfaces';
import {
  executeInsertReturningId,
  executeWrite,
  RepositoryError,
  selectOne,
} from '@/repositories/base';

const TABLE = 'ai_interpretations';

interface AiInterpretationRow {
  id: number;
  attachment_id: number | null;
  medicine_id: number | null;
  kind: AiInterpretationKind;
  content_json: string;
  provider: string;
  model: string;
  prompt_version: string;
  created_at: string;
}

function toEntity(row: AiInterpretationRow): AiInterpretation {
  return { ...row };
}

export class AiInterpretationRepositoryImpl
  implements AiInterpretationRepository
{
  constructor(private readonly db: DbHandle) {}

  async create(input: AiInterpretationCreateInput): Promise<AiInterpretation> {
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO ai_interpretations
         (attachment_id, medicine_id, kind, content_json, provider, model, prompt_version)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.attachment_id,
        input.medicine_id,
        input.kind,
        input.content_json,
        input.provider,
        input.model,
        input.prompt_version,
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

  async getById(id: number): Promise<AiInterpretation | null> {
    const row = await selectOne<AiInterpretationRow>(
      this.db,
      `SELECT * FROM ai_interpretations WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async getLatestByAttachment(
    attachmentId: number,
  ): Promise<AiInterpretation | null> {
    // 走 idx_ai_interp_attachment (attachment_id, kind) WHERE attachment_id IS NOT NULL
    const row = await selectOne<AiInterpretationRow>(
      this.db,
      `SELECT * FROM ai_interpretations
        WHERE attachment_id = ? AND kind = 'lab'
        ORDER BY created_at DESC
        LIMIT 1`,
      [attachmentId],
    );
    return row ? toEntity(row) : null;
  }

  async getLatestByMedicine(
    medicineId: number,
  ): Promise<AiInterpretation | null> {
    // 走 idx_ai_interp_medicine (medicine_id, kind) WHERE medicine_id IS NOT NULL
    const row = await selectOne<AiInterpretationRow>(
      this.db,
      `SELECT * FROM ai_interpretations
        WHERE medicine_id = ? AND kind = 'medication'
        ORDER BY created_at DESC
        LIMIT 1`,
      [medicineId],
    );
    return row ? toEntity(row) : null;
  }

  /**
   * lab_indicators 重跑时连带删 (invalidate 旧解读)。
   * useAiProcess.writeResults 在 reportIndicator.deleteByAttachment 前调,
   * 保证用户重跑 AI 处理后, 旧解读不会基于过时的指标。
   *
   * 无解读时 changes=0 也合法 (不抛 not-found), 与 delete(id) 语义不同。
   */
  async deleteByAttachment(attachmentId: number): Promise<void> {
    await executeWrite(
      this.db,
      `DELETE FROM ai_interpretations WHERE attachment_id = ? AND kind = 'lab'`,
      [attachmentId],
      'delete',
    );
  }

  /**
   * 一般不主动调 — medicine 删除时 FK ON DELETE CASCADE 已自动级联。
   * 保留方法是给应用层显式 invalidate 用 (如未来 medicine 改名清旧解读)。
   */
  async deleteByMedicine(medicineId: number): Promise<void> {
    await executeWrite(
      this.db,
      `DELETE FROM ai_interpretations WHERE medicine_id = ? AND kind = 'medication'`,
      [medicineId],
      'delete',
    );
  }
}
