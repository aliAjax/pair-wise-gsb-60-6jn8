<script lang="ts">
  import { enhance } from '$app/forms';
  import type { EvidenceItem, EvidenceStrength } from '$lib/models/signal';

  export let signalId: string;
  export let evidence: EvidenceItem[];

  const strengthLabels: Record<EvidenceItem['strength'], string> = {
    strong: '强支持',
    moderate: '中等支持',
    weak: '弱支持',
    contrary: '相反证据'
  };

  const typeLabels: Record<EvidenceItem['type'], string> = {
    complaint: '投诉',
    repair: '维修',
    adverse_event: '不良事件',
    field_report: '现场报告',
    test: '测试',
    literature: '文献'
  };

  const strengthOptions: Array<{ value: EvidenceStrength; label: string }> = [
    { value: 'strong', label: '强支持' },
    { value: 'moderate', label: '中等支持' },
    { value: 'weak', label: '弱支持' },
    { value: 'contrary', label: '相反证据' }
  ];
</script>

<div class="grid gap-3 lg:grid-cols-2">
  {#each evidence as item (item.id)}
    <article
      class="rounded border border-surface-300-700 bg-surface-100-900 p-4 {item.strength === 'strong'
        ? 'evidence-strong'
        : item.strength === 'contrary'
          ? 'evidence-conflicting'
          : 'evidence-weak'}"
    >
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p class="text-xs font-medium text-surface-500-400">{typeLabels[item.type]}</p>
          <h4 class="mt-1 font-semibold">{item.title}</h4>
        </div>
        <span class="badge">{strengthLabels[item.strength]}</span>
      </div>
      <p class="mt-3 text-sm text-surface-600-300">{item.note}</p>
      <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-surface-500-400">
        <span>来源：{item.source}</span>
        <span>批号：{item.batch}</span>
        <span>录入：{item.createdAt.slice(0, 10)}</span>
        {#if item.strengthChangedAt}
          <span>标记变化：{item.strengthChangedAt.slice(0, 10)}</span>
        {/if}
      </div>

      <form
        class="mt-3 border-t border-surface-300-700 pt-3"
        method="POST"
        action="?/evidence-strength"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') {
              const payload = result.data as {
                evidenceStrength?: {
                  id: string;
                  evidenceId: string;
                  strength: EvidenceStrength;
                  reason: string;
                  actor: string;
                };
              };
              if (payload.evidenceStrength) {
                const { evidenceId, strength, reason, actor } = payload.evidenceStrength;
                // 由页面级 store 统一处理，避免组件内直接依赖 store
                window.dispatchEvent(
                  new CustomEvent('evidence-strength-change', {
                    detail: { signalId, evidenceId, strength, reason, actor }
                  })
                );
              }
            }
            await update({ reset: true });
          }}
      >
        <input type="hidden" name="id" value={signalId} />
        <input type="hidden" name="evidenceId" value={item.id} />
        <div class="grid gap-2 md:grid-cols-[1fr_1fr]">
          <label class="text-xs">
            <span class="mb-1 block text-surface-500-400">重新标记强度</span>
            <select class="select" name="strength" value={item.strength}>
              {#each strengthOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="text-xs">
            <span class="mb-1 block text-surface-500-400">操作人</span>
            <input class="input" name="actor" value="安全评审专员" />
          </label>
        </div>
        <label class="mt-2 block text-xs">
          <span class="mb-1 block text-surface-500-400">变化依据</span>
          <input class="input" name="reason" placeholder="说明证据强度变化的原因" required minlength="4" />
        </label>
        <button class="btn btn-sm mt-2 variant-soft-primary" type="submit">更新证据标记</button>
      </form>
    </article>
  {/each}
</div>
