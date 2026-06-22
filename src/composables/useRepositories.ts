// ============================================================
// MedMemory — Repositories 单例 composable
// ============================================================
// 分层位置: UI 层的 Repository 入口, 包装 createRepositories() 单例
//
// 设计理由:
//   - sqlite-wasm 初始化 + OPFS 打开是昂贵操作, 整个 app 生命周期只做一次
//   - connection.ts 内部已用模块级单例保证 getDb() 复用, 但 createRepositories()
//     每次调仍会 new 9 个 Repository 实例（轻量但无意义）
//   - 这里用模块级 Promise 缓存, 第一次调 useRepositories() 触发初始化,
//     后续直接返回同一个 Promise<Repositories>
//
// 用法:
//   import { useRepositories } from '@/composables/useRepositories';
//   const repos = await useRepositories();
//   await repos.inbox.create({...});
// ============================================================

import { createRepositories } from '@/repositories';
import type { Repositories } from '@/repositories';

/** 模块级单例 Promise。null 表示尚未初始化。 */
let _promise: Promise<Repositories> | null = null;

/**
 * 拿到 Repositories 单例（首次调用触发 sqlite-wasm + OPFS 初始化）。
 *
 * - 首次: 调 `createRepositories()`, 缓存 Promise
 * - 后续: 直接返回同一 Promise（即使首次还未 resolve, 也复用同一等待）
 *
 * 不抛错 —— 错误由调用方 try/catch（通常 RepositoryError / SqliteConnectionError）。
 * 失败后 _promise 会被 reject 但**不重置**（避免重复 init 掩盖首次错误）;
 * 调用方可在出错时显式调 `resetRepositories()` 后重试。
 */
export function useRepositories(): Promise<Repositories> {
  if (_promise === null) {
    _promise = createRepositories();
  }
  return _promise;
}

/**
 * 重置单例（仅 dev / 测试 / 用户"重置数据库"场景调）。
 * 生产代码一般不调。
 */
export function resetRepositories(): void {
  _promise = null;
}
