<script setup lang="ts">
// SyncIndicator -- 全局同步状态指示器
// 对应 docs/sync-design.md §10.1 + §10.2
//
// 挂在 App.vue 导航栏, 常驻显示当前同步状态:
//   idle / pulling / pushing / editing / locked-by-other / offline / error
//
// 点击行为:
//   - idle/error → 弹小菜单 (立即同步 / 释放锁 / 设置)
//   - editing → 显示详情 + 剩余时间
//   - locked-by-other → 显示对方信息 + 剩余时间
//   - pulling/pushing → 显示进度提示
//   - offline → 重试按钮
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSync, type SyncState } from '@/composables/useSync';

const router = useRouter();
const {
  syncState,
  syncError,
  serverVersion,
  lockHolder,
  lastSyncAt,
  lockExpiresAt,
  heartbeatFailedCount,
  checkout,
  checkin,
  forceReleaseLock,
} = useSync();

// ============================================================
// 菜单展开
// ============================================================
const showMenu = ref(false);
const isActionLoading = ref(false);
const actionError = ref<string | null>(null);

function toggleMenu(): void {
  if (isActionLoading.value) return;
  showMenu.value = !showMenu.value;
}

function closeMenu(): void {
  showMenu.value = false;
  actionError.value = null;
}

function goToSettings(): void {
  closeMenu();
  void router.push('/settings');
}

// ============================================================
// 操作
// ============================================================
async function handleCheckout(): Promise<void> {
  isActionLoading.value = true;
  actionError.value = null;
  try {
    await checkout();
    closeMenu();
  } catch {
    // checkout 内部已设 syncError
  } finally {
    isActionLoading.value = false;
  }
}

async function handleCheckin(): Promise<void> {
  isActionLoading.value = true;
  actionError.value = null;
  try {
    await checkin();
    closeMenu();
  } catch {
    // checkin 内部已设 syncError
  } finally {
    isActionLoading.value = false;
  }
}

async function handleForceRelease(): Promise<void> {
  isActionLoading.value = true;
  actionError.value = null;
  try {
    await forceReleaseLock();
    closeMenu();
  } catch {
    // pass
  } finally {
    isActionLoading.value = false;
  }
}

// ============================================================
// 剩余时间倒计时 (editing 状态)
// ============================================================
const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

const remainingMs = computed<number | null>(() => {
  if (lockExpiresAt.value === null) return null;
  return lockExpiresAt.value.getTime() - now.value;
});

const remainingMinutes = computed<number | null>(() => {
  if (remainingMs.value === null) return null;
  return Math.max(0, Math.ceil(remainingMs.value / 60000));
});

const isLockExpiringSoon = computed<boolean>(() => {
  return remainingMs.value !== null && remainingMs.value <= 5 * 60 * 1000 && remainingMs.value > 0;
});

// ============================================================
// 显示文案 + 样式
// ============================================================
interface DisplayConfig {
  icon: string;
  text: string;
  title: string;
  className: string;
  spinning: boolean;
  flashing: boolean;
}

