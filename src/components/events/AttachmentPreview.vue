<script setup lang="ts">
// AttachmentPreview —— 事件详情页里单个附件的预览卡
//
// 渲染策略:
//   - photo (jpg/png): <img> 缩略图 + AI 处理状态/按钮/摘要折叠
//   - pdf: 文件名 + "在新标签打开"链接（PDF AI 处理 v1 不支持）
//
// 原件加载: 每次组件 mount 都重新 IndexedDbStorageAdapter.getFile(storage_key)
//   家庭数据量小, 不缓存（符合 .continue-here.md Key Decision）
//   objectURL 在 unmount 时 revokeObjectURL, 避免内存泄漏
//
// AI 处理 UI (仅 photo):
//   - UPLOADED: 显示"开始处理"按钮（需配置 API key）
//   - OCR_PROCESSING: 显示"AI 处理中..."（轮询 DB 每 3s, 适配 archive 后台触发）
//   - SUMMARY_DONE: 显示"已处理" + 可折叠摘要/OCR/tags + "重新生成"按钮
//   - FAILED: 显示红色错误 + "重试"按钮
//
// 原件缺失/加载失败不阻塞整个详情页, 只在该卡片显示错误
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';
import { useRepositories } from '@/composables/useRepositories';
import { useAiConfig } from '@/composables/useAiConfig';
import { useAiProcess } from '@/composables/useAiProcess';
import type {
  Attachment,
  DocType,
  LabIndicator,
  ProcessingStatus,
} from '@/repositories';

const props = defineProps<{
  attachment: Attachment;
}>();

const storage = new IndexedDbStorageAdapter();

// === 原件加载 ===
const objectUrl = ref<string | null>(null);
const loadError = ref<string | null>(null);
const isLoading = ref(false);

// === AI 处理本地状态（轮询同步, 因为后台触发时 prop 不会更新） ===
const localStatus = ref<ProcessingStatus>(props.attachment.processing_status);
const localError = ref<string | null>(props.attachment.processing_error);
const localTags = ref<string[]>([...props.attachment.tags]);
const localDocType = ref<DocType | null>(props.attachment.doc_type);
const localSubtype = ref<string | null>(props.attachment.subtype);

// 父组件更新 prop 时同步（防御性, 当前 EventDetailView 不重取）
watch(
  () => props.attachment.processing_status,
  (s) => {
    localStatus.value = s;
  },
);
watch(
  () => props.attachment.processing_error,
  (e) => {
    localError.value = e;
  },
);
watch(
  () => props.attachment.doc_type,
  (d) => {
    localDocType.value = d;
  },
);
watch(
  () => props.attachment.subtype,
  (s) => {
    localSubtype.value = s;
  },
);

// === AI 处理 composable ===
const { isProcessing, processingError, processAttachment, isApiKeyError } =
  useAiProcess();
const { hasKey } = useAiConfig();

// === ai_contents 懒加载 ===
const summaryContent = ref<string | null>(null);
const ocrContent = ref<string | null>(null);
const aiModel = ref<string | null>(null);
const labIndicators = ref<LabIndicator[]>([]);
const contentLoadError = ref<string | null>(null);
const isLoadingContent = ref(false);
const isExpanded = ref(false);

// === doc_type 手动兜底 ===
const isUpdatingDocType = ref(false);
const docTypeError = ref<string | null>(null);

/**
 * 下拉选项。'' 代表 null (未分类, 等待 AI 判型或主动留空)。
 */
const DOC_TYPE_OPTIONS: ReadonlyArray<{ value: DocType | ''; label: string }> = [
  { value: '', label: '未分类' },
  { value: 'lab_report', label: '化验报告' },
  { value: 'prescription', label: '处方' },
  { value: 'imaging_report', label: '影像报告' },
  { value: 'outpatient_record', label: '门诊记录' },
  { value: 'discharge_summary', label: '出院小结' },
  { value: 'receipt', label: '收据' },
  { value: 'other', label: '其他' },
];

