import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  SignalCase,
  SignalStatus,
  RiskLevel,
  EvidenceStrength
} from '$lib/models/signal';
import { seedSignals } from '$lib/services/seed';
import {
  STATE_STORAGE_KEY,
  addPendingOp,
  clearAllPendingOps,
  listAllPendingOps,
  mergeStates,
  removePendingOp,
  type PendingOp
} from '$lib/services/persistence';
import { get, writable } from 'svelte/store';

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function statusLabel(status: SignalStatus) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  return labels[status];
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  signal.audit.unshift({
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: now()
  });
  signal.updatedAt = now();
}

// ---- 旧数据迁移：补齐结论证据关联，再失效 ----
function migrateVersion(signal: SignalCase, version: CaseVersion): CaseVersion {
  if (version.evidenceIds && version.status) return version;
  const evidenceAtCreation = signal.evidence.filter((item) => item.createdAt <= version.createdAt);
  const batchMatches = evidenceAtCreation.filter(
    (item) => item.batch === signal.batch || signal.affectedBatches.includes(item.batch)
  );
  const associated = batchMatches.length > 0 ? batchMatches : evidenceAtCreation;
  return {
    ...version,
    evidenceIds: associated.map((item) => item.id),
    status: 'active'
  };
}

function migrateSignal(signal: SignalCase): SignalCase {
  const versions = signal.versions.map((version) => migrateVersion(signal, version));
  const trigger = signal.evidence.find((item) => item.strength === 'contrary');
  const activeCount = versions.filter((version) => version.status === 'active').length;
  if (!trigger || activeCount === 0) return { ...signal, versions };

  const at = now();
  const invalidated = versions.map((version) =>
    version.status === 'active'
      ? {
          ...version,
          status: 'invalid' as const,
          invalidatedAt: at,
          invalidatedBy: trigger.id,
          invalidatedReason: `迁移时检测到相反证据「${trigger.title}」`
        }
      : version
  );
  const tasks = signal.tasks.map((task) =>
    task.status === 'open' || task.status === 'in_progress'
      ? { ...task, status: 'paused' as const }
      : task
  );
  const audit: AuditEntry[] = [
    {
      id: makeId('AUD'),
      actor: '系统',
      action: '结论失效',
      detail: `迁移时检测到相反证据「${trigger.title}」，${activeCount} 个结论版本失效并进入待复核，相关任务暂停关闭。`,
      createdAt: at
    },
    ...signal.audit
  ];
  return {
    ...signal,
    versions: invalidated,
    status: 'review',
    tasks,
    audit,
    updatedAt: at
  };
}

function migrateAll(signals: SignalCase[]): SignalCase[] {
  return signals.map(migrateSignal);
}

function readPersisted(): SignalCase[] {
  if (!browser) return migrateAll(cloneSeed());
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SignalCase[]) : cloneSeed();
    return migrateAll(parsed);
  } catch {
    return migrateAll(cloneSeed());
  }
}

