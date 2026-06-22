<script setup lang="ts">
// MemberForm —— 成员创建/编辑表单
// 组合:
//   - 标量字段（name / nickname / birthday / gender / remark）
//   - JSON 字段（allergies / chronic_conditions / current_medications）
//
// 双模式:
//   - 创建: initialValues 不传, 提交 emit('submit', createInput)
//   - 编辑: initialValues 传入已有成员, 提交 emit('submit', updateInput)
//
// 不直接调 Repository: 父组件 MembersView 负责 modal 管理 + Repository 调用
// 这样组件职责清晰: 本组件只管表单状态 + 校验
import { reactive, ref, watch } from 'vue';
import type {
  Allergy,
  ChronicCondition,
  FamilyMember,
  FamilyMemberCreateInput,
  FamilyMemberUpdateInput,
} from '@/repositories';
import AllergyEditor from './AllergyEditor.vue';
import ChronicConditionEditor from './ChronicConditionEditor.vue';
import StringListEditor from './StringListEditor.vue';

const props = defineProps<{
  /** 编辑模式时传入已有成员; 创建模式不传 */
  initialValues?: FamilyMember | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  submit: [input: FamilyMemberCreateInput | FamilyMemberUpdateInput];
  cancel: [];
}>();

interface FormState {
  name: string;
  nickname: string;
  birthday: string;
  gender: 'male' | 'female' | 'other' | '';
  allergies: Allergy[];
  chronic_conditions: ChronicCondition[];
  current_medications: string[];
  remark: string;
}

function makeDefault(): FormState {
  return {
    name: '',
    nickname: '',
    birthday: '',
    gender: '',
    allergies: [],
    chronic_conditions: [],
    current_medications: [],
    remark: '',
  };
}

const form = reactive<FormState>(makeDefault());

// 当 initialValues 变化（打开 modal / 切换编辑对象）时重置表单
watch(
  () => props.initialValues,
  (val) => {
    const next = makeDefault();
    if (val) {
      next.name = val.name;
      next.nickname = val.nickname ?? '';
      next.birthday = val.birthday ?? '';
      next.gender = val.gender ?? '';
      next.allergies = val.allergies.map((a) => ({ ...a }));
      next.chronic_conditions = val.chronic_conditions.map((c) => ({ ...c }));
      next.current_medications = [...val.current_medications];
      next.remark = val.remark ?? '';
    }
    Object.assign(form, next);
  },
  { immediate: true },
);

function buildInput(): FamilyMemberCreateInput {
  const trimmedName = form.name.trim();
  if (!trimmedName) {
    throw new Error('请填写姓名');
  }
  return {
    name: trimmedName,
    nickname: form.nickname.trim() || null,
    birthday: form.birthday || null,
    gender: form.gender === '' ? null : form.gender,
    allergies: form.allergies
      .filter((a) => a.name.trim() !== '')
      .map((a) => ({
        name: a.name.trim(),
        severity: a.severity,
        reaction: a.reaction?.trim() || undefined,
      })),
    chronic_conditions: form.chronic_conditions
      .filter((c) => c.name.trim() !== '')
      .map((c) => ({
        name: c.name.trim(),
        status: c.status,
        diagnosed_date: c.diagnosed_date || undefined,
      })),
    current_medications: form.current_medications
      .map((m) => m.trim())
      .filter((m) => m !== ''),
    remark: form.remark.trim() || null,
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
  <form class="member-form" @submit.prevent="handleSubmit">
    <div class="form-section">
      <label class="form-row">
        <span class="form-label">
          姓名 <span class="required">*</span>
        </span>
        <input
          v-model="form.name"
          type="text"
          class="form-input"
          placeholder="如: 张三"
          required
          :disabled="props.disabled"
        />
      </label>

      <label class="form-row">
        <span class="form-label">昵称</span>
        <input
          v-model="form.nickname"
          type="text"
          class="form-input"
          placeholder="如: 三三（可选）"
          :disabled="props.disabled"
        />
      </label>

      <div class="form-row-multiple">
        <label class="form-row">
          <span class="form-label">生日</span>
          <input
            v-model="form.birthday"
            type="date"
            class="form-input"
            :disabled="props.disabled"
          />
        </label>
        <label class="form-row">
          <span class="form-label">性别</span>
          <select
            v-model="form.gender"
            class="form-input"
            :disabled="props.disabled"
          >
            <option value="">不填</option>
            <option value="male">男</option>
            <option value="female">女</option>
            <option value="other">其他</option>
          </select>
        </label>
      </div>
    </div>

    <div class="form-section">
      <h3 class="section-title">
        过敏
        <small class="section-hint">关键安全信息, 显示在 Dashboard 顶部</small>
      </h3>
      <AllergyEditor
        v-model:value="form.allergies"
        :disabled="props.disabled"
      />
    </div>

    <div class="form-section">
      <h3 class="section-title">慢性病</h3>
      <ChronicConditionEditor
        v-model:value="form.chronic_conditions"
        :disabled="props.disabled"
      />
    </div>

    <div class="form-section">
      <h3 class="section-title">当前长期用药</h3>
      <StringListEditor
        v-model:value="form.current_medications"
        add-label="+ 添加用药"
        empty-hint="无长期用药"
        placeholder="如: 孟鲁司特钠"
        :disabled="props.disabled"
      />
    </div>

    <div class="form-section">
      <label class="form-row">
        <span class="form-label">备注</span>
        <textarea
          v-model="form.remark"
          class="form-input"
          rows="2"
          placeholder="其他想记的信息（可选）"
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
        {{ props.initialValues ? '保存修改' : '添加成员' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.member-form {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
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

.section-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: #1f2937;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.section-hint {
  font-size: 0.78rem;
  font-weight: 400;
  color: #9ca3af;
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
</style>
