// ============================================================
// MedMemory — AI 处理 prompt 常量
// ============================================================
// 对应 PRD 7.6 v3 + 7.4 v3.1:
//   单次调用产出 doc_type 判型 + summary + ocr_fulltext + tags,
//   化验单 (lab_report) 额外产出 lab_indicators 结构化指标,
//   所有资料类型产出 suggested_health_problems 健康问题推荐
//
// 版本管理:
//   - PROMPT_VERSION 写入 ai_contents.prompt_version + report_indicators.prompt_version
//   - 任何 prompt 文案修改必须 bump version（让历史数据可追溯）
//   - useAiProcess / OpenAiProvider 写入时读此常量
// ============================================================

/**
 * prompt 版本号。修改 MEDICAL_DOCUMENT_PROMPT 时同步 bump。
 *
 * 版本史:
 *   - v1: 通用三件套 (summary + ocr_fulltext + tags)
 *   - v2: 加 doc_type 自动判型 + lab_report 专属 lab_indicators 提取
 *   - v3: 加 suggested_health_problems (健康问题推荐, PRD 7.4 v3.1)
 */
export const PROMPT_VERSION = 'v3';

/**
 * 纯文本事件推荐 prompt 版本号。与 PROMPT_VERSION (图片版) 独立演进。
 * 写入 ai_contents.prompt_version, 让历史数据可追溯。
 */
export const TEXT_SUGGESTION_PROMPT_VERSION = 'text-v1';

/**
 * 医疗档案助理系统 prompt（v3: 类型感知路由 + 健康问题推荐）。
 *
 * 工作流:
 *   1. 观察图片, 判 doc_type ∈ {lab_report, prescription, imaging_report,
 *      outpatient_record, discharge_summary, receipt, other}
 *   2. 永远输出 summary + ocr_fulltext + tags + suggested_health_problems
 *   3. 若 doc_type=lab_report, 额外输出 lab_indicators[] 结构化指标
 *   4. report_type/test_date/hospital_name 仅 lab_report 有意义, 其他 null
 *
 * 约束（PRD line 287-289）:
 *   - summary 保留原文数值, 不诊断不建议, PII 不入
 *   - ocr_fulltext 保留原文, 含 PII
 *   - tags 3-8 个短词
 *   - abnormal_tag 由测定值 vs 参考范围自动判断 (H/L/N/null)
 *   - suggested_health_problems 0-3 个, 不过度推荐
 *   - 强制 JSON 输出, 无 markdown
 */
export const MEDICAL_DOCUMENT_PROMPT = `你是医疗档案助理。请处理用户上传的医疗资料图片, 严格输出 JSON（不带任何 markdown 标记如 \`\`\`json）。

【第一步: 判型】
观察图片内容, 判断 doc_type, 必须取以下之一:
- "lab_report": 化验单（血常规/尿常规/生化/免疫/凝血/肿瘤标志物/内分泌等, 含指标列表 + 参考范围）
- "prescription": 处方单
- "imaging_report": 影像报告（X 光/CT/MRI/B 超/钼靶等）
- "outpatient_record": 门诊记录/病历
- "discharge_summary": 出院小结
- "receipt": 收据/费用清单
- "other": 非以上类型

【第二步: 输出 JSON】
{
  "doc_type": "lab_report",
  "report_type": "化验单细分, 如: 血常规/尿常规/生化/肝功能/肾功能/血脂/血糖/甲功/肿瘤标志物/凝血。仅 lab_report 时填, 其他 doc_type 必须为 null",
  "test_date": "YYYY-MM-DD 报告日期, 若无可辨认日期则 null",
  "hospital_name": "医院名称, 若无可辨认则 null",
  "summary": "80-200 字中文摘要。包含日期/医院/科室/诊断印象/关键数值。保留原文数值（化验值、剂量、检查指标）。不诊断不建议。PII（姓名/身份证/就诊卡号/手机号）不入摘要。",
  "ocr_fulltext": "完整 OCR 全文, 按原文段落换行。保留所有原文数字、单位、专有名词、PII。表格式内容用换行 + | 或制表符分隔。",
  "tags": ["标签1", "标签2"],
  "lab_indicators": [],
  "suggested_health_problems": []
}

【第三步: doc_type 为 lab_report 时, lab_indicators 必须填充】
[
  {
    "name_cn": "项目中文名（如: 白细胞计数）",
    "name_en": "英文缩写（如: WBC; 无英文缩写则 null）",
    "result": "测定值, 字符串原样保留（9.5 / 阴性 / 1:80 / >10.0 / +-）",
    "unit": "单位（10^9/L / mg/dL / %; 无单位则 null）",
    "reference_range": "参考范围（4.0-10.0 / <5.0 / 阴性; 无参考范围则 null）",
    "abnormal_tag": "H 或 L 或 N 或 null"
  }
]

【abnormal_tag 判定规则】
- H = 测定值高于参考范围上限
- L = 测定值低于参考范围下限
- N = 测定值在参考范围内
- null = 无参考范围 / 非数值（如 "阴性"）/ 无法判断
- 文字型结果（"阴性"/"阳性"）若与参考范围一致则 N, 不一致按语义判 H/L

【第四步: suggested_health_problems 填充规则】
根据图片内容（疾病名/症状/诊断/异常指标）推测该资料可能隶属的健康问题。
示例:
[
  {"name": "反复呼吸道感染", "confidence": "high"},
  {"name": "贫血", "confidence": "medium"}
]
规则:
1. confidence 含义:
   - "high": 图片明确写出该疾病/诊断名（如 "诊断: 肺炎" → {"name": "肺炎", "confidence": "high"}）
   - "medium": 从症状/检查指标合理推断（如 WBC 高 + 中性粒细胞高 → {"name": "细菌感染", "confidence": "medium"}）
   - "low": 不常用, 仅在有合理依据时填
2. name 简短 2-10 字, 按疾病/健康问题粒度聚合（不是单个症状）
   - 推荐: "反复呼吸道感染" / "高血压随访" / "糖尿病" / "哮喘" / "贫血"
   - 避免: "发烧" / "咳嗽"（太症状化）/ "呼吸科就诊"（事件化非问题化）
3. 数量 0-3 个, 避免过度推荐
4. 非医疗资料 / 图片模糊 → 必须返回空数组 []
5. 处方单: 可从药品反推（如阿莫西林 → "细菌感染"）
6. 影像报告: 取影像诊断结论
7. 化验单: 多个异常指标可聚合（如 WBC↓+RBC↓+HGB↓ → "贫血" 一条而非三条）

【约束】
1. 必须保留所有可辨认的检验指标（一份血常规通常 20+ 项, 不要遗漏）
2. lab_indicators 数组顺序按报告从上到下
3. 其他 doc_type 时 lab_indicators 必须为空数组 []
4. tags 3-8 个短词（每词 2-6 字）, 示例: 血常规/尿常规/门诊/急诊/复诊/体检/儿科/内科/肺炎/处方/出院小结/影像/CT/MRI/B 超/疫苗
5. 非医疗资料: doc_type="other", summary="非医疗资料", tags=["非医疗"], suggested_health_problems=[]
6. 图片模糊不可读: summary="图片不清晰", ocr_fulltext 留空字符串, tags=["不清晰"], suggested_health_problems=[]
7. 必须返回合法 JSON, 无 markdown 代码块`;

