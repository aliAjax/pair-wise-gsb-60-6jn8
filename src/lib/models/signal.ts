import { z } from 'zod';

export const signalStatuses = [
  'new',
  'investigating',
  'observed',
  'action_required',
  'review',
  'closed'
] as const;

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const evidenceStrengths = ['strong', 'moderate', 'weak', 'contrary'] as const;
export const investigationTaskStatuses = ['open', 'in_progress', 'done', 'paused'] as const;

export const createSignalSchema = z.object({
  title: z.string().trim().min(6, '信号标题至少 6 个字符'),
  product: z.string().trim().min(2, '请输入产品名称'),
  batch: z.string().trim().min(2, '请输入批号'),
  sourceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report']),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请选择发生日期'),
  description: z.string().trim().min(10, '经过说明至少 10 个字符')
});

export const transitionSchema = z.object({
  id: z.string().min(1),
  nextStatus: z.enum(signalStatuses),
  reason: z.string().trim().min(4, '请填写流转依据'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明')
});

export const evidenceMarkSchema = z.object({
  id: z.string().min(1, '缺少信号标识'),
  evidenceId: z.string().min(1, '缺少证据标识'),
  strength: z.enum(evidenceStrengths, { message: '请选择变更后的证据强度' }),
  reason: z.string().trim().min(4, '请填写标记变化的依据（至少 4 个字符）'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const versionSchema = z.object({
  id: z.string().min(1),
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据')
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type InvestigationTaskStatus = (typeof investigationTaskStatuses)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];

/** 结论版本状态：有效 / 已失效待复核（失效只追加状态，不删除原版本） */
export type CaseVersionState = 'active' | 'invalidated_pending_review';

/** 证据强度变更记录：原证据与历次标记全部保留，审计只追加 */
export interface StrengthChange {
  id: string;
  strength: EvidenceStrength;
  reason: string;
  actor: string;
  changedAt: string;
}

export interface EvidenceItem {
  id: string;
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  createdAt: string;
  /** 强度变更链：首项为登记时的初始强度，之后每次标记变化向尾部追加 */
  strengthHistory?: StrengthChange[];
  /** 登记为相反证据时明确指向的、被其推翻的结论版本 */
  contradictsVersionIds?: string[];
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: InvestigationTaskStatus;
  /** 暂停关闭前的原状态，用于复核完成后恢复，原任务始终保留 */
  pausedFrom?: InvestigationTaskStatus;
}

export interface CaseVersion {
  id: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  createdAt: string;
  /** 引用的证据 ID 列表，把结论版本与证据矩阵接起来 */
  evidenceIds?: string[];
  state?: CaseVersionState;
  invalidatedAt?: string;
  invalidatedReason?: string;
  /** 触发失效的相反/变更证据 */
  triggerEvidenceId?: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

export interface SignalCase {
  id: string;
  title: string;
  product: string;
  batch: string;
  sourceType: SignalSourceType;
  status: SignalStatus;
  riskLevel: RiskLevel;
  severity: number;
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  occurredAt: string;
  openedAt: string;
  updatedAt: string;
  owner: string;
  description: string;
  affectedBatches: string[];
  evidence: EvidenceItem[];
  tasks: InvestigationTask[];
  versions: CaseVersion[];
  audit: AuditEntry[];
  reopenedCount: number;
  /** 本地数据结构版本，用于旧数据分批迁移 */
  schemaVersion?: number;
}

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}
