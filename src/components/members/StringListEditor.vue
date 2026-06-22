<script setup lang="ts">
// StringListEditor —— 通用 string[] 动态编辑器
// 用途:
//   - FamilyMember.current_medications（当前用药）
//   - 后续 Attachment.tags（复用）
//
// v-model 模式: 父组件用 v-model:value="..." 双向绑定
// 空数组显示提示文案, 每条 input + × 删除按钮 + 底部"+ 添加"按钮
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    value: string[];
    addLabel?: string;
    emptyHint?: string;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  {
    addLabel: '+ 添加',
    emptyHint: '无',
    placeholder: '',
    disabled: false,
  },
);

const emit = defineEmits<{
  'update:value': [value: string[]];
}>();

const items = computed(() => props.value);

function update(next: string[]): void {
  emit('update:value', next);
}

function addItem(): void {
  update([...items.value, '']);
}

function removeItem(idx: number): void {
  const next = [...items.value];
  next.splice(idx, 1);
  update(next);
}

function updateItem(idx: number, val: string): void {
  const next = [...items.value];
  next[idx] = val;
  update(next);
}
</script>

<template>
  <div class="string-list-editor">
    <div v-if="items.length === 0" class="empty-hint">{{ props.emptyHint }}</div>
    <div
      v-for="(_item, idx) in items"
      :key="idx"
      class="item-row"
    >
      <input
        type="text"
        class="item-input"
        :value="items[idx]"
        :placeholder="props.placeholder"
        :disabled="props.disabled"
        @input="updateItem(idx, ($event.target as HTMLInputElement).value)"
      />
      <button
        type="button"
        class="remove-btn"
        :disabled="props.disabled"
        aria-label="删除"
        @click="removeItem(idx)"
      >
        ×
      </button>
    </div>
    <button
      type="button"
      class="add-btn"
      :disabled="props.disabled"
      @click="addItem"
    >
      {{ props.addLabel }}
    </button>
  </div>
</template>

<style scoped>
.string-list-editor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.empty-hint {
  color: #9ca3af;
  font-size: 0.85rem;
  padding: 0.25rem 0;
}

.item-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.item-input {
  flex: 1;
  padding: 0.45rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.9rem;
  font-family: inherit;
}

.item-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.item-input:disabled {
  background: #f9fafb;
  cursor: not-allowed;
}

.remove-btn {
  width: 1.75rem;
  height: 1.75rem;
  background: transparent;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  font-size: 1.1rem;
  line-height: 1;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.15s;
}

.remove-btn:hover:not(:disabled) {
  background: #fef2f2;
  border-color: #dc2626;
  color: #dc2626;
}

.remove-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-btn {
  align-self: flex-start;
  padding: 0.4rem 0.8rem;
  background: #f3f4f6;
  color: #4b5563;
  border: 1px dashed #d1d5db;
  border-radius: 4px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s;
}

.add-btn:hover:not(:disabled) {
  border-color: #2563eb;
  color: #2563eb;
  background: #eff6ff;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
