<script setup lang="ts">
// ============================================================
// Avatar —— 家庭成员卡通 SVG 头像
// ============================================================
// 派生策略: gender × ageGroup → 6 变体 + 1 neutral 兜底
//
//   年龄段 (computeAgeGroup, src/lib/memberAvatar.ts):
//     child:    < 14
//     young:    14..59
//     elderly:  >= 60
//     unknown:  birthday null → 视觉降级为 young
//
//   性别:
//     male/female → 对应变体
//     'other'/null → neutral (灰色兜底)
//
// 视觉差异:
//   - 背景色: 蓝 (male) / 粉 (female) / 灰 (neutral)
//   - 头发颜色: 棕 (child) / 深棕黑 (young) / 灰 (elderly)
//   - 头发形状: boy短发 / girl双马尾 / 中青年短发或中长发 / 老年稀疏+发髻
//   - 老年加眼镜
//   - child 脸更圆 + 大眼
//
// 不依赖任何外部资源 (emoji/PNG/font), 全部 inline SVG path.
// ============================================================
import { computed } from 'vue';
import { computeAgeGroup, type AgeGroup } from '@/lib/memberAvatar';

type Gender = 'male' | 'female' | 'other' | null;

const props = withDefaults(
  defineProps<{
    gender: Gender;
    /** YYYY-MM-DD, 缺省视为 'unknown' (视觉降级 young) */
    birthday?: string | null;
    /** 像素尺寸, 正方形. 默认 48 */
    size?: number;
  }>(),
  {
    birthday: null,
    size: 48,
  },
);

/** 'unknown' 视觉降级为 'young' (最常见的默认人群) */
const visualAge = computed<Exclude<AgeGroup, 'unknown'>>(() => {
  const g = computeAgeGroup(props.birthday);
  return g === 'unknown' ? 'young' : g;
});

/** gender 'other'/null → 'neutral' */
const visualGender = computed<'male' | 'female' | 'neutral'>(() => {
  if (props.gender === 'male') return 'male';
  if (props.gender === 'female') return 'female';
  return 'neutral';
});

const isChild = computed(() => visualAge.value === 'child');
const isElderly = computed(() => visualAge.value === 'elderly');
const isFemale = computed(() => visualGender.value === 'female');
const isMale = computed(() => visualGender.value === 'male');
const isNeutral = computed(() => visualGender.value === 'neutral');

// === 颜色 ===
const bgColor = computed(() => {
  if (isMale.value) return '#dbeafe'; // blue-100
  if (isFemale.value) return '#fce7f3'; // pink-100
  return '#f3f4f6'; // gray-100
});

const bodyColor = computed(() => {
  if (isMale.value) return '#3b82f6'; // blue-500
  if (isFemale.value) return '#ec4899'; // pink-500
  return '#6b7280'; // gray-500
});

const hairColor = computed(() => {
  if (isElderly.value) return '#d1d5db'; // gray-300
  if (isChild.value) return '#92400e'; // amber-800 (棕色)
  return '#374151'; // gray-700 (深棕黑)
});

const SKIN = '#fde0b0';
const INK = '#1f2937';

/** data-variant 用于调试 / e2e selector */
const variantKey = computed(
  () => `${visualGender.value}-${visualAge.value}`,
);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    class="member-avatar"
    :data-variant="variantKey"
    :style="{ color: bodyColor }"
    aria-hidden="true"
  >
    <!-- 背景圆 -->
    <circle cx="32" cy="32" r="32" :fill="bgColor" />

    <!-- 身体/肩膀 (在脸后面) -->
    <path d="M 8 64 Q 8 48 32 46 Q 56 48 56 64 Z" :fill="bodyColor" />

    <!--
      长发后片 (female young/elderly): 先画, 让脸盖住前面
      child 不画 (用马尾)
    -->
    <path
      v-if="isFemale && !isChild"
      d="M 14 32 Q 14 14 32 14 Q 50 14 50 32 L 50 50 L 44 50 L 44 28 Q 40 22 32 22 Q 24 22 20 28 L 20 50 L 14 50 Z"
      :fill="hairColor"
    />

    <!-- 脸 (child 更圆, 其余略椭圆) -->
    <ellipse
      cx="32"
      :cy="isChild ? 30 : 28"
      :rx="isChild ? 15 : 14"
      :ry="isChild ? 16 : 15"
      :fill="SKIN"
    />

    <!-- ============ 头发顶 (按变体分支) ============ -->

    <!-- male young/child: 短发 -->
    <path
      v-if="isMale && !isElderly"
      d="M 18 26 Q 18 12 32 12 Q 46 12 46 26 L 44 24 Q 40 16 32 16 Q 24 16 20 24 Z"
      :fill="hairColor"
    />

    <!-- male elderly: 稀疏发际线 (中间秃, 两侧) -->
    <path
      v-if="isMale && isElderly"
      d="M 18 24 Q 18 18 24 16 L 28 18 L 32 16 L 36 18 L 40 16 Q 46 18 46 24 L 42 22 Q 38 20 32 20 Q 26 20 22 22 Z"
      :fill="hairColor"
    />

    <!-- female child: 短发顶 + 两侧马尾 -->
    <g v-if="isFemale && isChild">
      <path
        d="M 19 26 Q 19 13 32 13 Q 45 13 45 26 L 42 22 Q 38 18 32 18 Q 26 18 22 22 Z"
        :fill="hairColor"
      />
      <circle cx="14" cy="32" r="4" :fill="hairColor" />
      <circle cx="50" cy="32" r="4" :fill="hairColor" />
    </g>

    <!-- female young/elderly: 顶部头发 (后片已画) -->
    <path
      v-if="isFemale && !isChild"
      d="M 18 26 Q 18 12 32 12 Q 46 12 46 26 L 44 22 Q 40 18 32 18 Q 24 18 20 22 Z"
      :fill="hairColor"
    />

    <!-- female elderly: 顶髻 -->
    <circle
      v-if="isFemale && isElderly"
      cx="32"
      cy="10"
      r="4"
      :fill="hairColor"
    />

    <!-- neutral (gender 'other'/null): 简单短发, 颜色随年龄 -->
    <path
      v-if="isNeutral"
      d="M 18 26 Q 18 13 32 13 Q 46 13 46 26 L 44 24 Q 40 17 32 17 Q 24 17 20 24 Z"
      :fill="isElderly ? '#d1d5db' : '#6b7280'"
    />

    <!-- ============ 眼睛 ============ -->
    <!-- child 眼睛略大 -->
    <circle cx="27" cy="28" :r="isChild ? 1.8 : 1.4" :fill="INK" />
    <circle cx="37" cy="28" :r="isChild ? 1.8 : 1.4" :fill="INK" />

    <!-- ============ 老年眼镜 ============ -->
    <g
      v-if="isElderly"
      fill="none"
      stroke="#4b5563"
      stroke-width="1.2"
      stroke-linecap="round"
    >
      <circle cx="27" cy="28" r="4" />
      <circle cx="37" cy="28" r="4" />
      <line x1="31" y1="28" x2="33" y2="28" />
    </g>

    <!-- ============ 嘴 (微笑) ============ -->
    <path
      d="M 28 34 Q 32 37 36 34"
      :stroke="INK"
      stroke-width="1.2"
      fill="none"
      stroke-linecap="round"
    />
  </svg>
</template>

<style scoped>
.member-avatar {
  display: inline-block;
  vertical-align: middle;
  /* 避免高对比背景下看到锯齿 */
  shape-rendering: geometricPrecision;
}
</style>
