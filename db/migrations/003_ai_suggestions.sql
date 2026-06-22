-- ============================================================
-- MedMemory — Migration 003: ai_contents.content_type 扩展
-- ============================================================
-- 对应 PRD 7.4 v3.1: AI 辅助健康问题关联
--
-- 改动:
--   ai_contents.content_type CHECK 约束加 'suggested_health_problems'
--   用于存储 AI 推荐的健康问题, 每个 suggestion 一条记录, 用户确认/跳过后删除
--
-- 为什么重建表:
--   SQLite 不支持 ALTER TABLE 修改 CHECK 约束, 必须走
--   "建新表 → 复制 → DROP 旧 → 改名 → 重建索引" 流程
--
-- 数据安全:
--   保留所有字段定义 (id/attachment_id/model/prompt_version/content/created_at)
--   保留 FK ON DELETE CASCADE
--   保留 idx_ai_attachment 索引
--
-- 幂等性:
--   非幂等 (DROP TABLE), 靠 schema_migrations 版本判断不重跑
--   不用 IF NOT EXISTS — 重建场景下新表必须建立
-- ============================================================

-- 1. 新建 ai_contents_new, CHECK 加 'suggested_health_problems'
CREATE TABLE ai_contents_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id  INTEGER NOT NULL,
    content_type   TEXT    NOT NULL CHECK (content_type IN ('summary', 'ocr_fulltext', 'suggested_health_problems')),
    model          TEXT    NOT NULL,
    prompt_version TEXT    NOT NULL,
    content        TEXT    NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

-- 2. 复制所有现有数据
INSERT INTO ai_contents_new (id, attachment_id, content_type, model, prompt_version, content, created_at)
SELECT id, attachment_id, content_type, model, prompt_version, content, created_at FROM ai_contents;

-- 3. DROP 旧表
DROP TABLE ai_contents;

-- 4. 改名
ALTER TABLE ai_contents_new RENAME TO ai_contents;

-- 5. 重建索引 (DROP TABLE 已自动删索引, 这里重新建)
CREATE INDEX IF NOT EXISTS idx_ai_attachment ON ai_contents (attachment_id, content_type, created_at DESC);

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (3);
