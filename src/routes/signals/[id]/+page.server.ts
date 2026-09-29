import { fail } from '@sveltejs/kit';
import {
  evidenceSchema,
  evidenceStrengthSchema,
  transitionSchema,
  versionSchema
} from '$lib/models/signal';
import type { InvestigationTask } from '$lib/models/signal';

  export function load({ params }) {
    return { id: params.id };
  }

  const actorName = (formData: FormData) => String(formData.get('actor') ?? '安全评审专员');

  function failure(error: { issues: Array<{ message: string }> }) {
    return fail(400, {
      message: error.issues[0]?.message ?? '表单校验失败'
    });
  }

  export const actions = {
    transition: async ({ request }) => {
      const formData = await request.formData();
      const parsed = transitionSchema.safeParse(Object.fromEntries(formData));
      if (!parsed.success) return failure(parsed.error);

      return {
        success: true,
        transition: parsed.data
      };
    },

    evidence: async ({ request }) => {
      const formData = await request.formData();
      const parsed = evidenceSchema.safeParse(Object.fromEntries(formData));
      if (!parsed.success) return failure(parsed.error);

      return {
        success: true,
        evidence: {
          id: `E-${Date.now().toString(36)}`,
          type: parsed.data.evidenceType,
          title: parsed.data.title,
          source: parsed.data.source,
          strength: parsed.data.strength,
          batch: parsed.data.batch,
          note: parsed.data.note,
          createdAt: new Date().toISOString()
        },
        actor: actorName(formData)
      };
    },

    'evidence-strength': async ({ request }) => {
      const formData = await request.formData();
      const parsed = evidenceStrengthSchema.safeParse(Object.fromEntries(formData));
      if (!parsed.success) return failure(parsed.error);

      return {
        success: true,
        evidenceStrength: parsed.data
      };
    },

    version: async ({ request }) => {
      const formData = await request.formData();
      const evidenceIds = formData.getAll('evidenceIds').map(String);
      const parsed = versionSchema.safeParse({
        ...Object.fromEntries(formData),
        evidenceIds
      });
      if (!parsed.success) return failure(parsed.error);

      return {
        success: true,
        version: {
          id: `V-${Date.now().toString(36)}`,
          version: Number(formData.get('versionNumber') ?? 1),
          author: parsed.data.author,
          summary: parsed.data.summary,
          disposition: parsed.data.disposition,
          rationale: parsed.data.rationale,
          evidenceIds: parsed.data.evidenceIds,
          status: 'active' as const,
          createdAt: new Date().toISOString()
        },
        actor: parsed.data.author
      };
    },

    task: async ({ request }) => {
      const formData = await request.formData();
      const id = String(formData.get('id') ?? '');
      const taskId = String(formData.get('taskId') ?? '');
      const status = String(formData.get('status') ?? '');
      const title = String(formData.get('title') ?? '');
      const owner = String(formData.get('owner') ?? '');
      const dueAt = String(formData.get('dueAt') ?? '');

      if (!id || !taskId || !title || !['open', 'in_progress', 'done', 'paused'].includes(status)) {
        return fail(400, { message: '任务状态无效，无法更新。' });
      }

      const task: InvestigationTask = { id: taskId, title, owner, dueAt, status: status as InvestigationTask['status'] };
      return {
        success: true,
        signalId: id,
        task
      };
    },

    reopen: async ({ request }) => {
      const formData = await request.formData();
      const actor = actorName(formData);
      const reason = String(formData.get('reason') ?? '').trim();
      const id = String(formData.get('id') ?? '');

      if (reason.length < 6) return fail(400, { message: '重新打开原因至少 6 个字符。' });

      return {
        success: true,
        reopen: { id, actor, reason, createdAt: new Date().toISOString() }
      };
    }
  };