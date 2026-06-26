<script setup lang="ts">
// DashboardView —— Dashboard 容器, 编排所有子组件
//
// 数据加载策略:
//   Promise.allSettled 并行加载 4 个数据源
//   任一失败不阻塞其他, 失败的子区域显示 error, 其他正常渲染
//
// 不用 KeepAlive: 每次进入 Dashboard 重新加载（路由切换刷新）
// 这样从 /capture 录入后回 Dashboard, 待整理徽章自动 +1
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import PageContainer from '@/components/layout/PageContainer.vue';
import { useRepositories } from '@/composables/useRepositories';
import type {
  FamilyMember,
  MedicalEvent,
  Medicine,
} from '@/repositories';
import DashboardHeader from '@/components/dashboard/DashboardHeader.vue';
import MemberCard from '@/components/dashboard/MemberCard.vue';
import MedicineWarningPanel from '@/components/dashboard/MedicineWarningPanel.vue';
import RecentEventsPanel from '@/components/dashboard/RecentEventsPanel.vue';
import AlertBanner from '@/components/dashboard/AlertBanner.vue';

// 每个数据源独立存: value + error, 这样部分失败不阻塞
const pendingCount = ref<number | null>(null);
const pendingError = ref<string | null>(null);

const members = ref<FamilyMember[] | null>(null);
const membersError = ref<string | null>(null);

const expiringMeds = ref<Medicine[] | null>(null);
const medsError = ref<string | null>(null);

const recentEvents = ref<MedicalEvent[] | null>(null);
const recentEventsError = ref<string | null>(null);

// v3.3: 复诊提醒
const upcomingFollowUps = ref<MedicalEvent[] | null>(null);
const followUpsError = ref<string | null>(null);

// 用 Map 加速 RecentEventsPanel 反查成员名（O(1)）
const memberMap = ref<Map<number, FamilyMember> | null>(null);

async function loadDashboard(): Promise<void> {
  try {
    const repos = await useRepositories();

    const [pending, m, meds, recent, followUps] = await Promise.allSettled([
      repos.inbox.countPending(),
      repos.familyMember.list(),
      repos.medicine.listExpiring(30),
      repos.medicalEvent.listRecent(10),
      repos.medicalEvent.listUpcomingFollowUps(30),
    ]);

    if (pending.status === 'fulfilled') {
      pendingCount.value = pending.value;
    } else {
      pendingError.value =
        pending.reason instanceof Error
          ? pending.reason.message
          : String(pending.reason);
    }

    if (m.status === 'fulfilled') {
      members.value = m.value;
      const map = new Map<number, FamilyMember>();
      for (const mem of m.value) map.set(mem.id, mem);
      memberMap.value = map;
    } else {
      membersError.value =
        m.reason instanceof Error ? m.reason.message : String(m.reason);
    }

    if (meds.status === 'fulfilled') {
      expiringMeds.value = meds.value;
    } else {
      medsError.value =
        meds.reason instanceof Error ? meds.reason.message : String(meds.reason);
    }

    if (recent.status === 'fulfilled') {
      recentEvents.value = recent.value;
    } else {
      recentEventsError.value =
        recent.reason instanceof Error
          ? recent.reason.message
          : String(recent.reason);
    }

    if (followUps.status === 'fulfilled') {
      upcomingFollowUps.value = followUps.value;
    } else {
      followUpsError.value =
        followUps.reason instanceof Error
          ? followUps.reason.message
          : String(followUps.reason);
    }
  } catch (e) {
    // 理论上 Promise.allSettled 不会 reject; 此处 catch 防御 useRepositories 失败
    membersError.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(() => {
  void loadDashboard();
});
</script>

<template>
  <PageContainer max-width="wide" class="dashboard">
    <DashboardHeader :pending-count="pendingCount" />

    <AlertBanner
      :expiring-meds="expiringMeds"
      :upcoming-follow-ups="upcomingFollowUps"
      :member-map="memberMap"
      :load-error="medsError ?? followUpsError"
    />

    <p v-if="pendingError" class="msg msg-warning">
      待整理计数加载失败: {{ pendingError }}
    </p>

    <!-- 空状态: 无成员 -->
    <div
      v-if="members !== null && members.length === 0"
      class="empty-members"
    >
      <p class="empty-title">还没有家庭成员</p>
      <p class="empty-hint">
        添加成员后, 这里会显示过敏 / 慢病 / 用药 / 最近就诊等信息。
      </p>
      <RouterLink to="/members" class="empty-cta">
        前往添加成员
      </RouterLink>
    </div>

    <!-- 有成员: 渲染卡片 -->
    <section
      v-else-if="members !== null && members.length > 0"
      class="member-cards"
    >
      <MemberCard
        v-for="m in members"
        :key="m.id"
        :member="m"
      />
    </section>

    <!-- 成员加载失败 -->
    <p v-else-if="membersError" class="msg msg-error">
      成员加载失败: {{ membersError }}
    </p>

    <!-- 否则 loading -->
    <p v-else class="hint">成员加载中...</p>

    <!-- 底部两栏: 药箱预警 + 最近事件 -->
    <section class="bottom-grid">
      <MedicineWarningPanel
        :medicines="expiringMeds"
        :load-error="medsError"
      />
      <RecentEventsPanel
        :events="recentEvents"
        :member-map="memberMap"
        :load-error="recentEventsError"
      />
    </section>

    <RouterLink to="/trends" class="trends-entry">
      <span class="trends-icon">📈</span>
      <span class="trends-text">
        <strong>查看健康趋势</strong>
        <small>白细胞 / 血红蛋白 / 血糖 等指标随时间变化</small>
      </span>
      <span class="trends-arrow">→</span>
    </RouterLink>

    <RouterLink to="/growth" class="trends-entry">
      <span class="trends-icon">📏</span>
      <span class="trends-text">
        <strong>儿童生长曲线</strong>
        <small>身高 / 体重 对照 WHO 标准百分位</small>
      </span>
      <span class="trends-arrow">→</span>
    </RouterLink>
  </PageContainer>
</template>

<style scoped>
.dashboard {
  /* padding/max-width/margin 由 PageContainer 提供 */
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.empty-members {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: 2.5rem 1.5rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.empty-title {
  margin: 0;
  font-size: var(--font-size-section-title);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.empty-hint {
  margin: 0;
  font-size: var(--font-size-body);
  color: var(--color-text-muted);
  max-width: 420px;
}

.empty-cta {
  margin-top: 1rem;
  padding: 0.6rem 1.2rem;
  background: var(--color-primary);
  color: white;
  text-decoration: none;
  border-radius: var(--radius-button);
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-input);
}

.empty-cta:hover {
  background: var(--color-primary-hover);
}

.member-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 0.75rem;
}

.bottom-grid {
  display: grid;
  grid-template-columns: 1fr 1.5fr;
  gap: 0.75rem;
}

.trends-entry {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  padding: 0.9rem 1.1rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  text-decoration: none;
  color: var(--color-text-primary);
  transition: border-color 0.15s, background 0.15s;
}

.trends-entry:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-light);
}

.trends-icon {
  font-size: 1.4rem;
}

.trends-text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  flex: 1;
}

.trends-text strong {
  font-size: var(--font-size-input);
  color: var(--color-text-primary);
}

.trends-text small {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.trends-arrow {
  color: var(--color-text-faint);
  font-size: 1.1rem;
}

@media (max-width: 720px) {
  .bottom-grid {
    grid-template-columns: 1fr;
  }
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

.msg-warning {
  background: var(--color-warning-light);
  color: var(--color-warning-text);
}

.hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-body);
  padding: 0.5rem 0;
}
</style>
