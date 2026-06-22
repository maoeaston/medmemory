// ============================================================
// MedMemory — Repository 接口层（数据访问边界）
// ============================================================
// 对应 schema: db/migrations/001_initial.sql（8 业务表）
// 方法集来源: PRD v3.1 第 7 节（Dashboard / 时间线 / 关键词搜索 / 药箱预警 / 附件查询）
// 分层位置: schema → 【Repository 接口】 → sqlite-wasm PoC → Storage Adapter → 迁移 → Domain → UI
//
// 设计约定:
//   1. 每张业务表一个 Repository 接口, 单一职责
//   2. 跨表聚合读（如关键词搜索）单独抽 SearchRepository, 不污染单表 Repo
//   3. JSON 字段（allergies / chronic_conditions / current_medications / tags）
//      在 TS 层用强类型, Repository 实现负责 TEXT 序列化/反序列化
//   4. 时间字段统一 ISO 8601 UTC 字符串（YYYY-MM-DDTHH:MM:SSZ 或 YYYY-MM-DD / YYYY-MM）
//   5. 查询类方法找不到返回 null / [], 写入/更新失败抛 Error
//   6. CreateInput 用 Omit 派生, 避免重复定义; DB 自增字段（id/created_at/updated_at）由实现层填
//   7. MVP 不分页（自用家庭, 数据量小）; 列表方法默认按时间倒序
// ============================================================

// ============================================================
// 实体类型（对应 schema 列）
// ============================================================

/** 过敏条目（family_members.allergies JSON 数组元素） */
export interface Allergy {
  name: string;
  severity: 'mild' | 'moderate' | 'severe';
  reaction?: string;
}

/** 慢性病条目（family_members.chronic_conditions JSON 数组元素） */
export interface ChronicCondition {
  name: string;
  status: 'active' | 'managed' | 'resolved';
  diagnosed_date?: string; // YYYY-MM
}

/** 事件类型（medical_events.event_type, 对应 PRD 7.4） */
export type EventType =
  | 'outpatient'
  | 'emergency'
  | 'checkup'
  | 'followup'
  | 'vaccine'
  | 'hospitalization'
  | 'other';

/** 附件处理状态机（attachments.processing_status, 对应 PRD 7.5） */
export type ProcessingStatus =
  | 'UPLOADED'
  | 'OCR_PROCESSING'
  | 'OCR_DONE'
  | 'SUMMARY_DONE'
  | 'FAILED';

/** AI 内容类型（ai_contents.content_type, 对应 PRD 7.6） */
export type AiContentType = 'summary' | 'ocr_fulltext';

/** 附件文档大类（attachments.doc_type） */
export type DocType =
  | 'outpatient_record'
  | 'lab_report'
  | 'imaging_report'
  | 'prescription'
  | 'discharge_summary'
  | 'receipt'
  | 'other';

/** 健康问题状态（health_problems.status） */
export type HealthProblemStatus = 'active' | 'chronic' | 'resolved';

export interface FamilyMember {
  id: number;
  name: string;
  nickname: string | null;
  birthday: string | null; // YYYY-MM-DD
  gender: 'male' | 'female' | 'other' | null;
  allergies: Allergy[]; // JSON
  chronic_conditions: ChronicCondition[]; // JSON
  current_medications: string[]; // JSON
  remark: string | null;
  created_at: string;
  updated_at: string;
}

