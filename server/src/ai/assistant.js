// The AI accounting assistant. With an Anthropic API key it uses Claude with tool use;
// without one it uses a built-in intent engine over the same tools. Either way every number
// in an answer comes from a tool result (database), and sources are returned with the answer.
import { pool } from '../db/pool.js';
import { TOOLS, runTool, today, monthStart, addMonths, addDays } from './tools.js';
import { aiClient, createMessage, textOf, stopProblem } from './provider.js';
import { toCents, fromCents, formatK } from './util.js';
import { can } from '../services/ledger.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';

const K = (v) => (v === null || v === undefined ? '—' : formatK(v));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthEnd = (d) => { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };

/** Extract a date range from text: this/last month, this/last year, today, last N days, "in March". */
export function parsePeriod(text) {
  const t = text.toLowerCase();
  const now = today();
  if (/last month|previous month/.test(t)) { const s = addMonths(monthStart(now), -1); return { from: s, to: monthEnd(s), label: 'last month' }; }
  if (/this year|year to date|ytd/.test(t)) return { from: `${now.slice(0, 4)}-01-01`, to: now, label: 'this year' };
  if (/last year|previous year/.test(t)) { const y = Number(now.slice(0, 4)) - 1; return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` }; }
  if (/\btoday\b/.test(t)) return { from: now, to: now, label: 'today' };
  if (/this week/.test(t)) { const d = new Date(`${now}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; return { from: addDays(now, -dow), to: now, label: 'this week' }; }
  let m = t.match(/last (\d{1,3}) days/);
  if (m) return { from: addDays(now, -Number(m[1])), to: now, label: `the last ${m[1]} days` };
  m = t.match(/(?:in|for|during)\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?/);
  if (m) { const mi = MONTHS.indexOf(m[1]); let y = Number(m[2] || now.slice(0, 4)); if (!m[2] && mi + 1 > Number(now.slice(5, 7))) y -= 1; const s = `${y}-${String(mi + 1).padStart(2, '0')}-01`; return { from: s, to: monthEnd(s), label: `${m[1][0].toUpperCase()}${m[1].slice(1)} ${y}` }; }
  return { from: monthStart(now), to: now, label: 'this month' };
}

function parseAmount(text) {
  const m = text.match(/(?:k|zmw|kwacha)\s?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s?(?:k\b|kwacha|zmw)/i) || text.match(/\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\b/);
  if (!m) return null;
  return (m[1] || m[2]).replace(/,/g, '');
}