const selectValue = computed(() => localDocType.value ?? '');

// === 常量 ===
const isImage =
  props.attachment.file_type === 'jpg' ||
  props.attachment.file_type === 'png';

const docTypeLabel: Partial<Record<DocType, string>> = {
  outpatient_record: '门诊记录',
  lab_report: '化验报告',
  imaging_report: '影像报告',
  prescription: '处方',
  discharge_summary: '出院小结',
  receipt: '收据',
  other: '其他',
};

const statusLabel: Record<ProcessingStatus, string> = {
  UPLOADED: '待处理',
  OCR_PROCESSING: 'AI 处理中',
  OCR_DONE: 'OCR 完成',
  SUMMARY_DONE: '已处理',
  FAILED: '处理失败',
};

// === 计算属性 ===
const statusBadgeClass = computed(() => {
  switch (localStatus.value) {
    case 'SUMMARY_DONE':
      return 'badge-done';
    case 'OCR_PROCESSING':
      return 'badge-processing';
    case 'FAILED':
      return 'badge-failed';
    default:
      return 'badge-pending';
  }
});

function metaLine(): string {
  const parts: string[] = [];
  if (localDocType.value) {
    const label = docTypeLabel[localDocType.value] ?? localDocType.value;
    parts.push(label);
  }
  if (localSubtype.value) {
    parts.push(localSubtype.value);
  }
  if (localTags.value.length > 0) {
    parts.push(localTags.value.join('/'));
  }
  return parts.join(' · ');
}

