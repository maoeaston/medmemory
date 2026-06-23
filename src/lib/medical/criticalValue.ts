// ============================================================
// MedMemory — 危急值硬规则 mini-parser (v3.2 PRD §2.1)
// ============================================================
// 设计原则:
//   - LLM urgency 是软判断, 会 drift; 危急值必须由硬规则覆盖
//   - 此文件是纯函数, 不依赖 DB / AI provider, 可独立单测
//   - UI 层实时叠加（不落库）: LabInterpretationModal 渲染时调用
//
// 三层检测:
//   1. 关键词白名单 + 绝对阈值（血钾/血糖/血钠/血红蛋白 等核心）
//   2. 2× 兜底规则: abnormal_tag='H' 且 result > high*2, 或 'L' 且 result < low/2
//   3. text rule: 单位无关的关键词警示（仅作辅助, 不强制就医）
//
// 输入只读 LabIndicator 字段（来自 report_indicators 表）。
// 输出 CriticalValueAlert[], 空数组 = 无危急值。
// ============================================================

import type { LabIndicator } from '@/repositories';

/**
 * 危急值告警。
 */
export interface CriticalValueAlert {
  /** 对应 lab_indicators.id */
  indicatorId: number;
  /** 对应 lab_indicators.name_cn */
  indicatorName: string;
  /** 触发规则类型 */
  rule: 'whitelist_low' | 'whitelist_high' | 'twofold_high' | 'twofold_low';
  /** 测定值（数值化后） */
  value: number;
  /** 阈值 */
  threshold: number;
  /** 单位（若可识别） */
  unit: string | null;
  /** 人类可读描述（UI 展示用） */
  description: string;
}

/**
 * 关键词白名单规则（按 name_cn 关键词匹配 + 绝对阈值）。
 *
 * MVP 6 项核心电解质/血液指标:
 *   - 血钾 (potassium / K+)
 *   - 血钠 (sodium / Na+)
 *   - 血糖 (glucose / GLU)
 *   - 血红蛋白 (hemoglobin / HGB)
 *   - 血钙 (calcium / Ca)
 *   - 白细胞计数 (WBC)
 *
 * 关键词用 includes 子串匹配, 兼容"血清钾""血钾(K+)"等变体。
 */
interface WhitelistRule {
  /** name_cn 匹配关键词（小写比较） */
  keywords: string[];
  /** 低危急阈值（< 此值触发） */
  criticalLow: number | null;
  /** 高危急阈值（> 此值触发） */
  criticalHigh: number | null;
  /** 指标中文名（用于 description） */
  displayName: string;
}

const WHITELIST_RULES: WhitelistRule[] = [
  {
    keywords: ['血钾', '钾离子', '血清钾', 'k+'],
    criticalLow: 3.0,
    criticalHigh: 6.0,
    displayName: '血钾',
  },
  {
    keywords: ['血钠', '钠离子', '血清钠', 'na+'],
    criticalLow: 120,
    criticalHigh: 160,
    displayName: '血钠',
  },
  {
    keywords: ['血糖', '葡萄糖', 'glu', '空腹血糖'],
    criticalLow: 2.2,
    criticalHigh: 33.3,
    displayName: '血糖',
  },
  {
    keywords: ['血红蛋白', 'hemoglobin', 'hgb', 'hb'],
    criticalLow: 60,
    criticalHigh: 200,
    displayName: '血红蛋白',
  },
  {
    keywords: ['血钙', '钙离子', '血清钙', 'ca'],
    criticalLow: 1.75,
    criticalHigh: 3.5,
    displayName: '血钙',
  },
  {
    keywords: ['白细胞', 'wbc', '白细胞计数'],
    criticalLow: 2,
    criticalHigh: 30,
    displayName: '白细胞',
  },
];

/**
 * 从文本结果中解析数值。
 *
 * 支持格式:
 *   - "9.5" → 9.5
 *   - ">10.0" → 10.0（取数字部分）
 *   - "<5.0" → 5.0
 *   - "9.5 ↑" → 9.5
 *   - "阴性" / "阳性" / "1:80" / "+-" → null
 *
 * 取第一个匹配的数字（支持小数和负号）。
 */
