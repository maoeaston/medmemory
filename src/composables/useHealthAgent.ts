// ============================================================
// MedMemory — v3.2 AI 健康助手 composable
// ============================================================
// 对应 PRD v3.2 §2.1 化验单解读 + §2.2 用药指南
//
// 与 useAiProcess 区别:
//   - useAiProcess 推进 attachments.processing_status 状态机, 产出 OCR+summary+tags+lab_indicators
//   - useHealthAgent 在已结构化数据基础上, 产出参考性解读（不修改原始数据）
//
// 持久化:
//   - ai_interpretations 表（双 FK: attachment_id | medicine_id, kind 区分）
//   - 解读不可变, 重新生成=create 新版本（老版本保留供历史对比）
//
// 危急值硬规则:
//   - 此 composable 不实现硬规则（见 criticalValue.ts）
//   - UI 层实时叠加 criticalValue.checkCriticalValues 到 LabInterpretation.urgency
//   - 落库的 urgency 是 LLM 软判断, UI 渲染时被硬规则覆盖
//
// namespace:
//   - 使用 'health-agent' namespace 的 useAiConfig（独立 apiKey/baseUrl/model）
//   - 用户可在 Settings 页为健康助手配置不同的中转站/模型
//
// PII 清洗:
//   - 不传成员姓名 / 昵称 / 备注（可能含 PII）
//   - 只传 age/gender（推算自 birthday）
// ============================================================

import { ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import { useAiConfig } from '@/composables/useAiConfig';
import { OpenAiProvider } from '@/lib/ai/OpenAiProvider';
import {
  LAB_INTERPRETATION_PROMPT,
  LAB_INTERPRETATION_PROMPT_VERSION,
  MEDICATION_GUIDE_PROMPT,
  MEDICATION_GUIDE_PROMPT_VERSION,
} from '@/lib/ai/prompts';
import { AiProviderError } from '@/lib/ai/AiProvider';
import type {
  LabInterpretation,
  LabIndicatorExtracted,
  MedicationGuide,
} from '@/lib/ai/AiProvider';
import type { AiInterpretation } from '@/repositories';

/**
 * 从生日字符串推算年龄（年）。
 * 生日格式 YYYY-MM-DD, 缺失或非法返回 undefined。
 */
function ageFromBirthday(birthday: string | null): number | undefined {
  if (!birthday) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);
  if (!match) return undefined;
  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]);
  const birthDay = Number(match[3]);
  const now = new Date();
  let age = now.getFullYear() - birthYear;
  // 月日还没到 → 减 1
  if (
    now.getMonth() + 1 < birthMonth ||
    (now.getMonth() + 1 === birthMonth && now.getDate() < birthDay)
  ) {
    age -= 1;
  }
  return age >= 0 && age < 150 ? age : undefined;
}

/**
 * useHealthAgent — 每次 call 返回独立状态。
 *
 * 用法（化验单解读）:
 *   const { interpretLabResult, getLatestLabInterpretation } = useHealthAgent();
 *   const cached = await getLatestLabInterpretation(attachmentId);
 *   if (!cached) await interpretLabResult(attachmentId, eventSummary);
 *
 * 用法（用药指南）:
 *   const { guideMedication, getLatestMedicationGuide } = useHealthAgent();
 *   const cached = await getLatestMedicationGuide(medicineId);
 *   if (!cached) await guideMedication(medicineId);
 */