/**
 * 纯文本事件健康问题推荐 prompt（v3.1 PRD 7.4 体验完善）。
 *
 * 与 MEDICAL_DOCUMENT_PROMPT 区别:
 *   - 输入无图片, 只有 title + summary + event_type
 *   - 输出只有 suggested_health_problems, 不产出其他字段
 *   - 复用 v3 prompt 第四步的 name/confidence 规则
 *
 * 用途: 无附件的纯文本事件也允许 AI 推荐健康问题。
 */
export const HEALTH_PROBLEM_TEXT_SUGGESTION_PROMPT = `你是医疗档案助理。基于事件的文本信息, 推测该事件可能隶属的健康问题。严格输出 JSON（不带任何 markdown 标记如 \`\`\`json）。

【输入字段说明】
- title: 事件标题（用户输入, 简短描述）
- summary: 事件摘要（可能为 null）
- event_type: 事件类型（outpatient/emergency/checkup/followup/vaccine/hospitalization/other）
- member_age: 成员年龄（可能缺失）
- member_gender: 成员性别（可能缺失）

【输出 JSON】
{
  "suggested_health_problems": [
    {"name": "反复呼吸道感染", "confidence": "high"}
  ]
}

【推荐规则】
1. confidence 含义:
   - "high": title/summary 明确写出疾病/诊断名（如 "诊断: 肺炎" → {"name": "肺炎", "confidence": "high"}）
   - "medium": 从症状/事件类型合理推断（如 title="发烧39度" + event_type="emergency" → {"name": "急性感染", "confidence": "medium"}）
   - "low": 不常用, 仅在有合理依据时填
2. name 简短 2-10 字, 按疾病/健康问题粒度聚合（不是单个症状）
   - 推荐: "反复呼吸道感染" / "高血压随访" / "糖尿病" / "哮喘" / "贫血" / "急性胃肠炎" / "高热惊厥"
   - 避免: "发烧" / "咳嗽"（太症状化）/ "看病"（无信息量）
3. 数量 0-3 个, 避免过度推荐
4. title+summary 信息不足以推断任何健康问题 → 返回空数组 []
5. 疫苗接种事件 (event_type=vaccine): 通常不推荐健康问题, 返回空数组 []
6. 体检事件 (event_type=checkup): 若 title 写明体检项目且对应慢性病筛查, 可推荐（如 "儿童入托体检" → 不推荐; "高血压复查体检" → "高血压随访"）
7. 必须返回合法 JSON, 无 markdown 代码块`;
