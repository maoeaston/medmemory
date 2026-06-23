// ============================================================
// MedMemory -- 同步主体 composable (useSync)
// ============================================================
// 对应 docs/sync-design.md §9 + 评审报告修订.
//
// 核心职责:
//   1. initOnAppStart: 冷启动检测状态, 决定 idle/editing/locked-by-other
//   2. checkout: 拉服务器快照 + 获锁 → 进入 editing
//   3. checkin: 导出本地 → 上传 → 释放锁 → 回到 idle
//   4. heartbeat: editing 期间每 10min 续期锁
//   5. 轮询: locked-by-other 时每 30s 检查锁是否释放
//   6. beforeunload: 仅弹提示, 不做网络请求 (评审 S4 结论)
//
// 模块级单例: 所有 useSync() 共享同一份 reactive state.
// ============================================================

import { readonly, ref } from 'vue';
import { exportAllData, importAllData } from '@/composables/useDataBackup';
import { useSyncConfig } from '@/composables/useSyncConfig';

// ============================================================
// 类型定义 (§9.1)
// ============================================================

export type SyncState =
  | 'idle'
  | 'pulling'
  | 'pushing'
  | 'editing'
  | 'locked-by-other'
  | 'offline'
  | 'error';

export interface SyncError {
  kind: 'auth' | 'version-conflict' | 'network' | 'server';
  message: string;
  details?: Record<string, unknown>;
}

export interface LockHolder {
  clientId: string;
  clientLabel: string;
}

// ============================================================
// 常量 (附录 D)
// ============================================================

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟
const POLL_INTERVAL_MS = 30 * 1000; // 30 秒
const HEARTBEAT_FAIL_THRESHOLD = 2; // 连续 2 次失败进 error
const CHECKIN_RETRY_COUNT = 3;
const CHECKIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟, 大 zip 上传
const DEFAULT_TIMEOUT_MS = 30 * 1000; // 30s 常规请求
const CHECKOUT_TIMEOUT_MS = 2 * 60 * 1000; // 2 分钟, 大 zip 下载
const OPFS_BACKUP_FILENAME = 'pre-checkout-backup.zip';
const LS_LAST_SYNC_AT = 'medmemory:sync:lastSyncAt';

// ============================================================
// 模块级 reactive state (单例)
// ============================================================

const syncState = ref<SyncState>('idle');
const syncError = ref<SyncError | null>(null);
const serverVersion = ref<number | null>(null);
const lockHolder = ref<LockHolder | null>(null);
const lastSyncAt = ref<Date | null>(loadLastSyncAt());
const lockExpiresAt = ref<Date | null>(null);
const heartbeatFailedCount = ref<number>(0);

// ============================================================
// 模块级 timer / flag
// ============================================================

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let isInitialized = false;

// ============================================================
// 辅助: load/persist lastSyncAt
// ============================================================

function loadLastSyncAt(): Date | null {
  try {
    const v = localStorage.getItem(LS_LAST_SYNC_AT);
    if (v) return new Date(v);
  } catch {
    // pass
  }
  return null;
}

function persistLastSyncAt(date: Date): void {
  try {
    localStorage.setItem(LS_LAST_SYNC_AT, date.toISOString());
  } catch {
    // pass
  }
}

// ============================================================
// fetch helper
// ============================================================

async function syncFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const { serverUrl, token } = useSyncConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = serverUrl.value.replace(/\/$/, '') + path;
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'X-Sync-Token': token.value,
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 错误分类辅助
// ============================================================

async function parseServerSyncError(
  res: Response,
  fallbackKind: SyncError['kind'] = 'server',
): Promise<SyncError> {
  let code: string | undefined;
  let message: string | undefined;
  let details: Record<string, unknown> | undefined;
  try {
    const body = await res.json();
    const errObj = body?.error;
    if (errObj && typeof errObj === 'object') {
      code = typeof errObj.code === 'string' ? errObj.code : undefined;
      message = typeof errObj.message === 'string' ? errObj.message : undefined;
      details = errObj.details as Record<string, unknown> | undefined;
    }
  } catch {
    // JSON parse failed; fall through to generic
  }

  if (res.status === 401) {
    return {
      kind: 'auth',
      message: message ?? '认证失败, 请检查同步密钥',
      details,
    };
  }

  if (code === 'VERSION_CONFLICT') {
    return {
      kind: 'version-conflict',
      message: message ?? '服务器版本已更新, 请重新拉取',
      details,
    };
  }

  if (code === 'LOCK_HELD_BY_OTHER' && details?.lockedBy) {
    const lb = details.lockedBy as { clientId: string; clientLabel: string };
    return {
      kind: 'server',
      message: message ?? `锁被 ${lb.clientLabel} 持有`,
      details,
    };
  }

  return {
    kind: fallbackKind,
    message: message ?? `服务器错误 ${res.status}`,
    details,
  };
}

