# sqlite-wasm + OPFS PoC 运行说明

## 前置

```bash
npm install
```

## 运行

```bash
npm run dev
```

浏览器打开 dev URL（通常 `http://localhost:5173`）。

## 浏览器要求

OPFS 需要：
- Chrome 86+ / Edge 86+ / Firefox 111+
- Safari 暂不支持 OPFS（会降级到 `:memory:`）

## 验证跨源隔离

DevTools -> Application -> Storage -> 确认 **cross-origin isolated** 为 `true`。

若不为 true，检查 `vite.config.ts` 的 COOP/COEP 头是否被浏览器实际接收（Network 面板看响应头）。

## 执行 PoC

在浏览器 console 运行：

```js
window.medmemoryPoc.runPoc()
```

预期返回：

```js
{
  tablesCreated: 8,
  memberInserted: true,
  cascadeWorked: true,
  dbVersion: 1,
  persistent: true
}
```

`persistent: false` 表示降级到了 `:memory:`（数据不持久）。

## 失败排查

### OPFS fallback 到 `:memory:`

console 会有 warn：`OPFS 不可用，降级到 :memory:`。

原因排查：
1. **COOP/COEP 头未生效** — 检查 `vite.config.ts` 的 `Cross-Origin-Opener-Policy: same-origin` 和 `Cross-Origin-Embedder-Policy: require-corp` 是否在响应头中
2. **浏览器不支持 OPFS** — 确认浏览器版本（Chrome 86+ / Edge 86+ / Firefox 111+）
3. **Safari** — 当前不支持 OPFS，必然降级

### 建表 SQL 报错（表已存在）

重跑 PoC 时，CREATE TABLE 无 IF NOT EXISTS 会报 "table already exists"。
console 会有 warn 但不影响验证（已有表仍可查询）。

### cascadeWorked: false

说明 `PRAGMA foreign_keys = ON` 未生效或外键约束未正确建立。
检查 `connection.ts` 的 PRAGMA 执行和 `001_initial.sql` 的 FOREIGN KEY 定义。

## PoC 跑通后

下一步：基于 `getDb()` 返回的 `DbHandle` 实现各表 Repository（`src/repositories/interfaces.ts`）。
此 PoC 仅验证基础设施层，不在 Repository 实现范围内。
