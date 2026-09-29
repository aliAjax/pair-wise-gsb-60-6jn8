import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  EvidenceStrength,
  InvestigationTask,
  SignalCase,
  SignalStatus
} from '$lib/models/signal';

/**
 * 领域规则（纯函数）：
 * 把证据、结论版本、批次与调查任务接起来。
 * 新证据标成相反，或已有证据强度标记变化后：
 *   1. 引用过该证据的结论版本立即失效，进入待复核；
 *   2. 原结论记录保留（只追加失效状态，不回写、不删除）；
 *   3. 信号不再按「已处置」统计（closed -> review）；
 *   4. 原调查任务保留但暂停关闭（done -> paused）。
 */

export const CURRENT_SCHEMA_VERSION = 2;

let counter = 0;
function now() {
  return new Date().toISOString();
}

export function makeId(prefix: string) {
  counter = (counter + 1) % 1_000_000;
  const rand =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${rand}`;
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string, at = now()) {
  // 审计只追加（unshift 保持时间线倒序展示），历史条目绝不回写
  signal.audit.unshift({ id: makeId('AUD'), actor, action, detail, createdAt: at });
  signal.updatedAt = at;
}

const CONTRARY_LABEL: Record<EvidenceStrength, string> = {
  strong: '强支持',
  moderate: '中等支持',
  weak: '弱支持',
  contrary: '相反证据'
};

/** 该信号当前是否存在有效（未失效）的结论版本 */
export function hasActiveVersion(signal: SignalCase): boolean {
  return signal.versions.some((v) => (v.state ?? 'active') === 'active');
}

/**
 * 批次/信号是否按「已处置」统计：
 * 只有信号已关闭且当前结论版本仍然有效才算已处置；
 * 结论一旦失效待复核，立即退出已处置口径。
 */
export function isDispositionSettled(signal: SignalCase): boolean {
  return signal.status === 'closed' && hasActiveVersion(signal);
}

/**
 * 触发证据变化后的联动（原子操作的核心）。
 * 返回受影响而失效的版本 ID 列表。
 */
function invalidateLinkedConclusions(
  signal: SignalCase,
  triggerEvidence: EvidenceItem,
  actor: string,
  at: string,
  opts: { isNewContrary: boolean }
): string[] {
  const invalidatedIds: string[] = [];

  for (const version of signal.versions) {
    const state = version.state ?? 'active';
    const linked =
      // 版本显式引用过该证据
      (version.evidenceIds ?? []).includes(triggerEvidence.id) ||
      // 新登记的相反证据：指向当前有效版本即触发
      // （显式选择见 applyEvidenceRegistered；旧数据迁移阶段先补显式关联，见 migrateSignal）
      (opts.isNewContrary &&
        state === 'active' &&
        (triggerEvidence.contradictsVersionIds?.includes(version.id) ?? false));

    if (!linked || state !== 'active') continue;

    version.state = 'invalidated_pending_review';
    version.invalidatedAt = at;
    version.invalidatedReason = opts.isNewContrary
      ? `相反证据《${triggerEvidence.title}》登记，结论进入待复核`
      : `引用证据《${triggerEvidence.title}》强度变更为「${CONTRARY_LABEL[triggerEvidence.strength]}」，结论进入待复核`;
    version.triggerEvidenceId = triggerEvidence.id;
    invalidatedIds.push(version.id);

    appendAudit(
      signal,
      actor,
      '结论失效',
      `V${version.version} 原结论「${version.summary}」失效，进入待复核；触发证据：${triggerEvidence.title}（${CONTRARY_LABEL[triggerEvidence.strength]}）。原版本保留备查。`,
      at
    );
  }

  if (invalidatedIds.length > 0) {
    // 批次不再按已处置统计：关闭信号回到复核中；其他状态也一律进入待复核
    if (signal.status === 'closed') {
      signal.status = 'review';
      signal.reopenedCount += 1;
      appendAudit(
        signal,
        actor,
        '退出已处置',
        `结论失效待复核，关联批次 ${signal.affectedBatches.join('、')} 不再按已处置统计，信号回到复核中。`,
        at
      );
    } else if (signal.status !== 'review') {
      signal.status = 'review';
      appendAudit(
        signal,
        actor,
        '进入复核',
        `有效结论因证据变化失效，批次 ${signal.affectedBatches.join('、')} 的处置口径挂起，信号进入复核中。`,
        at
      );
    }

    // 原调查任务保留但暂停关闭
    for (const task of signal.tasks) {
      if (task.status === 'done') {
        task.pausedFrom = 'done';
        task.status = 'paused';
        appendAudit(
          signal,
          actor,
          '任务暂停',
          `调查任务「${task.title}」原已关闭，结论失效后暂停关闭，待复核后确认。`,
          at
        );
      }
    }
  }

  return invalidatedIds;
}

export interface EvidenceInput {
  id: string;
  type: EvidenceItem['type'];
  title: string;
  source: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  actor: string;
  /** 登记时手工勾选引用该证据的结论版本（可空，相反证据默认指向当前有效版本） */
  referencedVersionIds?: string[];
}

/** 事件：登记新证据。相反证据与结论失效、批次统计在同一原子操作内生效 */
export function applyEvidenceRegistered(signal: SignalCase, input: EvidenceInput, at = now()): SignalCase {
  const evidence: EvidenceItem = {
    id: input.id,
    type: input.type,
    title: input.title,
    source: input.source,
    strength: input.strength,
    batch: input.batch,
    note: input.note,
    createdAt: at,
    strengthHistory: [
      { id: makeId('STRENGTH'), strength: input.strength, reason: '证据登记初始强度', actor: input.actor, changedAt: at }
    ],
    contradictsVersionIds: input.strength === 'contrary' ? input.referencedVersionIds ?? [] : undefined
  };

  signal.evidence.unshift(evidence);
  appendAudit(
    signal,
    input.actor,
    '新增证据',
    `${evidence.title}，证据强度：${CONTRARY_LABEL[evidence.strength]}，批号：${evidence.batch}。`,
    at
  );

  if (input.strength === 'contrary') {
    // 未显式选择时默认指向全部当前有效版本
    const targets =
      input.referencedVersionIds && input.referencedVersionIds.length > 0
        ? input.referencedVersionIds
        : signal.versions.filter((v) => (v.state ?? 'active') === 'active').map((v) => v.id);
    evidence.contradictsVersionIds = targets;
    invalidateLinkedConclusions(signal, evidence, input.actor, at, { isNewContrary: true });
  }

  return signal;
}

/** 事件：已有证据强度标记变化（原证据保留，变化只追加到 strengthHistory） */
export function applyEvidenceStrengthChanged(
  signal: SignalCase,
  evidenceId: string,
  strength: EvidenceStrength,
  reason: string,
  actor: string,
  at = now()
): SignalCase {
  const evidence = signal.evidence.find((item) => item.id === evidenceId);
  if (!evidence) return signal;

  const previous = evidence.strength;
  if (previous === strength) return signal;

  evidence.strength = strength;
  evidence.strengthHistory ??= [
    { id: makeId('STRENGTH'), strength: previous, reason: '证据登记初始强度', actor, changedAt: evidence.createdAt }
  ];
  evidence.strengthHistory.push({ id: makeId('STRENGTH'), strength, reason, actor, changedAt: at });

  appendAudit(
    signal,
    actor,
    '证据标记变化',
    `《${evidence.title}》强度：${CONTRARY_LABEL[previous]} -> ${CONTRARY_LABEL[strength]}；依据：${reason}。原标记保留。`,
    at
  );

  invalidateLinkedConclusions(signal, evidence, actor, at, { isNewContrary: false });
  return signal;
}

export function applyVersionCreated(signal: SignalCase, version: CaseVersion, actor: string, at = now()): SignalCase {
  const stamped: CaseVersion = {
    ...version,
    evidenceIds: version.evidenceIds ?? signal.evidence.map((item) => item.id),
    state: 'active',
    createdAt: version.createdAt ?? at
  };
  signal.versions.unshift(stamped);
  const refs = stamped.evidenceIds ?? [];
  appendAudit(
    signal,
    actor,
    '形成版本',
    `版本 V${stamped.version}：${stamped.summary}；引用证据 ${refs.length} 项。`,
    at
  );
  return signal;
}

export function applyTransition(
  signal: SignalCase,
  nextStatus: SignalStatus,
  reason: string,
  actor: string,
  at = now()
): SignalCase {
  const previous = signal.status;
  signal.status = nextStatus;
  if (nextStatus === 'action_required' && signal.riskLevel === 'low') {
    signal.riskLevel = 'medium';
  }
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  appendAudit(signal, actor, '状态流转', `${labels[previous]} -> ${labels[nextStatus]}；依据：${reason}`, at);
  return signal;
}

export function applyReopen(signal: SignalCase, actor: string, reason: string, at = now()): SignalCase {
  signal.status = 'investigating';
  signal.reopenedCount += 1;
  appendAudit(signal, actor, '重新打开', reason, at);
  return signal;
}

export function applyTaskReplaced(signal: SignalCase, task: InvestigationTask, at = now()): SignalCase {
  signal.tasks = signal.tasks.map((item) => (item.id === task.id ? task : item));
  appendAudit(signal, task.owner, '更新任务', `${task.title}：${task.status}`, at);
  return signal;
}

export function applyAuditAppended(signal: SignalCase, entry: AuditEntry): SignalCase {
  signal.audit.unshift(entry);
  signal.updatedAt = entry.createdAt;
  return signal;
}

// ---------------------------------------------------------------------------
// 旧数据迁移：缺少证据关联时，先迁移原结论，补齐关联后再失效。
// 分三个可审计阶段顺序执行，历史审计只追加不回写。
// ---------------------------------------------------------------------------

export function migrateSignal(input: SignalCase): SignalCase {
  let signal = structuredClone(input);
  const at = now();

  if ((signal.schemaVersion ?? 1) >= CURRENT_SCHEMA_VERSION) return signal;

  // 阶段 1：迁移原结论 —— 原版本记录与原审计一律保留，仅补默认状态
  for (const version of signal.versions) {
    if (!version.state) version.state = 'active';
  }

  // 阶段 2：补齐证据关联 —— 旧版本没有 evidenceIds，无法区分引用范围，
  // 按保守口径把矩阵中全部证据关联为该版本引用过的证据
  // （相反证据可能晚于版本登记，不能用登记时间截断），随后在阶段 3 统一判定失效。
  for (const version of signal.versions) {
    if (!version.evidenceIds) {
      version.evidenceIds = signal.evidence.map((item) => item.id);
    }
  }
  for (const item of signal.evidence) {
    if (!item.strengthHistory) {
      item.strengthHistory = [
        {
          id: makeId('STRENGTH'),
          strength: item.strength,
          reason: '历史数据迁移：补录登记时初始强度',
          actor: '系统迁移',
          changedAt: item.createdAt
        }
      ];
    }
  }

  // 阶段 3：关联补齐后再失效 —— 历史证据中若已存在相反证据，
  // 说明旧口径下仍按有效/已处置统计是错误的，补做失效联动。
  const contraryEvidence = signal.evidence.filter((item) => item.strength === 'contrary');
  for (const evidence of contraryEvidence) {
    const linkedVersions = signal.versions.filter(
      (v) => (v.state ?? 'active') === 'active' && (v.evidenceIds ?? []).includes(evidence.id)
    );
    if (linkedVersions.length === 0) continue;

    for (const version of linkedVersions) {
      version.state = 'invalidated_pending_review';
      version.invalidatedAt = at;
      version.invalidatedReason = '历史数据迁移：发现结论引用过相反证据，补做失效并进入待复核';
      version.triggerEvidenceId = evidence.id;
      evidence.contradictsVersionIds ??= [];
      if (!evidence.contradictsVersionIds.includes(version.id)) evidence.contradictsVersionIds.push(version.id);
    }
    if (signal.status === 'closed') {
      signal.status = 'review';
      signal.reopenedCount += 1;
    } else if (signal.status !== 'review') {
      signal.status = 'review';
    }
    for (const task of signal.tasks) {
      if (task.status === 'done') {
        task.pausedFrom = 'done';
        task.status = 'paused';
      }
    }
  }

  signal.schemaVersion = CURRENT_SCHEMA_VERSION;

  // 迁移动作本身也只追加审计
  appendAudit(
    signal,
    '系统迁移',
    '数据结构迁移',
    `迁移至 V${CURRENT_SCHEMA_VERSION}：保留原结论与原证据，补齐结论-证据关联${contraryEvidence.length > 0 ? '，并对引用相反证据的结论补做失效' : ''}；历史审计未回写。`,
    at
  );

  return signal;
}
