<script setup lang="ts">
// MedMemory 根组件 — 仅承载全局重置 + 渲染 AppShell
//
// 所有 App shell 逻辑 (header / nav / tab bar / drawer / sync / inbox badge)
// 已下沉到 src/components/layout/AppShell.vue (移动 APP 化重构)
import AppShell from '@/components/layout/AppShell.vue';
</script>

<template>
  <AppShell />
</template>

<style>
/* 全局重置 + 基础排版 */
*,
*::before,
*::after {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  padding: 0;
  font-family: var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-page);
}
</style>
