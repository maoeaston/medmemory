// ============================================================
// MedMemory — HealthProblemRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L275-295)
// 表: health_problems（schema L84-96）
//
// 实现要点:
//   1. 有 updated_at 字段（走 buildUpdateQuery 默认 withUpdatedAt=true）
//   2. status DEFAULT 'active'（HealthProblemCreateInput.status 可选）
//   3. findOrCreate: 先 findByName 再 create。无事务保护, 并发调用可能产生重名
//      MVP 接受（家庭场景单用户）; 真正并发风险来时再加 UNIQUE 约束 + 事务
//   4. PRD 7.4 明确 "MVP 不做手工 CRUD", create/update 主要由 AI 推荐 + 一键确认调用
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  HealthProblem,
  HealthProblemCreateInput,
  HealthProblemRepository,
  HealthProblemStatus,
  HealthProblemUpdateInput,
} from '@/repositories/interfaces';
import {
  buildUpdateQuery,
  executeInsertReturningId,
  executeWrite,
  RepositoryError,
  selectMany,
  selectOne,
} from '@/repositories/base';

const TABLE = 'health_problems';

const ALLOWED_UPDATE_FIELDS = [
  'name',
  'status',
  'started_date',
  'ended_date',
  'note',
] as const;

interface HealthProblemRow {
  id: number;
  member_id: number;
  name: string;
  status: HealthProblemStatus;
  started_date: string | null;
  ended_date: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function toEntity(row: HealthProblemRow): HealthProblem {
  return { ...row };
}

export class HealthProblemRepositoryImpl implements HealthProblemRepository {
  constructor(private readonly db: DbHandle) {}

  async create(input: HealthProblemCreateInput): Promise<HealthProblem> {
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO health_problems (
        member_id, name, status, started_date, ended_date, note
      ) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.member_id,
        input.name,
        input.status ?? 'active', // DEFAULT 兜底（TS 层显式传, 防止 NULL）
        input.started_date,
        input.ended_date,
        input.note,
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

  async getById(id: number): Promise<HealthProblem | null> {
    const row = await selectOne<HealthProblemRow>(
      this.db,
      `SELECT * FROM health_problems WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async update(
    id: number,
    input: HealthProblemUpdateInput,
  ): Promise<HealthProblem> {
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
      `DELETE FROM health_problems WHERE id = ?`,
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
  }

  async listByMember(memberId: number): Promise<HealthProblem[]> {
    // 走 idx_problems_member（member_id, status）
    // 排序: active 在前, chronic 次之, resolved 最后; 同状态按 updated_at 倒序
    const rows = await selectMany<HealthProblemRow>(
      this.db,
      `SELECT * FROM health_problems
        WHERE member_id = ?
        ORDER BY CASE status
                   WHEN 'active'   THEN 0
                   WHEN 'chronic'  THEN 1
                   WHEN 'resolved' THEN 2
                 END,
                 updated_at DESC`,
      [memberId],
    );
    return rows.map(toEntity);
  }

  async findByName(
    memberId: number,
    name: string,
  ): Promise<HealthProblem | null> {
    const row = await selectOne<HealthProblemRow>(
      this.db,
      `SELECT * FROM health_problems
        WHERE member_id = ? AND name = ?
        LIMIT 1`,
      [memberId, name],
    );
    return row ? toEntity(row) : null;
  }

  /**
   * 一键确认的"新建"分支: 存在则返回, 不存在则建。
   *
   * 无事务保护: 并发调用同一 (memberId, name) 可能产生重名行。
   * 家庭场景单用户无并发风险; 真正并发时 schema 加 UNIQUE(member_id, name)
   * + 此处用 INSERT OR IGNORE + 重新 findByName 兜底。
   */
  async findOrCreate(
    memberId: number,
    name: string,
  ): Promise<HealthProblem> {
    const existing = await this.findByName(memberId, name);
    if (existing !== null) {
      return existing;
    }
    return this.create({
      member_id: memberId,
      name,
      status: 'active',
      started_date: null,
      ended_date: null,
      note: null,
    });
  }
}
