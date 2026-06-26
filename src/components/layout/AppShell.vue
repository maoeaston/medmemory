<script setup lang="ts">
// AppShell — MedMemory 主壳 (移动 APP 化重构)
//
// 双布局:
//   - ≤1023px (移动): 顶部精简 header (brand + SyncIndicator) + 底部 BottomTabBar + MoreDrawer
//   - ≥1024px (桌面): 顶部完整横向 nav (所有 9 链接), 无 tab bar / drawer
//
// 职责下沉 (从 App.vue 迁移):
//   - useSync.initOnAppStart
//   - useInboxCount (角标)
//   - router.afterEach 刷新角标
//
// Phase 4: <RouterView> 包 <Transition>, 方向由 useRouteDirection 决定
import { computed, onMounted, ref } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import BottomTabBar from './BottomTabBar.vue';
import MoreDrawer from './MoreDrawer.vue';
import SyncIndicator from '@/components/SyncIndicator.vue';
import { useSync } from '@/composables/useSync';
import { useInboxCount } from '@/composables/useInboxCount';
import { routeDirection } from '@/composables/useRouteDirection';
import router from '@/router';

const { initOnAppStart } = useSync();
const { count: pendingInboxCount, refresh: refreshInboxCount } = useInboxCount();

const route = useRoute();

// Transition 名称: forward → slide-forward, back → slide-back, none → fade
const transitionName = computed(() => {
  switch (routeDirection.value) {
    case 'forward':
      return 'slide-forward';
    case 'back':
      return 'slide-back';
    default:
      return 'fade';
  }
});

const moreOpen = ref(false);

// standalone 检测 (PWA 启动模式)
const isStandalone = ref(false);

function updateStandalone(): void {
  if (typeof window === 'undefined') return;
  isStandalone.value =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
}

onMounted(() => {
  updateStandalone();
  void initOnAppStart();
  void refreshInboxCount();
});

// 每次路由切换刷新角标: 兜底所有数据变更入口 (capture / archive / sync)
router.afterEach(() => {
  void refreshInboxCount();
});
</script>

<template>
  <div class="app-shell" :class="{ 'is-standalone': isStandalone }">
    <header class="app-header">
      <div class="header-row">
        <RouterLink to="/dashboard" class="brand">家庭医疗记忆</RouterLink>
        <SyncIndicator class="sync-slot" />
      </div>
      <!-- 桌面 nav: 仅 ≥1024px 显示 -->
      <nav class="desktop-nav">
        <RouterLink to="/dashboard" class="nav-link">首页</RouterLink>
        <RouterLink to="/inbox" class="nav-link">
          待整理
          <span v-if="pendingInboxCount > 0" class="nav-badge">{{ pendingInboxCount }}</span>
        </RouterLink>
        <RouterLink to="/capture" class="nav-link nav-cta">+ 记录</RouterLink>
        <RouterLink to="/members" class="nav-link">成员</RouterLink>
        <RouterLink to="/timeline" class="nav-link">时间线</RouterLink>
        <RouterLink to="/search" class="nav-link">搜索</RouterLink>
        <RouterLink to="/medicines" class="nav-link">药箱</RouterLink>
        <RouterLink to="/growth" class="nav-link">生长曲线</RouterLink>
        <RouterLink to="/settings" class="nav-link">设置</RouterLink>
      </nav>
    </header>

    <main class="app-main">
      <RouterView v-slot="{ Component }">
        <Transition :name="transitionName" mode="default">
          <component :is="Component" :key="route.path" />
        </Transition>
      </RouterView>
    </main>

    <BottomTabBar @open-more="moreOpen = true" />
    <MoreDrawer v-model:open="moreOpen" />
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  min-height: 100dvh;
}

.app-header {
  background: var(--color-bg-card);
  border-bottom: 1px solid var(--color-border-default);
  padding: 0.5rem 1rem;
  /* safe-area-top 兜底: iOS notch / Android status bar */
  padding-top: max(0.5rem, var(--safe-area-top));
  position: sticky;
  top: 0;
  z-index: 20;
}

.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  max-width: var(--space-page-max-wide);
  margin: 0 auto;
}

.brand {
  font-weight: var(--font-weight-bold);
  font-size: 1.05rem;
  color: var(--color-text-primary);
  text-decoration: none;
}

.sync-slot {
  flex-shrink: 0;
}

/* === 桌面 nav (≥1024px) === */
.desktop-nav {
  display: none;
  gap: 0.4rem;
  flex-wrap: wrap;
  max-width: var(--space-page-max-wide);
  margin: 0.5rem auto 0;
}

.nav-link {
  padding: 0.4rem 0.8rem;
  border-radius: var(--radius-button);
  text-decoration: none;
  color: var(--color-text-secondary);
  font-size: 0.92rem;
  transition: background var(--duration-fast), color var(--duration-fast);
  display: inline-flex;
  align-items: center;
  min-height: var(--touch-target-min);
}

.nav-link:hover {
  background: var(--color-bg-muted);
  color: var(--color-text-primary);
}

.nav-link.router-link-active {
  background: var(--color-primary-light);
  color: var(--color-primary-dark);
  font-weight: var(--font-weight-semibold);
}

.nav-cta {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
  font-weight: var(--font-weight-semibold);
}

.nav-cta:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-on-primary);
}

.nav-cta.router-link-active {
  background: var(--color-primary-dark);
  color: var(--color-text-on-primary);
}

.nav-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 0.35rem;
  margin-left: 0.35rem;
  background: var(--color-warning);
  color: white;
  border-radius: 9999px;
  font-size: var(--font-size-btn-small);
  font-weight: var(--font-weight-semibold);
}

/* === 主内容区 === */
.app-main {
  /* 移动端给 tab bar 留空间 + safe-area-bottom */
  padding-bottom: calc(var(--tab-bar-height) + var(--safe-area-bottom));
  position: relative;
  min-height: calc(100vh - var(--tab-bar-height));
  min-height: calc(100dvh - var(--tab-bar-height));
}

@media (min-width: 1024px) {
  .desktop-nav {
    display: flex;
  }
  .app-main {
    padding-bottom: 0; /* 桌面无 tab bar */
  }
}
</style>