function persist(value: SignalCase[]): boolean {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const internal = writable<SignalCase[]>(readPersisted());

if (browser) {
  internal.subscribe((value) => {
    persist(value);
  });

  // 跨标签页：合并状态，两份证据都保留
  window.addEventListener('storage', (event) => {
    if (event.key === STATE_STORAGE_KEY && event.newValue) {
      try {
        const remote = JSON.parse(event.newValue) as SignalCase[];
        internal.update((local) => mergeStates(local, remote));
      } catch {
        // 忽略损坏的跨标签页状态
      }
    }
  });
}

// ---- 变更应用（幂等，便于重开恢复）----
function invalidateForEvidence(
  signal: SignalCase,
  evidenceId: string,
  actor: string,
  reason: string,
  allActive: boolean
): number {
  let affected = 0;
  signal.versions = signal.versions.map((version) => {
    if (version.status !== 'active') return version;
    if (!allActive && !version.evidenceIds.includes(evidenceId)) return version;
    affected += 1;
    return {
      ...version,
      status: 'invalid',
      invalidatedAt: now(),
      invalidatedBy: evidenceId,
      invalidatedReason: reason
    };
  });
  if (affected > 0) {
    signal.status = 'review';
    signal.tasks = signal.tasks.map((task) =>
      task.status === 'open' || task.status === 'in_progress'
        ? { ...task, status: 'paused' as const }
        : task
    );
    appendAudit(
      signal,
      actor,
      '结论失效',
      `${reason}，${affected} 个结论版本失效并进入待复核，调查任务暂停关闭。`
    );
  }
  return affected;
}

function applyEvidence(signal: SignalCase, evidence: EvidenceItem, actor: string): SignalCase {
  const updated = structuredClone(signal);
  if (updated.evidence.some((item) => item.id === evidence.id)) {
    return updated;
  }
  updated.evidence.unshift(evidence);
  appendAudit(
    updated,
    actor,
    '新增证据',
    `${evidence.title}，证据强度：${evidence.strength}`
  );
  if (evidence.strength === 'contrary') {
    invalidateForEvidence(
      updated,
      evidence.id,
      actor,
      `新登记证据「${evidence.title}」为相反证据`,
      true
    );
  }
  return updated;
}

function applyEvidenceStrength(
  signal: SignalCase,
  evidenceId: string,
  newStrength: EvidenceStrength,
  reason: string,
  actor: string
): SignalCase {
  const updated = structuredClone(signal);
  const evidence = updated.evidence.find((item) => item.id === evidenceId);
  if (!evidence || evidence.strength === newStrength) return updated;
  const previous = evidence.strength;
  evidence.strength = newStrength;
  evidence.strengthChangedAt = now();
  appendAudit(
    updated,
    actor,
    '证据标记变化',
    `证据「${evidence.title}」强度：${previous} → ${newStrength}；依据：${reason}`
  );
  if (newStrength === 'contrary') {
    invalidateForEvidence(
      updated,
      evidenceId,
      actor,
      `证据「${evidence.title}」标记变为相反`,
      false
    );
  }
  return updated;
}

function applyVersion(signal: SignalCase, version: CaseVersion, actor: string): SignalCase {
  const updated = structuredClone(signal);
  if (updated.versions.some((item) => item.id === version.id)) {
    return updated;
  }
  updated.versions.unshift(version);
  appendAudit(updated, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
  return updated;
}

function applyTransition(
  signal: SignalCase,
  nextStatus: SignalStatus,
  reason: string,
  actor: string
): SignalCase {
  const updated = structuredClone(signal);
  if (updated.status === nextStatus) return updated;
  const previous = updated.status;
  updated.status = nextStatus;
  if (nextStatus === 'action_required' && updated.riskLevel === 'low') {
    updated.riskLevel = 'medium';
  }
  appendAudit(
    updated,
    actor,
    '状态流转',
    `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
  );
  return updated;
}

function applyReopen(signal: SignalCase, actor: string, reason: string): SignalCase {
  const updated = structuredClone(signal);
  if (updated.status === 'investigating' && updated.audit.some((entry) => entry.action === '重新打开' && entry.detail.includes(reason))) {
    return updated;
  }
  updated.status = 'investigating';
  updated.reopenedCount += 1;
  appendAudit(updated, actor, '重新打开', reason);
  return updated;
}

function applyTask(signal: SignalCase, task: InvestigationTask): SignalCase {
  const updated = structuredClone(signal);
  const existing = updated.tasks.find((item) => item.id === task.id);
  if (existing && existing.status === task.status) return updated;
  updated.tasks = updated.tasks.map((item) => (item.id === task.id ? task : item));
  appendAudit(updated, task.owner, '更新任务', `${task.title}：${task.status}`);
  return updated;
}

function applyOp(signal: SignalCase, op: PendingOp): SignalCase {
  switch (op.type) {
    case 'evidence':
      return applyEvidence(signal, op.payload.evidence as EvidenceItem, op.payload.actor as string);
    case 'evidence-strength':
      return applyEvidenceStrength(
        signal,
        op.payload.evidenceId as string,
        op.payload.strength as EvidenceStrength,
        op.payload.reason as string,
        op.payload.actor as string
      );
    case 'version':
      return applyVersion(signal, op.payload.version as CaseVersion, op.payload.actor as string);
    case 'transition':
      return applyTransition(
        signal,
        op.payload.nextStatus as SignalStatus,
        op.payload.reason as string,
        op.payload.actor as string
      );
    case 'reopen':
      return applyReopen(signal, op.payload.actor as string, op.payload.reason as string);
    case 'task':
      return applyTask(signal, op.payload.task as InvestigationTask);
    default:
      return signal;
  }
}

// 先写待恢复记录，再提交；持久化成功后才清除
function commit(op: PendingOp, mutator: (signal: SignalCase) => SignalCase) {
  addPendingOp(op);
  internal.update((items) =>
    items.map((signal) => (signal.id === op.signalId ? mutator(signal) : signal))
  );
  if (persist(get(internal))) {
    removePendingOp(op.id);
  }
}

function recoverPendingOps() {
  if (!browser) return;
  const ops = listAllPendingOps();
  if (ops.length === 0) return;
  internal.update((items) =>
    items.map((signal) => {
      let current = signal;
      for (const op of ops) {
        if (op.signalId === current.id) {
          current = applyOp(current, op);
        }
      }
      return current;
    })
  );
  if (persist(get(internal))) {
    clearAllPendingOps();
  }
}

if (browser) {
  recoverPendingOps();
}

export const signalStore = {
  subscribe: internal.subscribe,

  add(signal: SignalCase) {
    internal.update((items) => [signal, ...items]);
  },

  create(input: Omit<SignalCase, 'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount'>) {
    const createdAt = now();
    const signal: SignalCase = {
      ...input,
      id: `SIG-${new Date().getFullYear()}-${String(get(internal).length + 20).padStart(3, '0')}`,
      openedAt: createdAt,
      updatedAt: createdAt,
      reopenedCount: 0,
      audit: [
        {
          id: makeId('AUD'),
          actor: input.owner,
          action: '建立信号',
          detail: `按${input.sourceType}来源建立核查任务。`,
          createdAt
        }
      ]
    };
    internal.update((items) => [signal, ...items]);
    return signal;
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    const op: PendingOp = {
      id: makeId('OP'),
      type: 'transition',
      signalId: id,
      payload: { nextStatus, reason, actor },
      createdAt: now()
    };
    commit(op, (signal) => applyTransition(signal, nextStatus, reason, actor));
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string) {
    const op: PendingOp = {
      id: makeId('OP'),
      type: 'evidence',
      signalId: id,
      recordId: evidence.id,
      payload: { evidence, actor },
      createdAt: now()
    };
    commit(op, (signal) => applyEvidence(signal, evidence, actor));
  },

  changeEvidenceStrength(
    id: string,
    evidenceId: string,
    newStrength: EvidenceStrength,
    reason: string,
    actor: string
  ) {
    const op: PendingOp = {
      id: makeId('OP'),
      type: 'evidence-strength',
      signalId: id,
      recordId: evidenceId,
      payload: { evidenceId, newStrength, reason, actor },
      createdAt: now()
    };
    commit(op, (signal) => applyEvidenceStrength(signal, evidenceId, newStrength, reason, actor));
  },

  addVersion(id: string, version: CaseVersion, actor: string) {
    const op: PendingOp = {
      id: makeId('OP'),
      type: 'version',
      signalId: id,
      recordId: version.id,
      payload: { version, actor },
      createdAt: now()
    };
    commit(op, (signal) => applyVersion(signal, version, actor));
  },

  reopen(id: string, actor: string, reason: string) {
    const op: PendingOp = {
      id: makeId('OP'),
      type: 'reopen',
      signalId: id,
      payload: { actor, reason },
      createdAt: now()
    };
    commit(op, (signal) => applyReopen(signal, actor, reason));
  },

  replaceTask(id: string, task: InvestigationTask) {
    const op: PendingOp = {
      id: makeId('OP'),
      type: 'task',
      signalId: id,
      recordId: task.id,
      payload: { task },
      createdAt: now()
    };
    commit(op, (signal) => applyTask(signal, task));
  },

  addAudit(id: string, entry: AuditEntry) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.audit.unshift(entry);
        updated.updatedAt = entry.createdAt;
        return updated;
      })
    );
  },

  reset() {
    internal.set(cloneSeed());
  },

  getSnapshot() {
    return get(internal);
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  sourceType: SignalCase['sourceType'];
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  return {
    id: `SIG-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`,
    title: input.title,
    product: input.product,
    batch: input.batch,
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 1,
    exposedUnits: 0,
    occurrenceRate: 0,
    occurredAt: input.occurredAt,
    openedAt: nowIso,
    updatedAt: nowIso,
    owner: '待分派',
    description: input.description,
    affectedBatches: [input.batch],
    evidence: [],
    tasks: [
      {
        id: makeId('TASK'),
        title: '核对来源记录与产品批号',
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    audit: [
      {
        id: makeId('AUD'),
        actor: '安全台账',
        action: '建立信号',
        detail: '由人工登记表单创建初始信号。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0
  };
}
