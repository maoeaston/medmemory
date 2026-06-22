<script setup lang="ts">
// AllergyEditor —— family_members.allergies JSON 字段的动态编辑器
// 每条 Allergy = { name, severity: 'mild'|'moderate'|'severe', reaction? }
//
// PRD 7.3 / 9.3: 过敏是关键安全信息, 强制顶部展示, 不可折叠
// Dashboard 会读 allergies[0] 高亮显示（MemberCard.vue）
import { computed } from 'vue';
import type { Allergy } from '@/repositories';

const props = withDefaults(
  defineProps<{
    value: Allergy[];
    disabled?: boolean;
  }>(),
  {
    disabled: false,
  },
);

const emit = defineEmits<{
  'update:value': [value: Allergy[]];
}>();

const items = computed(() => props.value);

const severityLabels: Record<Allergy['severity'], string> = {
  mild: '轻度',
  moderate: '中度',
  severe: '严重',
};

function update(next: Allergy[]): void {
  emit('update:value', next);
}

function addItem(): void {
  update([
    ...items.value,
    { name: '', severity: 'mild' },
  ]);
}

function removeItem(idx: number): void {
  const next = [...items.value];
  next.splice(idx, 1);
  update(next);
}

function updateField<K extends keyof Allergy>(
  idx: number,
  field: K,
  val: Allergy[K],
): void {
  const next = [...items.value];
  next[idx] = { ...next[idx], [field]: val };
  update(next);
}
</script>

<template>
  <div class="allergy-editor">
    <div v-if="items.length === 0" class="empty-hint">无过敏记录</div>
    <div
      v-for="(item, idx) in items"
      :key="idx"
      :class="['allergy-row', { 'row-severe': item.severity === 'severe' }]"
    >
      <input
        type="text"
        class="field-name"
        :value="item.name"
        placeholder="过敏原（如: 青霉素）"
        :disabled="props.disabled"
        @input="updateField(idx, 'name', ($event.target as HTMLInputElement).value)"
      />
      <select
        class="field-severity"
        :value="item.severity"
        :disabled="props.disabled"
        @change="updateField(idx, 'severity', ($event.target as HTMLSelectElement).value as Allergy['severity'])"
      >
        <option value="mild">{{ severityLabels.mild }}</option>
        <option value="moderate">{{ severityLabels.moderate }}</option>
        <option value="severe">{{ severityLabels.severe }}</option>
      </select>
      <input
        type="text"
        class="field-reaction"
        :value="item.reaction ?? ''"
        placeholder="反应（可选, 如: 皮疹）"
        :disabled="props.disabled"
        @input="updateField(idx, 'reaction', ($event.target as HTMLInputElement).value)"
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
      + 添加过敏
    </button>
  </div>
</template>

<style scoped>
.allergy-editor {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.empty-hint {
  color: #9ca3af;
  font-size: 0.85rem;
  padding: 0.25rem 0;
}

.allergy-row {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr 1.2fr auto;
  gap: 0.4rem;
  align-items: center;
  padding: 0.3rem;
  border-radius: 4px;
  background: #f9fafb;
}

.allergy-row.row-severe {
  background: #fef2f2;
}

.field-name,
.field-reaction {
  padding: 0.4rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.85rem;
  font-family: inherit;
  background: white;
}

.field-name:focus,
.field-reaction:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.field-severity {
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
  background: #fff7ed;
  color: #c2410c;
  border: 1px dashed #fb923c;
  border-radius: 4px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s;
}

.add-btn:hover:not(:disabled) {
  background: #ffedd5;
  border-color: #f97316;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 540px) {
  .allergy-row {
    grid-template-columns: 1fr;
    gap: 0.3rem;
  }
}
</style>
