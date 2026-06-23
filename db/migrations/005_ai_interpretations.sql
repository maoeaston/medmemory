-- ============================================================
-- MedMemory — Migration 005: ai_interpretations 表
-- ============================================================
-- 对应 PRD v3.2 AI 健康助手: 化验单解读 + 用药指南结果持久化
-- 决策点 #3 (PRD §8): 双 FK 列替代多态关联
--
-- Schema 设计 (PRD §8 #3):
--   - 双 FK 列 attachment_id / medicine_id 均 nullable + ON DELETE CASCADE
--   - 表级 CHECK 保证互斥 (lab 解读必填 attachment_id, medication 解读必填 medicine_id)
--   - kind 区分两类解读
--   - content_json 存完整 LabInterpretation / MedicationGuide JSON
--   - provider/model 留扩展点 (未来原生 Claude API 上线后历史可溯源)
--
-- 为什么双 FK 而非多态 (source_type + source_id):
--   评审指出多态关联无 FK 约束, 删 attachment/medicine 时不会级联清理
--   双 FK 让 DB 层强制 ON DELETE CASCADE, 应用层只需插数据无需手动 cleanup
--
-- 幂等性:
--   CREATE TABLE/INDEX 都 IF NOT EXISTS, 靠 schema_migrations 版本判断不重跑
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_interpretations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id  INTEGER REFERENCES attachments(id) ON DELETE CASCADE,
  medicine_id    INTEGER REFERENCES medicines(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK (kind IN ('lab', 'medication')),
  content_json   TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  prompt_version TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- 互斥约束: lab 解读必须有 attachment_id, medication 解读必须有 medicine_id
  -- DB 层硬保证 (应用层校验是软兜底)
  CHECK (
    (kind = 'lab'        AND attachment_id IS NOT NULL AND medicine_id IS NULL)
    OR
    (kind = 'medication' AND attachment_id IS NULL     AND medicine_id IS NOT NULL)
  )
);

-- 部分索引: 只索引有对应 FK 的行 (跳过另一种 kind 的行)
CREATE INDEX IF NOT EXISTS idx_ai_interp_attachment ON ai_interpretations (attachment_id, kind)
  WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_interp_medicine ON ai_interpretations (medicine_id, kind)
  WHERE medicine_id IS NOT NULL;

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (5);
