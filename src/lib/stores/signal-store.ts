import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceStrength,
  InvestigationTask,
  RiskLevel,
  SignalCase,
  SignalStatus
} from '$lib/models/signal';
import {
  applyAuditAppended,
  applyEvidenceRegistered,
  applyEvidenceStrengthChanged,
  applyReopen,
  applyTaskReplaced,
  applyTransition,
  applyVersionCreated,
  CURRENT_SCHEMA_VERSION,
  makeId,
  migrateSignal
} from '$lib/services/signal-domain';
import { seedSignals } from '$lib/services/seed';
import { get, writable } from 'svelte/store';

/**
 * 持久化采用「操作日志（write-ahead journal）+ 状态快照」：
 *  - 任何修改先把事件追加进 journal 并落盘，再推导内存状态，最后写快照；
 *  - 写快照失败/页面被杀，重开时重放 journal 即可恢复（事件是唯一事实来源）；
 *  - 两个窗口同时保存证据：各自事件都带全局唯一 ID，storage 事件按事件 ID 合并，
 *    两份证据记录都会留下；
 *  - 旧数据一次性迁移为 snapshot 事件，已确认结论和原证据不丢失。
 */

const JOURNAL_KEY = 'medical-safety-signals-v2-journal';
const STATE_KEY = 'medical-safety-signals-v2-state';
const PENDING_KEY = 'medical-safety-signals-v2-pending';
const LEGACY_KEY = 'medical-safety-signals-v1';
const JOURNAL_COMPACT_LIMIT = 200;

type JournalKind =
  | 'snapshot'
  | 'create'
  | 'add'
  | 'transition'
  | 'evidence'
  | 'mark'
  | 'version'
  | 'reopen'
  | 'task'
  | 'audit'
  | 'reset';

interface JournalEntry {
  id: string;
  /** 单调递增序号：毫秒级时间戳可能相同，重放严格按 seq 保证顺序 */
  seq: number;
  ts: string;
  kind: JournalKind;
  signalId?: string;
  payload?: unknown;
  /** snapshot 事件标记：baseline（初始化基线）还是 compact（日志压缩） */
  snapshotKind?: 'baseline' | 'compact';
}

export interface EvidenceDraft {
  evidenceType: SignalCase['evidence'][number]['type'];
  title: string;
  source: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  actor: string;
  contradictsVersionIds: string[];
}

export interface PendingCheck {
  /** 未完成核对（证据登记表单）的草稿，提交前先落盘，成功后清除 */
  draftId: string;
  signalId: string;
  savedAt: string;
  form: EvidenceDraft;
}

function now() {
  return new Date().toISOString();
}

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function migrateItems(items: SignalCase[]): SignalCase[] {
  return items.map((item) => ((item.schemaVersion ?? 1) < CURRENT_SCHEMA_VERSION ? migrateSignal(item) : item));
}

// ---------------------------------------------------------------------------
// journal 重放
// ---------------------------------------------------------------------------

function reduceEntry(items: SignalCase[], entry: JournalEntry): SignalCase[] {
  switch (entry.kind) {
    case 'snapshot':
      return migrateItems(structuredClone((entry.payload as SignalCase[]) ?? []));
    case 'reset':
      return migrateItems(cloneSeed());
    case 'create':
    case 'add':
      return [migrateSignal(structuredClone(entry.payload as SignalCase)), ...items];
    default:
      return items.map((signal) => {
        if (signal.id !== entry.signalId) return signal;
        const updated = structuredClone(signal);
        const p = entry.payload as Record<string, unknown>;
        switch (entry.kind) {
          case 'transition':
            return applyTransition(
              updated,
              p.nextStatus as SignalStatus,
              p.reason as string,
              p.actor as string,
              p.at as string
            );
          case 'evidence':
            return applyEvidenceRegistered(
              updated,
              {
                id: p.id as string,
                type: p.type as SignalCase['evidence'][number]['type'],
                title: p.title as string,
                source: p.source as string,
                strength: p.strength as EvidenceStrength,
                batch: p.batch as string,
                note: p.note as string,
                actor: p.actor as string,
                referencedVersionIds: p.referencedVersionIds as string[] | undefined
              },
              p.at as string
            );
          case 'mark':
            return applyEvidenceStrengthChanged(
              updated,
              p.evidenceId as string,
              p.strength as EvidenceStrength,
              p.reason as string,
              p.actor as string,
              p.at as string
            );
          case 'version':
            return applyVersionCreated(updated, p.version as CaseVersion, p.actor as string, p.at as string);
          case 'reopen':
            return applyReopen(updated, p.actor as string, p.reason as string, p.at as string);
          case 'task':
            return applyTaskReplaced(updated, p.task as InvestigationTask, p.at as string);
          case 'audit':
            return applyAuditAppended(updated, p.entry as AuditEntry);
          default:
            return updated;
        }
      });
  }
}

