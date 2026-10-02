export { toCents, fromCents, formatK } from '../lib/money.js';
import { splitInclusive } from '../services/tax.js';
export const splitInclusiveSafe = (amount, rate) => splitInclusive(amount, String(Number(rate)));
