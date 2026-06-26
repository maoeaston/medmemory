<script setup lang="ts">
// LabInterpretationModal —— 化验单 AI 解读展示 + 重新生成
//
// v3.2 PRD §2.1
//
// 行为:
//   - onMounted: 先读 ai_interpretations 缓存（getLatestByAttachment） + 加载 lab_indicators
//   - 无缓存: 自动调 useHealthAgent.interpretLabResult 生成
//   - 有缓存: 直接展示, 用户可点「重新生成」强制刷新
//
// 危急值硬规则（不落库, UI 实时叠加）:
//   - 调 criticalValue.checkCriticalValues(labIndicators)
//   - 若有告警: 强制红色高亮「⚠️ 建议立即就医」, 覆盖 LLM urgency
//   - 若无告警: 按 LLM urgency 展示
//
// Props:
//   - attachmentId: 目标附件 ID
//   - eventSummary: 事件摘要（传给 LLM 提供上下文）
//
// lab_indicators 由 modal 内部加载（reportIndicator.listByAttachment）,
// 避免父组件 EventDetailView 需要为每个附件管理 indicators 状态。
import { computed, onMounted, ref } from 'vue';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import { useHealthAgent } from '@/composables/useHealthAgent';
import { useRepositories } from '@/composables/useRepositories';
import { checkCriticalValues, type CriticalValueAlert } from '@/lib/medical/criticalValue';
import type { LabIndicator } from '@/repositories';
import type { LabInterpretation as LabInterpretationResult } from '@/lib/ai/AiProvider';

const props = defineProps<{
  attachmentId: number;
  eventSummary: string | null;
}>();

const emit = defineEmits<{ close: [] }>();

const {
  isProcessing,
  interpretLabResult,
  getLatestLabInterpretation,
} = useHealthAgent();

const interpretation = ref<LabInterpretationResult | null>(null);
const labIndicators = ref<LabIndicator[]>([]);
const loadError = ref<string | null>(null);

/**
 * 危急值告警（实时计算, 不缓存）。
 * labIndicators 变化时自动重算。
 */
const criticalAlerts = computed<CriticalValueAlert[]>(() =>
  checkCriticalValues(labIndicators.value),
);

/**
 * 实际展示的 urgency:
 *   - 有危急值告警 → 强制 'urgent_visit'（红色高亮）
 *   - 无告警 → 用 LLM 软判断
 */
const effectiveUrgency = computed<LabInterpretationResult['urgency']>(() => {
  if (criticalAlerts.value.length > 0) return 'urgent_visit';
  return interpretation.value?.urgency ?? 'observe';
});

const urgencyLabel = computed(() => {
  switch (effectiveUrgency.value) {
    case 'urgent_visit':
      return '建议立即就医';
    case 'suggest_visit':
      return '建议择期就诊';
    case 'observe':
    default:
      return '继续观察';
  }
});

const urgencyClass = computed(() => {
  switch (effectiveUrgency.value) {
    case 'urgent_visit':
      return 'urgency-urgent';
    case 'suggest_visit':
      return 'urgency-suggest';
    case 'observe':
    default:
      return 'urgency-observe';
  }
});

const hasResult = computed(() => interpretation.value !== null);

async function loadLabIndicators(): Promise<void> {
  try {
    const repos = await useRepositories();
    labIndicators.value = await repos.reportIndicator.listByAttachment(
      props.attachmentId,
    );
  } catch (e) {
    // 指标加载失败不阻塞解读, 但危急值检查会为空
    console.warn('[LabInterpretationModal] 加载 lab_indicators 失败:', e);
    labIndicators.value = [];
  }
}

