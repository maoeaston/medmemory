// ============================================================
// MedMemory — AI Provider 抽象接口
// ============================================================
// 对应 PRD 7.6 v2: 单一多模态大模型 API, 一轮调用产出:
//   - doc_type 自动判型 + summary + ocr_fulltext + tags
//   - 化验单 (lab_report) 额外产出 lab_indicators 结构化指标
//
// 设计:
//   - v1 只实现 OpenAiProvider (GPT-4o)
//   - 接口先抽出, 后续 Claude / Gemini 实现可平行加入
//   - 输入只接受原始 Blob, base64 编码由 provider 内部处理
//     （不同 provider 编码方式可能不同, 如 Anthropic 用 base64 source 而非 data URL）
// ============================================================

import type { DocType } from '@/repositories';

/**
 * 单次 AI 处理请求。
 * prompt 为医疗档案助理系统 prompt（来自 prompts.ts MEDICAL_DOCUMENT_PROMPT）。
 */
export interface MultimodalRequest {
  /** 医疗资料图片原件（jpg/png/webp/gif）, PDF 不在 v1 范围 */
  imageBlob: Blob;
  /** 系统 prompt */
  prompt: string;
}

/**
 * 纯文本事件 AI 推荐请求（v3.1 PRD 7.4 体验完善）。
 *
 * 与 MultimodalRequest 区别:
 *   - 无 imageBlob, 输入只有事件文本（title + summary + 类型）
 *   - 输出只有 suggestedHealthProblems, 不产出 summary/ocr/lab_indicators
 *
 * 用途: 无附件的事件也允许 AI 推荐健康问题, 复用 health-problem 推荐闭环。
 */
export interface TextSuggestionRequest {
  title: string;
  summary: string | null;
  event_type: string;
  /** 成员年龄（已知则传, 提升 prompt 准确性） */
  memberAge?: number;
  /** 成员性别（已知则传） */
  memberGender?: string;
  prompt: string;
}

/**
 * 化验单单项指标（LLM 产出, 与 report_indicators 表对齐）。
 * 字段含义见 db/migrations/002_lab_indicators.sql。
 */
export interface LabIndicatorExtracted {
  name_cn: string;
  name_en: string | null;
  result: string;
  unit: string | null;
  reference_range: string | null;
  abnormal_tag: 'H' | 'L' | 'N' | null;
}

/**
 * AI 推荐的健康问题（v3.1 PRD 7.4 一键确认）。
 *
 * 不直接落 health_problems 表 — 先写 ai_contents 待用户确认。
 * 原因见 plan: 严格遵循 PRD "一键确认" 交互。
 */
