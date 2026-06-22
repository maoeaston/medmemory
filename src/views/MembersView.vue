<script setup lang="ts">
// MembersView —— 家庭成员列表 + CRUD
//
// 模式:
//   - "+ 添加成员" 按钮 → 打开 MemberForm modal（创建模式）
//   - 每行"编辑"按钮 → 打开 MemberForm modal（编辑模式, initialValues 传当前成员）
//   - 每行"删除"按钮 → 打开 ConfirmDialog → 确认 → familyMember.delete(id)
//
// CASCADE 警告: 删成员会级联删 medical_events / health_problems / event_problem_rel
// attachments.event_id 是 SET NULL（不删附件 metadata）— ConfirmDialog 文案说明
import { onMounted, ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import type {
  FamilyMember,
  FamilyMemberCreateInput,
  FamilyMemberUpdateInput,
} from '@/repositories';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import MemberForm from '@/components/members/MemberForm.vue';

const members = ref<FamilyMember[]>([]);
const loadError = ref<string | null>(null);
const isLoading = ref(false);

// modal 状态
const showFormModal = ref(false);
const editingMember = ref<FamilyMember | null>(null);
const isSaving = ref(false);
const saveError = ref<string | null>(null);

// 删除对话框状态
const deletingMember = ref<FamilyMember | null>(null);
const isDeleting = ref(false);
const deleteError = ref<string | null>(null);

async function loadMembers(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  try {
    const repos = await useRepositories();
    members.value = await repos.familyMember.list();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

function openCreateModal(): void {
  editingMember.value = null;
  saveError.value = null;
  showFormModal.value = true;
}

function openEditModal(m: FamilyMember): void {
  editingMember.value = m;
  saveError.value = null;
  showFormModal.value = true;
}

function closeFormModal(): void {
  if (isSaving.value) return; // 保存中不允许关闭
  showFormModal.value = false;
  editingMember.value = null;
  saveError.value = null;
}

async function handleSubmit(
  input: FamilyMemberCreateInput | FamilyMemberUpdateInput,
): Promise<void> {
  isSaving.value = true;
  saveError.value = null;
  try {
    const repos = await useRepositories();
    if (editingMember.value === null) {
      await repos.familyMember.create(input as FamilyMemberCreateInput);
    } else {
      await repos.familyMember.update(
        editingMember.value.id,
        input as FamilyMemberUpdateInput,
      );
    }
    showFormModal.value = false;
    editingMember.value = null;
    await loadMembers();
  } catch (e) {
    // 保留 modal 打开, 保留用户输入
    saveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSaving.value = false;
  }
}

function openDeleteModal(m: FamilyMember): void {
  deletingMember.value = m;
  deleteError.value = null;
}

function closeDeleteModal(): void {
  if (isDeleting.value) return;
  deletingMember.value = null;
  deleteError.value = null;
}

async function handleDeleteConfirm(): Promise<void> {
  const target = deletingMember.value;
  if (target === null) return;
  isDeleting.value = true;
  deleteError.value = null;
  try {
    const repos = await useRepositories();
    await repos.familyMember.delete(target.id);
    deletingMember.value = null;
    await loadMembers();
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isDeleting.value = false;
  }
}

function formatAllergies(m: FamilyMember): string {
  if (m.allergies.length === 0) return '';
  return m.allergies
    .map((a) => {
      const severity =
        a.severity === 'severe'
          ? '严重'
          : a.severity === 'moderate'
            ? '中度'
            : '轻度';
      const reaction = a.reaction ? `·${a.reaction}` : '';
      return `${a.name}（${severity}${reaction}）`;
    })
    .join('、');
}

function formatChronicConditions(m: FamilyMember): string {
  if (m.chronic_conditions.length === 0) return '';
  return m.chronic_conditions
    .map((c) => {
      const status =
        c.status === 'active'
          ? '进行中'
          : c.status === 'managed'
            ? '可控'
            : '已结束';
      return `${c.name}（${status}）`;
    })
    .join('、');
}

onMounted(() => {
  void loadMembers();
});
</script>

<template>
  <main class="members-view">
    <header class="page-header">
      <h1 class="page-title">家庭成员</h1>
      <button
        type="button"
        class="btn btn-primary"
        @click="openCreateModal"
      >
        + 添加成员
      </button>
    </header>

    <p v-if="loadError" class="msg msg-error">加载失败: {{ loadError }}</p>
    <p v-else-if="isLoading" class="hint">加载中...</p>

    <p
      v-else-if="members.length === 0"
      class="empty-state"
    >
      还没有家庭成员。点击上方"添加成员"开始建档。
    </p>

    <ul v-else class="member-list">
      <li
        v-for="m in members"
        :key="m.id"
        class="member-item"
      >
        <div class="member-info">
          <div class="member-name-row">
            <span class="member-name">{{ m.name }}</span>
            <span v-if="m.nickname" class="member-nickname">{{ m.nickname }}</span>
          </div>
          <p v-if="m.allergies.length > 0" class="member-allergies">
            ⚠️ 过敏: {{ formatAllergies(m) }}
          </p>
          <p v-if="m.chronic_conditions.length > 0" class="member-chronic">
            📋 慢病: {{ formatChronicConditions(m) }}
          </p>
          <p v-if="m.current_medications.length > 0" class="member-meds">
            💊 用药: {{ m.current_medications.join('、') }}
          </p>
        </div>
        <div class="member-actions">
          <button
            type="button"
            class="btn btn-secondary btn-small"
            @click="openEditModal(m)"
          >
            编辑
          </button>
          <button
            type="button"
            class="btn btn-danger btn-small"
            @click="openDeleteModal(m)"
          >
            删除
          </button>
        </div>
      </li>
    </ul>

    <!-- 创建/编辑 modal -->
    <ModalOverlay
      v-if="showFormModal"
      :title="editingMember ? `编辑: ${editingMember.name}` : '添加家庭成员'"
      width="lg"
      @close="closeFormModal"
    >
      <MemberForm
        :initial-values="editingMember"
        :disabled="isSaving"
        @submit="handleSubmit"
        @cancel="closeFormModal"
      />
      <p v-if="saveError" class="msg msg-error modal-save-error">
        保存失败: {{ saveError }}
      </p>
    </ModalOverlay>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="deletingMember"
      title="删除成员"
      :message="`确认删除「${deletingMember.name}」?`"
      :detail="`将同时删除该成员的所有医疗事件 / 健康问题 / 关联。\n附件 metadata 会保留但 event_id 置空。\n此操作不可撤销。`"
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
.members-view {
  padding: 1.5rem;
  max-width: 720px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.page-title {
  margin: 0;
  font-size: 1.5rem;
}

.hint {
  color: #6b7280;
  font-size: 0.9rem;
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: #6b7280;
  background: #f9fafb;
  border-radius: 6px;
}

.member-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.member-item {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 1rem;
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
}

.member-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.member-name-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.member-name {
  font-size: 1.05rem;
  font-weight: 600;
  color: #1f2937;
}

.member-nickname {
  font-size: 0.85rem;
  color: #6b7280;
}

.member-allergies {
  margin: 0;
  font-size: 0.88rem;
  background: #fef2f2;
  color: #991b1b;
  padding: 0.25rem 0.5rem;
  border-left: 3px solid #dc2626;
  border-radius: 2px;
}

.member-chronic,
.member-meds {
  margin: 0;
  font-size: 0.88rem;
  color: #4b5563;
}

.member-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-small {
  padding: 0.4rem 0.8rem;
  font-size: 0.85rem;
}

.btn-primary {
  background: #2563eb;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
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

.modal-save-error {
  margin-top: 1rem;
}
</style>
