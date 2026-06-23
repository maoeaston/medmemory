<script setup lang="ts">
// SettingsView —— 数据备份 / 恢复 / 重置 + AI 处理配置 / 批量处理
//
// 五个 section, 各自独立 loading/error 状态:
//   § 数据备份: 导出 zip（含 sqlite + 所有附件 Blob）
//   § 数据恢复: 从 zip 覆盖导入（会清掉不在 zip 中的孤儿 Blob）
//   § AI 处理配置: OpenAI API key 输入（localStorage 主存 + env 默认）
//   § 批量处理附件: 对 UPLOADED/FAILED 附件批量跑 AI 处理
//   § 重置数据库: 两道确认（第一 dialog + 第二 dialog 输入"我确认删除"）
//
// 导入/重置成功后 location.reload(): 最稳的清理方式, 绕过组件 ref 残留。
// 导出不 reload（没改数据）。
import { computed, onMounted, ref } from 'vue';
import {
  exportAllData,
  importAllData,
  resetAllData,
  type ExportProgress,
  type ExportResult,
  type ImportProgress,
  type ImportSummary,
} from '@/composables/useDataBackup';
import { useAiConfig } from '@/composables/useAiConfig';
import { useAiProcess } from '@/composables/useAiProcess';
import { useRepositories } from '@/composables/useRepositories';
import type { Attachment } from '@/repositories';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';

// ============================================================
// 导出状态
// ============================================================
const isExporting = ref(false);
const exportError = ref<string | null>(null);
const exportProgress = ref<ExportProgress | null>(null);
const exportResult = ref<ExportResult | null>(null);

const exportProgressText = computed(() => {
  const p = exportProgress.value;
  if (p === null) return '';
  switch (p.phase) {
    case 'sqlite':
      return '正在读取数据库...';
    case 'enumerate-blobs':
      return '正在列举附件...';
    case 'read-blobs':
      return p.total === 0
        ? '没有附件需要读取'
        : `正在读取附件 ${p.current} / ${p.total}`;
    case 'zip-generate':
      return '正在打包 zip...';
  }
});

async function handleExport(): Promise<void> {
  isExporting.value = true;
  exportError.value = null;
  exportProgress.value = null;
  exportResult.value = null;
  try {
    const result = await exportAllData((p) => {
      exportProgress.value = p;
    });
    // 自动下载
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // revoke 延迟一下, 确保 download 已启动
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportResult.value = result;
  } catch (e) {
    exportError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isExporting.value = false;
    exportProgress.value = null;
  }
}

// ============================================================
// 导入状态
// ============================================================
const importFile = ref<File | null>(null);
const isImporting = ref(false);
const importError = ref<string | null>(null);
const importProgress = ref<ImportProgress | null>(null);
const importSummary = ref<ImportSummary | null>(null);
const showImportConfirm = ref(false);

const importProgressText = computed(() => {
  const p = importProgress.value;
  if (p === null) return '';
  switch (p.phase) {
    case 'parse-zip':
      return '正在解析 zip...';
    case 'validate-manifest':
      return '正在校验 manifest...';
    case 'write-sqlite':
      return '正在写入数据库文件...';
    case 'cleanup-orphans':
      return '正在清理孤儿附件...';
    case 'write-blobs':
      return p.total === 0
        ? '没有附件需要写入'
        : `正在写入附件 ${p.current} / ${p.total}`;
  }
});

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files === null || input.files.length === 0) {
    importFile.value = null;
    return;
  }
  importFile.value = input.files[0];
  importError.value = null;
  importSummary.value = null;
}

function openImportConfirm(): void {
  if (importFile.value === null) return;
  importError.value = null;
  showImportConfirm.value = true;
}

function closeImportConfirm(): void {
  if (isImporting.value) return;
  showImportConfirm.value = false;
}

async function handleImportConfirm(): Promise<void> {
  if (importFile.value === null) return;
  isImporting.value = true;
  importError.value = null;
  importProgress.value = null;
  importSummary.value = null;
  try {
    const summary = await importAllData(importFile.value, (p) => {
      importProgress.value = p;
    });
    importSummary.value = summary;
    showImportConfirm.value = false;
    // reload 重建所有组件 + 重新打开 sqlite
    // 用 setTimeout 让当前模板渲染一次 "已导入" 消息再 reload
    setTimeout(() => {
      window.location.reload();
    }, 600);
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isImporting.value = false;
    importProgress.value = null;
  }
}

