<script setup lang="ts">
// EventsView —— 医疗事件列表（跨成员, 按 created_at 倒序）
//
// 数据流:
//   medicalEvent.listRecent(50) + familyMember.list()
//   → 建 id→name 反查 map
//   → 每行显示 日期/成员/类型/title, 点击跳转 /events/:id
//
// 排序说明: listRecent 走 created_at DESC（"最近录入"语义）
//   时间线视图 (/timeline) 走 event_date DESC, 职责分开
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRepositories } from '@/composables/useRepositories';
import EventTypeBadge from '@/components/ui/EventTypeBadge.vue';
import type { FamilyMember, MedicalEvent } from '@/repositories';

const router = useRouter();

const events = ref<MedicalEvent[]>([]);
const members = ref<FamilyMember[]>([]);
const loadError = ref<string | null>(null);
const isLoading = ref(false);

const memberNameMap = computed(() => {
  const m = new Map<number, { name: string; nickname: string | null }>();
  for (const mem of members.value) {
    m.set(mem.id, { name: mem.name, nickname: mem.nickname });
  }
  return m;
});

async function loadEvents(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  try {
    const repos = await useRepositories();
    const [eventsResult, membersResult] = await Promise.allSettled([
      repos.medicalEvent.listRecent(50),
      repos.familyMember.list(),
    ]);
    if (eventsResult.status === 'fulfilled') {
      events.value = eventsResult.value;
    } else {
      loadError.value =
        eventsResult.reason instanceof Error
          ? eventsResult.reason.message
          : String(eventsResult.reason);
    }
    if (membersResult.status === 'fulfilled') {
      members.value = membersResult.value;
    }
    // 成员加载失败不阻塞事件列表（memberNameMap 找不到时显示"#id"）
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

function openDetail(id: number): void {
  void router.push(`/events/${id}`);
}

function formatMember(id: number): string {
  const m = memberNameMap.value.get(id);
  if (m === undefined) return `#${id}`;
  return m.nickname ? `${m.name} (${m.nickname})` : m.name;
}

function formatCreatedAt(iso: string): string {
  // iso: 2026-06-22T14:30:00Z → 06-22 14:30
  const mt = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return mt ? `${mt[2]}-${mt[3]} ${mt[4]}:${mt[5]}` : iso;
}

onMounted(() => {
  void loadEvents();
});
</script>

<template>
  <main class="events-view">
    <header class="page-header">
      <h1 class="page-title">医疗事件</h1>
      <span class="count-badge">{{ events.length }}</span>
    </header>

    <p v-if="loadError" class="msg msg-error">加载失败: {{ loadError }}</p>
    <p v-else-if="isLoading" class="hint">加载中...</p>

    <div
      v-else-if="events.length === 0"
      class="empty-state"
    >
      <p class="empty-title">还没有医疗事件</p>
      <p class="empty-hint">
        到
        <RouterLink to="/inbox" class="link">待整理</RouterLink>
        归档捕获记录, 或到
        <RouterLink to="/capture" class="link">快速记录</RouterLink>
        录入新内容。
      </p>
    </div>

    <ul v-else class="event-list">
      <li
        v-for="ev in events"
        :key="ev.id"
      >
        <button
          type="button"
          class="event-row"
          @click="openDetail(ev.id)"
        >
          <div class="event-date">
            <span class="date-main">{{ ev.event_date }}</span>
            <span class="date-created">录入 {{ formatCreatedAt(ev.created_at) }}</span>
          </div>
          <div class="event-body">
            <div class="event-title-row">
              <EventTypeBadge :type="ev.event_type" />
              <span class="event-title">{{ ev.title }}</span>
            </div>
            <div class="event-meta">
              <span class="event-member">{{ formatMember(ev.member_id) }}</span>
              <span v-if="ev.hospital" class="event-hospital">
                · {{ ev.hospital }}<span v-if="ev.department"> / {{ ev.department }}</span>
              </span>
            </div>
            <p v-if="ev.summary" class="event-summary">{{ ev.summary }}</p>
          </div>
          <span class="event-arrow">›</span>
        </button>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.events-view {
  padding: 1.5rem;
  max-width: var(--space-page-max-width);
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 1.25rem;
}

.page-title {
  margin: 0;
  font-size: var(--font-size-page-title);
}

.count-badge {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  background: var(--color-primary-light);
  color: var(--color-primary-dark);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-meta);
  font-weight: var(--font-weight-semibold);
  min-width: 1.6rem;
  text-align: center;
}

.hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
  color: var(--color-text-muted);
}

.empty-title {
  margin: 0 0 0.4rem;
  font-size: var(--font-size-section-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-secondary);
}

.empty-hint {
  margin: 0;
  font-size: var(--font-size-body);
}

.link {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: var(--font-weight-medium);
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
  gap: 0.6rem;
}

.event-row {
  width: 100%;
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  text-align: left;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: var(--space-card-pad-tight);
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, background 0.15s;
}

.event-row:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
}

.event-date {
  flex-shrink: 0;
  width: 5.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.date-main {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
}

.date-created {
  font-size: 0.7rem;
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
}

.event-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.event-title-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.event-title {
  font-size: 1rem;
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  word-break: break-word;
}

.event-meta {
  font-size: var(--font-size-meta);
  color: var(--color-text-muted);
}

.event-summary {
  margin: 0.15rem 0 0;
  font-size: var(--font-size-small);
  color: var(--color-text-secondary);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.event-arrow {
  flex-shrink: 0;
  color: var(--color-border-input);
  font-size: 1.4rem;
  line-height: 1;
  align-self: center;
}

.msg {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius-badge);
  font-size: var(--font-size-body);
}

.msg-error {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}
</style>
