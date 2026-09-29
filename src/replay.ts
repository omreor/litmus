import { utils } from "@coral-xyz/anchor";
import { DBC_PROGRAM_ID, decodeDbcTx, type DbcTx } from "./dbc";
import { applyEvidence, resetEvidence } from "./evidence";
import { judgePool } from "./integrity";
import { db } from "./store";

// History replay over Solami RPC: rebuilds a graduated pool's evidence from its own transactions.
//   full:     every transaction of the pool (the contested candidates: no rule fired, no evidence yet)
//   creation: only the creation slot (creator and bundle fill, same-slot completion) for all graduations
// Solami serves getTransaction for roughly the last 60 days (older requests time out after 40 s), so
// only pools created inside that window are attempted. Resumable: `replays` records every attempt.
// Usage: bun src/replay.ts full|creation [days=58] [limit]

const bs58 = utils.bytes.bs58;
const SOLAMI_RPC = `https://rpc.solami.dev/sol?api_key=${process.env.SOLAMI_API_KEY}`;
const MAX_TXS = 30_000;
// Requests per second, under Solami Pro's 200 to leave room for the server. Latency grows with age
// (0.3 s for last week's transactions, ~12 s at 60 days) and Solami's archive rejects too many
// simultaneous queries ("Code: 202"), so requests are both paced and capped in flight.
const RATE = Number(process.env.REPLAY_RATE ?? 150);
const MAX_IN_FLIGHT = Number(process.env.REPLAY_IN_FLIGHT ?? 6);
const POOLS_AT_ONCE = 32;
const BATCH = 10; // Solami's JSON-RPC batch limit
const ATTEMPTS = 5;

const redact = (s: string) => s.replace(/api_key=[^&\s"]+/g, "api_key=***");

let nextSlot = 0;
async function pace(requests: number) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + (requests * 1000) / RATE;
  if (at > now) await Bun.sleep(at - now);
}

let inFlight = 0;
let retried = 0;
const waiting: (() => void)[] = [];

type Call = { method: string; params: unknown[] };
type Reply = { result?: unknown; error?: { message: string } };
async function post(calls: Call[]): Promise<Reply[]> {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    await pace(calls.length);
    const res = await fetch(SOLAMI_RPC, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, ...c }))),
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    const replies = (await res.json()) as (Reply & { id: number })[];
    return calls.map((_, i) => replies.find((r) => r.id === i) ?? { error: { message: "no reply" } });
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

// Batched calls; failed ones are retried (as smaller batches) up to 3 times.
async function rpcMany<T>(calls: Call[]): Promise<T[]> {
  const out = new Array<T>(calls.length);
  let pending = calls.map((_, i) => i);
  for (let attempt = 1; pending.length; attempt++) {
    const failed: number[] = [];
    let lastError = "";
    const chunks: number[][] = [];
    for (let i = 0; i < pending.length; i += BATCH) chunks.push(pending.slice(i, i + BATCH));
    await Promise.all(chunks.map(async (chunk) => {
      try {
        const replies = await post(chunk.map((i) => calls[i]));
        replies.forEach((r, j) => (r.error ? (failed.push(chunk[j]), (lastError = r.error.message)) : (out[chunk[j]] = r.result as T)));
      } catch (e) {
        failed.push(...chunk);
        lastError = String(e instanceof Error ? e.message : e);
      }
    }));
    if (failed.length && attempt === ATTEMPTS) throw new Error(`${calls[failed[0]].method}: ${redact(lastError)}`);
    retried += failed.length;
    if (failed.length) await Bun.sleep(2000 * attempt);
    pending = failed;
  }
  return out;
}
const rpc = async <T>(method: string, params: unknown[]) => (await rpcMany<T>([{ method, params }]))[0];

type Signature = { signature: string; slot: number; err: unknown };

// Solami's signature index times out past ~30 days; mainnet-beta has them all but allows ~1 call/s.
const SOLAMI_SIGNATURE_DAYS = 25;
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
let publicSlot = 0;
async function publicSignatures(params: unknown[]) {
  for (let attempt = 1; ; attempt++) {
    const at = Math.max(Date.now(), publicSlot);
    publicSlot = at + 1100;
    await Bun.sleep(at - Date.now());
    const res = await fetch(PUBLIC_RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params }),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json()) as { result?: Signature[] }) : null;
    if (body?.result) return body.result;
    if (attempt === ATTEMPTS) throw new Error(`getSignaturesForAddress (mainnet-beta): HTTP ${res?.status}`);
  }
}

// All signatures of an address, oldest first; null past MAX_TXS.
async function signatures(address: string, createdAt: number) {
  const out: Signature[] = [];
  let before: string | undefined;
  let solami = createdAt > Date.now() / 1000 - SOLAMI_SIGNATURE_DAYS * 86400;
  while (true) {
    const params = [address, { limit: 1000, before }];
    const page = solami
      ? await rpc<Signature[]>("getSignaturesForAddress", params).catch(() => ((solami = false), null))
      : await publicSignatures(params);
    if (!page) continue;
    out.push(...page);
    if (page.length < 1000) return out.filter((s) => !s.err).reverse();
    if (out.length >= MAX_TXS) return null;
    before = page.at(-1)!.signature;
  }
}