function networkSyncError(e: unknown): SyncError {
  return {
    kind: 'network',
    message: e instanceof Error ? e.message : '网络请求失败',
  };
}

// ============================================================
// OPFS 备份 (评审 S2)
// ============================================================

async function backupLocalBeforeCheckout(): Promise<void> {
  // 仅当本地有 family_members 记录时才备份
  // 避免空库每次都备份
  const { useRepositories } = await import('@/composables/useRepositories');
  try {
    const repos = await useRepositories();
    const members = await repos.familyMember.list();
    if (members.length === 0) {
      return; // 空库不备份
    }
  } catch {
    // 检查失败不阻塞 checkout, 但记录不到本地数据状态
    return;
  }

  const result = await exportAllData();
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(OPFS_BACKUP_FILENAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(result.blob);
    await writable.close();
  } catch {
    // OPFS 写入失败不阻塞 checkout (已经内存里有 exportAllData 的数据)
    // 但 importAllData 失败后无法从 OPFS 恢复, 用户可手动导出
  }
}

// ============================================================
// checkout / checkin 内部实现
// ============================================================

async function downloadSnapshot(
  clientIdVal: string,
  clientLabelVal: string,
): Promise<{ zip: Blob; version: number; expiresAt: Date }> {
  const res = await syncFetch(
    '/api/sync/checkout',
    {
      method: 'POST',
      body: JSON.stringify({ clientId: clientIdVal, clientLabel: clientLabelVal }),
    },
    CHECKOUT_TIMEOUT_MS,
  );

  if (res.status === 409) {
    // LOCK_HELD_BY_OTHER
    const err = await parseServerSyncError(res);
    throw err;
  }

  if (res.status === 404) {
    // NO_SNAPSHOT -- 首次使用, 服务器无数据
    throw {
      kind: 'server' as const,
      message: '服务器还没有快照, 请先推送本地数据',
    } satisfies SyncError;
  }

  if (res.status === 401) {
    throw await parseServerSyncError(res);
  }

  if (!res.ok) {
    throw await parseServerSyncError(res);
  }

  const versionStr = res.headers.get('X-Sync-Version');
  const expiresAtStr = res.headers.get('X-Sync-Lock-Expires-At');
  if (versionStr === null || expiresAtStr === null) {
    throw {
      kind: 'server' as const,
      message: 'checkout 响应缺少必要的 header',
    } satisfies SyncError;
  }

  const version = Number(versionStr);
  const expiresAt = new Date(expiresAtStr);
  const zip = await res.blob();

  return { zip, version, expiresAt };
}

async function uploadZip(zipBlob: Blob, version: number): Promise<number> {
  const { clientId } = useSyncConfig();

  const form = new FormData();
  form.append('version', String(version));
  form.append('clientId', clientId.value);
  form.append('snapshot', zipBlob, 'snapshot.zip');

  const res = await syncFetch(
    '/api/sync/checkin',
    { method: 'POST', body: form },
    CHECKIN_TIMEOUT_MS,
  );

  if (!res.ok) {
    const err = await parseServerSyncError(res);
    throw err;
  }

  const body = await res.json();
  return body.version as number;
}

// ============================================================
// heartbeat 内部实现
// ============================================================

async function doHeartbeat(): Promise<{ expiresAt: Date; version: number }> {
  const { clientId } = useSyncConfig();
  const res = await syncFetch(
    '/api/sync/heartbeat',
    {
      method: 'POST',
      body: JSON.stringify({ clientId: clientId.value }),
    },
    DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw await parseServerSyncError(res);
  }

  const body = await res.json();
  return {
    expiresAt: new Date(body.expiresAt),
    version: body.version as number,
  };
}

// ============================================================
// 轮询内部实现
// ============================================================

interface ServerState {
  lockedBy: { clientId: string; clientLabel: string } | null;
  lockedAt: string | null;
  version: number;
  expiresAt: string | null;
  hasSnapshot: boolean;
  snapshotSize: number;
  serverTime: string;
}

