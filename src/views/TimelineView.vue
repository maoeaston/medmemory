<script setup lang="ts">
// TimelineView —— 医疗事件时间线（跨成员, 按 event_date DESC, 月分组）
//
// 数据流:
//   medicalEvent.listAll() + familyMember.list()
//   → 建 id→name 反查 map
//   → 按 event_date 前 7 位 (YYYY-MM) 分桶
//   → 每月一组, 组内已按 event_date DESC（repository 保证）
//
// 与 EventsView 的区别:
//   - EventsView: listRecent(50) 按 created_at DESC（"最近录入"）
//   - TimelineView: listAll() 按 event_date DESC（"按发生时间回溯"）, 月分组
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

/** 按 YYYY-MM 分桶; events 已按 event_date DESC 排序, Map 保插入顺序 → 桶自然倒序 */
const groupedByMonth = computed(() => {
  const buckets = new Map<string, MedicalEvent[]>();
  for (const ev of events.value) {
    const ym = ev.event_date.slice(0, 7); // YYYY-MM
    let arr = buckets.get(ym);
    if (arr === undefined) {
      arr = [];
      buckets.set(ym, arr);
    }
    arr.push(ev);
  }
  return Array.from(buckets.entries()).map(([ym, items]) => ({ ym, items }));
});

async function load(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  try {
    const repos = await useRepositories();
    const [eventsResult, membersResult] = await Promise.allSettled([
      repos.medicalEvent.listAll(),
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
    // 成员加载失败不阻塞时间线（memberNameMap 找不到时显示"#id"）
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

/** YYYY-MM → "YYYY 年 M 月"（失败原样返回, 不阻塞渲染） */
function formatMonth(ym: string): string {
  const mt = ym.match(/^(\d{4})-(\d{2})$/);
  if (!mt) return ym;
  return `${mt[1]} 年 ${Number(mt[2])} 月`;
}

/** YYYY-MM-DD → "M-D"（同月组内省略年份和月份） */
function formatDay(iso: string): string {
  const mt = iso.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!mt) return iso;
  return `${Number(mt[1])}-${Number(mt[2])}`;
}

onMounted(() => {
  void load();
});
</script>

<template>
  <main class="timeline-view">
    <header class="page-header">
      <h1 class="page-title">时间线</h1>
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

    <template v-else>
      <section
        v-for="group in groupedByMonth"
        :key="group.ym"
        class="month-group"
      >
        <h2 class="month-title">{{ formatMonth(group.ym) }}</h2>
        <ul class="event-list">
          <li
            v-for="ev in group.items"
            :key="ev.id"
          >
            <button
              type="button"
              class="event-row"
              @click="openDetail(ev.id)"
            >
              <div class="event-date">
                <span class="date-main">{{ formatDay(ev.event_date) }}</span>
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
      </section>
    </template>
  </main>
</template>

<style scoped>
.timeline-view {
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

.month-group {
  margin-bottom: 1.5rem;
}

.month-title {
  margin: 0 0 0.6rem;
  padding: 0.3rem 0;
  font-size: 1rem;
  font-weight: 600;
  color: #1e40af;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  background: #fafafa;
}

.event-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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
  padding: 0.75rem 1rem;
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
  width: 3rem;
  display: flex;
  flex-direction: column;
}

.date-main {
  font-size: 0.9rem;
  font-weight: 600;
  color: #1f2937;
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
