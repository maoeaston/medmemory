<script setup lang="ts">
// ArchiveForm —— 归档表单
// 把选中的 inbox_items 归档为一个新的 medical_event
//
// 字段:
//   - member (required, select 从父传入的成员列表)
//   - event_date (required, date, 默认今天)
//   - title (required, text)
//   - event_type (optional, select 7 种, 默认 'other')
//   - hospital (optional)
//   - department (optional)
//   - summary (optional textarea)
//
// 预填策略:
//   - 选中条目中有 text 类型时, summary 默认填入（多条换行拼接）
//   - 父组件传 initialSummary 即可（在 InboxView 里计算）
//
// 不调 Repository: 只 emit('submit', eventInput), 父组件调 archiveInboxItems
import { reactive, ref, watch } from 'vue';
import type {
  EventType,
  FamilyMember,
  MedicalEventCreateInput,
} from '@/repositories';

const props = defineProps<{
  members: FamilyMember[];
  /** 预填的 summary（来自选中的 text inbox items, 可空） */
  initialSummary?: string;
  /** 选中的条数（仅用于 submit 按钮文案） */
  selectedCount: number;
  disabled?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  submit: [input: MedicalEventCreateInput];
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

function todayIso(): string {
  // YYYY-MM-DD 本地时区（事件日期按本地习惯, 不走 UTC）
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface FormState {
  memberId: number | '';
  eventDate: string;
  title: string;
  eventType: EventType;
  hospital: string;
  department: string;
  summary: string;
  nextVisitDate: string;
}

function makeDefault(): FormState {
  return {
    memberId: '',
    eventDate: todayIso(),
    title: '',
    eventType: 'other',
    hospital: '',
    department: '',
    summary: props.initialSummary ?? '',
    nextVisitDate: '',
  };
}

const form = reactive<FormState>(makeDefault());
const validationError = ref<string | null>(null);

// initialSummary 变化时（用户改变选择）只更新 summary, 不重置其他字段
watch(
  () => props.initialSummary,
  (val) => {
    // 仅在用户没动过 summary 时跟随更新（简单策略: summary 为空 或 等于上一次 initialSummary）
    // 这里采用更直接策略: 每次选择变化都覆盖 summary（用户可再编辑）
    form.summary = val ?? '';
  },
);

function handleSubmit(): void {
  validationError.value = null;
  if (form.memberId === '' || form.memberId === 0) {
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

  const input: MedicalEventCreateInput = {
    member_id: form.memberId as number,
    event_date: form.eventDate,
    title: form.title.trim(),
    event_type: form.eventType,
    hospital: form.hospital.trim() || null,
    department: form.department.trim() || null,
    summary: form.summary.trim() || null,
    next_visit_date: form.nextVisitDate || null,
  };
  emit('submit', input);
}

function handleCancel(): void {
  emit('cancel');
}
</script>

<template>
  <form class="archive-form" @submit.prevent="handleSubmit">
    <p v-if="props.selectedCount > 0" class="form-context">
      将归档 <strong>{{ props.selectedCount }}</strong> 条记录为一个新的医疗事件。
    </p>

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
        <option value="" disabled>请选择成员</option>
        <option
          v-for="m in props.members"
          :key="m.id"
          :value="m.id"
        >
          {{ m.name }}<span v-if="m.nickname"> ({{ m.nickname }})</span>
        </option>
      </select>
      <p v-if="props.members.length === 0" class="form-warn">
        还没有成员。请先到
        <RouterLink to="/members" class="link">成员管理</RouterLink>
        添加。
      </p>
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
        rows="3"
        placeholder="事件概要（可选, 可从文字 inbox 自动填入）"
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
        :disabled="props.disabled || props.members.length === 0"
      >
        {{ props.disabled ? '归档中...' : `归档 ${props.selectedCount} 条` }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.archive-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.form-context {
  margin: 0 0 0.25rem;
  padding: 0.5rem 0.7rem;
  background: #eff6ff;
  color: #1e40af;
  border-radius: 4px;
  font-size: 0.88rem;
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

.form-warn {
  margin: 0.3rem 0 0;
  padding: 0.4rem 0.6rem;
  background: #fffbeb;
  color: #92400e;
  border-radius: 4px;
  font-size: 0.82rem;
}

.form-hint {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: #6b7280;
}

.link {
  color: #2563eb;
  text-decoration: none;
  font-weight: 500;
}

.link:hover {
  text-decoration: underline;
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