// ============================================================
// 重置状态: 两道确认
// ============================================================
const showResetConfirm1 = ref(false);
const showResetConfirm2 = ref(false);
const resetConfirmText = ref('');
const isResetting = ref(false);
const resetError = ref<string | null>(null);

const RESET_REQUIRED_TEXT = '我确认删除';

function openResetConfirm1(): void {
  resetError.value = null;
  resetConfirmText.value = '';
  showResetConfirm1.value = true;
}

function closeResetConfirm1(): void {
  if (isResetting.value) return;
  showResetConfirm1.value = false;
}

function openResetConfirm2(): void {
  resetConfirmText.value = '';
  showResetConfirm2.value = true;
}

function closeResetConfirm2(): void {
  if (isResetting.value) return;
  showResetConfirm2.value = false;
  resetConfirmText.value = '';
}

async function handleResetConfirm2(): Promise<void> {
  isResetting.value = true;
  resetError.value = null;
  try {
    await resetAllData();
    showResetConfirm2.value = false;
    setTimeout(() => {
      window.location.reload();
    }, 400);
  } catch (e) {
    resetError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isResetting.value = false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================
// AI 处理配置 (API key + Base URL + Model) — OCR namespace
// ============================================================
const {
  apiKey,
  baseUrl,
  model,
  hasKey,
  saveApiKey,
  saveBaseUrl,
  saveModel,
} = useAiConfig('ocr');

const apiKeyInput = ref(apiKey.value);
const baseUrlInput = ref(baseUrl.value);
const modelInput = ref(model.value);
const showApiKey = ref(false);
const apiKeySavedFlash = ref(false); // "已保存" 2s 反馈
const baseUrlSavedFlash = ref(false);
const modelSavedFlash = ref(false);

const usingEnvFallback = computed(
  () => !localStorage.getItem('medmemory:ai:ocr:apiKey') && hasKey.value,
);

function handleSaveApiKey(): void {
  saveApiKey(apiKeyInput.value);
  apiKeySavedFlash.value = true;
  setTimeout(() => {
    apiKeySavedFlash.value = false;
  }, 2000);
}

function handleClearApiKey(): void {
  apiKeyInput.value = '';
  saveApiKey('');
}

function handleSaveBaseUrl(): void {
  saveBaseUrl(baseUrlInput.value);
  baseUrlSavedFlash.value = true;
  setTimeout(() => {
    baseUrlSavedFlash.value = false;
  }, 2000);
}

function handleSaveModel(): void {
  saveModel(modelInput.value);
  modelSavedFlash.value = true;
  setTimeout(() => {
    modelSavedFlash.value = false;
  }, 2000);
}

// ============================================================
// AI 健康助手配置 (health-agent namespace) — v3.2
// 独立的 apiKey/baseUrl/model, 与 OCR 主流程可使用不同中转站/模型。
// ============================================================
const {
  apiKey: haApiKey,
  baseUrl: haBaseUrl,
  model: haModel,
  hasKey: haHasKey,
  saveApiKey: haSaveApiKey,
  saveBaseUrl: haSaveBaseUrl,
  saveModel: haSaveModel,
} = useAiConfig('health-agent');

const haApiKeyInput = ref(haApiKey.value);
const haBaseUrlInput = ref(haBaseUrl.value);
const haModelInput = ref(haModel.value);
const haShowApiKey = ref(false);
const haApiKeySavedFlash = ref(false);
const haBaseUrlSavedFlash = ref(false);
const haModelSavedFlash = ref(false);

function haHandleSaveApiKey(): void {
  haSaveApiKey(haApiKeyInput.value);
  haApiKeySavedFlash.value = true;
  setTimeout(() => {
    haApiKeySavedFlash.value = false;
  }, 2000);
}

function haHandleClearApiKey(): void {
  haApiKeyInput.value = '';
  haSaveApiKey('');
}

function haHandleSaveBaseUrl(): void {
  haSaveBaseUrl(haBaseUrlInput.value);
  haBaseUrlSavedFlash.value = true;
  setTimeout(() => {
    haBaseUrlSavedFlash.value = false;
  }, 2000);
}

function haHandleSaveModel(): void {
  haSaveModel(haModelInput.value);
  haModelSavedFlash.value = true;
  setTimeout(() => {
    haModelSavedFlash.value = false;
  }, 2000);
}

// ============================================================
// 批量处理附件
// ============================================================
const pendingAttachments = ref<Attachment[]>([]);
const pendingLoadError = ref<string | null>(null);
const isPendingLoading = ref(false);

const {
  isProcessing: isBatchProcessing,
  batchProgress,
  processBatch,
} = useAiProcess();
const batchError = ref<string | null>(null);
const batchComplete = ref<{ successCount: number; failureCount: number } | null>(
  null,
);

async function refreshPending(): Promise<void> {
  isPendingLoading.value = true;
  pendingLoadError.value = null;
  try {
    const repos = await useRepositories();
    pendingAttachments.value = await repos.attachment.listPendingAi();
  } catch (e) {
    pendingLoadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isPendingLoading.value = false;
  }
}

async function handleBatchProcess(): Promise<void> {
  if (pendingAttachments.value.length === 0 || !hasKey.value) return;
  batchError.value = null;
  batchComplete.value = null;
  const ids = pendingAttachments.value.map((a) => a.id);
  try {
    const result = await processBatch(ids);
    batchComplete.value = result;
    await refreshPending();
  } catch (e) {
    batchError.value = e instanceof Error ? e.message : String(e);
  }
}

const batchProgressText = computed(() => {
  const p = batchProgress.value;
  if (p === null) return '';
  return `处理中 ${p.current} / ${p.total} (成功 ${p.successCount}, 失败 ${p.failureCount})`;
});

onMounted(() => {
  void refreshPending();
});
</script>

<template>
  <main class="settings-view">
    <header class="page-header">
      <h1 class="page-title">设置</h1>
    </header>

    <!-- § 数据备份 -->
    <section class="settings-section">
      <h2 class="section-title">数据备份</h2>
      <p class="section-desc">
        把全部数据（家庭成员 / 事件 / 附件原件等）打包成 zip 下载保存。
        建议定期导出, 浏览器清缓存或换设备会导致数据丢失。
      </p>

      <div class="action-row">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="isExporting"
          @click="handleExport"
        >
          {{ isExporting ? '导出中...' : '导出数据' }}
        </button>
        <span v-if="isExporting" class="progress-text">
          {{ exportProgressText }}
        </span>
      </div>

      <p v-if="exportError" class="msg msg-error">导出失败: {{ exportError }}</p>
      <p v-if="exportResult" class="msg msg-success">
        已导出 {{ exportResult.blobCount }} 个附件,
        数据库 {{ formatSize(exportResult.sqliteBytes) }}。
        zip 文件已开始下载。
      </p>
    </section>

    <!-- § 数据恢复 -->
    <section class="settings-section">
      <h2 class="section-title">数据恢复</h2>
      <p class="section-desc">
        从之前导出的 zip 文件恢复。<strong class="warn">会覆盖当前所有数据</strong>,
        包括删除当前 IDB 中不在 zip 里的附件原件。
      </p>

      <div class="action-row">
        <label class="file-picker">
          <input
            type="file"
            accept=".zip,application/zip"
            @change="onFileChange"
            :disabled="isImporting"
          />
          <span class="file-picker-label">选择 zip 文件</span>
        </label>
        <span v-if="importFile" class="file-name">{{ importFile.name }}</span>
      </div>

      <div class="action-row" v-if="importFile">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="isImporting"
          @click="openImportConfirm"
        >
          开始导入
        </button>
        <span v-if="isImporting" class="progress-text">
          {{ importProgressText }}
        </span>
      </div>

      <p v-if="importError" class="msg msg-error">导入失败: {{ importError }}</p>
      <p v-if="importSummary" class="msg msg-success">
        已导入 {{ importSummary.blobImported }} 个附件,
        清理 {{ importSummary.blobDeletedOrphans }} 个孤儿附件,
        数据库 {{ formatSize(importSummary.sqliteBytes) }}。正在重载...
      </p>
    </section>

    <!-- § AI 处理配置 -->
    <section class="settings-section">
      <h2 class="section-title">AI 处理配置</h2>
      <p class="section-desc">
        支持 OpenAI 兼容协议（官方 / 中转站 / 本地部署）。
        归档照片附件会自动调用模型产出摘要 + OCR 全文 + 标签 + 化验单指标,
        解锁关键词搜索功能。配置存在浏览器 localStorage, 自用场景已接受明文存储。
      </p>

      <!-- API Key -->
      <div class="config-row">
        <label class="config-label">API Key</label>
        <div class="api-key-row">
          <input
            v-model="apiKeyInput"
            :type="showApiKey ? 'text' : 'password'"
            class="api-key-input"
            placeholder="sk-..."
            autocomplete="off"
            spellcheck="false"
            :disabled="isBatchProcessing"
          />
          <button
            type="button"
            class="btn btn-secondary"
            @click="showApiKey = !showApiKey"
          >{{ showApiKey ? '隐藏' : '显示' }}</button>
        </div>
        <div class="action-row">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="isBatchProcessing"
            @click="handleSaveApiKey"
          >保存 API Key</button>
          <button
            v-if="hasKey"
            type="button"
            class="btn btn-secondary"
            :disabled="isBatchProcessing"
            @click="handleClearApiKey"
          >清除</button>
          <span v-if="apiKeySavedFlash" class="saved-flash">✓ 已保存</span>
        </div>
        <p v-if="usingEnvFallback" class="msg msg-info">
          当前使用 .env 默认 key。保存后会覆盖为输入框中的值。
        </p>
        <p v-else-if="hasKey" class="msg msg-success">
          ✓ 已配置 API Key（保存在 localStorage）。
        </p>
        <p v-else class="msg msg-info">
          未配置 API Key。归档时附件会保持"待处理"状态, 配置后可手动或批量处理。
        </p>
      </div>

      <!-- Base URL -->
      <div class="config-row">
        <label class="config-label">Base URL</label>
        <input
          v-model="baseUrlInput"
          type="text"
          class="text-input"
          placeholder="https://api.openai.com/v1 或 https://ccapi.us/v1"
          autocomplete="off"
          spellcheck="false"
          :disabled="isBatchProcessing"
        />
        <div class="action-row">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="isBatchProcessing"
            @click="handleSaveBaseUrl"
          >保存 Base URL</button>
          <span v-if="baseUrlSavedFlash" class="saved-flash">✓ 已保存</span>
        </div>
        <p class="msg msg-info">
          只填到 <code>/v1</code>, 程序会自动拼 <code>/chat/completions</code>。
          切换中转站只需改这一栏 + Model。
        </p>
      </div>

      <!-- Model -->
      <div class="config-row">
        <label class="config-label">Model</label>
        <input
          v-model="modelInput"
          type="text"
          class="text-input"
          placeholder="gpt-4o / gpt-5.5 / deepseek-chat / moonshot-v1-8k-vision-preview 等"
          autocomplete="off"
          spellcheck="false"
          :disabled="isBatchProcessing"
        />
        <div class="action-row">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="isBatchProcessing"
            @click="handleSaveModel"
          >保存 Model</button>
          <span v-if="modelSavedFlash" class="saved-flash">✓ 已保存</span>
        </div>
        <p class="msg msg-info">
          必须支持 Vision（图片输入）+ JSON 强制输出。
          非官方模型若 <code>response_format: json_object</code> 不稳,
          可能导致解析失败。
        </p>
      </div>
    </section>

    <!-- § AI 健康助手配置 (v3.2) -->
    <section class="settings-section">
      <h2 class="section-title">AI 健康助手配置</h2>
      <p class="section-desc">
        化验单解读 + 用药指南使用独立的 OpenAI 兼容配置,
        可与上方 OCR 处理使用不同中转站或模型（如纯文本任务无需 Vision,
        可切更便宜的文本模型）。配置独立存储, 互不影响。
      </p>

      <!-- API Key -->
      <div class="config-row">
        <label class="config-label">API Key</label>
        <div class="api-key-row">
          <input
            v-model="haApiKeyInput"
            :type="haShowApiKey ? 'text' : 'password'"
            class="api-key-input"
            placeholder="sk-..."
            autocomplete="off"
            spellcheck="false"
          />
          <button
            type="button"
            class="btn btn-secondary"
            @click="haShowApiKey = !haShowApiKey"
          >{{ haShowApiKey ? '隐藏' : '显示' }}</button>
        </div>
        <div class="action-row">
          <button
            type="button"
            class="btn btn-primary"
            @click="haHandleSaveApiKey"
          >保存 API Key</button>
          <button
            v-if="haHasKey"
            type="button"
            class="btn btn-secondary"
            @click="haHandleClearApiKey"
          >清除</button>
          <span v-if="haApiKeySavedFlash" class="saved-flash">✓ 已保存</span>
        </div>
        <p v-if="haHasKey" class="msg msg-success">
          ✓ 已配置健康助手 API Key。
        </p>
        <p v-else class="msg msg-info">
          未配置。未配置时健康助手相关按钮（化验解读 / 用药指南）点击会提示。
        </p>
      </div>

      <!-- Base URL -->
      <div class="config-row">
        <label class="config-label">Base URL</label>
        <input
          v-model="haBaseUrlInput"
          type="text"
          class="text-input"
          placeholder="https://api.openai.com/v1 或 https://ccapi.us/v1"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="action-row">
          <button
            type="button"
            class="btn btn-primary"
            @click="haHandleSaveBaseUrl"
          >保存 Base URL</button>
          <span v-if="haBaseUrlSavedFlash" class="saved-flash">✓ 已保存</span>
        </div>
        <p class="msg msg-info">
          只填到 <code>/v1</code>。可与上方相同, 也可切换不同中转站。
        </p>
      </div>

      <!-- Model -->
      <div class="config-row">
        <label class="config-label">Model</label>
        <input
          v-model="haModelInput"
          type="text"
          class="text-input"
          placeholder="gpt-4o / gpt-5.5 / deepseek-chat / claude-3-5-sonnet 等"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="action-row">
          <button
            type="button"
            class="btn btn-primary"
            @click="haHandleSaveModel"
          >保存 Model</button>
          <span v-if="haModelSavedFlash" class="saved-flash">✓ 已保存</span>
        </div>
        <p class="msg msg-info">
          健康助手任务是纯文本输入, 不要求 Vision。
          可用更强的推理模型（如 gpt-5.5）提升解读质量。
        </p>
      </div>
    </section>

    <!-- § 批量处理附件 -->
    <section class="settings-section">
      <h2 class="section-title">批量处理附件</h2>
      <p class="section-desc">
        对所有"待处理"或"处理失败"的附件批量执行 AI 处理。顺序执行避免触发 OpenAI 限流,
        单个失败不中断。
      </p>

      <div class="action-row">
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="isPendingLoading || isBatchProcessing"
          @click="refreshPending"
        >刷新列表</button>
        <span v-if="isPendingLoading" class="progress-text">加载中...</span>
        <span v-else-if="pendingAttachments.length > 0" class="pending-count">
          {{ pendingAttachments.length }} 个待处理附件
        </span>
        <span v-else-if="!pendingLoadError" class="progress-text">
          没有待处理附件
        </span>
      </div>

      <p v-if="pendingLoadError" class="msg msg-error">
        加载失败: {{ pendingLoadError }}
      </p>

      <div
        v-if="pendingAttachments.length > 0"
        class="action-row batch-action-row"
      >
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!hasKey || isBatchProcessing"
          @click="handleBatchProcess"
        >
          {{ isBatchProcessing ? '处理中...' : `开始处理 ${pendingAttachments.length} 个` }}
        </button>
        <span v-if="isBatchProcessing" class="progress-text">
          {{ batchProgressText }}
        </span>
        <span v-if="!hasKey" class="progress-text warn">
          请先在上方配置 API key
        </span>
      </div>

      <p v-if="batchError" class="msg msg-error">批量处理出错: {{ batchError }}</p>
      <p
        v-if="batchComplete"
        class="msg"
        :class="batchComplete.failureCount > 0 ? 'msg-warn' : 'msg-success'"
      >
        批量处理完成: 成功 {{ batchComplete.successCount }} 个,
        失败 {{ batchComplete.failureCount }} 个。
      </p>

      <details v-if="pendingAttachments.length > 0" class="pending-list">
        <summary>查看待处理列表</summary>
        <ul>
          <li v-for="att in pendingAttachments" :key="att.id">
            <span class="pending-id">#{{ att.id }}</span>
            <span class="pending-name">{{ att.file_name }}</span>
            <span
              class="pending-status"
              :class="att.processing_status === 'FAILED' ? 'status-failed' : 'status-uploaded'"
            >
              {{ att.processing_status === 'FAILED' ? '失败' : '待处理' }}
            </span>
          </li>
        </ul>
      </details>
    </section>

    <!-- § 重置数据库 -->
    <section class="settings-section danger-section">
      <h2 class="section-title section-title-danger">重置数据库</h2>
      <p class="section-desc">
        清空所有数据回到初始状态（家庭成员 / 事件 / 附件原件 / 药箱 / 健康问题全部删除）。
        <strong class="warn">不可撤销</strong>, 请先导出备份。
      </p>
      <div class="action-row">
        <button
          type="button"
          class="btn btn-danger"
          :disabled="isResetting"
          @click="openResetConfirm1"
        >
          重置数据库
        </button>
      </div>
      <p v-if="resetError" class="msg msg-error">重置失败: {{ resetError }}</p>
    </section>

    <!-- 导入确认 -->
    <ConfirmDialog
      v-if="showImportConfirm"
      title="确认导入"
      :message="`确认用「${importFile?.name ?? ''}」覆盖当前所有数据?`"
      detail="当前的所有家庭成员 / 事件 / 附件都会被 zip 里的内容替换。\n此操作不可撤销。"
      confirm-text="覆盖导入"
      danger
      :loading="isImporting"
      :error-message="importError"
      @confirm="handleImportConfirm"
      @cancel="closeImportConfirm"
    />

    <!-- 重置第一道确认 -->
    <ConfirmDialog
      v-if="showResetConfirm1"
      title="重置数据库 - 第 1/2 步"
      message="重置数据库将清空所有数据"
      detail="包括: 家庭成员 / 事件 / 附件 / 药箱 / 健康问题的全部记录, OPFS sqlite 文件 + IndexedDB 附件原件都会被删除。\n\n此操作不可撤销, 请先导出备份。\n\n如果确认继续, 下一屏需要输入指定字样。"
      confirm-text="我已备份, 继续"
      danger
      :loading="isResetting"
      :error-message="resetError"
      @confirm="() => { showResetConfirm1 = false; openResetConfirm2(); }"
      @cancel="closeResetConfirm1"
    />

    <!-- 重置第二道: 输入字样 -->
    <ModalOverlay
      v-if="showResetConfirm2"
      title="重置数据库 - 第 2/2 步"
      width="sm"
      @close="closeResetConfirm2"
    >
      <p class="confirm-message">
        请在下方输入框输入 <strong class="warn">{{ RESET_REQUIRED_TEXT }}</strong>,
        然后点"执行重置"按钮。
      </p>
      <input
        v-model="resetConfirmText"
        type="text"
        class="reset-input"
        :placeholder="`输入: ${RESET_REQUIRED_TEXT}`"
        :disabled="isResetting"
        autocomplete="off"
      />
      <p v-if="resetError" class="msg msg-error">重置失败: {{ resetError }}</p>

      <template #footer>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="isResetting"
          @click="closeResetConfirm2"
        >
          取消
        </button>
        <button
          type="button"
          class="btn btn-danger"
          :disabled="isResetting || resetConfirmText !== RESET_REQUIRED_TEXT"
          @click="handleResetConfirm2"
        >
          {{ isResetting ? '处理中...' : '执行重置' }}
        </button>
      </template>
    </ModalOverlay>
  </main>
</template>

<style scoped>
.settings-view {
  padding: 1.5rem;
  max-width: var(--space-page-max-width);
  margin: 0 auto;
}

.page-header {
  margin-bottom: 1.25rem;
}

.page-title {
  margin: 0;
  font-size: var(--font-size-page-title);
}

.settings-section {
  padding: 1.25rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  margin-bottom: 1rem;
}

.danger-section {
  border-color: var(--color-danger-border);
  background: #fefcfb;
}

.section-title {
  margin: 0 0 0.5rem;
  font-size: var(--font-size-section-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.section-title-danger {
  color: #b91c1c;
}

.section-desc {
  margin: 0 0 0.9rem;
  font-size: var(--font-size-body);
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.warn {
  color: #b91c1c;
  font-weight: var(--font-weight-semibold);
}

.action-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.progress-text {
  font-size: var(--font-size-small);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.file-picker {
  position: relative;
  display: inline-block;
  cursor: pointer;
}

.file-picker input[type='file'] {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
  font-size: 0;
}

.file-picker-label {
  display: inline-block;
  padding: 0.5rem 1rem;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
  border-radius: var(--radius-input);
  font-size: 0.88rem;
  font-weight: var(--font-weight-semibold);
  border: 1px solid var(--color-border-input);
  transition: background 0.15s;
}

.file-picker:hover .file-picker-label {
  background: var(--color-border-default);
}

.file-name {
  font-size: 0.88rem;
  color: var(--color-text-primary);
  word-break: break-all;
  max-width: 20rem;
}

.msg {
  margin: 0.5rem 0 0;
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius-badge);
  font-size: 0.88rem;
}

.msg-error {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}

.msg-success {
  background: var(--color-success-light);
  color: var(--color-success);
}

.confirm-message {
  margin: 0 0 0.75rem;
  font-size: var(--font-size-input);
  color: var(--color-text-primary);
  line-height: 1.5;
}

.reset-input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: var(--font-size-input);
  font-family: inherit;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
}

.reset-input:focus {
  outline: none;
  border-color: var(--color-danger);
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.15);
}

.reset-input:disabled {
  background: var(--color-bg-page);
  cursor: not-allowed;
}

/* === AI 配置 === */
.api-key-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
}

.api-key-input {
  flex: 1;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: var(--font-size-body);
  font-family: monospace;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
}

.api-key-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

.api-key-input:disabled {
  background: var(--color-bg-page);
  cursor: not-allowed;
}

.config-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 1.2rem;
}

.config-row:last-child {
  margin-bottom: 0;
}

.config-label {
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-semibold);
  color: #374151;
}

