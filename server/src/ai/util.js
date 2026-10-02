export { toCents, fromCents, formatK } from '../lib/money.js';
import { splitInclusive } from '../services/tax.js';
export const splitInclusiveSafe = (amount, rate) => splitInclusive(amount, String(Number(rate)));

/** Text of a Claude response. Current models may also return thinking blocks, which are skipped. */
export const textOf = (resp) => resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** Friendly message for responses that ended without a usable answer, or null when the answer is fine. */
export function stopProblem(resp) {
  if (resp.stop_reason === 'refusal') return 'The AI declined to answer this request. Try rephrasing it, or use the reports directly.';
  if (resp.stop_reason === 'max_tokens' && !textOf(resp)) return 'The AI ran out of room before answering. Please ask a narrower question.';
  return null;
}
