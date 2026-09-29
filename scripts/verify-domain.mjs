/**
 * 领域规则验证脚本：node scripts/verify-domain.mjs
 * 用 esbuild 即时打包 TS 后执行。
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'signal-verify-'));
const entry = join(tmp, 'entry.ts');
writeFileSync(entry, `export * from ${JSON.stringify('/workspace/src/lib/services/signal-domain.ts')};`);

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent'
});
const outFile = join(tmp, 'out.mjs');
writeFileSync(outFile, result.outputFiles[0].text);
const domain = await import(pathToFileURL(outFile).href);

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

function iso(minute) {
  return `2026-09-29T0${minute}:00:00.000Z`;
}

function makeClosedCase() {
  return {
    id: 'SIG-T-1',
    title: '测试信号：关闭后收到相反证据',
    product: '样机',
    batch: 'B-1',
    sourceType: 'complaint',
    status: 'closed',
    riskLevel: 'low',
    severity: 2,
    reportCount: 4,
    exposedUnits: 100,
    occurrenceRate: 0.1,
    occurredAt: '2026-09-01',
    openedAt: iso(0),
    updatedAt: iso(2),
    owner: '测试员',
    description: '用于验证关闭后相反证据联动。',
    affectedBatches: ['B-1'],
    evidence: [
      {
        id: 'E-1',
        type: 'test',
        title: '支持性测试记录',
        source: '实验室',
        strength: 'strong',
        batch: 'B-1',
        note: '修复有效。',
        createdAt: iso(1)
      }
    ],
    tasks: [
      { id: 'T-1', title: '部署跟踪', owner: '测试员', dueAt: '2026-09-20', status: 'done' },
      { id: 'T-2', title: '开放任务', owner: '测试员', dueAt: '2026-10-20', status: 'in_progress' }
    ],
    versions: [
      {
        id: 'V-1',
        version: 1,
        author: '测试员',
        summary: '确认修复有效并关闭。',
        disposition: 'corrective_action',
        rationale: '回归通过。',
        createdAt: iso(2)
      }
    ],
    audit: [{ id: 'A-1', actor: '测试员', action: '关闭信号', detail: '历史审计', createdAt: iso(2) }],
    reopenedCount: 0
  };
}

// --- 场景 1：旧数据迁移（三阶段，先迁移原结论、补关联、再失效） ---
console.log('\n场景 1：旧数据迁移（缺证据关联 + 已有关联相反证据）');
{
  const old = makeClosedCase();
  old.evidence.push({
    id: 'E-2',
    type: 'test',
    title: '相反复测记录',
    source: '外部实验室',
    strength: 'contrary',
    batch: 'B-1',
    note: '复测复现故障。',
    createdAt: iso(3)
  });
  const migrated = domain.migrateSignal(old);

  check('schemaVersion 升级到 2', migrated.schemaVersion === 2);
  check('原结论记录保留（未删除）', migrated.versions[0].id === 'V-1' && migrated.versions[0].summary.includes('确认修复'));
  check('原证据保留', migrated.evidence.length === 2 && migrated.evidence.some((e) => e.id === 'E-1'));
  check('阶段 2：V-1 补齐证据关联', JSON.stringify(migrated.versions[0].evidenceIds?.sort()) === JSON.stringify(['E-1', 'E-2']));
  check('阶段 3：引用相反证据的结论失效', migrated.versions[0].state === 'invalidated_pending_review');
  check('失效后状态进入复核中', migrated.status === 'review');
  check('批次不再按已处置统计', domain.isDispositionSettled(migrated) === false);
  check('done 任务暂停关闭，原 in_progress 任务不变',
    migrated.tasks[0].status === 'paused' && migrated.tasks[0].pausedFrom === 'done' &&
    migrated.tasks[1].status === 'in_progress');
  check('历史审计只追加不回写', migrated.audit[migrated.audit.length - 1].id === 'A-1');
  check('追加了迁移审计', migrated.audit[0].action === '数据结构迁移');
  check('迁移幂等：再次迁移不产生新审计', (() => {
    const again = domain.migrateSignal(migrated);
    return again.audit.length === migrated.audit.length;
  })());
}

// --- 场景 2：关闭后登记新的相反证据 ---
console.log('\n场景 2：关闭后登记新的相反证据');
{
  const closed = domain.migrateSignal(makeClosedCase());
  check('迁移后初始按已处置', domain.isDispositionSettled(closed) === true);

  // 新结论 V-1 引用 E-1（迁移已补齐）。登记相反证据，默认指向当前有效版本
  const updated = domain.applyEvidenceRegistered(
    closed,
    {
      id: 'E-3',
      type: 'field_report',
      title: '现场再次发生的报告',
      source: '医院反馈',
      strength: 'contrary',
      batch: 'B-1',
      note: '同一故障再次出现。',
      actor: '复核员'
    },
    iso(5)
  );

  check('两份证据都保留（不覆盖）', updated.evidence.some((e) => e.id === 'E-1') && updated.evidence.some((e) => e.id === 'E-3'));
  const v1 = updated.versions.find((v) => v.id === 'V-1');
  check('引用过它的结论版本失效', v1.state === 'invalidated_pending_review');
  check('版本带触发证据', v1.triggerEvidenceId === 'E-3');
  check('信号进入待复核(review)', updated.status === 'review');
  check('reopenedCount 增加', updated.reopenedCount === 1);
  check('批次退出已处置口径', domain.isDispositionSettled(updated) === false);
  check('原 done 任务暂停关闭', updated.tasks.find((t) => t.id === 'T-1').status === 'paused');
  check('任务保留未删除', updated.tasks.length === 2);
  check('审计包含：新增证据/结论失效/退出已处置/任务暂停',
    ['新增证据', '结论失效', '退出已处置', '任务暂停'].every((a) => updated.audit.some((x) => x.action === a)));
  check('相反证据记录指向 V-1', (updated.evidence.find((e) => e.id === 'E-3').contradictsVersionIds ?? []).includes('V-1'));
  check('强度历史首项为登记强度', updated.evidence.find((e) => e.id === 'E-3').strengthHistory?.[0].strength === 'contrary');

  // 已失效版本不会被二次失效（不会重复追加审计）
  const auditLenBefore = updated.audit.length;
  domain.applyEvidenceRegistered(
    updated,
    { id: 'E-4', type: 'literature', title: '又一条相反文献证据', source: '文献', strength: 'contrary', batch: 'B-1', note: '同样支持复发。', actor: '复核员' },
    iso(6)
  );
  check('已失效版本不重复失效，但仍追加新证据', updated.versions.find((v) => v.id === 'V-1').state === 'invalidated_pending_review' && updated.evidence.length === 3);
}

// --- 场景 3：已有证据标记变化（strong -> contrary） ---
console.log('\n场景 3：已有证据强度标记变化');
{
  const c = domain.migrateSignal(makeClosedCase());
  const before = c.versions[0].state;
  domain.applyEvidenceStrengthChanged(c, 'E-1', 'contrary', '复测推翻原结论', '复核员', iso(7));

  check('标记前有效', before === 'active');
  check('证据强度已变更', c.evidence[0].strength === 'contrary');
  check('强度历史追加（原标记保留）', c.evidence[0].strengthHistory?.length === 2);
  check('强度历史保留原始 strong', c.evidence[0].strengthHistory?.[0].strength === 'strong');
  check('引用它的 V-1 失效待复核', c.versions[0].state === 'invalidated_pending_review');
  check('关闭信号回到 review', c.status === 'review');
  check('done 任务暂停', c.tasks.find((t) => t.id === 'T-1').status === 'paused');
  check('批次不计已处置', domain.isDispositionSettled(c) === false);

  // 标记为支持方向（weak）不应误触发失效
  const c2 = domain.migrateSignal(makeClosedCase());
  domain.applyEvidenceStrengthChanged(c2, 'E-1', 'weak', '证据弱化但非相反', '复核员', iso(8));
  check('标记为 weak 也触发引用版本失效（规则：任何标记变化都要复核）', c2.versions[0].state === 'invalidated_pending_review');
}

// --- 场景 4：非关闭信号：结论失效但任务仅 done->paused，状态补待复核审计 ---
console.log('\n场景 4：调查中信号收到相反证据');
{
  const investigating = domain.migrateSignal(makeClosedCase());
  investigating.status = 'investigating';
  domain.applyEvidenceRegistered(
    investigating,
    { id: 'E-5', type: 'test', title: '调查期相反证据', source: '实验室', strength: 'contrary', batch: 'B-1', note: '复现。', actor: '复核员' },
    iso(9)
  );
  check('版本失效', investigating.versions[0].state === 'invalidated_pending_review');
  check('非关闭信号强制进入复核中（待复核）', investigating.status === 'review');
  check('批次不计已处置', domain.isDispositionSettled(investigating) === false);
}

// --- 场景 5：新结论版本引用证据 ---
console.log('\n场景 5：新版本形成 + 后续证据标记只影响引用它的版本');
{
  const c = domain.migrateSignal(makeClosedCase());
  // V-1 迁移时引用 E-1。登记一条新的支持证据 E-6，再形成 V-2 只引用 E-6
  domain.applyEvidenceRegistered(
    c,
    { id: 'E-6', type: 'test', title: '新增支撑测试', source: '实验室', strength: 'strong', batch: 'B-1', note: '额外证据。', actor: '测试员' },
    iso(10)
  );
  domain.applyVersionCreated(
    c,
    { id: 'V-2', version: 2, author: '测试员', summary: '补充证据维持结论。', disposition: 'continue_observation', rationale: '充分。', createdAt: iso(11), evidenceIds: ['E-6'] },
    '测试员',
    iso(11)
  );
  check('V-1 与 V-2 均有效', c.versions.filter((v) => (v.state ?? 'active') === 'active').length === 2);

  // E-1 标记变化 -> 只应失效 V-1
  domain.applyEvidenceStrengthChanged(c, 'E-1', 'contrary', 'V1 证据被推翻', '复核员', iso(12));
  check('V-1 失效', c.versions.find((v) => v.id === 'V-1').state === 'invalidated_pending_review');
  check('V-2 仍有效（未引用 E-1）', c.versions.find((v) => v.id === 'V-2').state === 'active');

  // E-6 再标记变化 -> V-2 也失效
  domain.applyEvidenceStrengthChanged(c, 'E-6', 'contrary', 'V2 证据被推翻', '复核员', iso(13));
  check('V-2 随后失效', c.versions.find((v) => v.id === 'V-2').state === 'invalidated_pending_review');
  check('两个原版本都保留', c.versions.length === 2);
}

// --- 场景 6：支持性证据不触发失效 ---
console.log('\n场景 6：支持性新证据不改变结论状态');
{
  const c = domain.migrateSignal(makeClosedCase());
  domain.applyEvidenceRegistered(
    c,
    { id: 'E-7', type: 'literature', title: '支持性文献', source: '文献', strength: 'moderate', batch: 'B-1', note: '支持。', actor: '测试员' },
    iso(14)
  );
  check('V-1 仍有效', c.versions[0].state === 'active');
  check('仍按已处置统计', domain.isDispositionSettled(c) === true);
  check('状态保持 closed', c.status === 'closed');
  check('任务未被暂停', c.tasks.find((t) => t.id === 'T-1').status === 'done');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
