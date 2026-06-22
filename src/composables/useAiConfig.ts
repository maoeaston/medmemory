// ============================================================
// MedMemory — AI 配置 composable (API key + baseUrl + model)
// ============================================================
// 对应 PRD: 自用场景, 用户在 Settings 页输入 API 配置
//
// 三项配置:
//   - apiKey:  必填, bearer token
//   - baseUrl: 必填, OpenAI 兼容端点（用户自填, 如 https://api.openai.com/v1
//              或 https://ccapi.us/v1 等中转站, 后续可随时切换）
//   - model:   必填, 调用的模型名（如 gpt-4o / gpt-5.5 / deepseek-chat 等）
//
// 存储:
//   - localStorage 主存 (medmemory:aiApiKey / aiBaseUrl / aiModel)
//   - .env.local VITE_OPENAI_* 作为初始默认（开发时方便）
//   - 三项初始值都允许为空串（强制用户首次进入 Settings 主动填）
//
// 单例:
//   - 模块级 reactive state, 多次 useAiConfig() 共享同一份
//   - saveXxx() 同步更新 reactive + localStorage
//
// 安全提示:
//   - PWA 是纯前端, localStorage 和 bundle 中的 env 都是明文
//   - PRD line 65 已接受（自用场景）
//   - 不做加密（加密 key 还得存在某处, 意义有限）
// ============================================================

import { computed, readonly, ref } from 'vue';

const API_KEY_STORAGE = 'medmemory:aiApiKey';
const BASE_URL_STORAGE = 'medmemory:aiBaseUrl';
const MODEL_STORAGE = 'medmemory:aiModel';

/**
 * 模块级单例 state。首次 import 初始化, 全 app 共享。
 * 初始化放在模块顶层（而非 lazy）: Settings 页和 useAiProcess 都要同步读,
 * lazy 会引入 await, 让所有调用点变 async, 不划算。
 */
const apiKeyRef = ref<string>(loadFromStorage(API_KEY_STORAGE, 'VITE_OPENAI_API_KEY'));
const baseUrlRef = ref<string>(loadFromStorage(BASE_URL_STORAGE, 'VITE_OPENAI_BASE_URL'));
const modelRef = ref<string>(loadFromStorage(MODEL_STORAGE, 'VITE_OPENAI_MODEL'));

/**
 * 从 localStorage 主读, fallback 到 import.meta.env[VITE_OPENAI_*]。
 */
function loadFromStorage(storageKey: string, envKey: string): string {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // localStorage 不可用（隐私模式 / disable）: 跳到 env fallback
  }
  const envVal = (import.meta.env as Record<string, unknown>)[envKey];
  if (typeof envVal === 'string' && envVal.trim()) return envVal.trim();
  return '';
}

function persist(storageKey: string, value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(storageKey, trimmed);
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch {
    // localStorage 不可用: 仅内存更新（用户当会话内有效）
    // 不抛错, 避免阻塞 Settings 页保存流程
  }
}

/**
 * 获取/更新 AI 配置的统一入口。
 *
 * 返回:
 *   - apiKey:  只读 Ref<string>（'' 表示未配置）
 *   - baseUrl: 只读 Ref<string>（'' 表示未配置, 调 provider 前必须校验）
 *   - model:   只读 Ref<string>（'' 表示未配置, 调 provider 前必须校验）
 *   - hasKey:  ComputedRef<boolean>（等价 apiKey.value !== ''）
 *   - saveApiKey(key) / saveBaseUrl(url) / saveModel(model)
 *
 * 用法:
 *   const { apiKey, baseUrl, model, hasKey, saveApiKey } = useAiConfig();
 *   if (!hasKey.value) alert('请先配置 API key');
 *   saveApiKey('sk-...');
 */
export function useAiConfig() {
  const hasKey = computed(() => apiKeyRef.value !== '');

  function saveApiKey(key: string): void {
    const trimmed = key.trim();
    apiKeyRef.value = trimmed;
    persist(API_KEY_STORAGE, trimmed);
  }

  function saveBaseUrl(url: string): void {
    const trimmed = url.trim();
    baseUrlRef.value = trimmed;
    persist(BASE_URL_STORAGE, trimmed);
  }

  function saveModel(model: string): void {
    const trimmed = model.trim();
    modelRef.value = trimmed;
    persist(MODEL_STORAGE, trimmed);
  }

  return {
    apiKey: readonly(apiKeyRef),
    baseUrl: readonly(baseUrlRef),
    model: readonly(modelRef),
    hasKey,
    saveApiKey,
    saveBaseUrl,
    saveModel,
  };
}