.text-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  font-size: var(--font-size-body);
  font-family: monospace;
  background: var(--color-bg-card);
  color: var(--color-text-primary);
}

.text-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

.text-input:disabled {
  background: var(--color-bg-page);
  cursor: not-allowed;
}

.config-row code {
  font-family: monospace;
  background: var(--color-bg-muted);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  font-size: 0.85em;
  color: var(--color-primary-dark);
}

.saved-flash {
  font-size: var(--font-size-small);
  color: var(--color-success);
  font-weight: var(--font-weight-medium);
}

.msg-info {
  background: var(--color-primary-light);
  color: var(--color-primary-dark);
}

.msg-warn {
  background: #fef3c7;
  color: var(--color-warning-text);
}

/* === 批量处理 === */
.batch-action-row {
  margin-top: 0.3rem;
}

.pending-count {
  font-size: 0.88rem;
  color: var(--color-text-primary);
  font-weight: var(--font-weight-semibold);
}

.pending-list {
  margin-top: 0.6rem;
  font-size: var(--font-size-meta);
}

.pending-list summary {
  cursor: pointer;
  color: var(--color-primary);
  padding: 0.3rem 0;
}

.pending-list summary:hover {
  text-decoration: underline;
}

.pending-list ul {
  margin: 0.3rem 0 0;
  padding-left: 1rem;
  list-style: none;
  max-height: 10rem;
  overflow-y: auto;
}

.pending-list li {
  display: flex;
  gap: 0.4rem;
  padding: 0.2rem 0;
  align-items: center;
  font-size: var(--font-size-caption);
}

.pending-id {
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  min-width: 2.5rem;
}

.pending-name {
  flex: 1;
  color: var(--color-text-secondary);
  word-break: break-all;
}

.pending-status {
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-size: 0.72rem;
  font-weight: var(--font-weight-semibold);
}

.status-uploaded {
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
}

.status-failed {
  background: #fee2e2;
  color: var(--color-danger-text);
}
</style>