function replay(journal: JournalEntry[]): SignalCase[] {
  let items: SignalCase[] = [];
  for (const entry of [...journal].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))) {
    items = reduceEntry(items, entry);
  }
  return items;
}

function nextSeq(journal: JournalEntry[]): number {
  return journal.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0) + 1;
}

/**
 * 合并两个窗口的 journal：
 *  - baseline 快照（初始化基线，可能来自 v1 迁移）全窗口只保留一条，取较早的一条，
 *    这样两个窗口各自后续的操作都能在同一基线上重放；
 *  - compact 快照取最新一条（它本身已包含更早的全部历史）；
 *  - 普通事件按事件 ID 并集（UUID 保证两个窗口同时保存的证据互不覆盖）；
 *  - 合并后重新编号 seq：跨窗口事件按时间戳、再按全局唯一事件 ID 确定全局顺序。
 */
export function mergeJournals(local: JournalEntry[], foreign: JournalEntry[]): JournalEntry[] {
  const isSnapshot = (entry: JournalEntry) => entry.kind === 'snapshot';
  const baselines = [...local, ...foreign]
    .filter((entry) => isSnapshot(entry) && entry.snapshotKind === 'baseline')
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
    .slice(0, 1)
    .map((entry) => ({ ...entry, seq: 0 }));
  const compacts = [...local, ...foreign]
    .filter((entry) => isSnapshot(entry) && entry.snapshotKind !== 'baseline')
    .sort((a, b) => b.ts.localeCompare(a.ts) || a.id.localeCompare(b.id))
    .slice(0, 1);
  const regularById = new Map<string, JournalEntry>();
  for (const entry of [...local, ...foreign]) {
    if (isSnapshot(entry)) continue;
    if (!regularById.has(entry.id)) regularById.set(entry.id, entry);
  }
  const regular = [...regularById.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));

  // compact 快照如果覆盖了部分普通事件，仅保留快照之后（更新）的事件；
  // 简化策略：存在 compact 快照时，普通事件只保留 seq 大于快照原 seq 的。
  let ordered: JournalEntry[];
  if (compacts.length === 1) {
    const compact = compacts[0];
    const after = regular.filter((entry) => (entry.seq ?? 0) > (compact.seq ?? 0));
    ordered = [...baselines, { ...compact }, ...after.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))];
  } else {
    ordered = [...baselines, ...regular];
  }
  return ordered.map((entry, index) => ({ ...entry, seq: index }));
}

function readJournal(): JournalEntry[] {
  if (!browser) return [];
  return safeParse<JournalEntry[]>(localStorage.getItem(JOURNAL_KEY), []);
}

function writeJournal(journal: JournalEntry[]) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
}

function writeState(items: SignalCase[]) {
  localStorage.setItem(STATE_KEY, JSON.stringify(items));
}

function initialJournal(): JournalEntry[] {
  if (!browser) return [];

  const existing = readJournal();
  if (existing.length > 0) return existing;

  // 一次性迁移旧版本数据：原结论与原证据整体保留为快照，再经迁移补齐关联
  const legacy = safeParse<SignalCase[] | null>(localStorage.getItem(LEGACY_KEY), null);
  const baseline = Array.isArray(legacy) && legacy.length > 0 ? migrateItems(legacy) : migrateItems(cloneSeed());

  const journal: JournalEntry[] = [
    {
      id: makeId('EVT'),
      seq: 0,
      ts: now(),
      kind: 'snapshot',
      payload: baseline,
      snapshotKind: 'baseline'
    }
  ];
  writeJournal(journal);
  writeState(baseline);
  return journal;
}

function compactIfNeeded(journal: JournalEntry[]): JournalEntry[] {
  if (journal.length <= JOURNAL_COMPACT_LIMIT) return journal;
  // 仅在能从完整日志重放出状态后才压缩；数据全部进入 snapshot，不丢任何已确认内容
  const snapshot = replay(journal);
  const compacted: JournalEntry[] = [
    {
      id: makeId('EVT'),
      seq: nextSeq(journal),
      ts: now(),
      kind: 'snapshot',
      payload: snapshot,
      snapshotKind: 'compact'
    }
  ];
  writeJournal(compacted);
  writeState(snapshot);
  return compacted;
}

// ---------------------------------------------------------------------------
// stores
// ---------------------------------------------------------------------------

const initialItems = browser ? replay(compactIfNeeded(initialJournal())) : migrateItems(cloneSeed());
const internal = writable<SignalCase[]>(initialItems);

function readPending(): PendingCheck[] {
  if (!browser) return [];
  return safeParse<PendingCheck[]>(localStorage.getItem(PENDING_KEY), []);
}

const pendingStore = writable<PendingCheck[]>(readPending());

