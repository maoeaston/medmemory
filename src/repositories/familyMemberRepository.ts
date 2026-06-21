// ============================================================
// MedMemory — FamilyMemberRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L219-226)
// 表: family_members（schema L25-37）
//
// 实现要点:
//   1. create 用 INSERT ... RETURNING id 拿自增 PK, 再 getById 返回完整 entity
//   2. update 前先序列化 JSON 字段（allergies/chronic_conditions/current_medications）
//      buildUpdateQuery 会强制注入 updated_at（family_members 有此字段）
//   3. delete 返回 0 行视为 not-found 抛错（PRD 约定: 写入失败抛 Error）
//   4. CASCADE 级联由外键处理（medical_events/health_problems 自动删）
//
// 此文件同时作为后续 7 个 Repository 的实现模板。
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  Allergy,
  ChronicCondition,
  FamilyMember,
  FamilyMemberCreateInput,
  FamilyMemberRepository,
  FamilyMemberUpdateInput,
} from '@/repositories/interfaces';
import {
  buildUpdateQuery,
  executeInsertReturningId,
  executeWrite,
  readJsonArray,
  RepositoryError,
  selectMany,
  selectOne,
  writeJsonArray,
} from '@/repositories/base';

const TABLE = 'family_members';

/**
 * 允许 update 的字段白名单。
 * 与 schema 列一一对应, 排除 id/created_at/updated_at（由实现层控制）。
 * 编译期常量, 防止用户输入字段名注入 SQL。
 */
const ALLOWED_UPDATE_FIELDS = [
  'name',
  'nickname',
  'birthday',
  'gender',
  'allergies',
  'chronic_conditions',
  'current_medications',
  'remark',
] as const;

/**
 * SQLite 直接返回的原始行形状（JSON 字段还是 TEXT）。
 * toEntity 负责将其转成强类型 FamilyMember。
 */
interface FamilyMemberRow {
  id: number;
  name: string;
  nickname: string | null;
  birthday: string | null;
  gender: 'male' | 'female' | 'other' | null;
  allergies: string | null; // JSON TEXT
  chronic_conditions: string | null; // JSON TEXT
  current_medications: string | null; // JSON TEXT
  remark: string | null;
  created_at: string;
  updated_at: string;
}

/** Row → Entity: JSON 字段反序列化, NULL 数组兜底为 [] */
function toEntity(row: FamilyMemberRow): FamilyMember {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname,
    birthday: row.birthday,
    gender: row.gender,
    allergies: readJsonArray<Allergy>(row.allergies, []),
    chronic_conditions: readJsonArray<ChronicCondition>(row.chronic_conditions, []),
    current_medications: readJsonArray<string>(row.current_medications, []),
    remark: row.remark,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * FamilyMemberRepository 的 sqlite-wasm 实现。
 *
 * 使用方式:
 * ```ts
 * const db = await getDb();
 * const repo = new FamilyMemberRepositoryImpl(db);
 * const member = await repo.create({ name: '张三', ... });
 * ```
 *
 * 不持有可变状态, 构造后 dbId 由 DbHandle 单例保证一致。
 */
export class FamilyMemberRepositoryImpl implements FamilyMemberRepository {
  constructor(private readonly db: DbHandle) {}

  async create(input: FamilyMemberCreateInput): Promise<FamilyMember> {
    const id = await executeInsertReturningId(
      this.db,
      `INSERT INTO family_members (
        name, nickname, birthday, gender,
        allergies, chronic_conditions, current_medications, remark
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        input.name,
        input.nickname,
        input.birthday,
        input.gender,
        writeJsonArray(input.allergies),
        writeJsonArray(input.chronic_conditions),
        writeJsonArray(input.current_medications),
        input.remark,
      ],
    );
    if (id === null) {
      throw new RepositoryError('create', TABLE, 'INSERT RETURNING 未返回 id');
    }
    const created = await this.getById(id);
    if (created === null) {
      throw new RepositoryError(
        'create',
        TABLE,
        `id=${id} 在 INSERT 后立刻查不到（数据一致性问题）`,
      );
    }
    return created;
  }

  async getById(id: number): Promise<FamilyMember | null> {
    const row = await selectOne<FamilyMemberRow>(
      this.db,
      `SELECT * FROM family_members WHERE id = ?`,
      [id],
    );
    return row ? toEntity(row) : null;
  }

  async list(): Promise<FamilyMember[]> {
    // 按 updated_at 倒序: Dashboard 首屏优先显示最近编辑的成员
    const rows = await selectMany<FamilyMemberRow>(
      this.db,
      `SELECT * FROM family_members ORDER BY updated_at DESC`,
    );
    return rows.map(toEntity);
  }

  async update(id: number, input: FamilyMemberUpdateInput): Promise<FamilyMember> {
    // JSON 字段先序列化, 再交给 buildUpdateQuery 拼占位符
    // （buildUpdateQuery 的白名单只认字段名, 不处理值类型）
    const prepared: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (
        k === 'allergies' ||
        k === 'chronic_conditions' ||
        k === 'current_medications'
      ) {
        prepared[k] = writeJsonArray(v as unknown[]);
      } else {
        prepared[k] = v;
      }
    }

    const { sql, bind } = buildUpdateQuery({
      table: TABLE,
      allowedFields: ALLOWED_UPDATE_FIELDS,
      input: prepared,
      whereClause: 'id = ?',
      whereBind: [id],
      // withUpdatedAt 默认 true: family_members 有 updated_at 字段
    });

    const changes = await executeWrite(this.db, sql, bind, 'update');
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }

    const updated = await this.getById(id);
    if (updated === null) {
      throw new RepositoryError(
        'not-found',
        TABLE,
        `id=${id} 在 UPDATE 后立刻查不到（数据一致性问题）`,
      );
    }
    return updated;
  }

  async delete(id: number): Promise<void> {
    const changes = await executeWrite(
      this.db,
      `DELETE FROM family_members WHERE id = ?`,
      [id],
      'delete',
    );
    if (changes === 0) {
      throw new RepositoryError('not-found', TABLE, `id=${id} 不存在`);
    }
    // CASCADE 级联: medical_events / health_problems 由 SQLite 外键自动删除
    // （schema L55: ON DELETE CASCADE）
  }
}
