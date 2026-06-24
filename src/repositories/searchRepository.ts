// ============================================================
// MedMemory — SearchRepository 实现（LIKE，非 FTS）
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L411-421)
// 跨表 JOIN: ai_contents → attachments → medical_events → family_members
//
// 实现要点:
//   1. 在 ai_contents.content (content_type='ocr_fulltext') 上做 LIKE 模糊匹配
//   2. LEFT JOIN medical_events 和 family_members —— 未归档附件可能 event_id 为 null
//   3. snippet 用 substr + instr 取关键词附近 200 字符（找不到关键词返回从头截取）
//   4. keyword 在 SQL 中出现两次: LIKE 匹配 + instr 定位。都用 bind 参数
//   5. SQLite LIKE 默认 ASCII 大小写不敏感, 中文不受影响
//   6. MVP 不分页, 硬上限 LIMIT 50（避免超大结果集阻塞 UI）
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  Attachment,
  FamilyMember,
  MedicalEvent,
  SearchFilter,
  SearchRepository,
  SearchResult,
} from '@/repositories/interfaces';
import {
  fromDbBoolean,
  readJsonArray,
  selectMany,
} from '@/repositories/base';

/**
 * 联合查询的原始行形状（每个字段加表前缀避免列名冲突）。
 *
 * 注意: 所有列必须显式列出, SELECT * 在多表 JOIN 下会有列名冲突。
 */
interface SearchRow {
  // attachment 字段（前缀 a_）
  a_id: number;
  a_event_id: number | null;
  a_file_name: string;
  a_file_type: 'jpg' | 'png' | 'pdf';
  a_storage_key: string;
  a_doc_type: Attachment['doc_type'];
  a_subtype: string | null;
  a_tags: string | null;
  a_processing_status: Attachment['processing_status'];
  a_processing_error: string | null;
  a_ai_generated: number;
  a_created_at: string;

  // ai_content 字段（前缀 ac_）
  _snippet: string;

  // medical_event 字段（前缀 me_, 可能全 null）
  me_id: number | null;
  me_member_id: number | null;
  me_event_date: string | null;
  me_hospital: string | null;
  me_department: string | null;
  me_title: string | null;
  me_event_type: MedicalEvent['event_type'] | null;
  me_summary: string | null;
  me_next_visit_date: string | null;
  me_created_at: string | null;
  me_updated_at: string | null;

  // family_member 字段（前缀 fm_, 可能全 null）
  fm_id: number | null;
  fm_name: string | null;
  fm_nickname: string | null;
  fm_birthday: string | null;
  fm_gender: FamilyMember['gender'];
  fm_allergies: string | null;
  fm_chronic_conditions: string | null;
  fm_current_medications: string | null;
  fm_remark: string | null;
  fm_created_at: string | null;
  fm_updated_at: string | null;
}

/** 把拍平的行还原成结构化 SearchResult */
function toSearchResult(row: SearchRow): SearchResult {
  const attachment: Attachment = {
    id: row.a_id,
    event_id: row.a_event_id,
    file_name: row.a_file_name,
    file_type: row.a_file_type,
    storage_key: row.a_storage_key,
    doc_type: row.a_doc_type,
    subtype: row.a_subtype,
    tags: readJsonArray<string>(row.a_tags, []),
    processing_status: row.a_processing_status,
    processing_error: row.a_processing_error,
    ai_generated: fromDbBoolean(row.a_ai_generated),
    created_at: row.a_created_at,
  };

  // event 为 null 的场景: 附件未归档（event_id 为 null）或 event 已被 CASCADE 删
  const event: MedicalEvent | null =
    row.me_id === null
      ? null
      : {
          id: row.me_id,
          member_id: row.me_member_id as number,
          event_date: row.me_event_date as string,
          hospital: row.me_hospital,
          department: row.me_department,
          title: row.me_title as string,
          event_type: row.me_event_type as MedicalEvent['event_type'],
          summary: row.me_summary,
          next_visit_date: row.me_next_visit_date,
          created_at: row.me_created_at as string,
          updated_at: row.me_updated_at as string,
        };

  // member 为 null 的场景: event 为 null 或 event 的 member 被删
  const member: FamilyMember | null =
    row.fm_id === null
      ? null
      : {
          id: row.fm_id,
          name: row.fm_name as string,
          nickname: row.fm_nickname,
          birthday: row.fm_birthday,
          gender: row.fm_gender,
          allergies: readJsonArray(row.fm_allergies, []),
          chronic_conditions: readJsonArray(row.fm_chronic_conditions, []),
          current_medications: readJsonArray(row.fm_current_medications, []),
          remark: row.fm_remark,
          created_at: row.fm_created_at as string,
          updated_at: row.fm_updated_at as string,
        };

  return {
    attachment,
    snippet: row._snippet,
    event,
    member,
  };
}

export class SearchRepositoryImpl implements SearchRepository {
  constructor(private readonly db: DbHandle) {}

