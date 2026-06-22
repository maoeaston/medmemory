// ============================================================
// MedMemory — AI 配置 composable (API key 管理)
// ============================================================
// 对应 PRD: 自用场景, 用户在 Settings 页输入 OpenAI key
//
// 存储:
//   - localStorage 主存 ('medmemory:openaiApiKey')
//   - .env.local VITE_OPENAI_API_KEY 作为初始默认（开发时方便）
//   - loadKey(): localStorage 优先, 无则 fallback 到 env
//
// 单例:
//   - 模块级 reactive state, 多次 useAiConfig() 共享同一份
//   - saveKey() 同步更新 reactive + localStorage
//
// 安全提示:
//   - PWA 是纯前端, localStorage 和 bundle 中的 env 都是明文
//   - PRD line 65 已接受（自用场景）
//   - 不做加密（加密 key 还得存在某处, 意义有限）
// ============================================================

import { computed, readonly, ref } from 'vue';

const STORAGE_KEY = 'medmemory:openaiApiKey';

/**
 * 模块级单例 state。首次 import 初始化, 全 app 共享。
 * 初始化放在模块顶层（而非 lazy）: Settings 页和 useAiProcess 都要同步读 hasKey,
 * lazy 会引入 await, 让所有调用点变 async, 不划算。
 */
const apiKeyRef = ref<string>(loadKey());

function loadKey(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // localStorage 不可用（隐私模式 / disable）: 跳到 env fallback
  }
  const envKey = import.meta.env.VITE_OPENAI_API_KEY;
  if (typeof envKey === 'string' && envKey.trim()) return envKey.trim();
  return '';
}

/**
 * 获取/更新 OpenAI API key 的统一入口。
 *
 * 返回:
 *   - apiKey: 只读 Ref<string>（'' 表示未配置）
 *   - hasKey: ComputedRef<boolean>（等价 apiKey.value !== ''）
 *   - saveKey(key): 同步更新 reactive + localStorage
 *
 * 用法:
 *   const { apiKey, hasKey, saveKey } = useAiConfig();
 *   if (!hasKey.value) alert('请先配置 API key');
 *   saveKey('sk-...');
 */
export function useAiConfig() {
  const hasKey = computed(() => apiKeyRef.value !== '');

  function saveKey(key: string): void {
    const trimmed = key.trim();
    apiKeyRef.value = trimmed;
    try {
      if (trimmed) {
        localStorage.setItem(STORAGE_KEY, trimmed);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage 不可用: 仅内存更新（用户当会话内有效）
      // 不抛错, 避免阻塞 Settings 页保存流程
    }
  }

  return {
    apiKey: readonly(apiKeyRef),
    hasKey,
    saveKey,
  };
}
