<script setup lang="ts">
// EventEditForm —— 医疗事件编辑表单（modal 内使用）
//
// 职责: 编辑现有 event 的 7 个标量字段
//   - member_id (select, required)
//   - event_date (date, required)
//   - event_type (select 7 种)
//   - title (text, required)
//   - hospital (text, 可空)
//   - department (text, 可空)
//   - summary (textarea, 可空)
//
// 与 ArchiveForm 的区别:
//   - ArchiveForm 用于从 inbox 创建新 event（含 selectedCount 等上下文）
//   - EventEditForm 用于在事件详情页编辑现有 event
//   - 复用同样的字段约束与 UI 模式, 但 submit emit MedicalEventUpdateInput
//
// 不调 Repository: 只 emit('submit', updateInput), 父组件负责 modal + Repository
import { reactive, ref, watch } from 'vue';
import type {
  EventType,
  FamilyMember,
  MedicalEvent,
  MedicalEventUpdateInput,
} from '@/repositories';

const props = defineProps<{
  /** 必传: 编辑目标 event */
  initialValues: MedicalEvent;
  /** 成员列表（切换 member_id 用） */
  members: FamilyMember[];
  disabled?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  submit: [input: MedicalEventUpdateInput];
  cancel: [];
}>();

const eventTypeOptions: { value: EventType; label: string }[] = [
  { value: 'outpatient', label: '门诊就诊' },
  { value: 'emergency', label: '急诊' },
  { value: 'checkup', label: '体检' },
  { value: 'followup', label: '复诊' },
  { value: 'vaccine', label: '疫苗' },
  { value: 'hospitalization', label: '住院' },
  { value: 'other', label: '其他' },
];

interface FormState {
  memberId: number;
  eventDate: string;
  title: string;
  eventType: EventType;
  hospital: string;
  department: string;
  summary: string;
  nextVisitDate: string;
}

function snapshot(src: MedicalEvent): FormState {
  return {
    memberId: src.member_id,
    eventDate: src.event_date,
    title: src.title,
    eventType: src.event_type,
    hospital: src.hospital ?? '',
    department: src.department ?? '',
    summary: src.summary ?? '',
    nextVisitDate: src.next_visit_date ?? '',
  };
}

const form = reactive<FormState>(snapshot(props.initialValues));
const validationError = ref<string | null>(null);

// 切换编辑目标时重置表单（同一 modal 实例不会跨 event, 但保险起见）
watch(
  () => props.initialValues.id,
  () => {
    Object.assign(form, snapshot(props.initialValues));
    validationError.value = null;
  },
);

function handleSubmit(): void {
  validationError.value = null;
  if (!form.memberId) {
    validationError.value = '请选择成员';
    return;
  }
  if (!form.eventDate) {
    validationError.value = '请选择日期';
    return;
  }
  if (!form.title.trim()) {
    validationError.value = '请填写标题';
    return;
  }

  // 增量 diff: 只下发真正变化的字段（UPDATE input 是 Partial）
  const src = props.initialValues;
  const input: MedicalEventUpdateInput = {};
  if (form.memberId !== src.member_id) input.member_id = form.memberId;
  if (form.eventDate !== src.event_date) input.event_date = form.eventDate;
  if (form.title.trim() !== src.title) input.title = form.title.trim();
  if (form.eventType !== src.event_type) input.event_type = form.eventType;
  const nextHospital = form.hospital.trim() || null;
  if (nextHospital !== src.hospital) input.hospital = nextHospital;
  const nextDept = form.department.trim() || null;
  if (nextDept !== src.department) input.department = nextDept;
  const nextSummary = form.summary.trim() || null;
  if (nextSummary !== src.summary) input.summary = nextSummary;
  const nextVisitDate = form.nextVisitDate || null;
  if (nextVisitDate !== src.next_visit_date) input.next_visit_date = nextVisitDate;

  emit('submit', input);
}

function handleCancel(): void {
  emit('cancel');
}
</script>

<template>
  <form class="event-form" @submit.prevent="handleSubmit">
    <div class="form-row">
      <label class="form-label">
        成员 <span class="required">*</span>
      </label>
      <select
        v-model="form.memberId"
        class="form-input"
        required
        :disabled="props.disabled"
      >
        <option
          v-for="m in props.members"
          :key="m.id"
          :value="m.id"
        >
          {{ m.name }}<span v-if="m.nickname"> ({{ m.nickname }})</span>
        </option>
      </select>
    </div>

    <div class="form-row-multiple">
      <div class="form-row">
        <label class="form-label">
          日期 <span class="required">*</span>
        </label>
        <input
          v-model="form.eventDate"
          type="date"
          class="form-input"
          required
          :disabled="props.disabled"
        />
      </div>

      <div class="form-row">
        <label class="form-label">类型</label>
        <select
          v-model="form.eventType"
          class="form-input"
          :disabled="props.disabled"
        >
          <option
            v-for="opt in eventTypeOptions"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>
      </div>
    </div>

    <div class="form-row">
      <label class="form-label">
        标题 <span class="required">*</span>
      </label>
      <input
        v-model="form.title"
        type="text"
        class="form-input"
        placeholder="如: 儿童医院发烧就诊"
        required
        :disabled="props.disabled"
      />
    </div>

    <div class="form-row-multiple">
      <div class="form-row">
        <label class="form-label">医院</label>
        <input
          v-model="form.hospital"
          type="text"
          class="form-input"
          placeholder="如: 儿童医院（可选）"
          :disabled="props.disabled"
        />
      </div>
      <div class="form-row">
        <label class="form-label">科室</label>
        <input
          v-model="form.department"
          type="text"
          class="form-input"
          placeholder="如: 内科（可选）"
          :disabled="props.disabled"
        />
      </div>
    </div>

    <div class="form-row">
      <label class="form-label">摘要</label>
      <textarea
        v-model="form.summary"
        class="form-input"
        rows="4"
        placeholder="事件概要（可选）"
        :disabled="props.disabled"
      />
    </div>

    <div class="form-row">
      <label class="form-label">下次复诊日期（可选）</label>
      <input
        v-model="form.nextVisitDate"
        type="date"
        class="form-input"
        :disabled="props.disabled"
      />
      <p class="form-hint">医生交代的复诊时间。会显示在 Dashboard 顶部提醒。</p>
    </div>

    <p v-if="validationError" class="form-error">{{ validationError }}</p>
    <p v-if="props.errorMessage" class="form-error">{{ props.errorMessage }}</p>

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
        {{ props.disabled ? '保存中...' : '保存修改' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.event-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.form-row-multiple {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
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
  padding: 0.5rem 0.7rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 0.92rem;
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
  min-height: 3.5rem;
}

.form-error {
  margin: 0;
  padding: 0.5rem 0.7rem;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 4px;
  font-size: 0.88rem;
}

.form-hint {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: #6b7280;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid #e5e7eb;
}

.btn {
  padding: 0.55rem 1.2rem;
  border: none;
  border-radius: 6px;
  font-size: 0.92rem;
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

.btn-secondary {
  background: #f3f4f6;
  color: #4b5563;
}

.btn-secondary:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 540px) {
  .form-row-multiple {
    grid-template-columns: 1fr;
  }
}
</style>
