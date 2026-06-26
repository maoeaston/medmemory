<script setup lang="ts">
// TrendsView —— 健康趋势图（v3.3 触点扩展）
//
// 路径: /trends
// 数据流:
//   - onMounted: listDistinctNames() → 指标下拉; familyMember.list() → 成员下拉
//   - watch[selectedNameEn, selectedMemberId]: listHistoryByNameEn → 趋势数据
//   - parseNumericResult 过滤非数值（"阴性"等）→ TrendChart 渲染
//
// 关键决策:
//   - 参考范围带取最后一条的 reference_range（最近一次的标准最相关）
//   - 危急阈值虚线调 getThresholdsByName（不在白名单的指标不画）
//   - 同一天多个数据点按 created_at ASC 排（已在 repo 内保证）
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import PageContainer from '@/components/layout/PageContainer.vue';
import { useRepositories } from '@/composables/useRepositories';
import { parseNumericResult, parseReferenceRange, getThresholdsByName } from '@/lib/medical/criticalValue';
import TrendChart from '@/components/trends/TrendChart.vue';
import type { FamilyMember, TrendPoint } from '@/repositories';

interface ChartPoint {
  date: string;
  value: number;
  abnormal: 'H' | 'L' | 'N' | null;
  memberName: string;
}

const distinctNames = ref<{ name_en: string; name_cn: string; count: number }[]>([]);
const members = ref<FamilyMember[]>([]);
const selectedNameEn = ref<string>('');
const selectedMemberId = ref<number | ''>('');
const trendPoints = ref<TrendPoint[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

const selectedNameInfo = computed(() =>
  distinctNames.value.find((n) => n.name_en === selectedNameEn.value),
);

const chartPoints = computed<ChartPoint[]>(() => {
  return trendPoints.value
    .map((tp) => {
      const value = parseNumericResult(tp.indicator.result);
      if (value === null) return null;
      return {
        date: tp.event_date,
        value,
        abnormal: tp.indicator.abnormal_tag,
        memberName: tp.member_name,
      } satisfies ChartPoint;
    })
    .filter((p): p is ChartPoint => p !== null);
});

/** 参考范围: 取最后一条（最近一次的标准） */
const referenceRange = computed(() => {
  if (trendPoints.value.length === 0) return { low: null, high: null };
  const last = trendPoints.value[trendPoints.value.length - 1];
  return parseReferenceRange(last.indicator.reference_range);
});

/** 危急阈值: 用 name_cn / name_en 调 getThresholdsByName */
const thresholds = computed(() => {
  if (trendPoints.value.length === 0) return null;
  const first = trendPoints.value[0];
  return getThresholdsByName(first.indicator.name_cn, first.indicator.name_en);
});

const unit = computed(() => {
  if (trendPoints.value.length === 0) return null;
  return trendPoints.value[0].indicator.unit;
});

async function loadOptions(): Promise<void> {
  const repos = await useRepositories();
  const [names, m] = await Promise.all([
    repos.reportIndicator.listDistinctNames(),
    repos.familyMember.list(),
  ]);
  distinctNames.value = names;
  members.value = m;
  // 自动选第一个指标（出现次数最多的）
  if (names.length > 0 && !selectedNameEn.value) {
    selectedNameEn.value = names[0].name_en;
  }
}

async function loadTrend(): Promise<void> {
  if (!selectedNameEn.value) {
    trendPoints.value = [];
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const repos = await useRepositories();
    trendPoints.value = await repos.reportIndicator.listHistoryByNameEn(
      selectedNameEn.value,
      {
        memberId:
          selectedMemberId.value === '' ? undefined : Number(selectedMemberId.value),
      },
    );
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
    trendPoints.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  try {
    await loadOptions();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});

watch([selectedNameEn, selectedMemberId], () => {
  void loadTrend();
});

// 加载完 options 后手动触发一次（watch 不会因 selectedNameEn 改变而 trigger if it was set inside loadOptions)
// 通过 watch 已自动覆盖
</script>

<template>
  <PageContainer max-width="wide" class="trends-view">
    <header class="page-header">
      <h1 class="page-title">📈 健康趋势</h1>
      <RouterLink to="/dashboard" class="back-link">← 返回 Dashboard</RouterLink>
    </header>

    <!-- 空状态: 没有任何指标 -->
    <div v-if="distinctNames.length === 0 && !loadError" class="empty-state">
      <p class="empty-title">暂无化验数据</p>
      <p class="empty-hint">
        上传化验单并通过 AI 处理后，可在此查看指标随时间的变化。
      </p>
      <RouterLink to="/capture" class="empty-cta">上传化验单 →</RouterLink>
    </div>

    <template v-else>
      <!-- 控制栏 -->
      <section class="controls">
        <div class="control-row">
          <label class="control-label">
            <span class="control-text">指标</span>
            <select v-model="selectedNameEn" class="control-input">
              <option value="" disabled>请选择指标</option>
              <option
                v-for="n in distinctNames"
                :key="n.name_en"
                :value="n.name_en"
              >
                {{ n.name_cn }} ({{ n.name_en }}) · {{ n.count }} 次
              </option>
            </select>
          </label>

          <label class="control-label">
            <span class="control-text">成员</span>
            <select v-model="selectedMemberId" class="control-input">
              <option value="">全家</option>
              <option v-for="m in members" :key="m.id" :value="m.id">
                {{ m.name }}
              </option>
            </select>
          </label>
        </div>
      </section>

      <p v-if="loadError" class="msg msg-error">加载失败: {{ loadError }}</p>
      <p v-else-if="loading" class="hint">加载中...</p>

      <!-- 图表区 -->
      <section v-else-if="selectedNameEn" class="chart-section">
        <div class="chart-header">
          <h2 class="chart-title">
            {{ selectedNameInfo?.name_cn ?? selectedNameEn }}
            <small v-if="unit" class="chart-unit">单位: {{ unit }}</small>
          </h2>
          <p class="chart-meta">{{ chartPoints.length }} 个数据点</p>
        </div>

        <TrendChart
          v-if="chartPoints.length > 0"
          :points="chartPoints"
          :reference-range="referenceRange"
          :thresholds="thresholds"
          :unit="unit"
        />
        <p v-else class="hint">
          所选筛选条件下没有可绘制的数值数据（结果可能是「阴性」等非数值）。
        </p>
      </section>

      <!-- 数据明细表 -->
      <section v-if="chartPoints.length > 0" class="detail-section">
        <h3 class="detail-title">数据明细</h3>
        <div class="table-wrapper">
          <table class="detail-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>成员</th>
                <th>测定值</th>
                <th>参考范围</th>
                <th>标签</th>
                <th class="col-action"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="tp in [...trendPoints].reverse()"
                :key="tp.indicator.id"
              >
                <td>{{ tp.event_date }}</td>
                <td>{{ tp.member_name }}</td>
                <td>
                  <span :class="['result-cell', tp.indicator.abnormal_tag ? `ab-${tp.indicator.abnormal_tag}` : '']">
                    {{ tp.indicator.result }}
                    <small v-if="tp.indicator.unit" class="result-unit">{{ tp.indicator.unit }}</small>
                  </span>
                </td>
                <td>{{ tp.indicator.reference_range ?? '—' }}</td>
                <td>
                  <span v-if="tp.indicator.abnormal_tag === 'H'" class="tag tag-h">偏高</span>
                  <span v-else-if="tp.indicator.abnormal_tag === 'L'" class="tag tag-l">偏低</span>
                  <span v-else-if="tp.indicator.abnormal_tag === 'N'" class="tag tag-n">正常</span>
                  <span v-else class="tag tag-none">—</span>
                </td>
                <td class="col-action">
                  <RouterLink :to="`/events/${tp.event_id}`" class="row-link">
                    查看 →
                  </RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </PageContainer>
</template>

<style scoped>
.trends-view {
  /* padding/max-width/margin 由 PageContainer 提供 */
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.page-title {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-bold);
  color: var(--color-text-primary);
}

.back-link {
  font-size: 0.88rem;
  color: var(--color-primary);
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}

.empty-state {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: 2.5rem 1.5rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.empty-title {
  margin: 0;
  font-size: var(--font-size-section-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.empty-hint {
  margin: 0;
  font-size: var(--font-size-body);
  color: var(--color-text-muted);
  max-width: 420px;
}

.empty-cta {
  margin-top: 1rem;
  padding: 0.6rem 1.2rem;
  background: var(--color-primary);
  color: white;
  text-decoration: none;
  border-radius: var(--radius-button);
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-input);
}

.empty-cta:hover {
  background: var(--color-primary-hover);
}

.controls {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: 0.75rem 1rem;
}

.control-row {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.control-label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex: 1;
  min-width: 180px;
}

.control-text {
  font-size: var(--font-size-meta);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
}

.control-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-badge);
  font-size: var(--font-size-input);
  font-family: inherit;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
}

.control-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

.chart-section {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: var(--space-card-padding);
}

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.75rem;
  gap: 1rem;
  flex-wrap: wrap;
}

.chart-title {
  margin: 0;
  font-size: var(--font-size-panel-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.chart-unit {
  margin-left: 0.5rem;
  font-size: 0.8rem;
  font-weight: var(--font-weight-normal);
  color: var(--color-text-muted);
}

.chart-meta {
  margin: 0;
  font-size: var(--font-size-meta);
  color: var(--color-text-muted);
}

.detail-section {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: var(--space-card-padding);
}

.detail-title {
  margin: 0 0 0.75rem;
  font-size: var(--font-size-input);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.table-wrapper {
  overflow-x: auto;
}

.detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.detail-table th,
.detail-table td {
  padding: 0.5rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid var(--color-bg-muted);
}

.detail-table th {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-secondary);
  background: var(--color-bg-page);
  font-size: var(--font-size-meta);
}

.detail-table tbody tr:hover {
  background: var(--color-bg-page);
}

.result-cell {
  font-weight: var(--font-weight-medium);
}

.result-cell.ab-H {
  color: var(--color-danger);
}

.result-cell.ab-L {
  color: var(--color-warning);
}

.result-unit {
  margin-left: 0.25rem;
  color: var(--color-text-muted);
  font-size: var(--font-size-caption);
  font-weight: var(--font-weight-normal);
}

.tag {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-pill);
  font-size: var(--font-size-badge);
  font-weight: var(--font-weight-semibold);
}

.tag-h {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}

.tag-l {
  background: var(--color-warning-light);
  color: var(--color-warning-text);
}

.tag-n {
  background: var(--color-success-light);
  color: var(--color-success);
}

.tag-none {
  color: var(--color-text-faint);
}

.col-action {
  width: 4rem;
  text-align: right;
}

.row-link {
  font-size: var(--font-size-meta);
  color: var(--color-primary);
  text-decoration: none;
  white-space: nowrap;
}

.row-link:hover {
  text-decoration: underline;
}

.msg {
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-badge);
  font-size: 0.88rem;
}

.msg-error {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}

.hint {
  color: var(--color-text-muted);
  font-size: 0.88rem;
  padding: 0.5rem 0;
  margin: 0;
}
</style>
