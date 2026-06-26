<script setup lang="ts">
// CaptureView —— Quick Capture 容器（PRD 7.1）
//
// 顶部三段 segmented control 切换 photo / voice / text
// <KeepAlive> 保留未保存输入, 避免误切 tab 丢失
//
// MVP 当前实现:
//   - Text 完整可用（TextCapture.vue）
//   - Photo / Voice 建设中（后续 task 实现）, tab 显示但内容是占位
import { ref } from 'vue';
import PhotoCapture from '@/components/capture/PhotoCapture.vue';
import TextCapture from '@/components/capture/TextCapture.vue';
import VoiceCapture from '@/components/capture/VoiceCapture.vue';
import PageContainer from '@/components/layout/PageContainer.vue';

type CaptureTab = 'photo' | 'voice' | 'text';
const activeTab = ref<CaptureTab>('text');
const tabs: { id: CaptureTab; label: string; icon: string; available: boolean }[] = [
  { id: 'photo', label: '拍照', icon: '📷', available: true },
  { id: 'voice', label: '录音', icon: '🎤', available: true },
  { id: 'text', label: '文字', icon: '✍️', available: true },
];
</script>

<template>
  <PageContainer max-width="narrow" class="capture">
    <h1 class="title">快速记录</h1>
    <p class="hint">不要求填完整, 先抓拍下来。后续在"待整理"里归档成正式医疗事件。</p>

    <nav class="tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :class="['tab', { active: activeTab === tab.id, disabled: !tab.available }]"
        :disabled="!tab.available"
        @click="activeTab = tab.id"
      >
        <span class="tab-icon">{{ tab.icon }}</span>
        <span class="tab-label">{{ tab.label }}</span>
        <span v-if="!tab.available" class="tab-wip">建设中</span>
      </button>
    </nav>

    <div class="tab-panel">
      <KeepAlive>
        <PhotoCapture v-if="activeTab === 'photo'" />
        <VoiceCapture v-else-if="activeTab === 'voice'" />
        <TextCapture v-else-if="activeTab === 'text'" />
      </KeepAlive>
    </div>
  </PageContainer>
</template>

<style scoped>
/* .capture padding/max-width/margin 由 PageContainer 提供 */

.title {
  margin: 0 0 0.25rem;
  font-size: var(--font-size-page-title);
}

.hint {
  margin: 0 0 1.5rem;
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
}

.tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--color-border-default);
}

.tab {
  flex: 1;
  padding: 0.75rem 0.5rem;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  transition: color 0.15s, border-color 0.15s;
  position: relative;
}

.tab:hover:not(.disabled):not(.active) {
  color: var(--color-text-primary);
}

.tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: var(--font-weight-semibold);
}

.tab.disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.tab-icon {
  font-size: 1.4rem;
}

.tab-label {
  font-size: var(--font-size-body);
}

.tab-wip {
  font-size: 0.7rem;
  color: var(--color-text-faint);
  background: var(--color-bg-muted);
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  position: absolute;
  top: 0.3rem;
  right: 0.3rem;
}

.tab-panel {
  min-height: 200px;
}

.wip-panel {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--color-text-muted);
  background: var(--color-bg-page);
  border-radius: var(--radius-card);
}

.wip-hint {
  font-size: var(--font-size-small);
  margin-top: 0.5rem;
  color: var(--color-text-faint);
}
</style>
