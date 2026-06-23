<script setup lang="ts">
// StatusBadge —— 统一状态色渲染
//
// 跨场景复用:
//   - 药品过期状态: expired / soon / ok
//   - 附件处理状态: pending / processing / done / failed
//
// 替代原本 MedicinesView/MedicineWarningPanel/AlertBanner/AttachmentPreview 各写一套。
// 色板: expired=红 / soon=琥珀 / ok=绿 / pending=灰 / processing=琥珀动态 / done=绿 / failed=红
import { computed } from 'vue';

type Variant =
  | 'expired'
  | 'soon'
  | 'ok'
  | 'processing'
  | 'done'
  | 'failed'
  | 'pending';

const props = defineProps<{
  variant: Variant;
  /** 可选 label override; 不传走 variant 默认文案 */
  label?: string;
}>();

const defaultLabels: Record<Variant, string> = {
  expired: '已过期',
  soon: '即将过期',
  ok: '正常',
  processing: '处理中',
  done: '已完成',
  failed: '失败',
  pending: '待处理',
};

const text = computed(() => props.label ?? defaultLabels[props.variant]);
</script>

<template>
  <span :class="['status-badge', `status-${props.variant}`]">
    {{ text }}
  </span>
</template>

<style scoped>
.status-badge {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: var(--radius-badge);
  font-size: var(--font-size-badge);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  line-height: 1.4;
}

/* 药品过期三态 */
.status-expired {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}

.status-soon {
  background: var(--color-warning-light);
  color: var(--color-warning-text);
}

.status-ok {
  background: var(--color-success-light);
  color: var(--color-success);
}

/* 附件处理四态 */
.status-pending {
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
}

.status-processing {
  background: #fef3c7;
  color: var(--color-warning-text);
}

.status-done {
  background: #d1fae5;
  color: var(--color-success);
}

.status-failed {
  background: #fee2e2;
  color: var(--color-danger-text);
}
</style>
