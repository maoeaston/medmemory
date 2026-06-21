# ADR-001: 持久化方案选择 sqlite-wasm + OPFS

- **状态**: Accepted
- **日期**: 2026-06-21
- **决策者**: 架构评审

## 背景

MedMemory 是面向 5～10 年长期使用的家庭医疗档案库，数据存储在浏览器端（PWA）。存储层是这个项目**最大的长期风险**——一旦录入数千份病历后再重构存储层，是真正昂贵的技术债。因此存储选型必须面向长期稳定。

核心需求：

- 数据稳定存 5～10 年（最高优先级）
- 支持增量写入（频繁录入场景）
- 数据量增长后性能不退化（预计 800 事件 × 5 附件 = 4000 附件 + AI 摘要/OCR 全文长文本）
- 支持完整导出/迁移（不锁死在某个浏览器）

## 决策

采用 **sqlite-wasm + OPFS（Origin Private File System）VFS** 作为 SQLite 持久化方案。**放弃 SQL.js。**

## 理由

SQL.js 的根本缺陷：不支持增量写入。每次 `insert/update` 后必须 `db.export()` 把整个数据库序列化成二进制 blob，整体存回 IndexedDB。数据量增长后，单次保存的序列化耗时和数据库体积会持续增长，且**无解**——这是架构性限制，不是优化能解决的。

sqlite-wasm 配合 OPFS VFS 实现真正的增量持久化（文件级随机写），长期性能稳定。OPFS 是浏览器原生的私有文件系统，专为这类场景设计。

放弃 SQL.js 的代价是 OPFS 兼容性要求现代浏览器（Chrome/Edge 支持良好，Safari 较新版本支持，需阶段 0 实测）。但这个**可验证的兼容性风险**，远小于 SQL.js **必然发生**的性能恶化。

## 结果

**正面**：

- 增量持久化，长期性能稳定
- 真正的 SQLite（事务、外键、CHECK 约束、全文 SQL 表达力）
- OPFS 是浏览器原生，无第三方存储依赖
- 标准 SQLite 数据库文件，导出/迁移到其他环境兼容性好

**负面**：

- OPFS 需要跨源隔离 HTTP 头（`Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy`），vite dev server 和部署都要配置
- Safari 兼容性需在阶段 0 实测确认
- sqlite-wasm 首次启动需加载 wasm 文件（稍慢，可接受）

## 备选方案

- **SQL.js**：已否决（整体序列化无解）
- **Dexie (IndexedDB ORM)**：放弃 SQL 表达力，多表关联查询弱；不符合"医疗事件驱动"的多表关联需求
- **服务端数据库**：违背"自用本地优先、不引入账号体系"的约束（见 PRD 3.1/3.2）

## 参考

- PRD v3.1 第 9.2 节、第 12.1 节阶段 0
- sqlite-wasm: https://sqlite.org/wasm/
- OPFS: https://web.dev/articles/origin-private-file-system
