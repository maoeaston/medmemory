// ============================================================
// MedMemory — OpenAI Provider 实现（GPT-4o Vision）
// ============================================================
// 对应 PRD 7.6 + ADR（待补）: v1 默认 provider
//
// 调用模式:
//   POST https://api.openai.com/v1/chat/completions
//   model: gpt-4o
//   response_format: { type: 'json_object' }   ← 强制 JSON
//   messages:
//     [0] role=system, content=<prompt>
//     [1] role=user, content=[{ type:'image_url', image_url:{ url: <data URL> } }]
//
// 图片编码: FileReader.readAsDataURL → "data:image/jpeg;base64,..."
//   OpenAI 接受 png/jpeg/webp/gif, 当前 capture 仅产出 jpg, 兼容
//
// 错误分类:
//   401/403 → unauthorized（API key 问题）
//   429     → rate-limit
//   4xx/5xx → http-error
//   fetch reject → network
//   JSON 解析失败 / 字段缺失 → bad-response
// ============================================================

import {
  AiProviderError,
  type AiProvider,
  type AiProcessingResult,
  type LabIndicatorExtracted,
  type MultimodalRequest,
} from './AiProvider';
import type { DocType } from '@/repositories';

/**
 * v2 合法 doc_type 值（与 attachments.doc_type CHECK 对齐）。
 */
const VALID_DOC_TYPES: ReadonlySet<DocType> = new Set([
  'lab_report',
  'prescription',
  'imaging_report',
  'outpatient_record',
  'discharge_summary',
  'receipt',
  'other',
]);

/**
 * v2 合法 abnormal_tag 值（与 report_indicators.abnormal_tag CHECK 对齐）。
 */
const VALID_ABNORMAL_TAGS = new Set(['H', 'L', 'N']);

const DEFAULT_MODEL = 'gpt-4o';
const API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * OpenAI Vision API 请求体（只填我们用的字段）。
 */
interface OpenAiChatRequest {
  model: string;
  messages: [
    { role: 'system'; content: string },
    {
      role: 'user';
      content: Array<{
        type: 'image_url';
        image_url: { url: string };
      }>;
    },
  ];
  response_format: { type: 'json_object' };
  /**
   * 控制输出确定性。医疗档案场景优先稳定, 但完全 0 会限制模型对模糊原文的合理推断。
   * 0.2 是经验值（OpenAI 默认 1）。
   */
  temperature?: number;
}

/**
 * OpenAI Chat 响应（只取我们关心的字段）。
 */
interface OpenAiChatResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 期望的 JSON 输出 schema（prompt v2 强制）。
 */
interface ExpectedJsonOutput {
  doc_type: unknown;
  report_type: unknown;
  test_date: unknown;
  hospital_name: unknown;
  summary: unknown;
  ocr_fulltext: unknown;
  tags: unknown;
  lab_indicators: unknown;
}

