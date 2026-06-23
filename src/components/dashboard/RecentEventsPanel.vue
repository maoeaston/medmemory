<script setup lang="ts">
// RecentEventsPanel —— Dashboard 底部"最近事件"列表
// PRD 7.2: 跨成员显示最近 N 条医疗事件
//
// 接受 props.events 为父组件已查好的 listRecent(10) 结果
// 关联成员名通过 props.memberMap 反查（O(1) 查找）
//
// 每行可点击进入 /events/:id 详情（含附件 / 指标 / AI 摘要）— v3.3 入口修复
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import EventTypeBadge from '@/components/ui/EventTypeBadge.vue';
import type { FamilyMember, MedicalEvent } from '@/repositories';

const props = defineProps<{
  events: MedicalEvent[] | null;
  memberMap: Map<number, FamilyMember> | null;
  loadError?: string | null;
}>();

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
        <RouterLink :to="`/events/${event.id}`" class="event-link">
          <span class="event-date">{{ formatDate(event.event_date) }}</span>
          <EventTypeBadge :type="event.event_type" />
          <span class="event-member">{{ memberName(event.member_id) }}</span>
          <span class="event-title">{{ event.title }}</span>
          <span class="event-arrow">›</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.recent-panel {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: var(--space-card-padding);
}

.panel-header {
  margin-bottom: 0.75rem;
}

.panel-title {
  margin: 0;
  font-size: var(--font-size-panel-title);
  font-weight: var(--font-weight-semibold);
}

.hint {
  color: var(--color-text-faint);
  font-size: 0.88rem;
}

.empty-state {
  color: var(--color-text-muted);
  font-size: 0.88rem;
  padding: 0.75rem;
  background: var(--color-bg-page);
  border-radius: var(--radius-badge);
  text-align: center;
}

.link {
  color: var(--color-primary);
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
  padding: 0.35rem 0;
  border-bottom: 1px dashed var(--color-bg-muted);
}

.event-item:last-child {
  border-bottom: none;
}

.event-link {
  display: grid;
  grid-template-columns: 3rem auto 4rem 1fr auto;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.88rem;
  text-decoration: none;
  color: inherit;
  padding: 0.1rem 0.3rem;
  margin: -0.1rem -0.3rem;
  border-radius: var(--radius-badge);
  transition: background 0.15s;
}

.event-link:hover {
  background: var(--color-bg-page);
}

.event-date {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.event-member {
  color: var(--color-text-secondary);
  font-weight: var(--font-weight-medium);
}

.event-title {
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-arrow {
  color: var(--color-border-input);
  font-size: 1.2rem;
  line-height: 1;
}

.msg {
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-badge);
  font-size: 0.88rem;
}

.msg-error {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}

@media (max-width: 540px) {
  .event-link {
    grid-template-columns: 3rem auto 1fr auto;
    grid-template-rows: auto auto;
  }
  .event-member {
    grid-column: 3;
    grid-row: 1;
  }
  .event-title {
    grid-column: 1 / -1;
    grid-row: 2;
    color: var(--color-text-muted);
    font-size: var(--font-size-small);
  }
}
</style>
