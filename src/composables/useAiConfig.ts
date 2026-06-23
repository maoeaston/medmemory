// ============================================================
// MedMemory — AI 配置 composable (namespace 化)
// ============================================================
// 对应 PRD v3.2 §8 决策点 #5: OpenAI 兼容单一 provider, 不同 namespace
// 切换不同中转站/模型（OCR 用一套, 健康助手用另一套）。
//
// Namespace:
//   - 'ocr':          图片 OCR + 化验单结构化（MEDICAL_DOCUMENT_PROMPT）
//   - 'health-agent': v3.2 化验单解读 + 用药指南（LAB_INTERPRETATION_PROMPT / MEDICATION_GUIDE_PROMPT）
//
// 三项配置 per namespace:
//   - apiKey:  必填, bearer token
//   - baseUrl: 必填, OpenAI 兼容端点（用户自填, 可随时切换）
//   - model:   必填, 调用的模型名（如 gpt-4o / gpt-5.5 / deepseek-chat 等）
//
// 存储:
//   - localStorage 主存, key 按命名空间分组:
//     medmemory:ai:ocr:apiKey / baseUrl / model
//     medmemory:ai:health-agent:apiKey / baseUrl / model
//   - .env.local VITE_OPENAI_* 仅作为 ocr namespace 的初始默认（开发时方便）
//   - 三项初始值都允许为空串（强制用户首次进入 Settings 主动填）
//
// 单例:
//   - 模块级 Map<namespace, ConfigState>, 多次 useAiConfig(ns) 共享同一份
//   - saveXxx() 同步更新 reactive + localStorage
//
// 安全提示:
//   - PWA 是纯前端, localStorage 和 bundle 中的 env 都是明文
//   - PRD line 65 已接受（自用场景）, 不做加密
// ============================================================

import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue';

export type AiConfigNamespace = 'ocr' | 'health-agent';

interface ConfigState {
  apiKey: Ref<string>;
  baseUrl: Ref<string>;
  model: Ref<string>;
  hasKey: ComputedRef<boolean>;
}

/**
 * 模块级 Map 缓存: 每个 namespace 一份独立 state。
 * 首次 useAiConfig(ns) 时初始化, 后续复用同一份 refs。
 */
const stateCache = new Map<AiConfigNamespace, ConfigState>();

/**
 * namespace → storage key 前缀映射。
 */
function storageKey(ns: AiConfigNamespace, field: 'apiKey' | 'baseUrl' | 'model'): string {
  return `medmemory:ai:${ns}:${field}`;
}

/**
 * 从 localStorage 主读。
 * 仅 ocr namespace fallback 到 import.meta.env[VITE_OPENAI_*]（历史开发默认）。
 * health-agent 无 env fallback（必须用户主动填）。
 */
function loadFromStorage(
  ns: AiConfigNamespace,
  field: 'apiKey' | 'baseUrl' | 'model',
): string {
  const key = storageKey(ns, field);
  try {
    const stored = localStorage.getItem(key);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // localStorage 不可用（隐私模式）: 跳到 env fallback
  }
  if (ns === 'ocr') {
    const envKey = `VITE_OPENAI_${field === 'apiKey' ? 'API_KEY' : field === 'baseUrl' ? 'BASE_URL' : 'MODEL'}`;
    const envVal = (import.meta.env as Record<string, unknown>)[envKey];
    if (typeof envVal === 'string' && envVal.trim()) return envVal.trim();
  }
  return '';
}

function persist(
  ns: AiConfigNamespace,
  field: 'apiKey' | 'baseUrl' | 'model',
  value: string,
): void {
  const key = storageKey(ns, field);
  try {
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(key, trimmed);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage 不可用: 仅内存更新（用户当会话内有效）
  }
}

/**
 * 懒初始化某 namespace 的 state（首次调用时）。
 */
function getState(ns: AiConfigNamespace): ConfigState {
  let state = stateCache.get(ns);
  if (state) return state;

  const apiKey = ref<string>(loadFromStorage(ns, 'apiKey'));
  const baseUrl = ref<string>(loadFromStorage(ns, 'baseUrl'));
  const model = ref<string>(loadFromStorage(ns, 'model'));
  const hasKey = computed(() => apiKey.value !== '');
  state = { apiKey, baseUrl, model, hasKey };
  stateCache.set(ns, state);
  return state;
}

/**
 * 获取/更新 AI 配置的统一入口（namespace 化）。
 *
 * 参数:
 *   - namespace: 'ocr'（默认）或 'health-agent', 决定使用哪套配置 + localStorage key
 *
 * 返回:
 *   - apiKey:  只读 Ref<string>（'' 表示未配置）
 *   - baseUrl: 只读 Ref<string>（'' 表示未配置）
 *   - model:   只读 Ref<string>（'' 表示未配置）
 *   - hasKey:  ComputedRef<boolean>（等价 apiKey.value !== ''）
 *   - saveApiKey(key) / saveBaseUrl(url) / saveModel(model)
 *
 * 用法:
 *   // OCR 主流程
 *   const { apiKey, hasKey } = useAiConfig('ocr');
 *
 *   // v3.2 健康助手
 *   const { apiKey, model, hasKey } = useAiConfig('health-agent');
 *   if (!hasKey.value) alert('请先配置健康助手 API key');
 */
export function useAiConfig(namespace: AiConfigNamespace = 'ocr') {
  const state = getState(namespace);

  function saveApiKey(key: string): void {
    const trimmed = key.trim();
    state.apiKey.value = trimmed;
    persist(namespace, 'apiKey', trimmed);
  }

  function saveBaseUrl(url: string): void {
    const trimmed = url.trim();
    state.baseUrl.value = trimmed;
    persist(namespace, 'baseUrl', trimmed);
  }

  function saveModel(model: string): void {
    const trimmed = model.trim();
    state.model.value = trimmed;
    persist(namespace, 'model', trimmed);
  }

  return {
    apiKey: readonly(state.apiKey),
    baseUrl: readonly(state.baseUrl),
    model: readonly(state.model),
    hasKey: state.hasKey,
    saveApiKey,
    saveBaseUrl,
    saveModel,
  };
}