async function loadOrGenerate(forceFresh = false): Promise<void> {
  loadError.value = null;
  try {
    if (!forceFresh) {
      const cached = await getLatestLabInterpretation(props.attachmentId);
      if (cached) {
        interpretation.value = cached;
        return;
      }
    }
    // 无缓存或强制刷新 → 调 AI
    const fresh = await interpretLabResult(
      props.attachmentId,
      props.eventSummary,
    );
    interpretation.value = fresh;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

async function handleRegenerate(): Promise<void> {
  await loadOrGenerate(true);
}

onMounted(() => {
  void loadLabIndicators();
  void loadOrGenerate(false);
});
</script>

<template>
  <ModalOverlay
    title="化验单 AI 解读"
    width="lg"
    variant="fullscreen"
    @close="emit('close')"
  >
    <div class="lab-interpretation">
      <!-- 危急值硬规则告警（永远在顶部, 触发时强制红色） -->
      <div
        v-if="criticalAlerts.length > 0"
        class="critical-alert-banner"
      >
        <div class="critical-banner-title">
          ⚠️ 检测到危急值 — 建议立即就医
        </div>
        <ul class="critical-alert-list">
          <li
            v-for="alert in criticalAlerts"
            :key="alert.indicatorId"
          >
            {{ alert.description }}
          </li>
        </ul>
        <p class="critical-banner-note">
          此告警由硬规则实时计算, 优先于 AI 软判断。
        </p>
      </div>

      <!-- Loading 状态 -->
      <div v-if="isProcessing && !hasResult" class="state-block">
        <span class="spinner" aria-hidden="true"></span>
        <span>正在生成 AI 解读（通常 10-30 秒）...</span>
      </div>

      <!-- 错误状态 -->
      <div v-else-if="loadError" class="state-block state-error">
        <p class="error-title">解读失败</p>
        <p class="error-detail">{{ loadError }}</p>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="isProcessing"
          @click="handleRegenerate"
        >重试</button>
      </div>

      <!-- 空状态（理论上不会出现, interpretLabResult 抛错会被上面捕获） -->
      <div v-else-if="!hasResult" class="state-block">
        <p>暂无解读结果</p>
      </div>

      <!-- 结果展示 -->
      <template v-else-if="interpretation">
        <!-- urgency 横幅 -->
        <div :class="['urgency-banner', urgencyClass]">
          <span class="urgency-label">{{ urgencyLabel }}</span>
          <span v-if="criticalAlerts.length > 0" class="urgency-source">
            （基于硬规则）
          </span>
          <span v-else class="urgency-source">
            （AI 软判断）
          </span>
        </div>

        <!-- 整体印象 -->
        <section v-if="interpretation.overallImpression" class="result-section">
          <h3 class="section-h">整体印象</h3>
          <p class="section-text">{{ interpretation.overallImpression }}</p>
        </section>

        <!-- 异常项解读 -->
        <section
          v-if="interpretation.abnormalExplanations.length > 0"
          class="result-section"
        >
          <h3 class="section-h">异常项解读</h3>
          <ul class="explanation-list">
            <li
              v-for="(item, idx) in interpretation.abnormalExplanations"
              :key="idx"
            >
              <div class="explanation-name">{{ item.indicatorName }}</div>
              <div class="explanation-text">{{ item.interpretation }}</div>
              <div v-if="item.possibleCauses.length > 0" class="explanation-causes">
                可能原因: {{ item.possibleCauses.join(' / ') }}
              </div>
            </li>
          </ul>
        </section>

        <!-- 综合建议 -->
        <section v-if="interpretation.recommendation" class="result-section">
          <h3 class="section-h">综合建议</h3>
          <p class="section-text">{{ interpretation.recommendation }}</p>
        </section>

        <!-- 建议就诊科室 -->
        <section
          v-if="interpretation.suggestedDepartments.length > 0"
          class="result-section"
        >
          <h3 class="section-h">建议就诊科室</h3>
          <div class="department-chips">
            <span
              v-for="dept in interpretation.suggestedDepartments"
              :key="dept"
              class="department-chip"
            >{{ dept }}</span>
          </div>
        </section>

        <!-- 重新生成按钮 -->
        <div class="regen-row">
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="isProcessing"
            @click="handleRegenerate"
          >
            {{ isProcessing ? '解读中...' : '重新生成' }}
          </button>
          <span v-if="isProcessing" class="regen-hint">将创建新版本, 旧版本保留供历史对比</span>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="disclaimer-footer">
        <span class="disclaimer-icon">⚠️</span>
        <span class="disclaimer-text">
          本解读仅供参考, 不替代医生诊断。指标异常不等于患病, 需结合临床。
          请遵医嘱, 必要时及时就医。
        </span>
        <button
          type="button"
          class="btn btn-secondary"
          @click="emit('close')"
        >关闭</button>
      </div>
    </template>
  </ModalOverlay>
</template>

<style scoped>
.lab-interpretation {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

/* === 危急值告警横幅 === */
.critical-alert-banner {
  background: #fef2f2;
  border: 2px solid #dc2626;
  border-radius: 6px;
  padding: 0.7rem 0.9rem;
}

.critical-banner-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: #991b1b;
  margin-bottom: 0.4rem;
}

.critical-alert-list {
  margin: 0.3rem 0 0.5rem;
  padding-left: 1.2rem;
  font-size: 0.85rem;
  color: #991b1b;
  line-height: 1.5;
}

.critical-banner-note {
  margin: 0.4rem 0 0;
  font-size: 0.75rem;
  color: #b91c1c;
  font-style: italic;
}

/* === urgency 横幅 === */
.urgency-banner {
  padding: 0.55rem 0.8rem;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.95rem;
  font-weight: 600;
}

.urgency-urgent {
  background: #fee2e2;
  color: #991b1b;
  border-left: 4px solid #dc2626;
}

.urgency-suggest {
  background: #fef3c7;
  color: #92400e;
  border-left: 4px solid #d97706;
}

.urgency-observe {
  background: #ecfdf5;
  color: #065f46;
  border-left: 4px solid #10b981;
}

.urgency-source {
  font-size: 0.78rem;
  font-weight: 400;
  opacity: 0.85;
}

/* === 状态块 === */
.state-block {
  padding: 1.5rem;
  text-align: center;
  color: #6b7280;
  font-size: 0.9rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.state-error {
  color: #991b1b;
  background: #fef2f2;
  border-radius: 4px;
}

.error-title {
  font-weight: 600;
  margin: 0;
}

.error-detail {
  font-size: 0.82rem;
  margin: 0;
  word-break: break-word;
}

.spinner {
  display: inline-block;
  width: 1.2rem;
  height: 1.2rem;
  border: 2px solid #d1d5db;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* === 结果段落 === */
.result-section {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.section-h {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1e40af;
}

.section-text {
  margin: 0;
  font-size: 0.9rem;
  color: #1f2937;
  line-height: 1.6;
}

.explanation-list {
  margin: 0;
  padding-left: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.explanation-list li {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.explanation-name {
  font-weight: 600;
  color: #1f2937;
  font-size: 0.88rem;
}

.explanation-text {
  font-size: 0.85rem;
  color: #374151;
  line-height: 1.5;
}

.explanation-causes {
  font-size: 0.78rem;
  color: #6b7280;
}

.department-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.department-chip {
  padding: 0.2rem 0.6rem;
  background: #dbeafe;
  color: #1e40af;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 500;
}

.regen-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.4rem;
  padding-top: 0.6rem;
  border-top: 1px dashed #e5e7eb;
}

.regen-hint {
  font-size: 0.75rem;
  color: #9ca3af;
  font-style: italic;
}

/* .btn / .btn-secondary / .btn:disabled 已统一在 src/styles/buttons.css
 * 删除原 scoped 重复定义, 全局 .btn 自带 min-height: 44px (触摸目标达标) */

/* === footer disclaimer === */
.disclaimer-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  font-size: 0.78rem;
  color: #92400e;
}

.disclaimer-icon {
  font-size: 0.9rem;
}

.disclaimer-text {
  flex: 1;
  line-height: 1.4;
}
</style>
