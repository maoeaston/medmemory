// ============================================================
// MedMemory — GrowthRecordRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (GrowthRecordRepository)
// 表: growth_records（migration 009）
//
// 实现要点:
//   1. age_months 不由调用方传, 而是在 create 时由 member.birthday × measured_date
//      派生 (getBirthday 查 family_members)。保证月龄永远是单一真相源。
//   2. update 不含 measured_date (类型层已排除), 故无需重算 age_months。
//      改测量日期请 delete + create。
//   3. listByMember 升序 (measured_date ASC), 直接喂给折线图。
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  GrowthRecord,
  GrowthRecordCreateInput,
  GrowthRecordRepository,
  GrowthRecordUpdateInput,
  GrowthSource,
} from '@/repositories/interfaces';
import {
  buildUpdateQuery,
  executeInsertReturningId,
  executeWrite,
  RepositoryError,
  selectMany,
  selectOne,
} from '@/repositories/base';
import { monthsBetween } from '@/lib/growth/age';

const TABLE = 'growth_records';

// 排除 member_id (创建后不可改) 与 measured_date/age_months (派生)
const ALLOWED_UPDATE_FIELDS = [
  'height_cm',
  'weight_kg',
  'head_cm',
  'note',
  'source',
  'source_event_id',
] as const;

interface GrowthRow {
  id: number;
  member_id: number;
  measured_date: string;
  age_months: number;
  height_cm: number | null;
  weight_kg: number | null;
  head_cm: number | null;
  note: string | null;
  source: GrowthSource;
  source_event_id: number | null;
  created_at: string;
  updated_at: string;
}

function toEntity(row: GrowthRow): GrowthRecord {
  return { ...row };
}

export class GrowthRepositoryImpl implements GrowthRecordRepository {
  constructor(private readonly db: DbHandle) {}

  /** 取成员生日用于派生 age_months; 无生日抛错 (生长记录强依赖月龄)。 */
  private async getBirthday(memberId: number): Promise<string> {
    const row = await selectOne<{ birthday: string | null }>(
      this.db,
      'SELECT birthday FROM family_members WHERE id = ?',
      [memberId],
    );
    if (!row || !row.birthday) {
      throw new RepositoryError(
        'create',
        TABLE,
        `member_id=${memberId} 缺少 birthday, 无法计算月龄`,
      );
    }
    return row.birthday;
  }

  async create(input: GrowthRecordCreateInput): Promise<GrowthRecord> {
    const birthday = await this.getBirthday(input.member_id);
    const ageMonths = monthsBetween(birthday, input.measured_date);
    if (ageMonths < 0) {
      throw new RepositoryError(
        'create',
        TABLE,
        `measured_date ${input.measured_date} 早于生日 ${birthday}`,
      );
    }
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO growth_records (
        member_id, measured_date, age_months, height_cm, weight_kg, head_cm,
        note, source, source_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.member_id,
        input.measured_date,
        ageMonths,
        input.height_cm,
        input.weight_kg,
        input.head_cm,
        input.note ?? null,
        input.source ?? 'home',
        input.source_event_id ?? null,
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

  async getById(id: number): Promise<GrowthRecord | null> {
    const row = await selectOne<GrowthRow>(
      this.db,
      'SELECT * FROM growth_records WHERE id = ?',
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async update(id: number, input: GrowthRecordUpdateInput): Promise<GrowthRecord> {
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
      'DELETE FROM growth_records WHERE id = ?',
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }

  async listByMember(memberId: number): Promise<GrowthRecord[]> {
    // measured_date 升序, 折线从左到右时间递增
    const rows = await selectMany<GrowthRow>(
      this.db,
      `SELECT * FROM growth_records
        WHERE member_id = ?
        ORDER BY measured_date ASC, id ASC`,
      [memberId],
    );
    return rows.map(toEntity);
  }

  async getLatestByMember(memberId: number): Promise<GrowthRecord | null> {
    const row = await selectOne<GrowthRow>(
      this.db,
      `SELECT * FROM growth_records
        WHERE member_id = ?
        ORDER BY measured_date DESC, id DESC LIMIT 1`,
      [memberId],
    );
    return row ? toEntity(row) : null;
  }
}
