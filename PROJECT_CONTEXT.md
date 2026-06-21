# MedMemory 项目上下文

> 只追加，不改写历史。每条 ≤ 10 行。

## 架构分层（2026-06-21 建立）

schema.sql → Repository 接口层（数据访问边界）→ Storage Adapter（文件抽象）→ Domain Model → UI（Vue3）。
基础设施（sqlite-wasm+OPFS、Storage Adapter、迁移机制）验证通过后才进 UI。不直接写页面。

## 技术选型（2026-06-21 定稿）

- 持久化：sqlite-wasm + OPFS（放弃 SQL.js，见 ADR-001）
- 前端：Vue3 + TypeScript + Vite + Pinia + Vue Router
- AI：单一多模态 API（GPT-4o / Claude Sonnet 4.5 / Gemini 2.0 Flash 候选），一轮产出 summary + ocr_fulltext + tags
- 导出：jszip（ZIP 含原件+SQLite+JSON 元数据）

## 全局约束（2026-06-21）

- vite dev/preview 需配 COOP/COEP 跨源隔离头（OPFS/SharedArrayBuffer 必需），已在 vite.config.ts 配置
- 所有文件操作走 StorageAdapter 接口，数据模型只持抽象 storage_key（ADR-004）
- 自用场景：AI 接入优先于隐私合规；原图 PII 通过 prompt 约束不写入摘要/标签
- 时间字段统一 ISO 8601 UTC；枚举英文小写存储（应用层 i18n）；BOOLEAN 用 INTEGER 0/1
