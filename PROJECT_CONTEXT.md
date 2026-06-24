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

## AI Provider 落地（2026-06-22）

- v1+v2 实现 OpenAiProvider（GPT-4o Vision + `response_format: json_object`）, 一轮调用产出 doc_type 判型 + summary + ocr_fulltext + tags + 化验单 lab_indicators
- Provider 抽象保留（AiProvider 接口）, 后续 Claude/Gemini 可平行加入
- 用户运行时配置 apiKey + baseUrl + model 三项, 代码不写死中转站。支持任意 OpenAI 兼容端点（官方 / ccapi.us / DeepSeek / Ollama 等）, baseUrl 填到 `/v1`, 代码拼 `/chat/completions`

## 全局约束（2026-06-21）

- vite dev/preview 需配 COOP/COEP 跨源隔离头（OPFS/SharedArrayBuffer 必需），已在 vite.config.ts 配置
- 所有文件操作走 StorageAdapter 接口，数据模型只持抽象 storage_key（ADR-004）
- 自用场景：AI 接入优先于隐私合规；原图 PII 通过 prompt 约束不写入摘要/标签
- 时间字段统一 ISO 8601 UTC；枚举英文小写存储（应用层 i18n）；BOOLEAN 用 INTEGER 0/1

## 基础设施层代码契约（2026-06-21 就位，PoC 待浏览器验证）

- `getDb(): Promise<DbHandle>` 返回 `{ exec(sql, args?), dbId, isPersistent }`；Repository 实现层通过此 exec SQL
- `StorageAdapter` 接口 = `saveFile/getFile/deleteFile/listFiles(prefix?)`；`IndexedDbStorageAdapter` 默认实现（单 DB `medmemory-files` / 单 store `blobs` / out-of-line key）
- `storage_key` 格式：`{attachment|inbox}/{memberId|shared}/{YYYYMMDD-HHmmss}-{8hex}.{ext}`
- sqlite-wasm 走 `sqlite3Worker1Promiser` v2（worker 模式，OPFS 需跨源隔离）；不可用时降级 `:memory:`
- PoC 验证入口：`npm run dev` → console 跑 `window.medmemoryPoc.runPoc()`（详见 `src/db/POC.md`）
- **代码契约**：Repository 删 metadata 行不删原件 Blob，原件删除由 Domain 层显式调 `StorageAdapter.deleteFile`
- **OPFS sqlite 文件操作（2026-06-22 验证）**：`promiser('open')` 不支持 byteArray 入参（无法从字节导入）；`closeDb({unlink:true})` 在 opfs VFS 上不真删文件。覆写 sqlite 必须先 `closeDb()` 再用 `navigator.storage.getDirectory().removeEntry('medmemory.sqlite3')`（删）或 `getFileHandle().createWritable()`（写）。见 `src/composables/useDataBackup.ts`

## 生长曲线模块（2026-06-24 建立）

- 新增 `src/lib/growth/` 领域计算层：WHO LMS 百分位纯函数（`percentile.ts`）+ 静态参考数据（`who-lms-data.ts`，244 行常量打进 bundle 懒加载，不入库）
- 数据模型：`growth_records` 表（migration 009），`age_months` REAL 由 birthday 派生冗余存储，至少一项测量值非空（CHECK 约束）
- 图表：纯展示组件 `GrowthChart.vue` 接收 `lmsTable` prop（不 import 数据文件），SVG 手绘 5 条百分位参考曲线 + 孩子实测折线，与 TrendChart 同构不同域
