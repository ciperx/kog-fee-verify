#!/usr/bin/env node
/** Verify one recorded transaction against one quote, from files, with no network. */
import { readFileSync } from "node:fs";
import { verifyKogFee } from "./verify.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

try {
  const txPath = flag("tx");
  const quotePath = flag("quote");
  const payee = flag("payee");
  const mint = flag("mint");
  const seenPath = flag("seen");
  if (!txPath || !quotePath || !payee || !mint) {
    console.error("usage: verify --tx <transaction.json> --quote <quote.json> --payee <address> --mint <mint> [--seen <signatures.json>]");
    process.exit(2);
  }
  const tx = JSON.parse(readFileSync(txPath, "utf8"));
  const quote = JSON.parse(readFileSync(quotePath, "utf8"));
  const seen: string[] = seenPath ? JSON.parse(readFileSync(seenPath, "utf8")) : [];
  const verdict = verifyKogFee({ tx, quote, payee, mint, seen });
  console.log(JSON.stringify(verdict));
  process.exit(verdict.ok ? 0 : 1);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
