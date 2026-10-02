// Exercises the Claude tool-use loop against a local mock of the Messages API (no real key needed).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let srv, pool, chat, buildContext, calls = [];
before(async () => {
  srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const body = JSON.parse(b); calls.push(body);
      const last = body.messages[body.messages.length - 1];
      let out;
      if (typeof last.content === 'string' && last.content.includes('REFUSE')) out = { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } };
      else if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        const data = JSON.parse(last.content[0].content);
        out = { content: [{ type: 'text', text: `Customers owe K${data.totals.total}.` }], stop_reason: 'end_turn' };
      } else out = { content: [{ type: 'tool_use', id: 'tu_1', name: 'get_receivables', input: {} }], stop_reason: 'tool_use' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, usage: { input_tokens: 1, output_tokens: 1 }, ...out }));
    });
  });
  await new Promise((r) => srv.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const helpers = await import('./helpers.js');
  await helpers.resetDb();
  ({ pool } = helpers);
  ({ chat } = await import('../src/ai/assistant.js'));
  ({ buildContext } = await import('../src/middleware/auth.js'));
});
after(async () => { srv.close(); await pool.end(); });

describe('Claude provider (mocked)', () => {
  it('runs tools against the database and answers from their results', async () => {
    const { rows: [u] } = await pool.query(`SELECT id, email, name, is_super_admin FROM users WHERE is_super_admin LIMIT 1`);
    const { rows: [c] } = await pool.query(`SELECT id FROM companies ORDER BY id LIMIT 1`);
    const ctx = await buildContext({ user: u, companyId: c.id, ip: '127.0.0.1', userAgent: 'test' });
    const r = await chat(ctx, { message: 'How much do customers owe us?' });
    assert.equal(r.mode, 'claude');
    assert.deepEqual(r.tools, ['get_receivables']);
    assert.match(r.answer, /^Customers owe K\d+\.\d{2}\.$/);
    assert.ok(calls[0].system.includes('MUST come from a tool result'));
    assert.ok(calls[0].tools.some((t) => t.name === 'prepare_transaction_draft'));
    assert.equal(calls[0].model, 'claude-opus-5-5');
    assert.equal(calls[0].fallbacks, 'default');
    assert.equal(calls[0].output_config.effort, 'medium');
    assert.ok(calls[0].max_tokens >= 16000);
    // the assistant turn (with its tool_use block) is sent back unchanged before the tool result
    assert.equal(calls[1].messages.at(-2).content[0].type, 'tool_use');
  });
  it('turns a refusal into a clear message instead of an empty answer', async () => {
    const { rows: [u] } = await pool.query(`SELECT id, email, name, is_super_admin FROM users WHERE is_super_admin LIMIT 1`);
    const { rows: [c] } = await pool.query(`SELECT id FROM companies ORDER BY id LIMIT 1`);
    const ctx = await buildContext({ user: u, companyId: c.id, ip: '127.0.0.1', userAgent: 'test' });
    const r = await chat(ctx, { message: 'REFUSE this' });
    assert.match(r.answer, /declined/);
  });
});