// === 原件加载 ===
async function loadFile(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  try {
    const blob = await storage.getFile(props.attachment.storage_key);
    if (blob === null) {
      loadError.value = '原件缺失（可能已清理）';
      return;
    }
    objectUrl.value = URL.createObjectURL(blob);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

function openOriginal(): void {
  if (objectUrl.value !== null) {
    window.open(objectUrl.value, '_blank', 'noopener');
  }
}

// === AI 处理状态轮询 ===
let pollHandle: number | null = null;

async function refreshStatus(): Promise<void> {
  try {
    const repos = await useRepositories();
    const fresh = await repos.attachment.getById(props.attachment.id);
    if (fresh) {
      localStatus.value = fresh.processing_status;
      localError.value = fresh.processing_error;
      localTags.value = [...fresh.tags];
      localDocType.value = fresh.doc_type;
      localSubtype.value = fresh.subtype;
    }
  } catch (e) {
    console.error('[AttachmentPreview] 状态轮询失败:', e);
  }
}

function startPollingIfNeeded(): void {
  if (localStatus.value === 'OCR_PROCESSING' && pollHandle === null) {
    pollHandle = window.setInterval(refreshStatus, 3000);
  }
}

function stopPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

watch(localStatus, (s) => {
  if (s === 'OCR_PROCESSING') {
    startPollingIfNeeded();
  } else {
    stopPolling();
  }
});

// === AI 内容懒加载 ===
async function loadAiContent(): Promise<void> {
  if (!isImage) return;
  isLoadingContent.value = true;
  contentLoadError.value = null;
  try {
    const repos = await useRepositories();
    const [summary, ocr, indicators] = await Promise.all([
      repos.aiContent.getLatestByAttachment(props.attachment.id, 'summary'),
      repos.aiContent.getLatestByAttachment(
        props.attachment.id,
        'ocr_fulltext',
      ),
      repos.reportIndicator.listByAttachment(props.attachment.id),
    ]);
    summaryContent.value = summary?.content ?? null;
    ocrContent.value = ocr?.content ?? null;
    aiModel.value = summary?.model ?? ocr?.model ?? null;
    labIndicators.value = indicators;
  } catch (e) {
    contentLoadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoadingContent.value = false;
  }
}

async function toggleExpand(): Promise<void> {
  isExpanded.value = !isExpanded.value;
  // 每次展开都重新加载 (重新生成后旧缓存需要刷新)
  if (isExpanded.value && !isLoadingContent.value) {
    await loadAiContent();
  }
}

// === doc_type 手动兜底 ===
async function handleDocTypeChange(e: Event): Promise<void> {
  const target = e.target as HTMLSelectElement;
  const value = target.value === '' ? null : (target.value as DocType);
  if (value === localDocType.value) return;

  isUpdatingDocType.value = true;
  docTypeError.value = null;
  try {
    const repos = await useRepositories();
    // subtype 传 undefined = 保留原值 (用户只改 doc_type, LLM 给的 subtype 不应被清)
    const updated = await repos.attachment.updateDocType(
      props.attachment.id,
      value,
      undefined,
    );
    localDocType.value = updated.doc_type;
    localSubtype.value = updated.subtype;
  } catch (err) {
    docTypeError.value = err instanceof Error ? err.message : String(err);
    // 回滚 select 显示
    target.value = selectValue.value;
  } finally {
    isUpdatingDocType.value = false;
  }
}

// === AI 处理按钮 ===
async function handleProcess(): Promise<void> {
  try {
    await processAttachment(props.attachment.id);
    await refreshStatus();
    // 新处理完成自动展开
    if (localStatus.value === 'SUMMARY_DONE') {
      isExpanded.value = true;
      await loadAiContent();
    }
  } catch (e) {
    await refreshStatus();
    if (isApiKeyError(e)) {
      // API key 错误特殊提示（UI 显示跳设置页链接）
      console.warn('[AttachmentPreview] API key 无效, 跳设置页配置');
    }
    // processingError 已在 useAiProcess 内更新
  }
}

// === 生命周期 ===
onMounted(() => {
  void loadFile();
  startPollingIfNeeded();
});

onUnmounted(() => {
  stopPolling();
  if (objectUrl.value !== null) {
    URL.revokeObjectURL(objectUrl.value);
  }
});
</script>

<template>
  <article class="attachment-card">
    <!-- photo: 缩略图 -->
    <button
      v-if="isImage"
      type="button"
      class="photo-thumb"
      :disabled="isLoading || !!loadError"
      @click="openOriginal"
    >
      <span v-if="isLoading" class="placeholder-msg">加载中...</span>
      <span v-else-if="loadError" class="placeholder-msg error">{{ loadError }}</span>
      <img
        v-else-if="objectUrl"
        :src="objectUrl"
        :alt="props.attachment.file_name"
        class="photo-img"
      />
    </button>

    <!-- pdf: 文件名链接 -->
    <div v-else-if="props.attachment.file_type === 'pdf'" class="pdf-block">
      <div v-if="isLoading" class="placeholder-msg">加载中...</div>
      <div v-else-if="loadError" class="placeholder-msg error">{{ loadError }}</div>
      <button
        v-else
        type="button"
        class="pdf-link"
        @click="openOriginal"
      >
        <span class="pdf-icon">📄</span>
        <span class="pdf-name">{{ props.attachment.file_name }}</span>
        <span class="pdf-hint">点击打开</span>
      </button>
    </div>

    <div class="attachment-meta">
      <div class="meta-filename">{{ props.attachment.file_name }}</div>
      <div v-if="metaLine()" class="meta-line">{{ metaLine() }}</div>
      <div class="meta-sub">
        <span>#{{ props.attachment.id }}</span>
        <span>· {{ props.attachment.file_type.toUpperCase() }}</span>
        <span
          v-if="isImage && localStatus !== 'UPLOADED'"
          class="status-badge"
          :class="statusBadgeClass"
        >{{ statusLabel[localStatus] }}</span>
      </div>

      <!-- doc_type 手动兜底 (仅 image: PDF 不在 v1 AI 处理范围) -->
      <div v-if="isImage" class="doc-type-row">
        <label class="doc-type-label" :for="`doc-type-${props.attachment.id}`">
          分类
        </label>
        <select
          :id="`doc-type-${props.attachment.id}`"
          class="doc-type-select"
          :value="selectValue"
          :disabled="isUpdatingDocType"
          @change="handleDocTypeChange"
        >
          <option
            v-for="opt in DOC_TYPE_OPTIONS"
            :key="opt.value"
            :value="opt.value"
          >{{ opt.label }}</option>
        </select>
        <span v-if="isUpdatingDocType" class="doc-type-hint">保存中...</span>
        <span v-else-if="docTypeError" class="doc-type-hint error">
          {{ docTypeError }}
        </span>
      </div>
    </div>

    <!-- AI 处理区（仅 image） -->
    <div v-if="isImage" class="ai-section">
      <!-- UPLOADED: 待处理 -->
      <div v-if="localStatus === 'UPLOADED'" class="ai-pending">
        <button
          v-if="hasKey"
          type="button"
          class="ai-btn"
          :disabled="isProcessing"
          @click="handleProcess"
        >开始 AI 处理</button>
        <p v-else class="ai-hint">
          未配置 OpenAI API key, 请到
          <RouterLink to="/settings" class="link">设置页</RouterLink>
          填写。
        </p>
      </div>

      <!-- OCR_PROCESSING: 处理中（含本地触发 + 后台触发两种来源） -->
      <div v-else-if="localStatus === 'OCR_PROCESSING'" class="ai-processing">
        <span class="spinner" aria-hidden="true"></span>
        <span class="ai-text">AI 处理中... (通常 10-30 秒)</span>
      </div>

      <!-- SUMMARY_DONE: 已处理 -->
      <div v-else-if="localStatus === 'SUMMARY_DONE'" class="ai-done">
        <button
          type="button"
          class="ai-toggle"
          @click="toggleExpand"
        >
          {{ isExpanded ? '▼ 收起 AI 结果' : '▶ 查看 AI 结果' }}
        </button>
        <button
          type="button"
          class="ai-btn ai-btn-secondary"
          :disabled="isProcessing"
          @click="handleProcess"
        >重新生成</button>

        <div v-if="isExpanded" class="ai-content">
          <p v-if="isLoadingContent" class="placeholder-msg">加载中...</p>
          <p v-else-if="contentLoadError" class="placeholder-msg error">
            加载失败: {{ contentLoadError }}
          </p>
          <template v-else>
            <section v-if="summaryContent" class="ai-block">
              <h4 class="ai-block-title">摘要</h4>
              <p class="ai-block-text">{{ summaryContent }}</p>
            </section>

            <!-- 化验单指标表 (仅 doc_type=lab_report 且有数据时) -->
            <section
              v-if="labIndicators.length > 0"
              class="ai-block indicator-block"
            >
              <h4 class="ai-block-title">
                检验指标 ({{ labIndicators.length }})
              </h4>
              <div class="indicator-table-wrap">
                <table class="indicator-table">
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>结果</th>
                      <th>参考范围</th>
                      <th>标记</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="ind in labIndicators"
                      :key="ind.id"
                    >
                      <td class="ind-name">
                        <span class="ind-name-cn">{{ ind.name_cn }}</span>
                        <span v-if="ind.name_en" class="ind-name-en">
                          {{ ind.name_en }}
                        </span>
                      </td>
                      <td class="ind-result">
                        <span class="ind-result-value">{{ ind.result }}</span>
                        <span v-if="ind.unit" class="ind-unit">{{ ind.unit }}</span>
                      </td>
                      <td class="ind-ref">{{ ind.reference_range ?? '—' }}</td>
                      <td class="ind-tag">
                        <span
                          v-if="ind.abnormal_tag"
                          class="abnormal-tag"
                          :class="`abnormal-${ind.abnormal_tag}`"
                        >{{ ind.abnormal_tag }}</span>
                        <span v-else class="abnormal-none">—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section v-if="ocrContent" class="ai-block">
              <h4 class="ai-block-title">OCR 全文</h4>
              <pre class="ai-block-ocr">{{ ocrContent }}</pre>
            </section>
            <p v-if="aiModel" class="ai-model-tag">模型: {{ aiModel }}</p>
          </template>
        </div>
      </div>

      <!-- FAILED: 失败 + 重试 -->
      <div v-else-if="localStatus === 'FAILED'" class="ai-failed">
        <p class="ai-error-msg">
          处理失败: {{ localError ?? processingError ?? '未知错误' }}
        </p>
        <button
          type="button"
          class="ai-btn"
          :disabled="isProcessing"
          @click="handleProcess"
        >重试</button>
      </div>

      <!-- OCR_DONE: 单独状态, v1 不会出现（一轮调用直接到 SUMMARY_DONE）, 留兜底 -->
      <div v-else class="ai-processing">
        <span class="ai-text">状态: {{ statusLabel[localStatus] }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.attachment-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 0.6rem;
}

.photo-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 10rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
}

.photo-thumb:hover:not(:disabled) {
  border-color: #2563eb;
}

.photo-thumb:disabled {
  cursor: default;
}

.photo-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.pdf-block {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 5rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  padding: 0.75rem;
}

.pdf-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  background: transparent;
  border: none;
  padding: 0.5rem 1rem;
  cursor: pointer;
  color: #2563eb;
  font-family: inherit;
}

