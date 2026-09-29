import { decodeDbcTx, type DbcTx } from "./dbc";
import { queueConfig } from "./enrich";
import { applyEvidence, firstSighting } from "./evidence";
import { judgementOf, judgePool, launchpadLabel, OPERATOR_KEYS, verdictFields, type Signals } from "./integrity";
import { cleanText } from "./metadata";
import { db, recordGraduation, recordLaunch, recordSwap } from "./store";

type Verdict = Omit<ReturnType<typeof verdictFields>, "signals"> & { signals: Signals | null };
type Common = { ts: number; sig: string; launchpad: { id: string; name: string | null } | null } & Verdict;
export type FeedItem = Common & (
  | { type: "launch"; pool: string; config: string; creator: string; mint: string; name?: string; symbol?: string; uri?: string }
  | { type: "graduation"; pool: string; config: string; quoteReserve: string; name: string | null; symbol: string | null; mint: string | null }
  | { type: "config"; config: string; feeClaimer: string; quoteMint: string }
);

const listeners = new Set<(item: FeedItem) => void>();
export const subscribeFeed = (fn: (item: FeedItem) => void) => (listeners.add(fn), () => listeners.delete(fn));

const configLaunchpad = db.prepare("SELECT launchpad FROM configs WHERE address = ?");
export function launchpadOf(config: string) {
  const id = (configLaunchpad.get(config) as { launchpad: string | null } | null)?.launchpad;
  return id ? { id, name: launchpadLabel(id).name } : null;
}

const poolNames = db.prepare("SELECT name, symbol, base_mint FROM pools WHERE address = ?");
export function graduationItem(pool: string, config: string, ts: number, sig: string, quoteReserve: string): FeedItem | null {
  const judgement = judgementOf(pool);
  if (!judgement) return null;
  const p = poolNames.get(pool) as { name: string | null; symbol: string | null; base_mint: string | null };
  return {
    type: "graduation", ts, sig, pool, config, quoteReserve, name: p.name, symbol: p.symbol, mint: p.base_mint,
    launchpad: launchpadOf(config), ...verdictFields(judgement),
  };
}

// Pools whose evidence changed since they were last judged; re-judged in batches (flushVerdicts).
const dirty = new Set<string>();
export function flushVerdicts() {
  const pools = [...dirty];
  dirty.clear();
  db.transaction(() => pools.forEach((pool) => judgePool(pool))).immediate();
}

// A config created in a transaction an operator key co-signed belongs to that launchpad (integrity.ts
// OPERATOR_KEYS); describing the config later keeps the attribution.
const attributeConfig = db.prepare(`INSERT INTO configs (address, signer, launchpad) VALUES (?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET signer = excluded.signer, launchpad = excluded.launchpad`);

// Source-agnostic: the live stream, the archive replay and the RPC sampler all deliver DbcTx. Each
// transaction is applied once (store counters, evidence); feed items go out only for live ones, after
// the whole transaction is applied so a launch's verdict sees the creator's buy in the same transaction.
export function handleTransaction(tx: DbcTx, source: "live" | "archive") {
  if (!firstSighting(tx.sig, tx.slot)) return;
  const steps = decodeDbcTx(tx);
  const operator = tx.accountKeys.find((k) => OPERATOR_KEYS.includes(k));
  db.transaction(() => {
    for (const step of steps) {
      if (step.kind === "config" && operator) attributeConfig.run(step.config, operator, operator);
      queueConfig(step.config);
      if (step.kind === "launch") {
        const meta = step.meta && { name: cleanText(step.meta.name), symbol: cleanText(step.meta.symbol), uri: step.meta.uri };
        recordLaunch(step.pool, step.config, step.creator, step.mint, tx.blockTime, meta);
      } else if (step.kind === "swap") {
        if (step.reserve !== null && step.threshold !== null)
          recordSwap({ pool: step.pool, config: step.config, buy: step.buy, ts: step.ts, reserve: step.reserve, threshold: step.threshold, volume: step.quote });
        dirty.add(step.pool);
      } else if (step.kind === "complete") recordGraduation(step.pool, step.config, step.quoteReserve, tx.blockTime);
      applyEvidence(tx, step, source);
    }
  }).immediate();
  // One feed item per (type, pool or config) and transaction.
  const emitted = new Set<string>();
  for (const step of steps) {
    if (step.kind === "swap") continue;
    const key = `${step.kind}:${step.kind === "config" ? step.config : step.pool}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    let item: FeedItem | null;
    if (step.kind === "config") {
      if (source !== "live") continue;
      const id = operator ?? step.feeClaimer;
      item = {
        type: "config", ts: tx.blockTime, sig: tx.sig, config: step.config, feeClaimer: step.feeClaimer, quoteMint: step.quoteMint,
        launchpad: { id, name: launchpadLabel(id).name },
        verdict: "unverified", contested: null, organic: true, evidence: {}, signals: null, receipts: [], reasons: [],
      };
    } else if (step.kind === "launch") {
      const judgement = judgePool(step.pool);
      dirty.delete(step.pool);
      if (source !== "live" || !judgement) continue;
      const p = poolNames.get(step.pool) as { name: string | null; symbol: string | null };
      item = {
        type: "launch", ts: tx.blockTime, sig: tx.sig, pool: step.pool, config: step.config, creator: step.creator, mint: step.mint,
        name: p.name ?? undefined, symbol: p.symbol ?? undefined, uri: step.meta?.uri, launchpad: launchpadOf(step.config), ...verdictFields(judgement),
      };
    } else {
      dirty.delete(step.pool);
      judgePool(step.pool);
      if (source !== "live") continue;
      item = graduationItem(step.pool, step.config, tx.blockTime, tx.sig, step.quoteReserve.toString());
    }
    if (item) listeners.forEach((fn) => fn(item));
  }
}
