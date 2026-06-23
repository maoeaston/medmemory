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
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useRepositories } from '@/composables/useRepositories';
import EventTypeBadge from '@/components/ui/EventTypeBadge.vue';
import type { FamilyMember, MedicalEvent } from '@/repositories';

const router = useRouter();
const route = useRoute();

const events = ref<MedicalEvent[]>([]);
const members = ref<FamilyMember[]>([]);
const loadError = ref<string | null>(null);
const isLoading = ref(false);

// null = 全部成员; number = 仅该成员
// v3.3 入口修复: 从 ?member=N query 初始化（MemberCard 跳转过来）
const queryMember = route.query.member;
const initialMember =
  queryMember !== undefined && /^\d+$/.test(String(queryMember))
    ? Number(queryMember)
    : null;
const selectedMemberId = ref<number | null>(initialMember);

// 监听 query 变化（用户从 MemberCard 跳过来后, 或在 Timeline 内手动改 query）
watch(
  () => route.query.member,
  (val) => {
    if (val !== undefined && /^\d+$/.test(String(val))) {
      selectedMemberId.value = Number(val);
    } else if (val === undefined || val === '') {
      // 不主动清空: 用户从 select 选「全家」也会触发, 但 select 已经改了 selectedMemberId
    }
  },
);

const memberNameMap = computed(() => {
  const m = new Map<number, { name: string; nickname: string | null }>();
  for (const mem of members.value) {
    m.set(mem.id, { name: mem.name, nickname: mem.nickname });
  }
  return m;
});

/** 按 selectedMemberId 过滤; null = 不过滤 */
const filteredEvents = computed(() => {
  const id = selectedMemberId.value;
  if (id === null) return events.value;
  return events.value.filter((ev) => ev.member_id === id);
});

/** 按 YYYY-MM 分桶; filteredEvents 已按 event_date DESC 排序, Map 保插入顺序 → 桶自然倒序 */
const groupedByMonth = computed(() => {
  const buckets = new Map<string, MedicalEvent[]>();
  for (const ev of filteredEvents.value) {
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

/** select 改值时同步到 URL query, 让浏览器后退能回到上一筛选状态 */
function onMemberSelect(raw: string): void {
  const id = raw === '' ? null : Number(raw);
  selectedMemberId.value = id;
  void router.replace({
    query: id === null ? {} : { member: String(id) },
  });
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
      <span class="count-badge">{{ filteredEvents.length }}</span>
    </header>

    <div v-if="!isLoading && !loadError && events.length > 0" class="filters">
      <select
        :value="selectedMemberId"
        class="member-select"
        aria-label="按成员筛选"
        @change="onMemberSelect(($event.target as HTMLSelectElement).value)"
      >
        <option :value="null">全部成员</option>
        <option
          v-for="m in members"
          :key="m.id"
          :value="m.id"
        >
          {{ m.nickname ? `${m.name} (${m.nickname})` : m.name }}
        </option>
      </select>
    </div>

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

    <div
      v-else-if="filteredEvents.length === 0"
      class="empty-state"
    >
      <p class="empty-title">该成员暂无医疗事件</p>
      <p class="empty-hint">切换为"全部成员"查看其他成员的记录。</p>
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
                  <EventTypeBadge :type="ev.event_type" />
                  <span class="event-title">{{ ev.title }}</span>
                </div>
                <div class="event-meta">
                  <span v-if="selectedMemberId === null" class="event-member">{{ formatMember(ev.member_id) }}</span>
                  <span v-if="ev.hospital" class="event-hospital">
                    <span v-if="selectedMemberId === null">· </span>{{ ev.hospital }}<span v-if="ev.department"> / {{ ev.department }}</span>
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

.filters {
  margin-bottom: 1.25rem;
}

.member-select {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: var(--font-size-input);
  font-family: inherit;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
  cursor: pointer;
}

.member-select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
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

.month-group {
  margin-bottom: 1.5rem;
}

.month-title {
  margin: 0 0 0.6rem;
  padding: 0.3rem 0;
  font-size: 1rem;
  font-weight: var(--font-weight-semibold);
  color: var(--color-primary-dark);
  border-bottom: 1px solid var(--color-border-default);
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
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: 0.75rem 1rem;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, background 0.15s;
}

.event-row:hover {
  border-color: var(--color-primary);
  background: #f8FAff;
}

.event-date {
  flex-shrink: 0;
  width: 3rem;
  display: flex;
  flex-direction: column;
}

.date-main {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
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
