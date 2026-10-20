/**
 * A pure verifier for an x402 fee paid in a Token 2022 mint on Solana.
 * The parsed transaction is passed in: no RPC, no clock, no network.
 */

export interface TokenAmount {
  amount: string;
  decimals?: number;
  uiAmountString?: string;
}

export interface ParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, any> };
}

export interface TransactionLike {
  signature?: string;
  blockTime?: number | null;
  instructions?: ParsedInstruction[];
  transaction?: { message?: { instructions?: ParsedInstruction[] } };
  meta?: { innerInstructions?: { instructions?: ParsedInstruction[] }[] | null };
}

export interface Quote {
  amount: string | number | bigint;
  expiresAt: number;
  id?: string;
}

export interface VerifyInput {
  tx: TransactionLike;
  quote: Quote;
  payee: string;
  mint: string;
  seen?: Set<string> | string[];
}

export interface Verdict {
  ok: boolean;
  reason: string;
}

function instructionsOf(tx: TransactionLike): ParsedInstruction[] {
  const out: ParsedInstruction[] = [];
  if (Array.isArray(tx?.instructions)) out.push(...tx.instructions);
  const message = tx?.transaction?.message?.instructions;
  if (Array.isArray(message)) out.push(...message);
  const inner = tx?.meta?.innerInstructions;
  if (Array.isArray(inner)) for (const group of inner) if (Array.isArray(group?.instructions)) out.push(...group.instructions);
  return out;
}

function transfersOf(tx: TransactionLike): { mint: string; destination: string; amount: string }[] {
  const transfers = [];
  for (const instruction of instructionsOf(tx)) {
    const parsed = instruction?.parsed;
    if (!parsed || typeof parsed !== "object") continue;
    if (parsed.type !== "transferChecked" && parsed.type !== "transfer") continue;
    const info = parsed.info ?? {};
    const mint = typeof info.mint === "string" ? info.mint : "";
    const destination = typeof info.destination === "string" ? info.destination : "";
    const amount = info.tokenAmount?.amount ?? info.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) continue;
    transfers.push({ mint, destination, amount });
  }
  return transfers;
}

function atomic(value: string | number | bigint): bigint {
  const text = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error("quote.amount must be an atomic integer string");
  return BigInt(text);
}

/**
 * Verify that one transaction pays at least the quoted fee, in the quoted mint, to the payee,
 * before the quote expires, and that its signature has not been used before.
 * `seen` is read, never written: the caller records the signature after it accepts the payment.
 */
export function verifyKogFee(input: VerifyInput): Verdict {
  const { tx, quote, payee, mint } = input ?? ({} as VerifyInput);
  if (!tx || typeof tx !== "object") return { ok: false, reason: "no transaction" };
  const signature = typeof tx.signature === "string" ? tx.signature.trim() : "";
  if (!signature) return { ok: false, reason: "the transaction carries no signature" };

  const seen = input.seen instanceof Set ? input.seen : new Set(input.seen ?? []);
  if (seen.has(signature)) return { ok: false, reason: "signature already used" };

  if (!quote || quote.expiresAt === undefined) return { ok: false, reason: "the quote has no expiry" };
  const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;
  if (blockTime === null) return { ok: false, reason: "the transaction carries no block time" };
  if (blockTime > quote.expiresAt) return { ok: false, reason: "quote expired" };

  const transfers = transfersOf(tx);
  if (transfers.length === 0) return { ok: false, reason: "no token transfer in this transaction" };

  const toPayee = transfers.filter((t) => t.destination === payee);
  if (toPayee.length === 0) return { ok: false, reason: "no transfer to the payee in this transaction" };

  const rightMint = toPayee.filter((t) => t.mint === mint);
  if (rightMint.length === 0) return { ok: false, reason: "wrong mint" };

  let required: bigint;
  try {
    required = atomic(quote.amount);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }

  let paid = 0n;
  for (const transfer of rightMint) paid += BigInt(transfer.amount);
  if (paid < required) return { ok: false, reason: `fee is below the quote: paid ${paid} of ${required}` };

  return { ok: true, reason: "paid" };
}