export function parseNumericResult(text: string | null | undefined): number | null {
  if (!text) return null;
  // 匹配可选负号 + 数字（含小数）
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析参考范围为 { low, high }。
 *
 * 支持格式:
 *   - "4.0-10.0" / "4.0~10.0" → { low: 4.0, high: 10.0 }
 *   - "<5.0" → { low: null, high: 5.0 }
 *   - ">2.0" → { low: 2.0, high: null }
 *   - "阴性" / 无范围 → { low: null, high: null }
 */
export function parseReferenceRange(
  text: string | null | undefined,
): { low: number | null; high: number | null } {
  if (!text) return { low: null, high: null };
  const trimmed = text.trim();
  if (trimmed === '') return { low: null, high: null };

  // 范围格式: "4.0-10.0" / "4.0~10.0" / "4.0 – 10.0"
  const rangeMatch = trimmed.match(/^([<>]?\s*-?\d+(?:\.\d+)?)\s*[-–~]\s*([<>]?\s*-?\d+(?:\.\d+)?)\s*$/);
  if (rangeMatch) {
    const low = parseNumericResult(rangeMatch[1]);
    const high = parseNumericResult(rangeMatch[2]);
    return { low, high };
  }

  // 单边: "<5.0" / "≤ 5.0"
  const upperMatch = trimmed.match(/^[<≤]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (upperMatch) {
    return { low: null, high: Number(upperMatch[1]) };
  }

  // 单边: ">2.0" / "≥ 2.0"
  const lowerMatch = trimmed.match(/^[>≥]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (lowerMatch) {
    return { low: Number(lowerMatch[1]), high: null };
  }

  return { low: null, high: null };
}

/**
 * 在 name_cn 中找首个匹配的白名单规则。
 * 匹配策略: lowercase 后子串 includes。
 */
function findWhitelistRule(
  nameCn: string,
  nameEn: string | null,
): WhitelistRule | null {
  const haystack = `${nameCn} ${nameEn ?? ''}`.toLowerCase();
  for (const rule of WHITELIST_RULES) {
    if (rule.keywords.some((kw) => haystack.includes(kw.toLowerCase()))) {
      return rule;
    }
  }
  return null;
}

/**
 * 检查所有指标的危急值。
 *
 * 调用时机:
 *   - LabInterpretationModal 渲染时实时调用（不落库）
 *   - 返回的 alerts 即使 LLM 返回 urgency='observe', UI 也强制红色高亮
 *
 * 算法:
 *   1. 白名单匹配: name_cn 关键词命中 → 比对绝对阈值（criticalLow/criticalHigh）
 *   2. 2× 兜底: abnormal_tag='H' 且 result > reference_range.high * 2 → 高危急
 *                abnormal_tag='L' 且 result < reference_range.low / 2 → 低下危
 *
 * 同一指标可能触发多个规则（白名单 + 2×）— 去重保留首个。
 */
export function checkCriticalValues(
  indicators: LabIndicator[],
): CriticalValueAlert[] {
  const alerts: CriticalValueAlert[] = [];
  const seen = new Set<number>(); // 同一 indicatorId 只产 1 条

  for (const ind of indicators) {
    if (seen.has(ind.id)) continue;
    const value = parseNumericResult(ind.result);
    if (value === null) continue; // 非数值结果跳过

    // 1. 白名单规则匹配
    const rule = findWhitelistRule(ind.name_cn, ind.name_en);
    if (rule) {
      if (rule.criticalLow !== null && value < rule.criticalLow) {
        alerts.push({
          indicatorId: ind.id,
          indicatorName: ind.name_cn,
          rule: 'whitelist_low',
          value,
          threshold: rule.criticalLow,
          unit: ind.unit,
          description: `${rule.displayName} ${value}${ind.unit ?? ''} < 危急低值 ${rule.criticalLow}${ind.unit ?? ''}`,
        });
        seen.add(ind.id);
        continue;
      }
      if (rule.criticalHigh !== null && value > rule.criticalHigh) {
        alerts.push({
          indicatorId: ind.id,
          indicatorName: ind.name_cn,
          rule: 'whitelist_high',
          value,
          threshold: rule.criticalHigh,
          unit: ind.unit,
          description: `${rule.displayName} ${value}${ind.unit ?? ''} > 危急高值 ${rule.criticalHigh}${ind.unit ?? ''}`,
        });
        seen.add(ind.id);
        continue;
      }
    }

    // 2. 2× 兜底规则（基于参考范围倍数）
    if (ind.abnormal_tag === 'H' || ind.abnormal_tag === 'L') {
      const range = parseReferenceRange(ind.reference_range);
      if (ind.abnormal_tag === 'H' && range.high !== null && value > range.high * 2) {
        alerts.push({
          indicatorId: ind.id,
          indicatorName: ind.name_cn,
          rule: 'twofold_high',
          value,
          threshold: range.high * 2,
          unit: ind.unit,
          description: `${ind.name_cn} ${value}${ind.unit ?? ''} 远超参考上限 ${range.high}${ind.unit ?? ''}（2× 以上）`,
        });
        seen.add(ind.id);
      } else if (ind.abnormal_tag === 'L' && range.low !== null && range.low > 0 && value < range.low / 2) {
        alerts.push({
          indicatorId: ind.id,
          indicatorName: ind.name_cn,
          rule: 'twofold_low',
          value,
          threshold: range.low / 2,
          unit: ind.unit,
          description: `${ind.name_cn} ${value}${ind.unit ?? ''} 远低于参考下限 ${range.low}${ind.unit ?? ''}（半数以下）`,
        });
        seen.add(ind.id);
      }
    }
  }

  return alerts;
}
