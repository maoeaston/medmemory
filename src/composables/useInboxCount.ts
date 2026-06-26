// ============================================================
// MedMemory — 待整理计数全局单例 composable
// ============================================================
// 用途: Navbar 待整理 tab 的数字角标需要实时反映 inbox_items
//   WHERE status='pending' 的数量。
//
// 为什么需要这个: 项目无 Pinia / 无事件总线, 各视图各自 repo.xxx()。
// 角标要在导航栏（App.vue）持续展示, 且 InboxView 归档后要立即更新,
// 所以需要一个共享的 reactive 计数 + 显式 refresh 入口。
//
// 设计:
//   - 模块级 ref<number> 单例, 多次 useInboxCount() 共享
//   - refresh() 调 repos.inbox.countPending()（单条 SQL, 开销可忽略）
//   - count 为 readonly, 外部不能直接改
//
// 触发点（调用 refresh）:
//   - App.vue onMounted（首屏）
//   - App.vue router.afterEach（每次路由切换, 兜底所有数据变更入口）
//   - InboxView handleArchiveSubmit 成功后（即时反馈, 不等导航）
// ============================================================

import { readonly, ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';

const countRef = ref<number>(0);

async function refresh(): Promise<void> {
  try {
    const repos = await useRepositories();
    countRef.value = await repos.inbox.countPending();
  } catch {
    // DB 未就绪或查询失败: 保持上次的值, 不抛（角标是辅助 UI, 不阻塞主流程）
  }
}

export function useInboxCount() {
  return {
    count: readonly(countRef),
    refresh,
  };
}
