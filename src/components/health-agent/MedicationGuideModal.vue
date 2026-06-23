<script setup lang="ts">
// MedicationGuideModal —— 用药指南展示 + 重新生成
//
// v3.2 PRD §2.2
//
// 行为:
//   - onMounted: 先读 ai_interpretations 缓存（getLatestByMedicine）
//   - 无缓存: 自动调 useHealthAgent.guideMedication 生成
//   - 有缓存: 直接展示, 用户可点「重新生成」强制刷新
//
// Props:
//   - medicineId: 目标药物 ID
import { computed, onMounted, ref } from 'vue';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import { useHealthAgent } from '@/composables/useHealthAgent';
import type { MedicationGuide as MedicationGuideResult } from '@/lib/ai/AiProvider';

const props = defineProps<{
  medicineId: number;
}>();

const emit = defineEmits<{ close: [] }>();

const {
  isProcessing,
  guideMedication,
  getLatestMedicationGuide,
} = useHealthAgent();

const guide = ref<MedicationGuideResult | null>(null);
const loadError = ref<string | null>(null);

const hasResult = computed(() => guide.value !== null);

const prescriptionLabel = computed(() =>
  guide.value?.requiresPrescription ? '需医生指导' : '非处方 (OTC)',
);

async function loadOrGenerate(forceFresh = false): Promise<void> {
  loadError.value = null;
  try {
    if (!forceFresh) {
      const cached = await getLatestMedicationGuide(props.medicineId);
      if (cached) {
        guide.value = cached;
        return;
      }
    }
    const fresh = await guideMedication(props.medicineId);
    guide.value = fresh;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
}

async function handleRegenerate(): Promise<void> {
  await loadOrGenerate(true);
}

onMounted(() => {
  void loadOrGenerate(false);
});
</script>

<template>
  <ModalOverlay
    title="AI 用药指南"
    width="lg"
    @close="emit('close')"
  >
    <div class="med-guide">
      <!-- Loading 状态 -->
      <div v-if="isProcessing && !hasResult" class="state-block">
        <span class="spinner" aria-hidden="true"></span>
        <span>正在生成用药指南（通常 10-30 秒）...</span>
      </div>

      <!-- 错误状态 -->
      <div v-else-if="loadError" class="state-block state-error">
        <p class="error-title">生成失败</p>
        <p class="error-detail">{{ loadError }}</p>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="isProcessing"
          @click="handleRegenerate"
        >重试</button>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!hasResult" class="state-block">
        <p>暂无用药指南</p>
      </div>

      <!-- 结果展示 -->
      <template v-else-if="guide">
        <!-- 处方属性横幅 -->
        <div :class="['rx-banner', guide.requiresPrescription ? 'rx-rx' : 'rx-otc']">
          <span class="rx-label">{{ prescriptionLabel }}</span>
        </div>

        <!-- 红旗警示（成员特定, 必看） -->
        <section
          v-if="guide.redFlags.length > 0"
          class="result-section result-warning"
        >
          <h3 class="section-h">⚠️ 成员特定警示</h3>
          <ul class="bullet-list">
            <li v-for="(flag, idx) in guide.redFlags" :key="idx">{{ flag }}</li>
          </ul>
        </section>

        <!-- 药物概述 -->
        <section v-if="guide.overview" class="result-section">
          <h3 class="section-h">药物概述</h3>
          <p class="section-text">{{ guide.overview }}</p>
        </section>

        <!-- 用法用量 -->
        <section v-if="guide.usualDosage" class="result-section">
          <h3 class="section-h">用法用量（说明书常规）</h3>
          <p class="section-text">{{ guide.usualDosage }}</p>
        </section>

        <!-- 常见副作用 -->
        <section
          v-if="guide.commonSideEffects.length > 0"
          class="result-section"
        >
          <h3 class="section-h">常见副作用</h3>
          <ul class="bullet-list">
            <li v-for="(s, idx) in guide.commonSideEffects" :key="idx">{{ s }}</li>
          </ul>
        </section>

        <!-- 严重副作用（需立即停药就医） -->
        <section
          v-if="guide.seriousSideEffects.length > 0"
          class="result-section result-warning"
        >
          <h3 class="section-h">⚠️ 严重副作用（需立即停药就医）</h3>
          <ul class="bullet-list">
            <li v-for="(s, idx) in guide.seriousSideEffects" :key="idx">{{ s }}</li>
          </ul>
        </section>

        <!-- 药物相互作用 -->
        <section
          v-if="guide.interactions.length > 0"
          class="result-section"
        >
          <h3 class="section-h">与同成员其他药物相互作用</h3>
          <ul class="interaction-list">
            <li
              v-for="(interaction, idx) in guide.interactions"
              :key="idx"
              :class="['interaction-item', `severity-${interaction.severity}`]"
            >
              <div class="interaction-head">
                <span class="interaction-other">{{ interaction.otherMedicine }}</span>
                <span class="interaction-severity">{{ interaction.severity }}</span>
              </div>
              <p class="interaction-desc">{{ interaction.description }}</p>
            </li>
          </ul>
        </section>

        <!-- 重新生成按钮 -->
        <div class="regen-row">
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="isProcessing"
            @click="handleRegenerate"
          >
            {{ isProcessing ? '生成中...' : '重新生成' }}
          </button>
          <span v-if="isProcessing" class="regen-hint">将创建新版本, 旧版本保留供历史对比</span>
        </div>
      </template>
    </div>

    <template #footer>
      <div class="disclaimer-footer">
        <span class="disclaimer-icon">⚠️</span>
        <span class="disclaimer-text">
          本指南仅解读已存在药物, 不开新处方, 不计算个人剂量。
          特殊人群（儿童/孕妇/老年人/肝肾功能不全）必须遵医嘱。
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
.med-guide {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

/* === 处方属性横幅 === */
.rx-banner {
  padding: 0.5rem 0.8rem;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.rx-rx {
  background: #fef3c7;
  color: #92400e;
  border-left: 4px solid #d97706;
}

.rx-otc {
  background: #ecfdf5;
  color: #065f46;
  border-left: 4px solid #10b981;
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
  padding: 0.6rem;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  background: white;
}

.result-warning {
  border-color: #fecaca;
  background: #fefcfb;
}

.section-h {
  margin: 0;
  font-size: 0.88rem;
  font-weight: 600;
  color: #1e40af;
}

.result-warning .section-h {
  color: #b91c1c;
}

.section-text {
  margin: 0;
  font-size: 0.88rem;
  color: #1f2937;
  line-height: 1.6;
}

.bullet-list {
  margin: 0;
  padding-left: 1.2rem;
  font-size: 0.85rem;
  color: #374151;
  line-height: 1.6;
}

/* === 相互作用列表 === */
.interaction-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.interaction-item {
  padding: 0.5rem 0.6rem;
  border-radius: 4px;
  border-left: 3px solid #d1d5db;
  background: #f9fafb;
}

.severity-mild {
  border-left-color: #10b981;
}

.severity-moderate {
  border-left-color: #d97706;
}

.severity-severe {
  border-left-color: #dc2626;
  background: #fef2f2;
}

.interaction-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.2rem;
}

.interaction-other {
  font-weight: 600;
  color: #1f2937;
  font-size: 0.88rem;
}

.interaction-severity {
  font-size: 0.72rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: #e5e7eb;
  color: #4b5563;
  text-transform: uppercase;
  font-weight: 600;
}

.interaction-desc {
  margin: 0;
  font-size: 0.82rem;
  color: #4b5563;
  line-height: 1.5;
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

.btn {
  padding: 0.4rem 0.85rem;
  border: none;
  border-radius: 4px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s;
}

.btn-secondary {
  background: #f3f4f6;
  color: #4b5563;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

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
