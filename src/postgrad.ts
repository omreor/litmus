import { dammV2PoolAddress, readDammPools } from "./damm";
import { ALIVE_LIQUIDITY_USD } from "./integrity";
import { sweepQuotes } from "./metadata";
import { db } from "./store";

// Post-graduation outcomes: the DAMM v2 pool each graduated DBC pool migrated to (address derived from
// base mint, quote mint and the config's migration fee option), read in batches. Every read refreshes
// day -1 (latest); graduations seen from now on also get day 0 (first read after migration, the fee
// baseline) and snapshots one and seven days after graduation. Volume over a snapshot = fees earned
// since day 0 / fee rate. `bun src/postgrad.ts` reads every graduated pool once (history).

const SOLAMI_RPC = `https://rpc.solami.dev/sol?api_key=${process.env.SOLAMI_API_KEY}`;
const RPC = process.env.SOLAMI_API_KEY ? SOLAMI_RPC : "https://api.mainnet-beta.solana.com";
const DAMM_V2 = 1;
const DAY = 86400;
const Q64 = 2 ** 64;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let prices = { at: 0, usd: new Map<string, number>([[USDC, 1]]) };
async function quoteUsd(mints: string[]) {
  const missing = [...new Set(mints)].filter((m) => !prices.usd.has(m) || Date.now() - prices.at > 300_000);
  for (let i = 0; i < missing.length; i += 50) {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${missing.slice(i, i + 50).join(",")}`);
    if (!res.ok) throw new Error(`jupiter price: HTTP ${res.status}`);
    for (const [mint, p] of Object.entries((await res.json()) as Record<string, { usdPrice: number }>)) prices.usd.set(mint, p.usdPrice);
  }
  if (missing.length) prices.at = Date.now();
  return prices.usd;
}

type Target = { address: string; base_mint: string; quote_mint: string; migration_fee_option: number; decimals: number; graduated_at: number };
const saveRow = db.prepare(`INSERT OR REPLACE INTO post_graduation (pool, day, at, damm, liquidity, liquidity_usd, fees_a, fees_b, fees_usd, volume_usd, lp_pulled)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const baseline = db.prepare("SELECT liquidity, fees_a, fees_b FROM post_graduation WHERE pool = ? AND day = 0");
// Keeps the previous latest read as day -2 when it's at least half a day old.
const keepPrevious = db.prepare(`INSERT OR REPLACE INTO post_graduation (pool, day, at, damm, liquidity, liquidity_usd, fees_a, fees_b, fees_usd, volume_usd, lp_pulled)
  SELECT pool, -2, at, damm, liquidity, liquidity_usd, fees_a, fees_b, fees_usd, volume_usd, lp_pulled FROM post_graduation
  WHERE pool = ? AND day = -1 AND at < ?`);

// Reads the DAMM v2 pools of `targets` and stores `day` (plus day -1) for the ones that exist.
async function snapshot(targets: Target[], day: number) {
  const damm = targets.map((t) => dammV2PoolAddress(t.base_mint, t.quote_mint, t.migration_fee_option));
  const pools = await readDammPools(damm, RPC);
  const usd = await quoteUsd(targets.map((t) => t.quote_mint));
  const at = Math.floor(Date.now() / 1000);
  let stored = 0;
  db.transaction(() => {
    targets.forEach((t, i) => {
      const p = pools.get(damm[i]);
      const quoteUsdPrice = usd.get(t.quote_mint);
      if (!p || quoteUsdPrice === undefined) return;
      // Base valued at the pool price; raw quote per raw base = (sqrt_price / 2^64)^2.
      const price = (Number(p.sqrtPrice) / Q64) ** 2;
      const toUsd = (quoteRaw: number) => (quoteRaw / 10 ** t.decimals) * quoteUsdPrice;
      const [feesA, feesB, liquidity] = [Number(p.feesA), Number(p.feesB), Number(p.liquidity)];
      const liquidityUsd = toUsd(Number(p.reserveB) + Number(p.reserveA) * price);
      const feesUsd = toUsd(feesB + feesA * price);
      const base = baseline.get(t.address) as { liquidity: number; fees_a: number; fees_b: number } | null;
      const volumeUsd = base && p.feeRate > 0 ? toUsd(Math.max(feesB - base.fees_b + (feesA - base.fees_a) * price, 0)) / p.feeRate : null;
      // LP pulled: more than half the liquidity removed since migration; without a baseline, all of it.
      const lpPulled = base ? liquidity < base.liquidity / 2 : liquidity === 0;
      keepPrevious.run(t.address, at - 43_200);
      for (const d of new Set([day, -1]))
        saveRow.run(t.address, d, at, damm[i], liquidity, liquidityUsd, feesA, feesB, feesUsd, d === -1 ? null : volumeUsd, lpPulled ? 1 : 0);
      stored++;
    });
  }).immediate();
  return stored;
}

const TARGETS = `SELECT p.address, p.base_mint, c.quote_mint, c.migration_fee_option, COALESCE(m.decimals, 9) decimals, p.graduated_at
  FROM pools p JOIN configs c ON c.address = p.config LEFT JOIN mints m ON m.mint = c.quote_mint
  WHERE c.migration_option = ${DAMM_V2} AND p.base_mint IS NOT NULL`;
const due = db.prepare(`${TARGETS} AND p.graduated_at BETWEEN ? AND ?
  AND NOT EXISTS (SELECT 1 FROM post_graduation g WHERE g.pool = p.address AND g.day = ?) LIMIT 2000`);

// Day 0 once migrated (a few minutes after graduation), days 1 and 7 on schedule. Graduations from
// before this ran get no snapshots: history only has current state (day -1).
export async function snapshotGraduations() {
  const now = Math.floor(Date.now() / 1000);
  const plan: [number, number, number][] = [[0, now - DAY, now - 300], [1, now - 2 * DAY, now - DAY], [7, now - 8 * DAY, now - 7 * DAY]];
  const counts: Record<number, number> = {};
  for (const [day, from, to] of plan) {
    const targets = due.all(from, to, day) as Target[];
    const eligible = day === 0 ? targets : targets.filter((t) => baseline.get(t.address));
    counts[day] = eligible.length ? await snapshot(eligible, day) : 0;
  }
  return counts;
}

// Every graduated pool whose latest read is older than `maxAgeSeconds` (all of them on the first run).
export async function readHistory(maxAgeSeconds = 43_200, batch = 2000) {
  const pending = db.prepare(`${TARGETS} AND p.graduated_at IS NOT NULL AND p.rowid > ?
    AND NOT EXISTS (SELECT 1 FROM post_graduation g WHERE g.pool = p.address AND g.day = -1 AND g.at >= ${Math.floor(Date.now() / 1000) - maxAgeSeconds})
    ORDER BY p.rowid LIMIT ${batch}`);
  const rowid = db.prepare("SELECT rowid FROM pools WHERE address = ?");
  let [after, read, stored] = [0, 0, 0];
  while (true) {
    const targets = pending.all(after) as Target[];
    if (!targets.length) return { read, stored };
    stored += await snapshot(targets, -1);
    read += targets.length;
    after = (rowid.get(targets.at(-1)!.address) as { rowid: number }).rowid;
    if (read % 50_000 < batch) console.log(`  ${read} read, ${stored} stored`);
  }
}

type Day = { liquidity_usd: number; volume_usd: number | null; lp_pulled: number; at: number };
const poolRows = db.prepare("SELECT day, at, liquidity_usd, volume_usd, lp_pulled FROM post_graduation WHERE pool = ?");

export function postGraduationOf(pool: string) {
  const days = new Map((poolRows.all(pool) as (Day & { day: number })[]).map((r) => [r.day, r]));
  const latest = days.get(-1);
  if (!latest) return null;
  const snap = (d?: Day) => (d ? { liquidityUsd: Math.round(d.liquidity_usd), volumeUsd: d.volume_usd === null ? null : Math.round(d.volume_usd) } : null);
  return { d1: snap(days.get(1)), d7: snap(days.get(7)), lpPulled: !!latest.lp_pulled, current: { liquidityUsd: Math.round(latest.liquidity_usd), at: latest.at } };
}

// Per template or launchpad: graduations at least 7 days old that can be judged, and how many were
// alive at +1d / +7d: liquidity >= ALIVE_LIQUIDITY_USD and still trading. Pools graduated before
// snapshots began are judged on their current state instead, once two reads half a day apart show
// whether their fee counters still grow.
export function postGraduationBy(column: "template" | "launchpad") {
  const current = `(cur.liquidity_usd >= $alive AND (cur.fees_a > prev.fees_a OR cur.fees_b > prev.fees_b))`;
  const snap = (d: string) => `(${d}.liquidity_usd >= $alive AND ${d}.volume_usd > 0)`;
  const rows = db.query(`SELECT c.${column} key, COUNT(*) graduated,
      TOTAL(CASE WHEN d1.pool IS NULL THEN ${current} ELSE ${snap("d1")} END) aliveD1,
      TOTAL(CASE WHEN d7.pool IS NULL THEN ${current} ELSE ${snap("d7")} END) aliveD7,
      TOTAL(cur.lp_pulled) lpPulled
    FROM post_graduation cur JOIN pools p ON p.address = cur.pool JOIN configs c ON c.address = p.config
      LEFT JOIN post_graduation prev ON prev.pool = cur.pool AND prev.day = -2
      LEFT JOIN post_graduation d1 ON d1.pool = cur.pool AND d1.day = 1 LEFT JOIN post_graduation d7 ON d7.pool = cur.pool AND d7.day = 7
    WHERE cur.day = -1 AND p.graduated_at <= $settled AND (prev.pool IS NOT NULL OR d7.pool IS NOT NULL) GROUP BY key`).all({ $alive: ALIVE_LIQUIDITY_USD, $settled: Math.floor(Date.now() / 1000) - 7 * DAY }) as any[];
  return new Map(rows.map(({ key, ...r }) => [key as string, r as { graduated: number; aliveD1: number; aliveD7: number; lpPulled: number }]));
}

if (import.meta.main) {
  const started = performance.now();
  console.log("quote mints resolved", await sweepQuotes());
  console.log("post-graduation history", await readHistory(), `${((performance.now() - started) / 1000).toFixed(0)}s`);
}
