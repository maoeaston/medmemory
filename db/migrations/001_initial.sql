-- ============================================================
-- MedMemory 初始 Schema (v3.1)
-- 迁移版本: 001_initial
-- 目标数据库: SQLite (via sqlite-wasm + OPFS)
-- 对应 PRD: 家庭医疗记忆系统-v3.1.md，第 8 节数据模型
-- ============================================================
-- 约定:
--   1. 应用层每次连接数据库后必须执行: PRAGMA foreign_keys = ON;
--   2. 时间字段统一 ISO 8601 UTC 字符串 (YYYY-MM-DDTHH:MM:SSZ)
--   3. JSON 字段 (allergies/chronic_conditions/current_medications/tags) 存 TEXT,
--      应用层负责序列化/反序列化与校验
--   4. 枚举值用英文小写存储 (应用层做 i18n), processing_status 例外 (按 PRD 大写)
--   5. BOOLEAN 用 INTEGER (0/1), SQLite 无原生 BOOLEAN
--   6. updated_at 由应用层维护 (本 schema 不加触发器, 保持简单)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. family_members — 家庭成员
--    allergies/chronic_conditions 为对象数组 (v3 升级):
--      allergies:           [{name, severity, reaction}]
--      chronic_conditions:  [{name, status, diagnosed_date}]
-- ============================================================
CREATE TABLE IF NOT EXISTS family_members (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT    NOT NULL,
    nickname            TEXT,
    birthday            TEXT,   -- YYYY-MM-DD
    gender              TEXT    CHECK (gender IN ('male', 'female', 'other')),
    allergies           TEXT,   -- JSON: [{name, severity, reaction}]
    chronic_conditions  TEXT,   -- JSON: [{name, status, diagnosed_date}]
    current_medications TEXT,   -- JSON: [string] 当前用药快照
    remark              TEXT,
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ============================================================
-- 2. medical_events — 医疗事件 (核心对象, 接近 EMR Encounter)
--    problem_tag 已删除, 健康问题关联走 event_problem_rel
-- ============================================================
CREATE TABLE IF NOT EXISTS medical_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id   INTEGER NOT NULL,
    event_date  TEXT    NOT NULL,   -- YYYY-MM-DD
    hospital    TEXT,
    department  TEXT,
    title       TEXT    NOT NULL,
    event_type  TEXT    CHECK (event_type IN
                ('outpatient','emergency','checkup','followup','vaccine','hospitalization','other')),
    summary     TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (member_id) REFERENCES family_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_member_date ON medical_events (member_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_events_type        ON medical_events (event_type, event_date DESC);

-- ============================================================
-- 3. inbox_items — Quick Capture 暂存 (v3.1 新增)
--    归档后 status='archived', archived_event_id 指向转出的 event
-- ============================================================
CREATE TABLE IF NOT EXISTS inbox_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_type        TEXT    NOT NULL CHECK (capture_type IN ('photo', 'voice', 'text')),
    storage_key         TEXT,   -- 媒体文件键 (photo/voice 用; text 可空)
    text_content        TEXT,   -- 文字 / 语音转文字 (可空)
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    status              TEXT    NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'archived')),
    archived_event_id   INTEGER,   -- 归档后关联事件 (可空)
    FOREIGN KEY (archived_event_id) REFERENCES medical_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_items (status, created_at DESC);