.pdf-link:hover {
  text-decoration: underline;
}

.pdf-icon {
  font-size: 1.8rem;
}

.pdf-name {
  font-size: 0.88rem;
  font-weight: 600;
  word-break: break-all;
}

.pdf-hint {
  font-size: 0.75rem;
  color: #6b7280;
}

.placeholder-msg {
  font-size: 0.85rem;
  color: #6b7280;
  padding: 0.5rem;
}

.placeholder-msg.error {
  color: #991b1b;
}

.attachment-meta {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.meta-filename {
  font-size: 0.82rem;
  color: #4b5563;
  word-break: break-all;
}

.meta-line {
  font-size: 0.78rem;
  color: #1e40af;
  font-weight: 500;
}

.meta-sub {
  font-size: 0.72rem;
  color: #9ca3af;
  display: flex;
  gap: 0.3rem;
  align-items: center;
  flex-wrap: wrap;
}

.status-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-weight: 600;
  font-size: 0.7rem;
}

.badge-pending {
  background: #f3f4f6;
  color: #6b7280;
}

.badge-processing {
  background: #fef3c7;
  color: #92400e;
}

.badge-done {
  background: #d1fae5;
  color: #065f46;
}

.badge-failed {
  background: #fee2e2;
  color: #991b1b;
}