export interface SuggestedHealthProblem {
  /** 健康问题名称, 2-10 字, 如 "反复呼吸道感染" / "高血压随访" */
  name: string;
  /** 置信度: high (图片明确提及) / medium (症状推断) / low (少用) */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * 单次 AI 处理产出（v3: doc_type 路由 + 化验单结构化 + 健康问题推荐）。
 */
export interface AiProcessingResult {
  /** LLM 判型结果, 写入 attachments.doc_type */
  docType: DocType;
  /** 化验单细分（血常规/尿常规/...）, 仅 lab_report 有意义, 其他 null */
  reportType: string | null;
  /** 报告日期 YYYY-MM-DD 或 null */
  testDate: string | null;
  /** 医院名称或 null */
  hospitalName: string | null;
  /** 结构化摘要, PII 不入（PRD line 287 约束） */
  summary: string;
  /** 完整 OCR 全文, 保留 PII */
  ocrFulltext: string;
  /** 内容标签, 3-8 个短词 */
  tags: string[];
  /**
   * 化验单指标集（仅 doc_type=lab_report 时非空）。
   * display_order 由数组顺序决定, useAiProcess 写入时按下标填。
   */
  labIndicators: LabIndicatorExtracted[];
  /**
   * AI 推荐的健康问题集（v3 新增）。
   * 空数组 = 无推荐 / 推荐被 LLM 跳过。
   * 每个 suggestion 写入 ai_contents (content_type='suggested_health_problems'),
   * 用户确认/跳过后应用层 delete。
   */
  suggestedHealthProblems: SuggestedHealthProblem[];
}

/**
 * 化验单解读请求（v3.2 PRD §2.1）。
 *
 * 输入: 已结构化的 lab_indicators + 事件 summary + 可选成员年龄/性别。
 * 输出: LabInterpretation（参考性解读, 不替代医生）。
 */
export interface LabInterpretationRequest {
  /** 已结构化的化验指标（应用层从 report_indicators 表读取后映射） */
  indicators: LabIndicatorExtracted[];
  /** 事件摘要（精炼主诉, 提供上下文） */
  eventSummary: string | null;
  /** 成员年龄（推算自 family_members.birthday, 缺失则 undefined） */
  memberAge?: number;
  /** 成员性别, 缺失则 undefined */
  memberGender?: string;
  prompt: string;
}

/**
 * 化验单解读结果（v3.2 PRD §2.1）。
 *
 * 注意:
 *   - urgency 是 LLM 软判断, 前端硬规则（criticalValue.ts）会覆盖
 *   - ai_interpretations.content_json 存此结构, 危急值实时叠加不落库
 */
export interface LabInterpretation {
  /** 整体印象, 1-2 句话总结异常模式 */
  overallImpression: string;
  /** LLM 软判断紧急程度（UI 展示时叠加硬规则覆盖） */
  urgency: 'observe' | 'suggest_visit' | 'urgent_visit';
  /** 异常项逐条解读, 顺序按 lab_indicators 原序 */
  abnormalExplanations: Array<{
    /** 对应 lab_indicators.name_cn */
    indicatorName: string;
    /** 这个指标偏高/偏低通常意味着什么, 1-2 句 */
    interpretation: string;
    /** 可能原因, 2-4 个简短词 */
    possibleCauses: string[];
  }>;
  /** 综合建议（如「建议结合既往化验趋势」「建议进一步检查 X」） */
  recommendation: string;
  /** 建议就诊科室（必须从预定义白名单选, 见 PRD 附录 A + OpenAiProvider.validateDepartments） */
  suggestedDepartments: string[];
}

/**
 * 用药指南请求（v3.2 PRD §2.2）。
 */
export interface MedicationGuideRequest {
  /** 目标药物基本信息 */
  medicine: {
    name: string;
    usage: string | null;
    remark: string | null;
  };
  /** 同成员其他药物（用于检查相互作用, 空数组表示单药） */
  otherMedicines: Array<{ name: string }>;
  /** 同成员既往健康问题（用于既往史警示） */
  healthProblems: Array<{ name: string }>;
  /** 成员年龄 */
  memberAge?: number;
  /** 成员性别 */
  memberGender?: string;
  prompt: string;
}

/**
 * 用药指南结果（v3.2 PRD §2.2）。
 */
export interface MedicationGuide {
  /** 药物通用说明 (1-2 句, 该药主要用于什么) */
  overview: string;
  /** 用法用量通用范围 (说明书常规, 不根据体重/年龄计算个人剂量) */
  usualDosage: string;
  /** 常见副作用 top 3-5 */
  commonSideEffects: string[];
  /** 严重副作用 (需立即停药就医, ≤3 条) */
  seriousSideEffects: string[];
  /** 相互作用警示 (与同成员其他药物的已知相互作用; 无其他药物时空数组) */
  interactions: Array<{
    /** 对应另一条 medicines.name (校验: 必须在 otherMedicines 子集, 防编造) */
    otherMedicine: string;
    /** 相互作用描述 */
    description: string;
    severity: 'mild' | 'moderate' | 'severe';
  }>;
  /** 红旗警示 (成员特定: 儿童/孕妇/老年人/肝肾功能不全等慎用) */
  redFlags: string[];
  /** 是否需要医生指导使用 (处方药/特殊管理药品 true, OTC false) */
  requiresPrescription: boolean;
}

/**
 * AI Provider 抽象。每个 provider 只管"图片 → 三输出"这一件事。
 * 状态机推进 / ai_contents 写入 / tags 落盘由 useAiProcess 编排。
 */
export interface AiProvider {
  /** provider 标识, 写入 ai_contents.model 字段（如 'gpt-4o'） */
  readonly model: string;
  /** 执行多模态调用, 返回结构化结果 */
  processMedicalDocument(req: MultimodalRequest): Promise<AiProcessingResult>;
  /**
   * 纯文本事件推荐健康问题（v3.1 PRD 7.4 体验完善）。
   *
   * 输入无图片, 仅基于事件 title/summary/event_type + 可选成员信息。
   * 输出与图片版 suggestedHealthProblems 同结构, 写入 ai_contents 复用确认闭环。
   */
  suggestHealthProblemsFromText(
    req: TextSuggestionRequest,
  ): Promise<SuggestedHealthProblem[]>;
  /**
   * 化验单解读（v3.2 PRD §2.1）。
   *
   * 输入已结构化指标 + 上下文, 输出参考性解读 + 建议就诊科室。
   * 紧急程度 urgency 是 LLM 软判断, 前端硬规则会覆盖（见 criticalValue.ts）。
   */
  interpretLabResult(req: LabInterpretationRequest): Promise<LabInterpretation>;
  /**
   * 用药指南（v3.2 PRD §2.2）。
   *
   * 输入药物 + 同成员其他药物 + 既往健康问题, 输出用药参考指南。
   * 不开新处方, 不算个人剂量, 仅解读已存在药物。
   */
  guideMedication(req: MedicationGuideRequest): Promise<MedicationGuide>;
}

/**
 * provider 调用错误类型, 让 UI 能区分 401 / 网络 / 解析失败。
 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unauthorized' // 401 / 403 — API key 无效
      | 'rate-limit' // 429
      | 'http-error' // 其他 4xx / 5xx
      | 'network' // fetch reject
      | 'bad-response' // JSON 解析失败 / 字段缺失
      | 'unknown',
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
