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
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem 1.25rem;
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
  font-size: 1.05rem;
  font-weight: 600;
}

.panel-link {
  font-size: 0.85rem;
  color: #2563eb;
  text-decoration: none;
}

.panel-link:hover {
  text-decoration: underline;
}

.hint {
  color: #9ca3af;
  font-size: 0.88rem;
}

.ok-state {
  color: #065f46;
  font-size: 0.9rem;
  padding: 0.5rem 0.7rem;
  background: #ecfdf5;
  border-radius: 4px;
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
  font-weight: 600;
}

.group-expired .group-count {
  color: #991b1b;
}

.group-soon .group-count {
  color: #92400e;
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
  background: #f9fafb;
  border-radius: 4px;
  font-size: 0.85rem;
}

.group-expired .med-item {
  background: #fef2f2;
}

.group-soon .med-item {
  background: #fffbeb;
}

.med-name {
  color: #1f2937;
  font-weight: 500;
}

.med-expiry {
  color: #6b7280;
  font-size: 0.8rem;
  white-space: nowrap;
}

.msg {
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: 4px;
  font-size: 0.88rem;
}

.msg-error {
  background: #fef2f2;
  color: #991b1b;
}
</style>
