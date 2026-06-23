<script setup lang="ts">
// InitialSyncDialog -- 首次同步引导对话框
// 对应 docs/sync-design.md §10.3 + 评审 M3
//
// 触发条件: initOnAppStart 检测到
//   "本地有数据 && 服务器 hasSnapshot && lastSyncAt === null"
//
// 3 个选项:
//   A. "上传本地, 覆盖服务器" (危险, 二次确认)
//   B. "下载服务器, 覆盖本地" (危险, 二次确认)
//   C. "暂不同步" (取消)
//
// 评审 M3 要求: 选 A/B 后弹二次确认对话框.
import { computed, ref } from 'vue';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import { useSync } from '@/composables/useSync';
import { useRepositories } from '@/composables/useRepositories';
import { exportAllData } from '@/composables/useDataBackup';

interface LocalStats {
  memberCount: number;
}

const props = defineProps<{
  serverVersion: number;
}>();

const emit = defineEmits<{
  close: [];
  done: [];
}>();

const {
  checkout,
  seed,
  syncState,
} = useSync();

// ============================================================
// 本地数据统计
// ============================================================
const localStats = ref<LocalStats | null>(null);
const isLoadingStats = ref(true);
const statsError = ref<string | null>(null);
const isProcessing = ref(false);
const processError = ref<string | null>(null);

// 二次确认对话框
const confirmChoice = ref<'upload' | 'download' | null>(null);

async function loadLocalStats(): Promise<void> {
  isLoadingStats.value = true;
  statsError.value = null;
  try {
    const repos = await useRepositories();
    const members = await repos.familyMember.list();
    localStats.value = { memberCount: members.length };
  } catch (e) {
    statsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoadingStats.value = false;
  }
}

void loadLocalStats();

const hasLocalData = computed(() => {
  return localStats.value !== null && localStats.value.memberCount > 0;
});

// ============================================================
// 操作
// ============================================================
function chooseUpload(): void {
  confirmChoice.value = 'upload';
}

function chooseDownload(): void {
  confirmChoice.value = 'download';
}

function cancelConfirm(): void {
  if (isProcessing.value) return;
  confirmChoice.value = null;
}

async function executeConfirm(): Promise<void> {
  if (confirmChoice.value === null || isProcessing.value) return;
  isProcessing.value = true;
  processError.value = null;

  try {
    if (confirmChoice.value === 'upload') {
      // 上传本地覆盖服务器: seed (首次推送模式)
      await seed();
    } else if (confirmChoice.value === 'download') {
      // 下载服务器覆盖本地: checkout (会覆盖本地数据)
      await checkout();
    }
    confirmChoice.value = null;
    emit('done');
  } catch {
    // 操作失败: 错误在 syncError 里, 保持在当前对话框
    processError.value = '\u540C\u6B65\u64CD\u4F5C\u5931\u8D25, \u8BF7\u91CD\u8BD5';
  } finally {
    isProcessing.value = false;
  }
}

// ============================================================
// 导出本地备份 (覆盖前让用户保存)
// ============================================================
const isExporting = ref(false);

async function exportLocalBackup(): Promise<void> {
  isExporting.value = true;
  try {
    const result = await exportAllData();
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // pass
  } finally {
    isExporting.value = false;
  }
}

const confirmTitle = computed(() => {
  if (confirmChoice.value === 'upload') return '\u6700\u540E\u786E\u8BA4: \u8986\u76D6\u670D\u52A1\u5668';
  return '\u6700\u540E\u786E\u8BA4: \u8986\u76D6\u672C\u5730';
});

const confirmMessage = computed(() => {
  if (confirmChoice.value === 'upload') {
    return `\u60A8\u9009\u62E9\u7684\u662F\u300C\u4E0A\u4F20\u672C\u5730\u8986\u76D6\u670D\u52A1\u5668\u300D\u3002\u670D\u52A1\u5668\u7248\u672C ${props.serverVersion} \u7684\u6570\u636E\u5C06\u88AB\u6C38\u4E45\u8986\u76D6, \u4E0D\u53EF\u64A4\u9500\u3002\u786E\u5B9A\u8981\u7EE7\u7EED\u5417?`;
  }
  return `\u60A8\u9009\u62E9\u7684\u662F\u300C\u4E0B\u8F7D\u670D\u52A1\u5668\u8986\u76D6\u672C\u5730\u300D\u3002\u672C\u5730\u6570\u636E\u5C06\u88AB\u6C38\u4E45\u8986\u76D6, \u4E0D\u53EF\u64A4\u9500\u3002\u786E\u5B9A\u8981\u7EE7\u7EED\u5417?`;
});
</script>

