<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { CaseVersion, EvidenceItem, EvidenceStrength } from '$lib/models/signal';
  import { signalStore } from '$lib/stores/signal-store';

  export let evidence: EvidenceItem[];
  export let signalId: string;
  export let versions: CaseVersion[] = [];
  export let defaultActor = '';

  const strengthLabels: Record<EvidenceStrength, string> = {
    strong: '强支持',
    moderate: '中等支持',
    weak: '弱支持',
    contrary: '相反证据'
  };

  const strengthOptions: EvidenceStrength[] = ['strong', 'moderate', 'weak', 'contrary'];

  const typeLabels: Record<EvidenceItem['type'], string> = {
    complaint: '投诉',
    repair: '维修',
    adverse_event: '不良事件',
    field_report: '现场报告',
    test: '测试',
    literature: '文献'
  };

  function versionLabel(versionId: string) {
    const version = versions.find((item) => item.id === versionId);
    return version ? `V${version.version}` : versionId;
  }

  const markHandler: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === 'success') {
      const payload = result.data as {
        mark?: { id: string; evidenceId: string; strength: EvidenceStrength; reason: string; actor: string };
      };
      if (payload.mark) {
        // 标记变化、结论失效、批次统计在同一个原子操作内生效
        signalStore.markEvidence(
          payload.mark.id,
          payload.mark.evidenceId,
          payload.mark.strength,
          payload.mark.reason,
          payload.mark.actor
        );
      }
    }
    await update({ reset: true });
  };
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
      </div>

      {#if item.contradictsVersionIds && item.contradictsVersionIds.length > 0}
        <p class="mt-2 text-xs font-medium text-error-700">
          相反指向：{item.contradictsVersionIds.map(versionLabel).join('、')}
        </p>
      {/if}

      {#if item.strengthHistory && item.strengthHistory.length > 1}
        <div class="mt-3 rounded border border-surface-300-700 p-2 text-xs text-surface-500-400">
          <p class="font-medium">强度标记变化（原证据保留）：</p>
          <ul class="mt-1 list-inside list-disc space-y-0.5">
            {#each item.strengthHistory as change (change.id)}
              <li>
                {change.changedAt.slice(0, 10)} · {strengthLabels[change.strength]} · {change.actor}
                {#if change.reason}· {change.reason}{/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <details class="mt-3 text-xs">
        <summary class="cursor-pointer font-medium text-primary-700-300">标记强度变化（引用该证据的结论将失效待复核）</summary>
        <form method="POST" action="?/mark" use:enhance={markHandler} class="mt-2 grid gap-2">
          <input type="hidden" name="id" value={signalId} />
          <input type="hidden" name="evidenceId" value={item.id} />
          <label class="block">
            <span class="mb-1 block">变更后强度</span>
            <select class="select" name="strength">
              {#each strengthOptions as option}
                <option value={option} selected={option === item.strength}>{strengthLabels[option]}</option>
              {/each}
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block">操作人</span>
            <input class="input" name="actor" value={defaultActor} required />
          </label>
          <label class="block">
            <span class="mb-1 block">变化依据</span>
            <textarea class="textarea" name="reason" rows="2" placeholder="说明新发现的核查依据（至少 4 个字符）"></textarea>
          </label>
          <button class="btn btn-sm variant-soft-error" type="submit">提交标记变化</button>
        </form>
      </details>
    </article>
  {/each}
</div>
