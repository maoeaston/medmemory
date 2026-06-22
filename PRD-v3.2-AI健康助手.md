# MedMemory PRD v3.2 增量：AI 健康助手

> 本文件是主 PRD `家庭医疗记忆系统-v3.1.md` 的增量扩展, 不是独立 PRD。
> 主 PRD 已覆盖的功能（OCR / 摘要 / 健康问题推荐 / 时间线 / 药箱清单等）不在本文档范围。
> 本文档仅描述 v3.2 新增的「AI 健康助手」模块。

## 文档版本

| 版本 | 日期 | 主要变更 |
|---|---|---|
| v3.2-draft-1 | 2026-06-23 | 初稿：MVP 范围（化验解读 + 用药指南）+ 风险控制 + 5 个决策点 |

**状态**：草案（Draft）—— 待用户对 5 个决策点拍板后进入实施 plan。

---

## 1. 产品定位

MedMemory 从「家庭医疗档案柜」升级为「家庭医疗档案 + AI 健康助手」。

### 1.1 价值主张

用户拿到化验单第一件事是想知道「这啥意思」, 拿到药第一件事是想知道「怎么吃」。这两个高频痛点在 v3.1 中并未覆盖——v3.1 只做归档（OCR + 摘要 + 标签）, 不做解读。

v3.2 复用 v3.1 已结构化的数据（`lab_indicators` / `medicines`）+ 已接入的多模态 LLM, 提供**参考性**解读与用药指南, 把档案柜升级为健康助手。

### 1.2 命名（决策点 #1, 待定）

避免「家庭医生 agent」——该命名暗示「可替代医生」, 法律风险高。候选：

| 候选 | 优点 | 缺点 |
|---|---|---|
| AI 健康助手 | 中性, 通用 | 太泛 |
| AI 解读参考 | 明确「参考」语义 | 略冷 |
| MedMemory Copilot | 技术风, 高级感 | 部分用户陌生 Copilot 概念 |

**核心红线**：无论选哪个名字, 所有 AI 输出**永久标注「参考, 不替代专业医疗建议」**。

---

## 2. MVP 范围

两条独立路径, 同期交付。

### 2.1 路径 A：化验单解读

**入口**：`EventDetailView` → 任一附件 AI 结果「检验指标」tab 旁加「AI 解读」chip 按钮。

**触发条件**：
- 该附件 `doc_type='lab_report'`
- `lab_indicators.length > 0`（已有结构化数据）
- `family_members` 有该附件所属成员（用于年龄/性别上下文）

**输入给 LLM**：
- 结构化：`lab_indicators` 全部字段（`name_cn`/`name_en`/`result`/`unit`/`reference_range`/`abnormal_tag`）
- 上下文：`event.summary`（精炼主诉）+ 成员信息（年龄/性别, 从 `family_members.birthday` + `gender` 推导）
- **不输入**：OCR 全文（避免 prompt 漂移）、成员姓名、联系方式（PII）

**LLM 输出结构**：
```typescript
interface LabInterpretation {
  /** 整体印象, 1-2 句话总结异常模式 */
  overallImpression: string;
  /** 紧急程度 (硬规则 + LLM 软判断结合, 见 §3.2) */
  urgency: 'observe' | 'suggest_visit' | 'urgent_visit';
  /** 异常项逐条解读, 顺序按 lab_indicators 原序 */
  abnormalExplanations: Array<{
    indicatorName: string;   // 对应 lab_indicators.name_cn
    interpretation: string;  // 这个指标偏高/偏低通常意味着什么, 1-2 句
    possibleCauses: string[];// 可能原因, 2-4 个简短词
  }>;
  /** 综合建议（如「建议结合既往化验趋势」「建议进一步检查 X」） */
  recommendation: string;
  /** 建议就诊科室列表（必须从预定义白名单选, 见 §3.5） */
  suggestedDepartments: string[];
}
```

### 2.2 路径 B：用药指南

**入口**：`MedicinesView` → 药物卡片右下加「用药指南」按钮。

**触发条件**：
- 药物 `medicines.name` 非空
- 该药物所属成员（`medicines.member_id`）存在（用于成员特定警示）

**输入给 LLM**：
- 药物：`medicines.name` + `medicines.usage`（用途）+ `medicines.remark`（备注）
- 成员：年龄/性别（用于红旗警示, 见下）
- 同成员其他药物：`medicines` 表中 `member_id` 相同的其他行（用于检查相互作用）
- 同成员既往健康问题：`health_problems` 表中 `member_id` 相同（用于既往史警示）
- **不输入**：成员姓名、联系方式

