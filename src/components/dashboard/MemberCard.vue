<script setup lang="ts">
// MemberCard —— Dashboard 上的单个成员卡片
// PRD 7.2 / 9.3: 过敏强制顶部 + 红色高亮（不可折叠）, 因为关键安全信息
//
// 卡片渲染:
//   👤 姓名（昵称）
//   ⚠️ 过敏: xxx（严重·皮疹）  ← allergies.length > 0 时红底高亮
//   📋 慢病: xxx
//   💊 用药: xxx
//   最近就诊: 06-18 发烧          ← findLatestByMember(memberId, 'outpatient')
//   最近体检: 2025-09-10          ← findLatestByMember(memberId, 'checkup')
//   最近住院: 无                  ← findLatestByMember(memberId, 'hospitalization')
//   最近血常规: 2025-08-15        ← attachment.findLatestByMember(memberId, {docType:'lab_report', subtype:'cbc'})
//
// 每个卡片独立加载自己的数据（N×4 查询模式）, 失败的子项显示"加载失败"
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useRepositories } from '@/composables/useRepositories';
import type { Attachment, FamilyMember, MedicalEvent } from '@/repositories';

const props = defineProps<{
  member: FamilyMember;
}>();

const isLoading = ref(false);
const loadError = ref<string | null>(null);

const latestOutpatient = ref<MedicalEvent | null>(null);
const latestCheckup = ref<MedicalEvent | null>(null);
const latestHospitalization = ref<MedicalEvent | null>(null);
const latestCbc = ref<Attachment | null>(null);

// 标记每个维度是否查询过（用于区分 "null 因为无数据" vs "null 因为没查到"）
const dimensionsLoaded = ref({
  outpatient: false,
  checkup: false,
  hospitalization: false,
  cbc: false,
});

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  // YYYY-MM-DDTHH:MM:SSZ → MM-DD
  // 也支持 YYYY-MM-DD 和 YYYY-MM 直接截取
  const datePart = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return iso;
  return datePart.slice(5); // MM-DD
}

function formatAllergies(m: FamilyMember): string {
  return m.allergies
    .map((a) => {
      const severity =
        a.severity === 'severe'
          ? '严重'
          : a.severity === 'moderate'
            ? '中度'
            : '轻度';
      const reaction = a.reaction ? `·${a.reaction}` : '';
      return `${a.name}（${severity}${reaction}）`;
    })
    .join('、');
}

function formatChronic(m: FamilyMember): string {
  return m.chronic_conditions
    .map((c) => {
      const status =
        c.status === 'active'
          ? '进行中'
          : c.status === 'managed'
            ? '可控'
            : '已结束';
      return `${c.name}（${status}）`;
    })
    .join('、');
}

