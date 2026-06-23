-- ============================================================
-- MedMemory — Migration 006: medical_events.next_visit_date
-- ============================================================
-- 对应 v3.3 触点扩展: 复诊提醒
--
-- 设计:
--   - 单列 nullable TEXT (YYYY-MM-DD), 不做时间/时区, MVP 够用
--   - 部分索引: 只索引有 next_visit_date 的行, listUpcomingFollowUps 走此索引
--   - 不新建 reminders 表: 自用 MVP 不需要 snooze/status/多类型, 编辑事件去掉日期即"完成"
--
-- 为什么挂在 medical_events 而非独立表:
--   - 复诊本质是某次就诊的后续, 与原事件强关联
--   - member_id / event_type 已在事件上, 不必重复
--   - Dashboard "待复诊" 查询: 单表 WHERE next_visit_date IS NOT NULL, 比 JOIN reminders 简单
--
-- 幂等性:
--   - 靠 schema_migrations 版本判断不重跑 (ALTER TABLE 无 IF NOT EXISTS 语法)
--   - 重置数据库场景: DROP 整库 → 001-006 顺序重建, 不会重复 ALTER
-- ============================================================

ALTER TABLE medical_events ADD COLUMN next_visit_date TEXT;  -- YYYY-MM-DD, 可空

CREATE INDEX IF NOT EXISTS idx_events_next_visit
  ON medical_events (next_visit_date)
  WHERE next_visit_date IS NOT NULL;

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (6);