**LLM 输出结构**：
```typescript
interface MedicationGuide {
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
    otherMedicine: string;   // 对应另一条 medicines.name
    description: string;     // 相互作用描述
    severity: 'mild' | 'moderate' | 'severe';
  }>;
  /** 红旗警示 (成员特定: 儿童/孕妇/老年人/肝肾功能不全等慎用) */
  redFlags: string[];
  /** 是否需要医生指导使用 (处方药/特殊管理药品 true, OTC false) */
  requiresPrescription: boolean;
}
```

---

## 3. 风险控制原则

### 3.1 免责声明永久可见

每次 AI 输出底部固定显示（不可关闭, 不可折叠）：

> 本内容由 AI 生成, 仅供参考, 不替代专业医疗诊断。具体用药/治疗请咨询医生。

### 3.2 危急值硬规则（决策点 #2, 待定阈值）

LLM 输出的 `urgency` 字段不能单独决定是否「建议立即就医」。前端硬规则覆盖：

- `abnormal_tag='H'` 且测定值 > 参考范围上限 × N（候选 N: 1.5 / 2 / 3）
- `abnormal_tag='L'` 且测定值 < 参考范围下限 ÷ N
- 特定危急值关键词（"危急值" / "Critical" / 血钾 < 2.5 / 血糖 < 2.2 等医学共识项）

触发任一硬规则时, UI 强制红色高亮 + 「⚠️ 建议立即就医」提示, LLM 输出的 `urgency` 不能覆盖。

### 3.3 不主动推荐用药

AI 只解读**已存在**于 `medicines` 表的药物, 不开新处方, 不推荐替代药品。用户问「这个症状吃什么药」时, AI 应回答「本助手不开新处方, 请咨询医生或药师」。

### 3.4 不做剂量计算

`usualDosage` 只输出「说明书常规范围」（如「成人一次 1-2 片, 一日 3 次」）, **不根据体重/年龄/肾功能计算个人剂量**。儿童剂量、肝肾不全剂量均标注「需医生评估」。

### 3.5 输出存在性校验

- `suggestedDepartments` 必须从预定义白名单选（科室列表见附录 A）
- `interactions.otherMedicine` 必须匹配输入的其他药物名（防止 LLM 编造）
- `redFlags` 用词必须命中预定义关键词集（"儿童"/"孕妇"/"哺乳期"/"老年人"/"肝功能"/"肾功能"/"过敏"）

校验失败时, 该字段降级为空 / 默认值, 不抛错（避免单字段错导致整次解读 FAILED）。

### 3.6 PII 边界

上传给 LLM provider 的 prompt 只包含必要医学数据（指标值/药名/年龄/性别）。**绝不上传**：成员姓名、身份证、就诊卡号、手机号、地址。PII 清洗在 composable 层做（调 provider 前过滤）。

---

## 4. 数据依赖

| 路径 | 依赖表 | v3.1 已就绪 | 缺口 |
|---|---|---|---|
| A 化验单解读 | `lab_indicators`（migration 002） | ✓ | - |
| A 化验单解读 | `family_members.birthday`（算年龄） | 字段已存在, 需验证用户是否实际填写 | 缺则降级为「年龄未知」 |
| A 化验单解读 | `family_members.gender` | 字段已存在 | 缺则降级为「性别未知」 |
| B 用药指南 | `medicines` | ✓ | - |
| B 用药指南 | `family_members.birthday / gender` | 同上 | 同上 |
| B 用药指南 | `health_problems`（既往史, 用于红旗警示） | ✓ | v3.1 AI 推荐上线后会积累, 现阶段可能稀疏 |
| B 用药指南 | 同成员其他 `medicines`（相互作用） | ✓ | 多药同服场景才有意义 |

---

## 5. 技术架构（高层）

### 5.1 数据流

```
用户点「AI 解读」chip（化验单）
  ↓
useHealthAgent.interpretLabResult(attachmentId)
  ↓
组装 prompt 输入:
  - lab_indicators 全量 + event.summary + 成员年龄性别
  - PII 清洗（防御性）
  ↓
provider.interpretLabResult(req)  // 新 AiProvider 方法
  ↓
输出校验 (§3.5)
  ↓
ai_interpretations 表持久化 (source_type='lab', source_id=attachmentId)
  ↓
返回前端, Modal 展示
```

用药指南流程类似, `source_type='medication'`, `source_id=medicineId`。

