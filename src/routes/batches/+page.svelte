<script lang="ts">
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import { signalStore } from '$lib/stores/signal-store';

  $: signals = $signalStore;
  let selectedBatch = 'all';

  $: batches = Array.from(new Set(signals.flatMap((signal) => signal.affectedBatches))).sort();
  $: visibleSignals = signals.filter(
    (signal) => selectedBatch === 'all' || signal.affectedBatches.includes(selectedBatch)
  );

  interface BatchStats {
    total: number;
    disposed: number;
    review: number;
    open: number;
  }

  $: batchStats = (() => {
    const map = new Map<string, BatchStats>();
    for (const signal of signals) {
      const hasActiveVersion = signal.versions.some((version) => version.status === 'active');
      const isReview = signal.status === 'review' || signal.versions.some((version) => version.status === 'invalid');
      for (const batch of signal.affectedBatches) {
        const stats = map.get(batch) ?? { total: 0, disposed: 0, review: 0, open: 0 };
        stats.total += 1;
        if (signal.status === 'closed' && hasActiveVersion) stats.disposed += 1;
        else if (isReview) stats.review += 1;
        else stats.open += 1;
        map.set(batch, stats);
      }
    }
    return map;
  })();

  $: overallStats = (() => {
    const stats: BatchStats = { total: signals.length, disposed: 0, review: 0, open: 0 };
    for (const signal of signals) {
      const hasActiveVersion = signal.versions.some((version) => version.status === 'active');
      const isReview = signal.status === 'review' || signal.versions.some((version) => version.status === 'invalid');
      if (signal.status === 'closed' && hasActiveVersion) stats.disposed += 1;
      else if (isReview) stats.review += 1;
      else stats.open += 1;
    }
    return stats;
  })();
</script>

<svelte:head><title>批次追踪 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批次追踪</h1>
    <p class="mt-1 text-sm text-surface-600-300">按生产批号或软件版本追踪信号覆盖、报告数量和已处置状态。</p>
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

<section class="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
  <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <p class="text-sm text-surface-500-400">信号总数</p>
    <p class="metric-value mt-2 text-2xl font-semibold">{overallStats.total}</p>
  </article>
  <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <p class="text-sm text-surface-500-400">已处置</p>
    <p class="metric-value mt-2 text-2xl font-semibold text-teal-700">{overallStats.disposed}</p>
    <p class="mt-1 text-xs text-surface-500-400">已关闭且结论有效</p>
  </article>
  <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <p class="text-sm text-surface-500-400">待复核</p>
    <p class="metric-value mt-2 text-2xl font-semibold text-error-700">{overallStats.review}</p>
    <p class="mt-1 text-xs text-surface-500-400">结论失效，不再按已处置统计</p>
  </article>
  <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
    <p class="text-sm text-surface-500-400">进行中</p>
    <p class="metric-value mt-2 text-2xl font-semibold text-amber-700">{overallStats.open}</p>
  </article>
</section>

<section class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
  {#each visibleSignals as signal}
    {@const stats = batchStats.get(signal.batch)}
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
      {#if stats}
        <div class="mt-4 flex flex-wrap gap-2 text-xs">
          <span class="badge variant-soft-success">已处置 {stats.disposed}</span>
          <span class="badge variant-soft-error">待复核 {stats.review}</span>
          <span class="badge variant-soft">进行中 {stats.open}</span>
        </div>
      {/if}
      <p class="mt-4 text-sm text-surface-600-300">覆盖批号：{signal.affectedBatches.join('、')}</p>
      <a class="btn btn-sm mt-4 variant-soft-primary" href={`/signals/${signal.id}`}>查看批次证据</a>
    </article>
  {/each}
</section>