<template>
  <!-- 主对话框 -->
  <ModalOverlay
    v-if="confirmChoice === null"
    title="\u9996\u6B21\u540C\u6B65"
    width="md"
    @close="emit('close')"
  >
    <!-- 场景 A: 本地有数据 + 服务器空 → 不应走到这里, 由 seed 处理 -->
    <!-- 场景 B: 本地有数据 + 服务器也有数据 -->
    <div v-if="isLoadingStats" class="dialog-body">
      <p class="dialog-text">\u6B63\u5728\u68C0\u67E5\u672C\u5730\u6570\u636E...</p>
    </div>

    <div v-else-if="statsError" class="dialog-body">
      <p class="dialog-text msg-error">\u52A0\u8F7D\u672C\u5730\u6570\u636E\u5931\u8D25: {{ statsError }}</p>
    </div>

    <div v-else class="dialog-body">
      <p class="dialog-text">
        \u670D\u52A1\u5668\u5DF2\u6709\u6570\u636E (\u7248\u672C {{ serverVersion }})\u3002
        <template v-if="hasLocalData">
          \u60A8\u672C\u5730\u4E5F\u6709 {{ localStats!.memberCount }} \u540D\u6210\u5458\u7684\u6570\u636E\u3002
        </template>
      </p>

      <p class="dialog-warn">
        \u26A0 \u65E0\u6CD5\u81EA\u52A8\u5408\u5E76, \u8BF7\u9009\u62E9\u4E00\u65B9\u8986\u76D6\u53E6\u4E00\u65B9:
      </p>

      <div class="choice-list">
        <!-- 下载服务器覆盖本地 -->
        <button
          type="button"
          class="choice-card"
          :disabled="isProcessing"
          @click="chooseDownload"
        >
          <div class="choice-title">\u2B07\uFE0F \u4E0B\u8F7D\u670D\u52A1\u5668, \u8986\u76D6\u672C\u5730</div>
          <div class="choice-desc">
            \u670D\u52A1\u5668\u7248\u672C {{ serverVersion }} \u7684\u6570\u636E\u5C06\u66FF\u6362\u672C\u5730\u6570\u636E\u3002
            <span v-if="hasLocalData" class="warn">\u672C\u5730 {{ localStats!.memberCount }} \u540D\u6210\u5458\u7684\u6570\u636E\u5C06\u4E22\u5931\u3002</span>
          </div>
        </button>

        <!-- 上传本地覆盖服务器 -->
        <button
          v-if="hasLocalData"
          type="button"
          class="choice-card"
          :disabled="isProcessing"
          @click="chooseUpload"
        >
          <div class="choice-title">\u2B06\uFE0F \u4E0A\u4F20\u672C\u5730, \u8986\u76D6\u670D\u52A1\u5668</div>
          <div class="choice-desc">
            \u672C\u5730\u6570\u636E\u5C06\u8986\u76D6\u670D\u52A1\u5668\u7248\u672C {{ serverVersion }}\u3002
            <span class="warn">\u670D\u52A1\u5668\u539F\u6709\u6570\u636E\u5C06\u4E22\u5931\u3002</span>
          </div>
        </button>
      </div>

      <!-- 导出本地备份 -->
      <div v-if="hasLocalData" class="backup-row">
        <button
          type="button"
          class="btn btn-secondary btn-small"
          :disabled="isExporting"
          @click="exportLocalBackup"
        >
          {{ isExporting ? '\u5BFC\u51FA\u4E2D...' : '\u5BFC\u51FA\u672C\u5730\u5907\u4EFD' }}
        </button>
        <span class="hint">\u5EFA\u8BAE\u5728\u8986\u76D6\u524D\u5148\u5BFC\u51FA\u5907\u4EFD</span>
      </div>

      <p v-if="processError" class="msg-error">{{ processError }}</p>
      <p v-if="syncState === 'pulling'" class="sync-status">\u6B63\u5728\u62C9\u53D6\u670D\u52A1\u5668\u6570\u636E...</p>
      <p v-if="syncState === 'pushing'" class="sync-status">\u6B63\u5728\u4E0A\u4F20\u672C\u5730\u6570\u636E...</p>
    </div>

    <template #footer>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="isProcessing"
        @click="emit('close')"
      >
        \u6682\u4E0D\u540C\u6B65
      </button>
    </template>
  </ModalOverlay>

  <!-- 二次确认 (评审 M3) -->
  <ConfirmDialog
    v-else
    :title="confirmTitle"
    :message="confirmMessage"
    detail="\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002"
    confirm-text="\u786E\u8BA4\u8986\u76D6"
    danger
    :loading="isProcessing"
    :error-message="processError"
    @confirm="executeConfirm"
    @cancel="cancelConfirm"
  />
</template>

<style scoped>
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.dialog-text {
  margin: 0;
  font-size: var(--font-size-body);
  color: var(--color-text-primary);
  line-height: 1.5;
}

.dialog-warn {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--color-warning-text);
  font-weight: var(--font-weight-medium);
}

.choice-list {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.choice-card {
  text-align: left;
  padding: 0.8rem 1rem;
  border: 1px solid var(--color-border-input);
  border-radius: var(--radius-input);
  background: var(--color-bg-card);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  font-family: var(--font-family-base);
}

.choice-card:hover:not(:disabled) {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
}

.choice-card:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.choice-title {
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  margin-bottom: 0.3rem;
}

.choice-desc {
  font-size: var(--font-size-small);
  color: var(--color-text-secondary);
  line-height: 1.4;
}

.warn {
  color: var(--color-danger-text);
  font-weight: var(--font-weight-medium);
}

.backup-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.3rem;
}

.hint {
  font-size: var(--font-size-small);
  color: var(--color-text-muted);
}

.msg-error {
  margin: 0;
  padding: 0.5rem 0.7rem;
  background: var(--color-danger-light);
  color: var(--color-danger-text);
  border-radius: var(--radius-badge);
  font-size: var(--font-size-small);
}

.sync-status {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--color-primary-dark);
}
</style>