/** Built-in engine: map a question to tools and write the answer from their results. */
async function builtIn(ctx, message) {
  const t = message.toLowerCase();
  const p = parsePeriod(message);
  const used = [];
  const call = async (name, input) => { const r = await runTool(ctx, name, input); used.push(name); return r; };

  // ── Transaction instructions → drafts
  const amount = parseAmount(message);
  if (amount && /^(please\s+)?(record|post|enter|book|add|create|log|capture)\b|\b(paid|bought|purchased|received|sold|spent|invoice)\b/.test(t) && !/\bhow much\b|\?$/.test(t.trim())) {
    const via = /mobile money|airtel|mtn|zamtel|momo/.test(t) ? 'mobile_money' : /bank|transfer|eft|card|cheque/.test(t) ? 'bank' : 'cash';
    const party = message.match(/\b(?:to|from|for|by)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/)?.[1];
    const vat = /incl(?:uding|usive)? vat|vat incl|with vat/.test(t);
    let type;
    if (/cash sale|sold .* (for )?cash|sale .* cash|received .* (for|from) (a )?sale/.test(t)) type = 'cash_sale';
    else if (/\b(credit sale|invoice)\b/.test(t)) type = 'credit_sale';
    else if (/\bbill\b|on credit|supplier invoice/.test(t)) type = 'bill';
    else if (/received .* from|receipt from|customer paid/.test(t)) type = 'customer_receipt';
    else if (/pay(ment)? to supplier|paid supplier|settle(d)? .* bill/.test(t)) type = 'supplier_payment';
    else if (/owner|capital|invest(ed)? .* in(to)? the business/.test(t)) type = /draw|withdr/.test(t) ? 'owner_drawing' : 'owner_contribution';
    else if (/\bsale\b|\bsold\b/.test(t)) type = 'cash_sale';
    else type = 'expense';
    const category = message.match(/\b(?:for|on)\s+([a-z][a-z ]{2,30}?)(?:\s+(?:from|via|by|using|paid|in cash|with|on)\b|[.,]|$)/i)?.[1];
    const r = await call('prepare_transaction_draft', { type, amount, description: message.slice(0, 200), paid_via: via, category, party_name: party, includes_vat: vat, date: today() });
    if (r.proposal) return { answer: `I've prepared a ${type === 'customer_receipt' ? 'customer receipt' : 'supplier payment'} form for **${K(amount)}**${r.data.party ? ` (${r.data.party})` : ''}. Payments must be confirmed by you so they can be allocated to the right ${type === 'customer_receipt' ? 'invoices' : 'bills'}.\n\n**Nothing has been recorded yet.**`, proposal: r.proposal, sources: [], used };
    const lines = r.data.proposed_entry.map((l) => `| ${l.account} | ${l.debit ? K(l.debit) : ''} | ${l.credit ? K(l.credit) : ''} |`).join('\n');
    return { answer: `I've prepared **${r.data.record}** — status **${r.data.status}**.\n\nProposed entry:\n\n| Account | Debit | Credit |\n|---|---:|---:|\n${lines}\n\nIt has **not** been posted. An authorised user must review and approve it in Approvals before it affects your books.`, draft: r.draft, sources: r.sources, used };
  }

  if (/overdue/.test(t)) {
    const r = await call('list_overdue_invoices', {});
    if (!r.data.count) return { answer: 'There are no overdue customer invoices right now.', sources: [], used };
    const rows = r.data.invoices.slice(0, 12).map((i) => `| ${i.number} | ${i.customer} | ${i.due_date} | ${i.days_overdue} | ${K(i.balance_due)} |`).join('\n');
    return { answer: `**${r.data.count} invoice${r.data.count > 1 ? 's are' : ' is'} overdue**, totalling **${K(r.data.total_overdue)}**.\n\n| Invoice | Customer | Due | Days overdue | Balance |\n|---|---|---|---:|---:|\n${rows}`, sources: r.sources, used };
  }
  if (/(owes? us|owing us|receivable|debtors|customers owe|who owes)/.test(t)) {
    const r = await call('get_receivables', {});
    const tt = r.data.totals;
    const top = r.data.by_customer.slice(0, 5).map((c) => `- ${c.party}: ${K(c.total)}`).join('\n');
    return { answer: `Customers owe **${K(tt.total)}** as at ${r.data.as_of}.\n\n- Not yet due: ${K(tt.current)}\n- 1–30 days overdue: ${K(tt.d1_30)}\n- 31–60 days: ${K(tt.d31_60)}\n- 61–90 days: ${K(tt.d61_90)}\n- Over 90 days: ${K(tt.d90p)}\n\nLargest balances:\n${top || '- none'}`, sources: r.sources, used };
  }
  if (/(we owe|payable|creditors|owe (our )?suppliers|bills (due|outstanding))/.test(t)) {
    const r = await call('get_payables', {});
    const tt = r.data.totals;
    return { answer: `You owe suppliers **${K(tt.total)}** as at ${r.data.as_of} (${K(fromCents(toCents(tt.d1_30) + toCents(tt.d31_60) + toCents(tt.d61_90) + toCents(tt.d90p)))} past due).\n\n${r.data.by_supplier.slice(0, 5).map((s) => `- ${s.party}: ${K(s.total)}`).join('\n')}`, sources: r.sources, used };
  }
  if (/duplicate/.test(t)) {
    const r = await call('find_anomalies', { kind: 'duplicates' });
    return { answer: r.data.open_items ? `**${r.data.open_items} possible duplicate${r.data.open_items > 1 ? 's' : ''} require review:**\n\n${r.data.items.map((x) => `- ${x.message}`).join('\n')}` : 'No possible duplicate transactions were found.', sources: r.sources, used };
  }
  if (/(unusual|anomal|suspicious|odd|irregular|review)/.test(t)) {
    const r = await call('find_anomalies', { kind: 'all' });
    return { answer: r.data.open_items ? `**${r.data.open_items} item${r.data.open_items > 1 ? 's' : ''} require review** (these are prompts to check, not conclusions):\n\n${r.data.items.slice(0, 15).map((x) => `- **${x.severity}** — ${x.message}`).join('\n')}` : 'Nothing currently requires review.', sources: r.sources, used };
  }
  if (/(why|explain|reason).*(profit|loss|expens|revenue|sales)|compare|versus|vs\.?|than last/.test(t)) {
    // "this month vs last month" compares the current month; with no period named early in a month, explain the last full month.
    const explicit = /this month|last month|previous month|this year|last year|today|week|days|january|february|march|april|may|june|july|august|september|october|november|december/.test(t);
    const now = today();
    const cp = /this month/.test(t) ? { from: monthStart(now), to: now }
      : !explicit && Number(now.slice(8, 10)) < 10 ? { from: addMonths(monthStart(now), -1), to: monthEnd(addMonths(monthStart(now), -1)) } : p;
    const r = await call('compare_periods', { from: cp.from, to: cp.to, compare: /last year|previous year/.test(t) && !/last month/.test(t) ? 'previous_year' : 'previous_period' });
    const c = r.data.current, pr = r.data.previous || {};
    const pct = (a, b) => (toCents(b || 0) === 0n ? 'n/a' : `${(((Number(a) - Number(b)) / Math.abs(Number(b))) * 100).toFixed(1)}%`);
    const drivers = r.data.biggest_changes.slice(0, 5).map((d) => `- ${d.account}: ${K(d.previous)} → ${K(d.current)} (${toCents(d.change) >= 0n ? '+' : ''}${K(d.change)})`).join('\n');
    const dir = toCents(c.net_profit) > toCents(pr.net_profit || 0) ? 'increased' : toCents(c.net_profit) < toCents(pr.net_profit || 0) ? 'decreased' : 'was unchanged';
    return { answer: `Comparing **${r.data.current_period.from} – ${r.data.current_period.to}** with **${r.data.previous_period.from} – ${r.data.previous_period.to}**:\n\n| | Current | Previous | Change |\n|---|---:|---:|---:|\n| Revenue | ${K(c.revenue)} | ${K(pr.revenue)} | ${pct(c.revenue, pr.revenue)} |\n| Cost of sales | ${K(c.cost_of_sales)} | ${K(pr.cost_of_sales)} | ${pct(c.cost_of_sales, pr.cost_of_sales)} |\n| Expenses | ${K(c.expenses)} | ${K(pr.expenses)} | ${pct(c.expenses, pr.expenses)} |\n| **Net profit** | **${K(c.net_profit)}** | **${K(pr.net_profit)}** | ${pct(c.net_profit, pr.net_profit)} |\n\nNet profit ${dir}. The accounts that moved most:\n${drivers || '- no material changes'}`, sources: r.sources, used };
  }
  if (/cash ?flow/.test(t)) {
    const r = await call('cash_flow_summary', { from: p.from, to: p.to });
    const body = r.data.lines.filter((l) => l.amount !== null && l.kind !== 'header').map((l) => `- ${l.kind === 'subtotal' || l.kind === 'total' || l.kind === 'grand' ? `**${l.item}**` : l.item}: ${K(l.amount)}`).join('\n');
    return { answer: `**Cash flow for ${p.label}** (${r.data.period.from} – ${r.data.period.to}):\n\n${body}\n\nCash moved from ${K(r.data.opening)} to ${K(r.data.closing)}, a net change of ${K(r.data.net_change)}.`, sources: r.sources, used };
  }
  let m = t.match(/(?:spen[dt]|spending|cost|paid|pay) (?:on|for) ([a-z ]{3,30}?)(?:\s+(?:this|last|in|during|for)\b|\?|$)/) || t.match(/how much (?:did|have) we (?:spend|spent|pay|paid) (?:on|for) ([a-z ]{3,30}?)(?:\s|\?|$)/);
  if (m) {
    const kw = m[1].trim();
    const per = /this month|last month|this year|last year|today|week|days|january|february|march|april|may|june|july|august|september|october|november|december/.test(t) ? p : { from: `${today().slice(0, 4)}-01-01`, to: today(), label: 'this year' };
    const r = await call('spend_on', { keyword: kw, from: per.from, to: per.to });
    return { answer: `You spent **${K(r.data.total)}** on **${kw}** ${per.label} (${r.data.transactions} transaction${r.data.transactions === 1 ? '' : 's'}${r.data.matched_account ? `, account "${r.data.matched_account}" plus matching descriptions` : ''}).${r.data.by_month.length > 1 ? `\n\n${r.data.by_month.map((x) => `- ${x.month}: ${K(x.amount)}`).join('\n')}` : ''}`, sources: r.sources, used };
  }
  if (/(biggest|largest|top|main|highest) expenses?|expenses? (breakdown|by category)|where .* money go/.test(t)) {
    const r = await call('top_expenses', { from: p.from, to: p.to });
    const cats = r.data.by_category.filter((x) => !x._style).slice(0, 8).map((x) => `| ${x.grp} | ${K(x.amount)} | ${x.share ?? ''}% |`).join('\n');
    const big = r.data.largest.slice(0, 5).map((x) => `- ${x.entry_date} ${x.account}: ${x.description} — ${K(x.debit)}`).join('\n');
    return { answer: `**Biggest expenses ${p.label}** (${r.data.period.from} – ${r.data.period.to}):\n\n| Category | Amount | Share |\n|---|---:|---:|\n${cats || '| none | | |'}\n\nLargest single transactions:\n${big || '- none'}`, sources: r.sources, used };
  }
  m = message.match(/(?:transactions|invoices|payments|history|statement|activity|balance|account) (?:for|with|of) ([A-Z][\w&.' -]{2,60})/i) || message.match(/(?:customer|supplier)\s+([A-Z][\w&.' -]{2,60})/)
    || message.match(/\b([A-Z][\w&.' -]{2,60}?)(?:'s|’s|s') (?:account|statement|balance|invoices|history)/);
  if (m) {
    const r = await call('party_transactions', { name: m[1].replace(/[?.]$/, '').replace(/^(?:please\s+)?(?:show|give|display|open|view|get|prepare|send)(?:\s+(?:me|us))?(?:\s+(?:the|a))?\s+/i, '').trim() });
    if (!r.data.found && r.data.found !== undefined) return { answer: r.data.message, sources: [], used };
    const docs = r.data.documents.slice(0, 10).map((d) => `| ${d.number} | ${d.doc_date} | ${d.status} | ${K(d.total)} | ${K(d.balance_due)} |`).join('\n');
    return { answer: `**${r.data.name}** (${r.data.kind}) — ledger balance **${K(r.data.ledger_balance)}** ${r.data.kind === 'customer' ? 'owed to you' : 'owed by you'}.\n\n| Document | Date | Status | Total | Balance |\n|---|---|---|---:|---:|\n${docs || '| none | | | | |'}\n\n${r.data.payments.length} payment(s) recorded.`, sources: r.sources, used };
  }
  if (/sales|revenue|turnover|\bsold\b|\bsell\b|income/.test(t) && !/profit/.test(t)) {
    const s = await call('get_financial_summary', { from: p.from, to: p.to });
    let extra = '';
    if (can(ctx, 'view_sales') || can(ctx, 'view_reports')) {
      const r = await call('get_sales', { from: p.from, to: p.to, group_by: 'customer' });
      const rows = r.data.rows.filter((x) => !x._style).slice(0, 6).map((x) => `- ${x.grp}: ${K(x.net_sales)} (${x.invoices} invoice${x.invoices === 1 ? '' : 's'})`).join('\n');
      extra = rows ? `\n\nBy customer (net of VAT and credit notes):\n${rows}` : '';
      s.sources.push(...r.sources);
    }
    return { answer: `Revenue for **${p.label}** (${s.data.period.from} – ${s.data.period.to}) was **${K(s.data.revenue)}**${s.data.previous ? '' : ''}.${extra}`, sources: s.sources, used };
  }
  if (/profit|loss|p&l|p and l|income statement|how (are|is) (we|the business) doing|summary|overview|performance/.test(t)) {
    const s = await call('get_financial_summary', { from: p.from, to: p.to });
    const d = s.data;
    return { answer: `**${/prepare|report|statement/.test(t) ? 'Profit and Loss' : 'Financial summary'} — ${p.label}** (${d.period.from} – ${d.period.to})\n\n| | Amount |\n|---|---:|\n| Revenue | ${K(d.revenue)} |\n| Cost of sales | ${K(d.cost_of_sales)} |\n| **Gross profit** | **${K(d.gross_profit)}** |\n| Operating expenses | ${K(d.expenses)} |\n| **Net ${toCents(d.net_profit) >= 0n ? 'profit' : 'loss'}** | **${K(d.net_profit)}** |\n\nCash & bank: ${K(d.total_cash_and_bank)} · Receivables: ${K(d.receivables)} · Payables: ${K(d.payables)}\n\nOpen the full report: [Profit and Loss](/reports/profit-and-loss?from=${d.period.from}&to=${d.period.to}) — you can export it to PDF or Excel there.`, sources: s.sources, used };
  }
  if (/cash|bank balance|how much (money|cash)/.test(t)) {
    const s = await call('get_financial_summary', { from: p.from, to: p.to });
    return { answer: `Cash and bank balances total **${K(s.data.total_cash_and_bank)}**:\n\n${s.data.cash_and_bank.map((c) => `- ${c.account}: ${K(c.balance)}`).join('\n')}`, sources: s.sources, used };
  }
  // Fallback: search
  const words = message.replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !/^(show|find|what|which|where|when|with|from|this|that|have|were|transactions?)$/i.test(w));
  if (words.length) {
    const r = await call('search_transactions', { query: words.slice(0, 3).join(' ') });
    if (r.data.count) return { answer: `I found ${r.data.count} transaction(s) matching "${words.slice(0, 3).join(' ')}":\n\n${r.data.transactions.slice(0, 10).map((x) => `- ${x.entry_date} ${x.number}: ${x.description} — ${K(x.total)}`).join('\n')}`, sources: r.sources, used };
  }
  return { answer: 'I can answer questions using your live accounting data, for example:\n\n- "What were our sales this month?"\n- "How much do customers owe us?"\n- "Which invoices are overdue?"\n- "Show me our biggest expenses."\n- "Why did profit decrease this month?"\n- "How much did we spend on fuel?"\n- "Find duplicate transactions."\n- "Explain our cash flow."\n- "Record a K5,000 cash sale." (creates a draft for approval)', sources: [], used };
}

const SYSTEM = (ctx) => `You are ${ctx.settings?.ai?.assistant_name || 'TAEL Assistant'}, the accounting assistant inside TAEL Books for ${ctx.company?.name}, a business in Zambia.
Today is ${today()}. The currency is Zambian Kwacha; write amounts like K12,500.00.

Rules you must follow:
- Every financial figure you state MUST come from a tool result in this conversation. Never estimate, invent or "round" figures that are not in the tool output. If the tools do not return the data, say you do not have it.
- Call tools to retrieve data before answering any question about the business's numbers. Use date ranges in YYYY-MM-DD.
- When you give figures, name the period and mention which records they come from; the app shows source links automatically.
- For instructions to record a transaction, call prepare_transaction_draft. It only creates a DRAFT. Say clearly that it has NOT been posted and needs approval by an authorised user. Show the proposed debit and credit lines from the tool result.
- Never claim to have posted, edited, deleted or approved anything. You cannot change balances.
- If a tool returns a permission error, tell the user they don't have access to that information.
- For anomalies use neutral language ("requires review"); never accuse anyone of fraud.
- Tax figures are based on the rates configured in the system; suggest confirming current rates with ZRA when relevant.
- Be concise. Use short paragraphs, bullet points or small markdown tables.`;

async function withClaude(ctx, ai, history, message) {
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const messages = [...history, { role: 'user', content: message }];
  const sources = [], used = []; let draft = null, proposal = null;
  for (let step = 0; step < 6; step++) {
    const resp = await createMessage(ai, { max_tokens: 16000, system: SYSTEM(ctx), tools, messages });
    if (resp.stop_reason !== 'tool_use') {
      const answer = stopProblem(resp) || textOf(resp);
      return { answer, sources, used, draft, proposal };
    }
    // Keep the full content (including thinking blocks) so the next turn continues the same reasoning.
    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const b of resp.content.filter((x) => x.type === 'tool_use')) {
      used.push(b.name);
      try {
        const r = await runTool(ctx, b.name, b.input);
        sources.push(...(r.sources || []));
        if (r.draft) draft = r.draft;
        if (r.proposal) proposal = r.proposal;
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(r.data).slice(0, 12000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: e.expose ? e.message : 'The tool failed.' });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'I could not complete that request in a reasonable number of steps. Please try a more specific question.', sources, used, draft, proposal };
}

export async function chat(ctx, { conversationId, message }) {
  if (ctx.settings?.ai?.enabled === false) throw new AppError(403, 'The AI assistant is disabled for this company.', { code: 'AI_DISABLED' });
  const text = String(message || '').trim().slice(0, 2000);
  if (!text) throw new AppError(400, 'Type a question.', { code: 'BAD_REQUEST' });
  let convId = conversationId;
  if (convId) {
    const { rows } = await pool.query('SELECT id FROM ai_conversations WHERE id=$1 AND user_id=$2 AND company_id=$3', [convId, ctx.user.id, ctx.companyId]);
    if (!rows[0]) convId = null;
  }
  if (!convId) convId = (await pool.query(`INSERT INTO ai_conversations (company_id, user_id, title) VALUES ($1,$2,$3) RETURNING id`, [ctx.companyId, ctx.user.id, text.slice(0, 80)])).rows[0].id;
  const { rows: hist } = await pool.query(`SELECT role, content FROM ai_messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 10`, [convId]);
  await pool.query(`INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'user',$2)`, [convId, text]);

  const ai = await aiClient(ctx);
  let out, mode = 'built-in';
  if (ai) {
    try { out = await withClaude(ctx, ai, hist.reverse().map((h) => ({ role: h.role, content: h.content })), text); mode = 'claude'; } catch (e) {
      if (e?.expose) throw e;
      console.error('[ai] provider error, falling back:', e.message);
      out = await builtIn(ctx, text); out.notice = 'The AI provider was unavailable, so the built-in assistant answered.';
    }
  } else out = await builtIn(ctx, text);

  const seen = new Set();
  const sources = (out.sources || []).filter((s) => { const k = `${s.type}:${s.id}:${s.label}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
  const data = { sources, draft: out.draft || null, proposal: out.proposal || null, tools: out.used, mode, notice: out.notice || null };
  const { rows: [msg] } = await pool.query(`INSERT INTO ai_messages (conversation_id, role, content, data) VALUES ($1,'assistant',$2,$3) RETURNING id, created_at`, [convId, out.answer, JSON.stringify(data)]);
  await pool.query('UPDATE ai_conversations SET updated_at=now() WHERE id=$1', [convId]);
  await audit({ ...ctx, viaAi: true }, 'ai.chat', { entityType: 'ai_conversation', entityId: convId, newValue: { question: text.slice(0, 300), tools: out.used, mode, draft: out.draft?.number } });
  return { conversation_id: convId, message_id: msg.id, answer: out.answer, ...data };
}

export { builtIn };
