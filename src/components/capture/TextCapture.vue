<script setup lang="ts">
// TextCapture —— Quick Capture 的纯文字入口
// PRD 7.1: 一行快速笔记（实际允许多行更实用）
//
// 数据流: textarea → InboxRepository.create({capture_type:'text', storage_key:null, text_content})
// 不涉及媒体存储, 最简单的 capture 类型
import { computed, ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import type { InboxItem } from '@/repositories';

const text = ref('');
const isSaving = ref(false);
const errorMsg = ref<string | null>(null);
const lastSavedId = ref<number | null>(null);

const charCount = computed(() => text.value.length);
const canSave = computed(() => text.value.trim().length > 0 && !isSaving.value);

async function handleSave(): Promise<void> {
  if (!canSave.value) return;
  isSaving.value = true;
  errorMsg.value = null;
  lastSavedId.value = null;
  try {
    const repos = await useRepositories();
    const item: InboxItem = await repos.inbox.create({
      capture_type: 'text',
      storage_key: null,
      text_content: text.value,
    });
    lastSavedId.value = item.id;
    text.value = ''; // 清空, 准备下一条
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <section class="text-capture">
    <textarea
      v-model="text"
      class="text-input"
      placeholder="记点什么: 昨晚孩子发烧 39 度, 吃了美林退到 37.5..."
      :disabled="isSaving"
      rows="4"
    />
    <div class="meta">
      <span class="char-count">{{ charCount }} 字</span>
      <button
        type="button"
        class="save-btn"
        :disabled="!canSave"
        @click="handleSave"
      >
        {{ isSaving ? '保存中...' : '保存到待整理' }}
      </button>
    </div>

    <p v-if="errorMsg" class="msg msg-error">保存失败: {{ errorMsg }}</p>
    <p v-else-if="lastSavedId !== null" class="msg msg-ok">
      已保存到待整理（#{{ lastSavedId }}）, 可继续记下一条。
    </p>
  </section>
</template>

<style scoped>
.text-capture {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.text-input {
  width: 100%;
  padding: 0.8rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
  resize: vertical;
  min-height: 6rem;
}

.text-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.char-count {
  color: #6b7280;
  font-size: 0.85rem;
}

.save-btn {
  padding: 0.6rem 1.2rem;
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.save-btn:hover:not(:disabled) {
  background: #1d4ed8;
}

.save-btn:disabled {
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
