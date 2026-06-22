<script setup lang="ts">
// VoiceCapture —— Quick Capture 语音备忘入口
// PRD 7.1: 例 "昨晚孩子 39 度, 吃了美林退到 37.5", 录完存 inbox
//
// 数据流:
//   getUserMedia({audio:true}) → MediaRecorder 录制 → Blob
//   → generateStorageKey({category:'inbox', fileExt:'m4a'})
//   → StorageAdapter.saveFile + InboxRepository.create({capture_type:'voice', storage_key, text_content:null})
//
// 兼容性: MediaRecorder 在 iOS Safari 14+ 可用, 老版本不支持。检测后禁用按钮
// Blob.type 浏览器差异: Chrome 默认 audio/webm; Safari audio/mp4. 扩展名统一 'm4a'
import { computed, onUnmounted, ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';
import { generateStorageKey } from '@/storage/keys';

type State = 'idle' | 'recording' | 'recorded' | 'saving' | 'saved';

const state = ref<State>('idle');
const errorMsg = ref<string | null>(null);
const elapsedSec = ref(0);
const audioUrl = ref<string | null>(null);
const lastSavedId = ref<number | null>(null);

const storage = new IndexedDbStorageAdapter();
let mediaRecorder: MediaRecorder | null = null;
let mediaStream: MediaStream | null = null;
let chunks: Blob[] = [];
let timerId: number | null = null;
let currentBlob: Blob | null = null;

const isSupported = computed(
  () =>
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof MediaRecorder !== 'undefined',
);

const canStart = computed(() => state.value === 'idle' && isSupported.value);
const canStop = computed(() => state.value === 'recording');
const canSave = computed(
  () => state.value === 'recorded' || (state.value === 'saved' && audioUrl.value !== null),
);
const canReset = computed(
  () => state.value === 'recorded' || state.value === 'saved',
);

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

async function handleStart(): Promise<void> {
  errorMsg.value = null;
  lastSavedId.value = null;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);
    chunks = [];

    mediaRecorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      // Chrome: audio/webm; Safari: audio/mp4. 扩展名统一 m4a（与 keys.ts 示例对齐）
      const type = mediaRecorder?.mimeType || 'audio/webm';
      currentBlob = new Blob(chunks, { type });
      audioUrl.value = URL.createObjectURL(currentBlob);
      state.value = 'recorded';
    };

    mediaRecorder.start();
    state.value = 'recording';
    elapsedSec.value = 0;
    timerId = window.setInterval(() => {
      elapsedSec.value += 1;
    }, 1000);
  } catch (e) {
    state.value = 'idle';
    if (e instanceof DOMException) {
      if (e.name === 'NotAllowedError') {
        errorMsg.value = '麦克风权限被拒绝。请在浏览器地址栏的权限图标里允许。';
      } else if (e.name === 'NotFoundError') {
        errorMsg.value = '未找到麦克风设备。';
      } else {
        errorMsg.value = `${e.name}: ${e.message}`;
      }
    } else {
      errorMsg.value = e instanceof Error ? e.message : String(e);
    }
  }
}

function handleStop(): void {
  if (mediaRecorder === null) return;
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  // 关闭 stream（停止麦克风指示器）
  if (mediaStream !== null) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

function handleReset(): void {
  if (audioUrl.value !== null) {
    URL.revokeObjectURL(audioUrl.value);
  }
  audioUrl.value = null;
  currentBlob = null;
  lastSavedId.value = null;
  elapsedSec.value = 0;
  state.value = 'idle';
}

async function handleSave(): Promise<void> {
  if (currentBlob === null) return;
  state.value = 'saving';
  errorMsg.value = null;
  try {
    const storageKey = generateStorageKey({
      category: 'inbox',
      fileExt: 'm4a',
    });
    await storage.saveFile(storageKey, currentBlob);

    try {
      const repos = await useRepositories();
      const item = await repos.inbox.create({
        capture_type: 'voice',
        storage_key: storageKey,
        text_content: null,
      });
      lastSavedId.value = item.id;
      state.value = 'saved';
    } catch (e) {
      // metadata 写失败: 原件成孤儿 Blob（接受, 后续 StorageGC 清理）
      state.value = 'recorded';
      errorMsg.value = `媒体已保存但 inbox 记录写入失败: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  } catch (e) {
    state.value = 'recorded';
    errorMsg.value = `媒体保存失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// 组件卸载: 释放资源 + 关闭麦克风
onUnmounted(() => {
  if (mediaRecorder !== null && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  if (timerId !== null) clearInterval(timerId);
  if (mediaStream !== null) {
    mediaStream.getTracks().forEach((t) => t.stop());
  }
  if (audioUrl.value !== null) URL.revokeObjectURL(audioUrl.value);
});
</script>

<template>
  <section class="voice-capture">
    <div v-if="!isSupported" class="msg msg-error">
      当前浏览器不支持 MediaRecorder API。请在 Chrome / Edge / Firefox 或 iOS Safari 14+ 打开。
    </div>

    <div class="record-area">
      <div v-if="state === 'recording'" class="recording-indicator">
        <span class="pulse-dot"></span>
        录音中 · {{ formatTime(elapsedSec) }}
      </div>
      <div v-else-if="state === 'recorded' || state === 'saved'" class="recorded-info">
        录音时长: {{ formatTime(elapsedSec) }}
      </div>
      <div v-else class="hint">点下面的按钮开始录音（需要麦克风权限）</div>
    </div>

    <div v-if="audioUrl" class="preview">
      <audio :src="audioUrl" controls />
    </div>

    <div class="actions">
      <button
        v-if="canStart"
        type="button"
        class="btn btn-primary"
        @click="handleStart"
      >
        🎤 开始录音
      </button>
      <button
        v-else-if="canStop"
        type="button"
        class="btn btn-danger"
        @click="handleStop"
      >
        ⏹ 停止
      </button>
      <button
        v-if="canReset"
        type="button"
        class="btn btn-secondary"
        :disabled="state === 'saving'"
        @click="handleReset"
      >
        重录
      </button>
      <button
        v-if="canSave"
        type="button"
        class="btn btn-primary"
        :disabled="state === 'saving' || state === 'saved'"
        @click="handleSave"
      >
        {{ state === 'saving' ? '保存中...' : state === 'saved' ? '已保存' : '保存到待整理' }}
      </button>
    </div>

    <p v-if="errorMsg" class="msg msg-error">{{ errorMsg }}</p>
    <p v-else-if="lastSavedId !== null" class="msg msg-ok">
      已保存到待整理（#{{ lastSavedId }}）, 可继续录下一条。
    </p>
  </section>
</template>

<style scoped>
.voice-capture {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.record-area {
  padding: 1.5rem;
  background: #f9fafb;
  border-radius: 6px;
  text-align: center;
  min-height: 4rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hint {
  color: #6b7280;
  font-size: 0.9rem;
}

.recording-indicator {
  color: #dc2626;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.pulse-dot {
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  background: #dc2626;
  border-radius: 50%;
  animation: pulse 1.2s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.recorded-info {
  color: #1f2937;
  font-weight: 500;
}

.preview audio {
  width: 100%;
}

.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.btn {
  padding: 0.7rem 1.4rem;
  border: none;
  border-radius: 6px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-primary {
  background: #2563eb;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.btn-danger {
  background: #dc2626;
  color: white;
}

.btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

.btn-secondary {
  background: #f3f4f6;
  color: #4b5563;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
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
</style>
