<script setup lang="ts">
// EventDetailView —— 单个医疗事件详情
//
// 路由: /events/:id（router/index.ts props 注入 id: number）
//
// 数据加载（并行）:
//   - medicalEvent.getById(id) → event 本体
//   - familyMember.list() → id→name 反查（也可 getById(member_id) 单查）
//   - attachment.listByEvent(id) → 附件列表（每个附件原件由 AttachmentPreview 懒加载）
//
// 操作:
//   - 编辑: 打开 EventEditForm modal → medicalEvent.update(id, input) → 本地刷新
//   - 删除: ConfirmDialog → medicalEvent.delete(id) → router.push('/events')
//
// 删除影响范围（ConfirmDialog 文案）:
//   - event_problem_rel CASCADE 删（健康问题本体不删）
//   - attachments.event_id SET NULL（附件 metadata + 原件保留, 变孤儿）
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageContainer from '@/components/layout/PageContainer.vue';
import { useRepositories } from '@/composables/useRepositories';
import { useAiProcess } from '@/composables/useAiProcess';
import { useAiConfig } from '@/composables/useAiConfig';
import type { SuggestedHealthProblem } from '@/lib/ai/AiProvider';
import type {
  AiContent,
  Attachment,
  FamilyMember,
  HealthProblem,
  MedicalEvent,
  MedicalEventUpdateInput,
} from '@/repositories';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EventTypeBadge from '@/components/ui/EventTypeBadge.vue';
import EventEditForm from '@/components/events/EventEditForm.vue';
import AttachmentPreview from '@/components/events/AttachmentPreview.vue';
import LabInterpretationModal from '@/components/health-agent/LabInterpretationModal.vue';

const props = defineProps<{ id: number }>();

const router = useRouter();

const event = ref<MedicalEvent | null>(null);
const member = ref<FamilyMember | null>(null);
const members = ref<FamilyMember[]>([]);
const attachments = ref<Attachment[]>([]);
const loadError = ref<string | null>(null);
const isLoading = ref(false);
const notFound = ref(false);

// 健康问题关联状态 (v3.1 PRD 7.4)
const linkedProblems = ref<HealthProblem[]>([]);
const pendingSuggestions = ref<AiContent[]>([]);
const manualProblemInput = ref('');
const isProcessingProblem = ref(false);
const problemError = ref<string | null>(null);

// 子项 1: localStorage 软忽略状态
const ignoredSuggestionNames = ref<Set<string>>(new Set());
const showIgnoredSection = ref(false);

/** localStorage key: per-event 软忽略健康问题推荐 name 数组 */
function ignoredSuggestionsKey(eventId: number): string {
  return `medmemory:event:${eventId}:ignoredSuggestions`;
}

