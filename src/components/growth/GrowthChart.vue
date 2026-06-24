<script setup lang="ts">
// GrowthChart —— 儿童生长曲线 SVG 图（纯展示组件）
// ============================================================
// 参考 TrendChart 的画法 (viewBox 800×360, mapX/mapY, polyline+circle),
// 但专为生长曲线改造:
//   - X 轴 = 月龄 (0-60), 非日期
//   - 画 5 条 WHO 参考百分位曲线 (3/15/50/85/97) 作背景参照
//   - 孩子实测值画粗折线 + 数据点; 最新点标出百分位
//
// LMS 表由父组件 (GrowthView) 传入, 本组件不 import 数据文件 → 可独立测试。
// 空 points 时只画参考曲线 (让家长看到标准长什么样)。
import { computed } from 'vue';
import {
  REFERENCE_PERCENTILES,
  interpolateLMS,
  percentileForValue,
  valueFromZ,
  type GrowthMetric,
  type LmsRow,
} from '@/lib/growth/percentile';

interface GrowthPoint {
  ageMonths: number;
  value: number; // height_cm 或 weight_kg
  measuredDate: string; // YYYY-MM-DD, tooltip 用
}

const props = defineProps<{
  points: GrowthPoint[];
  metric: GrowthMetric; // 'height' | 'weight'
  lmsTable: LmsRow[];
  unit: string; // 'cm' | 'kg', 轴标签
  /** 性别+指标的中文名, 用于无数据时的占位说明 */
  metricLabel: string;
}>();

// 画布常量 (与 TrendChart 一致, 保持视觉统一)
const VB_W = 800;
const VB_H = 360;
const PAD_LEFT = 48;
const PAD_RIGHT = 56; // 右侧留白给百分位曲线标签
const PAD_TOP = 20;
const PAD_BOTTOM = 44;
const PLOT_W = VB_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VB_H - PAD_TOP - PAD_BOTTOM;

// ---- X 域 (月龄) ----
const xDomain = computed(() => {
  if (props.points.length === 0) {
    return { min: 0, max: 60 };
  }
  const ages = props.points.map((p) => p.ageMonths);
  const dataMin = Math.min(...ages);
  const dataMax = Math.max(...ages);
  // 单点时给 ±6 月窗口; 多点给 ±3 月留白; 钳到 0-60
  const span = dataMax - dataMin < 1 ? 6 : 3;
  return {
    min: Math.max(0, Math.floor(dataMin - span)),
    max: Math.min(60, Math.ceil(dataMax + span)),
  };
});

// ---- 参考曲线采样: x 域内每月一个点 × 5 条百分位 ----
interface RefCurve {
  percentile: number;
  label: string;
  pts: { x: number; y: number }[];
  raw: { month: number; value: number }[]; // 供 Y 域计算
  z: number;
}
const refCurves = computed<RefCurve[]>(() => {
  const { min, max } = xDomain.value;
  const out: RefCurve[] = [];
  for (const ref of REFERENCE_PERCENTILES) {
    const raw: { month: number; value: number }[] = [];
    for (let m = Math.ceil(min); m <= Math.floor(max); m++) {
      const lms = interpolateLMS(props.lmsTable, m);
      if (!lms) continue;
      raw.push({ month: m, value: valueFromZ(lms.L, lms.M, lms.S, ref.z) });
    }
    out.push({
      percentile: ref.percentile,
      label: ref.label,
      z: ref.z,
      raw,
      pts: [],
    });
  }
  return out;
});

// ---- Y 域: 孩子值 + 参考曲线值的并集, +8% 留白 ----
const yDomain = computed(() => {
  const vals: number[] = [];
  for (const p of props.points) vals.push(p.value);
  for (const c of refCurves.value) for (const r of c.raw) vals.push(r.value);
  if (vals.length === 0) return { min: 0, max: 100 };
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || hi * 0.08 || 1;
  return { min: Math.max(0, lo - pad), max: hi + pad };
});

// ---- 映射函数 ----
function mapX(month: number): number {
  const { min, max } = xDomain.value;
  if (max === min) return PAD_LEFT + PLOT_W / 2;
  const r = (month - min) / (max - min);
  return PAD_LEFT + r * PLOT_W;
}
function mapY(value: number): number {
  const { min, max } = yDomain.value;
  const r = (value - min) / (max - min || 1);
  return PAD_TOP + (1 - r) * PLOT_H; // 翻转: 值大在上
}

// 参考曲线 polyline 坐标
const refPolylines = computed(() =>
  refCurves.value.map((c) => ({
    percentile: c.percentile,
    label: c.label,
    points: c.raw.map((r) => `${mapX(r.month).toFixed(1)},${mapY(r.value).toFixed(1)}`).join(' '),
    // 右端标签位置 (最后一点)
    labelX: c.raw.length ? mapX(c.raw[c.raw.length - 1].month) : 0,
    labelY: c.raw.length ? mapY(c.raw[c.raw.length - 1].value) : 0,
  })),
);

// 孩子实测 polyline + 圆点
const childPolyline = computed(() =>
  props.points
    .map((p) => `${mapX(p.ageMonths).toFixed(1)},${mapY(p.value).toFixed(1)}`)
    .join(' '),
);

// 最新点的百分位 (用于标注)
const latestPercentile = computed(() => {
  if (props.points.length === 0) return null;
  const last = props.points[props.points.length - 1];
  const r = percentileForValue(props.lmsTable, last.ageMonths, last.value);
  return r ? { point: last, percentile: r.percentile } : null;
});