if (browser) {
  pendingStore.subscribe((pending) => {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  });

  // 跨窗口合并：两个窗口基线快照 ID 各自随机，需要按 snapshotKind 归一，
  // 其余事件按事件 ID 并集；重放后两个窗口写入的证据都会保留。
  const mergeFromForeignJournal = () => {
    const foreign = readJournal();
    if (foreign.length === 0) return;
    const local = readJournal();

    const merged = mergeJournals(local, foreign);
    if (merged.length === local.length) return;
    const compacted = compactIfNeeded(merged);
    writeJournal(compacted);
    const items = replay(compacted);
    writeState(items);
    internal.set(items);
  };

  window.addEventListener('storage', (event) => {
    if (event.key === JOURNAL_KEY || event.key === null) mergeFromForeignJournal();
    if (event.key === PENDING_KEY || event.key === null) {
      pendingStore.set(readPending());
    }
  });
  window.addEventListener('focus', mergeFromForeignJournal);
}

/**
 * 原子提交：journal 落盘成功后才更新内存与快照。
 * 任一步骤抛错都会向上传播，调用方保留未完成核对草稿，重开可恢复。
 */
function dispatch(kind: JournalKind, payload: unknown, signalId?: string): void {
  if (!browser) throw new Error('当前环境不支持本地写入');
  const journal = readJournal();
  const entry: JournalEntry = { id: makeId('EVT'), seq: nextSeq(journal), ts: now(), kind, signalId, payload };
  journal.push(entry);
  writeJournal(journal); // write-ahead：先落日志
  const items = replay(journal);
  writeState(items); // 快照写入失败也不影响：重开重放 journal 即可
  internal.set(items);
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

export const signalStore = {
  subscribe: internal.subscribe,

  add(signal: SignalCase) {
    dispatch('add', signal);
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
    dispatch('create', signal);
    return signal;
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    dispatch('transition', { id, nextStatus, reason, actor, at: now() }, id);
  },

  /** 登记证据；若为相反证据，结论失效与批次统计在同一原子事件内一起生效 */
  addEvidence(
    id: string,
    evidence: {
      id: string;
      type: SignalCase['evidence'][number]['type'];
      title: string;
      source: string;
      strength: EvidenceStrength;
      batch: string;
      note: string;
      actor: string;
      referencedVersionIds?: string[];
    }
  ) {
    dispatch(
      'evidence',
      {
        id: evidence.id,
        type: evidence.type,
        title: evidence.title,
        source: evidence.source,
        strength: evidence.strength,
        batch: evidence.batch,
        note: evidence.note,
        actor: evidence.actor,
        referencedVersionIds: evidence.referencedVersionIds,
        at: now()
      },
      id
    );
  },

  /** 已有证据强度标记变化：原证据保留，引用它的结论版本失效待复核 */
  markEvidence(
    id: string,
    evidenceId: string,
    strength: EvidenceStrength,
    reason: string,
    actor: string
  ) {
    dispatch('mark', { evidenceId, strength, reason, actor, at: now() }, id);
  },

  addVersion(id: string, version: CaseVersion, actor: string) {
    dispatch('version', { version, actor, at: now() }, id);
  },

  reopen(id: string, actor: string, reason: string) {
    dispatch('reopen', { id, actor, reason, at: now() }, id);
  },

  replaceTask(id: string, task: InvestigationTask) {
    dispatch('task', { task, at: now() }, id);
  },

  addAudit(id: string, entry: AuditEntry) {
    dispatch('audit', { entry }, id);
  },

  reset() {
    dispatch('reset', {});
  },

  getSnapshot() {
    return get(internal);
  }
};

// ---------------------------------------------------------------------------
// 未完成核对（证据草稿）：写入失败后重开可恢复
// ---------------------------------------------------------------------------

export const pendingChecks = {
  subscribe: pendingStore.subscribe,

  save(signalId: string, form: EvidenceDraft): PendingCheck {
    const check: PendingCheck = {
      draftId: makeId('DRAFT'),
      signalId,
      savedAt: now(),
      form
    };
    pendingStore.update((items) => [check, ...items.filter((item) => item.signalId !== signalId)]);
    return check;
  },

  clear(signalId: string, draftId?: string) {
    pendingStore.update((items) =>
      items.filter((item) =>
        draftId ? !(item.signalId === signalId && item.draftId === draftId) : item.signalId !== signalId
      )
    );
  },

  forSignal(signalId: string): PendingCheck[] {
    return get(pendingStore).filter((item) => item.signalId === signalId);
  }
};

export function emptyEvidenceDraft(signal: SignalCase): EvidenceDraft {
  return {
    evidenceType: 'complaint',
    title: '',
    source: '',
    strength: 'strong',
    batch: signal.batch,
    note: '',
    actor: signal.owner,
    contradictsVersionIds: []
  };
}

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
    reopenedCount: 0,
    schemaVersion: CURRENT_SCHEMA_VERSION
  };
}
