// ============================================================
// MedMemory — Repository 层 Smoke Test（Dev only）
// ============================================================
// 用途: 在浏览器 console 验证 8 个 Repository + SearchRepository 全部正常工作
// 触发方式:
//   npm run dev 后在浏览器 console:
//   window.medmemoryRepoPoc.runRepositorySmokeTest()
//
// 测试范围（每表）:
//   create → getById → list*（特有查询）→ update → delete
//
// 设计原则:
//   - 失败的 step 不中断整个测试, 收集所有失败便于一次看全
//   - 数据用 '[RepoTest]' 前缀, 开始前清理残留, 结束后清理本次数据
//   - 依赖顺序执行（familyMember → medicalEvent → ... → search）
//
// 不进生产 bundle: wireRepoPocToWindow 内部判断 import.meta.env?.DEV
// ============================================================

import { createRepositories } from '@/repositories';
import { RepositoryError } from '@/repositories/base';

// ============================================================
// 结果类型
// ============================================================

export interface StepResult {
  step: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface SmokeTestResult {
  /** 整体是否通过 */
  ok: boolean;
  /** 通过的步骤数 */
  passed: number;
  /** 失败的步骤数 */
  failed: number;
  /** 总耗时 */
  totalDurationMs: number;
  /** 详细结果（按执行顺序） */
  steps: StepResult[];
}

// ============================================================
// 内部辅助
// ============================================================

/** 包装一个 step: 计时 + catch 错误, 不中断主流程 */
async function runStep<T>(
  steps: StepResult[],
  stepName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const start = performance.now();
  try {
    const value = await fn();
    const durationMs = Math.round(performance.now() - start);
    steps.push({ step: stepName, ok: true, durationMs });
    return value;
  } catch (e) {
    const durationMs = Math.round(performance.now() - start);
    const error =
      e instanceof RepositoryError
        ? `${e.message}`
        : e instanceof Error
          ? `${e.name}: ${e.message}`
          : String(e);
    steps.push({ step: stepName, ok: false, durationMs, error });
    return null;
  }
}

// cleanup 内联在 runRepositorySmokeTest 末尾, 不单独抽函数

// ============================================================
// 主函数: runRepositorySmokeTest
// ============================================================

/**
 * 跑完整 Repository smoke test。
 *
 * 执行顺序（按 FK 依赖）:
 *   1. familyMember
 *   2. medicalEvent (依赖 member)
 *   3. inbox (独立)
 *   4. healthProblem (依赖 member)
 *   5. eventProblemRel (依赖 event + problem)
 *   6. attachment (依赖 event)
 *   7. aiContent (依赖 attachment)
 *   8. medicine (独立, 关联 member 可选)
 *   9. search (依赖 ai_content 有 ocr_fulltext 数据)
 *
 * 每步独立计时 + 错误收集, 失败的 step 不中断后续。
 * 数据用 '[RepoTest]' 前缀标识, 开始前清理, 结束后清理。
 */
export async function runRepositorySmokeTest(): Promise<SmokeTestResult> {
  const steps: StepResult[] = [];
  const overallStart = performance.now();

  // init step 直接返回 Repositories; 失败则整个 smoke test 中止
  const repos = await runStep(steps, 'init:createRepositories', async () => {
    return await createRepositories();
  });
  if (repos === null) {
    // 初始化就失败, 没必要继续
    return {
      ok: false,
      passed: 0,
      failed: steps.length,
      totalDurationMs: Math.round(performance.now() - overallStart),
      steps,
    };
  }

  // 持久化测试数据 ID 供清理用
  let memberId: number | null = null;
  let eventId: number | null = null;
  let problemId: number | null = null;
  let attachmentId: number | null = null;
  let aiContentId: number | null = null;
  let inboxId: number | null = null;
  let medicineId: number | null = null;

  // --- 1. FamilyMemberRepository ---
  await runStep(steps, 'familyMember.create', async () => {
    const m = await repos.familyMember.create({
      name: '[RepoTest] 张三',
      nickname: '三三',
      birthday: '1985-03-15',
      gender: 'male',
      allergies: [
        { name: '青霉素', severity: 'severe', reaction: '皮疹' },
      ],
      chronic_conditions: [
        { name: '高血压', status: 'active', diagnosed_date: '2020-01' },
      ],
      current_medications: ['氨氯地平 5mg'],
      remark: 'RepoTest 成员',
    });
    if (m.id <= 0) throw new Error(`bad id: ${m.id}`);
    if (m.allergies.length !== 1) throw new Error(`allergies 反序列化失败`);
    if (m.chronic_conditions[0]?.name !== '高血压') throw new Error('chronic 反序列化失败');
    memberId = m.id;
    return m;
  });

  await runStep(steps, 'familyMember.getById', async () => {
    const m = await repos.familyMember.getById(memberId!);
    if (m === null) throw new Error('未找到刚插入的 member');
    if (m.allergies[0]?.severity !== 'severe') throw new Error('JSON 字段读取错误');
    return m;
  });

  await runStep(steps, 'familyMember.list', async () => {
    const list = await repos.familyMember.list();
    if (!list.some((m) => m.id === memberId)) throw new Error('list 未包含插入的 member');
    return list.length;
  });

  await runStep(steps, 'familyMember.update', async () => {
    const u = await repos.familyMember.update(memberId!, {
      nickname: '三三改',
      allergies: [{ name: '海鲜', severity: 'mild' }],
    });
    if (u.nickname !== '三三改') throw new Error('nickname 未更新');
    if (u.allergies[0]?.name !== '海鲜') throw new Error('allergies 未替换');
    return u;
  });

  // --- 2. MedicalEventRepository ---
  await runStep(steps, 'medicalEvent.create', async () => {
    const e = await repos.medicalEvent.create({
      member_id: memberId!,
      event_date: '2026-06-15',
      hospital: 'RepoTest 医院',
      department: '内科',
      title: '[RepoTest] 门诊',
      event_type: 'outpatient',
      summary: '例行复诊',
      next_visit_date: null,
    });
    eventId = e.id;
    return e;
  });

  await runStep(steps, 'medicalEvent.listByMember', async () => {
    const list = await repos.medicalEvent.listByMember(memberId!, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    if (!list.some((e) => e.id === eventId)) throw new Error('range 过滤丢失');
    return list.length;
  });

  await runStep(steps, 'medicalEvent.findLatestByMember', async () => {
    const e = await repos.medicalEvent.findLatestByMember(memberId!, 'outpatient');
    if (e === null || e.id !== eventId) throw new Error('未找到最新 outpatient');
    return e;
  });

  await runStep(steps, 'medicalEvent.listRecent', async () => {
    const list = await repos.medicalEvent.listRecent(10);
    if (!list.some((e) => e.id === eventId)) throw new Error('listRecent 未包含');
    return list.length;
  });

  // --- 3. InboxRepository ---
  await runStep(steps, 'inbox.create', async () => {
    const i = await repos.inbox.create({
      capture_type: 'text',
      storage_key: null,
      text_content: '[RepoTest] 待整理条目',
    });
    inboxId = i.id;
    return i;
  });

  await runStep(steps, 'inbox.listPending + countPending', async () => {
    const list = await repos.inbox.listPending();
    const cnt = await repos.inbox.countPending();
    if (cnt < 1) throw new Error('countPending 应 >= 1');
    if (!list.some((i) => i.id === inboxId)) throw new Error('listPending 未包含');
    return { list: list.length, cnt };
  });

  // inbox.archive 用 eventId 作为归档目标
  await runStep(steps, 'inbox.archive', async () => {
    await repos.inbox.archive(inboxId!, eventId!);
    const after = await repos.inbox.getById(inboxId!);
    if (after?.status !== 'archived') throw new Error('archive 未生效');
    if (after?.archived_event_id !== eventId) throw new Error('archived_event_id 未设置');
    return after;
  });

  // --- 4. HealthProblemRepository ---
  await runStep(steps, 'healthProblem.create', async () => {
    const p = await repos.healthProblem.create({
      member_id: memberId!,
      name: '[RepoTest] 高血压',
      status: 'chronic',
      started_date: '2020-01',
      ended_date: null,
      note: 'RepoTest 慢病',
    });
    problemId = p.id;
    return p;
  });

  await runStep(steps, 'healthProblem.findByName', async () => {
    const p = await repos.healthProblem.findByName(memberId!, '[RepoTest] 高血压');
    if (p === null || p.id !== problemId) throw new Error('findByName 未命中');
    return p;
  });

  await runStep(steps, 'healthProblem.findOrCreate (existing)', async () => {
    const p = await repos.healthProblem.findOrCreate(memberId!, '[RepoTest] 高血压');
    if (p.id !== problemId) throw new Error('应返回已存在的 problem, 不是新建');
    return p;
  });

  await runStep(steps, 'healthProblem.findOrCreate (new)', async () => {
    const p = await repos.healthProblem.findOrCreate(memberId!, '[RepoTest] 糖尿病');
    if (p.name !== '[RepoTest] 糖尿病') throw new Error('新建 problem 错误');
    // 清理: 立即删除新建的
    await repos.healthProblem.delete(p.id);
    return p;
  });

  // --- 5. EventProblemRelRepository ---
  await runStep(steps, 'eventProblemRel.attach', async () => {
    await repos.eventProblemRel.attach(eventId!, problemId!);
    // 幂等性: 重复 attach 不应报错
    await repos.eventProblemRel.attach(eventId!, problemId!);
  });

  await runStep(steps, 'eventProblemRel.attachBatch', async () => {
    // 新建 2 个 problem 验证 batch
    const p1 = await repos.healthProblem.create({
      member_id: memberId!,
      name: '[RepoTest] batch1',
      status: 'active',
      started_date: null,
      ended_date: null,
      note: null,
    });
    const p2 = await repos.healthProblem.create({
      member_id: memberId!,
      name: '[RepoTest] batch2',
      status: 'active',
      started_date: null,
      ended_date: null,
      note: null,
    });
    await repos.eventProblemRel.attachBatch(eventId!, [p1.id, p2.id]);
    const problems = await repos.eventProblemRel.listProblemsByEvent(eventId!);
    if (problems.length < 3) throw new Error(`应至少有 3 个关联, 实际 ${problems.length}`);
    // 清理
    await repos.eventProblemRel.detach(eventId!, p1.id);
    await repos.eventProblemRel.detach(eventId!, p2.id);
    await repos.healthProblem.delete(p1.id);
    await repos.healthProblem.delete(p2.id);
  });

  await runStep(steps, 'eventProblemRel.listEventsByProblem', async () => {
    const events = await repos.eventProblemRel.listEventsByProblem(problemId!);
    if (!events.some((e) => e.id === eventId)) throw new Error('反向查询未命中');
    return events.length;
  });

  // --- 6. AttachmentRepository ---
  await runStep(steps, 'attachment.create', async () => {
    const a = await repos.attachment.create({
      event_id: eventId!,
      file_name: '[RepoTest] 化验单.jpg',
      file_type: 'jpg',
      storage_key: 'attachment/[RepoTest]/20260615-120000-deadbeef.jpg',
      doc_type: 'lab_report',
      subtype: 'cbc',
      tags: ['血常规', 'RepoTest'],
    });
    attachmentId = a.id;
    if (a.tags.length !== 2) throw new Error('tags 反序列化错误');
    return a;
  });

  await runStep(steps, 'attachment.listByEvent', async () => {
    const list = await repos.attachment.listByEvent(eventId!);
    if (!list.some((a) => a.id === attachmentId)) throw new Error('listByEvent 未包含');
    return list.length;
  });

  await runStep(steps, 'attachment.getByStorageKey', async () => {
    const a = await repos.attachment.getByStorageKey(
      'attachment/[RepoTest]/20260615-120000-deadbeef.jpg',
    );
    if (a === null || a.id !== attachmentId) throw new Error('storageKey 反查失败');
    return a;
  });

  await runStep(steps, 'attachment.updateTags', async () => {
    const a = await repos.attachment.updateTags(attachmentId!, ['更新后']);
    if (a.tags.length !== 1 || a.tags[0] !== '更新后') throw new Error('tags 未更新');
    return a;
  });

  await runStep(steps, 'attachment.updateProcessingStatus', async () => {
    const a = await repos.attachment.updateProcessingStatus(
      attachmentId!,
      'OCR_PROCESSING',
    );
    if (a.processing_status !== 'OCR_PROCESSING') throw new Error('status 未推进');
    const failed = await repos.attachment.updateProcessingStatus(
      attachmentId!,
      'FAILED',
      'OCR service timeout',
    );
    if (failed.processing_error !== 'OCR service timeout') throw new Error('error 未设置');
    return failed;
  });

  await runStep(steps, 'attachment.findLatestByMember', async () => {
    const a = await repos.attachment.findLatestByMember(memberId!, {
      docType: 'lab_report',
      subtype: 'cbc',
    });
    if (a === null || a.id !== attachmentId) throw new Error('未找到最新 cbc');
    return a;
  });

  // --- 7. AiContentRepository ---
  await runStep(steps, 'aiContent.create', async () => {
    const c = await repos.aiContent.create({
      attachment_id: attachmentId!,
      content_type: 'ocr_fulltext',
      model: 'test-model',
      prompt_version: 'v1',
      content: '[RepoTest] 这是测试 OCR 全文内容, 包含关键词 血常规 和白细胞计数。',
    });
    aiContentId = c.id;
    return c;
  });

  await runStep(steps, 'aiContent.getLatestByAttachment', async () => {
    const c = await repos.aiContent.getLatestByAttachment(attachmentId!, 'ocr_fulltext');
    if (c === null || c.id !== aiContentId) throw new Error('未找到最新');
    return c;
  });

  await runStep(steps, 'aiContent.listVersionsByAttachment', async () => {
    // 再建一个 summary 版本, 验证 content_type 过滤
    await repos.aiContent.create({
      attachment_id: attachmentId!,
      content_type: 'summary',
      model: 'test-model',
      prompt_version: 'v1',
      content: '[RepoTest] 摘要版本',
    });
    const fulltextOnly = await repos.aiContent.listVersionsByAttachment(
      attachmentId!,
      'ocr_fulltext',
    );
    if (fulltextOnly.length !== 1) throw new Error('过滤失败');
    const all = await repos.aiContent.listVersionsByAttachment(attachmentId!);
    if (all.length !== 2) throw new Error('应有两个版本');
    return { fulltext: fulltextOnly.length, all: all.length };
  });

  // --- 8. MedicineRepository ---
  await runStep(steps, 'medicine.create', async () => {
    const m = await repos.medicine.create({
      name: '[RepoTest] 美林',
      usage: '退烧 发热',
      expiry_date: '2026-08',
      storage_location: '药箱A',
      remark: 'RepoTest 药品',
      member_id: memberId,
    });
    medicineId = m.id;
    return m;
  });

  await runStep(steps, 'medicine.listAll', async () => {
    const list = await repos.medicine.listAll();
    if (!list.some((m) => m.id === medicineId)) throw new Error('listAll 未包含');
    return list.length;
  });

  await runStep(steps, 'medicine.listByMember', async () => {
    const list = await repos.medicine.listByMember(memberId!);
    if (!list.some((m) => m.id === medicineId)) throw new Error('listByMember 未包含');
    return list.length;
  });

  await runStep(steps, 'medicine.listByUsage', async () => {
    const list = await repos.medicine.listByUsage('退烧');
    if (!list.some((m) => m.id === medicineId)) throw new Error('listByUsage 未命中');
    return list.length;
  });

  await runStep(steps, 'medicine.listExpiring', async () => {
    // 测试药品 expiry_date = 2026-08, withinDays=90 应包含
    const list = await repos.medicine.listExpiring(90);
    if (!list.some((m) => m.id === medicineId)) throw new Error('listExpiring 未命中');
    return list.length;
  });

  // --- 9. SearchRepository ---
  await runStep(steps, 'search.searchByKeyword (血常规)', async () => {
    const results = await repos.search.searchByKeyword('血常规');
    const hit = results.find((r) => r.attachment.id === attachmentId);
    if (hit === undefined) throw new Error('未命中测试 attachment');
    if (!hit.snippet.includes('血常规')) throw new Error(`snippet 错误: ${hit.snippet}`);
    if (hit.event === null) throw new Error('event 应非 null（已归档）');
    if (hit.member === null) throw new Error('member 应非 null');
    return results.length;
  });

  await runStep(steps, 'search.searchByKeyword + filter (memberId)', async () => {
    const results = await repos.search.searchByKeyword('血常规', {
      memberId: memberId!,
    });
    const hit = results.find((r) => r.attachment.id === attachmentId);
    if (hit === undefined) throw new Error('memberId 过滤后未命中');
    return results.length;
  });

  // --- 清理（按依赖逆序） ---
  await runStep(steps, 'cleanup', async () => {
    // ai_content CASCADE 跟随 attachment 删除
    if (attachmentId !== null) {
      try {
        await repos.attachment.delete(attachmentId);
      } catch {
        /* 可能前面的 step 失败已删, 忽略 */
      }
    }
    // event_problem_rel CASCADE 跟随 event / problem 删除
    if (problemId !== null) {
      try {
        await repos.healthProblem.delete(problemId);
      } catch {
        /* ignore */
      }
    }
    if (eventId !== null) {
      try {
        await repos.medicalEvent.delete(eventId);
      } catch {
        /* ignore */
      }
    }
    if (inboxId !== null) {
      try {
        await repos.inbox.delete(inboxId);
      } catch {
        /* ignore */
      }
    }
    if (medicineId !== null) {
      try {
        await repos.medicine.delete(medicineId);
      } catch {
        /* ignore */
      }
    }
    if (memberId !== null) {
      try {
        await repos.familyMember.delete(memberId);
      } catch {
        /* ignore */
      }
    }
  });

  const passed = steps.filter((s) => s.ok).length;
  const failed = steps.filter((s) => !s.ok).length;
  const totalDurationMs = Math.round(performance.now() - overallStart);

  return {
    ok: failed === 0,
    passed,
    failed,
    totalDurationMs,
    steps,
  };
}

// ============================================================
// Dev-only: 挂载到 window
// ============================================================

/**
 * 将 Repository smoke test 挂载到 window.medmemoryRepoPoc，仅 dev 模式。
 * 用户在浏览器 console 执行 window.medmemoryRepoPoc.runRepositorySmokeTest() 验证。
 */
export function wireRepoPocToWindow(): void {
  if (!import.meta.env?.DEV) {
    return;
  }

  const w = window as unknown as {
    medmemoryRepoPoc?: { runRepositorySmokeTest: typeof runRepositorySmokeTest };
  };
  w.medmemoryRepoPoc = { runRepositorySmokeTest };
}
