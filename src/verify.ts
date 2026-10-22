/**
 * verifyKogFee - pure verification of an x402 KOG fee payment on Solana.
 *
 * No RPC, no network, no clock: the parsed transaction is passed in by the
 * caller, together with the quote it was supposed to satisfy and the set of
 * signatures already spent. The verifier decides, from those bytes only,
 * whether the fee was really paid.
 *
 * Checks, in order:
 *   1. the transaction is well formed and has a signature;
 *   2. it did not fail on chain (meta.err);
 *   3. the fee moved the quoted mint (Token 2022 or legacy SPL token);
 *   4. the payee actually received at least the quoted amount;
 *   5. the quote had not expired at the transaction's block time;
 *   6. the signature has not been used before (replay protection).
 *
 * Amounts are compared as bigint base units, never as floats.
 */

export interface Quote {
  /** SPL Token 2022 (or legacy SPL) mint address, base58. */
  mint: string;
  /** Amount in base units, as a decimal integer string. */
  amount: string | number | bigint;
  /** ISO 8601 string or unix seconds. Absent means the quote never expires. */
  expiresAt?: string | number;
  /** Optional payee carried by the quote itself. Informational. */
  payee?: string;
}

export interface VerifyInput {
  /** Parsed transaction, as returned by getTransaction with jsonParsed, or its JSON text. */
  tx: unknown;
  quote: Quote;
  /** The address that must end up with the tokens (owner or token account). */
  payee: string;
  /** The mint the quote is denominated in. Defaults to quote.mint. */
  mint?: string;
  /** Signatures already accepted. A Set/array/Map is mutated on success. */
  seen?: Set<string> | string[] | Map<string, unknown>;
  /** Unix seconds used when the transaction carries no blockTime. Optional. */
  now?: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Short machine-friendly code: ok, malformed, failed, wrong_mint, ... */
  code: string;
  /** Human readable explanation, always non-empty. */
  reason: string;
  signature: string | null;
  /** Amount received by the payee in base units, as a decimal string. */
  received: string | null;
  quoted: string | null;
}

type Rec = Record<string, any>;