function loadIgnoredNames(eventId: number): Set<string> {
  try {
    const raw = localStorage.getItem(ignoredSuggestionsKey(eventId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function saveIgnoredNames(eventId: number, names: Set<string>): void {
  try {
    localStorage.setItem(
      ignoredSuggestionsKey(eventId),
      JSON.stringify(Array.from(names)),
    );
  } catch (e) {
    console.warn(
      '[EventDetailView] localStorage 写入失败, 忽略状态将不持久:',
      e,
    );
  }
}

// 子项 3: 纯文本事件 AI 推荐状态
const { processTextEventSuggestions, isProcessing: isAiProcessing } =
  useAiProcess();
const { hasKey } = useAiConfig('ocr');

// 编辑 modal 状态
const showEditModal = ref(false);
const isSaving = ref(false);
const saveError = ref<string | null>(null);

// v3.2: 化验单 AI 解读 modal 状态
const showLabInterpretationModal = ref(false);
const currentLabInterpAttachmentId = ref<number | null>(null);

function handleLabInterpretation(attachmentId: number): void {
  currentLabInterpAttachmentId.value = attachmentId;
  showLabInterpretationModal.value = true;
}

function closeLabInterpretationModal(): void {
  showLabInterpretationModal.value = false;
  currentLabInterpAttachmentId.value = null;
}

// 删除 dialog 状态
const showDeleteModal = ref(false);
const isDeleting = ref(false);
const deleteError = ref<string | null>(null);

const memberDisplayName = computed(() => {
  if (member.value === null) return `#${event.value?.member_id ?? '?'}`;
  return member.value.nickname
    ? `${member.value.name} (${member.value.nickname})`
    : member.value.name;
});

/**
 * 去重聚合后的待确认推荐 (按 name 合并同名的 ai_contents 行)。
 *
 * 同一健康问题名可能被多附件推荐多次, UI 只显示一行,
 * 确认/跳过时批量删除所有同名 ai_contents。
 */
interface DedupSuggestion {
  name: string;
  confidence: SuggestedHealthProblem['confidence'];
  /** 同名所有 ai_contents 行的 id, 操作时批量处理 */
  aiContentIds: number[];
}

/**
 * 共享的去重聚合逻辑。filter 控制只保留 / 只排除被软忽略的 name。
 * - dedupSuggestions 用 (name) => !ignored.has(name)
 * - ignoredDedupSuggestions 用 (name) => ignored.has(name)
 */
function buildDedupSuggestions(
  filter: (name: string) => boolean,
): DedupSuggestion[] {
  const map = new Map<string, DedupSuggestion>();
  for (const ai of pendingSuggestions.value) {
    let parsed: SuggestedHealthProblem;
    try {
      parsed = JSON.parse(ai.content) as SuggestedHealthProblem;
    } catch {
      continue; // 忽略损坏的 JSON
    }
    if (typeof parsed.name !== 'string' || parsed.name.trim() === '') continue;
    if (!filter(parsed.name)) continue;

    const confidence: SuggestedHealthProblem['confidence'] =
      parsed.confidence === 'high' ||
      parsed.confidence === 'medium' ||
      parsed.confidence === 'low'
        ? parsed.confidence
        : 'medium';

    const existing = map.get(parsed.name);
    if (existing) {
      existing.aiContentIds.push(ai.id);
    } else {
      map.set(parsed.name, {
        name: parsed.name,
        confidence,
        aiContentIds: [ai.id],
      });
    }
  }
  return Array.from(map.values());
}

const dedupSuggestions = computed<DedupSuggestion[]>(() =>
  buildDedupSuggestions((name) => !ignoredSuggestionNames.value.has(name)),
);

/** 已软忽略的推荐列表（折叠区展示, 允许恢复） */
const ignoredDedupSuggestions = computed<DedupSuggestion[]>(() =>
  buildDedupSuggestions((name) => ignoredSuggestionNames.value.has(name)),
);

// === 子项 3: 纯文本事件 AI 推荐按钮可见性 ===
const canTriggerTextSuggestion = computed(() => {
  if (event.value === null) return false;
  if (!hasKey.value) return false;
  if (isProcessingProblem.value || isAiProcessing.value) return false;
  return !!(event.value.title || event.value.summary);
});

async function loadAll(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  notFound.value = false;
  try {
    const repos = await useRepositories();
    const ev = await repos.medicalEvent.getById(props.id);
    if (ev === null) {
      notFound.value = true;
      return;
    }
    event.value = ev;

    const [memberResult, attachmentsResult, membersResult, problemsResult, suggestionsResult] =
      await Promise.allSettled([
        repos.familyMember.getById(ev.member_id),
        repos.attachment.listByEvent(ev.id),
        repos.familyMember.list(),
        repos.eventProblemRel.listProblemsByEvent(ev.id),
        repos.aiContent.listPendingSuggestionsByEvent(ev.id),
      ]);

    if (memberResult.status === 'fulfilled') {
      member.value = memberResult.value;
    }
    if (attachmentsResult.status === 'fulfilled') {
      attachments.value = attachmentsResult.value;
    }
    if (membersResult.status === 'fulfilled') {
      members.value = membersResult.value;
    }
    if (problemsResult.status === 'fulfilled') {
      linkedProblems.value = problemsResult.value;
    }
    if (suggestionsResult.status === 'fulfilled') {
      pendingSuggestions.value = suggestionsResult.value;
    }
    // 子项 1: 从 localStorage 载入软忽略列表（per-event）
    ignoredSuggestionNames.value = loadIgnoredNames(ev.id);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

function openEditModal(): void {
  saveError.value = null;
  showEditModal.value = true;
}

function closeEditModal(): void {
  if (isSaving.value) return;
  showEditModal.value = false;
  saveError.value = null;
}

async function handleEditSubmit(input: MedicalEventUpdateInput): Promise<void> {
  if (event.value === null) return;
  // 空对象（无字段变化）直接关闭
  if (Object.keys(input).length === 0) {
    showEditModal.value = false;
    return;
  }
  isSaving.value = true;
  saveError.value = null;
  try {
    const repos = await useRepositories();
    const updated = await repos.medicalEvent.update(event.value.id, input);
    event.value = updated;
    // 成员变了要重查 member
    if (input.member_id !== undefined && input.member_id !== event.value?.member_id) {
      // updated.member_id 是新值, 直接 getById
      member.value = await repos.familyMember.getById(updated.member_id);
    }
    showEditModal.value = false;
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSaving.value = false;
  }
}

function openDeleteModal(): void {
  deleteError.value = null;
  showDeleteModal.value = true;
}

function closeDeleteModal(): void {
  if (isDeleting.value) return;
  showDeleteModal.value = false;
  deleteError.value = null;
}

/**
 * 重新加载健康问题关联状态 (problems + pending suggestions)。
 * confirmSuggestion/ignoreSuggestion/attachManual/detachProblem 操作后调用。
 */
async function reloadHealthLinks(eventId: number): Promise<void> {
  const repos = await useRepositories();
  const [problems, suggestions] = await Promise.all([
    repos.eventProblemRel.listProblemsByEvent(eventId),
    repos.aiContent.listPendingSuggestionsByEvent(eventId),
  ]);
  linkedProblems.value = problems;
  pendingSuggestions.value = suggestions;
}

/**
 * 确认一条 AI 推荐: findOrCreate + attach + 删除所有同名 ai_contents。
 */
async function confirmSuggestion(s: DedupSuggestion): Promise<void> {
  if (event.value === null || isProcessingProblem.value) return;
  isProcessingProblem.value = true;
  problemError.value = null;
  try {
    const repos = await useRepositories();
    const problem = await repos.healthProblem.findOrCreate(
      event.value.member_id,
      s.name,
    );
    await repos.eventProblemRel.attach(event.value.id, problem.id);
    await Promise.all(
      s.aiContentIds.map((id) => repos.aiContent.delete(id)),
    );
    await reloadHealthLinks(event.value.id);
  } catch (e) {
    problemError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isProcessingProblem.value = false;
  }
}

/**
 * 跳过一条 AI 推荐: 软忽略（localStorage 记 name）, 不删 ai_contents 行。
 * dedupSuggestions computed 会响应过滤, UI 立刻消失。
 * 用户可在"已忽略"折叠区恢复, 不需要重新跑 AI。
 */
async function ignoreSuggestion(s: DedupSuggestion): Promise<void> {
  if (event.value === null || isProcessingProblem.value) return;
  isProcessingProblem.value = true;
  problemError.value = null;
  try {
    const newSet = new Set(ignoredSuggestionNames.value);
    newSet.add(s.name);
    ignoredSuggestionNames.value = newSet;
    saveIgnoredNames(event.value.id, newSet);
    // 不调 reloadHealthLinks - computed 响应 ignoredSuggestionNames 自动过滤
  } catch (e) {
    problemError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isProcessingProblem.value = false;
  }
}

/** 恢复单条已忽略推荐 */
async function restoreIgnored(name: string): Promise<void> {
  if (event.value === null) return;
  const newSet = new Set(ignoredSuggestionNames.value);
  newSet.delete(name);
  ignoredSuggestionNames.value = newSet;
  saveIgnoredNames(event.value.id, newSet);
}

/** 恢复全部已忽略推荐 */
async function restoreAllIgnored(): Promise<void> {
  if (event.value === null) return;
  ignoredSuggestionNames.value = new Set();
  saveIgnoredNames(event.value.id, new Set());
  showIgnoredSection.value = false;
}

// === 子项 3: 纯文本事件 AI 推荐入口 ===
async function handleTextSuggestion(): Promise<void> {
  if (event.value === null || isAiProcessing.value) return;
  problemError.value = null;
  try {
    await processTextEventSuggestions(event.value.id);
    await reloadHealthLinks(event.value.id);
  } catch (e) {
    problemError.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * 手动添加关联: 用户输入健康问题名 → findOrCreate + attach。
 */
async function attachManualProblem(): Promise<void> {
  if (event.value === null || isProcessingProblem.value) return;
  const name = manualProblemInput.value.trim();
  if (!name) return;
  isProcessingProblem.value = true;
  problemError.value = null;
  try {
    const repos = await useRepositories();
    const problem = await repos.healthProblem.findOrCreate(
      event.value.member_id,
      name,
    );
    await repos.eventProblemRel.attach(event.value.id, problem.id);
    manualProblemInput.value = '';
    await reloadHealthLinks(event.value.id);
  } catch (e) {
    problemError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isProcessingProblem.value = false;
  }
}

/**
 * 移除已关联的健康问题 (不删除 health_problem 本体, 仅解关联)。
 */
async function detachProblem(problemId: number): Promise<void> {
  if (event.value === null || isProcessingProblem.value) return;
  isProcessingProblem.value = true;
  problemError.value = null;
  try {
    const repos = await useRepositories();
    await repos.eventProblemRel.detach(event.value.id, problemId);
    await reloadHealthLinks(event.value.id);
  } catch (e) {
    problemError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isProcessingProblem.value = false;
  }
}

async function handleDeleteConfirm(): Promise<void> {
  if (event.value === null) return;
  isDeleting.value = true;
  deleteError.value = null;
  try {
    const repos = await useRepositories();
    await repos.medicalEvent.delete(event.value.id);
    showDeleteModal.value = false;
    await router.push('/events');
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isDeleting.value = false;
  }
}

function goBack(): void {
  // 优先 history.back（如果有来自列表的 history）, 否则去列表
  if (window.history.length > 1) {
    void router.back();
  } else {
    void router.push('/events');
  }
}

onMounted(() => {
  void loadAll();
});
</script>

<template>
  <PageContainer max-width="standard" class="event-detail">
    <header class="detail-header">
      <button
        type="button"
        class="btn btn-ghost btn-small"
        @click="goBack"
      >
        ← 返回
      </button>
      <div class="header-actions" v-if="event">
        <button
          type="button"
          class="btn btn-secondary btn-small"
          @click="openEditModal"
        >
          编辑
        </button>
        <button
          type="button"
          class="btn btn-danger btn-small"
          @click="openDeleteModal"
        >
          删除
        </button>
      </div>
    </header>

    <p v-if="loadError" class="msg msg-error">加载失败: {{ loadError }}</p>
    <p v-else-if="isLoading" class="hint">加载中...</p>

    <div v-else-if="notFound" class="empty-state">
      <p class="empty-title">事件不存在</p>
      <p class="empty-hint">
        可能已被删除。返回
        <RouterLink to="/events" class="link">事件列表</RouterLink>。
      </p>
    </div>

    <article v-else-if="event" class="event-article">
      <div class="title-row">
        <EventTypeBadge :type="event.event_type" />
        <h1 class="event-title">{{ event.title }}</h1>
      </div>

      <dl class="meta-grid">
        <div class="meta-item">
          <dt>成员</dt>
          <dd>{{ memberDisplayName }}</dd>
        </div>
        <div class="meta-item">
          <dt>日期</dt>
          <dd>{{ event.event_date }}</dd>
        </div>
        <div class="meta-item" v-if="event.hospital">
          <dt>医院</dt>
          <dd>{{ event.hospital }}</dd>
        </div>
        <div class="meta-item" v-if="event.department">
          <dt>科室</dt>
          <dd>{{ event.department }}</dd>
        </div>
      </dl>

      <section v-if="event.summary" class="summary-section">
        <h2 class="section-title">摘要</h2>
        <p class="summary-text">{{ event.summary }}</p>
      </section>

      <section class="health-problems-section">
        <h2 class="section-title">
          健康问题
          <span class="count-badge">{{ linkedProblems.length }}</span>
        </h2>

        <!-- 子项 3: AI 推荐入口（纯文本事件也能触发） -->
        <div class="health-actions-bar">
          <button
            type="button"
            class="btn btn-secondary btn-small"
            :disabled="!canTriggerTextSuggestion"
            :title="!hasKey ? '未配置 AI, 请到设置页填 API key' : ''"
            @click="handleTextSuggestion"
          >
            {{ isAiProcessing ? '✨ AI 推荐中...' : '✨ AI 推荐问题' }}
          </button>
          <span v-if="!hasKey" class="hint-text">
            未配置 AI（
            <RouterLink to="/settings" class="link">设置页</RouterLink>
            填 API key）
          </span>
        </div>

        <!-- 已关联 (可 detach) -->
        <div v-if="linkedProblems.length > 0" class="problem-tags">
          <span
            v-for="p in linkedProblems"
            :key="p.id"
            class="problem-tag"
            :data-status="p.status"
          >
            {{ p.name }}
            <button
              type="button"
              class="tag-remove"
              :disabled="isProcessingProblem"
              aria-label="移除关联"
              @click="detachProblem(p.id)"
            >×</button>
          </span>
        </div>

        <!-- 手动添加 -->
        <div class="manual-add">
          <input
            v-model="manualProblemInput"
            type="text"
            class="manual-input"
            placeholder="+ 手动关联健康问题 (回车添加)"
            :disabled="isProcessingProblem"
            @keyup.enter="attachManualProblem"
          />
          <button
            type="button"
            class="btn btn-secondary btn-small"
            :disabled="isProcessingProblem || !manualProblemInput.trim()"
            @click="attachManualProblem"
          >添加</button>
        </div>

        <!-- AI 待确认推荐 -->
        <div v-if="dedupSuggestions.length > 0" class="suggestions">
          <p class="suggestions-title">AI 推荐关联:</p>
          <div
            v-for="s in dedupSuggestions"
            :key="s.name"
            class="suggestion-row"
          >
            <span class="suggestion-name">{{ s.name }}</span>
            <span class="suggestion-confidence" :data-level="s.confidence">
              {{ s.confidence === 'high' ? '高置信' : s.confidence === 'medium' ? '中置信' : '低置信' }}
            </span>
            <div class="suggestion-actions">
              <button
                type="button"
                class="btn btn-primary btn-small"
                :disabled="isProcessingProblem"
                @click="confirmSuggestion(s)"
              >确认</button>
              <button
                type="button"
                class="btn btn-ghost btn-small"
                :disabled="isProcessingProblem"
                @click="ignoreSuggestion(s)"
              >跳过</button>
            </div>
          </div>
        </div>

        <!-- 子项 1: 已忽略推荐折叠区（可恢复） -->
        <div v-if="ignoredDedupSuggestions.length > 0" class="ignored-section">
          <button
            type="button"
            class="ignored-toggle"
            @click="showIgnoredSection = !showIgnoredSection"
          >
            {{ showIgnoredSection ? '▼' : '▶' }} 已忽略 {{ ignoredDedupSuggestions.length }} 条
          </button>
          <div v-if="showIgnoredSection" class="ignored-list">
            <div
              v-for="s in ignoredDedupSuggestions"
              :key="s.name"
              class="ignored-row"
            >
              <span class="ignored-name">{{ s.name }}</span>
              <button
                type="button"
                class="btn btn-ghost btn-small"
                @click="restoreIgnored(s.name)"
              >恢复</button>
            </div>
            <button
              type="button"
              class="btn btn-ghost btn-small restore-all-btn"
              @click="restoreAllIgnored"
            >恢复全部</button>
          </div>
        </div>

        <p v-if="problemError" class="msg msg-error">{{ problemError }}</p>
      </section>

      <section class="attachments-section">
        <h2 class="section-title">
          附件
          <span class="count-badge">{{ attachments.length }}</span>
        </h2>
        <p v-if="attachments.length === 0" class="no-attachments">暂无附件</p>
        <div v-else class="attachments-grid">
          <AttachmentPreview
            v-for="att in attachments"
            :key="att.id"
            :attachment="att"
            @interpret-lab="handleLabInterpretation"
          />
        </div>
      </section>

      <p class="created-at">录入时间: {{ event.created_at }}</p>
    </article>

    <!-- 编辑 modal -->
    <ModalOverlay
      v-if="showEditModal && event"
      :title="`编辑事件 #${event.id}`"
      width="md"
      @close="closeEditModal"
    >
      <EventEditForm
        :initial-values="event"
        :members="members"
        :disabled="isSaving"
        :error-message="saveError"
        @submit="handleEditSubmit"
        @cancel="closeEditModal"
      />
    </ModalOverlay>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="showDeleteModal && event"
      title="删除事件"
      :message="`确认删除事件「${event.title}」?`"
      detail="将删除事件本体及其与健康问题的关联。\n附件 metadata 和原件会保留（变为未归档孤儿）。\n此操作不可撤销。"
      confirm-text="删除"
      danger
      :loading="isDeleting"
      :error-message="deleteError"
      @confirm="handleDeleteConfirm"
      @cancel="closeDeleteModal"
    />

    <!-- v3.2: 化验单 AI 解读 modal -->
    <LabInterpretationModal
      v-if="showLabInterpretationModal && currentLabInterpAttachmentId !== null"
      :attachment-id="currentLabInterpAttachmentId"
      :event-summary="event?.summary ?? null"
      @close="closeLabInterpretationModal"
    />
  </PageContainer>
</template>

<style scoped>
/* .event-detail padding/max-width/margin 由 PageContainer 提供 */

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.header-actions {
  display: flex;
  gap: 0.4rem;
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

.event-article {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.title-row {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.event-title {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  word-break: break-word;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem;
  margin: 0;
  padding: var(--space-card-pad-tight);
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.meta-item dt {
  font-size: var(--font-size-badge);
  color: var(--color-text-muted);
  font-weight: var(--font-weight-medium);
}

.meta-item dd {
  margin: 0;
  font-size: var(--font-size-input);
  color: var(--color-text-primary);
}

.summary-section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.section-title {
  margin: 0;
  font-size: var(--font-size-input);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.count-badge {
  padding: 0.1rem 0.5rem;
  background: var(--color-border-default);
  color: var(--color-text-secondary);
  border-radius: var(--radius-pill);
  font-size: 0.72rem;
  font-weight: var(--font-weight-semibold);
}

.summary-text {
  margin: 0;
  padding: 0.75rem 0.9rem;
  background: var(--color-warning-light);
  border-left: 3px solid var(--color-warning);
  border-radius: 3px;
  color: var(--color-text-primary);
  font-size: var(--font-size-input);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.health-problems-section {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.problem-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.problem-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.65rem;
  background: var(--color-success-light);
  color: var(--color-success);
  border: 1px solid #a7f3d0;
  border-radius: var(--radius-pill);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-medium);
}

.problem-tag[data-status="resolved"] {
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
  border-color: var(--color-border-input);
}

.problem-tag[data-status="chronic"] {
  background: #fef3c7;
  color: var(--color-warning-text);
  border-color: #fcd34d;
}

.tag-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.1rem;
  height: 1.1rem;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.6;
  border-radius: var(--radius-pill);
}

.tag-remove:hover:not(:disabled) {
  opacity: 1;
  background: rgba(0, 0, 0, 0.08);
}

.tag-remove:disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.manual-add {
  display: flex;
  gap: 0.4rem;
}

.manual-input {
  flex: 1;
  padding: 0.4rem 0.7rem;
  border: 1px dashed var(--color-border-input);
  border-radius: var(--radius-badge);
  font-size: 0.88rem;
  font-family: inherit;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
}

.manual-input:focus {
  outline: none;
  border-color: var(--color-primary);
  border-style: solid;
  box-shadow: var(--shadow-focus);
}

.manual-input:disabled {
  background: var(--color-bg-page);
  cursor: not-allowed;
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.65rem 0.8rem;
  background: var(--color-primary-light);
  border-radius: var(--radius-card);
  border: 1px solid #bfdbfe;
}

.suggestions-title {
  margin: 0 0 0.2rem;
  font-size: var(--font-size-meta);
  color: var(--color-primary-dark);
  font-weight: var(--font-weight-semibold);
}

.suggestion-row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.4rem 0.5rem;
  background: var(--color-bg-card);
  border-radius: var(--radius-badge);
}

.suggestion-name {
  flex: 1;
  font-size: var(--font-size-input);
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
}

.suggestion-confidence {
  font-size: 0.72rem;
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-pill);
  font-weight: var(--font-weight-semibold);
}

.suggestion-confidence[data-level="high"] {
  background: #fef3c7;
  color: var(--color-warning-text);
}

.suggestion-confidence[data-level="medium"] {
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
}

.suggestion-confidence[data-level="low"] {
  background: var(--color-bg-page);
  color: var(--color-text-faint);
}

.suggestion-actions {
  display: flex;
  gap: 0.5rem;
}

.suggestion-actions button {
  min-width: 3rem;
}

/* === 子项 3: AI 推荐入口 === */
.health-actions-bar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.hint-text {
  font-size: var(--font-size-caption);
  color: var(--color-text-muted);
}

/* === 子项 1: 已忽略折叠区 === */
.ignored-section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.45rem 0.65rem;
  background: var(--color-bg-page);
  border-radius: var(--radius-badge);
  border: 1px dashed var(--color-border-default);
}

.ignored-toggle {
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: var(--font-size-caption);
  color: var(--color-text-muted);
  cursor: pointer;
  text-align: left;
}

.ignored-toggle:hover {
  color: var(--color-text-primary);
}

.ignored-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.ignored-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.ignored-name {
  font-size: var(--font-size-small);
  color: var(--color-text-faint);
  text-decoration: line-through;
}

.restore-all-btn {
  align-self: flex-start;
  font-size: var(--font-size-badge);
  text-decoration: underline;
}

.attachments-section {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.no-attachments {
  margin: 0;
  padding: 1.5rem 1rem;
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
  text-align: center;
  color: var(--color-text-faint);
  font-size: 0.88rem;
}

.attachments-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
}

.created-at {
  margin: 0.5rem 0 0;
  font-size: var(--font-size-badge);
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
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
