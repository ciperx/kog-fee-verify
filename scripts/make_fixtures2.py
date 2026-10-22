"""Generate recorded-transaction fixtures modelled on getTransaction jsonParsed output."""
import hashlib, json, os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures")
os.makedirs(OUT, exist_ok=True)

MINT = "KOGm3z9tY4QdRu2uKPvxAZo1z8fJcUa9bY6pWq4hN7mS"
OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
PAYEE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
OTHER_PAYEE = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
PAYEE_ATA = "3uW5p8VtJ6YhVh4uWk1oQ1zB1jK9mN2pQ4rS6tU8vW1x"
PAYER = "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5"
PAYER_ATA = "BqQ2sVd9Wm4xTb1yHc3nLp6rZk8fJg5uA7eS9tN2vD4m"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def S(name):
    """Deterministic base58 signature, 88 chars, shaped like a real ed25519 signature."""
    h = hashlib.sha256(name.encode()).digest()
    out = []
    while len(out) < 88:
        out.extend(B58[b % 58] for b in h)
        h = hashlib.sha256(h).digest()
    return "".join(out[:88])


def tx(sig, mint, pre, post, block_time=1761177600, err=None):
    return {
        "blockTime": block_time,
        "meta": {
            "err": err,
            "fee": 5000,
            "preTokenBalances": [
                {"accountIndex": i, "mint": m, "owner": o, "uiTokenAmount": {"amount": str(a), "decimals": 9}}
                for (i, m, o, a) in pre
            ],
            "postTokenBalances": [
                {"accountIndex": i, "mint": m, "owner": o, "uiTokenAmount": {"amount": str(a), "decimals": 9}}
                for (i, m, o, a) in post
            ],
        },
        "transaction": {
            "signatures": [sig],
            "message": {
                "accountKeys": [
                    {"pubkey": PAYER, "signer": True, "writable": True},
                    {"pubkey": PAYER_ATA, "signer": False, "writable": True},
                    {"pubkey": PAYEE, "signer": False, "writable": False},
                    {"pubkey": PAYEE_ATA, "signer": False, "writable": True},
                ],
                "instructions": [
                    {"program": "spl-token", "programId": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                     "parsed": {"type": "transferChecked", "info": {
                         "mint": mint, "source": PAYER_ATA, "destination": PAYEE_ATA,
                         "authority": PAYER, "tokenAmount": {"amount": "250000000", "decimals": 9}}}},
                ],
            },
        },
    }


def write(name, obj):
    with open(os.path.join(OUT, name), "w") as fh:
        json.dump(obj, fh, indent=1)
        fh.write("\n")


write("right-fee.json", tx(S("right-fee"), MINT,
                            [(0, MINT, PAYER, 900000000), (3, MINT, PAYEE, 0)],
                            [(0, MINT, PAYER, 649995000), (3, MINT, PAYEE, 250000000)]))

write("exact-fee.json", tx(S("exact-fee"), MINT,
                           [(0, MINT, PAYER, 250000000), (3, MINT, PAYEE, 0)],
                           [(0, MINT, PAYER, 0), (3, MINT, PAYEE, 250000000)]))

write("short-fee.json", tx(S("short-fee"), MINT,
                           [(0, MINT, PAYER, 900000000), (3, MINT, PAYEE, 0)],
                           [(0, MINT, PAYER, 799995000), (3, MINT, PAYEE, 100000000)]))

write("wrong-mint.json", tx(S("wrong-mint"), OTHER,
                            [(0, OTHER, PAYER, 900000000), (3, OTHER, PAYEE, 0)],
                            [(0, OTHER, PAYER, 649995000), (3, OTHER, PAYEE, 250000000)]))

write("wrong-payee.json", tx(S("wrong-payee"), MINT,
                             [(0, MINT, PAYER, 900000000), (3, MINT, OTHER_PAYEE, 0)],
                             [(0, MINT, PAYER, 649995000), (3, MINT, OTHER_PAYEE, 250000000)]))

write("expired.json", tx(S("expired"), MINT,
                         [(0, MINT, PAYER, 900000000), (3, MINT, PAYEE, 0)],
                         [(0, MINT, PAYER, 649995000), (3, MINT, PAYEE, 250000000)],
                         block_time=1761177600))

write("failed-tx.json", tx(S("failed-tx"), MINT,
                           [(0, MINT, PAYER, 900000000)],
                           [(0, MINT, PAYER, 900000000)],
                           err={"InstructionError": [0, {"Custom": 1}]}))

write("instruction-only.json", {
    "blockTime": 1761177600,
    "meta": {"err": None, "innerInstructions": []},
    "transaction": {
        "signatures": [S("instruction-only")],
        "message": {"accountKeys": [PAYER, PAYER_ATA, PAYEE, PAYEE_ATA], "instructions": [
            {"program": "spl-token", "parsed": {"type": "transferChecked", "info": {
                "mint": MINT, "source": PAYER_ATA, "destination": PAYEE_ATA, "authority": PAYER,
                "tokenAmount": {"amount": "250000000", "decimals": 9}}}}]},
    },
})

write("inner-transfer.json", {
    "blockTime": 1761177600,
    "meta": {"err": None, "preTokenBalances": [],
             "postTokenBalances": [{"accountIndex": 3, "mint": MINT, "owner": PAYEE,
                                    "uiTokenAmount": {"amount": "300000000", "decimals": 9}}],
             "innerInstructions": []},
    "transaction": {
        "signatures": [S("inner-transfer")],
        "message": {"accountKeys": [PAYER, PAYER_ATA, PAYEE, PAYEE_ATA], "instructions": [
            {"program": "spl-token", "parsed": {"type": "transferChecked", "info": {
                "mint": MINT, "source": PAYER_ATA, "destination": PAYEE_ATA, "authority": PAYER,
                "tokenAmount": {"amount": "300000000", "decimals": 9}}}}]},
    },
})

print("wrote", sorted(os.listdir(OUT)))
