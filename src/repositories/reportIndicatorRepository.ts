// ============================================================
// MedMemory — ReportIndicatorRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (ReportIndicatorRepository)
// 表: report_indicators（migration 002）
//
// 实现要点:
//   1. 整批语义: createBatch 一次写完整指标集, 不暴露单条 create
//   2. 重新生成: 应用层先 deleteByAttachment 再 createBatch
//      不在 createBatch 内自动 delete —— 让调用方显式控制 (避免意外吞数据)
//   3. display_order 由调用方排好, impl 直接绑入 INSERT (不重排)
//   4. SQLite 没有 batch INSERT RETURNING, 用循环 + RETURNING id 取回
//      (sqlite-wasm exec 不支持多语句返回多 id, 逐条稳)
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  LabIndicator,
  LabIndicatorCreateInput,
  ReportIndicatorRepository,
} from '@/repositories/interfaces';
import { executeWrite, selectMany } from '@/repositories/base';

interface LabIndicatorRow {
  id: number;
  attachment_id: number;
  name_cn: string;
  name_en: string | null;
  result: string;
  unit: string | null;
  reference_range: string | null;
  abnormal_tag: 'H' | 'L' | 'N' | null;
  display_order: number;
  model: string;
  prompt_version: string;
  created_at: string;
}

function toEntity(row: LabIndicatorRow): LabIndicator {
  return { ...row };
}

export class ReportIndicatorRepositoryImpl implements ReportIndicatorRepository {
  constructor(private readonly db: DbHandle) {}

  async createBatch(
    attachmentId: number,
    indicators: LabIndicatorCreateInput[],
  ): Promise<LabIndicator[]> {
    if (indicators.length === 0) return [];

    // 逐条 INSERT + 收集 id, 最后 listByAttachment 返回完整实体
    // (sqlite-wasm 不支持 multi-row RETURNING, 逐条最稳)
    for (let i = 0; i < indicators.length; i++) {
      const ind = indicators[i];
      await executeWrite(
        this.db,
        `INSERT INTO report_indicators (
            attachment_id, name_cn, name_en, result, unit,
            reference_range, abnormal_tag, display_order,
            model, prompt_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attachmentId,
          ind.name_cn,
          ind.name_en,
          ind.result,
          ind.unit,
          ind.reference_range,
          ind.abnormal_tag,
          ind.display_order,
          ind.model,
          ind.prompt_version,
        ],
        'create',
      );
    }

    return this.listByAttachment(attachmentId);
  }

  async listByAttachment(attachmentId: number): Promise<LabIndicator[]> {
    // 走 idx_report_indicators_attachment (attachment_id, display_order)
    const rows = await selectMany<LabIndicatorRow>(
      this.db,
      `SELECT * FROM report_indicators
        WHERE attachment_id = ?
        ORDER BY display_order ASC`,
      [attachmentId],
    );
    return rows.map(toEntity);
  }

  async deleteByAttachment(attachmentId: number): Promise<void> {
    // ON DELETE CASCADE 在 attachment 删除时自动触发, 此方法是"重新生成"场景显式调
    await executeWrite(
      this.db,
      `DELETE FROM report_indicators WHERE attachment_id = ?`,
      [attachmentId],
      'delete',
    );
    // 不检查 changes: attachment 可能本来就没有 indicators, delete 0 行不算错误
  }
}
