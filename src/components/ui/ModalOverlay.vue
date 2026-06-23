<script setup lang="ts">
// ModalOverlay —— 通用 modal 容器
// 提供: 固定全屏 overlay + 居中卡片 + ESC 关闭 + 点背景关闭 + 阻止背景滚动
//
// 用法:
//   <ModalOverlay :title="..." @close="...">
//     <slot />  内容塞这里
//     <template #footer>...</template>
//   </ModalOverlay>
//
// 不引入第三方 modal 库: 家庭场景使用频次低, 原生实现足够
import { onMounted, onUnmounted } from 'vue';

const props = defineProps<{
  title?: string;
  /** 宽度: 'sm' | 'md' | 'lg'（默认 md） */
  width?: 'sm' | 'md' | 'lg';
}>();

const emit = defineEmits<{
  close: [];
}>();

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

function handleBackdropClick(e: MouseEvent): void {
  // 只在点击 overlay 本身（非内部 card）时关闭
  if (e.target === e.currentTarget) {
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  // 阻止背景滚动
  document.body.style.overflow = 'hidden';
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <div
      class="modal-overlay"
      role="dialog"
      aria-modal="true"
      :aria-label="props.title"
      @click="handleBackdropClick"
    >
      <div :class="['modal-card', `modal-${props.width ?? 'md'}`]">
        <header v-if="props.title || $slots.header" class="modal-header">
          <slot name="header">
            <h2 class="modal-title">{{ props.title }}</h2>
          </slot>
          <button
            type="button"
            class="modal-close"
            aria-label="关闭"
            @click="emit('close')"
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
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 5vh 1rem 1rem;
  overflow-y: auto;
  z-index: 100;
}

.modal-card {
  background: var(--color-bg-card);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  max-height: 90vh;
  width: 100%;
}

.modal-sm {
  max-width: 420px;
}

.modal-md {
  max-width: 600px;
}

.modal-lg {
  max-width: 800px;
}

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
</style>
