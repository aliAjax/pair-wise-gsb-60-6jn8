import { browser } from '$app/environment';
import type { SignalCase } from '$lib/models/signal';

export const STATE_STORAGE_KEY = 'medical-safety-signals-v1';
const DRAFT_STORAGE_KEY = 'medical-safety-drafts-v1';
const PENDING_PREFIX = 'medical-safety-pending-v1-';

export interface PendingOp {
  id: string;
  type: 'evidence' | 'evidence-strength' | 'version' | 'transition' | 'reopen' | 'task';
  signalId: string;
  recordId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface FormDraft {
  key: string;
  signalId: string;
  form: 'evidence' | 'version';
  data: Record<string, string>;
  savedAt: string;
}

function tabSessionId(): string {
  if (!browser) return 'server';
  let id = sessionStorage.getItem('medical-safety-tab-id');
  if (!id) {
    id = `tab-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    sessionStorage.setItem('medical-safety-tab-id', id);
  }
  return id;
}

function readJSON<T>(key: string, fallback: T): T {
  if (!browser) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): boolean {
  if (!browser) return true;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ---- 待恢复操作（write-ahead）----
function pendingStorageKey(): string {
  return `${PENDING_PREFIX}${tabSessionId()}`;
}

export function loadPendingOps(): PendingOp[] {
  return readJSON<PendingOp[]>(pendingStorageKey(), []);
}

export function savePendingOps(ops: PendingOp[]): boolean {
  return writeJSON(pendingStorageKey(), ops);
}

export function addPendingOp(op: PendingOp): boolean {
  const ops = loadPendingOps();
  if (ops.some((existing) => existing.id === op.id)) return true;
  return savePendingOps([...ops, op]);
}

export function removePendingOp(id: string): boolean {
  return savePendingOps(loadPendingOps().filter((op) => op.id !== id));
}

export function listAllPendingOps(): PendingOp[] {
  if (!browser) return [];
  const ops: PendingOp[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PENDING_PREFIX)) {
      ops.push(...readJSON<PendingOp[]>(key, []));
    }
  }
  return ops.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function clearAllPendingOps(): void {
  if (!browser) return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PENDING_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
}

// ---- 表单草稿（未完成核对恢复）----
export function loadDrafts(): Record<string, FormDraft> {
  return readJSON<Record<string, FormDraft>>(DRAFT_STORAGE_KEY, {});
}

export function saveDraft(draft: FormDraft): boolean {
  const drafts = loadDrafts();
  drafts[draft.key] = draft;
  return writeJSON(DRAFT_STORAGE_KEY, drafts);
}

export function clearDraft(key: string): boolean {
  const drafts = loadDrafts();
  if (!(key in drafts)) return true;
  delete drafts[key];
  return writeJSON(DRAFT_STORAGE_KEY, drafts);
}

// ---- 跨标签页状态合并（两份记录都保留）----
function mergeById<T extends { id: string }>(
  local: T[],
  remote: T[],
  timestamp: (item: T) => string
): T[] {
  const map = new Map<string, T>();
  for (const item of local) map.set(item.id, item);
  for (const item of remote) {
    const existing = map.get(item.id);
    map.set(item.id, existing && timestamp(existing) >= timestamp(item) ? existing : item);
  }
  return Array.from(map.values());
}

function mergeTasks(local: SignalCase['tasks'], remote: SignalCase['tasks']): SignalCase['tasks'] {
  const map = new Map<string, SignalCase['tasks'][number]>();
  for (const task of remote) map.set(task.id, task);
  for (const task of local) map.set(task.id, task);
  return Array.from(map.values());
}

export function mergeSignal(local: SignalCase, remote: SignalCase): SignalCase {
  const base = local.updatedAt >= remote.updatedAt ? local : remote;
  return {
    ...base,
    evidence: mergeById(local.evidence, remote.evidence, (item) => item.strengthChangedAt ?? item.createdAt),
    versions: mergeById(local.versions, remote.versions, (item) => item.invalidatedAt ?? item.createdAt),
    audit: mergeById(local.audit, remote.audit, (item) => item.createdAt),
    tasks: mergeTasks(local.tasks, remote.tasks)
  };
}

export function mergeStates(local: SignalCase[], remote: SignalCase[]): SignalCase[] {
  const remoteById = new Map(remote.map((signal) => [signal.id, signal]));
  const localById = new Map(local.map((signal) => [signal.id, signal]));
  const merged: SignalCase[] = [];
  for (const signal of local) {
    const counterpart = remoteById.get(signal.id);
    merged.push(counterpart ? mergeSignal(signal, counterpart) : signal);
  }
  for (const signal of remote) {
    if (!localById.has(signal.id)) merged.push(signal);
  }
  return merged;
}
