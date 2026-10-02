import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { getSecret } from '../services/secrets.js';

/** Resolve the API key: company key → platform key (Admin Center) → environment variable. Keys never reach the browser. */
export async function aiClient(ctx) {
  if (ctx.settings?.ai?.enabled === false) return null;
  const key = (await getSecret(ctx.companyId, 'anthropic_api_key')) || (await getSecret(null, 'anthropic_api_key')) || config.anthropicApiKey;
  if (!key) return null;
  return { client: new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 }), model: ctx.settings?.ai?.model || config.aiModel };
}
