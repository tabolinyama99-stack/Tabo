import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { getSecret } from '../services/secrets.js';

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Resolve the API key: company key → platform key (Admin Center) → environment variable. Keys never reach the browser. */
export async function aiClient(ctx) {
  if (ctx.settings?.ai?.enabled === false) return null;
  const key = (await getSecret(ctx.companyId, 'anthropic_api_key')) || (await getSecret(null, 'anthropic_api_key')) || config.anthropicApiKey;
  if (!key) return null;
  return { client: new Anthropic({ apiKey: key, maxRetries: 1, timeout: 120_000 }), model: ctx.settings?.ai?.model || config.aiModel };
}

/**
 * Send one Messages API request. Current models think before answering and thinking counts toward
 * max_tokens, so callers pass generous limits. A refusal is retried on a fallback model server-side
 * where the model supports it. Returns the full response; check `stop_reason` before reading text.
 */
export async function createMessage(ai, params, { effort = 'medium' } = {}) {
  const body = { model: ai.model, output_config: { effort }, ...params };
  if (FALLBACK_MODELS.has(ai.model)) {
    try {
      return await ai.client.beta.messages.create({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' });
    } catch (e) {
      // An account or deployment without the fallback beta: retry once as a plain request.
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
    }
  }
  return ai.client.messages.create(body);
}

export const textOf = (resp) => resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** Friendly message for responses that ended without a usable answer, or null when the answer is fine. */
export function stopProblem(resp) {
  if (resp.stop_reason === 'refusal') return 'The AI declined to answer this request. Try rephrasing it, or use the reports directly.';
  if (resp.stop_reason === 'max_tokens' && !textOf(resp)) return 'The AI ran out of room before answering. Please ask a narrower question.';
  return null;
}
