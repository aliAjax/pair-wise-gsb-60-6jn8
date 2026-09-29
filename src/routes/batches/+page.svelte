<script lang="ts">
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import { isDispositionSettled } from '$lib/services/signal-domain';
  import { signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  let selectedBatch = 'all';

  $: batches = Array.from(new Set(signals.flatMap((signal) => signal.affectedBatches))).sort();

  // 批次已处置口径：关联该批号的全部信号均已关闭，且不存在失效待复核结论；
  // 任一信号因相反证据退出已处置，该批次即回到待复核口径。
  function batchSettled(batch: string): boolean {
    const related = signals.filter((signal) => signal.affectedBatches.includes(batch));
    return related.length > 0 && related.every(isDispositionSettled);
  }

  $: visibleSignals = signals.filter(
    (signal) => selectedBatch === 'all' || signal.affectedBatches.includes(selectedBatch)
  );
  $: visibleBatches =
    selectedBatch === 'all' ? batches : batches.filter((batch) => batch === selectedBatch);
  $: settledCount = visibleBatches.filter(batchSettled).length;
  $: pendingCount = visibleBatches.length - settledCount;
</script>

<svelte:head><title>批次追踪 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批次追踪</h1>
    <p class="mt-1 text-sm text-surface-600-300">按生产批号或软件版本追踪信号覆盖、报告数量和处置口径；结论失效的批次不计已处置。</p>
  </div>
  <label class="min-w-[240px]">
    <span class="mb-1 block text-sm font-medium">目标批号</span>
    <select class="select" bind:value={selectedBatch}>
      <option value="all">全部批号</option>
      {#each batches as batch}
        <option value={batch}>{batch}</option>
      {/each}
    </select>
  </label>
</div>

<section class="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
  <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <p class="text-sm text-surface-500-400">覆盖批号</p>
    <p class="metric-value mt-2 text-2xl font-semibold">{visibleBatches.length}</p>
  </article>
  <article class="rounded border border-emerald-300 bg-emerald-50 p-4">
    <p class="text-sm text-emerald-800">已处置批次</p>
    <p class="metric-value mt-2 text-2xl font-semibold">{settledCount}</p>
    <p class="mt-1 text-xs text-emerald-700">已关闭且结论持续有效</p>
  </article>
  <article class="rounded border border-amber-400 bg-amber-50 p-4">
    <p class="text-sm text-amber-900">待复核批次</p>
    <p class="metric-value mt-2 text-2xl font-semibold">{pendingCount}</p>
    <p class="mt-1 text-xs text-amber-800">未关闭，或结论因相反证据失效</p>
  </article>
  <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <p class="text-sm text-surface-500-400">关联信号</p>
    <p class="metric-value mt-2 text-2xl font-semibold">{visibleSignals.length}</p>
  </article>
</section>

<section class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
  {#each visibleSignals as signal}
    <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm text-surface-500-400">{signal.product}</p>
          <h2 class="mt-1 font-semibold">{signal.batch}</h2>
        </div>
        <RiskBadge risk={signal.riskLevel} status={signal.status} />
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt class="text-surface-500-400">报告数量</dt>
          <dd class="metric-value mt-1 font-semibold">{signal.reportCount}</dd>
        </div>
        <div>
          <dt class="text-surface-500-400">暴露数量</dt>
          <dd class="metric-value mt-1 font-semibold">{signal.exposedUnits}</dd>
        </div>
      </dl>
      <p class="mt-4 text-sm text-surface-600-300">覆盖批号：{signal.affectedBatches.join('、')}</p>
      {#if isDispositionSettled(signal)}
        <p class="mt-3 badge bg-emerald-100 text-emerald-900">按已处置统计</p>
      {:else}
        <p class="mt-3 badge variant-soft-error">
          不计已处置{signal.versions.some((v) => v.state === 'invalidated_pending_review') ? '（结论待复核）' : ''}
        </p>
      {/if}
      <a class="btn btn-sm mt-4 variant-soft-primary" href={`/signals/${signal.id}`}>查看批次证据</a>
    </article>
  {/each}
</section>
