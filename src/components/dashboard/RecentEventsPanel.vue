<script setup lang="ts">
// RecentEventsPanel —— Dashboard 底部"最近事件"列表
// PRD 7.2: 跨成员显示最近 N 条医疗事件
//
// 接受 props.events 为父组件已查好的 listRecent(10) 结果
// 关联成员名通过 props.memberMap 反查（O(1) 查找）
import { computed } from 'vue';
import type { FamilyMember, MedicalEvent } from '@/repositories';

const props = defineProps<{
  events: MedicalEvent[] | null;
  memberMap: Map<number, FamilyMember> | null;
  loadError?: string | null;
}>();

const eventTypeLabels: Record<MedicalEvent['event_type'], string> = {
  outpatient: '就诊',
  emergency: '急诊',
  checkup: '体检',
  followup: '复诊',
  vaccine: '疫苗',
  hospitalization: '住院',
  other: '其他',
};

function formatDate(iso: string): string {
  const datePart = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return iso;
  return datePart.slice(5); // MM-DD
}

function memberName(memberId: number): string {
  const m = props.memberMap?.get(memberId);
  return m ? m.name : `#${memberId}`;
}

const hasEvents = computed(
  () => props.events !== null && props.events.length > 0,
);
</script>

<template>
  <section class="recent-panel">
    <header class="panel-header">
      <h2 class="panel-title">📅 最近事件</h2>
    </header>

    <div v-if="loadError" class="msg msg-error">
      加载失败: {{ loadError }}
    </div>

    <div v-else-if="props.events === null" class="hint">加载中...</div>

    <div v-else-if="!hasEvents" class="empty-state">
      暂无医疗事件。先去
      <RouterLink to="/capture" class="link">快速记录</RouterLink>
      一些信息。
    </div>

    <ul v-else class="event-list">
      <li
        v-for="event in props.events"
        :key="event.id"
        class="event-item"
      >
        <span class="event-date">{{ formatDate(event.event_date) }}</span>
        <span class="event-type">
          {{ eventTypeLabels[event.event_type] }}
        </span>
        <span class="event-member">{{ memberName(event.member_id) }}</span>
        <span class="event-title">{{ event.title }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.recent-panel {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem 1.25rem;
}

.panel-header {
  margin-bottom: 0.75rem;
}

.panel-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
}

.hint {
  color: #9ca3af;
  font-size: 0.88rem;
}

.empty-state {
  color: #6b7280;
  font-size: 0.88rem;
  padding: 0.75rem;
  background: #f9fafb;
  border-radius: 4px;
  text-align: center;
}

.link {
  color: #2563eb;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.event-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.event-item {
  display: grid;
  grid-template-columns: 3rem 3rem 4rem 1fr;
  gap: 0.5rem;
  align-items: baseline;
  padding: 0.35rem 0;
  font-size: 0.88rem;
  border-bottom: 1px dashed #f3f4f6;
}

.event-item:last-child {
  border-bottom: none;
}

.event-date {
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.event-type {
  font-size: 0.78rem;
  color: #2563eb;
  background: #eff6ff;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  text-align: center;
  white-space: nowrap;
}

.event-member {
  color: #4b5563;
  font-weight: 500;
}

.event-title {
  color: #1f2937;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg {
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: 4px;
  font-size: 0.88rem;
}

.msg-error {
  background: #fef2f2;
  color: #991b1b;
}

@media (max-width: 540px) {
  .event-item {
    grid-template-columns: 3rem 3rem 1fr;
    grid-template-rows: auto auto;
  }
  .event-member {
    grid-column: 3;
    grid-row: 1;
  }
  .event-title {
    grid-column: 1 / -1;
    grid-row: 2;
    color: #6b7280;
    font-size: 0.85rem;
  }
}
</style>
