<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type {
    CaseVersion,
    EvidenceItem,
    EvidenceStrength,
    InvestigationTaskStatus,
    SignalStatus
  } from '$lib/models/signal';
  import { exportSignalReport } from '$lib/services/signal-service';
  import {
    emptyEvidenceDraft,
    pendingChecks,
    signalStore,
    type EvidenceDraft
  } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;
  $: activeVersions = (signal?.versions ?? []).filter((version) => (version.state ?? 'active') === 'active');

  const statusOptions: Array<{ value: SignalStatus; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' },
    { value: 'action_required', label: '进入风险处置' },
    { value: 'review', label: '提交复核' },
    { value: 'closed', label: '关闭信号' }
  ];

  const taskStatusLabels: Record<InvestigationTaskStatus, string> = {
    open: '待启动',
    in_progress: '进行中',
    done: '已完成',
    paused: '已暂停关闭（待复核）'
  };

  // 证据登记表单本地状态：写入失败/重开后可由未完成核对草稿恢复
  let evidenceForm: EvidenceDraft | null = null;
  let evidenceWriteError = '';
  let restoredDraftId: string | null = null;
  $: if (signal && !evidenceForm) evidenceForm = emptyEvidenceDraft(signal);

  // 结论版本表单引用的证据（默认勾选当前矩阵全部证据）
  let versionEvidenceIds: string[] = [];
  let versionInitKey = '';
  $: if (signal && versionInitKey !== signal.id) {
    versionInitKey = signal.id;
    versionEvidenceIds = signal.evidence.map((item) => item.id);
  }

  $: signalPending = $pendingChecks.filter((item) => item.signalId === data.id);

  function restoreDraft(draftId: string) {
    const pending = signalPending.find((item) => item.draftId === draftId);
    if (pending) {
      evidenceForm = structuredClone(pending.form);
      restoredDraftId = draftId;
      evidenceWriteError = '';
    }
  }

  function discardDraft(draftId: string) {
    pendingChecks.clear(data.id, draftId);
    if (restoredDraftId === draftId) restoredDraftId = null;
  }

  const transitionHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          transition?: { id: string; nextStatus: SignalStatus; reason: string; actor: string };
        };
        if (payload.transition) {
          signalStore.transition(
            payload.transition.id,
            payload.transition.nextStatus,
            payload.transition.reason,
            payload.transition.actor
          );
        }
      }
      await update({ reset: true });
    };
  };

  const evidenceHandler: SubmitFunction = () => {
    // write-ahead：提交前先把未完成核对落盘，服务端校验失败或本地写入失败都不丢
    const draft = evidenceForm ? structuredClone(evidenceForm) : null;
    const draftId = draft ? pendingChecks.save(data.id, draft).draftId : undefined;

    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as {
          evidence?: {
            id: string;
            type: EvidenceItem['type'];
            title: string;
            source: string;
            strength: EvidenceStrength;
            batch: string;
            note: string;
            referencedVersionIds?: string[];
            createdAt: string;
          };
          actor?: string;
        };
        if (payload.evidence && signal) {
          try {
            // 证据登记、结论失效、批次统计在同一个原子操作内一起生效
            signalStore.addEvidence(signal.id, {
              ...payload.evidence,
              actor: payload.actor ?? signal.owner
            });
            if (draftId) pendingChecks.clear(signal.id, draftId);
            evidenceForm = emptyEvidenceDraft(signal);
            restoredDraftId = null;
            evidenceWriteError = '';
          } catch {
            evidenceWriteError = '本地写入失败：证据核对内容已保留为未完成核对，关闭后重开本页可恢复继续提交。';
          }
        }
      }
      await update({ reset: false });
    };
  };

  const versionHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as { version?: CaseVersion; actor?: string };
        if (payload.version && signal) {
          signalStore.addVersion(
            signal.id,
            { ...payload.version, evidenceIds: versionEvidenceIds },
            payload.actor ?? signal.owner
          );
          versionEvidenceIds = $signalStore
            .find((item) => item.id === signal.id)
            ?.evidence.map((item) => item.id) ?? [];
        }
      }
      await update({ reset: true });
    };
  };