/* === AI section === */
.ai-section {
  border-top: 1px dashed #e5e7eb;
  padding-top: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.ai-pending,
.ai-processing,
.ai-done,
.ai-failed {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.ai-btn {
  padding: 0.35rem 0.7rem;
  border: 1px solid #2563eb;
  background: #2563eb;
  color: white;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}

.ai-btn:hover:not(:disabled) {
  background: #1d4ed8;
}

.ai-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ai-btn-secondary {
  background: white;
  color: #2563eb;
}

.ai-btn-secondary:hover:not(:disabled) {
  background: #eff6ff;
}

.ai-hint {
  margin: 0;
  font-size: 0.8rem;
  color: #6b7280;
}

.link {
  color: #2563eb;
  text-decoration: none;
  font-weight: 500;
}

.link:hover {
  text-decoration: underline;
}

.ai-text {
  font-size: 0.8rem;
  color: #92400e;
}

.spinner {
  display: inline-block;
  width: 0.9rem;
  height: 0.9rem;
  border: 2px solid #fef3c7;
  border-top-color: #d97706;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.ai-toggle {
  background: transparent;
  border: none;
  padding: 0;
  color: #2563eb;
  font-size: 0.8rem;
  font-family: inherit;
  cursor: pointer;
  font-weight: 500;
}

.ai-toggle:hover {
  text-decoration: underline;
}

.ai-content {
  width: 100%;
  margin-top: 0.3rem;
  padding: 0.6rem;
  background: #f9fafb;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.ai-block {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.ai-block-title {
  margin: 0;
  font-size: 0.75rem;
  color: #1e40af;
  font-weight: 600;
}

.ai-block-text {
  margin: 0;
  font-size: 0.85rem;
  color: #1f2937;
  line-height: 1.5;
}

.ai-block-ocr {
  margin: 0;
  font-size: 0.78rem;
  color: #4b5563;
  line-height: 1.45;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 12rem;
  overflow-y: auto;
}

.ai-model-tag {
  margin: 0;
  font-size: 0.7rem;
  color: #9ca3af;
  font-style: italic;
}

.ai-error-msg {
  margin: 0;
  font-size: 0.8rem;
  color: #991b1b;
  flex: 1;
  word-break: break-word;
}

/* === doc_type 手动兜底 === */
.doc-type-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.2rem;
  flex-wrap: wrap;
}

.doc-type-label {
  font-size: 0.75rem;
  color: #6b7280;
  font-weight: 500;
}

.doc-type-select {
  font-family: inherit;
  font-size: 0.78rem;
  padding: 0.18rem 0.4rem;
  border: 1px solid #d1d5db;
  border-radius: 3px;
  background: white;
  color: #1f2937;
  cursor: pointer;
  max-width: 10rem;
}

.doc-type-select:hover:not(:disabled) {
  border-color: #2563eb;
}

.doc-type-select:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.doc-type-select:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
}

