# ADR-003: AI 产出存储为独立表 ai_contents

- **状态**: Accepted
- **日期**: 2026-06-21
- **决策者**: 架构评审

## 背景

若 AI 摘要只存单一 `attachments.ai_summary TEXT`，半年后必然遇到：

- 换模型（GPT-4o → Claude → Gemini）——旧摘要被覆盖丢失
- 换 prompt 版本——无法对比新旧质量
- 重新生成（AI 误读时）——旧版本无法追溯
- 人工修正——无法回退

这是很多 AI 项目的死法。

## 决策

独立 `ai_contents` 表，统一存所有 AI 产出：

```
ai_contents (id, attachment_id, content_type, model, prompt_version, content, created_at)
```

- `content_type` 区分产出类型：`summary`（结构化摘要）/ `ocr_fulltext`（原始 OCR 全文）
- 同一 attachment 可有多条记录（多模型/多版本/多类型），按 `created_at DESC` 取最新
- 保留 `model` 和 `prompt_version`，便于追溯每条产出来源

## 理由

- **可追溯**：换模型、换 prompt、重生成都不丢失历史，可对比
- **统一 OCR 全文**：OCR 全文和摘要都是 AI 产出，同一张表管理。OCR 全文是未来 RAG 搜索和全文检索的基础（见 ADR 关联：关键词搜索 MVP 就依赖 ocr_fulltext）
- **零额外 API 成本**：一次多模态调用同时产出 summary + ocr_fulltext + tags，存入本表

## 结果

**正面**：

- 多模型多版本可追溯对比，换模型无痛
- OCR 全文就地保存，未来 RAG 无需重跑几千份文件
- 数据模型面向长期（核心原则五）

**负面**：

- 查询需按 `created_at` 取最新版本（已建复合索引 `idx_ai_attachment`）
- 存储略增（多版本历史），自用规模可忽略

## 备选方案

- **attachments.ai_summary TEXT 单字段**：已否决（无法多版本/换模型）
- **分两张表（ai_summaries + ocr_texts）**：放弃——两者都是 attachment 的 AI 产出，元数据结构相同（model/prompt_version/created_at），统一成一张表更优雅，content_type 区分即可
- **文件存储**（每条摘要一个 JSON 文件）：放弃 SQL 查询能力

## 参考

- PRD v3.1 第 7.6 节、第 8.7 节、第 7.8 节（关键词搜索依赖 ocr_fulltext）