async function loadDimensions(): Promise<void> {
  isLoading.value = true;
  loadError.value = null;
  try {
    const repos = await useRepositories();
    const memberId = props.member.id;

    const [outpatient, checkup, hosp, cbc] = await Promise.allSettled([
      repos.medicalEvent.findLatestByMember(memberId, 'outpatient'),
      repos.medicalEvent.findLatestByMember(memberId, 'checkup'),
      repos.medicalEvent.findLatestByMember(memberId, 'hospitalization'),
      repos.attachment.findLatestByMember(memberId, {
        docType: 'lab_report',
        subtype: 'cbc',
      }),
    ]);

    if (outpatient.status === 'fulfilled') {
      latestOutpatient.value = outpatient.value;
      dimensionsLoaded.value.outpatient = true;
    }
    if (checkup.status === 'fulfilled') {
      latestCheckup.value = checkup.value;
      dimensionsLoaded.value.checkup = true;
    }
    if (hosp.status === 'fulfilled') {
      latestHospitalization.value = hosp.value;
      dimensionsLoaded.value.hospitalization = true;
    }
    if (cbc.status === 'fulfilled') {
      latestCbc.value = cbc.value;
      dimensionsLoaded.value.cbc = true;
    }

    // 任一 rejected 视为部分失败, 但不阻塞其他维度展示
    const anyRejected = [outpatient, checkup, hosp, cbc].some(
      (r) => r.status === 'rejected',
    );
    if (anyRejected) {
      loadError.value = '部分维度加载失败';
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  void loadDimensions();
});
</script>

<template>
  <article class="member-card">
    <header class="card-header">
      <span class="avatar">👤</span>
      <div class="header-info">
        <h2 class="member-name">
          {{ props.member.name }}
          <span v-if="props.member.nickname" class="member-nickname">
            {{ props.member.nickname }}
          </span>
        </h2>
        <span v-if="props.member.birthday" class="member-birthday">
          🎂 {{ props.member.birthday }}
        </span>
      </div>
    </header>

    <!-- 过敏强制顶部, 红色高亮 -->
    <div
      v-if="props.member.allergies.length > 0"
      class="allergy-row"
    >
      <span class="row-icon">⚠️</span>
      <span class="row-label">过敏:</span>
      <span class="row-content">{{ formatAllergies(props.member) }}</span>
    </div>

    <div
      v-if="props.member.chronic_conditions.length > 0"
      class="info-row"
    >
      <span class="row-icon">📋</span>
      <span class="row-label">慢病:</span>
      <span class="row-content">{{ formatChronic(props.member) }}</span>
    </div>

    <div
      v-if="props.member.current_medications.length > 0"
      class="info-row"
    >
      <span class="row-icon">💊</span>
      <span class="row-label">用药:</span>
      <span class="row-content">
        {{ props.member.current_medications.join('、') }}
      </span>
    </div>

    <div class="divider"></div>

    <div v-if="isLoading" class="loading-hint">维度加载中...</div>
    <div v-else-if="loadError" class="partial-error">
      {{ loadError }}（其他维度正常显示）
    </div>

    <dl class="dimensions">
      <div class="dimension">
        <dt>最近就诊</dt>
        <dd>
          <template v-if="latestOutpatient">
            {{ formatDate(latestOutpatient.event_date) }} ·
            {{ latestOutpatient.title }}
          </template>
          <template v-else-if="dimensionsLoaded.outpatient">无</template>
          <template v-else>—</template>
        </dd>
      </div>
      <div class="dimension">
        <dt>最近体检</dt>
        <dd>
          <template v-if="latestCheckup">
            {{ formatDate(latestCheckup.event_date) }} ·
            {{ latestCheckup.title }}
          </template>
          <template v-else-if="dimensionsLoaded.checkup">无</template>
          <template v-else>—</template>
        </dd>
      </div>
      <div class="dimension">
        <dt>最近住院</dt>
        <dd>
          <template v-if="latestHospitalization">
            {{ formatDate(latestHospitalization.event_date) }} ·
            {{ latestHospitalization.title }}
          </template>
          <template v-else-if="dimensionsLoaded.hospitalization">无</template>
          <template v-else>—</template>
        </dd>
      </div>
      <div class="dimension">
        <dt>最近血常规</dt>
        <dd>
          <template v-if="latestCbc">
            {{ formatDate(latestCbc.created_at) }}
          </template>
          <template v-else-if="dimensionsLoaded.cbc">无</template>
          <template v-else>—</template>
        </dd>
      </div>
    </dl>

    <p v-if="props.member.remark" class="member-remark">
      📝 {{ props.member.remark }}
    </p>

    <RouterLink
      :to="`/timeline?member=${props.member.id}`"
      class="view-events-link"
    >
      📋 查看该成员事件 →
    </RouterLink>
  </article>
</template>

<style scoped>
.member-card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-card);
  padding: var(--space-card-padding);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.25rem;
}

.avatar {
  font-size: 1.6rem;
  line-height: 1;
}

.header-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.member-name {
  margin: 0;
  font-size: var(--font-size-section-title);
  font-weight: var(--font-weight-bold);
  color: var(--color-text-primary);
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.member-nickname {
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-normal);
  color: var(--color-text-muted);
}

.member-birthday {
  font-size: var(--font-size-caption);
  color: var(--color-text-faint);
}

/* 过敏行: PRD 7.3/9.3 强制顶部 + 红色高亮 */
.allergy-row {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.5rem 0.7rem;
  background: var(--color-danger-light);
  color: var(--color-danger-text);
  border-left: 3px solid var(--color-danger);
  border-radius: var(--radius-small);
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-medium);
}

.info-row {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.2rem 0;
  font-size: 0.88rem;
  color: var(--color-text-secondary);
}

.row-icon {
  flex-shrink: 0;
}

.row-label {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.row-content {
  flex: 1;
}

.divider {
  height: 1px;
  background: var(--color-border-default);
  margin: 0.5rem 0;
}

.loading-hint,
.partial-error {
  font-size: 0.8rem;
  color: var(--color-text-faint);
  padding: 0.2rem 0;
}

.partial-error {
  color: #b45309;
}

.dimensions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.4rem 1rem;
  margin: 0;
}

.dimension {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.dimension dt {
  font-size: var(--font-size-badge);
  color: var(--color-text-faint);
  font-weight: var(--font-weight-medium);
}

.dimension dd {
  margin: 0;
  font-size: 0.88rem;
  color: var(--color-text-primary);
}

.member-remark {
  margin: 0.4rem 0 0;
  padding: 0.4rem 0.6rem;
  background: var(--color-bg-page);
  border-radius: var(--radius-small);
  font-size: var(--font-size-meta);
  color: var(--color-text-muted);
}

@media (max-width: 540px) {
  .dimensions {
    grid-template-columns: 1fr;
  }
}

.view-events-link {
  display: block;
  margin-top: 0.5rem;
  padding: 0.45rem 0.7rem;
  background: var(--color-primary-light);
  color: var(--color-primary-dark);
  border-radius: var(--radius-badge);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-medium);
  text-decoration: none;
  text-align: center;
  transition: background 0.15s;
}

.view-events-link:hover {
  background: #dbeafe;
}
</style>
