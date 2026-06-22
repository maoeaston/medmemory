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
import type {
  Attachment,
  EventType,
  FamilyMember,
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

    const [memberResult, attachmentsResult, membersResult] =
      await Promise.allSettled([
        repos.familyMember.getById(ev.member_id),
        repos.attachment.listByEvent(ev.id),
        repos.familyMember.list(),
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
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
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
