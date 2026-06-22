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
import type {
  EventType,
  FamilyMember,
  MedicalEvent,
} from '@/repositories';

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

const eventTypeLabel: Record<EventType, string> = {
  outpatient: '门诊',
  emergency: '急诊',
  checkup: '体检',
  followup: '复诊',
  vaccine: '疫苗',
  hospitalization: '住院',
  other: '其他',
};

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
              <span class="event-type">{{ eventTypeLabel[ev.event_type] }}</span>
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
  max-width: 720px;
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
  font-size: 1.5rem;
}

.count-badge {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  background: #eff6ff;
  color: #1e40af;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 600;
  min-width: 1.6rem;
  text-align: center;
}

.hint {
  color: #6b7280;
  font-size: 0.9rem;
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  background: #f9fafb;
  border-radius: 6px;
  color: #6b7280;
}

.empty-title {
  margin: 0 0 0.4rem;
  font-size: 1.1rem;
  font-weight: 600;
  color: #4b5563;
}

.empty-hint {
  margin: 0;
  font-size: 0.9rem;
}

.link {
  color: #2563eb;
  text-decoration: none;
  font-weight: 500;
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
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 0.85rem 1rem;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, background 0.15s;
}

.event-row:hover {
  border-color: #2563eb;
  background: #f8FAff;
}

.event-date {
  flex-shrink: 0;
  width: 5.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.date-main {
  font-size: 0.9rem;
  font-weight: 600;
  color: #1f2937;
  font-variant-numeric: tabular-nums;
}

.date-created {
  font-size: 0.7rem;
  color: #9ca3af;
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

.event-type {
  flex-shrink: 0;
  padding: 0.1rem 0.5rem;
  background: #eff6ff;
  color: #1e40af;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}

.event-title {
  font-size: 1rem;
  font-weight: 600;
  color: #1f2937;
  word-break: break-word;
}

.event-meta {
  font-size: 0.82rem;
  color: #6b7280;
}

.event-summary {
  margin: 0.15rem 0 0;
  font-size: 0.85rem;
  color: #4b5563;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.event-arrow {
  flex-shrink: 0;
  color: #d1d5db;
  font-size: 1.4rem;
  line-height: 1;
  align-self: center;
}

.msg {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 4px;
  font-size: 0.9rem;
}

.msg-error {
  background: #fef2f2;
  color: #991b1b;
}
</style>
