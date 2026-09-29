<script lang="ts">
  import { onDestroy } from 'svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import EvidenceMatrix from '$lib/components/EvidenceMatrix.svelte';
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import type {
    AuditEntry,
    CaseVersion,
    EvidenceItem,
    EvidenceStrength,
    InvestigationTask,
    SignalStatus
  } from '$lib/models/signal';
  import { exportSignalReport } from '$lib/services/signal-service';
  import { clearDraft, loadDrafts, saveDraft, type FormDraft } from '$lib/services/persistence';
  import { signalStore } from '$lib/stores/signal-store';
  import type { ActionData, PageData } from './$types';

  export let data: PageData;
  export let form: ActionData;

  $: signal = $signalStore.find((item) => item.id === data.id);
  $: nextVersion = (signal?.versions[0]?.version ?? 0) + 1;

  const statusOptions: Array<{ value: SignalStatus; label: string }> = [
    { value: 'investigating', label: '转入调查' },
    { value: 'observed', label: '持续观察' },
    { value: 'action_required', label: '进入风险处置' },
    { value: 'review', label: '提交复核' },
    { value: 'closed', label: '关闭信号' }
  ];

  const strengthLabels: Record<EvidenceStrength, string> = {
    strong: '强支持',
    moderate: '中等支持',
    weak: '弱支持',
    contrary: '相反证据'
  };

  const taskStatusLabels: Record<InvestigationTask['status'], string> = {
    open: '待开始',
    in_progress: '进行中',
    done: '已完成',
    paused: '已暂停'
  };

  // ---- 表单草稿（未完成核对恢复）----
  let evidenceForm = {
    evidenceType: 'complaint',
    strength: 'contrary' as EvidenceStrength,
    title: '',
    source: '',
    batch: '',
    actor: '',
    note: ''
  };
  let versionForm = {
    author: '',
    disposition: 'continue_observation' as CaseVersion['disposition'],
    summary: '',
    rationale: ''
  };

  $: drafts = typeof window === 'undefined' ? ({} as Record<string, FormDraft>) : loadDrafts();
  $: evidenceDraft = drafts[`evidence-${data.id}`];
  $: versionDraft = drafts[`version-${data.id}`];

  function restoreDrafts() {
    if (evidenceDraft) {
      const d = evidenceDraft.data;
      evidenceForm = {
        evidenceType: d.evidenceType ?? 'complaint',
        strength: (d.strength as EvidenceStrength) ?? 'contrary',
        title: d.title ?? '',
        source: d.source ?? '',
        batch: d.batch ?? '',
        actor: d.actor ?? '',
        note: d.note ?? ''
      };
      clearDraft(`evidence-${data.id}`);
    }
    if (versionDraft) {
      const d = versionDraft.data;
      versionForm = {
        author: d.author ?? '',
        disposition: (d.disposition as CaseVersion['disposition']) ?? 'continue_observation',
        summary: d.summary ?? '',
        rationale: d.rationale ?? ''
      };
      clearDraft(`version-${data.id}`);
    }
    drafts = loadDrafts();
  }

  function discardDrafts() {
    clearDraft(`evidence-${data.id}`);
    clearDraft(`version-${data.id}`);
    drafts = loadDrafts();
  }

  function persistDraft(form: 'evidence' | 'version', formElement: HTMLFormElement) {
    const data: Record<string, string> = {};
    new FormData(formElement).forEach((value, key) => {
      data[key] = String(value);
    });
    saveDraft({
      key: `${form}-${data.id}`,
      signalId: data.id,
      form,
      data,
      savedAt: new Date().toISOString()
    });
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
    return async ({ result, update, formElement }) => {
      persistDraft('evidence', formElement);
      if (result.type === 'success') {
        const payload = result.data as { evidence?: EvidenceItem; actor?: string };
        if (payload.evidence) {
          signalStore.addEvidence(data.id, payload.evidence, payload.actor ?? signal?.owner ?? '安全评审专员');
          clearDraft(`evidence-${data.id}`);
        }
      }
      await update({ reset: true });
    };
  };

  const versionHandler: SubmitFunction = () => {
    return async ({ result, update, formElement }) => {
      persistDraft('version', formElement);
      if (result.type === 'success') {
        const payload = result.data as { version?: CaseVersion; actor?: string };
        if (payload.version) {
          signalStore.addVersion(data.id, payload.version, payload.actor ?? signal?.owner ?? '安全评审专员');
          clearDraft(`version-${data.id}`);
        }
      }
      await update({ reset: true });
    };
  };

  const reopenHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as { reopen?: { id: string; actor: string; reason: string } };
        if (payload.reopen) {
          signalStore.reopen(payload.reopen.id, payload.reopen.actor, payload.reopen.reason);
        }
      }
      await update({ reset: true });
    };
  };

  const taskHandler: SubmitFunction = () => {
    return async ({ result, update }) => {
      if (result.type === 'success') {
        const payload = result.data as { signalId?: string; task?: InvestigationTask };
        if (payload.signalId && payload.task) {
          signalStore.replaceTask(payload.signalId, payload.task);
        }
      }
      await update({ reset: true });
    };
  };

  // 证据标记变化：由 EvidenceMatrix 组件派发
  function handleEvidenceStrengthChange(event: Event) {
    const detail = (event as CustomEvent).detail as {
      signalId: string;
      evidenceId: string;
      strength: EvidenceStrength;
      reason: string;
      actor: string;
    };
    signalStore.changeEvidenceStrength(
      detail.signalId,
      detail.evidenceId,
      detail.strength,
      detail.reason,
      detail.actor
    );
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('evidence-strength-change', handleEvidenceStrengthChange);
    onDestroy(() => {
      window.removeEventListener('evidence-strength-change', handleEvidenceStrengthChange);
    });
  }
