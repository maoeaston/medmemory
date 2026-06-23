// ============================================================
// MedMemory -- 同步配置 composable
// ============================================================
// 存储同步所需的 4 项配置:
//   - serverUrl:   服务器地址 (如 https://maohedong.top)
//   - token:       共享密钥 (X-Sync-Token)
//   - clientId:    设备 UUID (首次生成, 永久)
//   - clientLabel: 设备标签 (用户填写, 如 "爸爸的手机")
//
// 存储: localStorage, key 按命名空间 medmemory:sync:{field}
// 模式参考 useAiConfig.ts: 模块级单例, 多次 useSyncConfig() 共享同一份 state.
// ============================================================

import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue';

// ============================================================
// localStorage keys
// ============================================================

const LS_SERVER_URL = 'medmemory:sync:serverUrl';
const LS_TOKEN = 'medmemory:sync:token';
const LS_CLIENT_ID = 'medmemory:sync:clientId';
const LS_CLIENT_LABEL = 'medmemory:sync:clientLabel';

// ============================================================
// 模块级单例 state
// ============================================================

const serverUrl = ref<string>(loadStr(LS_SERVER_URL));
const token = ref<string>(loadStr(LS_TOKEN));
const clientId = ref<string>(loadOrCreateClientId());
const clientLabel = ref<string>(loadStr(LS_CLIENT_LABEL));

const isConfigured: ComputedRef<boolean> = computed(
  () => serverUrl.value !== '' && token.value !== '' && clientLabel.value !== '',
);

// ============================================================
// 辅助
// ============================================================

function loadStr(key: string): string {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? v.trim() : '';
  } catch {
    return '';
  }
}

function persistStr(key: string, value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(key, trimmed);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage 不可用: 仅内存更新
  }
}

function loadOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(LS_CLIENT_ID);
    if (existing && existing.trim()) return existing.trim();
  } catch {
    // proceed to create
  }
  // 首次启动: 生成 UUID 并持久化
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(LS_CLIENT_ID, id);
  } catch {
    // localStorage 不可用: 仅内存有效, 下次重新生成
  }
  return id;
}

// ============================================================
// 公开 API
// ============================================================

export function useSyncConfig(): {
  serverUrl: Readonly<Ref<string>>;
  token: Readonly<Ref<string>>;
  clientId: Readonly<Ref<string>>;
  clientLabel: Readonly<Ref<string>>;
  isConfigured: ComputedRef<boolean>;
  saveServerUrl: (url: string) => void;
  saveToken: (t: string) => void;
  saveClientLabel: (label: string) => void;
} {
  function saveServerUrl(url: string): void {
    const trimmed = url.trim();
    serverUrl.value = trimmed;
    persistStr(LS_SERVER_URL, trimmed);
  }

  function saveToken(t: string): void {
    const trimmed = t.trim();
    token.value = trimmed;
    persistStr(LS_TOKEN, trimmed);
  }

  function saveClientLabel(label: string): void {
    const trimmed = label.trim().slice(0, 20);
    clientLabel.value = trimmed;
    persistStr(LS_CLIENT_LABEL, trimmed);
  }

  return {
    serverUrl: readonly(serverUrl),
    token: readonly(token),
    clientId: readonly(clientId),
    clientLabel: readonly(clientLabel),
    isConfigured,
    saveServerUrl,
    saveToken,
    saveClientLabel,
  };
}
