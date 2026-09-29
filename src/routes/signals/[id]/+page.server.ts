import { fail } from '@sveltejs/kit';
import {
  evidenceMarkSchema,
  evidenceSchema,
  transitionSchema,
  versionSchema
} from '$lib/models/signal';

export function load({ params }) {
  return { id: params.id };
}

const actorName = (formData: FormData) => String(formData.get('actor') ?? '安全评审专员');

function failure(error: { issues: Array<{ message: string }> }) {
  return fail(400, {
    message: error.issues[0]?.message ?? '表单校验失败'
  });
}

function uid(prefix: string) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

    // 两个窗口同时保存时，UUID 保证两份证据记录各自独立、都会留下
    return {
      success: true,
      evidence: {
        id: uid('E'),
        type: parsed.data.evidenceType,
        title: parsed.data.title,
        source: parsed.data.source,
        strength: parsed.data.strength,
        batch: parsed.data.batch,
        note: parsed.data.note,
        referencedVersionIds: formData.getAll('contradictsVersionIds').map(String),
        createdAt: new Date().toISOString()
      },
      actor: actorName(formData)
    };
  },

  mark: async ({ request }) => {
    const formData = await request.formData();
    const parsed = evidenceMarkSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      mark: parsed.data
    };
  },

  version: async ({ request }) => {
    const formData = await request.formData();
    const parsed = versionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return failure(parsed.error);

    return {
      success: true,
      version: {
        id: uid('V'),
        version: Number(formData.get('versionNumber') ?? 1),
        author: parsed.data.author,
        summary: parsed.data.summary,
        disposition: parsed.data.disposition,
        rationale: parsed.data.rationale,
        evidenceIds: formData.getAll('evidenceIds').map(String),
        createdAt: new Date().toISOString()
      },
      actor: parsed.data.author
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
