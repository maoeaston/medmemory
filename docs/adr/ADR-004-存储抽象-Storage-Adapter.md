# ADR-004: 存储抽象 Storage Adapter 模式

- **状态**: Accepted
- **日期**: 2026-06-21
- **决策者**: 架构评审

## 背景

附件原件（JPG/PDF）需要持久化。若数据模型直接耦合具体存储实现（如 `attachments.file_path` 指向 IndexedDB 的某个 store/key），未来从 IndexedDB 换 OPFS、或接 OneDrive/iCloud/WebDAV 时，要**痛苦地清洗数据**——这正是评审指出的"未来最容易推翻重来的地方"。

## 决策

抽象 `StorageAdapter` 接口，数据模型只持有**抽象 storage_key**，不关心文件实际存在哪里。

```typescript
interface StorageAdapter {
  saveFile(key: string, blob: Blob): Promise<void>
  getFile(key: string): Promise<Blob | null>
  deleteFile(key: string): Promise<void>
  listFiles(prefix?: string): Promise<string[]>
}
```

当前实现：`IndexedDbStorageAdapter`（原件文件）。未来实现：`OpfsStorageAdapter`、`OneDriveStorageAdapter`、`WebDavStorageAdapter`——届时只需新增 Adapter 类，**数据模型零改动**。

## 理由

- **解耦**：数据模型与存储实现分离，各自独立演进
- **迁移友好**：换存储层只需换 Adapter + 数据迁移脚本，schema 不动
- **多存储后端**：未来可同时支持本地 + 网盘备份（见 PRD 7.9 数据持久性的"自动备份到网盘"未来扩展）
- **成本极低**：一层薄接口，现在的投入换未来存储层可独立演进

## 结果

**正面**：

- 存储层可独立替换/扩展
- `attachments.storage_key` 是抽象引用，不绑定具体存储
- 未来接网盘做备份/同步时，数据模型无需重构

**负面**：

- 一层抽象的维护成本（可接受，接口极简）
- 需要确保所有文件操作都走 Adapter，不绕过（代码规范约束）

## 备选方案

- **直接耦合 IndexedDB**（数据模型存具体 path）：已否决（换存储要清洗数据）
- **OPFS 单一实现不抽象**：放弃未来接网盘的灵活性；且 IndexedDB（原件）和 OPFS（SQLite）本就是两种存储，需要统一抽象

## 关联

- 与 ADR-001 配合：SQLite 数据库走 OPFS，原件文件走 StorageAdapter（当前 IndexedDB 实现）
- PRD v3.1 第 8.6 节（storage_key 字段）、第 9.2 节

## 参考

- 设计模式：Adapter / Ports & Adapters（六边形架构）
- PRD v3.1 第 9.2 节
