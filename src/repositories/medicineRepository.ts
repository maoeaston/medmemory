// ============================================================
// MedMemory — MedicineRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L372-390)
// 表: medicines（schema L168-182）
//
// 实现要点:
//   1. expiry_date 格式 YYYY-MM（不是 YYYY-MM-DD）—— listExpiring 用 strftime('%Y-%m', ...)
//      对齐, 保证 SQLite 字符串比较（按字符序）等价于年月顺序比较
//   2. listByUsage LIKE 模糊匹配 usage 字段（"发烧"→美林）
//   3. member_id 可空（家庭共用）, listByMember 走 idx_medicines_member
//   4. MedicineUpdateInput 排除 member_id（成员绑定后不通过 update 改）
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  Medicine,
  MedicineCreateInput,
  MedicineRepository,
  MedicineUpdateInput,
} from '@/repositories/interfaces';
import {
  buildUpdateQuery,
  executeInsertReturningId,
  executeWrite,
  RepositoryError,
  selectMany,
  selectOne,
} from '@/repositories/base';

const TABLE = 'medicines';

// MedicineUpdateInput 排除 member_id, 所以白名单不含 member_id
const ALLOWED_UPDATE_FIELDS = [
  'name',
  'usage',
  'expiry_date',
  'storage_location',
  'remark',
  'unit',
  'quantity',
] as const;

interface MedicineRow {
  id: number;
  name: string;
  usage: string | null;
  expiry_date: string | null; // YYYY-MM
  storage_location: string | null;
  remark: string | null;
  unit: string | null;
  quantity: number;
  member_id: number | null;
  photo_path: string | null;
  source_event_id: number | null;
  created_at: string;
  updated_at: string;
}

function toEntity(row: MedicineRow): Medicine {
  return { ...row };
}

export class MedicineRepositoryImpl implements MedicineRepository {
  constructor(private readonly db: DbHandle) {}

  async create(input: MedicineCreateInput): Promise<Medicine> {
    // photo_path / source_event_id 在 CreateInput 里强制为 null（第二阶段字段）
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO medicines (
        name, usage, expiry_date, storage_location, remark,
        member_id, photo_path, source_event_id, unit, quantity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.name,
        input.usage,
        input.expiry_date,
        input.storage_location,
        input.remark,
        input.member_id,
        input.photo_path ?? null,
        input.source_event_id ?? null,
        input.unit,
        input.quantity,
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

  async getById(id: number): Promise<Medicine | null> {
    const row = await selectOne<MedicineRow>(
      this.db,
      `SELECT * FROM medicines WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async update(id: number, input: MedicineUpdateInput): Promise<Medicine> {
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
      `DELETE FROM medicines WHERE id = ?`,
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }

  async listAll(): Promise<Medicine[]> {
    // 过期越近越靠前; 无 expiry_date 排到最后
    const rows = await selectMany<MedicineRow>(
      this.db,
      `SELECT * FROM medicines
        ORDER BY (expiry_date IS NULL), expiry_date ASC, name ASC`,
    );
    return rows.map(toEntity);
  }

  async listByMember(memberId: number): Promise<Medicine[]> {
    // 走 idx_medicines_member
    const rows = await selectMany<MedicineRow>(
      this.db,
      `SELECT * FROM medicines
        WHERE member_id = ?
        ORDER BY (expiry_date IS NULL), expiry_date ASC, name ASC`,
      [memberId],
    );
    return rows.map(toEntity);
  }

  async listByUsage(usageKeyword: string): Promise<Medicine[]> {
    // LIKE 默认大小写不敏感（ASCII）, 中文不受影响
    // 'usage LIKE '%' || ? || '%'': 关键词前后通配, 走 idx_medicines_usage 全表扫描
    // （LIKE '%X%' 无法用索引前缀, MVP 数据量可接受）
    const rows = await selectMany<MedicineRow>(
      this.db,
      `SELECT * FROM medicines
        WHERE usage LIKE '%' || ? || '%'
        ORDER BY name ASC`,
      [usageKeyword],
    );
    return rows.map(toEntity);
  }

  /**
   * 过期预警（Dashboard 高亮 + 药箱页）。
   *
   * @param withinDays 即将过期窗口（默认 30）; 已过期一定包含
   * @returns 按 expiry_date 升序（最快过期的在前）
   *
   * SQL 思路: expiry_date 是 YYYY-MM, 与 strftime('%Y-%m', date('now', '+N days')) 对齐。
   * SQLite 字符串比较与年月顺序比较等价（YYYY-MM 字典序 = 时间序）。
   */
  async listExpiring(withinDays: number = 30): Promise<Medicine[]> {
    // JS 先拼 modifier 字符串, 避免 SQL 里类型转换歧义
    const modifier = `+${withinDays} days`;
    const rows = await selectMany<MedicineRow>(
      this.db,
      `SELECT * FROM medicines
        WHERE expiry_date IS NOT NULL
          AND expiry_date <= strftime('%Y-%m', date('now', ?))
        ORDER BY expiry_date ASC`,
      [modifier],
    );
    return rows.map(toEntity);
  }
}
