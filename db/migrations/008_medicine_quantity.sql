-- ============================================================
-- MedMemory — Migration 008: medicines.unit + quantity（药箱余量）
-- ============================================================
-- 对应需求: 让用户直观看到家里药物余量（剩余 N 盒 / N ml）。
--
-- 设计:
--   - unit TEXT（可空）: 自由文本单位（盒/瓶/片/支/袋/ml/mg），不给枚举约束。
--     理由: 家庭药箱单位五花八门，枚举反而限制；UI 用 datalist 提供建议即可。
--   - quantity REAL NOT NULL DEFAULT 0: 液体制剂需要小数（美林 30ml 半瓶 = 15）。
--     NOT NULL 保证实体层 quantity 永远是 number，省 null 分支。
--
-- 不做的事:
--   - 不建 batch/lot 表: medicines.name 无 UNIQUE 约束，
--     同名不同到期日的药品天然就是多行（按 expiry_date 排序），已满足需求。
--     引入批次表会过度复杂化，违反 MVP 原则。
--
-- 幂等性:
--   - 靠 schema_migrations 版本判断不重跑（ALTER TABLE 无 IF NOT EXISTS 语法）。
--   - 全新库: 001 建表（无 unit/quantity）→ 008 ALTER 追加。
--   - 重置数据库: DROP 整库 → 001-008 顺序重建，不重复 ALTER。
--
-- 生产数据安全:
--   - 现有行 unit=NULL, quantity=0（DEFAULT 生效），无需数据迁移。
--   - 同步: export/import 走整库快照，新列自动随快照同步，无需改 sync-server。
--   - 注意: A/B 设备若一旧一新，旧端 import 新快照时新列会被忽略（schema 不含），
--     升级两端后再同步即可。
-- ============================================================

ALTER TABLE medicines ADD COLUMN unit     TEXT;                       -- 自由文本单位, 可空
ALTER TABLE medicines ADD COLUMN quantity REAL NOT NULL DEFAULT 0;    -- 余量, 液体需小数

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (8);
