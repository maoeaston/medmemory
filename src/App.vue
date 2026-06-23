<script setup lang="ts">
// MedMemory 主壳:
//   - 顶部固定导航条（移动优先, 单行横向）
//   - <router-view /> 承载各页面
//
// 导航顺序按使用频率: Dashboard / Inbox / **+Capture**（高亮）/ 成员 / 时间线 / 搜索 / 药箱 / 设置
// +Capture 是 MVP 最高优先级入口, 视觉强化
// 时间线放搜索前: 浏览历史事件的主入口（区别于搜索的关键字定位）
import { onMounted } from 'vue';
import SyncIndicator from '@/components/SyncIndicator.vue';
import { useSync } from '@/composables/useSync';

const { initOnAppStart } = useSync();

onMounted(() => {
  void initOnAppStart();
});
</script>

<template>
  <div class="app">
    <header class="app-header">
      <RouterLink to="/dashboard" class="brand">家庭医疗记忆</RouterLink>
      <nav class="nav">
        <RouterLink to="/dashboard" class="nav-link">首页</RouterLink>
        <RouterLink to="/inbox" class="nav-link">待整理</RouterLink>
        <RouterLink to="/capture" class="nav-link nav-cta">+ 记录</RouterLink>
        <RouterLink to="/members" class="nav-link">成员</RouterLink>
        <RouterLink to="/timeline" class="nav-link">时间线</RouterLink>
        <RouterLink to="/search" class="nav-link">搜索</RouterLink>
        <RouterLink to="/medicines" class="nav-link">药箱</RouterLink>
        <RouterLink to="/settings" class="nav-link">设置</RouterLink>
      </nav>
      <SyncIndicator class="sync-indicator-slot" />
    </header>

    <RouterView />
  </div>
</template>

<style>
/* 全局重置 + 基础排版 */
*,
*::before,
*::after {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  padding: 0;
  font-family: var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-page);
}
</style>

<style scoped>
.app {
  min-height: 100vh;
}

.app-header {
  background: var(--color-bg-card);
  border-bottom: 1px solid var(--color-border-default);
  padding: 0.75rem 1rem;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  flex-wrap: wrap;
  position: sticky;
  top: 0;
  z-index: 10;
}

.brand {
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--color-text-primary);
  text-decoration: none;
}

.nav {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.nav-link {
  padding: 0.4rem 0.8rem;
  border-radius: var(--radius-button);
  text-decoration: none;
  color: var(--color-text-secondary);
  font-size: 0.92rem;
  transition: background 0.15s, color 0.15s;
}

.nav-link:hover {
  background: var(--color-bg-muted);
  color: var(--color-text-primary);
}

.nav-link.router-link-active {
  background: var(--color-primary-light);
  color: var(--color-primary-dark);
  font-weight: 600;
}

/* + 记录 按钮视觉强化（PRD 7.1: 比 "+ New Event" 更显眼） */
.nav-cta {
  background: var(--color-primary);
  color: var(--color-text-on-primary) !important;
  font-weight: 600;
}

.nav-cta:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-on-primary) !important;
}

.nav-cta.router-link-active {
  background: var(--color-primary-dark);
  color: var(--color-text-on-primary) !important;
}

.sync-indicator-slot {
  margin-left: auto;
  flex-shrink: 0;
}
</style>
