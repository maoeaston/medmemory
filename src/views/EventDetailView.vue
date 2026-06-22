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
import { useRepositories } from '@/composables/useRepositories';
import type { SuggestedHealthProblem } from '@/lib/ai/AiProvider';
import type {
  AiContent,
  Attachment,
  EventType,
  FamilyMember,
  HealthProblem,
  MedicalEvent,
  MedicalEventUpdateInput,
} from '@/repositories';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EventEditForm from '@/components/events/EventEditForm.vue';
import AttachmentPreview from '@/components/events/AttachmentPreview.vue';

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

// 编辑 modal 状态
const showEditModal = ref(false);
const isSaving = ref(false);
const saveError = ref<string | null>(null);

// 删除 dialog 状态
const showDeleteModal = ref(false);
const isDeleting = ref(false);
const deleteError = ref<string | null>(null);

const eventTypeLabel: Record<EventType, string> = {
  outpatient: '门诊就诊',
  emergency: '急诊',
  checkup: '体检',
  followup: '复诊',
  vaccine: '疫苗',
  hospitalization: '住院',
  other: '其他',
};

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

const dedupSuggestions = computed<DedupSuggestion[]>(() => {
  const map = new Map<string, DedupSuggestion>();
  for (const ai of pendingSuggestions.value) {
    let parsed: SuggestedHealthProblem;
    try {
      parsed = JSON.parse(ai.content) as SuggestedHealthProblem;
    } catch {
      continue; // 忽略损坏的 JSON
    }
    if (typeof parsed.name !== 'string' || parsed.name.trim() === '') continue;

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
 * 跳过一条 AI 推荐: 删除所有同名 ai_contents (不 attach)。
 */
async function ignoreSuggestion(s: DedupSuggestion): Promise<void> {
  if (event.value === null || isProcessingProblem.value) return;
  isProcessingProblem.value = true;
  problemError.value = null;
  try {
    const repos = await useRepositories();
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
  <main class="event-detail">
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
        <span class="event-type-badge">{{ eventTypeLabel[event.event_type] }}</span>
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
  </main>
</template>

<style scoped>
.event-detail {
  padding: 1.5rem;
  max-width: 720px;
  margin: 0 auto;
}

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

.event-type-badge {
  flex-shrink: 0;
  padding: 0.2rem 0.6rem;
  background: #eff6ff;
  color: #1e40af;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 600;
}

.event-title {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 600;
  color: #1f2937;
  word-break: break-word;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem;
  margin: 0;
  padding: 0.85rem 1rem;
  background: #f9fafb;
  border-radius: 6px;
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.meta-item dt {
  font-size: 0.75rem;
  color: #6b7280;
  font-weight: 500;
}

.meta-item dd {
  margin: 0;
  font-size: 0.92rem;
  color: #1f2937;
}

.summary-section {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.section-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: #4b5563;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.count-badge {
  padding: 0.1rem 0.5rem;
  background: #e5e7eb;
  color: #4b5563;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
}

.summary-text {
  margin: 0;
  padding: 0.75rem 0.9rem;
  background: #fffbeb;
  border-left: 3px solid #f59e0b;
  border-radius: 3px;
  color: #1f2937;
  font-size: 0.92rem;
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
  background: #ecfdf5;
  color: #065f46;
  border: 1px solid #a7f3d0;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 500;
}

.problem-tag[data-status="resolved"] {
  background: #f3f4f6;
  color: #6b7280;
  border-color: #d1d5db;
}

.problem-tag[data-status="chronic"] {
  background: #fef3c7;
  color: #92400e;
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
  border-radius: 999px;
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
  border: 1px dashed #d1d5db;
  border-radius: 4px;
  font-size: 0.88rem;
  font-family: inherit;
  background: white;
  color: #1f2937;
}

.manual-input:focus {
  outline: none;
  border-color: #2563eb;
  border-style: solid;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.manual-input:disabled {
  background: #f9fafb;
  cursor: not-allowed;
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.65rem 0.8rem;
  background: #eff6ff;
  border-radius: 6px;
  border: 1px solid #bfdbfe;
}

.suggestions-title {
  margin: 0 0 0.2rem;
  font-size: 0.82rem;
  color: #1e40af;
  font-weight: 600;
}

.suggestion-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.5rem;
  background: white;
  border-radius: 4px;
}

.suggestion-name {
  flex: 1;
  font-size: 0.92rem;
  color: #1f2937;
  font-weight: 500;
}

.suggestion-confidence {
  font-size: 0.72rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-weight: 600;
}

.suggestion-confidence[data-level="high"] {
  background: #fef3c7;
  color: #92400e;
}

.suggestion-confidence[data-level="medium"] {
  background: #f3f4f6;
  color: #6b7280;
}

.suggestion-confidence[data-level="low"] {
  background: #f9fafb;
  color: #9ca3af;
}

.suggestion-actions {
  display: flex;
  gap: 0.3rem;
}

.attachments-section {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.no-attachments {
  margin: 0;
  padding: 1.5rem 1rem;
  background: #f9fafb;
  border-radius: 6px;
  text-align: center;
  color: #9ca3af;
  font-size: 0.88rem;
}

.attachments-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.75rem;
}

.created-at {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  font-family: inherit;
}

.btn-small {
  padding: 0.4rem 0.8rem;
  font-size: 0.85rem;
}

.btn-ghost {
  background: transparent;
  color: #4b5563;
}

.btn-ghost:hover:not(:disabled) {
  background: #f3f4f6;
}

.btn-secondary {
  background: #f3f4f6;
  color: #4b5563;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn-primary {
  background: #2563eb;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.btn-danger {
  background: white;
  color: #dc2626;
  border: 1px solid #fecaca;
}

.btn-danger:hover:not(:disabled) {
  background: #fef2f2;
  border-color: #dc2626;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
