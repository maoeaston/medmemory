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
//
// meta.depth (Phase 4): 用于 useRouteDirection 判断 slide-forward / slide-back / fade
//   0 = 主导航 (底部 tab 5 个)
//   1 = 二级页面 (抽屉 + 桌面顶 nav 的功能页)
//   2 = 详情页 (event detail)
// ============================================================

import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { depth: 0 },
  },
  {
    path: '/capture',
    name: 'capture',
    component: () => import('@/views/CaptureView.vue'),
    meta: { depth: 0 },
  },
  {
    path: '/inbox',
    name: 'inbox',
    component: () => import('@/views/InboxView.vue'),
    meta: { depth: 0 },
  },
  {
    path: '/medicines',
    name: 'medicines',
    component: () => import('@/views/MedicinesView.vue'),
    meta: { depth: 0 },
  },
  {
    path: '/members',
    name: 'members',
    component: () => import('@/views/MembersView.vue'),
    meta: { depth: 1 },
  },
  {
    path: '/events',
    name: 'events',
    component: () => import('@/views/EventsView.vue'),
    meta: { depth: 1 },
  },
  {
    path: '/events/:id',
    name: 'event-detail',
    component: () => import('@/views/EventDetailView.vue'),
    props: (route) => ({ id: Number(route.params.id) }),
    meta: { depth: 2 },
  },
  {
    path: '/timeline',
    name: 'timeline',
    component: () => import('@/views/TimelineView.vue'),
    meta: { depth: 1 },
  },
  {
    path: '/trends',
    name: 'trends',
    component: () => import('@/views/TrendsView.vue'),
    meta: { depth: 1 },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
    meta: { depth: 1 },
  },
  {
    path: '/growth',
    name: 'growth',
    component: () => import('@/views/GrowthView.vue'),
    meta: { depth: 1 },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { depth: 1 },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
