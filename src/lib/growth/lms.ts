// ============================================================
// MedMemory — LMS 表选择 + 指标元信息
// ============================================================
// 按 (性别, 指标) 选出对应的 WHO LMS 表, 供 GrowthChart 与百分位计算用。
// ============================================================
import type { GrowthMetric, LmsRow } from './percentile';
import { BOYS_HFA, BOYS_WFA, GIRLS_HFA, GIRLS_WFA } from './who-lms-data';

export type GrowthGender = 'male' | 'female';

/** 按 (性别, 指标) 选 WHO LMS 表。 */
export function selectLmsTable(gender: GrowthGender, metric: GrowthMetric): LmsRow[] {
  if (metric === 'height') {
    return gender === 'male' ? BOYS_HFA : GIRLS_HFA;
  }
  return gender === 'male' ? BOYS_WFA : GIRLS_WFA;
}

/** 指标的中文标签 + 单位 (UI 用)。 */
export const METRIC_META: Record<GrowthMetric, { label: string; unit: string }> = {
  height: { label: '身高/身长', unit: 'cm' },
  weight: { label: '体重', unit: 'kg' },
};
