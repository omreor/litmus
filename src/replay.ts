import { utils } from "@coral-xyz/anchor";
import { DBC_PROGRAM_ID, decodeDbcTx, type DbcTx } from "./dbc";
import { applyEvidence, EVIDENCE_VERSION, resetEvidence } from "./evidence";
import { assignLaunchpads, judgePool, OPERATOR_KEYS } from "./integrity";
import { db } from "./store";

// History replay over Solami RPC: rebuilds a pool's evidence from its own transactions.
//   full:     every transaction of the pool (the contested candidates: no rule fired, no evidence yet)
//   creation: only the creation slot (creator and bundle fill, same-slot completion) for all graduations
//   hot:      every transaction of pools trading right now without evidence, closest to graduation first
//             (the server runs this every minute so the Radar's pools get verdicts)
//   redo:     pools replayed with an older EVIDENCE_VERSION, again with their original scope
// `bun src/replay.ts operators` attributes the configs whose creation an operator key co-signed.
// Solami serves getTransaction for roughly the last 60 days (older requests time out after 40 s), so
// only pools created inside that window are attempted. Resumable: `replays` records every attempt.
// Usage: bun src/replay.ts full|creation|hot|redo [days=58] [limit]

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

// Batched calls; failed ones are retried (as smaller batches) until `attempts` tries.
export async function rpcMany<T>(calls: Call[], attempts = ATTEMPTS): Promise<T[]> {
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
    if (failed.length && attempt >= attempts) throw new Error(`${calls[failed[0]].method}: ${redact(lastError)}`);
    retried += failed.length;
    if (failed.length) await Bun.sleep(2000 * attempt);
    pending = failed;
  }
  return out;
}
export const rpc = async <T>(method: string, params: unknown[]) => (await rpcMany<T>([{ method, params }]))[0];

export type Signature = { signature: string; slot: number; blockTime: number | null; err: unknown };

// Solami's signature index times out past ~30 days (and on wallets whose only transactions are minutes
// old). Public archive RPCs have them all but allow about one call a second per client each
// (PUBLIC_RPC_SPACING_MS between calls to one endpoint); calls go to whichever endpoint is free first.
const SOLAMI_SIGNATURE_DAYS = 25;
const PUBLIC_RPCS = ["https://api.mainnet-beta.solana.com", "https://public.rpc.solanavibestation.com"].map((url) => ({ url, next: 0 }));
const PUBLIC_SPACING_MS = Number(process.env.PUBLIC_RPC_SPACING_MS ?? 1100);
export async function publicSignatures(params: unknown[]) {
  for (let attempt = 1; ; attempt++) {
    const rpc = PUBLIC_RPCS.reduce((a, b) => (b.next < a.next ? b : a));
    const at = Math.max(Date.now(), rpc.next);
    rpc.next = at + PUBLIC_SPACING_MS;
    await Bun.sleep(at - Date.now());
    const res = await fetch(rpc.url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params }),
    }).catch(() => null);
    const body = res?.ok ? ((await res.json().catch(() => null)) as { result?: Signature[]; error?: { message: string } } | null) : null;
    if (body?.result) return body.result;
    if (attempt === ATTEMPTS * 2) throw new Error(`getSignaturesForAddress (public RPC): ${body?.error?.message ?? `HTTP ${res?.status}`}`);
    // Rate limited (429, or an error body): every caller in this process backs off from that endpoint.
    if (res?.status === 429 || body?.error) rpc.next += 2000;
  }
}

