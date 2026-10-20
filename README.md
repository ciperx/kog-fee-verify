# kog-fee-verify

A pure verifier for an x402 fee paid in a Token 2022 mint on Solana. The parsed transaction and the
quote are passed in, so there is no RPC, no clock and no network inside the check: the same input
always gives the same verdict, which is what makes it testable on recorded fixtures.

```ts
import { verifyKogFee } from "@ciperx/kog-fee-verify";

const { ok, reason } = verifyKogFee({ tx, quote, payee, mint, seen });
```

## What is checked, in this order

1. The transaction carries a non empty signature.
2. The signature is not in `seen` (replay). `seen` is read, never written: the caller records the
   signature after it accepts the payment.
3. The quote has an expiry and the transaction has a block time; `blockTime > expiresAt` is
   `quote expired`. A payment in the same second as the expiry is inside the quote.
4. The transaction moves the quoted mint to the payee. A transfer to somebody else says so, and a
   transfer of another mint says `wrong mint`.
5. The sum of the transfers of that mint to the payee is at least `quote.amount`, an atomic integer
   string. A short fee reports both numbers.

A transfer is read from `transferChecked` or `transfer` parsed instructions, whether they sit in
`tx.instructions`, in `transaction.message.instructions` or in `meta.innerInstructions`, so a
`jsonParsed` transaction straight from `getTransaction` works without reshaping.

Malformed input answers a reason instead of throwing.

## CLI

```sh
node dist/cli.js --tx fixtures/t22-transfer.json --quote quote.json --payee <address> --mint <mint> [--seen seen.json]
```

Exit 0 when the fee verifies, 1 when it does not, 2 on wrong usage. It prints the verdict as JSON.

## Tests

```sh
npm test
```

8 tests over a recorded Token 2022 transfer (`fixtures/t22-transfer.json`, a live `transferChecked`
of a six decimal mint): the right fee, a short fee, the wrong mint, the wrong payee, an expired
quote plus the same second edge, a replay with `seen` left untouched, malformed input, and a raw
`jsonParsed` transaction whose transfer sits in the inner instructions.
