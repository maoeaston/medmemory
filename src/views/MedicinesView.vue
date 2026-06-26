<script setup lang="ts">
// MedicinesView —— 药箱列表 + CRUD + 过期预警
//
// 模式（沿用 MembersView）:
//   - "+ 添加药品" → MedicineForm modal（创建模式）
//   - 行内"编辑" → MedicineForm modal（编辑模式, member_id disabled）
//   - 行内"删除" → ConfirmDialog → medicine.delete(id)
//
// 筛选:
//   - 搜索框: 前端 substring 匹配 name + usage, 不区分大小写
//   - filter tabs: 全部 / 即将过期 (30 天内) / 已过期 / 家庭共用
//
// 过期判定: 本地 THIS_MONTH 常量比对, 与 Dashboard MedicineWarningPanel 对齐
//   不调 listExpiring(30) —— listAll 已含全部, 前端计算省一次 DB 查询
import { computed, onMounted, reactive, ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import type {
  FamilyMember,
  Medicine,
  MedicineCreateInput,
  MedicineUpdateInput,
} from '@/repositories';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import MedicineForm from '@/components/medicines/MedicineForm.vue';
import MedicationGuideModal from '@/components/health-agent/MedicationGuideModal.vue';

// === 数据 ===
const medicines = ref<Medicine[]>([]);
const members = ref<FamilyMember[]>([]);
const isLoading = ref(false);
const loadError = ref<string | null>(null);
const membersLoadError = ref<string | null>(null);

// === 筛选状态 ===
const searchUsage = ref('');
type TabKey = 'all' | 'soon' | 'expired' | 'shared';
const activeTab = ref<TabKey>('all');

const tabs: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'soon', label: '即将过期' },
  { key: 'expired', label: '已过期' },
  { key: 'shared', label: '家庭共用' },
];

// === Form modal 状态 ===
const showFormModal = ref(false);
const editingMedicine = ref<Medicine | null>(null);
const isSaving = ref(false);
const saveError = ref<string | null>(null);

// === 删除状态 ===
const deletingMedicine = ref<Medicine | null>(null);
const isDeleting = ref(false);
const deleteError = ref<string | null>(null);

// === 备注 clamp 状态: 按 medicine.id 记录已展开项 ===
const expandedRemarks = reactive(new Set<number>());

/** 启发式: 备注 > 120 字才显示"展开/收起" */
function remarkNeedsClamp(text: string): boolean {
  return text.length > 120;
}

function toggleRemark(id: number): void {
  if (expandedRemarks.has(id)) {
    expandedRemarks.delete(id);
  } else {
    expandedRemarks.add(id);
  }
}

// === v3.2 用药指南 modal 状态 ===
const showMedGuideModal = ref(false);
const currentMedicineId = ref<number | null>(null);

function openMedGuide(m: Medicine): void {
  currentMedicineId.value = m.id;
  showMedGuideModal.value = true;
}

function closeMedGuideModal(): void {
  showMedGuideModal.value = false;
  currentMedicineId.value = null;
}

// === 时间常量（组件挂载时计算一次, 与 MedicineWarningPanel 逻辑一致）===
// YYYY-MM 格式; expiry_date 是月粒度, "<本月" 即已过期
const THIS_MONTH = new Date().toISOString().slice(0, 7);
const MONTH_PLUS_30 = new Date(Date.now() + 30 * 86400 * 1000)
  .toISOString()
  .slice(0, 7);

type MedStatus = 'expired' | 'soon' | 'ok';

function statusOf(m: Medicine): MedStatus {
  if (!m.expiry_date) return 'ok';
  if (m.expiry_date < THIS_MONTH) return 'expired';
  if (m.expiry_date <= MONTH_PLUS_30) return 'soon';
  return 'ok';
}

async function loadData(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;

  let repos;
  try {
    repos = await useRepositories();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    isLoading.value = false;
    return;
  }

  // 并行加载 medicines + members; members 失败不阻塞主列表
  const [medsResult, mbsResult] = await Promise.allSettled([
    repos.medicine.listAll(),
    repos.familyMember.list(),
  ]);

  if (medsResult.status === 'fulfilled') {
    medicines.value = medsResult.value;
    loadError.value = null;
  } else {
    medicines.value = [];
    loadError.value =
      medsResult.reason instanceof Error
        ? medsResult.reason.message
        : String(medsResult.reason);
  }

  if (mbsResult.status === 'fulfilled') {
    members.value = mbsResult.value;
    membersLoadError.value = null;
  } else {
    members.value = [];
    membersLoadError.value =
      mbsResult.reason instanceof Error
        ? mbsResult.reason.message
        : String(mbsResult.reason);
  }

  isLoading.value = false;
}

const counts = computed(() => {
  let soon = 0;
  let expired = 0;
  let shared = 0;
  for (const m of medicines.value) {
    const s = statusOf(m);
    if (s === 'expired') expired++;
    else if (s === 'soon') soon++;
    if (m.member_id === null) shared++;
  }
  return {
    all: medicines.value.length,
    soon,
    expired,
    shared,
  };
});

