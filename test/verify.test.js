import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyKogFee } from "../dist/verify.js";

const recorded = JSON.parse(readFileSync(new URL("../fixtures/t22-transfer.json", import.meta.url), "utf8"));
const info = recorded.instructions[0].parsed.info;
const MINT = info.mint;
const PAYEE = info.destination;
const PAID = info.tokenAmount.amount;
const BLOCK_TIME = recorded.blockTime;

function quote(overrides = {}) {
  return { amount: PAID, expiresAt: BLOCK_TIME + 60, id: "q1", ...overrides };
}

test("A1 the right fee in the right mint to the payee is accepted", () => {
  const verdict = verifyKogFee({ tx: recorded, quote: quote(), payee: PAYEE, mint: MINT });
  assert.deepEqual(verdict, { ok: true, reason: "paid" });
});

test("A2 a fee below the quote is refused with both numbers", () => {
  const verdict = verifyKogFee({ tx: recorded, quote: quote({ amount: String(Number(PAID) + 1) }), payee: PAYEE, mint: MINT });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /below the quote/);
  assert.match(verdict.reason, new RegExp(PAID));
});

test("A3 the wrong mint is refused even when the amount and the payee match", () => {
  const verdict = verifyKogFee({ tx: recorded, quote: quote(), payee: PAYEE, mint: "SomeOtherMint111111111111111111111111111111" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "wrong mint");
});

test("A4 a transfer to somebody else is refused", () => {
  const verdict = verifyKogFee({ tx: recorded, quote: quote(), payee: "SomeOtherWallet11111111111111111111111111111", mint: MINT });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no transfer to the payee/);
});

test("A5 an expired quote is refused, and the block time is the clock", () => {
  const verdict = verifyKogFee({ tx: recorded, quote: quote({ expiresAt: BLOCK_TIME - 1 }), payee: PAYEE, mint: MINT });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "quote expired");

  const edge = verifyKogFee({ tx: recorded, quote: quote({ expiresAt: BLOCK_TIME }), payee: PAYEE, mint: MINT });
  assert.equal(edge.ok, true, "a payment in the same second as the expiry is still inside the quote");
});

test("A6 a replayed signature is refused and seen is not mutated", () => {
  const seen = new Set([recorded.signature]);
  const verdict = verifyKogFee({ tx: recorded, quote: quote(), payee: PAYEE, mint: MINT, seen });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "signature already used");
  assert.equal(seen.size, 1);

  const fresh = [];
  assert.equal(verifyKogFee({ tx: recorded, quote: quote(), payee: PAYEE, mint: MINT, seen: fresh }).ok, true);
  assert.equal(fresh.length, 0);
});

test("A7 malformed input answers a reason instead of throwing", () => {
  assert.deepEqual(verifyKogFee({ tx: {}, quote: quote(), payee: PAYEE, mint: MINT }), { ok: false, reason: "the transaction carries no signature" });
  assert.equal(verifyKogFee({ tx: { signature: "s", blockTime: BLOCK_TIME, instructions: [] }, quote: quote(), payee: PAYEE, mint: MINT }).reason, "no token transfer in this transaction");
  assert.equal(verifyKogFee({ tx: { signature: "s", instructions: [] }, quote: quote(), payee: PAYEE, mint: MINT }).reason, "the transaction carries no block time");
  assert.equal(verifyKogFee({ tx: recorded, quote: quote({ amount: "12.5" }), payee: PAYEE, mint: MINT }).reason, "quote.amount must be an atomic integer string");
  const noExpiry = verifyKogFee({ tx: recorded, quote: { amount: PAID }, payee: PAYEE, mint: MINT });
  assert.equal(noExpiry.reason, "the quote has no expiry");
});

test("A8 a raw jsonParsed transaction with inner instructions verifies the same way", () => {
  const raw = {
    transaction: { message: { instructions: [{ program: "compute-budget", parsed: { type: "setComputeUnitLimit", info: {} } }] } },
    meta: { innerInstructions: [{ instructions: recorded.instructions }] },
    blockTime: BLOCK_TIME,
  };
  // the signature sits on the top level of the transaction, not inside meta
  const withSignature = { ...raw, signature: recorded.signature };
  assert.equal(verifyKogFee({ tx: withSignature, quote: quote(), payee: PAYEE, mint: MINT }).ok, true);
  const without = verifyKogFee({ tx: raw, quote: quote(), payee: PAYEE, mint: MINT });
  assert.equal(without.ok, false);
});
