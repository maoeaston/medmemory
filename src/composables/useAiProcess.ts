// ============================================================
// MedMemory — AI 处理编排 composable
// ============================================================
// 对应 PRD 7.5 + 7.6: 推动 attachments.processing_status 状态机,
// 调用 AiProvider 产出 summary + ocr_fulltext + tags, 写入 ai_contents + attachments.tags
//
// 状态机:
//   UPLOADED → OCR_PROCESSING → SUMMARY_DONE
//                            ↘ FAILED (含 processing_error)
//
// v1 不走 OCR_DONE 中间态（单轮 LLM 调用一次产出 summary+ocr, 无需分阶段）
//
// 并发锁:
//   processAttachment 入口检查 attachment.processing_status, 若已 OCR_PROCESSING 拒绝
//   防止 AttachmentPreview 重复点 + 多 tab 场景（多 tab 的强一致锁 v1 不做）
//
// 单例 vs 每次新状态:
//   每次调 useAiProcess() 返回独立的 isProcessing/processingError refs
//   （AttachmentPreview 每张卡一份状态, Settings 批量处理一份）
//   processAttachment/processBatch 函数闭包绑定到本组 state
// ============================================================

import { ref } from 'vue';
import { useRepositories } from '@/composables/useRepositories';
import { useAiConfig } from '@/composables/useAiConfig';
import { IndexedDbStorageAdapter } from '@/storage/IndexedDbStorageAdapter';
import { OpenAiProvider } from '@/lib/ai/OpenAiProvider';
import { MEDICAL_DOCUMENT_PROMPT, PROMPT_VERSION } from '@/lib/ai/prompts';
import { AiProviderError } from '@/lib/ai/AiProvider';
import type { AiProcessingResult } from '@/lib/ai/AiProvider';
import type {
  Attachment,
  LabIndicatorCreateInput,
} from '@/repositories';

/**
 * AI 内容写入时使用的 model 字段。
 * 与 OpenAiProvider 内部默认 model 保持一致, 任何切换需同步调整。
 */
const DEFAULT_MODEL = 'gpt-4o';

/**
 * 单次批量处理进度。
 */
export interface BatchProgress {
  /** 1-based 当前处理的序号（处理中） */
  current: number;
  total: number;
  /** 已成功数 */
  successCount: number;
  /** 已失败数 */
  failureCount: number;
  /** 最近一次失败的错误消息（UI 展示滚动列表由调用方自己累积） */
  lastError: string | null;
}

/**
 * useAiProcess — 每次 call 返回独立状态。
 *
 * 用法（单附件）:
 *   const { isProcessing, processingError, processAttachment } = useAiProcess();
 *   await processAttachment(attachmentId);
 *
 * 用法（批量）:
 *   const { batchProgress, processBatch } = useAiProcess();
 *   await processBatch([id1, id2, id3]);
 */
