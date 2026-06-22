-- ============================================================
-- MedMemory — Migration 002: report_indicators 表
-- ============================================================
-- 对应 PRD 7.6 v2: 化验单结构化提取
--
-- 设计:
--   - 化验单 (lab_report) 的检验指标独立表存储 (非 ai_contents JSON)
--   - 原因: 跨周期查询 (WBC 趋势) 需 SQL 直接 WHERE name_en, JSON 函数阻力大
--   - 每个指标一行, attachment_id 关联, ON DELETE CASCADE 跟随附件清理
--   - 重新生成时: 应用层先 DELETE WHERE attachment_id, 再批量 INSERT
--     (整批替换, 不保留历史批次 — 对比看 ai_contents.summary 多版本)
--
-- 字段说明:
--   result 是 TEXT: 化验值可能是 "9.5" / "阴性" / "1:80" / ">10.0", 不强制 numeric
--   unit / reference_range 可空: 部分指标无单位 (如 "尿色: 黄")
--   abnormal_tag: H 偏高 / L 偏低 / N 正常 / NULL 无参考范围或无法判断
--   display_order: 保留报告内原始顺序 (GPT 按 top→bottom 输出)
--   model + prompt_version: 追溯生成来源, 与 ai_contents 一致
-- ============================================================

CREATE TABLE IF NOT EXISTS report_indicators (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    attachment_id   INTEGER NOT NULL,
    name_cn         TEXT    NOT NULL,                  -- 项目中文名 (白细胞计数)
    name_en         TEXT,                              -- 英文缩写 (WBC), 可空
    result          TEXT    NOT NULL,                  -- 测定值, 字符串原样保留
    unit            TEXT,                              -- 单位 (10^9/L)
    reference_range TEXT,                              -- 参考范围 (4.0-10.0 / <5.0 / 阴性)
    abnormal_tag    TEXT    CHECK (abnormal_tag IN ('H', 'L', 'N')),  -- H/L/N, NULL=未知
    display_order   INTEGER NOT NULL DEFAULT 0,        -- 报告内顺序 (top→bottom)
    model           TEXT    NOT NULL,                  -- 'gpt-4o' 等
    prompt_version  TEXT    NOT NULL,                  -- 与 ai_contents.prompt_version 对齐
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);

-- 查单个附件的全部指标 (UI 渲染)
CREATE INDEX IF NOT EXISTS idx_report_indicators_attachment
    ON report_indicators (attachment_id, display_order);

-- 跨附件按指标名查 (趋势图: 全家 WBC 历史)
CREATE INDEX IF NOT EXISTS idx_report_indicators_name_en
    ON report_indicators (name_en);

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
