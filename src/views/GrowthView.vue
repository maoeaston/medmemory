<script setup lang="ts">
// GrowthView —— 儿童生长曲线（录入 + 曲线 + 历史）
// ============================================================
// 数据流:
//   members (filter → children: 有 birthday+gender 且 0-19y)
//     → selectedMember → records (listByMember)
//       → 按 metric (身高/体重) 映射成 chart points
//         → GrowthChart 叠加 WHO 参考百分位
//
// 复用: MedicinesView 的 CRUD modal 模式; TrendsView 的宽页面布局。
// 成员筛选: 仅显示可作为生长追踪对象的成员 (有生日、有性别、0-19y)。
import { computed, onMounted, ref, watch } from 'vue';
import PageContainer from '@/components/layout/PageContainer.vue';
import { useRepositories } from '@/composables/useRepositories';
import type {
  FamilyMember,
  GrowthRecord,
  GrowthRecordCreateInput,
  GrowthRecordUpdateInput,
} from '@/repositories';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import GrowthRecordForm from '@/components/growth/GrowthRecordForm.vue';
import GrowthChart from '@/components/growth/GrowthChart.vue';
import { formatAgeMonths, monthsBetween } from '@/lib/growth/age';
import { METRIC_META, selectLmsTable, type GrowthGender } from '@/lib/growth/lms';
import { percentileForValue, type GrowthMetric } from '@/lib/growth/percentile';

// === 数据 ===
const allMembers = ref<FamilyMember[]>([]);
const records = ref<GrowthRecord[]>([]);
const isLoading = ref(false);
const loadError = ref<string | null>(null);
const selectedMemberId = ref<number | null>(null);
const activeMetric = ref<GrowthMetric>('height');

const TODAY = new Date().toISOString().slice(0, 10);
const AGE_MAX_MONTHS = 19 * 12; // 19 岁 = 生长标准覆盖上限

// 仅保留可追踪成员: 有生日 + 性别男/女 + 月龄 0-228
function isTrackable(m: FamilyMember): boolean {
  if (!m.birthday) return false;
  if (m.gender !== 'male' && m.gender !== 'female') return false;
  const age = monthsBetween(m.birthday, TODAY);
  return age >= 0 && age <= AGE_MAX_MONTHS;
}

const children = computed(() => allMembers.value.filter(isTrackable));

const selectedMember = computed<FamilyMember | null>(() => {
  if (selectedMemberId.value === null) return null;
  return children.value.find((m) => m.id === selectedMemberId.value) ?? null;
});

// === 图表数据: 当前指标的有效测量点 ===
interface ChartPoint {
  ageMonths: number;
  value: number;
  measuredDate: string;
}
const chartPoints = computed<ChartPoint[]>(() => {
  if (!selectedMember.value) return [];
  return records.value
    .map((r) => {
      const v = activeMetric.value === 'height' ? r.height_cm : r.weight_kg;
      return v == null ? null : { ageMonths: r.age_months, value: v, measuredDate: r.measured_date };
    })
    .filter((p): p is ChartPoint => p !== null);
});

// LMS 表 (随成员性别 + 当前指标变)
const lmsTable = computed(() => {
  const m = selectedMember.value;
  if (!m || !m.gender) return [];
  return selectLmsTable(m.gender as GrowthGender, activeMetric.value);
});

const metricMeta = computed(() => METRIC_META[activeMetric.value]);

// === 单条记录的百分位 (列表展示用) ===
function heightPct(r: GrowthRecord): number | null {
  const m = selectedMember.value;
  if (!m?.gender || r.height_cm == null) return null;
  const res = percentileForValue(selectLmsTable(m.gender as GrowthGender, 'height'), r.age_months, r.height_cm);
  return res?.percentile ?? null;
}
function weightPct(r: GrowthRecord): number | null {
  const m = selectedMember.value;
  if (!m?.gender || r.weight_kg == null) return null;
  const res = percentileForValue(selectLmsTable(m.gender as GrowthGender, 'weight'), r.age_months, r.weight_kg);
  return res?.percentile ?? null;
}

// === Form modal ===
const showFormModal = ref(false);
const editingRecord = ref<GrowthRecord | null>(null);
const isSaving = ref(false);
const saveError = ref<string | null>(null);

// === 删除 ===
const deletingRecord = ref<GrowthRecord | null>(null);
const isDeleting = ref(false);
const deleteError = ref<string | null>(null);

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
  const [mbsResult] = await Promise.allSettled([repos.familyMember.list()]);
  if (mbsResult.status === 'fulfilled') {
    allMembers.value = mbsResult.value;
    // 默认选第一个可追踪成员
    if (selectedMemberId.value === null) {
      const first = allMembers.value.find(isTrackable);
      selectedMemberId.value = first ? first.id : null;
    }
  } else {
    allMembers.value = [];
    loadError.value = mbsResult.reason instanceof Error ? mbsResult.reason.message : String(mbsResult.reason);
  }
  await loadRecords();
  isLoading.value = false;
}

