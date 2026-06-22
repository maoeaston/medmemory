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

// 每个数据源独立存: value + error, 这样部分失败不阻塞
const pendingCount = ref<number | null>(null);
const pendingError = ref<string | null>(null);

const members = ref<FamilyMember[] | null>(null);
const membersError = ref<string | null>(null);

const expiringMeds = ref<Medicine[] | null>(null);
const medsError = ref<string | null>(null);

const recentEvents = ref<MedicalEvent[] | null>(null);
const recentEventsError = ref<string | null>(null);

// 用 Map 加速 RecentEventsPanel 反查成员名（O(1)）
const memberMap = ref<Map<number, FamilyMember> | null>(null);

async function loadDashboard(): Promise<void> {
  try {
    const repos = await useRepositories();

    const [pending, m, meds, recent] = await Promise.allSettled([
      repos.inbox.countPending(),
      repos.familyMember.list(),
      repos.medicine.listExpiring(30),
      repos.medicalEvent.listRecent(10),
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
  <main class="dashboard">
    <DashboardHeader :pending-count="pendingCount" />

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
  </main>
</template>

<style scoped>
.dashboard {
  padding: 1.5rem;
  max-width: 920px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.empty-members {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 2.5rem 1.5rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.empty-title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: #1f2937;
}

.empty-hint {
  margin: 0;
  font-size: 0.9rem;
  color: #6b7280;
  max-width: 420px;
}

.empty-cta {
  margin-top: 1rem;
  padding: 0.6rem 1.2rem;
  background: #2563eb;
  color: white;
  text-decoration: none;
  border-radius: 6px;
  font-weight: 600;
  font-size: 0.92rem;
}

.empty-cta:hover {
  background: #1d4ed8;
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

@media (max-width: 720px) {
  .bottom-grid {
    grid-template-columns: 1fr;
  }
}

.msg {
  margin: 0;
  padding: 0.6rem 0.8rem;
  border-radius: 4px;
  font-size: 0.9rem;
}

.msg-error {
  background: #fef2f2;
  color: #991b1b;
}

.msg-warning {
  background: #fffbeb;
  color: #92400e;
}

.hint {
  color: #6b7280;
  font-size: 0.9rem;
  padding: 0.5rem 0;
}
</style>