</script>

<svelte:head><title>{signal?.id ?? data.id} | 信号核查详情</title></svelte:head>

{#if !signal}
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

  {#if evidenceDraft || versionDraft}
    <div class="mb-5 rounded border border-amber-300 bg-amber-50 p-4 text-amber-900">
      <p class="font-medium">检测到未完成的核对记录</p>
      <p class="mt-1 text-sm">
        {#if evidenceDraft}证据登记（{evidenceDraft.savedAt.slice(0, 16).replace('T', ' ')}）{/if}
        {#if evidenceDraft && versionDraft}、{/if}
        {#if versionDraft}结论版本（{versionDraft.savedAt.slice(0, 16).replace('T', ' ')}）{/if}
        尚未保存成功，是否恢复填写？
      </p>
      <div class="mt-3 flex gap-2">
        <button class="btn btn-sm variant-filled-primary" type="button" on:click={restoreDrafts}>恢复填写</button>
        <button class="btn btn-sm variant-soft" type="button" on:click={discardDrafts}>放弃</button>
      </div>
    </div>
  {/if}

  {#if signal.versions.some((version) => version.status === 'invalid')}
    <div class="mb-5 rounded border border-error-300 bg-error-50 p-4 text-error-900">
      <p class="font-medium">结论已失效，进入待复核</p>
      <p class="mt-1 text-sm">
        相反证据导致 {signal.versions.filter((version) => version.status === 'invalid').length} 个结论版本失效，
        相关调查任务已暂停关闭，批次不再按已处置统计。请形成新的结论版本后重新提交复核。
      </p>
    </div>
  {/if}

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
            use:enhance={reopenHandler}
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

  <section class="mb-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">证据矩阵</h2>
        <p class="mt-1 text-sm text-surface-500-400">强支持、弱支持和相反证据并列保存，不覆盖替代解释。</p>
      </div>
      <span class="badge">{signal.evidence.length} 项证据</span>
    </div>
    <EvidenceMatrix signalId={signal.id} evidence={signal.evidence} />
  </section>

  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold">调查任务</h2>
        <p class="mt-1 text-sm text-surface-500-400">结论失效后任务保留但暂停关闭，原调查不丢失。</p>
      </div>
    </div>
    {#if signal.tasks.length === 0}
      <p class="text-sm text-surface-500-400">暂无调查任务。</p>
    {:else}
      <div class="space-y-3">
        {#each signal.tasks as task (task.id)}
          <article class="flex flex-wrap items-center justify-between gap-3 rounded border border-surface-300-700 p-3">
            <div>
              <p class="font-medium">{task.title}</p>
              <p class="mt-1 text-xs text-surface-500-400">{task.owner} · 截止 {task.dueAt}</p>
            </div>
            <div class="flex items-center gap-2">
              {#if task.status === 'paused'}
                <span class="badge variant-soft-warning">已暂停 · 待复核</span>
              {:else}
                <form method="POST" action="?/task" use:enhance={taskHandler}>
                  <input type="hidden" name="id" value={signal.id} />
                  <input type="hidden" name="taskId" value={task.id} />
                  <input type="hidden" name="title" value={task.title} />
                  <input type="hidden" name="owner" value={task.owner} />
                  <input type="hidden" name="dueAt" value={task.dueAt} />
                  <select
                    class="select select-sm"
                    name="status"
                    value={task.status}
                    on:change={(event) => event.currentTarget.form?.requestSubmit()}
                  >
                    {#each Object.entries(taskStatusLabels) as [value, label]}
                      <option value={value}>{label}</option>
                    {/each}
                  </select>
                </form>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
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
            {#each Object.entries(strengthLabels) as [value, label]}
              <option value={value}>{label}</option>
            {/each}
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
          <input class="input" name="author" bind:value={versionForm.author} />
        </label>
        <label>
          <span class="mb-1 block text-sm font-medium">建议处置</span>
          <select class="select" name="disposition" bind:value={versionForm.disposition}>
            <option value="continue_observation">继续观察</option>
            <option value="risk_communication">风险沟通</option>
            <option value="corrective_action">纠正措施</option>
          </select>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">结论摘要</span>
          <textarea class="textarea" name="summary" rows="2" bind:value={versionForm.summary}></textarea>
        </label>
        <label class="md:col-span-2">
          <span class="mb-1 block text-sm font-medium">判断依据与替代解释</span>
          <textarea class="textarea" name="rationale" rows="3" bind:value={versionForm.rationale}></textarea>
        </label>
        <fieldset class="md:col-span-2">
          <legend class="mb-1 block text-sm font-medium">结论依据证据（必选）</legend>
          <div class="grid gap-2 md:grid-cols-2">
            {#each signal.evidence as item (item.id)}
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" name="evidenceIds" value={item.id} checked />
                <span>{item.title}</span>
                <span class="text-xs text-surface-500-400">({strengthLabels[item.strength]})</span>
              </label>
            {:else}
              <p class="text-sm text-surface-500-400">暂无证据，请先登记证据。</p>
            {/each}
          </div>
        </fieldset>
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
          <article class="border-l-2 {version.status === 'invalid' ? 'border-error-500' : 'border-teal-600'} pl-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="font-medium">V{version.version} · {version.author}</p>
              <div class="flex items-center gap-2">
                {#if version.status === 'invalid'}
                  <span class="badge variant-soft-error">已失效</span>
                {:else}
                  <span class="badge variant-soft-success">有效</span>
                {/if}
                <span class="text-xs text-surface-500-400">{version.createdAt.slice(0, 10)}</span>
              </div>
            </div>
            <p class="mt-2 text-sm">{version.summary}</p>
            <p class="mt-2 text-xs text-surface-500-400">{version.rationale}</p>
            <p class="mt-2 text-xs text-surface-500-400">
              依据证据：{version.evidenceIds.length > 0 ? version.evidenceIds.join('、') : '未关联'}
            </p>
            {#if version.status === 'invalid' && version.invalidatedAt}
              <p class="mt-1 text-xs text-error-600">
                {version.invalidatedAt.slice(0, 16).replace('T', ' ')} 失效：{version.invalidatedReason}
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