export interface MedicalEvent {
  id: number;
  member_id: number;
  event_date: string; // YYYY-MM-DD
  hospital: string | null;
  department: string | null;
  title: string;
  event_type: EventType;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxItem {
  id: number;
  capture_type: 'photo' | 'voice' | 'text';
  storage_key: string | null;
  text_content: string | null;
  created_at: string;
  status: 'pending' | 'archived';
  archived_event_id: number | null;
}

export interface HealthProblem {
  id: number;
  member_id: number;
  name: string;
  status: HealthProblemStatus;
  started_date: string | null; // YYYY-MM
  ended_date: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: number;
  event_id: number | null; // Quick Capture 未归档时可空
  file_name: string;
  file_type: 'jpg' | 'png' | 'pdf';
  storage_key: string;
  doc_type: DocType | null;
  subtype: string | null; // 自由文本子类（cbc/ct/mri...）, 与 tags 不混用
  tags: string[]; // JSON
  processing_status: ProcessingStatus;
  processing_error: string | null;
  ai_generated: boolean; // INTEGER 0/1, 实现层转换
  created_at: string;
}

export interface AiContent {
  id: number;
  attachment_id: number;
  content_type: AiContentType;
  model: string;
  prompt_version: string;
  content: string;
  created_at: string;
}

export interface Medicine {
  id: number;
  name: string;
  usage: string | null; // v3.1: 退烧/过敏/腹泻..., 支持"发烧吃什么"式检索
  expiry_date: string | null; // YYYY-MM
  storage_location: string | null;
  remark: string | null;
  member_id: number | null; // 可空表示家庭共用
  photo_path: string | null; // 第二阶段
  source_event_id: number | null; // 第二阶段
  created_at: string;
  updated_at: string;
}

// ============================================================
// CreateInput 派生类型（自增/默认字段由实现层填）
// ============================================================

export type FamilyMemberCreateInput = Omit<
  FamilyMember,
  'id' | 'created_at' | 'updated_at'
>;
export type FamilyMemberUpdateInput = Partial<FamilyMemberCreateInput>;

export type MedicalEventCreateInput = Omit<
  MedicalEvent,
  'id' | 'created_at' | 'updated_at'
>;
export type MedicalEventUpdateInput = Partial<MedicalEventCreateInput>;

export type InboxItemCreateInput = Pick<
  InboxItem,
  'capture_type' | 'storage_key' | 'text_content'
>;

export type HealthProblemCreateInput = Omit<
  HealthProblem,
  'id' | 'created_at' | 'updated_at'
> & {
  status?: HealthProblemStatus; // 默认 'active'
};
export type HealthProblemUpdateInput = Partial<
  Omit<HealthProblem, 'id' | 'created_at' | 'updated_at' | 'member_id'>
>;

export type AttachmentCreateInput = Pick<
  Attachment,
  | 'event_id'
  | 'file_name'
  | 'file_type'
  | 'storage_key'
  | 'doc_type'
  | 'subtype'
  | 'tags'
>;

export type AiContentCreateInput = Pick<
  AiContent,
  'attachment_id' | 'content_type' | 'model' | 'prompt_version' | 'content'
>;

export type MedicineCreateInput = Omit<
  Medicine,
  'id' | 'created_at' | 'updated_at' | 'photo_path' | 'source_event_id'
> & {
  photo_path?: null;
  source_event_id?: null;
};
export type MedicineUpdateInput = Partial<Omit<MedicineCreateInput, 'member_id'>>;

// ============================================================
// 1. FamilyMemberRepository
// 对应 PRD: 7.2 Dashboard 成员卡片 / 7.3 成员管理 / 7.4 创建事件时强制展示过敏慢病
// ============================================================
export interface FamilyMemberRepository {
  create(input: FamilyMemberCreateInput): Promise<FamilyMember>;
  getById(id: number): Promise<FamilyMember | null>;
  /** 全部成员（Dashboard 首屏循环渲染成员卡片） */
  list(): Promise<FamilyMember[]>;
  update(id: number, input: FamilyMemberUpdateInput): Promise<FamilyMember>;
  delete(id: number): Promise<void>; // schema ON DELETE CASCADE: 事件/健康问题级联删
}

// ============================================================
// 2. MedicalEventRepository
// 对应 PRD: 7.2 Dashboard 最近一次 / 7.4 事件 CRUD / 7.7 时间线视图 A
// ============================================================
export interface MedicalEventRepository {
  create(input: MedicalEventCreateInput): Promise<MedicalEvent>;
  getById(id: number): Promise<MedicalEvent | null>;
  update(id: number, input: MedicalEventUpdateInput): Promise<MedicalEvent>;
  delete(id: number): Promise<void>;

