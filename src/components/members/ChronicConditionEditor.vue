<script setup lang="ts">
// ChronicConditionEditor —— family_members.chronic_conditions JSON 字段的动态编辑器
// 每条 ChronicCondition = { name, status: 'active'|'managed'|'resolved', diagnosed_date? }
//
// PRD 7.3: 慢病在 Dashboard 成员卡片上以列表呈现（非高亮, 区别于过敏）
import { computed } from 'vue';
import type { ChronicCondition } from '@/repositories';

const props = withDefaults(
  defineProps<{
    value: ChronicCondition[];
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);

const emit = defineEmits<{
  'update:value': [value: ChronicCondition[]];
}>();

const items = computed(() => props.value);

const statusLabels: Record<ChronicCondition['status'], string> = {
  active: '进行中',
  managed: '可控',
  resolved: '已结束',
};

function update(next: ChronicCondition[]): void {
  emit('update:value', next);
}

function addItem(): void {
  update([
    ...items.value,
    { name: '', status: 'active' },
  ]);
}

function removeItem(idx: number): void {
  const next = [...items.value];
  next.splice(idx, 1);
  update(next);
}

function updateField<K extends keyof ChronicCondition>(
  idx: number,
  field: K,
  val: ChronicCondition[K],
): void {
  const next = [...items.value];
  next[idx] = { ...next[idx], [field]: val };
  update(next);
}
</script>

<template>
  <div class="chronic-editor">
    <div v-if="items.length === 0" class="empty-hint">无慢病史</div>
    <div
      v-for="(item, idx) in items"
      :key="idx"
      class="chronic-row"
    >
      <input
        type="text"
        class="field-name"
        :value="item.name"
        placeholder="慢病名（如: 哮喘）"
        :disabled="props.disabled"
        @input="updateField(idx, 'name', ($event.target as HTMLInputElement).value)"
      />
      <select
        class="field-status"
        :value="item.status"
        :disabled="props.disabled"
        @change="updateField(idx, 'status', ($event.target as HTMLSelectElement).value as ChronicCondition['status'])"
      >
        <option value="active">{{ statusLabels.active }}</option>
        <option value="managed">{{ statusLabels.managed }}</option>
        <option value="resolved">{{ statusLabels.resolved }}</option>
      </select>
      <input
        type="month"
        class="field-date"
        :value="item.diagnosed_date ?? ''"
        placeholder="确诊时间"
        :disabled="props.disabled"
        @input="updateField(idx, 'diagnosed_date', ($event.target as HTMLInputElement).value)"
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
      + 添加慢病
    </button>
  </div>
</template>

<style scoped>
.chronic-editor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.empty-hint {
  color: #9ca3af;
  font-size: 0.85rem;
  padding: 0.25rem 0;
}

.chronic-row {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr 1fr auto;
  gap: 0.4rem;
  align-items: center;
  padding: 0.3rem;
  border-radius: 4px;
  background: #f9fafb;
}

.field-name {
  padding: 0.4rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.85rem;
  font-family: inherit;
  background: white;
}

.field-name:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.field-status {
  padding: 0.4rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.85rem;
  font-family: inherit;
  background: white;
}

.field-date {
  padding: 0.4rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.85rem;
  font-family: inherit;
  background: white;
}

.remove-btn {
  width: 1.6rem;
  height: 1.6rem;
  background: transparent;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  font-size: 1rem;
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
  background: #eff6ff;
  color: #2563eb;
  border: 1px dashed #93c5fd;
  border-radius: 4px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s;
}

.add-btn:hover:not(:disabled) {
  background: #dbeafe;
  border-color: #2563eb;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 540px) {
  .chronic-row {
    grid-template-columns: 1fr;
    gap: 0.3rem;
  }
}
</style>