async function loadRecords(): Promise<void> {
  if (selectedMemberId.value === null) {
    records.value = [];
    return;
  }
  try {
    const repos = await useRepositories();
    records.value = await repos.growth.listByMember(selectedMemberId.value);
  } catch (e) {
    records.value = [];
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

// 切换成员时重载记录
watch(selectedMemberId, () => {
  void loadRecords();
});

function openCreateModal(): void {
  editingRecord.value = null;
  saveError.value = null;
  showFormModal.value = true;
}
function openEditModal(r: GrowthRecord): void {
  editingRecord.value = r;
  saveError.value = null;
  showFormModal.value = true;
}
function closeFormModal(): void {
  if (isSaving.value) return;
  showFormModal.value = false;
  editingRecord.value = null;
  saveError.value = null;
}

async function handleSubmit(input: GrowthRecordCreateInput | GrowthRecordUpdateInput): Promise<void> {
  isSaving.value = true;
  saveError.value = null;
  try {
    const repos = await useRepositories();
    if (editingRecord.value === null) {
      await repos.growth.create(input as GrowthRecordCreateInput);
    } else {
      await repos.growth.update(editingRecord.value.id, input as GrowthRecordUpdateInput);
    }
    showFormModal.value = false;
    editingRecord.value = null;
    await loadRecords();
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSaving.value = false;
  }
}

function openDeleteModal(r: GrowthRecord): void {
  deletingRecord.value = r;
  deleteError.value = null;
}
function closeDeleteModal(): void {
  if (isDeleting.value) return;
  deletingRecord.value = null;
  deleteError.value = null;
}
async function handleDeleteConfirm(): Promise<void> {
  const target = deletingRecord.value;
  if (target === null) return;
  isDeleting.value = true;
  deleteError.value = null;
  try {
    const repos = await useRepositories();
    await repos.growth.delete(target.id);
    deletingRecord.value = null;
    await loadRecords();
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isDeleting.value = false;
  }
}

function memberAgeLabel(m: FamilyMember | null): string {
  if (!m || !m.birthday) return '';
  return formatAgeMonths(monthsBetween(m.birthday, TODAY));
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <PageContainer max-width="wide" class="growth-view">
    <header class="page-header">
      <h1 class="page-title">生长曲线</h1>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="children.length === 0"
        @click="openCreateModal"
      >
        + 录入测量
      </button>
    </header>

    <p v-if="loadError" class="msg msg-error">加载失败: {{ loadError }}</p>
    <p v-else-if="isLoading" class="hint">加载中...</p>

    <!-- 无可追踪成员 -->
    <p v-else-if="children.length === 0" class="empty-state">
      生长曲线需要成员有<strong>出生日期</strong>和<strong>性别</strong>，且年龄在 0–19 岁。
      请先到「成员」页补全孩子的生日与性别。
    </p>

    <template v-else>
      <!-- 成员选择 -->
      <div class="member-bar">
        <div v-if="children.length > 1" class="member-select">
          <label class="micro-label">追踪对象</label>
          <select v-model="selectedMemberId" class="form-input">
            <option v-for="m in children" :key="m.id" :value="m.id">
              {{ m.name }} · {{ memberAgeLabel(m) }}
            </option>
          </select>
        </div>
        <div v-else class="member-single">
          <strong>{{ selectedMember?.name }}</strong>
          <span class="muted">{{ memberAgeLabel(selectedMember) }}</span>
        </div>
      </div>

      <!-- 指标切换 -->
      <div class="metric-tabs">
        <button
          v-for="mk in (['height','weight'] as GrowthMetric[])"
          :key="mk"
          type="button"
          class="metric-tab"
          :class="{ active: activeMetric === mk }"
          @click="activeMetric = mk"
        >
          {{ METRIC_META[mk].label }}
        </button>
      </div>

      <!-- 曲线图 -->
      <section class="chart-card">
        <GrowthChart
          :points="chartPoints"
          :metric="activeMetric"
          :lms-table="lmsTable"
          :unit="metricMeta.unit"
          :metric-label="metricMeta.label"
        />
      </section>

      <!-- 历史记录 -->
      <section class="history">
        <h2 class="section-title">测量记录 ({{ records.length }})</h2>
        <p v-if="records.length === 0" class="history-empty">
          还没有记录。点上方「+ 录入测量」开始建档。
        </p>
        <ul v-else class="record-list">
          <li v-for="r in [...records].reverse()" :key="r.id" class="record-item">
            <div class="rec-main">
              <div class="rec-date">
                {{ r.measured_date }}
                <span class="rec-age muted">· 约 {{ formatAgeMonths(r.age_months) }}</span>
              </div>
              <div class="rec-metrics">
                <span v-if="r.height_cm != null" class="rec-metric">
                  身高 <strong>{{ r.height_cm }}</strong> cm
                  <span v-if="heightPct(r) != null" class="rec-pct">第 {{ heightPct(r)!.toFixed(0) }} 位</span>
                </span>
                <span v-if="r.weight_kg != null" class="rec-metric">
                  体重 <strong>{{ r.weight_kg }}</strong> kg
                  <span v-if="weightPct(r) != null" class="rec-pct">第 {{ weightPct(r)!.toFixed(0) }} 位</span>
                </span>
                <span v-if="r.head_cm != null" class="rec-metric">
                  头围 <strong>{{ r.head_cm }}</strong> cm
                </span>
              </div>
              <p v-if="r.note" class="rec-note muted">{{ r.note }}</p>
            </div>
            <div class="rec-actions">
              <button type="button" class="btn btn-secondary btn-small" @click="openEditModal(r)">编辑</button>
              <button type="button" class="btn btn-danger btn-small" @click="openDeleteModal(r)">删除</button>
            </div>
          </li>
        </ul>
      </section>
    </template>

    <!-- 录入/编辑 modal -->
    <ModalOverlay
      v-if="showFormModal"
      :title="editingRecord ? '编辑测量记录' : '录入测量'"
      width="lg"
      @close="closeFormModal"
    >
      <GrowthRecordForm
        :initial-values="editingRecord"
        :members="children"
        :disabled="isSaving"
        @submit="handleSubmit"
        @cancel="closeFormModal"
      />
      <p v-if="saveError" class="msg msg-error modal-save-error">保存失败: {{ saveError }}</p>
    </ModalOverlay>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="deletingRecord"
      title="删除测量记录"
      :message="`确认删除 ${deletingRecord.measured_date} 的记录?`"
      detail="此操作不可撤销。"
      confirm-text="删除"
      danger
      :loading="isDeleting"
      :error-message="deleteError"
      @confirm="handleDeleteConfirm"
      @cancel="closeDeleteModal"
    />
  </PageContainer>
</template>

<style scoped>
/* .growth-view padding/max-width/margin 由 PageContainer 提供 */

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

.hint {
  color: var(--color-text-muted);
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--color-text-muted);
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
}

.member-bar {
  margin-bottom: 1rem;
}

.member-select {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.member-single {
  font-size: 1.05rem;
}

.micro-label {
  font-size: 0.78rem;
  color: var(--color-text-muted);
}

.form-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--color-border-input, #d1d5db);
  border-radius: var(--radius-input, 4px);
  font-size: 0.95rem;
  font-family: inherit;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
}

.muted {
  color: var(--color-text-muted);
  font-size: 0.85rem;
}

.metric-tabs {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 1rem;
}

.metric-tab {
  padding: 0.4rem 1rem;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-pill, 999px);
  background: var(--color-bg-card);
  color: var(--color-text-secondary);
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
}

.metric-tab.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.chart-card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
}

.history {
  margin-top: 0.5rem;
}

.section-title {
  margin: 0 0 0.75rem;
  font-size: var(--font-size-panel-title, 1.05rem);
}

.history-empty {
  color: var(--color-text-muted);
  padding: 1.5rem;
  text-align: center;
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
}

.record-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.record-item {
  display: flex;
  gap: 1rem;
  justify-content: space-between;
  align-items: flex-start;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: 0.75rem 1rem;
}

.rec-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.rec-date {
  font-weight: 600;
  color: var(--color-text-primary);
}

.rec-age {
  font-weight: 400;
}

.rec-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  font-size: 0.9rem;
  color: var(--color-text-secondary);
}

.rec-pct {
  color: var(--color-primary);
  font-size: 0.8rem;
  margin-left: 0.2rem;
}

.rec-note {
  font-size: 0.82rem;
}

.rec-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

@media (max-width: 580px) {
  .record-item {
    flex-direction: column;
    gap: 0.6rem;
  }
  .rec-actions {
    width: 100%;
  }
}

.msg {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  font-size: 0.9rem;
}

.msg-error {
  background: var(--color-danger-light, #fef2f2);
  color: var(--color-danger-text, #991b1b);
}

.modal-save-error {
  margin-top: 1rem;
}
</style>
