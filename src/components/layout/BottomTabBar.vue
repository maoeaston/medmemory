<script setup lang="ts">
// BottomTabBar — 移动端固定底部 5 tab, 中央凸起 FAB
//
// 布局: [首页] [待整理] [+记录 FAB] [药箱] [更多]
//   - FAB 凸出 tab bar 之上 var(--fab-raise) (20px), 圆形主色, 强视觉权重
//   - "更多" 触发 emit, 由 AppShell 打开 MoreDrawer
//   - 待整理 tab 带 amber 数字角标 (复用 useInboxCount)
//
// 仅 ≤1023px 显示 (≥1024px 走桌面 top nav)
import { RouterLink } from 'vue-router';
import { useInboxCount } from '@/composables/useInboxCount';

defineEmits<{ 'open-more': [] }>();

const { count: pendingInboxCount } = useInboxCount();
</script>

<template>
  <nav class="tab-bar" aria-label="主导航">
    <RouterLink to="/dashboard" class="tab" active-class="tab-active">
      <span class="tab-icon" aria-hidden="true">🏠</span>
      <span class="tab-label">首页</span>
    </RouterLink>

    <RouterLink to="/inbox" class="tab" active-class="tab-active">
      <span class="tab-icon" aria-hidden="true">📥</span>
      <span class="tab-label">
        待整理
        <span v-if="pendingInboxCount > 0" class="tab-badge">{{ pendingInboxCount }}</span>
      </span>
    </RouterLink>

    <RouterLink to="/capture" class="tab-fab" active-class="tab-fab-active" aria-label="新增记录">
      <span class="tab-fab-plus" aria-hidden="true">+</span>
      <span class="tab-fab-label">记录</span>
    </RouterLink>

    <RouterLink to="/medicines" class="tab" active-class="tab-active">
      <span class="tab-icon" aria-hidden="true">💊</span>
      <span class="tab-label">药箱</span>
    </RouterLink>

    <button type="button" class="tab" @click="$emit('open-more')">
      <span class="tab-icon" aria-hidden="true">⋯</span>
      <span class="tab-label">更多</span>
    </button>
  </nav>
</template>

<style scoped>
.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 50;
  height: var(--tab-bar-height);
  padding-bottom: var(--safe-area-bottom);
  background: var(--color-bg-card);
  border-top: 1px solid var(--color-border-default);
  box-shadow: var(--shadow-tab-bar);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  align-items: center;
}

.tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  text-decoration: none;
  font-size: var(--font-size-caption);
  font-family: inherit;
  cursor: pointer;
  padding: 0.3rem 0;
  min-height: var(--touch-target-min);
  transition: color var(--duration-fast);
}

.tab:hover {
  color: var(--color-text-primary);
}

.tab-icon {
  font-size: 1.25rem;
  line-height: 1;
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
}

.tab-active {
  color: var(--color-primary-dark);
  font-weight: var(--font-weight-semibold);
}

.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.1rem;
  height: 1.1rem;
  padding: 0 0.3rem;
  background: var(--color-warning);
  color: white;
  border-radius: 9999px;
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-semibold);
}

/* === 中央 FAB (凸起) === */
.tab-fab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 0.15rem;
  text-decoration: none;
  color: var(--color-primary-dark);
  margin-top: calc(-1 * var(--fab-raise));
  cursor: pointer;
}

.tab-fab-plus {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--fab-diameter);
  height: var(--fab-diameter);
  border-radius: 50%;
  background: var(--color-primary);
  color: white;
  font-size: 2rem;
  font-weight: var(--font-weight-bold);
  box-shadow: var(--shadow-fab);
  transition: background var(--duration-fast), transform var(--duration-fast);
  line-height: 1;
}

.tab-fab:hover .tab-fab-plus {
  background: var(--color-primary-hover);
  transform: scale(1.05);
}

.tab-fab-active .tab-fab-plus {
  background: var(--color-primary-dark);
}

.tab-fab-label {
  font-size: var(--font-size-caption);
  color: var(--color-primary-dark);
  font-weight: var(--font-weight-semibold);
}

/* ≥1024px 隐藏, 桌面走顶部 nav */
@media (min-width: 1024px) {
  .tab-bar {
    display: none;
  }
}
</style>