// ---- 刻度 ----
const xTicks = computed(() => {
  const { min, max } = xDomain.value;
  const ticks: { x: number; label: string }[] = [];
  const step = max - min <= 12 ? 2 : max - min <= 24 ? 6 : 12;
  for (let m = Math.ceil(min / step) * step; m <= max; m += step) {
    ticks.push({ x: mapX(m), label: `${m}月` });
  }
  return ticks;
});
const yTicks = computed(() => {
  const { min, max } = yDomain.value;
  const ticks: { y: number; label: string }[] = [];
  const n = 5;
  const step = (max - min) / n;
  for (let i = 0; i <= n; i++) {
    const v = min + step * i;
    ticks.push({ y: mapY(v), label: v.toFixed(v < 10 ? 1 : 0) });
  }
  return ticks;
});

const isHeight = computed(() => props.metric === 'height');
</script>

<template>
  <div class="growth-chart">
    <svg
      :viewBox="`0 0 ${VB_W} ${VB_H}`"
      class="chart-svg"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      :aria-label="`${metricLabel} 曲线`"
    >
      <!-- Y 轴刻度 + 网格 -->
      <g class="axis-y">
        <line
          v-for="(t, i) in yTicks"
          :key="`y${i}`"
          :x1="PAD_LEFT"
          :x2="VB_W - PAD_RIGHT"
          :y1="t.y"
          :y2="t.y"
          class="grid-line"
        />
        <text
          v-for="(t, i) in yTicks"
          :key="`yl${i}`"
          :x="PAD_LEFT - 6"
          :y="t.y + 3"
          class="tick-label"
          text-anchor="end"
        >
          {{ t.label }}
        </text>
      </g>

      <!-- X 轴刻度 -->
      <g class="axis-x">
        <text
          v-for="(t, i) in xTicks"
          :key="`x${i}`"
          :x="t.x"
          :y="VB_H - PAD_BOTTOM + 16"
          class="tick-label"
          text-anchor="middle"
        >
          {{ t.label }}
        </text>
      </g>

      <!-- 参考百分位曲线 (3/15/50/85/97) -->
      <g class="ref-curves">
        <polyline
          v-for="(c, i) in refPolylines"
          :key="`ref${i}`"
          :points="c.points"
          :class="['ref-line', `ref-p${c.percentile}`]"
          fill="none"
        />
        <text
          v-for="(c, i) in refPolylines"
          :key="`refl${i}`"
          :x="c.labelX + 4"
          :y="c.labelY + 3"
          :class="['ref-label', `ref-p${c.percentile}`]"
        >
          {{ c.label }}
        </text>
      </g>

      <!-- 孩子实测折线 + 圆点 -->
      <g v-if="points.length > 0" class="child-curve">
        <polyline :points="childPolyline" class="child-line" fill="none" />
        <circle
          v-for="(p, i) in points"
          :key="`pt${i}`"
          :cx="mapX(p.ageMonths)"
          :cy="mapY(p.value)"
          :r="i === points.length - 1 ? 4.5 : 3"
          :class="['child-dot', { 'child-dot-latest': i === points.length - 1 }]"
        >
          <title>{{ p.measuredDate }} · {{ p.value }} {{ unit }}</title>
        </circle>
      </g>

      <!-- 轴标题 -->
      <text :x="PAD_LEFT" :y="VB_H - 6" class="axis-title">月龄</text>
      <text
        :x="VB_W - PAD_RIGHT"
        :y="VB_H - 6"
        class="axis-title"
        text-anchor="end"
      >
        {{ isHeight ? '身高/身长' : '体重' }} ({{ unit }})
      </text>
    </svg>

    <!-- 最新点百分位摘要 (图外, 便于一眼看到) -->
    <p v-if="latestPercentile" class="latest-summary">
      <strong>{{ latestPercentile.point.measuredDate }}</strong>
      测量 ·
      {{ isHeight ? '身高' : '体重' }}
      {{ latestPercentile.point.value }} {{ unit }} ·
      <span class="pct">第 {{ latestPercentile.percentile.toFixed(0) }} 百分位</span>
    </p>
    <p v-else-if="points.length === 0" class="chart-empty">
      暂无{{ metricLabel }}数据。参考曲线为 WHO 标准（3/15/50/85/97 百分位），
      录入测量后孩子的曲线会叠加上去。
    </p>
  </div>
</template>

<style scoped>
.growth-chart {
  width: 100%;
}

.chart-svg {
  width: 100%;
  height: auto;
  display: block;
}

.grid-line {
  stroke: #f0f0f0;
  stroke-width: 1;
}

.tick-label {
  font-size: 11px;
  fill: #6b7280;
}

.axis-title {
  font-size: 11px;
  fill: #9ca3af;
}

/* 参考百分位曲线: 3/97 虚线最淡, 15/85 更淡, 50 中等 */
.ref-line {
  stroke-width: 1.2;
}
.ref-p3,
.ref-p97 {
  stroke: #cbd5e1;
  stroke-dasharray: 4 3;
}
.ref-p15,
.ref-p85 {
  stroke: #d6dce5;
}
.ref-p50 {
  stroke: #94a3b8;
  stroke-width: 1.6;
}

.ref-label {
  font-size: 10px;
  fill: #94a3b8;
}

/* 孩子实测 */
.child-line {
  stroke: #2563eb;
  stroke-width: 2.4;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.child-dot {
  fill: #2563eb;
  stroke: white;
  stroke-width: 1.5;
}

.child-dot-latest {
  fill: #1d4ed8;
}

.latest-summary {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.75rem;
  background: #eff6ff;
  border-radius: 6px;
  font-size: 0.9rem;
  color: #1f2937;
}

.latest-summary .pct {
  color: #1d4ed8;
  font-weight: 600;
}

.chart-empty {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.75rem;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 0.85rem;
  color: #6b7280;
}
</style>
