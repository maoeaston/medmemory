// ============================================================
// MedMemory — MedicalEventRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L232-252)
// 表: medical_events（schema L43-56）
//
// 实现要点:
//   1. listByMember 的 range 过滤动态拼 WHERE（from/to 都可选）
//      —— 值一律走 bind 参数, 避免 SQL 注入
//   2. findLatestByMember 用 idx_events_member_date 索引（member_id, event_date DESC）
//   3. listRecent 跨成员按 created_at 倒序（最近录入, 不是最近发生）
//   4. 无 JSON 字段, 实现比 family_members 更简单
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  EventType,
  MedicalEvent,
  MedicalEventCreateInput,
  MedicalEventRepository,
  MedicalEventUpdateInput,
} from '@/repositories/interfaces';
import {
  buildUpdateQuery,
  executeInsertReturningId,
  executeWrite,
  RepositoryError,
  selectMany,
  selectOne,
} from '@/repositories/base';

const TABLE = 'medical_events';

const ALLOWED_UPDATE_FIELDS = [
  'member_id',
  'event_date',
  'hospital',
  'department',
  'title',
  'event_type',
  'summary',
] as const;

interface MedicalEventRow {
  id: number;
  member_id: number;
  event_date: string;
  hospital: string | null;
  department: string | null;
  title: string;
  event_type: EventType;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

function toEntity(row: MedicalEventRow): MedicalEvent {
  return { ...row };
}

export class MedicalEventRepositoryImpl implements MedicalEventRepository {
  constructor(private readonly db: DbHandle) {}

  async create(input: MedicalEventCreateInput): Promise<MedicalEvent> {
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO medical_events (
        member_id, event_date, hospital, department, title, event_type, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.member_id,
        input.event_date,
        input.hospital,
        input.department,
        input.title,
        input.event_type,
        input.summary,
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

  async getById(id: number): Promise<MedicalEvent | null> {
    const row = await selectOne<MedicalEventRow>(
      this.db,
      `SELECT * FROM medical_events WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async update(id: number, input: MedicalEventUpdateInput): Promise<MedicalEvent> {
    const { sql, bind } = buildUpdateQuery({
      table: TABLE,
      allowedFields: ALLOWED_UPDATE_FIELDS,
      input: input as Record<string, unknown>,
      whereClause: 'id = ?',
      whereBind: [id],
    });

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

  async delete(id: number): Promise<void> {
    const changes = await executeWrite(
      this.db,
      `DELETE FROM medical_events WHERE id = ?`,
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }

  /**
   * 成员事件列表, 支持日期范围过滤。
   *
   * 走 idx_events_member_date（member_id, event_date DESC）。
   * range 值走 bind 参数, WHERE 子句动态拼接（字段名硬编码, 安全）。
   */
  async listByMember(
    memberId: number,
    range?: { from?: string; to?: string },
  ): Promise<MedicalEvent[]> {
    const where: string[] = ['member_id = ?'];
    const bind: unknown[] = [memberId];

    if (range?.from !== undefined) {
      where.push('event_date >= ?');
      bind.push(range.from);
    }
    if (range?.to !== undefined) {
      where.push('event_date <= ?');
      bind.push(range.to);
    }

    const sql = `SELECT * FROM medical_events WHERE ${where.join(' AND ')} ORDER BY event_date DESC`;
    const rows = await selectMany<MedicalEventRow>(this.db, sql, bind);
    return rows.map(toEntity);
  }

  async findLatestByMember(
    memberId: number,
    eventType: EventType,
  ): Promise<MedicalEvent | null> {
    const row = await selectOne<MedicalEventRow>(
      this.db,
      `SELECT * FROM medical_events
        WHERE member_id = ? AND event_type = ?
        ORDER BY event_date DESC
        LIMIT 1`,
      [memberId, eventType],
    );
    return row ? toEntity(row) : null;
  }

  async listRecent(limit: number): Promise<MedicalEvent[]> {
    // 跨成员最近事件: 按 created_at 倒序（最近录入, 不是最近发生）
    // 用 created_at 因为 Dashboard 底部"最近事件"的语义是"最近录入的更新"
    const rows = await selectMany<MedicalEventRow>(
      this.db,
      `SELECT * FROM medical_events ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(toEntity);
  }
}