.doc-type-hint {
  font-size: 0.7rem;
  color: #6b7280;
}

.doc-type-hint.error {
  color: #991b1b;
}

/* === 化验单指标表 === */
.indicator-block {
  gap: 0.3rem;
}

.indicator-table-wrap {
  overflow-x: auto;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  background: white;
}

.indicator-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}

.indicator-table thead {
  background: #f9fafb;
}

.indicator-table th {
  padding: 0.35rem 0.5rem;
  text-align: left;
  font-weight: 600;
  color: #4b5563;
  border-bottom: 1px solid #e5e7eb;
  font-size: 0.72rem;
  white-space: nowrap;
}

.indicator-table td {
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid #f3f4f6;
  color: #1f2937;
  vertical-align: top;
}

.indicator-table tbody tr:last-child td {
  border-bottom: none;
}

.ind-name {
  white-space: nowrap;
}

.ind-name-cn {
  font-weight: 500;
}

.ind-name-en {
  display: inline-block;
  margin-left: 0.3rem;
  color: #9ca3af;
  font-size: 0.72rem;
}

.ind-result-value {
  font-weight: 600;
  white-space: nowrap;
}

.ind-unit {
  display: inline-block;
  margin-left: 0.2rem;
  color: #6b7280;
  font-size: 0.72rem;
}

.ind-ref {
  color: #6b7280;
  font-size: 0.72rem;
  white-space: nowrap;
}

.ind-tag {
  text-align: center;
}

.abnormal-tag {
  display: inline-block;
  min-width: 1.2rem;
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
  font-weight: 700;
  font-size: 0.72rem;
  line-height: 1.3;
}

/* H = 偏高, 红色高亮 (用户约定) */
.abnormal-H {
  background: #fee2e2;
  color: #991b1b;
}

/* L = 偏低, 蓝色高亮 (区别于 H, 同为异常但色调反差) */
.abnormal-L {
  background: #dbeafe;
  color: #1e40af;
}

/* N = 正常, 灰色低调 (不抢眼) */
.abnormal-N {
  background: #f3f4f6;
  color: #6b7280;
}

.abnormal-none {
  color: #d1d5db;
}
</style>
