<script setup lang="ts">
// InboxItemCard —— Inbox 列表中的单条卡片
//
// 三种 capture_type 渲染:
//   - photo: 缩略图（URL.createObjectURL from IndexedDB Blob）
//   - voice: <audio controls>
//   - text: 直接渲染 text_content
//
// 左侧 checkbox, v-model:checked 双向绑定
// 原件加载失败不阻塞 checkbox（用户仍可归档, archive 时会报错）
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';
import type { InboxItem } from '@/repositories';

const props = defineProps<{
  item: InboxItem;
  checked: boolean;
}>();

const emit = defineEmits<{
  'update:checked': [checked: boolean];
}>();

const storage = new IndexedDbStorageAdapter();

// 原件 object URL（photo/voice 共用, text 不用）
const mediaUrl = ref<string | null>(null);
const mediaError = ref<string | null>(null);
const isLoading = ref(false);

function captureTypeLabel(t: InboxItem['capture_type']): string {
  switch (t) {
    case 'photo':
      return '📷 照片';
    case 'voice':
      return '🎤 语音';
    case 'text':
      return '✍️ 文字';
  }
}

function formatTimestamp(iso: string): string {
  // iso: 2026-06-22T14:30:00Z → 06-22 14:30
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

async function loadMedia(): Promise<void> {
  // text 类型不需要加载原件
  if (props.item.capture_type === 'text') return;
  if (props.item.storage_key === null) {
    mediaError.value = '无 storage_key';
    return;
  }

  isLoading.value = true;
  mediaError.value = null;

  // 清理上次的 URL（如果有）
  if (mediaUrl.value !== null) {
    URL.revokeObjectURL(mediaUrl.value);
    mediaUrl.value = null;
  }

  try {
    const blob = await storage.getFile(props.item.storage_key);
    if (blob === null) {
      mediaError.value = '原件缺失（可能已清理）';
      return;
    }
    mediaUrl.value = URL.createObjectURL(blob);
  } catch (e) {
    mediaError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  void loadMedia();
});

// item 变化时（理论上 inbox 列表不会原地改 item, 但保险起见）
watch(
  () => props.item.id,
  () => {
    void loadMedia();
  },
);

onUnmounted(() => {
  if (mediaUrl.value !== null) {
    URL.revokeObjectURL(mediaUrl.value);
  }
});
</script>

<template>
  <article
    :class="[
      'inbox-item-card',
      `type-${props.item.capture_type}`,
      { checked: props.checked },
    ]"
  >
    <label class="card-checkbox">
      <input
        type="checkbox"
        :checked="props.checked"
        @change="emit('update:checked', ($event.target as HTMLInputElement).checked)"
      />
    </label>

    <div class="card-body">
      <header class="card-header">
        <span class="type-badge">{{ captureTypeLabel(props.item.capture_type) }}</span>
        <span class="timestamp">{{ formatTimestamp(props.item.created_at) }}</span>
        <span class="item-id">#{{ props.item.id }}</span>
      </header>

      <!-- text: 直接渲染内容 -->
      <div
        v-if="props.item.capture_type === 'text'"
        class="text-content"
      >
        {{ props.item.text_content ?? '(空)' }}
      </div>

      <!-- photo: 缩略图 -->
      <div
        v-else-if="props.item.capture_type === 'photo'"
        class="media-preview photo-preview"
      >
        <div v-if="isLoading" class="media-loading">加载中...</div>
        <div v-else-if="mediaError" class="media-error">
          原件加载失败: {{ mediaError }}
        </div>
        <img
          v-else-if="mediaUrl"
          :src="mediaUrl"
          alt="inbox 照片"
          class="photo-img"
        />
      </div>

      <!-- voice: 音频播放器 -->
      <div
        v-else-if="props.item.capture_type === 'voice'"
        class="media-preview voice-preview"
      >
        <div v-if="isLoading" class="media-loading">加载中...</div>
        <div v-else-if="mediaError" class="media-error">
          原件加载失败: {{ mediaError }}
        </div>
        <audio
          v-else-if="mediaUrl"
          :src="mediaUrl"
          controls
          class="voice-audio"
        />
      </div>
    </div>
  </article>
</template>

<style scoped>
.inbox-item-card {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  transition: border-color 0.15s, background 0.15s;
}

.inbox-item-card.checked {
  border-color: #2563eb;
  background: #eff6ff;
}

.card-checkbox {
  flex-shrink: 0;
  padding-top: 0.15rem;
}

.card-checkbox input[type='checkbox'] {
  width: 1.1rem;
  height: 1.1rem;
  cursor: pointer;
}

.card-body {
  flex: 1;
  min-width: 0; /* 让 flex 子元素可以 shrink, text-content 才能正常省略 */
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
}

.type-badge {
  font-weight: 600;
  color: #4b5563;
}

.timestamp {
  color: #6b7280;
  font-variant-numeric: tabular-nums;
}

.item-id {
  color: #9ca3af;
  font-size: 0.75rem;
  margin-left: auto;
}

.text-content {
  color: #1f2937;
  font-size: 0.92rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 6rem;
  overflow-y: auto;
  padding: 0.4rem 0.5rem;
  background: #f9fafb;
  border-radius: 4px;
}

.media-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f9fafb;
  border-radius: 4px;
  min-height: 4rem;
  padding: 0.4rem;
}

.photo-preview {
  justify-content: flex-start;
}

.photo-img {
  max-width: 100%;
  max-height: 12rem;
  border-radius: 3px;
  object-fit: contain;
}

.voice-audio {
  width: 100%;
  max-width: 100%;
}

.media-loading,
.media-error {
  font-size: 0.85rem;
  color: #6b7280;
  padding: 0.5rem;
}

.media-error {
  color: #991b1b;
}
</style>
