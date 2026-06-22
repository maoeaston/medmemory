<script setup lang="ts">
// DashboardHeader —— Dashboard 顶部
//   - 标题: "家庭医疗档案"
//   - 待整理徽章（可点跳 /inbox）
//   - "+ 快速记录" CTA（跳 /capture）
//
// 不直接查数据: pendingCount 由 DashboardView 加载后通过 prop 传入
// 这样 Header 不做 IO, 可独立测试
import { RouterLink } from 'vue-router';

defineProps<{
  pendingCount: number | null;
}>();
</script>

<template>
  <header class="dashboard-header">
    <div class="header-left">
      <h1 class="header-title">家庭医疗档案</h1>
      <RouterLink
        v-if="pendingCount !== null && pendingCount > 0"
        to="/inbox"
        class="pending-badge"
      >
        📥 {{ pendingCount }} 待整理
      </RouterLink>
      <span
        v-else-if="pendingCount === 0"
        class="pending-zero"
      >
        待整理已清空
      </span>
    </div>
    <RouterLink to="/capture" class="cta-btn">
      + 快速记录
    </RouterLink>
  </header>
</template>

<style scoped>
.dashboard-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.25rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.header-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  color: #1f2937;
}

.pending-badge {
  display: inline-block;
  padding: 0.3rem 0.7rem;
  background: #fef3c7;
  color: #92400e;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 600;
  text-decoration: none;
  border: 1px solid #fcd34d;
  transition: background 0.15s;
}

.pending-badge:hover {
  background: #fde68a;
}

.pending-zero {
  display: inline-block;
  padding: 0.3rem 0.7rem;
  background: #ecfdf5;
  color: #065f46;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 500;
  border: 1px solid #a7f3d0;
}

.cta-btn {
  padding: 0.6rem 1.2rem;
  background: #2563eb;
  color: white;
  text-decoration: none;
  border-radius: 6px;
  font-weight: 600;
  font-size: 0.92rem;
  transition: background 0.15s;
  white-space: nowrap;
}

.cta-btn:hover {
  background: #1d4ed8;
}
</style>
