<script setup lang="ts">
// AlertBanner —— Dashboard 顶部红色横幅
// v3.3 触点扩展: 把"开 app 第一眼值得看"的事项集中提到顶部
//
// 三类来源（按优先级降序）:
//   1. 🔴 已过期药品（最紧急, 可能已失效 / 误服）
//   2. ⚠️ 即将过期药品（30 天内）
//   3. 📅 待复诊（未来 30 天内）
//
// 数据策略:
//   - 接收 listExpiring(30) 的原始返回（含已过期 + 即将过期）, 内部分类
//   - upcomingFollowUps 由父组件调 listUpcomingFollowUps(30) 传入
//   - 三类都为空时不渲染（v-if）
//
// 设计原则:
//   - 横幅整条可点击, 跳 /medicines（多数情况药品问题更紧急）
//   - 复诊也可点, 但默认跳药品——用户进药品页可看到完整列表
//   - 不在横幅内列明细（明细仍在 bottom-grid 的 MedicineWarningPanel）
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { MedicalEvent, FamilyMember, Medicine } from '@/repositories';

const props = defineProps<{
  /** listExpiring(30) 原始返回（含已过期 + 即将过期） */
  expiringMeds: Medicine[] | null;
  upcomingFollowUps: MedicalEvent[] | null;
  memberMap: Map<number, FamilyMember> | null;
  loadError?: string | null;
}>();

const todayMonth = computed(() => new Date().toISOString().slice(0, 7)); // YYYY-MM

const expiredMeds = computed<Medicine[]>(() => {
  if (props.expiringMeds === null) return [];
  return props.expiringMeds.filter(
    (m) => m.expiry_date !== null && m.expiry_date < todayMonth.value,
  );
});

const expiringSoonMeds = computed<Medicine[]>(() => {
  if (props.expiringMeds === null) return [];
  return props.expiringMeds.filter(
    (m) => m.expiry_date !== null && m.expiry_date >= todayMonth.value,
  );
});

interface FollowUpItem {
  event: MedicalEvent;
  memberName: string;
}

const followUps = computed<FollowUpItem[]>(() => {
  if (props.upcomingFollowUps === null) return [];
  return props.upcomingFollowUps.map((event) => ({
    event,
    memberName: props.memberMap?.get(event.member_id)?.name ?? '?',
  }));
});

const totalCount = computed(
  () =>
    expiredMeds.value.length +
    expiringSoonMeds.value.length +
    followUps.value.length,
);

const hasCritical = computed(() => expiredMeds.value.length > 0);
</script>

<template>
  <RouterLink
    v-if="totalCount > 0"
    to="/medicines"
    class="alert-banner"
    :class="{ critical: hasCritical }"
  >
    <div class="banner-content">
      <span v-if="expiredMeds.length > 0" class="alert-item critical">
        🔴 {{ expiredMeds.length }} 件药品已过期
      </span>
      <span v-if="expiringSoonMeds.length > 0" class="alert-item warning">
        ⚠️ {{ expiringSoonMeds.length }} 件即将过期
      </span>
      <span v-if="followUps.length > 0" class="alert-item info">
        📅 {{ followUps.length }} 次复诊待办
        <small v-if="followUps.length <= 2" class="followup-detail">
          ({{ followUps.map((f) => `${f.memberName}: ${f.event.next_visit_date}`).join(' · ') }})
        </small>
      </span>
    </div>
    <span class="banner-cta">查看 →</span>
  </RouterLink>
  <p v-else-if="loadError" class="msg msg-error">提醒加载失败: {{ loadError }}</p>
</template>

<style scoped>
.alert-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 0.8rem 1rem;
  background: var(--color-warning-light);
  color: var(--color-warning-text);
  border-left: 4px solid var(--color-warning);
  border-radius: var(--radius-button);
  text-decoration: none;
  font-size: var(--font-size-input);
  font-weight: var(--font-weight-medium);
  transition: background 0.15s;
}

.alert-banner.critical {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
  border-left-color: var(--color-danger);
}

.alert-banner:hover {
  background: #fef3c7;
}

.alert-banner.critical:hover {
  background: #fee2e2;
}

.banner-content {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.alert-item {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
}

.alert-item.critical {
  font-weight: var(--font-weight-bold);
}

.followup-detail {
  font-size: var(--font-size-caption);
  color: var(--color-text-muted);
  font-weight: var(--font-weight-normal);
}

.banner-cta {
  white-space: nowrap;
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-small);
}

.msg {
  margin: 0;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-badge);
  font-size: 0.88rem;
}

.msg-error {
  background: var(--color-danger-light);
  color: var(--color-danger-text);
}

@media (max-width: 540px) {
  .banner-content {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.3rem;
  }
}
</style>
