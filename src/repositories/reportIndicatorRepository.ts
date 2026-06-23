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
  TrendPoint,
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

  /**
   * v3.3: 跨 attachment 按指标 name_en 查趋势。
   *
   * 利用 idx_report_indicators_name_en 索引（migration 002 为此查询专门建）。
   * JOIN attachments → medical_events → family_members 拿时间 + 成员名。
   *
   * 未归档附件（event_id 为 null）不参与——趋势图需要事件日期做 X 轴。
   */
  async listHistoryByNameEn(
    nameEn: string,
    filter?: { memberId?: number },
  ): Promise<TrendPoint[]> {
    const where = ['ri.name_en = ?', 'a.event_id IS NOT NULL'];
    const bind: unknown[] = [nameEn];
    if (filter?.memberId !== undefined) {
      where.push('me.member_id = ?');
      bind.push(filter.memberId);
    }
    const rows = await selectMany<
      LabIndicatorRow & {
        event_date: string;
        member_id: number;
        member_name: string;
        event_id: number;
      }
    >(
      this.db,
      `SELECT ri.*, me.event_date, me.member_id, fm.name AS member_name, me.id AS event_id
        FROM report_indicators ri
        JOIN attachments a ON ri.attachment_id = a.id
        JOIN medical_events me ON a.event_id = me.id
        JOIN family_members fm ON me.member_id = fm.id
        WHERE ${where.join(' AND ')}
        ORDER BY me.event_date ASC, ri.created_at ASC`,
      bind,
    );
    return rows.map((r) => {
      const { event_date, member_id, member_name, event_id, ...indicator } = r;
      return {
        indicator: toEntity(indicator),
        event_date,
        member_id,
        member_name,
        event_id,
      };
    });
  }

  /**
   * v3.3: TrendsView 下拉用。
   * GROUP BY name_en 聚合; MIN(name_cn) 取代表名（同名异写时取字典序首个, 稳定）。
   * 只返回有 name_en 的指标（趋势按 name_en 跨次比较）。
   */
  async listDistinctNames(): Promise<
    { name_en: string; name_cn: string; count: number }[]
  > {
    return selectMany<{ name_en: string; name_cn: string; count: number }>(
      this.db,
      `SELECT name_en, MIN(name_cn) AS name_cn, COUNT(*) AS count
        FROM report_indicators
        WHERE name_en IS NOT NULL AND name_en != ''
        GROUP BY name_en
        ORDER BY count DESC, name_cn ASC`,
    );
  }
}
