<script setup lang="ts">
// AttachmentPreview —— 事件详情页里单个附件的预览卡
//
// 渲染策略:
//   - photo (jpg/png): <img> 缩略图, 点击在新标签打开原图
//   - pdf: 文件名 + "在新标签打开"链接（不内嵌 iframe, 家庭场景简单可靠）
//
// 原件加载: 每次组件 mount 都重新 IndexedDbStorageAdapter.getFile(storage_key)
//   家庭数据量小, 不缓存（符合 .continue-here.md Key Decision）
//   objectURL 在 unmount 时 revokeObjectURL, 避免内存泄漏
//
// 原件缺失/加载失败不阻塞整个详情页, 只在该卡片显示错误
import { onMounted, onUnmounted, ref } from 'vue';
import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';
import type { Attachment, DocType } from '@/repositories';

const props = defineProps<{
  attachment: Attachment;
}>();

const storage = new IndexedDbStorageAdapter();

const objectUrl = ref<string | null>(null);
const loadError = ref<string | null>(null);
const isLoading = ref(false);

const docTypeLabel: Partial<Record<DocType, string>> = {
  outpatient_record: '门诊记录',
  lab_report: '化验报告',
  imaging_report: '影像报告',
  prescription: '处方',
  discharge_summary: '出院小结',
  receipt: '收据',
  other: '其他',
};

function metaLine(): string {
  const parts: string[] = [];
  if (props.attachment.doc_type) {
    const label = docTypeLabel[props.attachment.doc_type] ?? props.attachment.doc_type;
    parts.push(label);
  }
  if (props.attachment.subtype) {
    parts.push(props.attachment.subtype);
  }
  if (props.attachment.tags.length > 0) {
    parts.push(props.attachment.tags.join('/'));
  }
  return parts.join(' · ');
}

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

onMounted(() => {
  void loadFile();
});

onUnmounted(() => {
  if (objectUrl.value !== null) {
    URL.revokeObjectURL(objectUrl.value);
  }
});
</script>

<template>
  <article class="attachment-card">
    <!-- photo: 缩略图 -->
    <button
      v-if="props.attachment.file_type === 'jpg' || props.attachment.file_type === 'png'"
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
        <span v-if="props.attachment.processing_status !== 'UPLOADED'">
          · {{ props.attachment.processing_status }}
        </span>
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
}
</style>
