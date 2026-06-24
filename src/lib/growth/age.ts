// ============================================================
// MedMemory — 生长曲线月龄计算
// ============================================================
// 用途: growth_records.age_months 派生 + WHO 百分位插值 + UI 展示。
//
// 约定:
//   - 月龄按"日历月差 + 日的比例补偿"算, 含小数, 便于 LMS 线性插值。
//   - 日补偿用平均月长 30.4375 天折算 (365.25/12), WHO 月度 LMS 精度足够。
//   - date 早于 birthday 返回负数, 调用方应校验。
// ============================================================

/**
 * 计算从 birthday 到 date 的月龄（含小数）。
 * @param birthday 'YYYY-MM-DD'
 * @param date 'YYYY-MM-DD'
 * @returns 月龄; date 早于 birthday 为负
 */
export function monthsBetween(birthday: string, date: string): number {
  const b = new Date(birthday + 'T00:00:00Z');
  const d = new Date(date + 'T00:00:00Z');
  const months =
    (d.getUTCFullYear() - b.getUTCFullYear()) * 12 +
    (d.getUTCMonth() - b.getUTCMonth());
  const dayDiff = d.getUTCDate() - b.getUTCDate();
  return months + dayDiff / 30.4375;
}

/**
 * 把月龄格式化成人类可读：
 *   - <24 月 → "N 月"
 *   - >=24 月 → "X 岁 Y 月"
 * @param months 月龄（含小数，会四舍五入到整月）
 */
export function formatAgeMonths(months: number): string {
  if (months < 0) return '—';
  // <24 月用原始值判断 (23.6 月还没满 2 岁, 应显示"24 月"而非"2 岁");
  // >=24 月时先四舍五入再算 years/rem, 避免 rem=12 (如 35.5→36→"3 岁"而非"2 岁 12 月")
  if (months < 24) return `${Math.round(months)} 月`;
  const rounded = Math.round(months);
  const years = Math.floor(rounded / 12);
  const rem = rounded % 12;
  return rem === 0 ? `${years} 岁` : `${years} 岁 ${rem} 月`;
}
