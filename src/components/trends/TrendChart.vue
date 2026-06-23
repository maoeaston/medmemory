<script setup lang="ts">
// TrendChart —— 手写 SVG 折线图
// v3.3 触点扩展: 健康趋势图（化验指标随时间变化）
//
// 设计:
//   - 零依赖（不引入 Chart.js / ECharts / D3）
//   - viewBox 800x360, 响应式靠 CSS width: 100%
//   - 三层视觉:
//     1. 参考范围带（浅绿色 rect）—— 来自 parseReferenceRange
//     2. 危急阈值虚线（红色 dashed line）—— 来自 getThresholdsByName
//     3. 数据折线 + 数据点（abnormal 染色）
//
// 不做 IO: 数据 + 范围 + 阈值都由父组件传入, 纯展示组件
import { computed } from 'vue';

interface ChartPoint {
  /** YYYY-MM-DD */
  date: string;
  value: number;
  abnormal: 'H' | 'L' | 'N' | null;
  memberName: string;
}

const props = defineProps<{
  points: ChartPoint[];
  referenceRange: { low: number | null; high: number | null };
  thresholds?: {
    criticalLow: number | null;
    criticalHigh: number | null;
  } | null;
  unit: string | null;
}>();

// SVG 画布尺寸（viewBox, 内部坐标; 实际显示靠 CSS 缩放）
const W = 800;
const H = 360;
const PAD_LEFT = 60;
const PAD_RIGHT = 24;
const PAD_TOP = 24;
const PAD_BOTTOM = 48;
const PLOT_W = W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;

