<script setup lang="ts">
// ModalOverlay —— 通用 modal 容器
// 提供: 固定全屏 overlay + 居中/bottom-sheet/fullscreen 三变体 + ESC 关闭 + 点背景关闭 + 阻止背景滚动
//
// 变体选择 (variant prop):
//   - 'centered'     桌面默认: 居中卡片
//   - 'bottom-sheet' 移动默认 (<=1023px): 底部上滑 sheet, 顶部圆角 + drag handle
//   - 'fullscreen'   显式指定 (长内容如 AI 解读): 100dvh, 无圆角
//
// 内部 isVisible 双相:
//   - mount 后 nextTick 设 true → 触发 enter 动画
//   - close 时 isVisible=false, 250ms 后 emit('close'), 让 leave 动画跑完
//   - 配合 caller 的 v-if 模式: 动画期间组件还在, emit 后才卸载
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps<{
  title?: string;
  /** 宽度: 'sm' | 'md' | 'lg'（默认 md, 仅 centered 生效） */
  width?: 'sm' | 'md' | 'lg';
  /** 显式变体; 不传则自动: 移动=bottom-sheet, 桌面=centered */
  variant?: 'centered' | 'bottom-sheet' | 'fullscreen';
}>();

const emit = defineEmits<{ close: [] }>();

// ============================================================
// 响应式断点检测
// ============================================================
const mql = typeof window !== 'undefined' ? window.matchMedia('(max-width: 1023px)') : null;
const isMobile = ref(mql?.matches ?? false);

function updateIsMobile(e: MediaQueryListEvent): void {
  isMobile.value = e.matches;
}

const resolvedVariant = computed(() => {
  if (props.variant) return props.variant;
  return isMobile.value ? 'bottom-sheet' : 'centered';
});

// ============================================================
// 内部 isVisible (双相关闭)
// ============================================================
const isVisible = ref(false);

function emitClose(): void {
  emit('close');
}

function handleClose(): void {
  isVisible.value = false;
  // 等 leave 动画跑完再真正卸载
  setTimeout(emitClose, 250);
}

// ============================================================
// 键盘 / 背景点击
// ============================================================
function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    handleClose();
  }
}

function handleBackdropClick(e: MouseEvent): void {
  // fullscreen 不允许点空白关闭 (空白即内容)
  if (resolvedVariant.value === 'fullscreen') return;
  if (e.target === e.currentTarget) {
    handleClose();
  }
}

// ============================================================
// 生命周期: mount → enter, unmount → 清理
// ============================================================
onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  document.body.style.overflow = 'hidden';
  mql?.addEventListener('change', updateIsMobile);
  // nextTick 确保 leave-start 类先应用, 再切到 enter-from
  void nextTick(() => {
    isVisible.value = true;
  });
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  document.body.style.overflow = '';
  mql?.removeEventListener('change', updateIsMobile);
});
</script>

<template>
  <Teleport to="body">
    <Transition
      :name="resolvedVariant === 'centered' ? 'modal-fade' : 'sheet-up'"
    >
      <div
        v-show="isVisible"
        class="modal-overlay"
        :class="`overlay-${resolvedVariant}`"
        role="dialog"
        aria-modal="true"
        :aria-label="props.title"
        @click="handleBackdropClick"
      >
        <div :class="['modal-card', `modal-${props.width ?? 'md'}`, `variant-${resolvedVariant}`]">
          <div
            v-if="resolvedVariant !== 'centered'"
            class="drag-handle"
            aria-hidden="true"
          />
          <header v-if="props.title || $slots.header" class="modal-header">
            <slot name="header">
              <h2 class="modal-title">{{ props.title }}</h2>
            </slot>
            <button
              type="button"
              class="modal-close"
              aria-label="关闭"
              @click="handleClose"
            >
              ×
            </button>
          </header>
          <div class="modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* === overlay 基础 === */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
}

