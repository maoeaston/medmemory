<script setup lang="ts">
// SettingsView —— 数据备份 / 恢复 / 重置
//
// 三个 section, 各自独立 loading/error 状态:
//   § 数据备份: 导出 zip（含 sqlite + 所有附件 Blob）
//   § 数据恢复: 从 zip 覆盖导入（会清掉不在 zip 中的孤儿 Blob）
//   § 重置数据库: 两道确认（第一 dialog + 第二 dialog 输入"我确认删除"）
//
// 导入/重置成功后 location.reload(): 最稳的清理方式, 绕过组件 ref 残留。
// 导出不 reload（没改数据）。
import { computed, ref } from 'vue';
import {
  exportAllData,
  importAllData,
  resetAllData,
  type ExportProgress,
  type ExportResult,
  type ImportProgress,
  type ImportSummary,
} from '@/composables/useDataBackup';
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
  max-width: 720px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 1.25rem;
}

.page-title {
  margin: 0;
  font-size: 1.5rem;
}

.settings-section {
  padding: 1.25rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  margin-bottom: 1rem;
}

.danger-section {
  border-color: #fecaca;
  background: #fefcfb;
}

.section-title {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
  font-weight: 600;
  color: #1f2937;
}

.section-title-danger {
  color: #b91c1c;
}

.section-desc {
  margin: 0 0 0.9rem;
  font-size: 0.9rem;
  color: #4b5563;
  line-height: 1.5;
}

.warn {
  color: #b91c1c;
  font-weight: 600;
}

.action-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}

.progress-text {
  font-size: 0.85rem;
  color: #6b7280;
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
  background: #f3f4f6;
  color: #4b5563;
  border-radius: 6px;
  font-size: 0.88rem;
  font-weight: 600;
  border: 1px solid #d1d5db;
  transition: background 0.15s;
}

.file-picker:hover .file-picker-label {
  background: #e5e7eb;
}

.file-name {
  font-size: 0.88rem;
  color: #1f2937;
  word-break: break-all;
  max-width: 20rem;
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
  margin: 0.5rem 0 0;
  padding: 0.6rem 0.8rem;
  border-radius: 4px;
  font-size: 0.88rem;
}

.msg-error {
  background: #fef2f2;
  color: #991b1b;
}

.msg-success {
  background: #ecfdf5;
  color: #065f46;
}

.confirm-message {
  margin: 0 0 0.75rem;
  font-size: 0.92rem;
  color: #1f2937;
  line-height: 1.5;
}

.reset-input {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.95rem;
  font-family: inherit;
  background: white;
  color: #1f2937;
}

.reset-input:focus {
  outline: none;
  border-color: #dc2626;
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.15);
}

.reset-input:disabled {
  background: #f9fafb;
  cursor: not-allowed;
}
</style>