  /** 成员的事件列表（时间线视图 A：按时间倒序） */
  listByMember(
    memberId: number,
    range?: { from?: string; to?: string } // YYYY-MM-DD
  ): Promise<MedicalEvent[]>;

  /** 跨成员全量事件（时间线视图: 按 event_date 倒序, 区别于 listRecent 的 created_at 语义） */
  listAll(): Promise<MedicalEvent[]>;

  /** Dashboard "最近一次"维度：最近一次就诊/体检/住院（按 event_type） */
  findLatestByMember(
    memberId: number,
    eventType: EventType
  ): Promise<MedicalEvent | null>;

  /** Dashboard 底部"最近事件"（跨成员） */
  listRecent(limit: number): Promise<MedicalEvent[]>;
}

// ============================================================
// 3. InboxRepository
// 对应 PRD: 7.1 Quick Capture（MVP 最高优先级）
// 归档逻辑（capture_type=photo/voice 的 storage_key 转 attachment）由 Domain 层编排
// ============================================================
export interface InboxRepository {
  create(input: InboxItemCreateInput): Promise<InboxItem>;
  getById(id: number): Promise<InboxItem | null>;
  /** Dashboard "📥 N 条待整理" */
  listPending(): Promise<InboxItem[]>;
  countPending(): Promise<number>;
  /** 归档：标记 status=archived + 关联 event（媒体转 attachment 由 Domain 层做） */
  archive(id: number, archivedEventId: number): Promise<void>;
  delete(id: number): Promise<void>;
}

// ============================================================
// 4. HealthProblemRepository
// 对应 PRD: 7.4 AI 辅助关联（MVP 不做手工 CRUD） / 7.7 时间线视图 B
// MVP 交互：AI 推荐 + 一键确认, findOrCreate 支撑"已有 vs 新建"分支
// ============================================================
export interface HealthProblemRepository {
  create(input: HealthProblemCreateInput): Promise<HealthProblem>;
  getById(id: number): Promise<HealthProblem | null>;
  update(id: number, input: HealthProblemUpdateInput): Promise<HealthProblem>;
  delete(id: number): Promise<void>;

  /** 成员的健康问题列表（时间线视图 B 侧栏 + Dashboard 慢病高亮） */
  listByMember(memberId: number): Promise<HealthProblem[]>;

  /** AI 推荐"已有,3 次关联"时查同名问题是否已存在 */
  findByName(
    memberId: number,
    name: string
  ): Promise<HealthProblem | null>;

  /** 一键确认的"新建"分支: 存在则返回, 不存在则建 */
  findOrCreate(
    memberId: number,
    name: string
  ): Promise<HealthProblem>;
}

// ============================================================
// 5. EventProblemRelRepository
// 对应 PRD: 7.4 关联 / 7.7 时间线视图 B（按问题聚合事件）
// 多对多关联表, 无独立业务实体, 直接返回关联的 HealthProblem / MedicalEvent
// ============================================================
export interface EventProblemRelRepository {
  /** 单条关联（手工或 AI 推荐单个） */
  attach(eventId: number, problemId: number): Promise<void>;
  /** AI 推荐批量确认（用户可一次勾选多个） */
  attachBatch(eventId: number, problemIds: number[]): Promise<void>;
  detach(eventId: number, problemId: number): Promise<void>;

  /** 事件详情页展示已关联的健康问题 */
  listProblemsByEvent(eventId: number): Promise<HealthProblem[]>;

