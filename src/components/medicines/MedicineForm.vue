<script setup lang="ts">
// MedicineForm —— 药品创建/编辑表单
// 参考 MemberForm 结构
//
// 双模式:
//   - 创建: initialValues 不传, 提交 emit('submit', createInput)
//   - 编辑: initialValues 传入, 提交 emit('submit', updateInput)
//
// 重要约束: MedicineUpdateInput = Partial<Omit<MedicineCreateInput, 'member_id'>>
//   → member_id 创建后不可改。编辑模式下 select disabled。
//
// members 由父组件 (MedicinesView) 加载后传入, Form 自己不做 IO。
import { reactive, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useAiConfig } from '@/composables/useAiConfig';
import { OpenAiProvider } from '@/lib/ai/OpenAiProvider';
import { MEDICINE_PACKAGE_SCAN_PROMPT } from '@/lib/ai/prompts';
import type {
  FamilyMember,
  Medicine,
  MedicineCreateInput,
  MedicineUpdateInput,
} from '@/repositories';

const props = defineProps<{
  /** 编辑模式时传入已有药品; 创建模式不传 */
  initialValues?: Medicine | null;
  /** 家庭成员列表, 用于 member_id 下拉。父组件负责加载 */
  members: FamilyMember[];
  /** members 加载失败时传入错误文案, Form 显示提示但下拉仍可用 (只有"家庭共用") */
  membersLoadError?: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  submit: [input: MedicineCreateInput | MedicineUpdateInput];
  cancel: [];
}>();

interface FormState {
  name: string;
  usage: string;
  expiry_date: string; // YYYY-MM, 对应 input type="month"
  storage_location: string;
  member_id: number | null; // null = 家庭共用
  quantity: string; // 余量, 字符串绑定; buildInput 解析成 number
  unit: string; // 单位, 自由文本
  remark: string;
}

function makeDefault(): FormState {
  return {
    name: '',
    usage: '',
    expiry_date: '',
    storage_location: '',
    member_id: null,
    quantity: '',
    unit: '',
    remark: '',
  };
}

const form = reactive<FormState>(makeDefault());

// 当 initialValues 变化 (打开 modal / 切换编辑对象) 时重置表单
watch(
  () => props.initialValues,
  (val) => {
    const next = makeDefault();
    if (val) {
      next.name = val.name;
      next.usage = val.usage ?? '';
      next.expiry_date = val.expiry_date ?? '';
      next.storage_location = val.storage_location ?? '';
      next.member_id = val.member_id;
      // quantity=0（含 migration 默认值）视为未记录, 编辑框留空; 真实余量回填
      next.quantity = val.quantity > 0 ? String(val.quantity) : '';
      next.unit = val.unit ?? '';
      next.remark = val.remark ?? '';
    }
    Object.assign(form, next);
  },
  { immediate: true },
);

const isEdit = () => props.initialValues !== null && props.initialValues !== undefined;

// 数量字段: 空串 → 0（与 DB NOT NULL DEFAULT 0 语义一致），非法输入 → 0 兜底
function parseQuantity(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  return isNaN(n) ? 0 : n;
}

function buildInput(): MedicineCreateInput | MedicineUpdateInput {
  const trimmedName = form.name.trim();
  if (!trimmedName) {
    throw new Error('请填写药品名称');
  }

  const unit = form.unit.trim() || null;
  const quantity = parseQuantity(form.quantity);

  if (isEdit()) {
    // UpdateInput 不允许 member_id, 由类型保证
    return {
      name: trimmedName,
      usage: form.usage.trim() || null,
      expiry_date: form.expiry_date || null,
      storage_location: form.storage_location.trim() || null,
      remark: form.remark.trim() || null,
      unit,
      quantity,
    };
  }

  return {
    name: trimmedName,
    usage: form.usage.trim() || null,
    expiry_date: form.expiry_date || null,
    storage_location: form.storage_location.trim() || null,
    member_id: form.member_id,
    remark: form.remark.trim() || null,
    unit,
    quantity,
  };
}

const errorMsg = ref<string | null>(null);

// === 药品包装扫描（v3.4）===
// 复用 OCR namespace 的 API key/baseUrl/model（与化验单 OCR 共享 GPT-4o Vision）
const { hasKey, apiKey, baseUrl, model } = useAiConfig('ocr');
const isScanning = ref(false);
const scanError = ref<string | null>(null);
const scanConfidence = ref<{
  name: 'high' | 'medium' | 'low';
  usage: 'high' | 'medium' | 'low';
  expiry_date: 'high' | 'medium' | 'low';
} | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function triggerFilePicker(): void {
  scanError.value = null;
  fileInput.value?.click();
}

