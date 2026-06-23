<script setup lang="ts">
// MedicineWarningPanel —— 药箱过期预警
// PRD 7.2 / 7.10:
//   - 即将过期（30 天内）: 黄色提示 + 数量
//   - 已过期: 红色提示 + 数量
//   - 点击跳 /medicines 查详情
//
// 接受 props.medicines 为父组件已查好的 listExpiring(30) 结果
// 本组件不做 IO, 只做分类展示, 保持职责单一
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { Medicine } from '@/repositories';

const props = defineProps<{
  medicines: Medicine[] | null;
  loadError?: string | null;
}>();

interface Grouped {
  expiringSoon: Medicine[]; // 未过期, 30 天内到期
  expired: Medicine[]; // 已过期
}

const today = computed(() => new Date().toISOString().slice(0, 7)); // YYYY-MM

const grouped = computed<Grouped>(() => {
  const result: Grouped = { expiringSoon: [], expired: [] };
  if (props.medicines === null) return result;
  const nowMonth = today.value;
  for (const m of props.medicines) {
    if (!m.expiry_date) continue; // 无过期日期的不计入
    if (m.expiry_date < nowMonth) {
      result.expired.push(m);
    } else {
      result.expiringSoon.push(m);
    }
  }
  // 按到期日升序
  result.expiringSoon.sort((a, b) =>
    (a.expiry_date ?? '').localeCompare(b.expiry_date ?? ''),
  );
  result.expired.sort((a, b) =>
    (a.expiry_date ?? '').localeCompare(b.expiry_date ?? ''),
  );
  return result;
});

const totalCount = computed(
  () => grouped.value.expiringSoon.length + grouped.value.expired.length,
);
</script>

<template>
  <section class="medicine-panel">
    <header class="panel-header">
      <h2 class="panel-title">💊 药箱预警</h2>
      <RouterLink to="/medicines" class="panel-link">查看全部</RouterLink>
    </header>

    <div v-if="loadError" class="msg msg-error">
      加载失败: {{ loadError }}
    </div>

    <div v-else-if="props.medicines === null" class="hint">加载中...</div>

    <div v-else-if="totalCount === 0" class="ok-state">
      ✓ 暂无过期预警
    </div>

    <div v-else class="groups">
      <div v-if="grouped.expired.length > 0" class="group group-expired">
        <div class="group-header">
          <span class="group-count">🔴 已过期 {{ grouped.expired.length }}</span>
        </div>
        <ul class="med-list">
          <li v-for="m in grouped.expired" :key="m.id" class="med-item">
            <span class="med-name">{{ m.name }}</span>
            <span class="med-expiry">到期 {{ m.expiry_date }}</span>
          </li>
        </ul>
      </div>

      <div v-if="grouped.expiringSoon.length > 0" class="group group-soon">
        <div class="group-header">
          <span class="group-count">
            ⚠️ 即将过期 {{ grouped.expiringSoon.length }}
          </span>
        </div>
        <ul class="med-list">
          <li v-for="m in grouped.expiringSoon" :key="m.id" class="med-item">
            <span class="med-name">{{ m.name }}</span>
            <span class="med-expiry">到期 {{ m.expiry_date }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.medicine-panel {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: var(--space-card-padding);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.panel-title {
  margin: 0;
  font-size: var(--font-size-panel-title);
  font-weight: var(--font-weight-semibold);
}

.panel-link {
  font-size: var(--font-size-small);
  color: var(--color-primary);
  text-decoration: none;
}

.panel-link:hover {
  text-decoration: underline;
}

.hint {
  color: var(--color-text-faint);
  font-size: 0.88rem;
}

.ok-state {
  color: var(--color-success);
  font-size: var(--font-size-body);
  padding: 0.5rem 0.7rem;
  background: var(--color-success-light);
  border-radius: var(--radius-badge);
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.group-header {
  margin-bottom: 0.4rem;
}

.group-count {
  font-size: 0.88rem;
  font-weight: var(--font-weight-semibold);
}

.group-expired .group-count {
  color: var(--color-danger-text);
}

.group-soon .group-count {
  color: var(--color-warning-text);
}

.med-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.med-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  background: var(--color-bg-page);
  border-radius: var(--radius-badge);
  font-size: var(--font-size-small);
}

.group-expired .med-item {
  background: var(--color-danger-light);
}

.group-soon .med-item {
  background: var(--color-warning-light);
}

.med-name {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
}

.med-expiry {
  color: var(--color-text-muted);
  font-size: 0.8rem;
  white-space: nowrap;
}

.msg {
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-badge);
  font-size: 0.88rem;
}

.msg-error {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}
</style>
