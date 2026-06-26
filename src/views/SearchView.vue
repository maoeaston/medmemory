<script setup lang="ts">
// SearchView —— 关键词搜索（基于 ai_contents.ocr_fulltext LIKE）
//
// 数据流:
//   - 默认（空 query）: repos.search.listRecent(20, filter) → 最近 OCR
//   - 搜索（非空 query）: repos.search.searchByKeyword(query, filter)
//   → SearchResult[]: attachment + event + member + snippet
//   → 点击跳 /events/:eventId
//
// MVP:
//   - 搜索框（300ms 防抖）
//   - member filter（可选, 复用 FamilyMember list, 对 recent 和 search 都生效）
//   - snippet 显示（不做 highlight 标记, 简单展示）
//   - 空态: 无 OCR 内容 / 搜索无命中 / 错误
//
// 不做（v2+）:
//   - 高亮 keyword 在 snippet 中的位置
//   - 时间范围 filter
//   - 分页（SearchRepository 硬上限 LIMIT 50）
//   - 语义搜索（RAG）
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRepositories } from '@/composables/useRepositories';
import type {
  FamilyMember,
  SearchResult,
} from '@/repositories';

const RECENT_LIMIT = 20;

const router = useRouter();

const query = ref('');
const memberId = ref<number | null>(null);
const results = ref<SearchResult[]>([]);
const recentResults = ref<SearchResult[]>([]);
const members = ref<FamilyMember[]>([]);
const isLoading = ref(false);
const isLoadingRecent = ref(false);
const loadError = ref<string | null>(null);
const recentError = ref<string | null>(null);
const hasSearched = ref(false);

let debounceHandle: number | null = null;

const trimmedQuery = computed(() => query.value.trim());
const isSearching = computed(() => trimmedQuery.value.length > 0);
const displayResults = computed(() =>
  isSearching.value ? results.value : recentResults.value,
);