async function onPackagePhoto(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空 input.value 让同一文件可重复选
  input.value = '';
  if (!file) return;

  isScanning.value = true;
  scanError.value = null;
  scanConfidence.value = null;
  try {
    const provider = new OpenAiProvider(
      apiKey.value,
      baseUrl.value,
      model.value,
    );
    const result = await provider.scanMedicinePackage({
      imageBlob: file,
      prompt: MEDICINE_PACKAGE_SCAN_PROMPT,
    });
    // pre-fill: 覆盖 name/usage/expiry_date/remark, 保留 member_id/storage_location
    // （后者跟包装无关, 是用户预设）
    form.name = result.name;
    if (result.usage) form.usage = result.usage;
    if (result.expiry_date) form.expiry_date = result.expiry_date;
    if (result.extra_info) form.remark = result.extra_info;
    scanConfidence.value = result.confidence;
  } catch (e) {
    scanError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isScanning.value = false;
  }
}

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
  <form class="medicine-form" @submit.prevent="handleSubmit">
    <!-- v3.4: 药品包装扫描入口 -->
    <div v-if="hasKey" class="form-section scan-section">
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        capture="environment"
        class="scan-file-input"
        @change="onPackagePhoto"
      />
      <button
        type="button"
        class="btn btn-scan"
        :disabled="isScanning || props.disabled"
        @click="triggerFilePicker"
      >
        {{ isScanning ? '🔍 扫描中...' : '📷 扫描包装' }}
      </button>
      <small class="form-hint">
        拍药品包装（药盒/药瓶/说明书）, AI 自动识别填表
      </small>
      <p
        v-if="scanConfidence && (scanConfidence.name !== 'high' || scanConfidence.usage !== 'high' || scanConfidence.expiry_date !== 'high')"
        class="scan-warning"
      >
        ⚠️ 部分字段置信度低（{{
          [
            scanConfidence.name !== 'high' ? '名称' : null,
            scanConfidence.usage !== 'high' ? '用途' : null,
            scanConfidence.expiry_date !== 'high' ? '有效期' : null,
          ]
            .filter(Boolean)
            .join('/')
        }}）, 请重点核对
      </p>
    </div>
    <div v-else class="form-section scan-section">
      <p class="form-hint">
        💡 想用 AI 扫描包装自动填表？先到
        <RouterLink to="/settings" class="link">设置</RouterLink>
        配置 AI 密钥
      </p>
    </div>

    <p v-if="scanError" class="form-error">扫描失败: {{ scanError }}</p>

    <div class="form-section">
      <label class="form-row">
        <span class="form-label">
          药品名称 <span class="required">*</span>
        </span>
        <input
          v-model="form.name"
          type="text"
          class="form-input"
          placeholder="如: 美林布洛芬混悬液"
          required
          :disabled="props.disabled"
        />
      </label>

      <label class="form-row">
        <span class="form-label">用途</span>
        <input
          v-model="form.usage"
          type="text"
          class="form-input"
          placeholder="如: 退烧 / 过敏 / 腹泻"
          :disabled="props.disabled"
        />
      </label>

      <label class="form-row">
        <span class="form-label">到期日期</span>
        <input
          v-model="form.expiry_date"
          type="month"
          class="form-input"
          :disabled="props.disabled"
        />
      </label>
    </div>

    <div class="form-section">
      <div class="form-row">
        <span class="form-label">数量与单位</span>
        <div class="qty-unit-group">
          <input
            v-model="form.quantity"
            type="number"
            class="form-input qty-input"
            min="0"
            step="any"
            inputmode="decimal"
            placeholder="如: 2"
            :disabled="props.disabled"
          />
          <input
            v-model="form.unit"
            type="text"
            class="form-input unit-input"
            list="unit-options"
            placeholder="如: 盒"
            :disabled="props.disabled"
          />
          <datalist id="unit-options">
            <option value="盒"></option>
            <option value="瓶"></option>
            <option value="片"></option>
            <option value="支"></option>
            <option value="袋"></option>
            <option value="ml"></option>
            <option value="mg"></option>
          </datalist>
        </div>
        <small class="form-hint">
          数量支持小数（液体半瓶记 15）。单位自由填写。
        </small>
      </div>
    </div>

    <div class="form-section">
      <label class="form-row">
        <span class="form-label">归属成员</span>
        <select
          v-model="form.member_id"
          class="form-input"
          :disabled="props.disabled || isEdit()"
        >
          <option :value="null">家庭共用</option>
          <option v-for="m in props.members" :key="m.id" :value="m.id">
            {{ m.name }}
          </option>
        </select>
        <small v-if="isEdit()" class="form-hint">
          归属成员创建后不可更改
        </small>
        <small v-else-if="props.membersLoadError" class="form-hint form-hint-error">
          成员列表加载失败 ({{ props.membersLoadError }}), 仅可选择"家庭共用"
        </small>
      </label>
    </div>

    <div class="form-section">
      <label class="form-row">
        <span class="form-label">存放位置</span>
        <input
          v-model="form.storage_location"
          type="text"
          class="form-input"
          placeholder="如: 客厅药箱 / 冰箱上层"
          :disabled="props.disabled"
        />
      </label>
    </div>

    <div class="form-section">
      <label class="form-row">
        <span class="form-label">备注</span>
        <textarea
          v-model="form.remark"
          class="form-input"
          rows="2"
          placeholder="如: 每次 5ml, 6 小时一次 (可选)"
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
        {{ isEdit() ? '保存修改' : '添加药品' }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.medicine-form {
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

.qty-unit-group {
  display: flex;
  gap: 0.5rem;
}

.qty-input {
  flex: 0 0 7rem;
}

.unit-input {
  flex: 1 1 auto;
  min-width: 0;
}

textarea.form-input {
  resize: vertical;
  min-height: 3rem;
}

.form-hint {
  font-size: 0.78rem;
  color: #9ca3af;
}

.form-hint-error {
  color: #991b1b;
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

/* v3.4: 药品包装扫描区 */
.scan-section {
  padding: 0.75rem;
  background: #f9fafb;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: flex-start;
}

.scan-file-input {
  display: none;
}

.btn-scan {
  background: white;
  color: #1e40af;
  border: 1px solid #2563eb;
  padding: 0.55rem 1.2rem;
  align-self: stretch;
}

.btn-scan:hover:not(:disabled) {
  background: #eff6ff;
}

.scan-warning {
  margin: 0;
  padding: 0.4rem 0.6rem;
  background: #fffbeb;
  color: #92400e;
  border-radius: 4px;
  font-size: 0.82rem;
  align-self: stretch;
}

.link {
  color: #2563eb;
  text-decoration: none;
  font-weight: 500;
}

.link:hover {
  text-decoration: underline;
}
</style>
