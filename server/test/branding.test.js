// Logo & branding: every slot, public login branding, and logos (including SVG) embedded in invoice, receipt and report PDFs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, login, app, request, pool, accountId, today } from './helpers.js';

let admin, cid;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="#0f5c4a"/><text x="10" y="40" fill="#fff" font-size="28">TAEL</text></svg>');
const hasImage = (buf) => /\/Subtype\s*\/Image/.test(buf.toString('latin1'));
const pdf = (url) => admin.agent.get(url).buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
const upload = (slot, buf, name) => admin.agent.post(`/api/admin/branding/${slot}`).set('X-CSRF-Token', admin.csrf).attach('file', buf, name);

before(async () => { cid = (await resetDb()).id; admin = await login(); });
after(async () => { await pool.end(); });

describe('Logo & branding', () => {
  it('accepts main, light, dark and favicon uploads and serves them publicly', async () => {
    for (const slot of ['logo', 'logo_light', 'logo_dark', 'favicon']) {
      const r = await upload(slot, SVG, `${slot}.svg`);
      assert.equal(r.status, 200, `${slot}: ${JSON.stringify(r.body)}`);
      const pub = await request(app).get(`/api/public/branding/${cid}/${slot}`);
      assert.equal(pub.status, 200);
      assert.equal(pub.headers['content-type'], 'image/svg+xml');
    }
    assert.equal((await upload('banner', SVG, 'x.svg')).status, 400);
  });
  it('login page branding reports the logo and favicon', async () => {
    const r = await request(app).get('/api/auth/public-branding');
    assert.equal(r.body.has_logo, true);
    assert.equal(r.body.logo_slot, 'logo_light');
    assert.ok(r.body.favicon_version);
  });
  it('an SVG logo is converted and embedded in invoice, receipt and report PDFs', async () => {
    const cust = (await admin.post('/api/customers').send({ name: 'Logo Customer' })).body.id;
    const inv = await admin.post('/api/sales/documents').send({ doc_type: 'INVOICE', customer_id: cust, doc_date: today(), action: 'post',
      lines: [{ description: 'Svc', quantity: 1, unit_price: '100', account_id: await accountId(cid, 'SALES') }] });
    const quote = await admin.post('/api/sales/documents').send({ doc_type: 'QUOTE', customer_id: cust, doc_date: today(),
      lines: [{ description: 'Svc', quantity: 1, unit_price: '100', account_id: await accountId(cid, 'SALES') }] });
    const rct = await admin.post('/api/payments').send({ direction: 'IN', payment_date: today(), customer_id: cust, amount: '100', bank_account_id: await accountId(cid, 'BANK'), allocations: [{ document_id: inv.body.id, amount: '100' }] });
    for (const url of [`/api/sales/documents/${inv.body.id}/pdf`, `/api/sales/documents/${quote.body.id}/pdf`, `/api/payments/${rct.body.id}/pdf`, '/api/reports/profit-and-loss?format=pdf']) {
      const r = await pdf(url);
      assert.equal(r.status, 200, url);
      assert.equal(r.headers['content-type'], 'application/pdf');
      assert.ok(hasImage(r.body), `${url} should contain the logo image`);
    }
  });
  it('PDFs fall back to the company name when the logo is removed or hidden', async () => {
    await admin.del('/api/admin/branding/logo'); await admin.del('/api/admin/branding/logo_light');
    const r = await pdf('/api/reports/profit-and-loss?format=pdf');
    assert.equal(r.status, 200);
    assert.ok(!hasImage(r.body));
  });
});
