// ============================================================
// MedMemory — Repository 实现层统一导出
// ============================================================
// Domain 层 / UI 层通过此文件拿 Repository 实例, 不直接 import 具体实现文件。
//
// 用法:
//   import { createRepositories } from '@/repositories';
//   const repos = await createRepositories();
//   const member = await repos.familyMember.create({ name: '张三', ... });
// ============================================================

import { getDb } from '@/db/connection';
import { AiContentRepositoryImpl } from '@/repositories/aiContentRepository';
import { AiInterpretationRepositoryImpl } from '@/repositories/aiInterpretationRepository';
import { AttachmentRepositoryImpl } from '@/repositories/attachmentRepository';
import { EventProblemRelRepositoryImpl } from '@/repositories/eventProblemRelRepository';
import { FamilyMemberRepositoryImpl } from '@/repositories/familyMemberRepository';
import { HealthProblemRepositoryImpl } from '@/repositories/healthProblemRepository';
import { InboxRepositoryImpl } from '@/repositories/inboxRepository';
import { MedicalEventRepositoryImpl } from '@/repositories/medicalEventRepository';
import { MedicineRepositoryImpl } from '@/repositories/medicineRepository';
import { ReportIndicatorRepositoryImpl } from '@/repositories/reportIndicatorRepository';
import { SearchRepositoryImpl } from '@/repositories/searchRepository';

/**
 * 所有 Repository 的集合。
 * 每个字段对应一个表 / 跨表聚合读, 接口类型见 interfaces.ts。
 */
export interface Repositories {
  familyMember: InstanceType<typeof FamilyMemberRepositoryImpl>;
  medicalEvent: InstanceType<typeof MedicalEventRepositoryImpl>;
  inbox: InstanceType<typeof InboxRepositoryImpl>;
  healthProblem: InstanceType<typeof HealthProblemRepositoryImpl>;
  eventProblemRel: InstanceType<typeof EventProblemRelRepositoryImpl>;
  attachment: InstanceType<typeof AttachmentRepositoryImpl>;
  aiContent: InstanceType<typeof AiContentRepositoryImpl>;
  aiInterpretation: InstanceType<typeof AiInterpretationRepositoryImpl>;
  reportIndicator: InstanceType<typeof ReportIndicatorRepositoryImpl>;
  medicine: InstanceType<typeof MedicineRepositoryImpl>;
  search: InstanceType<typeof SearchRepositoryImpl>;
}

/**
 * 初始化所有 Repository（共享 getDb() 单例句柄）。
 *
 * 首次调用会触发 sqlite-wasm 初始化 + OPFS 打开;
 * 后续调用复用同一个 DbHandle（connection.ts 单例保证）。
 *
 * @example
 * ```ts
 * const repos = await createRepositories();
 * const member = await repos.familyMember.getById(1);
 * ```
 */
export async function createRepositories(): Promise<Repositories> {
  const db = await getDb();
  return {
    familyMember: new FamilyMemberRepositoryImpl(db),
    medicalEvent: new MedicalEventRepositoryImpl(db),
    inbox: new InboxRepositoryImpl(db),
    healthProblem: new HealthProblemRepositoryImpl(db),
    eventProblemRel: new EventProblemRelRepositoryImpl(db),
    attachment: new AttachmentRepositoryImpl(db),
    aiContent: new AiContentRepositoryImpl(db),
    aiInterpretation: new AiInterpretationRepositoryImpl(db),
    reportIndicator: new ReportIndicatorRepositoryImpl(db),
    medicine: new MedicineRepositoryImpl(db),
    search: new SearchRepositoryImpl(db),
  };
}

// 导出实现类（供 PoC / 测试代码单独构造, 不经过工厂）
export {
  AiContentRepositoryImpl,
  AiInterpretationRepositoryImpl,
  AttachmentRepositoryImpl,
  EventProblemRelRepositoryImpl,
  FamilyMemberRepositoryImpl,
  HealthProblemRepositoryImpl,
  InboxRepositoryImpl,
  MedicalEventRepositoryImpl,
  MedicineRepositoryImpl,
  ReportIndicatorRepositoryImpl,
  SearchRepositoryImpl,
};

// 导出接口与基础类型（供 Domain 层 import 不必指 interfaces.ts）
export type {
  AiContent,
  AiContentCreateInput,
  AiContentRepository,
  AiContentType,
  AiInterpretation,
  AiInterpretationCreateInput,
  AiInterpretationKind,
  AiInterpretationRepository,
  Allergy,
  Attachment,
  AttachmentCreateInput,
  AttachmentRepository,
  ChronicCondition,
  DocType,
  EventType,
  FamilyMember,
  FamilyMemberCreateInput,
  FamilyMemberRepository,
  FamilyMemberUpdateInput,
  HealthProblem,
  HealthProblemCreateInput,
  HealthProblemRepository,
  HealthProblemStatus,
  HealthProblemUpdateInput,
  InboxItem,
  InboxItemCreateInput,
  InboxRepository,
  LabIndicator,
  LabIndicatorCreateInput,
  MedicalEvent,
  MedicalEventCreateInput,
  MedicalEventRepository,
  MedicalEventUpdateInput,
  Medicine,
  MedicineCreateInput,
  MedicineRepository,
  MedicineUpdateInput,
  ProcessingStatus,
  ReportIndicatorRepository,
  SearchFilter,
  SearchRepository,
  SearchResult,
} from '@/repositories/interfaces';

export { RepositoryError } from '@/repositories/base';
export type { RepositoryPhase } from '@/repositories/base';