const filtered = computed(() => {
  const q = searchUsage.value.trim().toLowerCase();
  const tab = activeTab.value;
  return medicines.value
    .filter((m) => {
      // tab 过滤
      if (tab === 'soon' && statusOf(m) !== 'soon') return false;
      if (tab === 'expired' && statusOf(m) !== 'expired') return false;
      if (tab === 'shared' && m.member_id !== null) return false;
      // 搜索过滤: 匹配 name + usage
      if (q) {
        const name = m.name.toLowerCase();
        const usage = (m.usage ?? '').toLowerCase();
        if (!name.includes(q) && !usage.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // expiry_date 升序, null 排最后
      const ae = a.expiry_date ?? '9999-12';
      const be = b.expiry_date ?? '9999-12';
      return ae.localeCompare(be);
    });
});

function memberName(m: Medicine): string {
  if (m.member_id === null) return '家庭共用';
  const found = members.value.find((x) => x.id === m.member_id);
  return found ? found.name : '(成员已删除)';
}

function expiryLabel(m: Medicine): string {
  if (!m.expiry_date) return '';
  const s = statusOf(m);
  if (s === 'expired') return `已过期 · ${m.expiry_date}`;
  if (s === 'soon') return `即将过期 · ${m.expiry_date}`;
  return `到期 ${m.expiry_date}`;
}

// 余量标签: quantity NOT NULL DEFAULT 0；0 且无单位时视为未记录，不显示
function quantityLabel(m: Medicine): string {
  if (m.quantity === 0 && !m.unit) return '';
  return `剩余 ${m.quantity}${m.unit ? ' ' + m.unit : ''}`;
}

// === CRUD handlers（MembersView 模式）===
function openCreateModal(): void {
  editingMedicine.value = null;
  saveError.value = null;
  showFormModal.value = true;
}

function openEditModal(m: Medicine): void {
  editingMedicine.value = m;
  saveError.value = null;
  showFormModal.value = true;
}

function closeFormModal(): void {
  if (isSaving.value) return; // 保存中不允许关闭
  showFormModal.value = false;
  editingMedicine.value = null;
  saveError.value = null;
}

async function handleSubmit(
  input: MedicineCreateInput | MedicineUpdateInput,
): Promise<void> {
  isSaving.value = true;
  saveError.value = null;
  try {
    const repos = await useRepositories();
    if (editingMedicine.value === null) {
      await repos.medicine.create(input as MedicineCreateInput);
    } else {
      await repos.medicine.update(
        editingMedicine.value.id,
        input as MedicineUpdateInput,
      );
    }
    showFormModal.value = false;
    editingMedicine.value = null;
    await loadData();
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSaving.value = false;
  }
}

function openDeleteModal(m: Medicine): void {
  deletingMedicine.value = m;
  deleteError.value = null;
}

function closeDeleteModal(): void {
  if (isDeleting.value) return;
  deletingMedicine.value = null;
  deleteError.value = null;
}

async function handleDeleteConfirm(): Promise<void> {
  const target = deletingMedicine.value;
  if (target === null) return;
  isDeleting.value = true;
  deleteError.value = null;
  try {
    const repos = await useRepositories();
    await repos.medicine.delete(target.id);
    deletingMedicine.value = null;
    await loadData();
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isDeleting.value = false;
  }
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <main class="medicines-view">
    <header class="page-header">
      <h1 class="page-title">药箱</h1>
      <button
        type="button"
        class="btn btn-primary"
        @click="openCreateModal"
      >
        + 添加药品
      </button>
    </header>

    <div class="filters">
      <input
        v-model="searchUsage"
        type="search"
        class="search-input"
        placeholder="按名称或用途搜索（如: 退烧）"
      />
      <div class="filter-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="filter-tab"
          :class="{
            active: activeTab === tab.key,
            'tab-soon': tab.key === 'soon' && counts.soon > 0,
            'tab-expired': tab.key === 'expired' && counts.expired > 0,
          }"
          @click="activeTab = tab.key"
        >
          <span class="tab-label">{{ tab.label }}</span>
          <span class="tab-count">{{ counts[tab.key] }}</span>
        </button>
      </div>
    </div>

    <p v-if="loadError" class="msg msg-error">加载失败: {{ loadError }}</p>
    <p v-else-if="isLoading" class="hint">加载中...</p>
    <p
      v-else-if="medicines.length === 0"
      class="empty-state"
    >
      还没有药品。点击上方"+ 添加药品"开始建档。
    </p>
    <p
      v-else-if="filtered.length === 0"
      class="empty-state"
    >
      当前筛选条件下没有药品。
    </p>

    <ul v-else class="medicine-list">
      <li
        v-for="m in filtered"
        :key="m.id"
        class="medicine-item"
        :class="`status-${statusOf(m)}`"
      >
        <div class="med-info">
          <div class="name-row">
            <span class="med-name">{{ m.name }}</span>
            <span v-if="m.usage" class="med-usage">{{ m.usage }}</span>
          </div>
          <div class="meta-row">
            <span v-if="m.expiry_date" class="med-expiry">
              {{ expiryLabel(m) }}
            </span>
            <span v-if="quantityLabel(m)" class="med-qty">
              {{ quantityLabel(m) }}
            </span>
            <span v-if="m.storage_location" class="med-loc">
              📍 {{ m.storage_location }}
            </span>
            <span class="med-member">{{ memberName(m) }}</span>
          </div>
          <div v-if="m.remark" class="remark-wrap">
            <p
              class="med-remark"
              :class="{ 'is-expanded': expandedRemarks.has(m.id) }"
            >{{ m.remark }}</p>
            <button
              v-if="remarkNeedsClamp(m.remark)"
              type="button"
              class="btn btn-ghost btn-small expand-toggle"
              @click="toggleRemark(m.id)"
            >{{ expandedRemarks.has(m.id) ? '收起' : '展开' }}</button>
          </div>
        </div>
        <div class="med-actions">
          <button
            type="button"
            class="btn btn-secondary btn-small"
            @click="openMedGuide(m)"
          >
            ✨ AI 用药指南
          </button>
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
      :title="editingMedicine ? `编辑: ${editingMedicine.name}` : '添加药品'"
      width="lg"
      @close="closeFormModal"
    >
      <MedicineForm
        :initial-values="editingMedicine"
        :members="members"
        :members-load-error="membersLoadError"
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
      v-if="deletingMedicine"
      title="删除药品"
      :message="`确认删除「${deletingMedicine.name}」?`"
      detail="此操作不可撤销。"
      confirm-text="删除"
      danger
      :loading="isDeleting"
      :error-message="deleteError"
      @confirm="handleDeleteConfirm"
      @cancel="closeDeleteModal"
    />

    <!-- v3.2: 用药指南 modal -->
    <MedicationGuideModal
      v-if="showMedGuideModal && currentMedicineId !== null"
      :medicine-id="currentMedicineId"
      @close="closeMedGuideModal"
    />
  </main>
</template>

<style scoped>
.medicines-view {
  padding: 1.5rem;
  max-width: var(--space-page-max-width);
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
  font-size: var(--font-size-page-title);
}

/* ===== Filters ===== */
.filters {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-bottom: 1.25rem;
}

.search-input {
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

.filter-tabs {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill);
  background: var(--color-bg-card);
  color: var(--color-text-secondary);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.filter-tab:hover {
  background: var(--color-bg-page);
}

.filter-tab.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.filter-tab.tab-soon:not(.active) {
  border-color: #fbbf24;
  color: var(--color-warning-text);
}

.filter-tab.tab-expired:not(.active) {
  border-color: #fca5a5;
  color: var(--color-danger-text);
}

.tab-count {
  font-size: var(--font-size-caption);
  opacity: 0.85;
}

/* ===== 状态提示 ===== */
.hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--color-text-muted);
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
}

/* ===== 药品列表 ===== */
.medicine-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.medicine-item {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-left: 3px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: var(--space-card-pad-tight);
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
}

.medicine-item.status-expired {
  border-left-color: var(--color-danger);
  background: var(--color-danger-light);
}

.medicine-item.status-soon {
  border-left-color: var(--color-warning);
  background: var(--color-warning-light);
}

.med-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.name-row {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.med-name {
  font-size: 1.02rem;
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.med-usage {
  font-size: var(--font-size-meta);
  color: var(--color-primary);
  background: var(--color-primary-light);
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-pill);
}

.med-qty {
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
}

.meta-row {
  display: flex;
  gap: 0.8rem;
  flex-wrap: wrap;
  font-size: var(--font-size-meta);
  color: var(--color-text-muted);
}

.status-expired .med-expiry {
  color: var(--color-danger-text);
  font-weight: var(--font-weight-semibold);
}

.status-soon .med-expiry {
  color: var(--color-warning-text);
  font-weight: var(--font-weight-semibold);
}

.med-remark {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--color-text-secondary);
  line-height: 1.4;
  /* 3 行截断, 长备注不再撑爆卡片 */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.med-remark.is-expanded {
  -webkit-line-clamp: unset;
  overflow: visible;
}

.remark-wrap {
  margin-top: 0.3rem;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.expand-toggle {
  margin-top: 0.2rem;
  padding: 0.2rem 0.4rem;
  font-size: var(--font-size-btn-small);
}

.med-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

/* ===== Mobile responsive =====
 * 默认 .medicine-item 是 flex row: info 左, actions 右。
 * 手机宽度下三个按钮 (AI 用药指南/编辑/删除, ~200px) + flex:1 的 info 列
 * 会让信息被挤到 ~100px 宽 → 文字挤在左侧。
 * 解法: ≤580px 时切 column, info 全宽在前, actions 铺满在后。
 */
@media (max-width: 580px) {
  .medicines-view {
    padding: 1rem;
  }

  .medicine-item {
    flex-direction: column;
    gap: 0.75rem;
    align-items: stretch;
  }

  .med-actions {
    width: 100%;
    flex-wrap: wrap;
  }
}

/* ===== Messages ===== */
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

.modal-save-error {
  margin-top: 1rem;
}
</style>