async function fetchServerState(): Promise<ServerState> {
  const res = await syncFetch('/api/sync/state', { method: 'GET' }, DEFAULT_TIMEOUT_MS);

  if (res.status === 401) {
    throw await parseServerSyncError(res);
  }

  if (!res.ok) {
    throw await parseServerSyncError(res);
  }

  return (await res.json()) as ServerState;
}

// ============================================================
// heartbeat timer 管理
// ============================================================

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatFailedCount.value = 0;

  heartbeatTimer = setInterval(async () => {
    if (syncState.value !== 'editing') {
      stopHeartbeat();
      return;
    }

    try {
      const result = await doHeartbeat();
      heartbeatFailedCount.value = 0;
      lockExpiresAt.value = result.expiresAt;
      if (result.version !== serverVersion.value) {
        serverVersion.value = result.version;
      }
    } catch {
      heartbeatFailedCount.value++;

      if (heartbeatFailedCount.value === 1) {
        // 首次失败: 仅设置 error 信息但不切状态, 用户可继续编辑
        // (评审 M2: 弹非阻塞 toast -- 由 SyncIndicator 根据 heartbeatFailedCount 显示)
      }

      if (heartbeatFailedCount.value >= HEARTBEAT_FAIL_THRESHOLD) {
        // 连续 2 次失败: 进 error 状态
        syncError.value = {
          kind: 'network',
          message: 'heartbeat 连续失败, 编辑锁可能已被释放',
        };
        syncState.value = 'error';
        stopHeartbeat();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ============================================================
// poll timer 管理
// ============================================================

function startPolling(): void {
  stopPolling();

  pollTimer = setInterval(async () => {
    if (syncState.value !== 'locked-by-other') {
      stopPolling();
      return;
    }

    try {
      await pollState();
    } catch {
      // 轮询失败静默忽略, 下次重试
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ============================================================
// pollState: 轮询 /state, 检测锁释放
// ============================================================

async function pollState(): Promise<void> {
  const { clientId } = useSyncConfig();
  const state = await fetchServerState();

  serverVersion.value = state.version;

  if (state.lockedBy === null) {
    // 锁释放了
    lockHolder.value = null;
    lockExpiresAt.value = null;
    syncError.value = null;
    syncState.value = 'idle';
    stopPolling();
    return;
  }

  // 锁主信息更新
  lockHolder.value = state.lockedBy;
  lockExpiresAt.value = state.expiresAt ? new Date(state.expiresAt) : null;

  if (state.lockedBy.clientId === clientId.value) {
    // 异常恢复: 锁回到了自己 (可能对方 force-release 了)
    syncError.value = null;
    syncState.value = 'editing';
    stopPolling();
    startHeartbeat();
  }
}

// ============================================================
// 事件处理
// ============================================================

function handleOnline(): void {
  if (syncState.value === 'offline') {
    // 网络恢复, 重新检查状态
    syncState.value = 'idle';
    void initOnAppStart();
  }
}

function handleOffline(): void {
  if (syncState.value === 'editing') {
    // 编辑中离线: 不切状态, 用户可继续编辑, heartbeat 会失败
    return;
  }
  syncState.value = 'offline';
}

function handleBeforeUnload(e: BeforeUnloadEvent): void {
  // 评审 S4 结论: 仅弹提示, 不做网络请求
  if (syncState.value === 'editing' || syncState.value === 'pushing') {
    e.preventDefault();
    e.returnValue = '';
  }
}

// ============================================================
// dispose: 清理 listeners + timers
// ============================================================

function dispose(): void {
  stopHeartbeat();
  stopPolling();
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  isInitialized = false;
}

// ============================================================
// initOnAppStart: 冷启动决策流程 (§4.1)
// ============================================================

async function initOnAppStart(): Promise<void> {
  const { isConfigured: configured, clientId } = useSyncConfig();

  // 注册事件监听 (只注册一次)
  if (!isInitialized) {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeunload', handleBeforeUnload);
    isInitialized = true;
  }

  // 未配置 → idle
  if (!configured.value) {
    syncState.value = 'idle';
    return;
  }

  // navigator.onLine 检查
  if (!navigator.onLine) {
    syncState.value = 'offline';
    return;
  }

  // fetch /state
  let state: ServerState;
  try {
    state = await fetchServerState();
  } catch (e) {
    // 判断是否 auth 错误
    if (e instanceof Object && 'kind' in e) {
      const syncErr = e as SyncError;
      if (syncErr.kind === 'auth') {
        syncState.value = 'error';
        syncError.value = syncErr;
        return;
      }
    }
    // 网络错误
    syncState.value = 'offline';
    syncError.value = networkSyncError(e);
    return;
  }

  // 更新版本号
  serverVersion.value = state.version;

  if (state.lockedBy === null) {
    // 无人持锁
    lockHolder.value = null;
    lockExpiresAt.value = null;
    syncError.value = null;

    if (!state.hasSnapshot) {
      // 服务器无快照 → idle, 等用户首次推送
      syncState.value = 'idle';
      return;
    }

    // 有快照, 无锁 → idle
    // 首次同步检测由 SyncIndicator / InitialSyncDialog 处理
    syncState.value = 'idle';
    return;
  }

  // 有人持锁
  lockHolder.value = state.lockedBy;
  lockExpiresAt.value = state.expiresAt ? new Date(state.expiresAt) : null;

  if (state.lockedBy.clientId === clientId.value) {
    // 锁主是自己 (上次 checkout 未正常 checkin, 浏览器崩了)
    // 恢复 editing 状态
    syncState.value = 'editing';
    syncError.value = null;
    startHeartbeat();
    return;
  }

  // 锁主是别人
  syncState.value = 'locked-by-other';
  startPolling();
}

// ============================================================
// checkout: 用户主动拉取 + 获锁 (§4.2)
// ============================================================

async function checkout(): Promise<void> {
  const { clientId, clientLabel } = useSyncConfig();
  syncState.value = 'pulling';
  syncError.value = null;

  try {
    // 1. 下载快照 + 获锁
    const { zip, version, expiresAt } = await downloadSnapshot(
      clientId.value,
      clientLabel.value,
    );

    // 2. checkout 前备份本地数据到 OPFS (评审 S2)
    await backupLocalBeforeCheckout();

    // 3. 导入服务器数据到本地
    await importAllData(zip);

    // 4. 进入 editing 状态
    serverVersion.value = version;
    lockExpiresAt.value = expiresAt;
    lockHolder.value = { clientId: clientId.value, clientLabel: clientLabel.value };
    syncState.value = 'editing';

    // 5. 启动 heartbeat
    startHeartbeat();
  } catch (e) {
    if (e instanceof Object && 'kind' in e) {
      const syncErr = e as SyncError;
      syncError.value = syncErr;

      // LOCK_HELD_BY_OTHER → locked-by-other
      if (
        syncErr.details?.lockedBy ||
        syncErr.message.includes('锁被')
      ) {
        // 更新 lockHolder
        const lb = syncErr.details?.lockedBy as
          | { clientId: string; clientLabel: string }
          | undefined;
        if (lb) {
          lockHolder.value = lb;
        }
        syncState.value = 'locked-by-other';
        startPolling();
        return;
      }

      syncState.value = 'error';
    } else {
      // 网络错误
      syncError.value = networkSyncError(e);
      syncState.value = 'offline';
    }
  }
}

// ============================================================
// checkin: 导出 + 上传 + 释放锁 (§4.2)
// ============================================================

async function checkin(): Promise<void> {
  if (serverVersion.value === null) {
    syncError.value = { kind: 'server', message: '无法确定当前版本, 请重新 checkout' };
    syncState.value = 'error';
    return;
  }

  syncState.value = 'pushing';
  syncError.value = null;

  // 停止 heartbeat (checkin 成功后不再需要)
  stopHeartbeat();

  let lastError: SyncError | null = null;

  for (let attempt = 0; attempt < CHECKIN_RETRY_COUNT; attempt++) {
    try {
      // 1. 导出本地数据
      const exportResult = await exportAllData();

      // 2. 上传
      const newVersion = await uploadZip(exportResult.blob, serverVersion.value);

      // 3. 成功
      serverVersion.value = newVersion;
      lockHolder.value = null;
      lockExpiresAt.value = null;
      lastSyncAt.value = new Date();
      persistLastSyncAt(lastSyncAt.value);
      syncState.value = 'idle';
      return;
    } catch (e) {
      if (e instanceof Object && 'kind' in e) {
        const syncErr = e as SyncError;
        lastError = syncErr;

        // version-conflict / auth 不重试
        if (syncErr.kind === 'version-conflict' || syncErr.kind === 'auth') {
          break;
        }

        // server 错误: 退避后重试
        if (syncErr.kind === 'server' && attempt < CHECKIN_RETRY_COUNT - 1) {
          await sleep(Math.pow(2, attempt) * 1000); // 1s, 2s, 4s
          continue;
        }
        break;
      } else {
        // 网络错误: 退避后重试
        lastError = networkSyncError(e);
        if (attempt < CHECKIN_RETRY_COUNT - 1) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        break;
      }
    }
  }

  // 全部重试失败
  syncError.value = lastError;
  syncState.value = 'error';
}

// ============================================================
// forceReleaseLock: 强制释放锁 (§9.3)
// ============================================================

async function forceReleaseLock(): Promise<void> {
  const { clientId } = useSyncConfig();

  try {
    const res = await syncFetch(
      '/api/sync/lock',
      {
        method: 'DELETE',
        body: JSON.stringify({ clientId: clientId.value, force: true }),
      },
      DEFAULT_TIMEOUT_MS,
    );

    if (!res.ok) {
      throw await parseServerSyncError(res);
    }

    stopHeartbeat();
    stopPolling();
    lockHolder.value = null;
    lockExpiresAt.value = null;
    syncError.value = null;
    syncState.value = 'idle';
  } catch (e) {
    if (e instanceof Object && 'kind' in e) {
      syncError.value = e as SyncError;
    } else {
      syncError.value = networkSyncError(e);
    }
    syncState.value = 'error';
  }
}

// ============================================================
// testConnection: 设置页测试 (§9.3)
// ============================================================

async function testConnection(): Promise<{ ok: boolean; message: string }> {
  const { isConfigured: configured } = useSyncConfig();

  if (!configured.value) {
    return { ok: false, message: '请先填写服务器地址和密钥' };
  }

  try {
    const state = await fetchServerState();
    return {
      ok: true,
      message: `已连接, 服务器版本 ${state.version}, ${
        state.hasSnapshot ? `快照 ${formatBytes(state.snapshotSize)}` : '无快照'
      }${state.lockedBy ? `, ${state.lockedBy.clientLabel} 编辑中` : ', 锁空闲'}`,
    };
  } catch (e) {
    if (e instanceof Object && 'kind' in e) {
      const syncErr = e as SyncError;
      if (syncErr.kind === 'auth') {
        return { ok: false, message: '密钥错误' };
      }
      return { ok: false, message: syncErr.message };
    }
    return { ok: false, message: '无法连接服务器' };
  }
}

// ============================================================
// seed: 首次推送 (场景 A: 服务器空, 本地有数据)
// ============================================================

async function seed(): Promise<void> {
  const { clientId } = useSyncConfig();
  syncState.value = 'pushing';
  syncError.value = null;

  try {
    const exportResult = await exportAllData();

    const form = new FormData();
    form.append('clientId', clientId.value);
    form.append('snapshot', exportResult.blob, 'snapshot.zip');

    const res = await syncFetch(
      '/api/sync/seed',
      { method: 'POST', body: form },
      CHECKIN_TIMEOUT_MS,
    );

    if (!res.ok) {
      throw await parseServerSyncError(res);
    }

    const body = await res.json();
    serverVersion.value = body.version as number;
    lastSyncAt.value = new Date();
    persistLastSyncAt(lastSyncAt.value);
    syncState.value = 'idle';
  } catch (e) {
    if (e instanceof Object && 'kind' in e) {
      syncError.value = e as SyncError;
    } else {
      syncError.value = networkSyncError(e);
    }
    syncState.value = 'error';
  }
}

// ============================================================
// 辅助函数
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================
// useSync 公开 API
// ============================================================

export function useSync() {
  return {
    // reactive state
    syncState: readonly(syncState),
    syncError: readonly(syncError),
    serverVersion: readonly(serverVersion),
    lockHolder: readonly(lockHolder),
    lastSyncAt: readonly(lastSyncAt),
    lockExpiresAt: readonly(lockExpiresAt),
    heartbeatFailedCount: readonly(heartbeatFailedCount),

    // 生命周期
    initOnAppStart,

    // 操作
    checkout,
    checkin,
    forceReleaseLock,
    seed,
    testConnection,
    dispose,

    // 内部 (测试用)
    _heartbeat: doHeartbeat,
    _pollState: pollState,
  };
}
