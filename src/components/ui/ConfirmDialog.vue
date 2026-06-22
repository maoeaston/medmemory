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
        :class="['btn', props.danger ? 'btn-danger' : 'btn-primary']"
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
  color: #1f2937;
  line-height: 1.5;
}

.confirm-detail {
  margin: 0;
  font-size: 0.85rem;
  color: #6b7280;
  line-height: 1.5;
  white-space: pre-line;
}

.confirm-error {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: #991b1b;
  background: #fef2f2;
  padding: 0.5rem;
  border-radius: 4px;
}

.btn {
  padding: 0.55rem 1.1rem;
  border: none;
  border-radius: 6px;
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-primary {
  background: #2563eb;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.btn-danger {
  background: #dc2626;
  color: white;
}

.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

.btn-secondary {
  background: #f3f4f6;
  color: #4b5563;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