### 5.2 复用与新增

| 组件 | 复用 v3.1 | 新增 |
|---|---|---|
| AiProvider 抽象 | ✓ interface | 加 `interpretLabResult` / `guideMedication` 两方法 |
| OpenAiProvider | ✓ fetch 逻辑 | 加两方法实现（纯文本 prompt, 无 image_url） |
| prompts.ts | ✓ 版本号管理 | 加 `LAB_INTERPRETATION_PROMPT` / `MEDICATION_GUIDE_PROMPT` |
| useAiProcess | ✓ isProcessing/error 模式 | 新 composable `useHealthAgent.ts`（独立, 不混入 useAiProcess） |
| Result 持久化 | 模式参考 ai_contents | 新表 `ai_interpretations`（决策点 #3, 待定） |

### 5.3 多 Provider 路由策略（决策点 #5, 新增）

不同任务适合不同模型特征：

| 任务 | 推荐模型特征 | 候选 |
|---|---|---|
| OCR + summary（主流程, 已有） | 多模态强、便宜、快 | GPT-4o / Gemini 2.0 Flash |
| 化验单解读 | 推理强、医疗知识稳、有引用 | Claude Sonnet 4.5 / GPT-4o |
| 用药指南 | 药物相互作用知识、保守、低幻觉 | Claude Sonnet 4.5 / 文心医疗 |
| 健康问题推荐（已有） | 轻量、JSON 模式稳 | 复用主 config 即可 |

**配置 UI 候选**：
- 方案 A：SettingsView 加分组（主任务 / 健康助手）, 各 3 字段（apiKey/baseUrl/model）
- 方案 B：`useAiConfig` 加 namespace（`useAiConfig('ocr')` / `useAiConfig('health-agent')`）, 未来可扩展更多 agent
- 方案 C：每条 agent 配置可选「继承主 config」或「自定义」复选框

**推荐方案 B**——namespace 扩展点预留, 未来加影像解读 / 对话问诊时无需重构。

### 5.4 持久化（决策点 #3, 待定）

候选：
- **方案 X**：新建 `ai_interpretations` 表（`id` / `source_type` / `source_id` / `content_json` / `model` / `prompt_version` / `created_at`）, 每次调用 INSERT 新行, 进入页面默认显示最近一次
- **方案 Y**：不持久化, 每次进入页面实时调用

**推荐方案 X**——避免重复调用浪费 API 费用 + 用户可对比不同时间的解读（虽然 v3.2 MVP 不做对比 UI, 数据先攒）。

---

## 6. UI 入口

### 6.1 化验单解读

- 入口位置：`AttachmentPreview` 的「检验指标」tab 标题旁加 `✨ AI 解读` chip
- 触发条件：`labIndicators.length > 0`
- 结果展示：Modal（不动现有页面布局）
- Modal 结构：
  ```
  ┌─ 化验单 AI 解读 ─────────────────┐
  │ 整体印象: ...                    │
  │ 紧急程度: 🟢 观察                │
  │                                  │
  │ 异常项解读:                       │
  │  • 白细胞计数 (H): ...           │
  │    可能原因: 细菌感染 / 应激 /... │
  │                                  │
  │ 建议: ...                        │
  │ 建议就诊科室: 血液内科            │
  │                                  │
  │ ─────────────────────           │
  │ ⚠️ 本内容由 AI 生成, 仅供参考,   │
  │    不替代专业医疗诊断。具体用药/  │
  │    治疗请咨询医生。               │
  │                                  │
  │ [关闭]  [重新生成]                │
  └──────────────────────────────────┘
  ```

### 6.2 用药指南

- 入口位置：`MedicinesView` 药物卡片右下角「用药指南」按钮
- 触发条件：`medicine.name` 非空
- 结果展示：Modal（同化验单解读）
- Modal 结构类似, 字段对应 §2.2 输出结构

---

## 7. 不做的事（v3.2 边界）

| 不做的事 | 原因 | 留给 |
|---|---|---|
| 实时对话 / 问诊 | 单次调用避免「问诊」语义, 法律风险 | v3.3+ |
| 开新处方 | 不替代医生 | 永不做 |
| 儿童剂量计算 | 需医生判断 | 永不做 |
| 影像解读（X 光/CT/MRI） | 范围太大, v3.2 聚焦化验 + 药物 | v3.3 |
| 跨事件病程推理（「半年白细胞趋势」） | 依赖跨事件数据聚合, 复杂度高 | v3.3 |
| 上传原件图片给 agent | 用结构化数据 + summary 文本, 避免 prompt 漂移 | v3.3+ 评估 |
| 用户对结果的反馈/纠错 UI | MVP 先看使用频次, 反馈机制 v3.3 再做 | v3.3 |
| 结果分享 / 导出 PDF | 留给 v3.3 评估需求强度 | v3.3 |

