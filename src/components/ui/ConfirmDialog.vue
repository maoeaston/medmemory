<script setup lang="ts">
// ConfirmDialog —— 通用确认对话框
// 用于: 删除成员（CASCADE 警告） / 删除事件 / 其他危险操作
//
// 基于 ModalOverlay 构建, 固定 sm 宽度 + danger 风格按钮
// 接受 loading 状态（删除进行中禁用按钮）
import ModalOverlay from './ModalOverlay.vue';

const props = withDefaults(
  defineProps<{
    title?: string;
    message: string;
    /** 详尽说明（多行, 灰色小字, 用于列出影响范围） */
    detail?: string;
    confirmText?: string;
    cancelText?: string;
    /** 确认按钮风格: 危险操作红色 */
    danger?: boolean;
    loading?: boolean;
    errorMessage?: string | null;
  }>(),
  {
    title: '请确认',
    confirmText: '确认',
    cancelText: '取消',
    danger: false,
    loading: false,
    errorMessage: null,
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <ModalOverlay
    :title="props.title"
    width="sm"
    @close="emit('cancel')"
  >
    <p class="confirm-message">{{ props.message }}</p>
    <p v-if="props.detail" class="confirm-detail">{{ props.detail }}</p>
    <p v-if="props.errorMessage" class="confirm-error">{{ props.errorMessage }}</p>

    <template #footer>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="props.loading"
        @click="emit('cancel')"
      >
        {{ props.cancelText }}
      </button>
      <button
        type="button"
        :class="['btn', props.danger ? 'btn-danger-solid' : 'btn-primary']"
        :disabled="props.loading"
        @click="emit('confirm')"
      >
        {{ props.loading ? '处理中...' : props.confirmText }}
      </button>
    </template>
  </ModalOverlay>
</template>

<style scoped>
.confirm-message {
  margin: 0 0 0.5rem;
  font-size: 1rem;
  color: var(--color-text-primary);
  line-height: 1.5;
}

.confirm-detail {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--color-text-muted);
  line-height: 1.5;
  white-space: pre-line;
}

.confirm-error {
  margin: 0.5rem 0 0;
  font-size: var(--font-size-small);
  color: var(--color-danger-text);
  background: var(--color-danger-light);
  padding: 0.5rem;
  border-radius: var(--radius-badge);
}
</style>
