// ============================================================
// MedMemory — EventProblemRelRepository 实现
// ============================================================
// 对应接口: src/repositories/interfaces.ts (L302-314)
// 表: event_problem_rel（schema L103-109）, 复合主键 (event_id, problem_id)
//
// 实现要点:
//   1. attach/detach 用 INSERT OR IGNORE / DELETE, 幂等（重复 attach 不报错）
//   2. attachBatch 循环调 attach; 当前 DbHandle 无事务 API, 部分失败留残留
//      TODO: 后续单开 task 加 DbHandle.transaction(), 届时改单事务
//   3. listProblemsByEvent / listEventsByProblem 是 JOIN 查询, 返回对端实体
//   4. 复合主键保证 (event_id, problem_id) 唯一, attach 用 INSERT OR IGNORE 避免重复键报错
// ============================================================

import type { DbHandle } from '@/db/connection';
import type {
  EventProblemRelRepository,
  HealthProblem,
  MedicalEvent,
} from '@/repositories/interfaces';
import { executeWrite, selectMany } from '@/repositories/base';

export class EventProblemRelRepositoryImpl implements EventProblemRelRepository {
  constructor(private readonly db: DbHandle) {}

  /**
   * 单条关联。
   * 幂等: INSERT OR IGNORE 忽略重复键冲突, 不抛错。
   */
  async attach(eventId: number, problemId: number): Promise<void> {
    await executeWrite(
      this.db,
      `INSERT OR IGNORE INTO event_problem_rel (event_id, problem_id) VALUES (?, ?)`,
      [eventId, problemId],
      'create',
    );
  }

  /**
   * 批量关联。
   *
   * TODO（事务缺失风险）: 当前逐条 exec, 部分失败会留下已 attach 的行。
   * DbHandle 暴露 transaction API 后, 改为单事务包裹。
   * 家庭场景单用户 + problem 数量有限（<20）, MVP 风险可接受;
   * Domain 层重试时可用 detach 清理残留, 或显式 attachBatch 再调一次（幂等）。
   */
  async attachBatch(eventId: number, problemIds: number[]): Promise<void> {
    if (problemIds.length === 0) return;
    for (const problemId of problemIds) {
      await this.attach(eventId, problemId);
    }
  }

  async detach(eventId: number, problemId: number): Promise<void> {
    // 幂等: DELETE 不存在的行不报错
    await executeWrite(
      this.db,
      `DELETE FROM event_problem_rel WHERE event_id = ? AND problem_id = ?`,
      [eventId, problemId],
      'delete',
    );
  }

  async listProblemsByEvent(eventId: number): Promise<HealthProblem[]> {
    // JOIN health_problems, 按 status 排序便于 UI 高亮进行中的
    const rows = await selectMany<HealthProblem>(
      this.db,
      `SELECT hp.*
         FROM event_problem_rel epr
         JOIN health_problems hp ON hp.id = epr.problem_id
        WHERE epr.event_id = ?
        ORDER BY CASE hp.status
                   WHEN 'active'   THEN 0
                   WHEN 'chronic'  THEN 1
                   WHEN 'resolved' THEN 2
                 END,
                 hp.updated_at DESC`,
      [eventId],
    );
    return rows;
  }

  async listEventsByProblem(problemId: number): Promise<MedicalEvent[]> {
    // JOIN medical_events, 按 event_date 倒序（时间线视图 B: 最近的事件在前）
    const rows = await selectMany<MedicalEvent>(
      this.db,
      `SELECT me.*
         FROM event_problem_rel epr
         JOIN medical_events me ON me.id = epr.event_id
        WHERE epr.problem_id = ?
        ORDER BY me.event_date DESC`,
      [problemId],
    );
    return rows;
  }
}
