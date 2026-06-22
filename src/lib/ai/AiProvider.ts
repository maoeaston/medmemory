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
 * 单次 AI 处理产出（v2: doc_type 路由 + 化验单结构化）。
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
