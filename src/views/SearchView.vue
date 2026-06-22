<script setup lang="ts">
// SearchView —— 关键词搜索（基于 ai_contents.ocr_fulltext LIKE）
//
// 数据流:
//   repos.search.searchByKeyword(query, filter)
//   → SearchResult[]: attachment + event + member + snippet
//   → 点击跳 /events/:eventId
//
// MVP:
//   - 搜索框（300ms 防抖）
//   - member filter（可选, 复用 FamilyMember list）
//   - snippet 显示（不做 highlight 标记, 简单展示）
//   - 空态: query 空 / 无结果 / 错误 三种
//
// 不做（v2+）:
//   - 高亮 keyword 在 snippet 中的位置
//   - 时间范围 filter
//   - 分页（SearchRepository 硬上限 LIMIT 50）
//   - 语义搜索（RAG）
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRepositories } from '@/composables/useRepositories';
import type {
  FamilyMember,
  SearchResult,
} from '@/repositories';

const router = useRouter();

const query = ref('');
const memberId = ref<number | null>(null);
const results = ref<SearchResult[]>([]);
const members = ref<FamilyMember[]>([]);
const isLoading = ref(false);
const loadError = ref<string | null>(null);
const hasSearched = ref(false);

let debounceHandle: number | null = null;

const trimmedQuery = computed(() => query.value.trim());

/** 触发搜索（300ms 防抖, 避免每个按键都打 LIKE） */
function scheduleSearch(): void {
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle);
  }
  if (trimmedQuery.value.length === 0) {
    results.value = [];
    hasSearched.value = false;
    loadError.value = null;
    return;
  }
  debounceHandle = window.setTimeout(() => {
    void runSearch();
  }, 300);
}

async function runSearch(): Promise<void> {
  if (trimmedQuery.value.length === 0) return;
  isLoading.value = true;
  loadError.value = null;
  hasSearched.value = true;
  try {
    const repos = await useRepositories();
    const filter =
      memberId.value === null ? undefined : { memberId: memberId.value };
    results.value = await repos.search.searchByKeyword(
      trimmedQuery.value,
      filter,
    );
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    results.value = [];
  } finally {
    isLoading.value = false;
  }
}

function openEvent(eventId: number | null): void {
  if (eventId === null) return;
  void router.push(`/events/${eventId}`);
}

function formatMember(name: string | null, nickname: string | null): string {
  if (name === null) return '未知成员';
  return nickname ? `${name} (${nickname})` : name;
}

onMounted(async () => {
  try {
    const repos = await useRepositories();
    members.value = await repos.familyMember.list();
  } catch (e) {
    console.error('[SearchView] 成员列表加载失败:', e);
  }
});
</script>

<template>
  <main class="search-view">
    <header class="page-header">
      <h1 class="page-title">搜索</h1>
    </header>

    <p class="hint">
      搜索已 AI 处理的附件 OCR 全文（如"血常规"、"肺炎"、"阿莫西林"）。
      未处理或处理中的附件不会出现在结果里。
    </p>

    <div class="search-bar">
      <input
        v-model="query"
        type="search"
        class="search-input"
        placeholder="输入关键词..."
        @input="scheduleSearch"
      />
      <select
        v-model.number="memberId"
        class="member-filter"
        aria-label="按成员筛选"
        @change="scheduleSearch"
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

    <p v-if="loadError" class="msg msg-error">搜索失败: {{ loadError }}</p>
    <p v-else-if="isLoading" class="hint">搜索中...</p>
    <p v-else-if="trimmedQuery.length === 0" class="hint">
      输入关键词开始搜索。
    </p>
    <p v-else-if="results.length === 0 && hasSearched" class="empty-state">
      没有命中。换一个关键词, 或到设置页确认附件已 AI 处理。
    </p>

    <ul v-else-if="results.length > 0" class="result-list">
      <li
        v-for="r in results"
        :key="r.attachment.id"
      >
        <button
          type="button"
          class="result-row"
          :disabled="r.event === null"
          @click="openEvent(r.event?.id ?? null)"
        >
          <div class="result-head">
            <span class="result-title">
              {{ r.event?.title ?? r.attachment.file_name }}
            </span>
            <span v-if="r.event" class="result-date">{{ r.event.event_date }}</span>
          </div>
          <div class="result-meta">
            <span class="result-member">
              {{ formatMember(r.member?.name ?? null, r.member?.nickname ?? null) }}
            </span>
            <span v-if="r.event?.hospital" class="result-hospital">
              · {{ r.event.hospital }}
            </span>
          </div>
          <p class="result-snippet">{{ r.snippet }}</p>
        </button>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.search-view {
  padding: 1.5rem;
  max-width: 720px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 0.75rem;
}

.page-title {
  margin: 0;
  font-size: 1.5rem;
}

.hint {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: #6b7280;
  line-height: 1.5;
}

.search-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.search-input {
  flex: 1;
  padding: 0.55rem 0.7rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.92rem;
  font-family: inherit;
  background: white;
  color: #1f2937;
}

.search-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.member-filter {
  padding: 0.55rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.88rem;
  font-family: inherit;
  background: white;
  color: #1f2937;
  cursor: pointer;
  max-width: 10rem;
}

.member-filter:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.empty-state {
  text-align: center;
  padding: 2rem 1rem;
  background: #f9fafb;
  border-radius: 6px;
  color: #6b7280;
  font-size: 0.9rem;
}

.result-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.result-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  text-align: left;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 0.7rem 0.9rem;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, background 0.15s;
}

.result-row:hover:not(:disabled) {
  border-color: #2563eb;
  background: #f8faff;
}

.result-row:disabled {
  cursor: default;
  opacity: 0.7;
}

.result-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}

.result-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: #1f2937;
  word-break: break-word;
}

.result-date {
  font-size: 0.78rem;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.result-meta {
  font-size: 0.78rem;
  color: #6b7280;
}

.result-snippet {
  margin: 0.15rem 0 0;
  font-size: 0.82rem;
  color: #4b5563;
  line-height: 1.45;
  background: #f9fafb;
  padding: 0.4rem 0.5rem;
  border-radius: 3px;
  border-left: 2px solid #d1d5db;
  max-height: 5rem;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
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