export function useHealthAgent() {
  const isProcessing = ref(false);
  const processingError = ref<string | null>(null);

  /**
   * 校验 health-agent namespace 配置是否就绪。
   * @returns 三项配置, 或抛 Error（message 已是用户可读中文）
   */
  function ensureConfig(): {
    apiKey: string;
    baseUrl: string;
    model: string;
  } {
    const { apiKey, baseUrl, model, hasKey } = useAiConfig('health-agent');
    if (!hasKey.value) {
      const msg = '未配置 AI 健康助手 API key, 请到设置页「AI 健康助手」分组填写';
      processingError.value = msg;
      throw new Error(msg);
    }
    if (!baseUrl.value) {
      const msg = '未配置 AI 健康助手 Base URL, 请到设置页填写';
      processingError.value = msg;
      throw new Error(msg);
    }
    if (!model.value) {
      const msg = '未配置 AI 健康助手 Model, 请到设置页填写';
      processingError.value = msg;
      throw new Error(msg);
    }
    return { apiKey: apiKey.value, baseUrl: baseUrl.value, model: model.value };
  }

  /**
   * 化验单解读。
   *
   * @param attachmentId 目标附件 ID（必为化验单 doc_type=lab_report）
   * @param eventSummary 事件摘要（可空, 来自 medical_event.summary）
   * @returns LabInterpretation（已落 ai_interpretations 表）
   *
   * @throws 当指标为空 / 配置缺失 / provider 调用失败时
   */
  async function interpretLabResult(
    attachmentId: number,
    eventSummary: string | null,
  ): Promise<LabInterpretation> {
    isProcessing.value = true;
    processingError.value = null;
    try {
      const { apiKey, baseUrl, model } = ensureConfig();
      const repos = await useRepositories();

      // 1. 读已结构化指标
      const indicators = await repos.reportIndicator.listByAttachment(
        attachmentId,
      );
      if (indicators.length === 0) {
        const msg = '该附件暂无结构化化验指标, 请先完成 AI 处理';
        processingError.value = msg;
        throw new Error(msg);
      }

      // 2. 推算成员信息（attachment → event → member）
      let memberAge: number | undefined;
      let memberGender: string | undefined;
      const attachment = await repos.attachment.getById(attachmentId);
      if (attachment?.event_id) {
        const event = await repos.medicalEvent.getById(attachment.event_id);
        if (event) {
          const member = await repos.familyMember.getById(event.member_id);
          if (member) {
            memberAge = ageFromBirthday(member.birthday);
            memberGender = member.gender ?? undefined;
          }
        }
      }

      // 3. PII 清洗: 指标字段不含 PII（name_cn/name_en/result/unit/range/abnormal_tag）
      //    eventSummary 是 LLM 产出的 PII-free 摘要, 直接传
      const labIndicators: LabIndicatorExtracted[] = indicators.map((i) => ({
        name_cn: i.name_cn,
        name_en: i.name_en,
        result: i.result,
        unit: i.unit,
        reference_range: i.reference_range,
        abnormal_tag: i.abnormal_tag,
      }));

      // 4. 调 provider
      const provider = new OpenAiProvider(apiKey, baseUrl, model);
      const result = await provider.interpretLabResult({
        indicators: labIndicators,
        eventSummary,
        memberAge,
        memberGender,
        prompt: LAB_INTERPRETATION_PROMPT,
      });

      // 5. 落 ai_interpretations 表
      await repos.aiInterpretation.create({
        attachment_id: attachmentId,
        medicine_id: null,
        kind: 'lab',
        content_json: JSON.stringify(result),
        provider: 'openai-compatible',
        model,
        prompt_version: LAB_INTERPRETATION_PROMPT_VERSION,
      });

      return result;
    } catch (e) {
      const msg =
        e instanceof AiProviderError
          ? `化验单解读失败（${e.code}）: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      processingError.value = msg;
      throw e;
    } finally {
      isProcessing.value = false;
    }
  }

  /**
   * 用药指南。
   *
   * @param medicineId 目标药物 ID
   * @returns MedicationGuide（已落 ai_interpretations 表）
   *
   * @throws 当药物不存在 / 配置缺失 / provider 调用失败时
   */
  async function guideMedication(
    medicineId: number,
  ): Promise<MedicationGuide> {
    isProcessing.value = true;
    processingError.value = null;
    try {
      const { apiKey, baseUrl, model } = ensureConfig();
      const repos = await useRepositories();

      // 1. 目标药物
      const medicine = await repos.medicine.getById(medicineId);
      if (!medicine) {
        const msg = `药物不存在 (id=${medicineId})`;
        processingError.value = msg;
        throw new Error(msg);
      }

      // 2. 同成员其他药物（查相互作用）+ 既往健康问题（既往史警示）
      let otherMedicines: Array<{ name: string }> = [];
      let healthProblems: Array<{ name: string }> = [];
      let memberAge: number | undefined;
      let memberGender: string | undefined;
      if (medicine.member_id) {
        const all = await repos.medicine.listByMember(medicine.member_id);
        otherMedicines = all
          .filter((m) => m.id !== medicineId)
          .map((m) => ({ name: m.name }));

        const problems = await repos.healthProblem.listByMember(
          medicine.member_id,
        );
        healthProblems = problems
          .filter((p) => p.status !== 'resolved')
          .map((p) => ({ name: p.name }));

        const member = await repos.familyMember.getById(medicine.member_id);
        if (member) {
          memberAge = ageFromBirthday(member.birthday);
          memberGender = member.gender ?? undefined;
        }
      }

      // 3. PII 清洗: 只传 medicine.name/usage/remark, 不传成员名
      //    remark 可能含 PII 但通常为用药注意事项, 取舍: 传（用药指南有价值）
      //    healthProblems 是问题名（非 PII）
      const provider = new OpenAiProvider(apiKey, baseUrl, model);
      const result = await provider.guideMedication({
        medicine: {
          name: medicine.name,
          usage: medicine.usage,
          remark: medicine.remark,
        },
        otherMedicines,
        healthProblems,
        memberAge,
        memberGender,
        prompt: MEDICATION_GUIDE_PROMPT,
      });

      // 4. 落 ai_interpretations 表
      await repos.aiInterpretation.create({
        attachment_id: null,
        medicine_id: medicineId,
        kind: 'medication',
        content_json: JSON.stringify(result),
        provider: 'openai-compatible',
        model,
        prompt_version: MEDICATION_GUIDE_PROMPT_VERSION,
      });

      return result;
    } catch (e) {
      const msg =
        e instanceof AiProviderError
          ? `用药指南失败（${e.code}）: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      processingError.value = msg;
      throw e;
    } finally {
      isProcessing.value = false;
    }
  }

  /**
   * 读化验单解读缓存（最新版本）。
   * 无记录返回 null, 调用方决定是否调 interpretLabResult 强制刷新。
   */
  async function getLatestLabInterpretation(
    attachmentId: number,
  ): Promise<LabInterpretation | null> {
    const repos = await useRepositories();
    const interp = await repos.aiInterpretation.getLatestByAttachment(
      attachmentId,
    );
    if (!interp) return null;
    return parseLabInterpretationContent(interp);
  }

  /**
   * 读用药指南缓存（最新版本）。
   */
  async function getLatestMedicationGuide(
    medicineId: number,
  ): Promise<MedicationGuide | null> {
    const repos = await useRepositories();
    const interp = await repos.aiInterpretation.getLatestByMedicine(medicineId);
    if (!interp) return null;
    return parseMedicationGuideContent(interp);
  }

  function parseLabInterpretationContent(
    interp: AiInterpretation,
  ): LabInterpretation {
    try {
      return JSON.parse(interp.content_json) as LabInterpretation;
    } catch {
      // content_json 损坏（理论上不会, 因为 create 前已 JSON.stringify）
      // 返回空骨架, UI 兜底展示
      return {
        overallImpression: '',
        urgency: 'observe',
        abnormalExplanations: [],
        recommendation: '',
        suggestedDepartments: [],
      };
    }
  }

  function parseMedicationGuideContent(
    interp: AiInterpretation,
  ): MedicationGuide {
    try {
      return JSON.parse(interp.content_json) as MedicationGuide;
    } catch {
      return {
        overview: '',
        usualDosage: '',
        commonSideEffects: [],
        seriousSideEffects: [],
        interactions: [],
        redFlags: [],
        requiresPrescription: true,
      };
    }
  }

  return {
    isProcessing,
    processingError,
    interpretLabResult,
    guideMedication,
    getLatestLabInterpretation,
    getLatestMedicationGuide,
  };
}
