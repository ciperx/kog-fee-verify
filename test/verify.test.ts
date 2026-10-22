import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyKogFee, expirySeconds } from '../src/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, '..', 'fixtures', name), 'utf8'));

const MINT = 'KOGm3z9tY4QdRu2uKPvxAZo1z8fJcUa9bY6pWq4hN7mS';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAYEE = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const QUOTE = { mint: MINT, amount: '250000000', expiresAt: '2026-10-22T22:40:00Z' };

const call = (tx: unknown, quote: any = QUOTE, extra: any = {}) =>
  verifyKogFee({ tx, quote, payee: PAYEE, mint: quote.mint, ...extra });

test('right fee: exact quoted amount reaches the payee', () => {
  const r = call(fixture('right-fee.json'));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.code, 'ok');
  assert.equal(r.received, '250000000');
  assert.equal(r.quoted, '250000000');
  assert.match(r.reason, /250000000/);
});

test('exact fee: whole balance spent, no change output', () => {
  const r = call(fixture('exact-fee.json'));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.received, '250000000');
});

test('short fee: 100000000 paid against a 250000000 quote', () => {
  const r = call(fixture('short-fee.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'short_fee');
  assert.equal(r.received, '100000000');
  assert.match(r.reason, /100000000/);
});

test('overpayment above the quote is accepted', () => {
  const r = call(fixture('right-fee.json'), { ...QUOTE, amount: '1' });
  assert.equal(r.ok, true, r.reason);
});

test('wrong mint: USDC paid where the quote asks for KOG', () => {
  const r = call(fixture('wrong-mint.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'wrong_mint');
  assert.match(r.reason, new RegExp(USDC));
  assert.equal(r.received, null);
});

test('wrong payee: tokens moved, but not to the quoted payee', () => {
  const r = call(fixture('wrong-payee.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'wrong_payee');
});

test('expired quote: payment landed after the quote expiry', () => {
  const r = call(fixture('expired.json'), { ...QUOTE, expiresAt: '2025-10-22T21:00:00Z' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'expired');
  assert.match(r.reason, /expired/);
});

test('quote still valid at block time is accepted', () => {
  const r = call(fixture('expired.json'), { ...QUOTE, expiresAt: '2026-10-23T00:00:00Z' });
  assert.equal(r.ok, true, r.reason);
});

test('replay: the second presentation of the same signature is refused', () => {
  const seen = new Set<string>();
  const tx = fixture('right-fee.json');
  const first = call(tx, QUOTE, { seen });
  assert.equal(first.ok, true, first.reason);
  const second = call(tx, QUOTE, { seen });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'replay');
  assert.equal(seen.size, 1);
});

test('replay guard also works with an array store', () => {
  const seen: string[] = [];
  const tx = fixture('right-fee.json');
  assert.equal(call(tx, QUOTE, { seen }).ok, true);
  assert.equal(call(tx, QUOTE, { seen }).code, 'replay');
  assert.equal(seen.length, 1);
});

test('failed on chain: no fee counts even if balances look right', () => {
  const r = call(fixture('failed-tx.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'failed');
});

test('transaction as JSON text is accepted', () => {
  const text = JSON.stringify(fixture('right-fee.json'));
  const r = call(text);
  assert.equal(r.ok, true, r.reason);
});

test('malformed: broken JSON text', () => {
  const r = call('{"transaction":');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed');
});

test('malformed: no signature', () => {
  const tx = fixture('right-fee.json');
  tx.transaction.signatures = [];
  const r = call(tx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed');
});

test('malformed: quote amount that is not a decimal integer', () => {
  const r = call(fixture('right-fee.json'), { ...QUOTE, amount: '2.5' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed');
});

test('malformed: missing payee', () => {
  const r = verifyKogFee({ tx: fixture('right-fee.json'), quote: QUOTE, payee: '', mint: MINT });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'malformed');
});

test('numeric quote amount is compared as base units', () => {
  const r = call(fixture('right-fee.json'), { ...QUOTE, amount: 250000000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.quoted, '250000000');
});

test('instruction-only fixture: payee named by its token account', () => {
  const tx = fixture('instruction-only.json');
  const r = verifyKogFee({ tx, quote: QUOTE, payee: '3uW5p8VtJ6YhVh4uWk1oQ1zB1jK9mN2pQ4rS6tU8vW1x', mint: MINT });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.received, '250000000');
});

test('inner transfer with no pre-balance metadata still verifies', () => {
  const r = call(fixture('inner-transfer.json'));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.received, '300000000');
});

test('deterministic: the same bytes give the same verdict', () => {
  const tx = fixture('right-fee.json');
  const a = call(tx);
  const b = call(tx);
  assert.deepEqual(a, b);
});

test('a quote without expiry never expires', () => {
  const r = call(fixture('right-fee.json'), { mint: MINT, amount: '250000000' });
  assert.equal(r.ok, true, r.reason);
});

test('expirySeconds accepts unix seconds, milliseconds and ISO', () => {
  assert.equal(expirySeconds(1761177600), 1761177600);
  assert.equal(expirySeconds('1761177600'), 1761177600);
  assert.equal(expirySeconds(1761177600000), 1761177600);
  assert.equal(expirySeconds('2026-10-22T22:40:00Z'), 1792708800);
  assert.equal(expirySeconds(undefined), null);
  assert.equal(expirySeconds('not a date'), null);
});

test('no network and no RPC: verification is a pure function of the input', () => {
  const source = readFileSync(join(here, '..', 'src', 'verify.ts'), 'utf8');
  for (const bad of ['fetch(', 'http://', 'https://', 'Math.random', 'Date.now', 'console.log']) {
    assert.equal(source.includes(bad), false, `src/verify.ts must not contain ${bad}`);
  }
});