-- ============================================================
-- 4. health_problems — 健康问题表 (v3 新增, 替代 problem_tag TEXT)
--    status: active(进行中) / chronic(长期) / resolved(已结束)
--    MVP 不做手工 CRUD; 通过 AI 推荐 + 一键确认渐进积累
-- ============================================================
CREATE TABLE IF NOT EXISTS health_problems (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id     INTEGER NOT NULL,
    name          TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'chronic', 'resolved')),
    started_date  TEXT,   -- YYYY-MM
    ended_date    TEXT,   -- 可空
    note          TEXT,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (member_id) REFERENCES family_members(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_problems_member ON health_problems (member_id, status);

-- ============================================================
-- 5. event_problem_rel — 事件 × 健康问题 多对多 (v3 新增)
-- ============================================================
CREATE TABLE IF NOT EXISTS event_problem_rel (
    event_id    INTEGER NOT NULL,
    problem_id  INTEGER NOT NULL,
    PRIMARY KEY (event_id, problem_id),
    FOREIGN KEY (event_id)   REFERENCES medical_events(id)  ON DELETE CASCADE,
    FOREIGN KEY (problem_id) REFERENCES health_problems(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_epr_problem ON event_problem_rel (problem_id);

-- ============================================================
-- 6. attachments — 医疗资料附件 (v3 storage_key + tags, v3.1 加状态机)
--    event_id 可空: Quick Capture 产生的附件归档前不挂事件
--    processing_status 状态机: UPLOADED → OCR_PROCESSING → OCR_DONE → SUMMARY_DONE
--                              任何阶段可 → FAILED (processing_error 记录原因)
-- ============================================================
CREATE TABLE IF NOT EXISTS attachments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id          INTEGER,   -- 可空 (Quick Capture 未归档时)
    file_name         TEXT    NOT NULL,
    file_type         TEXT    NOT NULL CHECK (file_type IN ('jpg', 'png', 'pdf')),
    storage_key       TEXT    NOT NULL,   -- 存储抽象键, 由 Storage Adapter 管理实际位置
    doc_type          TEXT    CHECK (doc_type IN
                      ('outpatient_record','lab_report','imaging_report',
                       'prescription','discharge_summary','receipt','other')),
    subtype           TEXT,   -- 子类 (自由文本, 大类下细分): lab_report->cbc/urinalysis/biochemistry;
                      --        imaging_report->ct/mri/xray/ultrasound. 应用层维护建议值列表.
                      --        分类(doc_type/subtype) 与 标签(tags) 是两种东西, 不混用.
    tags              TEXT,   -- JSON: [string] 最新标签快照
    processing_status TEXT    NOT NULL DEFAULT 'UPLOADED'
                              CHECK (processing_status IN
                              ('UPLOADED','OCR_PROCESSING','OCR_DONE','SUMMARY_DONE','FAILED')),
    processing_error  TEXT,   -- FAILED 时记录原因
    ai_generated      INTEGER NOT NULL DEFAULT 0,   -- 0/1
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (event_id) REFERENCES medical_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_event  ON attachments (event_id);
CREATE INDEX IF NOT EXISTS idx_attachments_status ON attachments (processing_status);
CREATE INDEX IF NOT EXISTS idx_attachments_event_doc ON attachments (event_id, doc_type);

-- ============================================================
-- 7. ai_contents — AI 产出统一表 (v3 新增)
--    content_type: summary(结构化摘要) / ocr_fulltext(原始 OCR 全文)
--    支持多模型/多版本: 同一 attachment 可有多条记录, 按 created_at 取最新
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_contents (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id  INTEGER NOT NULL,
    content_type   TEXT    NOT NULL CHECK (content_type IN ('summary', 'ocr_fulltext')),
    model          TEXT    NOT NULL,    -- 如 'gpt-4o', 'claude-sonnet-4-5'
    prompt_version TEXT    NOT NULL,
    content        TEXT    NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_attachment ON ai_contents (attachment_id, content_type, created_at DESC);

-- ============================================================
-- 8. medicines — 药箱 (v3.1 加 usage 用途字段)
--    MVP 字段: name/usage/expiry_date/storage_location/remark/member_id
--    第二阶段字段: photo_path/source_event_id
-- ============================================================
CREATE TABLE IF NOT EXISTS medicines (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    usage            TEXT,   -- v3.1: 用途 (退烧/过敏/腹泻/止咳…), 支持"发烧吃什么"式检索
    expiry_date      TEXT,   -- YYYY-MM
    storage_location TEXT,
    remark           TEXT,
    member_id        INTEGER,   -- 可空表示家庭共用
    photo_path       TEXT,      -- 第二阶段
    source_event_id  INTEGER,   -- 第二阶段: 关联处方事件
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (member_id)      REFERENCES family_members(id) ON DELETE SET NULL,
    FOREIGN KEY (source_event_id) REFERENCES medical_events(id)  ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_medicines_expiry ON medicines (expiry_date);
CREATE INDEX IF NOT EXISTS idx_medicines_usage  ON medicines (usage);
CREATE INDEX IF NOT EXISTS idx_medicines_member ON medicines (member_id);

-- ============================================================
-- schema_migrations — 迁移版本跟踪
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- INSERT OR IGNORE 保幂等: schemaSql 若被重复 exec（migration 重跑 / PoC 手动触发）
-- 不应因 version=1 已存在而报错。
INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
