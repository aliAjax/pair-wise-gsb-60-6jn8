/**
 * Store/journal 验证：node scripts/verify-store.mjs
 * 用 localStorage 内存垫片模拟浏览器；通过「第二个 store 实例」模拟两个窗口。
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'signal-store-'));

async function loadStore(browserFlag, storage) {
  const stub = join(tmp, `env-${browserFlag}-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    stub,
    `export const browser = ${browserFlag}; export const dev = false; export const building = false; export const version = 'test';`
  );
  const entry = join(tmp, `entry-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    entry,
    `
    export * from ${JSON.stringify('/workspace/src/lib/stores/signal-store.ts')};
    export const __storage = globalThis.__ls;
    `
  );
  globalThis.__ls = storage;
  globalThis.localStorage = storage;
  if (!globalThis.window) {
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {}
    };
  }  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    alias: {
      '$app/environment': stub
    }
  });
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(out, result.outputFiles[0].text);
  return import(pathToFileURL(out).href);
}

class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
  dump() {
    return Object.fromEntries(this.map);
  }
}

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function evidencePayload(id, overrides = {}) {
  return {
    id,
    type: 'field_report',
    title: `证据 ${id}`,
    source: '医院',
    strength: 'strong',
    batch: 'B-1',
    note: '核查说明内容',
    actor: '测试员',
    ...overrides
  };
}

// --- 场景 A：首次加载从 v1 数据迁移，已确认结论和原证据不丢 ---
console.log('\n场景 A：v1 旧数据（无 schemaVersion/关联）首次加载迁移');
{
  const v1 = [
    {
      id: 'SIG-OLD-1',
      title: '旧信号',
      product: '旧产品',
      batch: 'OLD-1',
      sourceType: 'complaint',
      status: 'closed',
      riskLevel: 'low',
      severity: 2,
      reportCount: 1,
      exposedUnits: 1,
      occurrenceRate: 0,
      occurredAt: '2026-01-01',
      openedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      owner: '张三',
      description: '旧描述',
      affectedBatches: ['OLD-1'],
      evidence: [
        {
          id: 'E-OLD',
          type: 'test',
          title: '旧支持证据',
          source: '实验室',
          strength: 'strong',
          batch: 'OLD-1',
          note: '旧证据说明',
          createdAt: '2026-01-02T00:00:00.000Z'
        }
      ],
      tasks: [{ id: 'T-OLD', title: '旧任务', owner: '张三', dueAt: '2026-02-01', status: 'done' }],
      versions: [
        {
          id: 'V-OLD',
          version: 1,
          author: '张三',
          summary: '旧结论：修复有效关闭',
          disposition: 'corrective_action',
          rationale: '旧依据',
          createdAt: '2026-02-01T00:00:00.000Z'
        }
      ],
      audit: [{ id: 'A-OLD', actor: '张三', action: '关闭信号', detail: '原始审计', createdAt: '2026-02-01T00:00:00.000Z' }],
      reopenedCount: 0
    }
  ];
  const storage = new MemoryStorage({ 'medical-safety-signals-v1': JSON.stringify(v1) });
  const mod = await loadStore(true, storage);
  const sig = mod.signalStore.getSnapshot()[0];

  check('旧信号仍在', sig.id === 'SIG-OLD-1');
  check('原结论保留且仍有效（无相反证据）', sig.versions[0].id === 'V-OLD' && sig.versions[0].state === 'active');
  check('原证据保留', sig.evidence[0].id === 'E-OLD');
  check('结论补齐证据关联', sig.versions[0].evidenceIds?.includes('E-OLD'));
  check('证据补录强度历史', sig.evidence[0].strengthHistory?.length === 1);
  check('原审计保留且只追加', sig.audit.at(-1).id === 'A-OLD');
  check('schemaVersion=2', sig.schemaVersion === 2);
  check('journal 与 state 均已落盘', !!storage.getItem('medical-safety-signals-v2-journal') && !!storage.getItem('medical-safety-signals-v2-state'));

  // --- 场景 B：重开（新建 store 实例读同一 storage），状态一致（重放恢复） ---
  console.log('\n场景 B：重开后从 journal 重放恢复');
  const reopen = await loadStore(true, storage);
  const sig2 = reopen.signalStore.getSnapshot()[0];
  check('重开后信号一致', sig2.id === 'SIG-OLD-1' && sig2.versions.length === 1);
  check('重开后 schemaVersion 保持 2（迁移不重复）', sig2.schemaVersion === 2 && sig2.audit.length === sig.audit.length);
}

// --- 场景 C：原子操作 —— 证据登记、结论失效、批次统计一起生效 ---
console.log('\n场景 C：相反证据原子生效');
{
  const storage = new MemoryStorage();
  const mod = await loadStore(true, storage);
  const closed = mod.signalStore.getSnapshot().find((s) => s.status === 'closed');
  check('种子中存在已关闭信号', !!closed, JSON.stringify(mod.signalStore.getSnapshot().map((s) => s.status)));

  // SIG-2026-011 关闭且有结论。先给它登记一条相反证据，显式指向当前版本
  const targetId = 'SIG-2026-011';
  const versionId = mod.signalStore.getSnapshot().find((s) => s.id === targetId).versions[0].id;
  mod.signalStore.addEvidence(targetId, evidencePayload('E-CONTRARY-1', {
    strength: 'contrary',
    title: '复现报告',
    referencedVersionIds: [versionId]
  }));

  const after = mod.signalStore.getSnapshot().find((s) => s.id === targetId);
  check('证据已登记', after.evidence.some((e) => e.id === 'E-CONTRARY-1'));
  check('结论版本失效', after.versions[0].state === 'invalidated_pending_review');
  check('状态变为 review（批次不再按已处置）', after.status === 'review');
  check('已关闭任务暂停', after.tasks.some((t) => t.status === 'paused'));

  // journal 中是同一个 evidence 事件（联动不是分步写入，不会出现只登记证据未失效的中间态）
  const journal = JSON.parse(storage.getItem('medical-safety-signals-v2-journal'));
  const evidEvents = journal.filter((e) => e.kind === 'evidence');
  check('journal 只有一条 evidence 事件承载整个原子操作', evidEvents.length === 1);

  // 重放必须得到同样结果
  const reopen = await loadStore(true, storage);
  const replayed = reopen.signalStore.getSnapshot().find((s) => s.id === targetId);
  check('重放后结论仍失效', replayed.versions[0].state === 'invalidated_pending_review');
  check('重放后状态仍 review', replayed.status === 'review');
  check('重放后任务仍暂停', replayed.tasks.some((t) => t.status === 'paused'));
}

// --- 场景 D：两个窗口同时保存证据，两份记录都留下 ---
console.log('\n场景 D：两个窗口并发保存（事件 ID 唯一 + 并集合并去重）');
{
  const storage = new MemoryStorage();
  // 窗口 1 初始化后单独保存它的持久层
  const window1 = await loadStore(true, storage);
  const window1Dump = JSON.parse(JSON.stringify(storage.dump()));
  const targetId = 'SIG-2026-015';
  window1.signalStore.addEvidence(targetId, evidencePayload('E-WIN-A', { title: '窗口 A 的证据' }));
  const afterA = JSON.parse(JSON.stringify(storage.dump()));

  // 窗口 2 在窗口 1 写入前的基线上打开（独立标签页的真实情形）
  const storage2 = new MemoryStorage(window1Dump);
  const window2 = await loadStore(true, storage2);
  window2.signalStore.addEvidence(targetId, evidencePayload('E-WIN-B', { title: '窗口 B 的证据' }));
  const afterB = JSON.parse(JSON.stringify(storage2.dump()));

  // 两边各自只有自己的证据事件
  const jA = JSON.parse(afterA['medical-safety-signals-v2-journal']);
  const jB = JSON.parse(afterB['medical-safety-signals-v2-journal']);
  check('窗口 1 仅有 A 事件', jA.some((e) => e.payload?.id === 'E-WIN-A') && !jA.some((e) => e.payload?.id === 'E-WIN-B'));
  check('窗口 2 仅有 B 事件', jB.some((e) => e.payload?.id === 'E-WIN-B') && !jB.some((e) => e.payload?.id === 'E-WIN-A'));

  // storage 事件到达窗口 1：走真实的 mergeJournals 合并（基线快照归一 + 事件 ID 并集）
  const mergedJournal = window1.mergeJournals(jA, jB);
  check('合并后基线快照只有一条', mergedJournal.filter((e) => e.snapshotKind === 'baseline').length === 1);
  check('合并后日志同时含 A 与 B', mergedJournal.some((e) => e.payload?.id === 'E-WIN-A') && mergedJournal.some((e) => e.payload?.id === 'E-WIN-B'));

  // 用合并后的日志重放（等价窗口 1 合并后的内部状态）
  const mergedStorage = new MemoryStorage({ 'medical-safety-signals-v2-journal': JSON.stringify(mergedJournal) });
  const merged = await loadStore(true, mergedStorage);
  const sig = merged.signalStore.getSnapshot().find((s) => s.id === targetId);
  check('合并重放后两份证据记录都保留', sig.evidence.some((e) => e.id === 'E-WIN-A') && sig.evidence.some((e) => e.id === 'E-WIN-B'));
  check('合并重放后其他种子信号完整', merged.signalStore.getSnapshot().length === 4);

  // 再来一轮 storage 事件（同一份 jB 重复到达）：幂等，不产生重复证据
  const mergedTwice = window1.mergeJournals(mergedJournal, jB);
  const mergedTwiceStorage = new MemoryStorage({ 'medical-safety-signals-v2-journal': JSON.stringify(mergedTwice) });
  const mergedAgain = await loadStore(true, mergedTwiceStorage);
  const sigAgain = mergedAgain.signalStore.getSnapshot().find((s) => s.id === targetId);
  check('同一 foreign journal 重复到达幂等，不产生重复证据',
    sigAgain.evidence.filter((e) => e.id === 'E-WIN-A').length === 1 &&
    sigAgain.evidence.filter((e) => e.id === 'E-WIN-B').length === 1);
}

// --- 场景 E：草稿（未完成核对）保存与重开恢复，写入失败不丢 ---
console.log('\n场景 E：未完成核对草稿恢复');
{
  const storage = new MemoryStorage();
  const mod = await loadStore(true, storage);
  const targetId = 'SIG-2026-015';
  const draft = mod.pendingChecks.save(targetId, {
    evidenceType: 'test',
    title: '写到一半的证据',
    source: '实验室',
    strength: 'contrary',
    batch: 'B-X',
    note: '尚未提交的核查说明',
    actor: '测试员',
    contradictsVersionIds: []
  });
  check('草稿已持久化', !!storage.getItem('medical-safety-signals-v2-pending'));

  const reopen = await loadStore(true, storage);
  const found = reopen.pendingChecks.forSignal(targetId);
  check('重开后草稿可恢复', found.length === 1 && found[0].form.title === '写到一半的证据');
  check('草稿 ID 稳定', found[0].draftId === draft.draftId);

  // 同一信号再保存草稿会替换旧草稿（一个信号保留一份未完成核对）
  reopen.pendingChecks.save(targetId, { ...found[0].form, title: '第二版草稿' });
  check('同信号草稿只保留最新一份', reopen.pendingChecks.forSignal(targetId).length === 1);
  check('最新草稿内容正确', reopen.pendingChecks.forSignal(targetId)[0].form.title === '第二版草稿');

  reopen.pendingChecks.clear(targetId);
  check('清除成功', reopen.pendingChecks.forSignal(targetId).length === 0);
}

// --- 场景 F：写入快照失败（但 journal 已先落盘），重开仍能恢复 ---
console.log('\n场景 F：write-ahead：快照写入失败后重开恢复');
{
  const storage = new MemoryStorage();
  const mod = await loadStore(true, storage);
  const targetId = 'SIG-2026-015';

  // 让 state 写入抛错（journal 的 setItem 仍成功），dispatch 应抛错但日志已落盘
  const origSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === 'medical-safety-signals-v2-state') throw new Error('QuotaExceeded (simulated)');
    origSet(key, value);
  };
  let threw = false;
  try {
    mod.signalStore.addEvidence(targetId, evidencePayload('E-PENDING-SAVE', { title: '快照失败但日志成功' }));
  } catch (err) {
    threw = true;
  }
  check('快照写入失败时调用方能感知错误', threw);
  check('journal 事件已先落盘', storage.getItem('medical-safety-signals-v2-journal').includes('E-PENDING-SAVE'));

  storage.setItem = origSet;
  const reopen = await loadStore(true, storage);
  const sig = reopen.signalStore.getSnapshot().find((s) => s.id === targetId);
  check('重开重放 journal 后证据未丢', sig.evidence.some((e) => e.id === 'E-PENDING-SAVE'));
}

// --- 场景 G：非浏览器（SSR）不写本地 ---
console.log('\n场景 G：SSR 安全');
{
  const storage = new MemoryStorage();
  const mod = await loadStore(false, storage);
  check('SSR 返回种子数据', mod.signalStore.getSnapshot().length >= 4);
  let threw = false;
  try {
    mod.signalStore.transition('SIG-2026-011', 'review', 'SSR 不应写入', '测试员');
  } catch {
    threw = true;
  }
  check('SSR 下写操作抛错且不落盘', threw && !storage.getItem('medical-safety-signals-v2-journal'));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
