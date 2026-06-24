// ============================================================
// MedMemory — 成员年龄/年龄段共享工具
// ============================================================
// 用途:
//   - Avatar.vue 派生卡通头像变体 (gender × ageGroup)
//   - useAiProcess / useHealthAgent 给 AI prompt 传 memberAge
//
// 提取自 useAiProcess.ts:451 (computeAgeFromBirthday)
//      + useHealthAgent.ts:50 (ageFromBirthday) —— 之前是两份重复实现.
//
// 年龄段分界 (中国临床约定):
//   child:    < 14       儿科常规分界
//   young:    14..59     中青年
//   elderly:  >= 60      老年
//   unknown:  birthday 为空, 无法判定 → 视觉默认按 young 处理
// ============================================================

export type AgeGroup = 'child' | 'young' | 'elderly' | 'unknown';

/**
 * 从 YYYY-MM-DD 生日字符串算周岁. 返回 undefined 表示无法判定.
 *
 * 实现: 拆年月日 → 当前年 - 出生年, 然后根据 (月, 日) 是否过了调整.
 * 直接用 Date 对象算会出现 2/29 出生 + 平年的边角问题, 这里逐字段比较更稳.
 *
 * 边界过滤: age < 0 (未来生日) 或 >= 150 (明显脏数据) 返回 undefined.
 * 用本地时间 (非 UTC), 与 useHealthAgent 旧实现一致.
 *
 * 返回 undefined (非 null) 是为了和现有 AI request 字段 `memberAge?: number`
 * 保持兼容, 可以直接赋值不包 ?? undefined.
 */
export function computeAge(birthday: string | null | undefined): number | undefined {
  if (!birthday) return undefined;
  // YYYY-MM-DD 严格拆分; 不接受其他格式
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);
  if (m === null) return undefined;
  const birthY = Number(m[1]);
  const birthM = Number(m[2]);
  const birthD = Number(m[3]);
  if (!Number.isFinite(birthY) || !Number.isFinite(birthM) || !Number.isFinite(birthD)) {
    return undefined;
  }

  const now = new Date();
  const nowY = now.getFullYear();
  const nowM = now.getMonth() + 1;
  const nowD = now.getDate();

  let age = nowY - birthY;
  // 今年的生日还没到: 减 1
  if (nowM < birthM || (nowM === birthM && nowD < birthD)) {
    age -= 1;
  }
  return age >= 0 && age < 150 ? age : undefined;
}

/**
 * 把生日映射到头像年龄段. null/无效生日 → 'unknown'.
 * Avatar.vue 等消费方负责把 'unknown' 视觉降级到 'young'.
 */
export function computeAgeGroup(birthday: string | null | undefined): AgeGroup {
  const age = computeAge(birthday);
  if (age === undefined) return 'unknown';
  if (age < 14) return 'child';
  if (age < 60) return 'young';
  return 'elderly';
}
