// ============================================================
// MedMemory — WHO 生长标准百分位计算 (纯函数, 无副作用)
// ============================================================
// 输入: LMS 表 (常量, 由 who-lms-data.ts 提供) + 月龄 + 测量值。
// 输出: z-score 与百分位 (0-100)。
//
// 数学来源: WHO Child Growth Standards (LMS 方法)。
//   - z = ((value/M)^L - 1) / (L*S)        (L ≠ 0)
//   - z = ln(value/M) / S                  (L = 0)
//   - 百分位 = Φ(z) × 100, Φ 为标准正态 CDF。
//
// CDF 用 Abramowitz & Stegun 7.1.26 (erf 有理近似), Φ 最大误差 < 1.5e-7,
// 远低于百分位整数显示所需精度。
// ============================================================

/** LMS 表的一行 (月龄 → L, M, S)。与 who-lms-data.ts 的结构一致。 */
export interface LmsRow {
  month: number;
  L: number;
  M: number;
  S: number;
}

/** 测量指标 (与 LMS 表一一对应) */
export type GrowthMetric = 'height' | 'weight';

/**
 * 标准正态 CDF Φ(z)。
 * 用 erf 近似: Φ(z) = 0.5 × (1 + erf(z/√2)); erf 用 A&S 7.1.26。
 */
export function normalCdf(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  // Horner 形式: a1 t + a2 t² + ... + a5 t⁵
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
    t;
  const erfAbs = 1 - poly * Math.exp(-x * x);
  const erf = z >= 0 ? erfAbs : -erfAbs;
  const result = 0.5 * (1 + erf);
  // 钳到 [0,1]: A&S 近似在 |z|>3.8 时 erfAbs 可能略超 1, 导致 result 微超 1
  if (result < 0) return 0;
  if (result > 1) return 1;
  return result;
}

/** 由 L, M, S 与测量值算 z-score。 */
export function zFromLMS(L: number, M: number, S: number, value: number): number {
  if (L === 0) {
    return Math.log(value / M) / S;
  }
  return (Math.pow(value / M, L) - 1) / (L * S);
}

/** 由 z-score 反算测量值 (画百分位参考曲线用)。 */
export function valueFromZ(L: number, M: number, S: number, z: number): number {
  if (L === 0) {
    return M * Math.exp(S * z);
  }
  return M * Math.pow(L * S * z + 1, 1 / L);
}

/** z-score → 百分位 (0-100)。 */
export function percentileFromZ(z: number): number {
  return normalCdf(z) * 100;
}

/**
 * 在 LMS 表上按月龄线性插值得到 {L,M,S}。
 * - 月龄超出表范围 (如 <0 或 >60) 返回 null。
 * - 命中整月直接返回; 否则在相邻两月间线性插值 L/M/S。
 */
export function interpolateLMS(
  table: readonly LmsRow[],
  ageMonths: number,
): LmsRow | null {
  if (table.length === 0) return null;
  const first = table[0];
  const last = table[table.length - 1];
  if (ageMonths < first.month || ageMonths > last.month) return null;

  // 找到 month <= ageMonths 的最后一行
  let lo = 0;
  for (let i = 0; i < table.length; i++) {
    if (table[i].month <= ageMonths) lo = i;
    else break;
  }
  const a = table[lo];
  if (a.month === ageMonths) return { ...a };
  const b = table[lo + 1] ?? a;
  const span = b.month - a.month || 1;
  const frac = (ageMonths - a.month) / span;
  return {
    month: ageMonths,
    L: a.L + (b.L - a.L) * frac,
    M: a.M + (b.M - a.M) * frac,
    S: a.S + (b.S - a.S) * frac,
  };
}

export interface PercentileResult {
  z: number;
  percentile: number; // 0-100
}

/**
 * 由 LMS 表 + 月龄 + 测量值算百分位。
 * 月龄超出表范围返回 null (UI 提示"超出 WHO 标准覆盖年龄")。
 */
export function percentileForValue(
  table: readonly LmsRow[],
  ageMonths: number,
  value: number,
): PercentileResult | null {
  const lms = interpolateLMS(table, ageMonths);
  if (!lms) return null;
  const z = zFromLMS(lms.L, lms.M, lms.S, value);
  return { z, percentile: percentileFromZ(z) };
}

// ============================================================
// 参考百分位曲线 (画图用)
// ============================================================

/** 画参考曲线用的标准百分位 → z-score (查标准正态表, 精确到 4 位)。 */
export const REFERENCE_PERCENTILES: ReadonlyArray<{
  percentile: number;
  z: number;
  label: string;
}> = [
  { percentile: 3, z: -1.8808, label: '3%' },
  { percentile: 15, z: -1.0364, label: '15%' },
  { percentile: 50, z: 0, label: '50%' },
  { percentile: 85, z: 1.0364, label: '85%' },
  { percentile: 97, z: 1.8808, label: '97%' },
];