const display = computed<DisplayConfig>(() => {
  const state = syncState.value as SyncState;
  switch (state) {
    case 'idle':
      return {
        icon: '\u23F8', // pause symbol
        text: serverVersion.value !== null ? `\u5DF2\u540C\u6B65 v${serverVersion.value}` : '\u672A\u540C\u6B65',
        title: lastSyncAt.value !== null
          ? `\u6700\u540E\u540C\u6B65: ${formatRelativeTime(lastSyncAt.value)}`
          : '\u5C1A\u672A\u540C\u6B65',
        className: 'state-idle',
        spinning: false,
        flashing: false,
      };
    case 'pulling':
      return {
        icon: '\u2B07\uFE0F',
        text: '\u62C9\u53D6\u4E2D...',
        title: '\u6B63\u5728\u4ECE\u670D\u52A1\u5668\u62C9\u53D6\u6570\u636E',
        className: 'state-pulling',
        spinning: true,
        flashing: false,
      };
    case 'pushing':
      return {
        icon: '\u2B06\uFE0F',
        text: '\u4E0A\u4F20\u4E2D...',
        title: '\u6B63\u5728\u4E0A\u4F20\u5230\u670D\u52A1\u5668',
        className: 'state-pushing',
        spinning: true,
        flashing: false,
      };
    case 'editing': {
      const remain = remainingMinutes.value;
      const remainText = remain !== null ? ` \u5269${remain}\u5206\u949F` : '';
      const warn = isLockExpiringSoon.value ? '! ' : '';
      return {
        icon: '\u270F\uFE0F',
        text: `\u7F16\u8F91\u4E2D${warn}${remainText}`,
        title: '\u70B9\u51FB\u5B8C\u6210\u7F16\u8F91\u5E76\u540C\u6B65',
        className: isLockExpiringSoon.value ? 'state-editing-warn' : 'state-editing',
        spinning: false,
        flashing: isLockExpiringSoon.value,
      };
    }
    case 'locked-by-other': {
      const label = lockHolder.value?.clientLabel ?? '\u5176\u4ED6\u8BBE\u5907';
      return {
        icon: '\uD83D\uDD12',
        text: `${label}\u7F16\u8F91\u4E2D`,
        title: '\u53EA\u8BFB\u6A21\u5F0F, \u7B49\u5F85\u9501\u91CA\u653E',
        className: 'state-locked',
        spinning: false,
        flashing: false,
      };
    }
    case 'offline':
      return {
        icon: '\u26A0\uFE0F',
        text: '\u79BB\u7EBF',
        title: '\u65E0\u6CD5\u8FDE\u63A5\u670D\u52A1\u5668',
        className: 'state-offline',
        spinning: false,
        flashing: false,
      };
    case 'error':
      return {
        icon: '\u274C',
        text: '\u540C\u6B65\u9519\u8BEF',
        title: syncError.value?.message ?? '\u540C\u6B65\u9519\u8BEF',
        className: 'state-error',
        spinning: false,
        flashing: false,
      };
    default:
      return {
        icon: '?',
        text: '\u672A\u77E5',
        title: '',
        className: 'state-idle',
        spinning: false,
        flashing: false,
      };
  }
});

