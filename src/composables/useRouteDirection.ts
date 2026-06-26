// ============================================================
// useRouteDirection — 路由切换方向感知 (forward / back / none)
// ============================================================
// 用途: AppShell 的 <Transition :name="..."> 据此选 slide-forward / slide-back / fade
//
// 原理: 每条 route 有 meta.depth, 切换时比较 to.depth vs from.depth
//   - to.depth > from.depth → forward (新页面层级更深, 如 dashboard→events/:id)
//   - to.depth < from.depth → back (返回更浅层级)
//   - depth 相等 → none (同层切换, 如 dashboard↔inbox↔medicines 走 fade)
//
// 仅在 router.afterEach 触发更新; 组件 setup 时拿当前值作为初值.
// ============================================================

import { ref } from 'vue';
import router from '@/router';

export type RouteDirection = 'forward' | 'back' | 'none';

export const routeDirection = ref<RouteDirection>('none');

router.afterEach((to, from) => {
  // 首次进入 (from 无 matched) 不动画
  if (!from.matched.length) {
    routeDirection.value = 'none';
    return;
  }
  const toDepth = (to.meta.depth as number | undefined) ?? 0;
  const fromDepth = (from.meta.depth as number | undefined) ?? 0;
  if (toDepth > fromDepth) {
    routeDirection.value = 'forward';
  } else if (toDepth < fromDepth) {
    routeDirection.value = 'back';
  } else {
    routeDirection.value = 'none';
  }
});

/**
 * 在组件里读取当前方向. 也可直接 import { routeDirection } 使用.
 */
export function useRouteDirection() {
  return { direction: routeDirection };
}
