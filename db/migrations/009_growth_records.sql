-- ============================================================
-- MedMemory — Migration 009: growth_records（儿童生长曲线）
-- ============================================================
-- 对应需求: 儿童身高/体重随月龄变化，对照 WHO 生长标准百分位。
--          目标用户: 家有 0-6 岁娃的家庭 (本项目当前一个 45 月龄娃)。
--
-- 设计:
--   - 一次测量一行; 身高/体重/头围可部分填 (某次只称体重)。
--   - age_months 冗余存储 (REAL 含小数): 由 birthday × measured_date 派生,
--     写入时算好。保留小数便于百分位插值; 冗余存储避免每次重算,
--     也避免生日/测量日任一变化后需全表重算。
--   - source: home(家里量) / checkup(儿保), source_event_id 关联体检事件可追溯。
--   - 仅儿童场景 (0-19y), 但 schema 不强约束年龄——应用层按 birthday 过滤成员。
--
-- 不做的事 (MVP):
--   - 不做 WHO 参考数据表: LMS 是静态常量, 打进前端 bundle 懒加载, 不入库。
--   - 不做早产矫正: age_months 用实际月龄; 矫正月龄留 v2 (需 gestational_weeks)。
--   - BMI 不入库: 应用层 weight_kg / (height_cm/100)^2 派生。
--
-- 幂等性: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE, 重跑安全。
-- 同步: export/import 走整库快照, 新表自动随快照, 无需改 sync-server。
-- ============================================================

CREATE TABLE IF NOT EXISTS growth_records (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id        INTEGER NOT NULL,
    measured_date    TEXT    NOT NULL,   -- YYYY-MM-DD
    age_months       REAL    NOT NULL,   -- 派生月龄(含小数), 写入时由 birthday×measured_date 算
    height_cm        REAL,               -- 身高 cm (24月前为身长 length, 应用层措辞区分)
    weight_kg        REAL,               -- 体重 kg
    head_cm          REAL,               -- 头围 cm (婴幼儿关键)
    note             TEXT,
    source           TEXT    CHECK (source IN ('home', 'checkup')) NOT NULL DEFAULT 'home',
    source_event_id  INTEGER,            -- 关联体检事件 (source=checkup 时)
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (member_id)       REFERENCES family_members(id) ON DELETE CASCADE,
    FOREIGN KEY (source_event_id) REFERENCES medical_events(id)  ON DELETE SET NULL,
    -- 至少一项测量值非空 (防止空行, 同步导入或直写 DB 时兜底)
    CHECK (height_cm IS NOT NULL OR weight_kg IS NOT NULL OR head_cm IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_growth_member_date ON growth_records (member_id, measured_date);

-- 记录 migration 版本
INSERT OR IGNORE INTO schema_migrations (version) VALUES (9);
