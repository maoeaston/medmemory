-- ============================================================
-- MedMemory — Migration 007: ai_contents.attachment_id 放宽为 nullable
-- ============================================================
-- 修复 bug: 纯文本事件 AI 推荐（useAiProcess.processTextEventSuggestions）
--   写 ai_contents(attachment_id=NULL, event_id=X) 时撞 SQLITE_CONSTRAINT_NOTNULL.
--
-- 根因:
--   migration 004 加了 event_id 列支持"无附件事件也能存 AI 推荐",
--   但没同步放宽 attachment_id 的 NOT NULL 约束. 004 注释说
--   "纯文本推荐写 event_id, 附件推荐保持 attachment_id 不变, event_id=NULL"
--   实际代码（useAiProcess L215）是 attachment_id=NULL, event_id=eventId,
--   与 schema NOT NULL 冲突.
--
-- 改动:
--   1. ai_contents 重建, attachment_id 改 nullable
--   2. 加 CHECK (attachment_id IS NOT NULL OR event_id IS NOT NULL)
--      —— 强制"至少一个外键", 避免全 NULL 的孤儿记录
--   3. 保留 content_type CHECK (含 'suggested_health_problems', 自 003)
--   4. 保留 FK ON DELETE CASCADE (attachment_id + event_id)
--   5. 重建 idx_ai_attachment (覆盖旧索引) + idx_ai_event (004 已建, 复用)
--
-- 为什么重建表:
--   SQLite 不支持 ALTER TABLE 放宽 NOT NULL, 必须走
--   "建新表 → 复制 → DROP 旧 → 改名 → 重建索引" 流程 (同 003)
--
-- 数据安全:
--   保留所有字段定义 (id/attachment_id/event_id/content_type/model/prompt_version/content/created_at)
--   现有数据 100% 满足新 CHECK (旧行 attachment_id 都非空)
--
-- 幂等性:
--   非幂等 (DROP TABLE), 靠 schema_migrations 版本判断不重跑
-- ============================================================

-- 1. 新建 ai_contents_new, attachment_id 放宽 nullable + 加 CHECK
CREATE TABLE ai_contents_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id  INTEGER,                                                              -- nullable (放宽)
    event_id       INTEGER,                                                              -- nullable (004 已加)
    content_type   TEXT    NOT NULL CHECK (content_type IN ('summary', 'ocr_fulltext', 'suggested_health_problems')),
    model          TEXT    NOT NULL,
    prompt_version TEXT    NOT NULL,
    content        TEXT    NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- 至少一个外键: 防止"既无附件也无事件"的孤儿 AI 内容
    CHECK (attachment_id IS NOT NULL OR event_id IS NOT NULL),
    FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id)      REFERENCES medical_events(id) ON DELETE CASCADE
);

-- 2. 复制所有现有数据
INSERT INTO ai_contents_new (id, attachment_id, event_id, content_type, model, prompt_version, content, created_at)
SELECT id, attachment_id, event_id, content_type, model, prompt_version, content, created_at FROM ai_contents;

-- 3. DROP 旧表 (自动删 idx_ai_attachment + idx_ai_event)
DROP TABLE ai_contents;

-- 4. 改名
ALTER TABLE ai_contents_new RENAME TO ai_contents;

-- 5. 重建索引
CREATE INDEX IF NOT EXISTS idx_ai_attachment ON ai_contents (attachment_id, content_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_event     ON ai_contents (event_id, content_type) WHERE event_id IS NOT NULL;

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (7);
