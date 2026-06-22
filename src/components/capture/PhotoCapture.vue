<script setup lang="ts">
// PhotoCapture —— Quick Capture 拍照 / 图库上传入口
// PRD 7.1: 调起摄像头连拍, 或从图库选择多张检查报告/化验单/药盒
//
// 数据流（每张照片）:
//   input[type=file] → File 转 Blob
//   → generateStorageKey({category:'inbox', fileExt: jpg|png})
//   → StorageAdapter.saveFile(key, blob)
//   → InboxRepository.create({capture_type:'photo', storage_key:key, text_content:null})
//
// 每张照片独立调一次 inbox.create（schema: inbox_items 单条记录）
// 多张照片部分失败不影响其他张（逐张报告）
import { computed, onUnmounted, ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';
import { generateStorageKey } from '@/storage/keys';

interface PendingPhoto {
  id: string; // 临时 uid, 用于 v-for key
  file: File;
  previewUrl: string; // URL.createObjectURL 结果
}

interface SavedResult {
  fileName: string;
  ok: boolean;
  error?: string;
  inboxId?: number;
}

const storage = new IndexedDbStorageAdapter();

const pendingPhotos = ref<PendingPhoto[]>([]);
const isSaving = ref(false);
const savedResults = ref<SavedResult[]>([]);

const hasPending = computed(() => pendingPhotos.value.length > 0);
const canSave = computed(() => hasPending.value && !isSaving.value);

function fileExtFromType(mime: string): string {
  // schema attachments.file_type CHECK ('jpg','png','pdf')
  // inbox_items.storage_key 没强制约束, 但保持一致便于后续归档转 attachment
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png') return 'png';
  // 兜底: 其他格式（heic/webp）也用 jpg 扩展名（浏览器转码需要另做, MVP 接受）
  return 'jpg';
}

function handleFileSelect(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files === null) return;

  const newPhotos: PendingPhoto[] = [];
  for (const file of Array.from(input.files)) {
    if (!file.type.startsWith('image/')) {
      // 非图片跳过（不应发生, accept=image/* 已过滤）
      continue;
    }
    newPhotos.push({
      id: `${file.name}-${file.size}-${crypto.randomUUID()}`,
      file,
      previewUrl: URL.createObjectURL(file),
    });
  }
  pendingPhotos.value = [...pendingPhotos.value, ...newPhotos];

  // 清空 input value 允许重复选择同一文件
  input.value = '';
}

function removePending(id: string): void {
  const idx = pendingPhotos.value.findIndex((p) => p.id === id);
  if (idx === -1) return;
  URL.revokeObjectURL(pendingPhotos.value[idx].previewUrl);
  pendingPhotos.value.splice(idx, 1);
}

async function handleSaveAll(): Promise<void> {
  if (!canSave.value) return;
  isSaving.value = true;
  savedResults.value = [];

  try {
    const repos = await useRepositories();
    // 复制一份, 保存过程中清空 pending 让 UI 立即反馈
    const queue = [...pendingPhotos.value];

    for (const photo of queue) {
      const result: SavedResult = { fileName: photo.file.name, ok: false };
      try {
        const fileExt = fileExtFromType(photo.file.type);
        const storageKey = generateStorageKey({
          category: 'inbox',
          fileExt,
        });

        // 先存原件到 IndexedDB
        await storage.saveFile(storageKey, photo.file);

        // 再写 inbox_items metadata
        try {
          const item = await repos.inbox.create({
            capture_type: 'photo',
            storage_key: storageKey,
            text_content: null,
          });
          result.ok = true;
          result.inboxId = item.id;
        } catch (e) {
          // metadata 写失败: 原件已成为孤儿 Blob（后续 StorageGC 清理）
          result.error = e instanceof Error ? e.message : String(e);
          // 不抛出, 继续下一张
        }
      } catch (e) {
        // saveFile 失败: 没写任何东西, 安全
        result.error = e instanceof Error ? e.message : String(e);
      }
      savedResults.value.push(result);

      // 从 pending 移除已处理的
      const idx = pendingPhotos.value.findIndex((p) => p.id === photo.id);
      if (idx !== -1) {
        URL.revokeObjectURL(pendingPhotos.value[idx].previewUrl);
        pendingPhotos.value.splice(idx, 1);
      }
    }
  } finally {
    isSaving.value = false;
  }
}

// 清理所有 object URL 防内存泄漏
onUnmounted(() => {
  for (const p of pendingPhotos.value) {
    URL.revokeObjectURL(p.previewUrl);
  }
});

const successCount = computed(() => savedResults.value.filter((r) => r.ok).length);
const failureCount = computed(() => savedResults.value.filter((r) => !r.ok).length);
</script>

<template>
  <section class="photo-capture">
    <label class="pick-btn">
      <input
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        @change="handleFileSelect"
      />
      📷 拍照 / 选择图片
    </label>

    <div v-if="hasPending" class="preview-grid">
      <div v-for="photo in pendingPhotos" :key="photo.id" class="preview-item">
        <img :src="photo.previewUrl" :alt="photo.file.name" />
        <button
          type="button"
          class="remove-btn"
          :disabled="isSaving"
          @click="removePending(photo.id)"
        >
          ×
        </button>
        <span class="file-name">{{ photo.file.name }}</span>
      </div>
    </div>

    <div v-if="hasPending" class="actions">
      <span class="count">{{ pendingPhotos.length }} 张待保存</span>
      <button
        type="button"
        class="save-all-btn"
        :disabled="!canSave"
        @click="handleSaveAll"
      >
        {{ isSaving ? `保存中（${successCount + failureCount}/${pendingPhotos.length + successCount + failureCount}）` : '全部保存到待整理' }}
      </button>
    </div>

    <div v-if="savedResults.length > 0" class="results">
      <p v-if="successCount > 0" class="msg msg-ok">
        ✓ {{ successCount }} 张已保存到待整理
      </p>
      <div v-if="failureCount > 0" class="msg msg-error">
        <p>✗ {{ failureCount }} 张保存失败:</p>
        <ul>
          <li v-for="(r, i) in savedResults.filter(x => !x.ok)" :key="i">
            {{ r.fileName }}: {{ r.error }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.photo-capture {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.pick-btn {
  display: inline-block;
  padding: 1rem;
  background: #f3f4f6;
  border: 2px dashed #d1d5db;
  border-radius: 6px;
  cursor: pointer;
  text-align: center;
  color: #4b5563;
  font-weight: 500;
  transition: border-color 0.15s, background 0.15s;
}

.pick-btn:hover {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1e40af;
}

.pick-btn input[type='file'] {
  display: none;
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 0.75rem;
}

.preview-item {
  position: relative;
  aspect-ratio: 1;
  background: #f9fafb;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.preview-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.remove-btn {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
}

.remove-btn:hover:not(:disabled) {
  background: rgba(220, 38, 38, 0.9);
}

.remove-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.file-name {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  font-size: 0.7rem;
  padding: 0.15rem 0.3rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.count {
  color: #6b7280;
  font-size: 0.9rem;
}

.save-all-btn {
  padding: 0.6rem 1.2rem;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
}

.save-all-btn:hover:not(:disabled) {
  background: #1d4ed8;
}

.save-all-btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.msg {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 4px;
  font-size: 0.9rem;
}

.msg-ok {
  background: #ecfdf5;
  color: #065f46;
}

.msg-error {
  background: #fef2f2;
  color: #991b1b;
}

.msg-error ul {
  margin: 0.3rem 0 0;
  padding-left: 1.2rem;
}
</style>
