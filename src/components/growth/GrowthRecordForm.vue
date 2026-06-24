<script setup lang="ts">
// GrowthRecordForm —— 生长测量录入（创建/编辑）
// 参考 MedicineForm 结构: reactive + watch initialValues reset + buildInput。
//
// 双模式:
//   - 创建: 选成员 + 填日期/身高/体重/头围 → emit('submit', createInput)
//   - 编辑: initialValues 传入, member_id 与 measured_date 锁定 (update 不含这两项)
//
// 约束:
//   - 至少填身高/体重/头围之一 (空测量无意义)。
//   - 月龄实时预览 (由所选成员 birthday × 日期算), 帮用户核对。
//   - source 不在表单暴露, 默认 'home' (capture-first, 极简)。
//   - number 输入经 v-model 会被 Vue 数值化, parseOptionalNumber 兼容 string|number。
import { computed, reactive, ref, watch } from 'vue';
import type {
  FamilyMember,
  GrowthRecord,
  GrowthRecordCreateInput,
  GrowthRecordUpdateInput,
} from '@/repositories';
import { formatAgeMonths, monthsBetween } from '@/lib/growth/age';

const props = defineProps<{
  /** 编辑模式时传入已有记录; 创建模式不传 */
  initialValues?: GrowthRecord | null;
  /** 家庭成员列表 (父组件加载). 表单自身不做 IO */
  members: FamilyMember[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  submit: [input: GrowthRecordCreateInput | GrowthRecordUpdateInput];
  cancel: [];
}>();

interface FormState {
  member_id: number | null;
  measured_date: string; // YYYY-MM-DD
  height_cm: string;
  weight_kg: string;
  head_cm: string;
  note: string;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeDefault(): FormState {
  return {
    member_id: null,
    measured_date: todayStr(),
    height_cm: '',
    weight_kg: '',
    head_cm: '',
    note: '',
  };
}

const form = reactive<FormState>(makeDefault());

watch(
  () => props.initialValues,
  (val) => {
    const next = makeDefault();
    if (val) {
      next.member_id = val.member_id;
      next.measured_date = val.measured_date;
      next.height_cm = val.height_cm != null ? String(val.height_cm) : '';
      next.weight_kg = val.weight_kg != null ? String(val.weight_kg) : '';
      next.head_cm = val.head_cm != null ? String(val.head_cm) : '';
      next.note = val.note ?? '';
    }
    Object.assign(form, next);
  },
  { immediate: true },
);

const isEdit = () => props.initialValues !== null && props.initialValues !== undefined;

// 兼容 Vue 对 type=number 输入的数值化: 入参可能是 number 或 string
function parseOptionalNumber(raw: string | number): number | null {
  if (typeof raw === 'number') return isNaN(raw) ? null : raw;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return isNaN(n) ? null : n;
}

// 月龄实时预览: 所选成员 birthday × 当前日期
const agePreview = computed<string>(() => {
  if (form.member_id === null || !form.measured_date) return '';
  const m = props.members.find((x) => x.id === form.member_id);
  if (!m || !m.birthday) return '';
  const age = monthsBetween(m.birthday, form.measured_date);
  if (age < 0) return '日期早于出生日';
  return `测量时约 ${formatAgeMonths(age)}`;
});

function buildInput(): GrowthRecordCreateInput | GrowthRecordUpdateInput {
  if (form.member_id === null) {
    throw new Error('请选择成员');
  }
  if (!form.measured_date) {
    throw new Error('请填写测量日期');
  }
  const height = parseOptionalNumber(form.height_cm);
  const weight = parseOptionalNumber(form.weight_kg);
  const head = parseOptionalNumber(form.head_cm);
  if (height === null && weight === null && head === null) {
    throw new Error('至少填写一项身高 / 体重 / 头围');
  }
  const note = form.note.trim() || null;

  if (isEdit()) {
    // UpdateInput 不含 member_id / measured_date
    return { height_cm: height, weight_kg: weight, head_cm: head, note };
  }
  return {
    member_id: form.member_id,
    measured_date: form.measured_date,
    height_cm: height,
    weight_kg: weight,
    head_cm: head,
    note,
  };
}

const errorMsg = ref<string | null>(null);

function handleSubmit(): void {
  errorMsg.value = null;
  try {
    const input = buildInput();
    emit('submit', input);
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  }
}

function handleCancel(): void {
  emit('cancel');
}
</script>

<template>
  <form class="growth-form" @submit.prevent="handleSubmit">
    <div class="form-section">
      <label class="form-row">
        <span class="form-label">
          归属成员 <span class="required">*</span>
        </span>
        <select
          v-model="form.member_id"
          class="form-input"
          :disabled="props.disabled || isEdit()"
        >
          <option :value="null" disabled>选择孩子</option>
          <option v-for="m in props.members" :key="m.id" :value="m.id">
            {{ m.name }}
          </option>
        </select>
        <small v-if="isEdit()" class="form-hint">归属成员创建后不可更改</small>
      </label>

      <label class="form-row">
        <span class="form-label">
          测量日期 <span class="required">*</span>
        </span>
        <input
          v-model="form.measured_date"
          type="date"
          class="form-input"
          :disabled="props.disabled || isEdit()"
        />
        <small v-if="isEdit()" class="form-hint">改日期请删除后重新录入</small>
        <small v-else-if="agePreview" class="form-hint age-preview">
          {{ agePreview }}
        </small>
      </label>
    </div>

    <div class="form-section">
      <p class="section-title">测量数据（至少填一项）</p>
      <label class="form-row">
        <span class="form-label">身高 / 身长 (cm)</span>
        <input
          v-model="form.height_cm"
          type="number"
          class="form-input"
          min="0"
          step="any"
          inputmode="decimal"
          placeholder="如: 100"
          :disabled="props.disabled"
        />
      </label>
      <label class="form-row">
        <span class="form-label">体重 (kg)</span>
        <input
          v-model="form.weight_kg"
          type="number"
          class="form-input"
          min="0"
          step="any"
          inputmode="decimal"
          placeholder="如: 16"
          :disabled="props.disabled"
        />
      </label>
      <label class="form-row">
        <span class="form-label">头围 (cm)</span>
        <input
          v-model="form.head_cm"
          type="number"
          class="form-input"
          min="0"
          step="any"
          inputmode="decimal"
          placeholder="婴幼儿关键指标, 可空"
          :disabled="props.disabled"
        />
      </label>
    </div>

    <div class="form-section">
      <label class="form-row">
        <span class="form-label">备注</span>
        <textarea
          v-model="form.note"
          class="form-input"
          rows="2"
          placeholder="如: 儿保体检测得 / 家里量的 (可选)"
          :disabled="props.disabled"
        />
      </label>
    </div>

    <p v-if="errorMsg" class="form-error">{{ errorMsg }}</p>

    <div class="form-actions">
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="props.disabled"
        @click="handleCancel"
      >
        取消
      </button>
      <button
        type="submit"
        class="btn btn-primary"
        :disabled="props.disabled"
      >
        {{ isEdit() ? '保存修改' : '记录测量' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.growth-form {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.section-title {
  margin: 0;
  font-size: 0.85rem;
  color: #4b5563;
  font-weight: 500;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.form-label {
  font-size: 0.85rem;
  color: #4b5563;
  font-weight: 500;
}

.required {
  color: #dc2626;
}

.form-input {
  padding: 0.55rem 0.7rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.95rem;
  font-family: inherit;
  background: white;
  color: #1f2937;
}

.form-input:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.form-input:disabled {
  background: #f9fafb;
  cursor: not-allowed;
}

textarea.form-input {
  resize: vertical;
  min-height: 3rem;
}

.form-hint {
  font-size: 0.78rem;
  color: #9ca3af;
}

.age-preview {
  color: #2563eb;
  font-weight: 500;
}

.form-error {
  margin: 0;
  padding: 0.5rem 0.7rem;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 4px;
  font-size: 0.88rem;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid #e5e7eb;
}
</style>
