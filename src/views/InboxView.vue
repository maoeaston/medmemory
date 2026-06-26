<script setup lang="ts">
// InboxView —— 待整理列表 + 批量归档
//
// PRD 7.1 archive path: 多选 inbox_items → 一个 medical_event
//
// 数据流:
//   listPending() → 渲染卡片列表（每卡 checkbox）
//   → 勾选 N 条 → 点"归档选中" → 打开 ArchiveForm modal
//   → 提交 → archiveInboxItems() 创建 event + 迁移 photo + archive inbox
//   → 成功: 关闭 modal + 刷新列表
//   → 部分失败: 保留 modal 打开, 显示失败详情, 用户可重试或取消
import { computed, onMounted, ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import { archiveInboxItems } from '@/composables/useInboxArchive';
import { useInboxCount } from '@/composables/useInboxCount';
import type {
  FamilyMember,
  InboxItem,
  MedicalEventCreateInput,
} from '@/repositories';
import ModalOverlay from '@/components/ui/ModalOverlay.vue';
import InboxItemCard from '@/components/inbox/InboxItemCard.vue';
import ArchiveForm from '@/components/inbox/ArchiveForm.vue';

// 列表数据
const items = ref<InboxItem[]>([]);
const members = ref<FamilyMember[]>([]);
const loadError = ref<string | null>(null);
const isLoading = ref(false);

// 角标同步: 每次列表刷新（mount + archive 后）顺带更新 Navbar 待整理数字
const { refresh: refreshInboxCount } = useInboxCount();

// 选择状态: 用 Set<number> 存选中 id（避免 reactive 数组性能问题）
const selectedIds = ref<Set<number>>(new Set());

// 归档 modal 状态
const showArchiveModal = ref(false);
const isArchiving = ref(false);
const archiveErrorMessage = ref<string | null>(null);
// 上次归档的部分失败详情（成功后清空, 显示给用户看）
const partialFailures = ref<
  { itemId: number; captureType: string; error: string }[] | null
>(null);

const hasMembers = computed(() => members.value.length > 0);
const selectedCount = computed(() => selectedIds.value.size);
const allSelected = computed(
  () => items.value.length > 0 && selectedIds.value.size === items.value.length,
);

// 预填 summary: 从选中的 text 条目里拼接
const initialSummary = computed(() => {
  const texts = items.value
    .filter(
      (it) =>
        selectedIds.value.has(it.id) &&
        it.capture_type === 'text' &&
        it.text_content,
    )
    .map((it) => it.text_content as string);
  return texts.length > 0 ? texts.join('\n') : '';
});

async function loadInbox(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  try {
    const repos = await useRepositories();
    const [inboxResult, memberResult] = await Promise.allSettled([
      repos.inbox.listPending(),
      repos.familyMember.list(),
    ]);
    if (inboxResult.status === 'fulfilled') {
      items.value = inboxResult.value;
    } else {
      loadError.value =
        inboxResult.reason instanceof Error
          ? inboxResult.reason.message
          : String(inboxResult.reason);
    }
    if (memberResult.status === 'fulfilled') {
      members.value = memberResult.value;
    }
    // member 加载失败不阻塞列表展示, 仅归档按钮禁用
    selectedIds.value = new Set(); // 重置选择
    void refreshInboxCount(); // 同步 Navbar 角标
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

function toggleItem(id: number, checked: boolean): void {
  const next = new Set(selectedIds.value);
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  selectedIds.value = next;
}

function toggleAll(): void {
  if (allSelected.value) {
    selectedIds.value = new Set();
  } else {
    selectedIds.value = new Set(items.value.map((it) => it.id));
  }
}

function openArchiveModal(): void {
  if (selectedCount.value === 0) return;
  archiveErrorMessage.value = null;
  partialFailures.value = null;
  showArchiveModal.value = true;
}

function closeArchiveModal(): void {
  if (isArchiving.value) return;
  showArchiveModal.value = false;
  archiveErrorMessage.value = null;
  partialFailures.value = null;
}

async function handleArchiveSubmit(
  eventInput: MedicalEventCreateInput,
): Promise<void> {
  isArchiving.value = true;
  archiveErrorMessage.value = null;
  partialFailures.value = null;

  try {
    const repos = await useRepositories();
    const selectedItems = items.value.filter((it) =>
      selectedIds.value.has(it.id),
    );

    const result = await archiveInboxItems(repos, {
      items: selectedItems,
      eventInput,
    });

    if (result.failures.length === 0) {
      // 全部成功
      showArchiveModal.value = false;
      selectedIds.value = new Set();
      await loadInbox();
      // 简单 toast: 用 alert 过于打扰, 这里仅 console
      console.log(
        `[Inbox] 归档完成: event #${result.eventId}, ${result.successCount} 条`,
      );
    } else {
      // 部分失败: 保留 modal 打开, 展示失败详情
      partialFailures.value = result.failures.map((f) => ({
        itemId: f.item.id,
        captureType: f.item.capture_type,
        error: f.error,
      }));
      // 刷新列表让已成功的从 pending 移除
      await loadInbox();
      // 如果全部都失败了, 保留 event 创建错误提示
      if (result.successCount === 0) {
        archiveErrorMessage.value = `事件 #${result.eventId} 已创建, 但所有条目归档失败（见下方详情）`;
      }
    }
  } catch (e) {
    // event 创建本身失败
    archiveErrorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    isArchiving.value = false;
  }
}

onMounted(() => {
  void loadInbox();
});
</script>

<template>
  <main class="inbox-view">
    <header class="page-header">
      <div class="header-info">
        <h1 class="page-title">待整理</h1>
        <span class="count-badge">{{ items.length }}</span>
      </div>
      <div class="header-actions" v-if="items.length > 0">
        <button
          type="button"
          class="btn btn-secondary btn-small"
          @click="toggleAll"
        >
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
        <button
          type="button"
          class="btn btn-primary btn-small"
          :disabled="selectedCount === 0 || !hasMembers"
          :title="!hasMembers ? '请先到成员管理添加成员' : ''"
          @click="openArchiveModal"
        >
          归档选中{{ selectedCount > 0 ? ` (${selectedCount})` : '' }}
        </button>
      </div>
    </header>

    <p v-if="loadError" class="msg msg-error">加载失败: {{ loadError }}</p>
    <p v-else-if="isLoading" class="hint">加载中...</p>

    <div
      v-else-if="items.length === 0"
      class="empty-state"
    >
      <p class="empty-title">待整理已清空</p>
      <p class="empty-hint">
        所有捕获都已归档。到
        <RouterLink to="/capture" class="link">快速记录</RouterLink>
        录入新条目。
      </p>
    </div>

    <ul v-else class="item-list">
      <li v-for="item in items" :key="item.id">
        <InboxItemCard
          :item="item"
          :checked="selectedIds.has(item.id)"
          @update:checked="(checked) => toggleItem(item.id, checked)"
        />
      </li>
    </ul>

    <!-- 归档 modal -->
    <ModalOverlay
      v-if="showArchiveModal"
      :title="`归档 ${selectedCount} 条记录为医疗事件`"
      width="md"
      @close="closeArchiveModal"
    >
      <ArchiveForm
        :members="members"
        :initial-summary="initialSummary"
        :selected-count="selectedCount"
        :disabled="isArchiving"
        :error-message="archiveErrorMessage"
        @submit="handleArchiveSubmit"
        @cancel="closeArchiveModal"
      />

      <!-- 部分失败详情 -->
      <div v-if="partialFailures && partialFailures.length > 0" class="failures">
        <h3 class="failures-title">
          {{ partialFailures.length }} 条归档失败:
        </h3>
        <ul class="failures-list">
          <li
            v-for="f in partialFailures"
            :key="f.itemId"
            class="failures-item"
          >
            #{{ f.itemId }} ({{ f.captureType }}): {{ f.error }}
          </li>
        </ul>
        <p class="failures-hint">
          失败的条目仍在待整理列表, 可重新勾选后再次归档。
        </p>
      </div>
    </ModalOverlay>
  </main>
</template>

<style scoped>
.inbox-view {
  padding: 1.5rem;
  max-width: var(--space-page-max-width);
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.page-title {
  margin: 0;
  font-size: var(--font-size-page-title);
}

.count-badge {
  display: inline-block;
  padding: 0.2rem 0.6rem;
  background: #fef3c7;
  color: var(--color-warning-text);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-meta);
  font-weight: var(--font-weight-semibold);
  min-width: 1.6rem;
  text-align: center;
}

.header-actions {
  display: flex;
  gap: 0.5rem;
}

.hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  background: var(--color-success-light);
  border-radius: var(--radius-card);
  color: var(--color-success);
}

.empty-title {
  margin: 0 0 0.4rem;
  font-size: var(--font-size-section-title);
  font-weight: var(--font-weight-semibold);
}

.empty-hint {
  margin: 0;
  font-size: var(--font-size-body);
  color: #047857;
}

.link {
  color: var(--color-primary);
  text-decoration: none;
  font-weight: var(--font-weight-medium);
}

.link:hover {
  text-decoration: underline;
}

.item-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.msg {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius-badge);
  font-size: var(--font-size-body);
}

.msg-error {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}

.failures {
  margin-top: 1rem;
  padding: 0.75rem;
  background: var(--color-danger-light);
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-badge);
}

.failures-title {
  margin: 0 0 0.4rem;
  font-size: var(--font-size-input);
  color: var(--color-danger-text);
}

.failures-list {
  list-style: none;
  padding: 0;
  margin: 0 0 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.failures-item {
  font-size: var(--font-size-meta);
  color: #7f1d1d;
  font-family: monospace;
}

.failures-hint {
  margin: 0;
  font-size: var(--font-size-meta);
  color: var(--color-danger-text);
}
</style>