export function useAiProcess() {
  const isProcessing = ref(false);
  const processingError = ref<string | null>(null);
  const batchProgress = ref<BatchProgress | null>(null);

  /**
   * 处理单个附件。
   *
   * @throws 当 attachment 不存在 / 已在处理中 / API key 未配置 / provider 调用失败时
   *         所有错误都已先写入 attachments.processing_status='FAILED' 再 rethrow
   *         （API key 未配置和 attachment 不存在是 precondition 错误, 不写 FAILED）
   */
  async function processAttachment(attachmentId: number): Promise<void> {
    const { apiKey, hasKey } = useAiConfig();
    if (!hasKey.value) {
      const msg = '未配置 OpenAI API key, 请到设置页填写';
      processingError.value = msg;
      throw new Error(msg);
    }

    const repos = await useRepositories();
    const attachment = await repos.attachment.getById(attachmentId);
    if (attachment === null) {
      const msg = `附件不存在 (id=${attachmentId})`;
      processingError.value = msg;
      throw new Error(msg);
    }

    // 并发锁: 已在处理中拒绝（防止用户连点 / 多源触发）
    if (attachment.processing_status === 'OCR_PROCESSING') {
      const msg = `附件 #${attachmentId} 正在处理中, 请勿重复触发`;
      processingError.value = msg;
      throw new Error(msg);
    }

    isProcessing.value = true;
    processingError.value = null;

    try {
      // 状态推进: → OCR_PROCESSING
      await repos.attachment.updateProcessingStatus(
        attachmentId,
        'OCR_PROCESSING',
      );

      const result = await callProvider(attachment, apiKey.value);
      await writeResults(attachment, result);

      // 状态推进: → SUMMARY_DONE
      await repos.attachment.updateProcessingStatus(
        attachmentId,
        'SUMMARY_DONE',
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 写 FAILED + processing_error（FAILED 之外的状态不应保留旧 error）
      try {
        await repos.attachment.updateProcessingStatus(
          attachmentId,
          'FAILED',
          msg,
        );
      } catch (writeErr) {
        // 写 FAILED 本身失败（DB 错误等）, 不掩盖原错误, console 报告
        console.error(
          `[useAiProcess] 写 FAILED 状态失败 attachment=${attachmentId}:`,
          writeErr,
        );
      }
      processingError.value = msg;
      throw e;
    } finally {
      isProcessing.value = false;
    }
  }

  /**
   * 调 OpenAI provider, 拿回三输出。
   * 不捕获错误 —— 让上层 catch 走 FAILED 路径。
   */
  async function callProvider(
    attachment: Attachment,
    apiKey: string,
  ): Promise<AiProcessingResult> {
    const storage = new IndexedDbStorageAdapter();
    const blob = await storage.getFile(attachment.storage_key);
    if (blob === null) {
      throw new Error(
        `原件 Blob 缺失: storage_key=${attachment.storage_key}`,
      );
    }

    const provider = new OpenAiProvider(apiKey);
    return provider.processMedicalDocument({
      imageBlob: blob,
      prompt: MEDICAL_DOCUMENT_PROMPT,
    });
  }

  /**
   * 落盘 AI 产出:
   *   1. ai_contents: summary + ocr_fulltext (并行, 多版本保留)
   *   2. attachments.doc_type + subtype (LLM 判型回写, subtype = reportType 如"血常规")
   *   3. report_indicators: 化验单指标整批替换 (DELETE + INSERT)
   *   4. attachments.tags (AI 产出覆盖)
   *
   * 任一失败抛错, 让上层 catch 走 FAILED。
   */
  async function writeResults(
    attachment: Attachment,
    result: AiProcessingResult,
  ): Promise<void> {
    const repos = await useRepositories();
    const baseInput = {
      attachment_id: attachment.id,
      model: DEFAULT_MODEL,
      prompt_version: PROMPT_VERSION,
    };

    // 并行写 summary + ocr_fulltext
    await Promise.all([
      repos.aiContent.create({
        ...baseInput,
        content_type: 'summary',
        content: result.summary,
      }),
      repos.aiContent.create({
        ...baseInput,
        content_type: 'ocr_fulltext',
        content: result.ocrFulltext,
      }),
    ]);

    // v2: doc_type + subtype 回写
    // subtype 字段语义就是 doc_type 的细分, reportType ("血常规"/"CT"/"MRI") 天然匹配
    // testDate / hospitalName 暂不持久化: schema 无对应字段, 且已在 summary/ocr_fulltext 内可检索
    //   (若后续 UI 需独立展示再加 schema 列, 避免 migration churn)
    const newSubtype = result.reportType;
    if (
      attachment.doc_type !== result.docType ||
      attachment.subtype !== newSubtype
    ) {
      await repos.attachment.updateDocType(
        attachment.id,
        result.docType,
        newSubtype,
      );
    }

    // v2: 化验单指标整批替换
    // 仅在 LLM 产出非空指标时触发; 空数组视为未提取, 不动旧数据 (保留 idempotency)
    if (result.labIndicators.length > 0) {
      await repos.reportIndicator.deleteByAttachment(attachment.id);
      const inputs: LabIndicatorCreateInput[] = result.labIndicators.map(
        (ind, i) => ({
          name_cn: ind.name_cn,
          name_en: ind.name_en,
          result: ind.result,
          unit: ind.unit,
          reference_range: ind.reference_range,
          abnormal_tag: ind.abnormal_tag,
          display_order: i,
          model: DEFAULT_MODEL,
          prompt_version: PROMPT_VERSION,
        }),
      );
      await repos.reportIndicator.createBatch(attachment.id, inputs);
    }

    // tags 写入 attachments.tags（JSON array 快照, AI 产出覆盖现有）
    const currentTags = attachment.tags;
    const newTags = result.tags;
    if (!tagsEqual(currentTags, newTags)) {
      await repos.attachment.updateTags(attachment.id, newTags);
    }
  }

  /**
   * 批量顺序处理多个附件。
   *
   * 不并发: 避免 OpenAI rate limit + 控制带宽（图片 base64 较大）。
   * 单个失败不中断, 累计 success/failure; 全部跑完后 resolve。
   */
  async function processBatch(
    attachmentIds: number[],
  ): Promise<{ successCount: number; failureCount: number }> {
    const total = attachmentIds.length;
    if (total === 0) {
      batchProgress.value = null;
      return { successCount: 0, failureCount: 0 };
    }

    batchProgress.value = {
      current: 0,
      total,
      successCount: 0,
      failureCount: 0,
      lastError: null,
    };
    isProcessing.value = true;
    processingError.value = null;

    for (let i = 0; i < total; i++) {
      batchProgress.value = {
        ...batchProgress.value,
        current: i + 1,
      };
      try {
        await processAttachment(attachmentIds[i]);
        batchProgress.value = {
          ...batchProgress.value,
          successCount: batchProgress.value.successCount + 1,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        batchProgress.value = {
          ...batchProgress.value,
          failureCount: batchProgress.value.failureCount + 1,
          lastError: msg,
        };
        console.error(
          `[useAiProcess] 批量处理 attachment=${attachmentIds[i]} 失败:`,
          e,
        );
      }
    }

    isProcessing.value = false;
    return {
      successCount: batchProgress.value.successCount,
      failureCount: batchProgress.value.failureCount,
    };
  }

  /**
   * 判断错误是否为 API key 相关（UI 用来给"跳设置页"提示）。
   */
  function isApiKeyError(e: unknown): boolean {
    if (e instanceof AiProviderError) {
      return e.code === 'unauthorized';
    }
    return false;
  }

  return {
    isProcessing,
    processingError,
    batchProgress,
    processAttachment,
    processBatch,
    isApiKeyError,
  };
}

/**
 * tags 数组浅比较（顺序敏感）。同序同元素视为相等, 不写。
 */
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