/** 触发搜索（300ms 防抖, 避免每个按键都打 LIKE） */
function scheduleSearch(): void {
  if (debounceHandle !== null) {
    clearTimeout(debounceHandle);
  }
  if (trimmedQuery.value.length === 0) {
    results.value = [];
    hasSearched.value = false;
    loadError.value = null;
    // 空查询 + 可能切换了 filter: 重载 recent
    void loadRecent();
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

async function loadRecent(): Promise<void> {
  isLoadingRecent.value = true;
  recentError.value = null;
  try {
    const repos = await useRepositories();
    const filter =
      memberId.value === null ? undefined : { memberId: memberId.value };
    recentResults.value = await repos.search.listRecent(RECENT_LIMIT, filter);
  } catch (e) {
    recentError.value = e instanceof Error ? e.message : String(e);
    recentResults.value = [];
  } finally {
    isLoadingRecent.value = false;
  }
}

function openEvent(eventId: number | null): void {
  if (eventId === null) return;
  void router.push(`/events/${eventId}`);
}

// snippet 展开/收起状态: 按 attachment.id 索引, 用 Set 记录已展开项
const expandedSnippets = reactive(new Set<number>());

/** 启发式判断 snippet 是否长到需要 clamp（避免短文本也显示"展开"按钮） */
function snippetNeedsClamp(text: string): boolean {
  return text.length > 120;
}

function toggleSnippet(attachmentId: number): void {
  if (expandedSnippets.has(attachmentId)) {
    expandedSnippets.delete(attachmentId);
  } else {
    expandedSnippets.add(attachmentId);
  }
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
  void loadRecent();
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

    <p v-if="isSearching && loadError" class="msg msg-error">
      搜索失败: {{ loadError }}
    </p>
    <p v-else-if="!isSearching && recentError" class="msg msg-error">
      加载最近内容失败: {{ recentError }}
    </p>
    <p v-else-if="isSearching && isLoading" class="hint">搜索中...</p>
    <p v-else-if="!isSearching && isLoadingRecent" class="hint">加载中...</p>
    <p v-else-if="isSearching && results.length === 0 && hasSearched" class="empty-state">
      没有命中。换一个关键词, 或到设置页确认附件已 AI 处理。
    </p>
    <p v-else-if="!isSearching && recentResults.length === 0" class="empty-state">
      还没有已 OCR 的内容。到「快速记录」上传报告并完成 AI 处理后, 这里会显示最近内容。
    </p>

    <template v-else-if="displayResults.length > 0">
      <p v-if="!isSearching" class="section-label">
        最近处理的 OCR 内容（{{ recentResults.length }}）
      </p>
      <ul class="result-list">
        <li
          v-for="r in displayResults"
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
              <span v-if="r.event" class="result-arrow">›</span>
            </div>
            <div class="result-meta">
              <span class="result-member">
                {{ formatMember(r.member?.name ?? null, r.member?.nickname ?? null) }}
              </span>
              <span v-if="r.event?.hospital" class="result-hospital">
                · {{ r.event.hospital }}
              </span>
            </div>
            <p
              class="result-snippet"
              :class="{ 'is-expanded': expandedSnippets.has(r.attachment.id) }"
            >{{ r.snippet }}</p>
            <span
              v-if="snippetNeedsClamp(r.snippet)"
              class="expand-toggle"
              role="button"
              tabindex="0"
              @click.stop="toggleSnippet(r.attachment.id)"
              @keyup.enter="toggleSnippet(r.attachment.id)"
              @keyup.space.prevent="toggleSnippet(r.attachment.id)"
            >{{ expandedSnippets.has(r.attachment.id) ? '收起' : '展开' }}</span>
          </button>
        </li>
      </ul>
    </template>
  </main>
</template>

<style scoped>
.search-view {
  padding: 1.5rem;
  max-width: var(--space-page-max-width);
  margin: 0 auto;
}

.page-header {
  margin-bottom: 0.75rem;
}

.page-title {
  margin: 0;
  font-size: var(--font-size-page-title);
}

.hint {
  margin: 0 0 1rem;
  font-size: var(--font-size-small);
  color: var(--color-text-muted);
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
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: var(--font-size-input);
  font-family: inherit;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
}

.search-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

.member-filter {
  padding: 0.55rem 0.5rem;
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: 0.88rem;
  font-family: inherit;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
  cursor: pointer;
  max-width: 10rem;
}

.member-filter:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

.empty-state {
  text-align: center;
  padding: 2rem 1rem;
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.section-label {
  margin: 0 0 0.6rem;
  font-size: var(--font-size-meta);
  color: var(--color-text-muted);
  font-weight: var(--font-weight-medium);
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
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: 0.7rem 0.9rem;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s, background 0.15s;
}

.result-row:hover:not(:disabled) {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
}

.result-row:disabled {
  cursor: default;
  opacity: 0.7;
}

.result-head {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.5rem;
  align-items: baseline;
}

.result-title {
  font-size: var(--font-size-input);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  word-break: break-word;
}

.result-date {
  font-size: var(--font-size-caption);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.result-arrow {
  color: var(--color-border-input);
  font-size: 1.2rem;
  line-height: 1;
}

.result-meta {
  font-size: var(--font-size-caption);
  color: var(--color-text-muted);
}

.result-snippet {
  margin: 0.15rem 0 0;
  font-size: var(--font-size-meta);
  color: var(--color-text-secondary);
  line-height: 1.45;
  background: var(--color-bg-page);
  padding: 0.4rem 0.5rem;
  border-radius: 3px;
  border-left: 2px solid var(--color-border-input);
  /* 3 行截断 —— 替代原 max-height + overflow-y: auto 的"卡片内滚动"差体验 */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}

.result-snippet.is-expanded {
  -webkit-line-clamp: unset;
  overflow: visible;
}

.expand-toggle {
  display: inline-block;
  margin: 0.3rem 0 0 0.5rem;
  font-size: var(--font-size-btn-small);
  color: var(--color-primary);
  cursor: pointer;
  user-select: none;
}
.expand-toggle:hover,
.expand-toggle:focus {
  text-decoration: underline;
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