// ============================================================
// 辅助
// ============================================================
function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '\u521A\u521A';
  if (minutes < 60) return `${minutes} \u5206\u949F\u524D`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} \u5C0F\u65F6\u524D`;
  const days = Math.floor(hours / 24);
  return `${days} \u5929\u524D`;
}

// ============================================================
// 外部点击关闭菜单
// ============================================================
const indicatorRef = ref<HTMLElement | null>(null);

function handleDocumentClick(e: MouseEvent): void {
  if (showMenu.value && indicatorRef.value && !indicatorRef.value.contains(e.target as Node)) {
    closeMenu();
  }
}

// ============================================================
// 生命周期
// ============================================================
onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 30000); // 每 30 秒更新倒计时
  document.addEventListener('click', handleDocumentClick);
});

onUnmounted(() => {
  if (nowTimer !== null) clearInterval(nowTimer);
  document.removeEventListener('click', handleDocumentClick);
});
</script>

<template>
  <div ref="indicatorRef" class="sync-indicator-wrapper">
    <button
      type="button"
      class="sync-indicator-btn"
      :class="[display.className, { flashing: display.flashing }]"
      :title="display.title"
      @click.stop="toggleMenu"
    >
      <span class="sync-icon" :class="{ spinning: display.spinning }">{{ display.icon }}</span>
      <span class="sync-text">{{ display.text }}</span>
      <span
        v-if="heartbeatFailedCount >= 1 && syncState === 'editing'"
        class="sync-warn-dot"
        title="\u7F51\u7EDC\u5F02\u5E38, \u9501\u53EF\u80FD\u4E22\u5931"
      ></span>
    </button>

    <!-- 下拉菜单 -->
    <div v-if="showMenu" class="sync-menu">
      <!-- 状态详情 -->
      <div class="menu-section menu-info">
        <p v-if="syncState === 'idle'" class="menu-info-line">
          \u6700\u540E\u540C\u6B65: {{ lastSyncAt ? formatRelativeTime(lastSyncAt) : '\u672A\u540C\u6B65' }}
        </p>
        <p v-if="serverVersion !== null" class="menu-info-line">
          \u670D\u52A1\u5668\u7248\u672C: v{{ serverVersion }}
        </p>
        <p v-if="lockHolder" class="menu-info-line">
          \u9501\u4E3B: {{ lockHolder.clientLabel }}
        </p>
        <p v-if="lockExpiresAt && (syncState === 'editing' || syncState === 'locked-by-other')" class="menu-info-line">
          \u8FC7\u671F\u65F6\u95F4: {{ lockExpiresAt.toLocaleTimeString() }}
        </p>
        <p v-if="syncError" class="menu-info-line menu-info-error">
          {{ syncError.message }}
        </p>
      </div>

      <!-- 操作按钮 -->
      <div class="menu-section">
        <button
          v-if="syncState === 'editing'"
          type="button"
          class="btn btn-primary btn-small menu-btn"
          :disabled="isActionLoading"
          @click="handleCheckin"
        >
          {{ isActionLoading ? '\u5904\u7406\u4E2D...' : '\u5B8C\u6210\u7F16\u8F91\u5E76\u540C\u6B65' }}
        </button>

        <button
          v-if="syncState === 'idle'"
          type="button"
          class="btn btn-primary btn-small menu-btn"
          :disabled="isActionLoading"
          @click="handleCheckout"
        >
          {{ isActionLoading ? '\u5904\u7406\u4E2D...' : '\u7ACB\u5373\u62C9\u53D6\u5E76\u7F16\u8F91' }}
        </button>

        <button
          v-if="syncState === 'error'"
          type="button"
          class="btn btn-secondary btn-small menu-btn"
          :disabled="isActionLoading"
          @click="handleCheckout"
        >
          \u91CD\u65B0\u62C9\u53D6
        </button>

        <button
          v-if="syncState === 'locked-by-other' || syncState === 'error' || syncState === 'editing'"
          type="button"
          class="btn btn-secondary btn-small menu-btn"
          :disabled="isActionLoading"
          @click="handleForceRelease"
        >
          \u5F3A\u5236\u91CA\u653E\u9501
        </button>

        <button
          type="button"
          class="btn btn-ghost btn-small menu-btn"
          @click="goToSettings"
        >
          \u540C\u6B65\u8BBE\u7F6E
        </button>
      </div>

      <p v-if="actionError" class="menu-error">{{ actionError }}</p>
    </div>
  </div>
</template>

<style scoped>
.sync-indicator-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.sync-indicator-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.35rem 0.7rem;
  border: none;
  border-radius: var(--radius-pill);
  font-size: var(--font-size-small);
  font-family: var(--font-family-base);
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  background: transparent;
  white-space: nowrap;
}

.sync-icon {
  font-size: 0.9rem;
  line-height: 1;
}

.sync-icon.spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}

.sync-text {
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-medium);
}

/* === 状态颜色 === */
.state-idle {
  color: var(--color-success);
  background: var(--color-success-light);
}

.state-pulling,
.state-pushing {
  color: var(--color-primary-dark);
  background: var(--color-primary-light);
}

.state-editing {
  color: var(--color-warning-text);
  background: var(--color-warning-light);
}

.state-editing-warn {
  color: var(--color-danger-text);
  background: var(--color-danger-light);
  border: 1px solid var(--color-danger-border);
}

.state-locked {
  color: var(--color-text-muted);
  background: var(--color-bg-muted);
}

.state-offline {
  color: var(--color-text-muted);
  background: var(--color-bg-muted);
  opacity: 0.7;
}

.state-error {
  color: var(--color-danger-text);
  background: var(--color-danger-light);
}

/* === 闪烁动画 (锁快过期) === */
.flashing {
  animation: pulse-warn 1.5s ease-in-out infinite;
}

@keyframes pulse-warn {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* === 心跳失败警告点 === */
.sync-warn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-danger);
  display: inline-block;
  animation: pulse-warn 1s ease-in-out infinite;
}

/* === 下拉菜单 === */
.sync-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 0.4rem;
  min-width: 260px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-modal);
  z-index: 50;
  overflow: hidden;
}

.menu-section {
  padding: 0.6rem 0.8rem;
}

.menu-section + .menu-section {
  border-top: 1px solid var(--color-border-default);
}

.menu-info {
  font-size: var(--font-size-small);
  color: var(--color-text-secondary);
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.menu-info-line {
  margin: 0;
}

.menu-info-error {
  color: var(--color-danger-text);
  font-weight: var(--font-weight-medium);
}

.menu-btn {
  width: 100%;
  text-align: center;
  margin-bottom: 0.35rem;
}

.menu-btn:last-child {
  margin-bottom: 0;
}

.menu-error {
  margin: 0;
  padding: 0.4rem 0.8rem;
  font-size: var(--font-size-small);
  color: var(--color-danger-text);
  background: var(--color-danger-light);
}
</style>