/** 计算 Y 轴范围: 数据点 + 参考范围 + 阈值的并集, 留 10% padding */
const yDomain = computed<{ min: number; max: number }>(() => {
  const candidates: number[] = [];
  for (const p of props.points) candidates.push(p.value);
  if (props.referenceRange.low !== null) candidates.push(props.referenceRange.low);
  if (props.referenceRange.high !== null) candidates.push(props.referenceRange.high);
  if (props.thresholds?.criticalLow !== null && props.thresholds?.criticalLow !== undefined) {
    candidates.push(props.thresholds.criticalLow);
  }
  if (props.thresholds?.criticalHigh !== null && props.thresholds?.criticalHigh !== undefined) {
    candidates.push(props.thresholds.criticalHigh);
  }
  if (candidates.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...candidates);
  let max = Math.max(...candidates);
  if (min === max) {
    // 单点或全部相同: 给个 ±10% 的可视范围
    const pad = Math.abs(min) * 0.1 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.1;
  return { min: min - pad, max: max + pad };
});

/** 5 个 Y 轴 tick (含 min/max) */
const yTicks = computed<{ value: number; y: number; label: string }[]>(() => {
  const { min, max } = yDomain.value;
  const steps = 5;
  const result: { value: number; y: number; label: string }[] = [];
  for (let i = 0; i <= steps; i++) {
    const value = min + ((max - min) * i) / steps;
    result.push({
      value,
      y: mapY(value),
      label: formatNumber(value),
    });
  }
  return result;
});

/** X 轴坐标: 按日期均匀分布（不按真实时间间隔, MVP 够用） */
const xDomain = computed<{ min: number; max: number }>(() => {
  if (props.points.length === 0) return { min: 0, max: 1 };
  const times = props.points.map((p) => new Date(p.date).getTime());
  let min = Math.min(...times);
  let max = Math.max(...times);
  if (min === max) {
    // 单点: 留前后 1 天让点能落到中间
    const dayMs = 86400000;
    min -= dayMs;
    max += dayMs;
  }
  return { min, max };
});

/** X 轴 tick: 至多 5 个日期, 按均匀分布 */
const xTicks = computed<{ x: number; label: string }[]>(() => {
  if (props.points.length === 0) return [];
  const { min, max } = xDomain.value;
  const steps = Math.min(props.points.length, 5);
  if (steps <= 1) {
    return [
      {
        x: mapX(new Date(props.points[0].date).getTime(), min, max),
        label: formatDate(props.points[0].date),
      },
    ];
  }
  const result: { x: number; label: string }[] = [];
  for (let i = 0; i < steps; i++) {
    const t = min + ((max - min) * i) / (steps - 1);
    result.push({ x: mapX(t, min, max), label: formatDate(new Date(t).toISOString().slice(0, 10)) });
  }
  return result;
});

function mapY(value: number): number {
  const { min, max } = yDomain.value;
  const ratio = (value - min) / (max - min || 1);
  // SVG y 轴反向: value=max 在顶部 (PAD_TOP), value=min 在底部
  return PAD_TOP + (1 - ratio) * PLOT_H;
}

function mapX(time: number, min: number, max: number): number {
  if (max === min) return PAD_LEFT + PLOT_W / 2;
  const ratio = (time - min) / (max - min);
  return PAD_LEFT + ratio * PLOT_W;
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // 小于 1 的小数保留 2 位, 否则 1 位
  if (Math.abs(n) < 1) return n.toFixed(2);
  return n.toFixed(1);
}

function formatDate(yyyymmdd: string): string {
  // YYYY-MM-DD → MM-DD
  return yyyymmdd.slice(5);
}

/** SVG polyline points 字符串 */
const polylinePoints = computed(() => {
  const { min, max } = xDomain.value;
  return props.points
    .map((p) => {
      const t = new Date(p.date).getTime();
      const x = mapX(t, min, max);
      const y = mapY(p.value);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

interface SvgPoint {
  cx: number;
  cy: number;
  cls: string;
  tooltip: string;
}

const svgPoints = computed<SvgPoint[]>(() => {
  const { min, max } = xDomain.value;
  return props.points.map((p) => {
    const t = new Date(p.date).getTime();
    const x = mapX(t, min, max);
    const y = mapY(p.value);
    let cls = 'normal';
    if (p.abnormal === 'H') cls = 'high';
    else if (p.abnormal === 'L') cls = 'low';
    return {
      cx: x,
      cy: y,
      cls,
      tooltip: `${p.date} · ${p.memberName} · ${p.value}${props.unit ?? ''}${
        p.abnormal ? ` (${p.abnormal === 'H' ? '偏高' : '偏低'})` : ''
      }`,
    };
  });
});

/** 参考范围矩形 (y, height) */
const refRect = computed<{ y: number; h: number } | null>(() => {
  const { low, high } = props.referenceRange;
  if (low === null || high === null) return null;
  const y = mapY(high);
  const yLow = mapY(low);
  return { y, h: yLow - y };
});

/** 危急高值虚线 y */
const criticalHighY = computed<number | null>(() => {
  if (props.thresholds?.criticalHigh === null || props.thresholds?.criticalHigh === undefined) {
    return null;
  }
  return mapY(props.thresholds.criticalHigh);
});

/** 危急低值虚线 y */
const criticalLowY = computed<number | null>(() => {
  if (props.thresholds?.criticalLow === null || props.thresholds?.criticalLow === undefined) {
    return null;
  }
  return mapY(props.thresholds.criticalLow);
});
</script>

<template>
  <div class="trend-chart-wrapper">
    <svg
      :viewBox="`0 0 ${W} ${H}`"
      class="trend-chart"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="化验指标趋势图"
    >
      <!-- 背景 -->
      <rect :x="PAD_LEFT" :y="PAD_TOP" :width="PLOT_W" :height="PLOT_H" class="plot-bg" />

      <!-- 参考范围带 -->
      <rect
        v-if="refRect"
        :x="PAD_LEFT"
        :y="refRect.y"
        :width="PLOT_W"
        :height="refRect.h"
        class="ref-band"
      />

      <!-- Y 轴 tick 线 + 标签 -->
      <g class="y-axis">
        <line
          v-for="(t, i) in yTicks"
          :key="`y-${i}`"
          :x1="PAD_LEFT"
          :x2="W - PAD_RIGHT"
          :y1="t.y"
          :y2="t.y"
          class="tick-line"
        />
        <text
          v-for="(t, i) in yTicks"
          :key="`yl-${i}`"
          :x="PAD_LEFT - 8"
          :y="t.y + 3"
          text-anchor="end"
          class="tick-label"
        >
          {{ t.label }}
        </text>
      </g>

      <!-- 危急阈值虚线 -->
      <line
        v-if="criticalHighY !== null"
        :x1="PAD_LEFT"
        :x2="W - PAD_RIGHT"
        :y1="criticalHighY"
        :y2="criticalHighY"
        class="threshold-high"
      />
      <line
        v-if="criticalLowY !== null"
        :x1="PAD_LEFT"
        :x2="W - PAD_RIGHT"
        :y1="criticalLowY"
        :y2="criticalLowY"
        class="threshold-low"
      />

      <!-- X 轴 tick 标签 -->
      <g class="x-axis">
        <text
          v-for="(t, i) in xTicks"
          :key="`x-${i}`"
          :x="t.x"
          :y="H - PAD_BOTTOM + 20"
          text-anchor="middle"
          class="tick-label"
        >
          {{ t.label }}
        </text>
      </g>

      <!-- 数据折线 -->
      <polyline
        v-if="points.length > 1"
        :points="polylinePoints"
        class="data-line"
        fill="none"
      />

      <!-- 数据点 -->
      <circle
        v-for="(p, i) in svgPoints"
        :key="`p-${i}`"
        :cx="p.cx"
        :cy="p.cy"
        :r="5"
        :class="['data-point', p.cls]"
      >
        <title>{{ p.tooltip }}</title>
      </circle>
    </svg>

    <!-- 图例 -->
    <div class="legend">
      <span class="legend-item">
        <span class="legend-dot normal"></span>正常
      </span>
      <span class="legend-item">
        <span class="legend-dot high"></span>偏高
      </span>
      <span class="legend-item">
        <span class="legend-dot low"></span>偏低
      </span>
      <span v-if="refRect" class="legend-item">
        <span class="legend-band"></span>参考范围
      </span>
      <span v-if="criticalHighY !== null || criticalLowY !== null" class="legend-item">
        <span class="legend-line"></span>危急阈值
      </span>
    </div>
  </div>
</template>

<style scoped>
.trend-chart-wrapper {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
}

.trend-chart {
  width: 100%;
  height: auto;
  max-height: 360px;
  display: block;
}

.plot-bg {
  fill: #fafafa;
  stroke: none;
}

.ref-band {
  fill: #d1fae5;
  fill-opacity: 0.5;
  stroke: none;
}

.tick-line {
  stroke: #e5e7eb;
  stroke-width: 1;
}

.tick-label {
  font-size: 11px;
  fill: #6b7280;
  font-family: system-ui, sans-serif;
}

.threshold-high,
.threshold-low {
  stroke: #dc2626;
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
  opacity: 0.7;
}

.data-line {
  stroke: #2563eb;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.data-point {
  stroke: white;
  stroke-width: 2;
}

.data-point.normal {
  fill: #2563eb;
}

.data-point.high {
  fill: #dc2626;
}

.data-point.low {
  fill: #f59e0b;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  margin-top: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid #f3f4f6;
  font-size: 0.78rem;
  color: #6b7280;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid white;
  box-shadow: 0 0 0 1px #e5e7eb;
}

.legend-dot.normal {
  background: #2563eb;
}

.legend-dot.high {
  background: #dc2626;
}

.legend-dot.low {
  background: #f59e0b;
}

.legend-band {
  display: inline-block;
  width: 14px;
  height: 10px;
  background: #d1fae6;
  background-color: rgba(209, 250, 229, 0.7);
  border: 1px solid #a7f3d0;
}

.legend-line {
  display: inline-block;
  width: 14px;
  height: 0;
  border-top: 1.5px dashed #dc2626;
}
</style>