function rec(v: unknown): Rec | null {
  return v !== null && typeof v === 'object' ? (v as Rec) : null;
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function big(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) ? BigInt(v) : null;
  }
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) {
    try {
      return BigInt(v.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Expiry as unix seconds. ISO strings and numeric strings are both accepted. */
export function expirySeconds(expiresAt: unknown): number | null {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null;
  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt)) return null;
    return expiresAt > 1e11 ? Math.floor(expiresAt / 1000) : Math.floor(expiresAt);
  }
  const text = String(expiresAt).trim();
  if (/^[0-9]+$/.test(text)) {
    const n = Number(text);
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

interface Delta {
  mint: string;
  owner: string | null;
  /** Token account address, when the transaction names it. */
  account: string | null;
  amount: bigint;
}

function accountAddresses(msg: Rec | null): string[] {
  return arr(msg?.accountKeys).map((k) =>
    typeof k === 'string' ? k : String(rec(k)?.pubkey ?? ''),
  );
}

function collectDeltas(tx: Rec, msg: Rec | null, meta: Rec | null): Delta[] {
  const deltas: Delta[] = [];
  const pre = arr(meta?.preTokenBalances);
  const post = arr(meta?.postTokenBalances);
  const preByIndex = new Map<string, bigint>();
  for (const b of pre) {
    const idx = String(b?.accountIndex);
    const amount = big(rec(b?.uiTokenAmount)?.amount);
    if (amount !== null) preByIndex.set(idx, amount);
  }
  const keys = accountAddresses(msg);
  for (const b of post) {
    const idx = String(b?.accountIndex);
    const mint = typeof b?.mint === 'string' ? b.mint : '';
    const amount = big(rec(b?.uiTokenAmount)?.amount);
    if (!mint || amount === null) continue;
    const before = preByIndex.get(idx) ?? 0n;
    const delta = amount - before;
    if (delta === 0n) continue;
    deltas.push({
      mint,
      owner: typeof b?.owner === 'string' ? b.owner : null,
      account: keys[Number(idx)] ?? null,
      amount: delta,
    });
  }
  return deltas;
}

/**
 * Fallback for fixtures without balance metadata: read parsed SPL token
 * instructions (transfer and transferChecked) from the message and its inner
 * instructions.
 */
function collectInstructions(tx: Rec, msg: Rec | null, meta: Rec | null): Delta[] {
  const groups: any[][] = [
    arr(msg?.instructions),
    ...arr(meta?.innerInstructions).map((g) => arr(rec(g)?.instructions)),
  ];
  const keys = accountAddresses(msg);
  const out: Delta[] = [];
  for (const group of groups) {
    for (const ix of group) {
      const r = rec(ix);
      if (!r) continue;
      const parsed = rec(r.parsed);
      const program = String(r.program ?? parsed?.program ?? '');
      if (!/spl-token/.test(program)) continue;
      const info = rec(parsed?.info);
      if (!info) continue;
      const type = String(parsed?.type ?? info.type ?? '');
      if (type !== 'transfer' && type !== 'transferChecked') continue;
      const amount = big(rec(info.tokenAmount)?.amount ?? info.amount);
      if (amount === null || amount <= 0n) continue;
      const mint = typeof info.mint === 'string' ? info.mint : '';
      const destination = typeof info.destination === 'string' ? info.destination : null;
      const authority =
        typeof info.authority === 'string'
          ? info.authority
          : typeof info.owner === 'string'
            ? info.owner
            : null;
      out.push({ mint, owner: authority, account: destination, amount });
    }
  }
  void keys;
  return out;
}

function fail(code: string, reason: string, signature: string | null, quoted: string | null): VerifyResult {
  return { ok: false, code, reason, signature, received: null, quoted };
}

function seenHas(seen: VerifyInput['seen'], signature: string): boolean {
  if (!seen) return false;
  if (seen instanceof Set) return seen.has(signature);
  if (seen instanceof Map) return seen.has(signature);
  if (Array.isArray(seen)) return seen.includes(signature);
  return false;
}

function seenAdd(seen: VerifyInput['seen'], signature: string): void {
  if (!seen) return;
  if (seen instanceof Set) seen.add(signature);
  else if (seen instanceof Map) seen.set(signature, true);
  else if (Array.isArray(seen)) seen.push(signature);
}

export function verifyKogFee(input: VerifyInput): VerifyResult {
  const quoted = big(input?.quote?.amount);
  const quotedText = quoted === null ? null : quoted.toString();
  let tx: Rec | null = null;
  try {
    tx = typeof input?.tx === 'string' ? rec(JSON.parse(input.tx)) : rec(input?.tx);
  } catch {
    return fail('malformed', 'transaction is not valid JSON', null, quotedText);
  }
  if (!tx) return fail('malformed', 'transaction is missing or not an object', null, quotedText);

  const transaction = rec(tx.transaction);
  const msg = rec(transaction?.message);
  const meta = rec(tx.meta);
  const signatures = arr(transaction?.signatures)
    .map((s) => String(s))
    .filter((s) => s.length > 0);
  const signature = signatures[0] ?? (typeof tx.signature === 'string' ? tx.signature : null);
  if (!signature) return fail('malformed', 'transaction carries no signature', null, quotedText);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(signature)) {
    return fail('malformed', 'signature is not base58', signature, quotedText);
  }

  const payee = typeof input?.payee === 'string' ? input.payee.trim() : '';
  const mint = (typeof input?.mint === 'string' && input.mint.trim()) || String(input?.quote?.mint ?? '').trim();
  if (!payee) return fail('malformed', 'payee is required', signature, quotedText);
  if (!mint) return fail('malformed', 'quote mint is required', signature, quotedText);
  if (quoted === null || quoted < 0n) {
    return fail('malformed', 'quote amount is not a decimal integer', signature, quotedText);
  }

  const err = meta?.err ?? tx.err ?? null;
  if (err !== null && err !== undefined) {
    return fail('failed', 'transaction failed on chain, no fee was paid', signature, quotedText);
  }

  const deltas = collectDeltas(tx, msg, meta);
  const instructions = collectInstructions(tx, msg, meta);

  // Amount credited to the payee in the quoted mint.
  let received = 0n;
  for (const d of deltas) {
    if (d.mint !== mint) continue;
    if (d.owner !== payee && d.account !== payee) continue;
    if (d.amount > 0n) received += d.amount;
  }

  // Fixtures without balance metadata: trust a matching parsed transfer.
  if (received === 0n) {
    for (const d of instructions) {
      if (d.mint !== mint) continue;
      if (d.account !== payee && d.owner !== payee) continue;
      received += d.amount;
    }
  }

  if (received === 0n) {
    const otherMints = new Set<string>();
    for (const d of deltas) {
      if (d.amount > 0n && (d.owner === payee || d.account === payee) && d.mint) otherMints.add(d.mint);
    }
    for (const d of instructions) {
      if (d.amount > 0n && (d.owner === payee || d.account === payee) && d.mint) otherMints.add(d.mint);
    }
    if (otherMints.size > 0) {
      const got = [...otherMints].join(', ');
      return fail('wrong_mint', `payee received ${got} but the quote is in ${mint}`, signature, quotedText);
    }
    return fail('wrong_payee', `no transfer of ${mint} reached payee ${payee}`, signature, quotedText);
  }

  if (received < quoted) {
    return {
      ok: false,
      code: 'short_fee',
      reason: `payee received ${received.toString()} base units, the quote asks for ${quoted.toString()}`,
      signature,
      received: received.toString(),
      quoted: quotedText,
    };
  }

  const blockTime = big(tx.blockTime) ?? null;
  const at = blockTime !== null ? Number(blockTime) : typeof input?.now === 'number' ? Math.floor(input.now) : null;
  const expires = expirySeconds(input?.quote?.expiresAt);
  if (expires !== null && at !== null && at >= expires) {
    return {
      ok: false,
      code: 'expired',
      reason: `quote expired at ${expires} but the payment landed at ${at}`,
      signature,
      received: received.toString(),
      quoted: quotedText,
    };
  }

  if (seenHas(input?.seen, signature)) {
    return {
      ok: false,
      code: 'replay',
      reason: `signature ${signature.slice(0, 8)} was already used for a fee`,
      signature,
      received: received.toString(),
      quoted: quotedText,
    };
  }
  seenAdd(input?.seen, signature);

  return {
    ok: true,
    code: 'ok',
    reason: `fee paid: ${received.toString()} base units of ${mint} to ${payee.slice(0, 8)}`,
    signature,
    received: received.toString(),
    quoted: quotedText,
  };
}

export default verifyKogFee;
