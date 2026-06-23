<script setup lang="ts">
// EventTypeBadge —— 医疗事件类型标签（单一真理源）
//
// 替代原本散落在 6 个文件的 labelMap + 4 份 .event-type CSS 副本。
// 解决:
//   1. 文案不一致: outpatient 在不同页面是「门诊」「门诊就诊」「就诊」— 此处统一「门诊」
//   2. 全蓝无色编码: 7 类事件 7 种色, 便于扫读
//
// 色编码语义:
//   emergency=红（紧急） / checkup=绿（常规积极） / vaccine=紫（预防独特）
//   hospitalization=琥珀（严重长期） / outpatient+followup=蓝（常规诊疗）
//   other=灰（兜底）
import type { EventType } from '@/repositories';

defineProps<{
  type: EventType;
}>();

// canonical label map — 与 TrendsView/ArchiveForm 等所有调用方共享
const labelMap: Record<EventType, string> = {
  outpatient: '门诊',
  emergency: '急诊',
  checkup: '体检',
  followup: '复诊',
  vaccine: '疫苗',
  hospitalization: '住院',
  other: '其他',
};
</script>

<template>
  <span :class="['event-type-badge', `event-type-${type}`]">
    {{ labelMap[type] }}
  </span>
</template>

<style scoped>
.event-type-badge {
  flex-shrink: 0;
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-badge);
  font-size: var(--font-size-badge);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  text-align: center;
  line-height: 1.4;
}

/* 7 类事件 — 引用 tokens.css 的 --color-event-* 对 */
.event-type-outpatient {
  background: var(--color-event-outpatient-bg);
  color: var(--color-event-outpatient);
}

.event-type-emergency {
  background: var(--color-event-emergency-bg);
  color: var(--color-event-emergency);
}

.event-type-checkup {
  background: var(--color-event-checkup-bg);
  color: var(--color-event-checkup);
}

.event-type-followup {
  background: var(--color-event-followup-bg);
  color: var(--color-event-followup);
}

.event-type-vaccine {
  background: var(--color-event-vaccine-bg);
  color: var(--color-event-vaccine);
}

.event-type-hospitalization {
  background: var(--color-event-hospitalization-bg);
  color: var(--color-event-hospitalization);
}

.event-type-other {
  background: var(--color-event-other-bg);
  color: var(--color-event-other);
}
</style>