/* === overlay: centered (桌面默认) === */
.overlay-centered {
  align-items: flex-start;
  justify-content: center;
  padding: 5vh 1rem 1rem;
  overflow-y: auto;
}

/* === overlay: bottom-sheet (移动默认) === */
.overlay-bottom-sheet {
  align-items: flex-end;
  justify-content: stretch;
  padding: 0;
}

/* === overlay: fullscreen === */
.overlay-fullscreen {
  align-items: stretch;
  justify-content: stretch;
  padding: 0;
  padding-top: var(--safe-area-top);
}

/* === card 基础 === */
.modal-card {
  background: var(--color-bg-card);
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* === card: centered === */
.variant-centered {
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-modal);
  max-height: 90vh;
}

.modal-sm { max-width: 420px; }
.modal-md { max-width: 600px; }
.modal-lg { max-width: 800px; }

/* === card: bottom-sheet === */
.variant-bottom-sheet {
  border-radius: var(--radius-card) var(--radius-card) 0 0;
  box-shadow: var(--shadow-modal);
  max-height: 92vh;
  /* safe-area-bottom 由 footer / body 兜底, 此处整体留 padding */
  padding-bottom: var(--safe-area-bottom);
}

/* === card: fullscreen === */
.variant-fullscreen {
  border-radius: 0;
  box-shadow: none;
  height: 100dvh;
  max-height: 100dvh;
}

/* centered 宽度限制在 overlay-centered padding 内自然实现,
   bottom-sheet / fullscreen 走 width:100% (上面 .modal-card 已设) */
.variant-bottom-sheet,
.variant-fullscreen {
  max-width: none;
}

/* === drag handle (仅 bottom-sheet / fullscreen 顶部) === */
.drag-handle {
  flex-shrink: 0;
  width: 36px;
  height: 4px;
  background: var(--color-border-input);
  border-radius: var(--radius-pill);
  margin: 0.5rem auto 0;
}

/* === header / body / footer === */
.modal-header {
  padding: var(--space-card-padding);
  border-bottom: 1px solid var(--color-border-default);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.modal-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.modal-close {
  background: transparent;
  border: none;
  font-size: 1.6rem;
  line-height: 1;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-badge);
  transition: background 0.15s, color 0.15s;
  min-height: var(--touch-target-min);
  min-width: var(--touch-target-min);
}

.modal-close:hover {
  background: var(--color-bg-muted);
  color: var(--color-text-primary);
}

.modal-body {
  padding: 1.25rem;
  overflow-y: auto;
  flex: 1;
}

.modal-footer {
  padding: 0.75rem 1.25rem;
  border-top: 1px solid var(--color-border-default);
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  background: var(--color-bg-page);
  border-radius: 0 0 var(--radius-card) var(--radius-card);
}

/* fullscreen 的 footer 不需要圆角 (顶部无圆角对应) */
.variant-fullscreen .modal-footer {
  border-radius: 0;
  padding-bottom: calc(0.75rem + var(--safe-area-bottom));
}
</style>

<!-- 全局 transition (非 scoped, 让 .modal-fade/sheet-up 类作用在 Transition 生成的 wrapper 上) -->
<style>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--duration-normal) var(--ease-decel);
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

/* sheet-up: overlay 整体淡入, card 从底部滑入.
   因为 Transition 直接作用在 .modal-overlay (v-show 根元素),
   只能用 opacity + transform 在同一元素上做. */
.sheet-up-enter-active {
  transition: opacity var(--duration-normal) var(--ease-decel);
}
.sheet-up-leave-active {
  transition: opacity var(--duration-fast) var(--ease-accel);
}
.sheet-up-enter-from,
.sheet-up-leave-to {
  opacity: 0;
}
.sheet-up-enter-active .modal-card,
.sheet-up-leave-active .modal-card {
  transition: transform var(--duration-normal) var(--ease-decel);
}
.sheet-up-enter-from .modal-card,
.sheet-up-leave-to .modal-card {
  transform: translateY(100%);
}
</style>
