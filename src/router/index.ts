// ============================================================
// MedMemory — Vue Router 路由表
// ============================================================
// 路由设计:
//   - / 重定向到 /dashboard（首屏入口）
//   - /capture 独立路由（PRD 7.1 Quick Capture, MVP 最高优先级）
//   - 其他 8 个功能模块各占一个路由, 大部分为占位（下次迭代）
//
// 历史模式: history（非 hash）, 美观 + PWA 友好
// dev 模式 vite 自动 fallback 到 index.html
// ============================================================

import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
    },
    {
      path: '/capture',
      name: 'capture',
      component: () => import('@/views/CaptureView.vue'),
    },
    {
      path: '/inbox',
      name: 'inbox',
      component: () => import('@/views/InboxView.vue'),
    },
    {
      path: '/members',
      name: 'members',
      component: () => import('@/views/MembersView.vue'),
    },
    {
      path: '/events',
      name: 'events',
      component: () => import('@/views/EventsView.vue'),
    },
    {
      path: '/events/:id',
      name: 'event-detail',
      component: () => import('@/views/EventDetailView.vue'),
      props: (route) => ({ id: Number(route.params.id) }),
    },
    {
      path: '/timeline',
      name: 'timeline',
      component: () => import('@/views/TimelineView.vue'),
    },
    {
      path: '/trends',
      name: 'trends',
      component: () => import('@/views/TrendsView.vue'),
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('@/views/SearchView.vue'),
    },
    {
      path: '/medicines',
      name: 'medicines',
      component: () => import('@/views/MedicinesView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
  ],
});

export default router;
