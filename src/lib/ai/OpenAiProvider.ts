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
  type LabInterpretation,
  type LabInterpretationRequest,
  type MedicationGuide,
  type MedicationGuideRequest,
  type MultimodalRequest,
  type SuggestedHealthProblem,
  type TextSuggestionRequest,
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

/**
 * v3 合法 confidence 值（与 SuggestedHealthProblem.confidence 对齐）。
 */
const VALID_CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);

/**
 * 技术层 fallback 默认值（构造函数 default param 用）。
 * 业务层（useAiConfig）不依赖此常量——baseUrl/model 由用户主动填,
 * 调用方（useAiProcess）会在调用前校验非空。此处默认仅为健壮性兜底。
 */
const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

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
 * 期望的 JSON 输出 schema（prompt v3 强制）。
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
  suggested_health_problems: unknown;
}

export class OpenAiProvider implements AiProvider {
  readonly model: string;
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string = DEFAULT_BASE_URL,
    model: string = DEFAULT_MODEL,
  ) {
    if (!apiKey) {
      throw new AiProviderError(
        'API key 为空, 请到设置页配置',
        'unauthorized',
      );
    }
    // OpenAI SDK 兼容行为: 用户填到 baseURL (如 https://ccapi.us/v1),
    // 代码拼 /chat/completions, 最终 https://ccapi.us/v1/chat/completions.
    // 不做"用户已填 /chat/completions 就保留"的容错——主流约定要求用户只填到 /v1,
    // 容错反而让边界模糊 (参考 ccapi.us 文档"接口地址与密钥"章节).
    // 仅处理一种边界: 末尾多余斜杠.
    const normalizedBase = baseUrl.replace(/\/+$/, '');
    this.endpoint = `${normalizedBase}/chat/completions`;
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
      resp = await fetch(this.endpoint, {
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

  /**
   * 纯文本 Chat Completion 共用方法（v3.2 抽出）。
   *
   * system + user (string) 两段消息, response_format 强制 JSON, temperature 0.2。
   * 返回 choices[0].message.content 原始字符串, 由调用方各自 parse + validate。
   *
   * processMedicalDocument 用 image_url 不走此方法（content 类型不同）。
   */
  private async callChatCompletion(
    systemPrompt: string,
    userContent: string,
  ): Promise<string> {
    const body = {
      model: this.model,
      messages: [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userContent },
      ],
      response_format: { type: 'json_object' as const },
      temperature: 0.2,
    };

    let resp: Response;
    try {
      resp = await fetch(this.endpoint, {
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
    return rawContent;
  }

  /**
   * 纯文本事件推荐健康问题（v3.1 PRD 7.4 体验完善）。
   *
   * 与 processMedicalDocument 区别:
   *   - messages 无 image_url, user content 是拼好的事件上下文字符串
   *   - 输出只解析 suggested_health_problems 字段
   *   - 复用 validateSuggestedHealthProblems 校验（非法元素降级丢弃）
   */
  async suggestHealthProblemsFromText(
    req: TextSuggestionRequest,
  ): Promise<SuggestedHealthProblem[]> {
    const contextLines: string[] = [
      `event_type: ${req.event_type}`,
      `title: ${req.title}`,
    ];
    if (req.summary) {
      contextLines.push(`summary: ${req.summary}`);
    }
    if (req.memberAge !== undefined) {
      contextLines.push(`member_age: ${req.memberAge}`);
    }
    if (req.memberGender) {
      contextLines.push(`member_gender: ${req.memberGender}`);
    }
    const userContent = contextLines.join('\n');

    const rawContent = await this.callChatCompletion(req.prompt, userContent);

    let parsed: { suggested_health_problems?: unknown };
    try {
      parsed = JSON.parse(rawContent) as typeof parsed;
    } catch (e) {
      throw new AiProviderError(
        `GPT 输出 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
        'bad-response',
      );
    }
    return validateSuggestedHealthProblems(parsed.suggested_health_problems);
  }

  /**
   * 化验单解读（v3.2 PRD §2.1）。
   *
   * 输入已结构化指标 + 上下文, 输出参考性解读 + 建议就诊科室。
   * 紧急程度 urgency 是 LLM 软判断, 应用层 criticalValue.ts 硬规则会覆盖。
   */
  async interpretLabResult(
    req: LabInterpretationRequest,
  ): Promise<LabInterpretation> {
    const indicatorsJson = JSON.stringify(
      req.indicators.map((i) => ({
        name_cn: i.name_cn,
        name_en: i.name_en,
        result: i.result,
        unit: i.unit,
        reference_range: i.reference_range,
        abnormal_tag: i.abnormal_tag,
      })),
    );
    const contextLines: string[] = [`indicators: ${indicatorsJson}`];
    if (req.eventSummary) {
      contextLines.push(`event_summary: ${req.eventSummary}`);
    }
    if (req.memberAge !== undefined) {
      contextLines.push(`member_age: ${req.memberAge}`);
    }
    if (req.memberGender) {
      contextLines.push(`member_gender: ${req.memberGender}`);
    }
    const userContent = contextLines.join('\n');

    const rawContent = await this.callChatCompletion(req.prompt, userContent);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawContent) as Record<string, unknown>;
    } catch (e) {
      throw new AiProviderError(
        `化验解读 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
        'bad-response',
      );
    }
    return parseLabInterpretation(parsed);
  }

  /**
   * 用药指南（v3.2 PRD §2.2）。
   *
   * 输入药物 + 同成员其他药物 + 既往健康问题, 输出参考性用药指南。
   * 不开新处方, 不算个人剂量, 仅解读已存在药物。
   */
  async guideMedication(req: MedicationGuideRequest): Promise<MedicationGuide> {
    const contextLines: string[] = [
      `medicine: ${JSON.stringify(req.medicine)}`,
    ];
    if (req.otherMedicines.length > 0) {
      contextLines.push(`other_medicines: ${JSON.stringify(req.otherMedicines)}`);
    } else {
      contextLines.push('other_medicines: []');
    }
    if (req.healthProblems.length > 0) {
      contextLines.push(
        `health_problems: ${JSON.stringify(req.healthProblems)}`,
      );
    } else {
      contextLines.push('health_problems: []');
    }
    if (req.memberAge !== undefined) {
      contextLines.push(`member_age: ${req.memberAge}`);
    }
    if (req.memberGender) {
      contextLines.push(`member_gender: ${req.memberGender}`);
    }
    const userContent = contextLines.join('\n');

    const rawContent = await this.callChatCompletion(req.prompt, userContent);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawContent) as Record<string, unknown>;
    } catch (e) {
      throw new AiProviderError(
        `用药指南 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
        'bad-response',
      );
    }
    return parseMedicationGuide(parsed, req.otherMedicines);
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
    suggested_health_problems,
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

  // suggested_health_problems: 数组, 元素必须符合 SuggestedHealthProblem
  // v3 新增。非法元素整条丢弃不抛错（避免单条错导致整批 FAILED）
  const typedSuggestedProblems = validateSuggestedHealthProblems(
    suggested_health_problems,
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
    suggestedHealthProblems: typedSuggestedProblems,
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

/**
 * 校验 suggested_health_problems 数组（v3 新增）。
 *
 * 校验失败时降级（丢弃非法元素）而非抛错 — 原因:
 *   单条 malformed recommendation 不应导致整个附件处理 FAILED
 *   （lab_indicators 走严格校验因为那是化验单核心结构数据, 推荐是软信息）
 *
 * 完全缺失 / 非数组 / 全部非法 → 返回空数组（视为 LLM 未推荐）
 */
function validateSuggestedHealthProblems(
  v: unknown,
): SuggestedHealthProblem[] {
  if (!Array.isArray(v)) {
    // 非数组 → prompt drift, 但降级为空数组（不 FAILED 整批）
    return [];
  }

  const result: SuggestedHealthProblem[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== 'object' || item === null) continue;

    const obj = item as Record<string, unknown>;
    const name = obj.name;
    if (typeof name !== 'string' || name.trim() === '') continue;

    const confidenceRaw = obj.confidence;
    if (
      typeof confidenceRaw !== 'string' ||
      !VALID_CONFIDENCE_LEVELS.has(confidenceRaw)
    ) {
      // confidence 缺失 / 非法 → 默认 medium（允许保留推荐, 不丢弃）
      result.push({ name: name.trim(), confidence: 'medium' });
      continue;
    }

    result.push({
      name: name.trim(),
      confidence: confidenceRaw as SuggestedHealthProblem['confidence'],
    });
  }
  return result;
}

// ============================================================
// v3.2 健康助手 helpers — LabInterpretation / MedicationGuide
// ============================================================

/**
 * 科室白名单（PRD 附录 A）。
 * suggestedDepartments 必须从白名单选, 不在白名单的丢弃（防 LLM 编造）。
 */
const DEPARTMENT_WHITELIST: ReadonlySet<string> = new Set([
  '心血管内科',
  '心内科',
  '神经内科',
  '呼吸内科',
  '消化内科',
  '内分泌科',
  '肾内科',
  '风湿免疫科',
  '血液内科',
  '感染科',
  '肿瘤科',
  '普外科',
  '心胸外科',
  '神经外科',
  '泌尿外科',
  '骨科',
  '皮肤科',
  '妇科',
  '产科',
  '儿科',
  '儿内科',
  '儿外科',
  '眼科',
  '耳鼻喉科',
  '口腔科',
  '急诊科',
  '全科',
  '中医科',
  '老年科',
  '精神心理科',
]);

/**
 * 科室同义词归一化表（LLM 可能输出"心血管内科", 应用层归一化为"心内科"）。
 * key = 输入别名, value = 白名单内的规范名。
 */
const DEPARTMENT_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['心血管内科', '心内科'],
  ['心血管科', '心内科'],
  ['心脏科', '心内科'],
  ['神经科', '神经内科'],
  ['呼吸科', '呼吸内科'],
  ['消化科', '消化内科'],
  ['内分泌科', '内分泌科'], // 自映射保持
  ['肾脏科', '肾内科'],
  ['风湿科', '风湿免疫科'],
  ['血液科', '血液内科'],
  ['传染科', '感染科'],
  ['普通外科', '普外科'],
  ['外科', '普外科'],
  ['心外', '心胸外科'],
  ['胸外科', '心胸外科'],
  ['脑外科', '神经外科'],
  ['泌尿科', '泌尿外科'],
  ['耳鼻喉', '耳鼻喉科'],
  ['ENT', '耳鼻喉科'],
  ['口腔', '口腔科'],
  ['牙科', '口腔科'],
  ['精神科', '精神心理科'],
  ['心理科', '精神心理科'],
  ['老人科', '老年科'],
]);

/**
 * 校验 suggestedDepartments（PRD §2.1 白名单 + 同义词归一化）。
 *
 * 规则:
 *   1. 同义词先归一化（"心血管内科" → "心内科"）
 *   2. 不在白名单的科室丢弃（防 LLM 编造如"免疫科""传染内科"）
 *   3. 去重保序
 *
 * 校验失败降级（不抛错） — 单条坏数据不应导致整批 FAILED。
 */
function validateDepartments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '') continue;
    // 同义词归一化
    const normalized = DEPARTMENT_SYNONYMS.get(trimmed) ?? trimmed;
    if (!DEPARTMENT_WHITELIST.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * LabInterpretation 合法 urgency 值。
 */
const VALID_URGENCY_LEVELS = new Set([
  'observe',
  'suggest_visit',
  'urgent_visit',
]);

/**
 * 解析 + 校验 LabInterpretation 输出。
 *
 * 校验失败策略:
 *   - urgency 非法 → 降级 'observe'（最保守）
 *   - abnormalExplanations 元素非法 → 丢弃（不抛错）
 *   - suggestedDepartments → validateDepartments 白名单过滤
 *   - overallImpression/recommendation 缺失 → 空串兜底
 */
function parseLabInterpretation(
  parsed: Record<string, unknown>,
): LabInterpretation {
  const overallImpression =
    typeof parsed.overallImpression === 'string'
      ? parsed.overallImpression.trim()
      : '';

  const urgencyRaw = parsed.urgency;
  const urgency: LabInterpretation['urgency'] =
    typeof urgencyRaw === 'string' && VALID_URGENCY_LEVELS.has(urgencyRaw)
      ? (urgencyRaw as LabInterpretation['urgency'])
      : 'observe';

  // abnormalExplanations: 数组, 元素非法丢弃
  const abnormalExplanations: LabInterpretation['abnormalExplanations'] = [];
  if (Array.isArray(parsed.abnormalExplanations)) {
    for (const item of parsed.abnormalExplanations) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as Record<string, unknown>;
      const indicatorName = obj.indicatorName;
      const interpretation = obj.interpretation;
      if (
        typeof indicatorName !== 'string' ||
        indicatorName.trim() === '' ||
        typeof interpretation !== 'string' ||
        interpretation.trim() === ''
      ) {
        continue;
      }
      const possibleCauses = Array.isArray(obj.possibleCauses)
        ? obj.possibleCauses.filter(
            (c): c is string => typeof c === 'string' && c.trim() !== '',
          )
        : [];
      abnormalExplanations.push({
        indicatorName: indicatorName.trim(),
        interpretation: interpretation.trim(),
        possibleCauses,
      });
    }
  }

  const recommendation =
    typeof parsed.recommendation === 'string'
      ? parsed.recommendation.trim()
      : '';

  const suggestedDepartments = validateDepartments(
    parsed.suggestedDepartments,
  );

  return {
    overallImpression,
    urgency,
    abnormalExplanations,
    recommendation,
    suggestedDepartments,
  };
}

/**
 * MedicationGuide 合法 severity 值。
 */
const VALID_INTERACTION_SEVERITY = new Set(['mild', 'moderate', 'severe']);

/**
 * 校验 interactions 数组（PRD §2.2 防编造）。
 *
 * 规则:
 *   1. otherMedicine 必须在输入 otherMedicines[].name 子集内（防 LLM 编造药物）
 *   2. description 非空字符串
 *   3. severity 非法 → 降级 'moderate'（保守）
 *   4. 同一 otherMedicine 多条保留（不同方面相互作用）
 *
 * 校验失败降级（丢弃非法元素）, 不抛错。
 */
function validateInteractions(
  raw: unknown,
  otherMedicines: Array<{ name: string }>,
): MedicationGuide['interactions'] {
  if (!Array.isArray(raw)) return [];
  const allowedNames = new Set(otherMedicines.map((m) => m.name));
  const result: MedicationGuide['interactions'] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const otherMedicine = obj.otherMedicine;
    if (
      typeof otherMedicine !== 'string' ||
      !allowedNames.has(otherMedicine)
    ) {
      continue; // 编造药物直接丢
    }
    const description = obj.description;
    if (typeof description !== 'string' || description.trim() === '') continue;

    const severityRaw = obj.severity;
    const severity: MedicationGuide['interactions'][number]['severity'] =
      typeof severityRaw === 'string' &&
      VALID_INTERACTION_SEVERITY.has(severityRaw)
        ? (severityRaw as 'mild' | 'moderate' | 'severe')
        : 'moderate';

    result.push({
      otherMedicine,
      description: description.trim(),
      severity,
    });
  }
  return result;
}

/**
 * 解析 + 校验 MedicationGuide 输出。
 *
 * 校验失败策略:
 *   - interactions → validateInteractions（防编造, otherMedicine 必须在输入子集）
 *   - 数组字段非法元素丢弃
 *   - requiresPrescription 非布尔 → 降级 true（保守, 视为需处方）
 *   - overview/usualDosage 缺失 → 空串兜底
 */
function parseMedicationGuide(
  parsed: Record<string, unknown>,
  otherMedicines: Array<{ name: string }>,
): MedicationGuide {
  const overview =
    typeof parsed.overview === 'string' ? parsed.overview.trim() : '';

  const usualDosage =
    typeof parsed.usualDosage === 'string' ? parsed.usualDosage.trim() : '';

  const commonSideEffects = Array.isArray(parsed.commonSideEffects)
    ? parsed.commonSideEffects.filter(
        (s): s is string => typeof s === 'string' && s.trim() !== '',
      )
    : [];

  const seriousSideEffects = Array.isArray(parsed.seriousSideEffects)
    ? parsed.seriousSideEffects.filter(
        (s): s is string => typeof s === 'string' && s.trim() !== '',
      )
    : [];

  const interactions = validateInteractions(parsed.interactions, otherMedicines);

  const redFlags = Array.isArray(parsed.redFlags)
    ? parsed.redFlags.filter(
        (s): s is string => typeof s === 'string' && s.trim() !== '',
      )
    : [];

  const requiresPrescription =
    typeof parsed.requiresPrescription === 'boolean'
      ? parsed.requiresPrescription
      : true; // 不确定时保守为 true

  return {
    overview,
    usualDosage,
    commonSideEffects,
    seriousSideEffects,
    interactions,
    redFlags,
    requiresPrescription,
  };
}
