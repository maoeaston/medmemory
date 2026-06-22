<script setup lang="ts">
// MVP 骨架占位 —— Dashboard 完整 UI 见下次迭代
// 当前只提供一个跳转 Quick Capture 的入口（PRD 7.1: 比 "+ New Event" 更显眼）
</script>

<template>
  <main class="placeholder">
    <h1>家庭医疗记忆</h1>
    <p class="hint">Dashboard 建设中（下次迭代做成员卡片 + 最近事件 + 药箱预警）。</p>

    <RouterLink to="/capture" class="cta">+ 快速记录</RouterLink>
  </main>
</template>

<style scoped>
.placeholder {
  padding: 1.5rem;
  max-width: 640px;
  margin: 0 auto;
}
.hint {
  color: #888;
  margin: 1rem 0;
}
.cta {
  display: inline-block;
  padding: 0.8rem 1.5rem;
  background: #2563eb;
  color: white;
  text-decoration: none;
  border-radius: 6px;
  font-weight: 600;
}
.cta:hover {
  background: #1d4ed8;
}
</style>
