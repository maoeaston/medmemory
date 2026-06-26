<script setup lang="ts">
// PageContainer — 统一的页面外壳, 替代 12 个 view 各自 <main class="xxx-view"> + 硬编码 padding。
//
// 三种宽度对齐 tokens.css 已有定义:
//   - standard (720px): InboxView / MembersView / MedicinesView / SearchView / 等
//   - wide (920px):     DashboardView / TrendsView / GrowthView (网格/图表)
//   - narrow (640px):   CaptureView (单任务聚焦)
//
// 移动端 (≤1023px) 用 --space-page-padding-mobile: 1rem 取代桌面 1.5rem
defineProps<{ maxWidth?: 'standard' | 'wide' | 'narrow' }>();
</script>

<template>
  <main class="page" :class="`page-${maxWidth ?? 'standard'}`"><slot /></main>
</template>

<style scoped>
.page {
  padding: var(--space-page-padding);
  margin: 0 auto;
}

.page-standard {
  max-width: var(--space-page-max-width);
}

.page-wide {
  max-width: var(--space-page-max-wide);
}

.page-narrow {
  max-width: var(--space-page-max-narrow);
}

@media (max-width: 1023px) {
  .page {
    padding: var(--space-page-padding-mobile);
  }
}
</style>