// All signatures of an address, oldest first; null past MAX_TXS.
async function signatures(address: string, createdAt: number) {
  const out: Signature[] = [];
  let before: string | undefined;
  let solami = createdAt > Date.now() / 1000 - SOLAMI_SIGNATURE_DAYS * 86400;
  while (true) {
    const params = [address, { limit: 1000, before }];
    // One Solami attempt (a failure there is a ~40 s timeout, retrying rarely helps), then mainnet-beta.
    const page = solami
      ? await rpcMany<Signature[]>([{ method: "getSignaturesForAddress", params }], 1).then((r) => r[0], () => ((solami = false), null))
      : await publicSignatures(params);
    if (!page) continue;
    // Solami answers some older addresses with an empty list; every pool has at least its creation.
    if (solami && !page.length && !out.length) {
      solami = false;
      continue;
    }
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

// Candidate pools and the scope each is replayed with. Contested candidates first: graduated, judged
// unverified (no rule fired, no transaction evidence). An attempt that failed (RPC errors) is retried after an hour.
const SETTLED = "(r.status NOT LIKE 'error%' OR r.at > unixepoch() - 3600)";
const CANDIDATES = {
  full: `SELECT p.address, 'full' FROM pools p WHERE p.graduated_at IS NOT NULL AND p.verdict IS NULL AND p.created_at >= $since
    AND NOT EXISTS (SELECT 1 FROM replays r WHERE r.pool = p.address AND ${SETTLED}) ORDER BY p.graduated_at DESC LIMIT $limit`,
  // Unverified graduations are left to the full replay (a superset), so the two can run side by side.
  creation: `SELECT p.address, 'creation' FROM pools p WHERE p.graduated_at >= $since AND p.created_at >= $since AND p.verdict IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pool_evidence e WHERE e.pool = p.address AND e.complete = 1)
    AND NOT EXISTS (SELECT 1 FROM replays r WHERE r.pool = p.address AND ${SETTLED}) ORDER BY p.graduated_at DESC LIMIT $limit`,
  hot: `SELECT p.address, 'full' FROM pools p INDEXED BY pools_last_trade WHERE p.last_trade_at >= unixepoch() - 600 AND p.graduated_at IS NULL
    AND p.migration_threshold > 0 AND p.created_at >= $since
    AND NOT EXISTS (SELECT 1 FROM pool_evidence e WHERE e.pool = p.address AND e.complete = 1)
    AND NOT EXISTS (SELECT 1 FROM replays r WHERE r.pool = p.address AND ${SETTLED})
    ORDER BY CAST(p.quote_reserve AS REAL) / p.migration_threshold DESC LIMIT $limit`,
  redo: `SELECT e.pool, CASE WHEN e.partial THEN 'creation' ELSE 'full' END FROM pool_evidence e JOIN pools p ON p.address = e.pool
    WHERE e.source = 'rpc' AND e.version IS NOT ${EVIDENCE_VERSION} AND p.created_at >= $since
    ORDER BY e.partial, p.graduated_at DESC LIMIT $limit`,
};
export type ReplayMode = keyof typeof CANDIDATES;

export async function replay(mode: ReplayMode, days: number, limit: number) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const pools = db.query(CANDIDATES[mode]).values({ $since: since, $limit: limit }) as [string, "full" | "creation"][];
  const tally: Record<string, number> = {};
  const started = performance.now();
  let next = 0;
  const worker = async () => {
    while (next < pools.length) {
      const [pool, scope] = pools[next++];
      const result = await replayPool(pool, scope).catch((e) => {
        saveReplay.run(pool, scope, `error: ${String(e.message).slice(0, 80)}`, 0, Math.floor(Date.now() / 1000));
        return "error";
      });
      tally[result] = (tally[result] ?? 0) + 1;
      const n = Object.values(tally).reduce((a, b) => a + b, 0);
      if (n % 20 === 0 && mode !== "hot") console.log(`${mode} ${n}/${pools.length}`, tally, `${retried} calls retried`, `${((performance.now() - started) / 1000).toFixed(0)}s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOLS_AT_ONCE, pools.length) }, worker));
  return { pools: pools.length, ...tally };
}

// Every config created in a transaction an operator key (integrity.ts OPERATOR_KEYS) signed: the key
// becomes the config's signer, then launchpads are reassigned.
const attributeConfig = db.prepare(`INSERT INTO configs (address, signer) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET signer = excluded.signer`);
export async function attributeOperators() {
  const configs: Record<string, number> = {};
  for (const key of OPERATOR_KEYS) {
    const sigs = ((await signatures(key, 0)) ?? []).map((s) => s.signature);
    const txs = await transactions(sigs);
    const found = new Set<string>();
    txs.forEach((tx, i) => {
      if (tx && !tx.meta?.err) for (const step of decodeDbcTx(toDbcTx(sigs[i], tx))) if (step.kind === "config") found.add(step.config);
    });
    db.transaction(() => found.forEach((config) => attributeConfig.run(config, key))).immediate();
    configs[key] = found.size;
  }
  assignLaunchpads();
  return configs;
}

if (import.meta.main) {
  const [mode = "full", days = "58", limit = "1000000"] = process.argv.slice(2);
  if (mode === "operators") console.log("configs co-signed by operator keys", await attributeOperators());
  else console.log("replay", mode, await replay(mode as ReplayMode, Number(days), Number(limit)));
}
