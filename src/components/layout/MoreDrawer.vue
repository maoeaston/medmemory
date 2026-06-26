<script setup lang="ts">
// MoreDrawer — 移动端 "更多" 抽屉, 从底部上滑的半屏 sheet
//
// 容纳 tab bar 放不下的次级入口: 成员 / 时间线 / 搜索 / 生长曲线 / 设置
// 与 BottomTabBar 互斥 (桌面 ≥1024px 都不显示)
//
// 交互: v-model:open 双向绑定; backdrop 点击 / ESC 关闭; body scroll lock
import { RouterLink } from 'vue-router';
import { onMounted, onUnmounted, watch } from 'vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();

function close(): void {
  emit('update:open', false);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) close();
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));

// body scroll lock
watch(
  () => props.open,
  (v) => {
    if (typeof document !== 'undefined') {
      document.body.style.overflow = v ? 'hidden' : '';
    }
  },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-up">
      <div v-if="open" class="drawer-overlay" @click.self="close">
        <div class="drawer-sheet" role="dialog" aria-label="更多功能">
          <div class="drag-handle" aria-hidden="true"></div>
          <h3 class="drawer-title">更多</h3>
          <nav class="drawer-nav">
            <RouterLink to="/members" class="drawer-item" @click="close">
              <span class="drawer-icon" aria-hidden="true">👤</span>
              <span>成员</span>
            </RouterLink>
            <RouterLink to="/timeline" class="drawer-item" @click="close">
              <span class="drawer-icon" aria-hidden="true">📅</span>
              <span>时间线</span>
            </RouterLink>
            <RouterLink to="/search" class="drawer-item" @click="close">
              <span class="drawer-icon" aria-hidden="true">🔍</span>
              <span>搜索</span>
            </RouterLink>
            <RouterLink to="/growth" class="drawer-item" @click="close">
              <span class="drawer-icon" aria-hidden="true">📈</span>
              <span>生长曲线</span>
            </RouterLink>
            <RouterLink to="/settings" class="drawer-item" @click="close">
              <span class="drawer-icon" aria-hidden="true">⚙️</span>
              <span>设置</span>
            </RouterLink>
          </nav>
          <button type="button" class="drawer-close" @click="close">关闭</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.drawer-sheet {
  background: var(--color-bg-card);
  width: 100%;
  max-width: 480px;
  border-radius: var(--radius-card) var(--radius-card) 0 0;
  padding: 0.75rem 1rem calc(1rem + var(--safe-area-bottom));
  box-shadow: var(--shadow-modal);
}

.drag-handle {
  width: 36px;
  height: 4px;
  background: var(--color-border-default);
  border-radius: 2px;
  margin: 0 auto 0.75rem;
}

.drawer-title {
  margin: 0 0 0.75rem;
  font-size: var(--font-size-section-title);
  color: var(--color-text-primary);
  text-align: center;
}

.drawer-nav {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.drawer-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  text-decoration: none;
  color: var(--color-text-primary);
  border-radius: var(--radius-input);
  font-size: var(--font-size-body);
  min-height: var(--touch-target-min);
  transition: background var(--duration-fast);
}

.drawer-item:hover {
  background: var(--color-bg-muted);
}

.drawer-item.router-link-active {
  background: var(--color-primary-light);
  color: var(--color-primary-dark);
  font-weight: var(--font-weight-semibold);
}

.drawer-icon {
  font-size: 1.25rem;
  width: 1.5rem;
  text-align: center;
}

.drawer-close {
  margin-top: 0.75rem;
  width: 100%;
  padding: 0.6rem;
  background: var(--color-bg-muted);
  border: none;
  border-radius: var(--radius-button);
  color: var(--color-text-secondary);
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  font-family: inherit;
  cursor: pointer;
  min-height: var(--touch-target-min);
}

/* Transition: overlay fade + sheet slide-up */
.sheet-up-enter-active,
.sheet-up-leave-active {
  transition: opacity var(--duration-normal) var(--ease-standard);
}

.sheet-up-enter-active .drawer-sheet,
.sheet-up-leave-active .drawer-sheet {
  transition: transform var(--duration-normal) var(--ease-decel);
}

.sheet-up-enter-from,
.sheet-up-leave-to {
  opacity: 0;
}

.sheet-up-enter-from .drawer-sheet,
.sheet-up-leave-to .drawer-sheet {
  transform: translateY(100%);
}

/* 桌面 ≥1024px 不显示 (AppShell 不会触发, 防御性隐藏) */
@media (min-width: 1024px) {
  .drawer-overlay {
    display: none;
  }
}
</style>