---

## 8. 决策点（待用户拍板）

### #1 命名

候选见 §1.2。**推荐**：`AI 解读参考`（明确「参考」语义, 法律上最稳）。

### #2 危急值硬规则阈值

候选 N: 1.5× / 2× / 3× 参考范围。

- 1.5×：保守, 假阳性多, 但医疗场景偏保守合理
- 2×：折中, 临床常用「危急值」通常落在 2-3× 区间
- 3×：激进, 假阴性风险（用户已严重异常但未触发）

**推荐**：2× + 关键词白名单（特定项目如血钾/血糖/血钠等危急值用医学共识固定阈值, 不依赖倍数）。

### #3 结果持久化

候选见 §5.4。**推荐**：方案 X（新表 `ai_interpretations`）。

### #4 成本控制 / quota

候选：
- A. 不做 quota, 信任用户自控
- B. 日调用上限软提示（如每日 > 10 次弹「调用频繁, 确认继续?」）
- C. 硬 quota（需登录账号体系, v3.2 不做）

**推荐**：B（软提示, 实现成本最低, 不阻碍正常使用）。

### #5 多 Provider 路由策略

候选见 §5.3。**推荐**：方案 B（`useAiConfig(namespace)` 扩展）。

实施时直接重命名现有 3 个 key（`medmemory:aiApiKey` 等）到 namespace 模式（`medmemory:ai:ocr:apiKey` 等）。开发阶段无需保留旧 key 兼容读取——清掉 localStorage 重填即可。

---

## 9. 验收标准（高层）

- 化验单解读：上传任一化验单 → AI 处理产出 lab_indicators → 进 EventDetailView 展开指标 tab → 点「AI 解读」→ Modal 显示 5 个字段（overallImpression / urgency / 异常项解读 / 建议 / 科室）
- 危急值硬规则：构造一个 H 且 > 2× 上限的指标 → UI 强制红色高亮 + 「建议立即就医」, LLM 输出的低 urgency 被覆盖
- 用药指南：进 MedicinesView → 任意药物卡片点「用药指南」→ Modal 显示完整字段, 相互作用字段在有同成员其他药物时非空
- 持久化：第二次进入同一化验单 → 默认显示上次的解读结果（不重新调 AI）, 「重新生成」按钮可强制刷新
- 跨设备一致性：同 origin 下 localStorage 配置 + ai_interpretations 表数据, 数据一致

---

## 附录 A：科室白名单（v3.2 初版）

> 用于校验 `suggestedDepartments` 输出。LLM 只能从该列表选, 防止编造。

```
内科 / 外科 / 儿科 / 妇产科 / 急诊科 / 神经内科 / 心内科 / 呼吸内科 / 消化内科 /
内分泌科 / 肾内科 / 血液内科 / 风湿免疫科 / 感染科 / 肿瘤科 / 神经外科 /
心胸外科 / 泌尿外科 / 骨科 / 普外科 / 皮肤科 / 眼科 / 耳鼻喉科 / 口腔科 /
精神科 / 心理咨询科 / 康复科 / 中医科 / 全科 / 家庭医学科
```

---

## 附录 B：v3.2 与主 PRD v3.1 的关系

| 维度 | v3.1 | v3.2 |
|---|---|---|
| 核心定位 | 家庭医疗档案柜 | 档案柜 + AI 健康助手 |
| 数据流 | 上传 → OCR → 摘要 → 归档 | 复用 v3.1 已结构化数据 → AI 解读 |
| AI 角色 | 信息提取器（图片 → 结构化 JSON） | 信息解读器（结构化数据 → 解释性文本） |
| 输出消费者 | 归档系统（写入 ai_contents / lab_indicators） | 用户直接阅读 |
| 风险等级 | 低（错误最多是数据不准） | 中（错误可能误导用户决策） |
| 法律边界 | 弱（只是档案） | 强（解读可能被照做） |

v3.2 不修改 v3.1 任何已有功能, 只新增模块。所有 v3.1 已上线功能（OCR / 摘要 / 健康问题推荐 / 时间线 / 药箱）在 v3.2 完全保留原行为。