type RpcIx = { programIdIndex: number; accounts: number[]; data: string };
type RpcTx = {
  slot: number; blockTime: number | null;
  transaction: { message: { accountKeys: string[]; instructions: RpcIx[] }; signatures: string[] };
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] }; innerInstructions?: { instructions: RpcIx[] }[] } | null;
};

function toDbcTx(sig: string, tx: RpcTx): DbcTx {
  const accountKeys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const dbc = accountKeys.indexOf(DBC_PROGRAM_ID);
  return {
    sig, slot: tx.slot, blockTime: tx.blockTime ?? 0, accountKeys,
    ixs: [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)]
      .filter((ix) => ix.programIdIndex === dbc)
      .map((ix) => ({ accounts: ix.accounts, data: bs58.decode(ix.data) })),
  };
}

const transactions = (sigs: string[]) =>
  rpcMany<RpcTx | null>(sigs.map((sig) => ({ method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] })));

const saveReplay = db.prepare("INSERT OR REPLACE INTO replays (pool, scope, status, txs, at) VALUES (?, ?, ?, ?, ?)");

const createdAt = db.prepare("SELECT created_at FROM pools WHERE address = ?");

export async function replayPool(pool: string, scope: "full" | "creation") {
  const all = await signatures(pool, (createdAt.get(pool) as { created_at: number | null } | null)?.created_at ?? 0);
  const now = Math.floor(Date.now() / 1000);
  if (!all) {
    saveReplay.run(pool, scope, "too many transactions", MAX_TXS, now);
    return "capped";
  }
  if (!all.length) {
    saveReplay.run(pool, scope, "no signatures", 0, now);
    return "no signatures";
  }
  const sigs = scope === "full" ? all : all.filter((s) => s.slot === all[0].slot);
  const txs = await transactions(sigs.map((s) => s.signature));
  if (txs.some((t) => !t)) {
    saveReplay.run(pool, scope, "missing transactions", sigs.length, now);
    return "missing";
  }
  db.transaction(() => {
    resetEvidence(pool);
    txs.forEach((tx, i) => {
      if (tx!.meta?.err) return;
      const dbcTx = toDbcTx(sigs[i].signature, tx!);
      for (const step of decodeDbcTx(dbcTx)) if (step.kind !== "config" && step.pool === pool) applyEvidence(dbcTx, step, "rpc", scope === "creation");
    });
    judgePool(pool);
    saveReplay.run(pool, scope, "done", sigs.length, now);
  }).immediate();
  return "done";
}

// Contested candidates first: graduated, judged unverified (no rule fired, no transaction evidence).
const CANDIDATES = {
  full: `SELECT p.address FROM pools p WHERE p.graduated_at IS NOT NULL AND p.verdict IS NULL AND p.created_at >= ?
    AND NOT EXISTS (SELECT 1 FROM replays r WHERE r.pool = p.address) ORDER BY p.graduated_at DESC LIMIT ?`,
  // Unverified graduations are left to the full replay (a superset), so the two can run side by side.
  creation: `SELECT p.address FROM pools p WHERE p.graduated_at >= ? AND p.created_at >= ? AND p.verdict IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pool_evidence e WHERE e.pool = p.address AND e.complete = 1)
    AND NOT EXISTS (SELECT 1 FROM replays r WHERE r.pool = p.address) ORDER BY p.graduated_at DESC LIMIT ?`,
};

export async function replay(scope: "full" | "creation", days: number, limit: number) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const pools = (scope === "full" ? db.query(CANDIDATES.full).values(since, limit) : db.query(CANDIDATES.creation).values(since, since, limit)).flat() as string[];
  const tally: Record<string, number> = {};
  const started = performance.now();
  let next = 0;
  const worker = async () => {
    while (next < pools.length) {
      const pool = pools[next++];
      const result = await replayPool(pool, scope).catch((e) => {
        saveReplay.run(pool, scope, `error: ${String(e.message).slice(0, 80)}`, 0, Math.floor(Date.now() / 1000));
        return "error";
      });
      tally[result] = (tally[result] ?? 0) + 1;
      const n = Object.values(tally).reduce((a, b) => a + b, 0);
      if (n % 20 === 0) console.log(`${scope} ${n}/${pools.length}`, tally, `${retried} calls retried`, `${((performance.now() - started) / 1000).toFixed(0)}s`);
    }
  };
  await Promise.all(Array.from({ length: POOLS_AT_ONCE }, worker));
  return { pools: pools.length, ...tally };
}

if (import.meta.main) {
  const [scope = "full", days = "58", limit = "1000000"] = process.argv.slice(2);
  console.log("replay", scope, await replay(scope as "full" | "creation", Number(days), Number(limit)));
}