  async searchByKeyword(
    keyword: string,
    filter?: SearchFilter,
  ): Promise<SearchResult[]> {
    const where: string[] = [
      `ac.content_type = 'ocr_fulltext'`,
      `ac.content LIKE '%' || ? || '%'`,
    ];
    // keyword 给 LIKE 用一次, 给 instr 再用一次（位置对齐）
    const bind: unknown[] = [keyword];

    if (filter?.memberId !== undefined) {
      where.push('me.member_id = ?');
      bind.push(filter.memberId);
    }
    if (filter?.from !== undefined) {
      where.push('me.event_date >= ?');
      bind.push(filter.from);
    }
    if (filter?.to !== undefined) {
      where.push('me.event_date <= ?');
      bind.push(filter.to);
    }

    const sql = `
      SELECT
        a.id AS a_id, a.event_id AS a_event_id, a.file_name AS a_file_name,
        a.file_type AS a_file_type, a.storage_key AS a_storage_key,
        a.doc_type AS a_doc_type, a.subtype AS a_subtype, a.tags AS a_tags,
        a.processing_status AS a_processing_status, a.processing_error AS a_processing_error,
        a.ai_generated AS a_ai_generated, a.created_at AS a_created_at,

        substr(ac.content,
               max(1, instr(ac.content, ?) - 50),
               200) AS _snippet,

        me.id AS me_id, me.member_id AS me_member_id, me.event_date AS me_event_date,
        me.hospital AS me_hospital, me.department AS me_department,
        me.title AS me_title, me.event_type AS me_event_type, me.summary AS me_summary,
        me.next_visit_date AS me_next_visit_date,
        me.created_at AS me_created_at, me.updated_at AS me_updated_at,

        fm.id AS fm_id, fm.name AS fm_name, fm.nickname AS fm_nickname,
        fm.birthday AS fm_birthday, fm.gender AS fm_gender,
        fm.allergies AS fm_allergies, fm.chronic_conditions AS fm_chronic_conditions,
        fm.current_medications AS fm_current_medications, fm.remark AS fm_remark,
        fm.created_at AS fm_created_at, fm.updated_at AS fm_updated_at
      FROM ai_contents ac
      JOIN attachments a ON a.id = ac.attachment_id
      LEFT JOIN medical_events me ON me.id = a.event_id
      LEFT JOIN family_members fm ON fm.id = me.member_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT 50`;

    // instr 参数插在 attachment 字段之后、filter 参数之前
    // 实际位置: SQL 中 ? 出现的顺序
    //   1. LIKE 的 keyword
    //   2. instr 的 keyword
    //   3..N: filter 参数
    const fullBind = [bind[0], keyword, ...bind.slice(1)];

    const rows = await selectMany<SearchRow>(this.db, sql, fullBind);
    return rows.map(toSearchResult);
  }

  async listRecent(
    limit: number,
    filter?: SearchFilter,
  ): Promise<SearchResult[]> {
    // 与 searchByKeyword 同一张 JOIN, 区别:
    //   - WHERE 只过滤 content_type + filter（无 LIKE）
    //   - snippet: substr(ac.content, 1, 200)（无关键词锚点, 从头截取）
    //   - ORDER BY ac.created_at DESC（OCR 处理时间倒序, 非 attachment 创建时间）
    const where: string[] = [`ac.content_type = 'ocr_fulltext'`];
    const bind: unknown[] = [];

    if (filter?.memberId !== undefined) {
      where.push('me.member_id = ?');
      bind.push(filter.memberId);
    }
    if (filter?.from !== undefined) {
      where.push('me.event_date >= ?');
      bind.push(filter.from);
    }
    if (filter?.to !== undefined) {
      where.push('me.event_date <= ?');
      bind.push(filter.to);
    }

    const sql = `
      SELECT
        a.id AS a_id, a.event_id AS a_event_id, a.file_name AS a_file_name,
        a.file_type AS a_file_type, a.storage_key AS a_storage_key,
        a.doc_type AS a_doc_type, a.subtype AS a_subtype, a.tags AS a_tags,
        a.processing_status AS a_processing_status, a.processing_error AS a_processing_error,
        a.ai_generated AS a_ai_generated, a.created_at AS a_created_at,

        substr(ac.content, 1, 200) AS _snippet,

        me.id AS me_id, me.member_id AS me_member_id, me.event_date AS me_event_date,
        me.hospital AS me_hospital, me.department AS me_department,
        me.title AS me_title, me.event_type AS me_event_type, me.summary AS me_summary,
        me.next_visit_date AS me_next_visit_date,
        me.created_at AS me_created_at, me.updated_at AS me_updated_at,

        fm.id AS fm_id, fm.name AS fm_name, fm.nickname AS fm_nickname,
        fm.birthday AS fm_birthday, fm.gender AS fm_gender,
        fm.allergies AS fm_allergies, fm.chronic_conditions AS fm_chronic_conditions,
        fm.current_medications AS fm_current_medications, fm.remark AS fm_remark,
        fm.created_at AS fm_created_at, fm.updated_at AS fm_updated_at
      FROM ai_contents ac
      JOIN attachments a ON a.id = ac.attachment_id
      LEFT JOIN medical_events me ON me.id = a.event_id
      LEFT JOIN family_members fm ON fm.id = me.member_id
      WHERE ${where.join(' AND ')}
      ORDER BY ac.created_at DESC
      LIMIT ?`;

    const rows = await selectMany<SearchRow>(this.db, sql, [...bind, limit]);
    return rows.map(toSearchResult);
  }
}