export class OpenAiProvider implements AiProvider {
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string = DEFAULT_MODEL,
  ) {
    if (!apiKey) {
      throw new AiProviderError(
        'OpenAI API key 为空, 请到设置页配置',
        'unauthorized',
      );
    }
    this.model = model;
  }

  async processMedicalDocument(
    req: MultimodalRequest,
  ): Promise<AiProcessingResult> {
    const dataUrl = await blobToDataUrl(req.imageBlob);
    const body: OpenAiChatRequest = {
      model: this.model,
      messages: [
        { role: 'system', content: req.prompt },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: dataUrl } }],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    };

    let resp: Response;
    try {
      resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new AiProviderError(
        `网络请求失败: ${e instanceof Error ? e.message : String(e)}`,
        'network',
      );
    }

    if (!resp.ok) {
      throw await httpErrorFromResponse(resp);
    }

    let json: OpenAiChatResponse;
    try {
      json = (await resp.json()) as OpenAiChatResponse;
    } catch (e) {
      throw new AiProviderError(
        `响应 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
        'bad-response',
        resp.status,
      );
    }

    const rawContent = json.choices?.[0]?.message?.content;
    if (typeof rawContent !== 'string') {
      throw new AiProviderError(
        '响应缺少 choices[0].message.content',
        'bad-response',
        resp.status,
      );
    }

    return parseMedicalDocumentJson(rawContent);
  }
}

// ============================================================
// helpers
// ============================================================

/**
 * Blob → data URL（base64）, 喂给 OpenAI image_url 字段。
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new AiProviderError('FileReader 返回非字符串', 'bad-response'));
      }
    };
    reader.onerror = () => {
      reject(
        new AiProviderError(
          `FileReader 失败: ${reader.error?.message ?? '未知错误'}`,
          'bad-response',
        ),
      );
    };
    reader.readAsDataURL(blob);
  });
}

async function httpErrorFromResponse(resp: Response): Promise<AiProviderError> {
  let bodyText = '';
  try {
    bodyText = await resp.text();
  } catch {
    // swallow, bodyText 留空
  }
  const code: AiProviderError['code'] =
    resp.status === 401 || resp.status === 403
      ? 'unauthorized'
      : resp.status === 429
        ? 'rate-limit'
        : 'http-error';
  // OpenAI 错误响应通常是 {"error":{"message":"..."}}, 尝试解析
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // 非 JSON, 用原始 bodyText
  }
  return new AiProviderError(
    `OpenAI ${resp.status} ${resp.statusText}: ${detail}`,
    code,
    resp.status,
  );
}

/**
 * 解析 GPT-4o 返回的 JSON 字符串为结构化结果（v2 schema）。
 *
 * response_format: json_object 强制合法 JSON, 但仍校验字段类型防 prompt drift。
 * 校验失败一律抛 AiProviderError('bad-response'), 让 useAiProcess 走 FAILED 路径。
 */
function parseMedicalDocumentJson(raw: string): AiProcessingResult {
  let parsed: ExpectedJsonOutput;
  try {
    parsed = JSON.parse(raw) as ExpectedJsonOutput;
  } catch (e) {
    throw new AiProviderError(
      `GPT 输出 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}。原始: ${raw.slice(0, 200)}`,
      'bad-response',
    );
  }

  const {
    doc_type,
    report_type,
    test_date,
    hospital_name,
    summary,
    ocr_fulltext,
    tags,
    lab_indicators,
  } = parsed;

  // doc_type: 必须是合法枚举
  if (typeof doc_type !== 'string' || !VALID_DOC_TYPES.has(doc_type as DocType)) {
    throw new AiProviderError(
      `GPT 输出 doc_type 非法: ${JSON.stringify(doc_type).slice(0, 100)}`,
      'bad-response',
    );
  }
  const typedDocType = doc_type as DocType;

  // report_type / hospital_name: string 或 null
  const typedReportType = validateStringOrNull(report_type, 'report_type');
  const typedHospitalName = validateStringOrNull(
    hospital_name,
    'hospital_name',
  );

  // test_date: YYYY-MM-DD 或 null
  const typedTestDate = validateDateStringOrNull(test_date);

  // summary / ocr_fulltext: string
  if (typeof summary !== 'string') {
    throw new AiProviderError(
      `GPT 输出 summary 字段非 string: ${typeof summary}`,
      'bad-response',
    );
  }
  if (typeof ocr_fulltext !== 'string') {
    throw new AiProviderError(
      `GPT 输出 ocr_fulltext 字段非 string: ${typeof ocr_fulltext}`,
      'bad-response',
    );
  }

  // tags: string[]
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    throw new AiProviderError(
      `GPT 输出 tags 字段非 string[]: ${JSON.stringify(tags).slice(0, 100)}`,
      'bad-response',
    );
  }

  // lab_indicators: 数组, 元素必须符合 LabIndicatorExtracted
  const typedLabIndicators = validateLabIndicators(
    lab_indicators,
    typedDocType,
  );

  return {
    docType: typedDocType,
    reportType: typedReportType,
    testDate: typedTestDate,
    hospitalName: typedHospitalName,
    summary,
    ocrFulltext: ocr_fulltext,
    tags,
    labIndicators: typedLabIndicators,
  };
}

function validateStringOrNull(
  v: unknown,
  fieldName: string,
): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v || null; // 空串视为 null
  throw new AiProviderError(
    `GPT 输出 ${fieldName} 字段类型错误: ${typeof v}`,
    'bad-response',
  );
}

/**
 * test_date 必须是 YYYY-MM-DD 或 null。
 * 不严格校验日期合法性（GPT 偶尔会出 2026-13-01 这种）, 只校验格式。
 */
function validateDateStringOrNull(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') {
    throw new AiProviderError(
      `GPT 输出 test_date 字段类型错误: ${typeof v}`,
      'bad-response',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return v;
}

/**
 * 校验 lab_indicators 数组。
 * 当 doc_type !== 'lab_report' 时, 数组必须为空（否则 prompt drift）。
 */
function validateLabIndicators(
  v: unknown,
  docType: DocType,
): LabIndicatorExtracted[] {
  if (!Array.isArray(v)) {
    throw new AiProviderError(
      `GPT 输出 lab_indicators 字段非数组: ${typeof v}`,
      'bad-response',
    );
  }
  if (v.length === 0) return [];

  if (docType !== 'lab_report') {
    // 非化验单却给了指标 —— prompt drift, 拒绝（不让脏数据落库）
    throw new AiProviderError(
      `GPT 在 doc_type=${docType} 下输出了 ${v.length} 条 lab_indicators, 预期为空`,
      'bad-response',
    );
  }

  return v.map((item, i) => validateLabIndicator(item, i));
}

function validateLabIndicator(
  item: unknown,
  index: number,
): LabIndicatorExtracted {
  if (typeof item !== 'object' || item === null) {
    throw new AiProviderError(
      `GPT 输出 lab_indicators[${index}] 非对象: ${typeof item}`,
      'bad-response',
    );
  }
  const obj = item as Record<string, unknown>;

  const name_cn = obj.name_cn;
  if (typeof name_cn !== 'string' || name_cn.trim() === '') {
    throw new AiProviderError(
      `GPT 输出 lab_indicators[${index}].name_cn 非法: ${JSON.stringify(name_cn).slice(0, 80)}`,
      'bad-response',
    );
  }

  const name_en =
    typeof obj.name_en === 'string' && obj.name_en.trim()
      ? obj.name_en
      : null;

  const result = obj.result;
  if (typeof result !== 'string' || result.trim() === '') {
    throw new AiProviderError(
      `GPT 输出 lab_indicators[${index}].result 非法: ${JSON.stringify(result).slice(0, 80)}`,
      'bad-response',
    );
  }

  const unit =
    typeof obj.unit === 'string' && obj.unit.trim() ? obj.unit : null;
  const reference_range =
    typeof obj.reference_range === 'string' && obj.reference_range.trim()
      ? obj.reference_range
      : null;

  const abnormal_tag_raw = obj.abnormal_tag;
  let abnormal_tag: 'H' | 'L' | 'N' | null;
  if (abnormal_tag_raw === null) {
    abnormal_tag = null;
  } else if (
    typeof abnormal_tag_raw === 'string' &&
    VALID_ABNORMAL_TAGS.has(abnormal_tag_raw)
  ) {
    abnormal_tag = abnormal_tag_raw as 'H' | 'L' | 'N';
  } else {
    // 非法 abnormal_tag 不抛错, 降级为 null（避免单条错指标导致整批 FAILED）
    abnormal_tag = null;
  }

  return {
    name_cn,
    name_en,
    result,
    unit,
    reference_range,
    abnormal_tag,
  };
}
