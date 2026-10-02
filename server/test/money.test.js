import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, fromCents, percentOf, mulRound, formatK } from '../src/lib/money.js';
import { splitInclusive } from '../src/services/tax.js';
import { parseDate, parseCsv, detectColumns } from '../src/services/banking.js';
import { parseReceiptText } from '../src/ai/extract.js';
import { parsePeriod } from '../src/ai/assistant.js';

describe('money arithmetic (no floating point)', () => {
  it('parses amounts exactly', () => {
    assert.equal(toCents('1,234.56'), 123456n);
    assert.equal(toCents('K 99.995'), 10000n);
    assert.equal(toCents(0.1), 10n);
    assert.equal(fromCents(toCents('0.1') + toCents('0.2')), '0.30');
    assert.throws(() => toCents('abc'));
  });
  it('rounds percentages half-up to the ngwee', () => {
    assert.equal(percentOf('3000.30', '16'), 48005n);
    assert.equal(percentOf('224.98', '16.0000'), 3600n);
    assert.equal(mulRound('99.99', '2.5'), 24998n);
  });
  it('splits tax-inclusive totals', () => {
    assert.deepEqual(splitInclusive('1160.00', '16'), { net: 100000n, tax: 16000n });
    const s = splitInclusive('100.00', '16');
    assert.equal(s.net + s.tax, 10000n);
  });
  it('formats Kwacha', () => { assert.equal(formatK('1234567.5'), 'K1,234,567.50'); assert.equal(formatK('-12'), '-K12.00'); });
});

describe('statement parsing', () => {
  it('reads Zambian date formats', () => {
    assert.equal(parseDate('05/03/2026'), '2026-03-05');
    assert.equal(parseDate('2026-03-05'), '2026-03-05');
    assert.equal(parseDate('5 Mar 2026'), '2026-03-05');
    assert.equal(parseDate('31/02/2026'), null);
  });
  it('parses quoted CSV and detects columns', () => {
    const rows = parseCsv('Date,Narration,Debit,Credit,Balance\n01/09/2026,"Transfer, ref 1",,"1,000.00",5000\n');
    assert.equal(rows[1][1], 'Transfer, ref 1');
    const c = detectColumns(rows[0]);
    assert.equal(c.debit, 2); assert.equal(c.credit, 3); assert.equal(c.description, 1);
  });
});

describe('AI helpers', () => {
  it('reads receipts conservatively', () => {
    const x = parseReceiptText('PUMA ENERGY CAIRO RD\nTPIN 1001234567\nDate: 12/09/2026\nReceipt No: R-5531\nDiesel 25L\nVAT 16% 66.21\nTOTAL K 480.00\nCash');
    assert.equal(x.total, '480.00'); assert.equal(x.date, '2026-09-12'); assert.equal(x.tpin, '1001234567'); assert.equal(x.payment_method, 'cash');
  });
  it('understands periods', () => {
    assert.equal(parsePeriod('sales last month').label, 'last month');
    assert.equal(parsePeriod('profit this year').from.slice(5), '01-01');
  });
});