</script>

<svelte:head><title>{signal?.id ?? data.id} | 信号核查详情</title></svelte:head>

{#if !signal || !evidenceForm}
  <section class="rounded border border-error-300 bg-error-50 p-6 text-error-900">
    未找到信号 {data.id}。它可能已被本地数据重置。
  </section>
{:else}
  <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="flex flex-wrap items-center gap-3">
        <a class="text-sm text-primary-700-300 hover:underline" href="/signals">返回信号台账</a>
        <span class="text-surface-400">/</span>
        <span class="text-sm text-surface-500-400">{signal.id}</span>
      </div>
      <h1 class="mt-3 max-w-4xl text-2xl font-semibold">{signal.title}</h1>
      <div class="mt-3"><RiskBadge risk={signal.riskLevel} status={signal.status} /></div>
    </div>
    <button class="btn variant-soft-primary" type="button" on:click={() => exportSignalReport(signal.id)}>
      导出可追溯报告
    </button>
  </div>

  {#if form?.message}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">{form.message}</div>
  {/if}

  {#if evidenceWriteError}
    <div class="mb-5 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">{evidenceWriteError}</div>
  {/if}

  {#each signalPending as pending (pending.draftId)}
    <div class="mb-3 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-900">
      {#if restoredDraftId === pending.draftId}
        <span>已载入未完成核对「{pending.form.title || '未命名证据'}」，可继续编辑后提交。</span>
      {:else}
        <span>
          检测到未完成的证据核对（{pending.savedAt.slice(0, 16).replace('T', ' ')} 保存）：{pending.form.title || '未命名证据'}。
        </span>
      {/if}
      <span class="ml-2 inline-flex gap-2">
        <button class="btn btn-sm variant-soft-primary" type="button" on:click={() => restoreDraft(pending.draftId)}>
          恢复到表单
        </button>
        <button class="btn btn-sm variant-ghost-surface" type="button" on:click={() => discardDraft(pending.draftId)}>
          丢弃
        </button>
      </span>
    </div>
  {/each}

  <section class="workspace-grid mb-6">
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-8">
      <div class="grid gap-5 md:grid-cols-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">产品与批号</p>
          <p class="mt-1 font-medium">{signal.product}</p>
          <p class="mt-1 text-sm text-surface-600-300">{signal.affectedBatches.join(' / ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">调查负责人</p>
          <p class="mt-1 font-medium">{signal.owner}</p>
          <p class="mt-1 text-sm text-surface-600-300">最后更新 {signal.updatedAt.slice(0, 16).replace('T', ' ')}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">报告与暴露</p>
          <p class="metric-value mt-1 font-medium">{signal.reportCount} 条 / {signal.exposedUnits} 台</p>
        </div>
        <div>
          <p class="text-xs font-medium text-surface-500-400">核查发生率</p>
          <p class="metric-value mt-1 font-medium">{signal.occurrenceRate.toFixed(2)}%</p>
        </div>
      </div>
      <div class="section-rule mt-5 pt-5">
        <p class="text-sm leading-6 text-surface-700-300">{signal.description}</p>
      </div>
    </article>

    <aside class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 xl:col-span-4">
      <h2 class="font-semibold">状态流转</h2>
      <p class="mt-1 text-xs text-surface-500-400">每次流转都记录依据、操作人和时间。</p>
      <form
        class="mt-4 space-y-3"
        method="POST"
        action="?/transition"
        use:enhance={transitionHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <label class="block">
          <span class="mb-1 block text-sm font-medium">目标状态</span>
          <select class="select" name="nextStatus">
            {#each statusOptions as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">操作人</span>
          <input class="input" name="actor" value={signal.owner} />
        </label>
        <label class="block">
          <span class="mb-1 block text-sm font-medium">流转依据</span>
          <textarea class="textarea" name="reason" rows="3" placeholder="说明新增证据、风险判断或复核结论"></textarea>
        </label>
        <button class="btn w-full variant-filled-primary" type="submit">提交状态流转</button>
      </form>

      {#if signal.status === 'closed'}
        <div class="section-rule mt-5 pt-5">
          <h3 class="font-medium">新事件重新打开</h3>
          <p class="mt-1 text-xs text-surface-500-400">关闭信号收到新报告时，不允许静默修改结论。</p>
          <form
            class="mt-3 space-y-3"
            method="POST"
            action="?/reopen"
            use:enhance={() =>
              async ({ result, update }) => {
                if (result.type === 'success') {
                  const payload = result.data as { reopen?: { id: string; actor: string; reason: string } };
                  if (payload.reopen) {
                    signalStore.reopen(payload.reopen.id, payload.reopen.actor, payload.reopen.reason);
                  }
                }
                await update({ reset: true });
              }}
          >
            <input type="hidden" name="id" value={signal.id} />
            <input class="input" name="actor" value={signal.owner} aria-label="操作人" />
            <textarea class="textarea" name="reason" rows="2" placeholder="描述新报告及其影响"></textarea>
            <button class="btn w-full variant-soft-error" type="submit">重新打开信号</button>
          </form>
        </div>
      {/if}
    </aside>
  </section>

  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {#each signal.tasks as task (task.id)}
        <div class="rounded border border-surface-300-700 p-3">
          <p class="text-sm font-medium">{task.title}</p>
          <p class="mt-1 text-xs text-surface-500-400">{task.owner} · 截止 {task.dueAt}</p>
          <p class="mt-2 badge {task.status === 'paused' ? 'variant-soft-error' : ''}">
            {taskStatusLabels[task.status]}
          </p>
          {#if task.status === 'paused'}
            <p class="mt-2 text-xs text-error-700">原任务保留，结论复核完成前暂停关闭。</p>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <section class="mb-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">证据矩阵</h2>
        <p class="mt-1 text-sm text-surface-500-400">强支持、弱支持和相反证据并列保存，不覆盖替代解释。</p>
      </div>
      <span class="badge">{signal.evidence.length} 项证据</span>
    </div>
    <EvidenceMatrix
      evidence={signal.evidence}
      signalId={signal.id}
      versions={signal.versions}
      defaultActor={signal.owner}
    />
  </section>

  <div class="grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">补充核查证据</h2>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/evidence"
        use:enhance={evidenceHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <label>
          <span class="mb-1 block text-sm font-medium">证据类型</span>
          <select class="select" name="evidenceType" bind:value={evidenceForm.evidenceType}>
            <option value="complaint">投诉</option>
            <option value="repair">维修</option>
            <option value="adverse_event">不良事件</option>
            <option value="field_report">现场报告</option>
            <option value="test">测试</option>
            <option value="literature">文献</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据强度</span>
          <select class="select" name="strength" bind:value={evidenceForm.strength}>
            <option value="strong">强支持</option>
            <option value="moderate">中等支持</option>
            <option value="weak">弱支持</option>
            <option value="contrary">相反证据</option>
          </select>
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">证据名称</span>
          <input class="input" name="title" bind:value={evidenceForm.title} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">来源</span>
          <input class="input" name="source" bind:value={evidenceForm.source} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">关联批号</span>
          <input class="input" name="batch" bind:value={evidenceForm.batch} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">录入人</span>
          <input class="input" name="actor" bind:value={evidenceForm.actor} />
        </label>

        {#if evidenceForm.strength === 'contrary'}
          <fieldset class="rounded border border-error-300 bg-error-50/50 p-3 md:col-span-2">
            <legend class="px-1 text-sm font-medium text-error-800">
              该相反证据推翻哪些结论版本（勾选后这些版本将失效并进入待复核；不选默认指向全部当前有效版本）
            </legend>
            <div class="mt-2 flex flex-wrap gap-4">
              {#each activeVersions as version (version.id)}
                <label class="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="contradictsVersionIds"
                    value={version.id}
                    bind:group={evidenceForm.contradictsVersionIds}
                  />
                  V{version.version}：{version.summary}
                </label>
              {:else}
                <span class="text-xs text-surface-500-400">当前没有有效结论版本。</span>
              {/each}
            </div>
          </fieldset>
        {/if}

        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">核查说明</span>
          <textarea class="textarea" name="note" rows="3" bind:value={evidenceForm.note}></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-primary" type="submit">加入证据矩阵</button>
        </div>
      </form>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">形成结论版本</h2>
      <p class="mt-1 text-xs text-surface-500-400">
        新结论将引用勾选的证据；其中任一证据后续标记为相反或发生强度变化，本版本即失效待复核。
      </p>
      <form
        class="mt-4 grid gap-4 md:grid-cols-2"
        method="POST"
        action="?/version"
        use:enhance={versionHandler}
      >
        <input type="hidden" name="id" value={signal.id} />
        <input type="hidden" name="versionNumber" value={nextVersion} />
        <label>
          <span class="mb-1 block text-sm font-medium">版本作者</span>
          <input class="input" name="author" value={signal.owner} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">建议处置</span>
          <select class="select" name="disposition">
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <fieldset class="md:col-span-2">
          <legend class="mb-1 block text-sm font-medium">引用证据（默认全选）</legend>
          <div class="grid gap-1 sm:grid-cols-2">
            {#each signal.evidence as item (item.id)}
              <label class="inline-flex items-center gap-2 text-xs">
                <input type="checkbox" name="evidenceIds" value={item.id} bind:group={versionEvidenceIds} />
                {item.title}
              </label>
            {:else}
              <span class="text-xs text-surface-500-400">暂无证据，建议先登记证据再形成结论。</span>
            {/each}
          </div>
        </fieldset>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">结论摘要</span>
          <textarea class="textarea" name="summary" rows="2"></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
          <textarea class="textarea" name="rationale" rows="3"></textarea>
        </label>
        <div class="md:col-span-2">
          <button class="btn variant-filled-secondary" type="submit">保存为 V{nextVersion}</button>
        </div>
      </form>
    </section>
  </div>

  <div class="mt-6 grid gap-6 xl:grid-cols-2">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论版本</h2>
      <div class="mt-4 space-y-4">
        {#each signal.versions as version}
          {@const invalidated = (version.state ?? 'active') === 'invalidated_pending_review'}
          <article class="border-l-2 pl-4 {invalidated ? 'border-error-500' : 'border-teal-600'}">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <span class="badge {invalidated ? 'variant-soft-error' : 'variant-soft-primary'}">
                {invalidated ? '已失效 · 待复核' : '有效'}
              </span>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
            {#if version.evidenceIds && version.evidenceIds.length > 0}
              <p class="mt-2 text-xs text-surface-500-400">
                引用证据：{version.evidenceIds
                  .map((evidenceId) => signal.evidence.find((item) => item.id === evidenceId)?.title ?? evidenceId)
                  .join('、')}
              </p>
            {/if}
            {#if invalidated}
              <p class="mt-2 text-xs text-error-700">
                失效时间 {version.invalidatedAt?.slice(0, 16).replace('T', ' ')}：{version.invalidatedReason}
              </p>
            {/if}
          </article>
        {:else}
          <p class="text-sm text-surface-500-400">尚未形成正式结论版本。</p>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">审计记录</h2>
      <div class="mt-4 space-y-5">
        {#each signal.audit as entry}
          <div class="timeline-item">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
              <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <p class="mt-1 text-xs text-surface-500-400">{entry.detail}</p>
          </div>
        {/each}
      </div>
    </section>
  </div>
{/if}
