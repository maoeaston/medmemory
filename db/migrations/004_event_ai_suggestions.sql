-- ============================================================
-- MedMemory — Migration 004: ai_contents 加 event_id 列
-- ============================================================
-- 对应 PRD 7.4 体验完善: 纯文本事件（无附件）AI 推荐健康问题
--
-- 改动:
--   ai_contents 加 event_id INTEGER (nullable) + FK ON DELETE CASCADE
--   新增 idx_ai_event 索引 (覆盖 WHERE event_id IS NOT NULL)
--
-- 为什么 ALTER TABLE ADD COLUMN:
--   003 用了"建新表 → 复制 → DROP → 改名"流程因为 SQLite 不支持 ALTER CHECK 约束;
--   004 只是加列, SQLite 原生支持 ADD COLUMN, 不需要重建表.
--   ADD COLUMN 限制: 新列要么 NULLABLE, 要么有 DEFAULT. event_id 选 NULLABLE
--   (纯文本推荐写 event_id, 附件推荐保持 attachment_id 不变, event_id=NULL).
--
-- 数据安全:
--   现有所有 ai_contents 行 event_id 自动为 NULL (旧行不受影响)
--   现有 FK (attachment_id) 不动
--   现有 idx_ai_attachment 不动
--
-- 幂等性:
--   ALTER TABLE 不支持 IF NOT EXISTS. 靠 schema_migrations 版本判断不重跑.
--   索引用 IF NOT EXISTS (CREATE INDEX 支持).
-- ============================================================

-- 1. 加 event_id 列 (nullable + FK)
ALTER TABLE ai_contents ADD COLUMN event_id INTEGER REFERENCES medical_events(id) ON DELETE CASCADE;

-- 2. 部分索引: 只索引有 event_id 的行 (省空间, 跳过旧行 + 附件推荐行)
CREATE INDEX IF NOT EXISTS idx_ai_event ON ai_contents (event_id, content_type) WHERE event_id IS NOT NULL;

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (4);
