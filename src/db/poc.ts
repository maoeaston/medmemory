// ============================================================
// MedMemory — sqlite-wasm + OPFS 最小 PoC（Demo 文件，不进生产路径）
// ============================================================
// 用途: 证明 sqlite-wasm 能加载、OPFS 能持久化、schema 能跑、外键 CASCADE 生效
// 使用方式:
//   1. npm run dev 后在浏览器 console 执行:
//      window.medmemoryPoc.runPoc()
//   2. 预期返回: { tablesCreated: 8, memberInserted: true, cascadeWorked: true, dbVersion: 1 }
//
// 注意: 此文件不自动执行（避免污染生产环境），需用户在 console 主动触发。
// ============================================================

import { getDb, getSchemaSql, type DbHandle } from '@/db/connection';

// ============================================================
// 结果类型
// ============================================================

export interface PocResult {
  /** 建表数量（8 张业务表，不含 schema_migrations） */
  tablesCreated: number;
  /** family_member 是否成功插入 */
  memberInserted: boolean;
  /** CASCADE 删除是否生效（删 member 后 event 是否被级联删） */
  cascadeWorked: boolean;
  /** schema_migrations.version 值 */
  dbVersion: number;
  /** 是否走 OPFS 持久化（false = 降级到 :memory:） */
  persistent: boolean;
}

// ============================================================
// 内部辅助
// ============================================================

/**
 * 统计 sqlite_master 中的业务表数量。
 * 8 张业务表: family_members, medical_events, inbox_items, health_problems,
 * event_problem_rel, attachments, ai_contents, medicines
 * （不含 schema_migrations、sqlite_% 系统表）
 */
async function countBusinessTables(db: DbHandle): Promise<number> {
  const resp = await db.exec(
    `SELECT count(*) as cnt
       FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name != 'schema_migrations'`,
    { rowMode: 'object', resultRows: [] },
  );

  const row = resp.result.resultRows?.[0] as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * 读取 schema_migrations.version。
 */
async function getDbVersion(db: DbHandle): Promise<number> {
  const resp = await db.exec(
    `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
    { rowMode: 'object', resultRows: [] },
  );

  const row = resp.result.resultRows?.[0] as { version: number } | undefined;
  return row?.version ?? 0;
}

// ============================================================
// 主函数：runPoc
// ============================================================

/**
 * 执行 PoC 全流程:
 *   1. 打开数据库
 *   2. 执行 001_initial.sql 建表
 *   3. 验证 schema_migrations 表存在且 version=1
 *   4. 插入 family_member + 关联 medical_event
 *   5. 验证 CASCADE（删 member 看 event 是否级联删）
 *   6. 返回结构化结果
 *
 * 幂等性: 建表 SQL 用 CREATE TABLE（无 IF NOT EXISTS），重复执行会报错。
 * 如需重跑，先 closeDb() 再重新打开，或清空 OPFS。
 */
export async function runPoc(): Promise<PocResult> {
  // --- Step 1: 打开数据库 ---
  const db = await getDb();

  // --- Step 2: 执行建表 SQL ---
  const schemaSql = getSchemaSql();
  try {
    await db.exec(schemaSql);
  } catch (err) {
    // 表已存在（重跑场景）——非致命，继续验证
    console.warn(
      '[PoC] 建表 SQL 执行出错（可能是表已存在，重跑场景正常）:',
      err,
    );
  }

  // --- Step 3a: 统计业务表数量 ---
  const tablesCreated = await countBusinessTables(db);

  // --- Step 3b: 验证 schema_migrations.version ---
  const dbVersion = await getDbVersion(db);

  // --- Step 4: 插入测试数据 ---
  // 先清理可能残留的测试数据（重跑场景）
  await db.exec(`DELETE FROM medical_events WHERE title = '[PoC] 测试事件'`);
  await db.exec(`DELETE FROM family_members WHERE name = '[PoC] 测试成员'`);

  // 插入 family_member
  await db.exec(
    `INSERT INTO family_members (name, nickname, birthday, gender)
     VALUES ('[PoC] 测试成员', 'PoC', '2000-01-01', 'other')`,
    { countChanges: true },
  );

  // 查回 member id
  const memberResp = await db.exec(
    `SELECT id FROM family_members WHERE name = '[PoC] 测试成员' LIMIT 1`,
    { rowMode: 'object', resultRows: [] },
  );
  const memberRow = memberResp.result.resultRows?.[0] as { id: number } | undefined;
  const memberId = memberRow?.id;

  if (memberId === undefined) {
    return {
      tablesCreated,
      memberInserted: false,
      cascadeWorked: false,
      dbVersion,
      persistent: db.isPersistent,
    };
  }

  // 插入关联 medical_event（event_date 用合法 YYYY-MM-DD, 不是占位符前缀）
  await db.exec(
    `INSERT INTO medical_events (member_id, event_date, title, event_type)
     VALUES (?, '2000-01-01', '[PoC] 测试事件', 'checkup')`,
    { bind: [memberId] },
  );

  // 确认 event 存在
  const eventBeforeResp = await db.exec(
    `SELECT count(*) as cnt FROM medical_events WHERE member_id = ?`,
    { bind: [memberId], rowMode: 'object', resultRows: [] },
  );
  const eventBeforeRow = eventBeforeResp.result.resultRows?.[0] as { cnt: number } | undefined;
  const memberInserted = (eventBeforeRow?.cnt ?? 0) > 0;

  // --- Step 5: CASCADE 验证 ---
  // 删除 member，检查 event 是否被级联删除
  await db.exec(`DELETE FROM family_members WHERE id = ?`, { bind: [memberId] });

  // event 应已被 CASCADE 删除（member_id 不再存在）
  // 用一个不可能的 member_id 查（原 memberId 已删）
  const orphanCheckResp = await db.exec(
    `SELECT count(*) as cnt FROM medical_events WHERE member_id = ?`,
    { bind: [memberId], rowMode: 'object', resultRows: [] },
  );
  const orphanRow = orphanCheckResp.result.resultRows?.[0] as { cnt: number } | undefined;
  const orphanCount = orphanRow?.cnt;
  // cascadeWorked: event 行数为 0 表示被级联删除；undefined 表示查询异常
  const cascadeWorked = orphanCount === 0;

  // 清理：删除可能残留的 PoC event（外键已断）
  await db.exec(`DELETE FROM medical_events WHERE title = '[PoC] 测试事件'`);

  // --- Step 6: 返回结果 ---
  return {
    tablesCreated,
    memberInserted,
    cascadeWorked,
    dbVersion,
    persistent: db.isPersistent,
  };
}

// ============================================================
// Dev-only: 挂载到 window
// ============================================================

/**
 * 将 runPoc 挂载到 window.medmemoryPoc，仅 dev 模式。
 * 用户在浏览器 console 执行 window.medmemoryPoc.runPoc() 验证。
 */
export function wirePocToWindow(): void {
  // import.meta.env?.DEV —— Vite dev 模式为 true，build 后为 false
  // 用可选链防止非 Vite 环境（如纯 tsc）报错
  if (!import.meta.env?.DEV) {
    return;
  }

  // 挂载到 window 供 console 调用
  const w = window as unknown as {
    medmemoryPoc?: { runPoc: typeof runPoc };
  };
  w.medmemoryPoc = { runPoc };
}