  /** 时间线视图 B: 按健康问题聚合所有关联事件（按 event_date 倒序） */
  listEventsByProblem(problemId: number): Promise<MedicalEvent[]>;
}

// ============================================================
// 6. AttachmentRepository
// 对应 PRD: 7.5 归档 + processing_status 状态机 / 7.2 Dashboard 最近血常规
// 原件文件的读写走 StorageAdapter, 本 Repo 只管 metadata 行
// ============================================================
export interface AttachmentRepository {
  create(input: AttachmentCreateInput): Promise<Attachment>;
  getById(id: number): Promise<Attachment | null>;
  /** 事件详情页的附件列表 */
  listByEvent(eventId: number): Promise<Attachment[]>;
  /** ADR-004: 按 storage_key 反查（导入/校验/迁移场景） */
  getByStorageKey(storageKey: string): Promise<Attachment | null>;
  updateTags(id: number, tags: string[]): Promise<Attachment>;
  /** 状态机推进（PRD 7.5）: FAILED 时传 processingError */
  updateProcessingStatus(
    id: number,
    status: ProcessingStatus,
    processingError?: string | null
  ): Promise<Attachment>;
  delete(id: number): Promise<void>; // 原件删除由 Domain 层调 StorageAdapter

  /**
   * Dashboard "最近血常规": 按成员 + doc_type/subtype 找最近一份附件
   * 例: findLatestByMember(memberId, { docType: 'lab_report', subtype: 'cbc' })
   */
  findLatestByMember(
    memberId: number,
    filter: { docType?: DocType; subtype?: string }
  ): Promise<Attachment | null>;
}

// ============================================================
// 7. AiContentRepository
// 对应 PRD: 7.6 多版本 / 7.8 关键词搜索（ocr_fulltext 数据源）
// 多模型/多版本: 同一 attachment 可有多条, 按 created_at 取最新
// ============================================================
export interface AiContentRepository {
  create(input: AiContentCreateInput): Promise<AiContent>;
  getById(id: number): Promise<AiContent | null>;
  /** 取最新一条（事件页快速浏览 / 重新生成的对比基准） */
  getLatestByAttachment(
    attachmentId: number,
    contentType: AiContentType
  ): Promise<AiContent | null>;
  /** 重新生成时列历史版本可对比 */
  listVersionsByAttachment(
    attachmentId: number,
    contentType?: AiContentType
  ): Promise<AiContent[]>;
  delete(id: number): Promise<void>;
}

// ============================================================
// 8. MedicineRepository
// 对应 PRD: 7.10 药箱清单（v3.1 加 usage） / 7.2 Dashboard 过期计数
// ============================================================
export interface MedicineRepository {
  create(input: MedicineCreateInput): Promise<Medicine>;
  getById(id: number): Promise<Medicine | null>;
  update(id: number, input: MedicineUpdateInput): Promise<Medicine>;
  delete(id: number): Promise<void>;

  listAll(): Promise<Medicine[]>;
  listByMember(memberId: number): Promise<Medicine[]>;

  /** 按用途检索（"退烧"→美林/泰诺）, 支持模糊匹配 */
  listByUsage(usageKeyword: string): Promise<Medicine[]>;

  /**
   * 过期预警（Dashboard 高亮 + 药箱页）
   * @param withinDays 即将过期窗口（默认 30 天）; 已过期一定包含
   * @returns 按到期日升序
   */
  listExpiring(withinDays?: number): Promise<Medicine[]>;
}

// ============================================================
// 9. SearchRepository（跨表聚合读, 不属于单一表）
// 对应 PRD: 7.8 关键词搜索（ocr_fulltext LIKE, MVP 不需 RAG）
// 结果以 attachment 为单位, join 出 event + member 供 UI 展示
// ============================================================
export interface SearchResult {
  attachment: Attachment;
  /** 命中片段（截取 keyword 周边上下文, UI 高亮） */
  snippet: string;
  event: MedicalEvent | null; // 未归档附件可能 event_id 为空
  member: FamilyMember | null; // event 为空时反查不到 member
}

export interface SearchFilter {
  memberId?: number;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
}

export interface SearchRepository {
  /**
   * 在所有 ai_contents (content_type='ocr_fulltext) 上做 LIKE 匹配
   * 命中后反查 attachment → event → member
   * 实现注意: snippet 截取规则由实现层定义（如 keyword 前后各 50 字）
   */
  searchByKeyword(
    keyword: string,
    filter?: SearchFilter
  ): Promise<SearchResult[]>;
}
