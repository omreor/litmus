import { quote } from "./aggregates";
import { describeNow } from "./enrich";
import { evidenceOf } from "./evidence";
import { graduationItem, launchpadOf } from "./indexer";
import { judgementOf, verdictFields } from "./integrity";
import { postGraduationOf } from "./postgrad";
import { db } from "./store";

// Cheap, index-backed reads served straight from the database; the full-history aggregates live in
// aggregates.ts. `organic` = not judged uncontested (contested or unverified).

const now = () => Math.floor(Date.now() / 1000);

// Volume is counted from the live stream only (config_hourly): windows reaching back before its first
// hour cover less, and say so. The first hour never changes once there is one.
let volumeStart: number | null = null;
function firstVolumeHour() {
  if (volumeStart === null) {
    const { first } = db.query("SELECT MIN(hour) first FROM config_hourly").get() as { first: number | null };
    volumeStart = first === null ? null : first * 3600;
  }
  return volumeStart;
}

export function overview(since: number) {
  const launches = db.query(`SELECT COUNT(*) launches, COALESCE(SUM(verdict IS NOT 0), 0) organic, COALESCE(SUM(verdict = 1), 0) contested,
      COALESCE(SUM(verdict = 0), 0) uncontested FROM pools WHERE created_at >= ?`).get(since) as any;
  const graduations = db.query(`SELECT COUNT(*) graduations, COALESCE(SUM(verdict IS NOT 0), 0) organic, COALESCE(SUM(verdict = 1), 0) contested,
      COALESCE(SUM(verdict = 0), 0) uncontested FROM pools WHERE graduated_at >= ?`).get(since) as any;
  const { active } = db.query("SELECT COUNT(*) active FROM pools WHERE last_trade_at >= ?").get(since) as any;
  // Live volume per quote token, and how much of it traded on volume-farm templates (1 bps, never graduate).
  const volume = db.query(`SELECT c.quote_mint mint, m.symbol, COALESCE(m.decimals, 9) decimals, SUM(h.volume) volume, SUM(h.trades) trades,
      COALESCE(SUM(h.volume) FILTER (WHERE t.rules LIKE '%volume-farm%'), 0) farmVolume
    FROM config_hourly h JOIN configs c ON c.address = h.config LEFT JOIN mints m ON m.mint = c.quote_mint LEFT JOIN templates t ON t.template = c.template
    WHERE h.hour >= ? GROUP BY c.quote_mint ORDER BY volume DESC`).all(Math.floor(since / 3600)) as any[];
  const sol = volume.find((v) => v.mint === "So11111111111111111111111111111111111111112");
  const start = firstVolumeHour();
  return {
    launches: launches.launches, graduations: graduations.graduations, active,
    organic: { launches: launches.organic, graduations: graduations.organic },
    contested: { launches: launches.contested, graduations: graduations.contested },
    uncontested: { launches: launches.uncontested, graduations: graduations.uncontested },
    volume: volume.map(({ farmVolume, ...v }) => ({ ...v, symbol: quote(v.mint).symbol })),
    volumeFarm: { solVolume: sol?.farmVolume ?? 0, solShare: sol?.volume ? sol.farmVolume / sol.volume : null },
    volumeFrom: start === null ? null : Math.max(start, since),
  };
}

// Empirical odds for a live pool: graduation rate of its template's settled pools that reached the
// highest progress step this pool has reached. Null until there's a meaningful sample.
const MIN_ODDS_SAMPLE = 5;
type Step = { step: number; reached: number; graduated: number };
function oddsFor(steps: Step[] | undefined, progress: number) {
  const step = steps?.findLast((s) => progress >= s.step);
  return step && step.reached >= MIN_ODDS_SAMPLE ? { rate: step.graduated / step.reached, sample: step.reached, step: step.step } : null;
}

const judged = (pool: string) => {
  const j = judgementOf(pool);
  return j ? verdictFields(j) : null;
};

export function hotPools(oddsByTemplate: Record<string, Step[]>, limit = 30) {
  const rows = db.query(`SELECT p.address, p.config, p.base_mint, p.name, p.symbol, c.template family, p.created_at, p.last_trade_at, p.trades,
        p.buys, p.volume_quote, c.quote_mint, CAST(p.quote_reserve AS REAL) / p.migration_threshold progress,
        p.quote_reserve, p.migration_threshold
      FROM pools p INDEXED BY pools_last_trade LEFT JOIN configs c ON c.address = p.config
      WHERE p.last_trade_at >= ? AND p.graduated_at IS NULL AND p.migration_threshold > 0
      ORDER BY progress DESC LIMIT ?`).all(now() - 600, limit) as any[];
  return rows.map((r) => {
    const q = quote(r.quote_mint);
    return {
      ...r, quote_symbol: q.symbol, quote_decimals: q.decimals, odds: oddsFor(oddsByTemplate[r.family], r.progress),
      launchpad: launchpadOf(r.config), ...judged(r.address),
    };
  });
}

const poolRow = db.prepare(`SELECT p.address, p.config, p.creator, p.base_mint, p.name, p.symbol, p.uri, p.created_at, p.graduated_at, p.last_trade_at,
    p.quote_reserve, p.trades, p.volume_quote, c.template, c.quote_mint, c.threshold
  FROM pools p LEFT JOIN configs c ON c.address = p.config WHERE p.address = ?`);

export function poolDetail(address: string) {
  const p = poolRow.get(address) as any;
  if (!p) return null;
  const q = quote(p.quote_mint);
  const ev = evidenceOf(address);
  return {
    ...p, quote: q, progress: p.graduated_at ? 1 : p.threshold ? Math.min(p.quote_reserve / p.threshold, 1) : null,
    launchpad: launchpadOf(p.config), ...judged(address), postGraduation: p.graduated_at ? postGraduationOf(address) : null,
    transactions: ev && { source: ev.source, fromCreation: !!ev.complete, creationSlotOnly: !!ev.partial, trades: ev.trades },
  };
}

// Latest graduations as stream items. Only graduations whose completing transaction is known (seen live,
// archived or replayed) qualify, so every item links its transaction.
const recentGraduations = db.prepare(`SELECT p.address, p.config, p.graduated_at, p.quote_reserve, e.completion_sig
  FROM pools p JOIN pool_evidence e ON e.pool = p.address
  WHERE p.graduated_at IS NOT NULL AND e.completion_sig IS NOT NULL ORDER BY p.graduated_at DESC LIMIT ?`);
export function graduationsRecent(limit: number) {
  return (recentGraduations.all(Math.min(limit, 200)) as any[])
    .map((r) => graduationItem(r.address, r.config, r.graduated_at, r.completion_sig, String(r.quote_reserve)))
    .filter(Boolean);
}

const configRow = db.prepare("SELECT address, fee_claimer, quote_mint, template, launchpad, info FROM configs WHERE address = ?");
const configStats = db.prepare(`SELECT COUNT(*) pools, COUNT(graduated_at) graduated, COALESCE(SUM(graduated_at IS NOT NULL AND verdict = 1), 0) contestedGraduated,
    COALESCE(SUM(graduated_at IS NOT NULL AND verdict IS NOT 0), 0) organicGraduated
  FROM pools WHERE config = ?`);
const configPools = db.prepare(`SELECT address, name, symbol, base_mint, created_at, graduated_at, trades, volume_quote, verdict,
    CAST(quote_reserve AS REAL) / NULLIF(migration_threshold, 0) progress
  FROM pools WHERE config = ? ORDER BY created_at DESC LIMIT 100`);

// Any config: decoded from chain on first request (so the Studio can fork configs we never saw).
export async function configDetail(address: string) {
  let row = configRow.get(address) as any;
  if (!row?.info) {
    await describeNow(address);
    row = configRow.get(address);
  }
  if (!row?.info) return null;
  return {
    address, info: JSON.parse(row.info), template: row.template, launchpad: row.launchpad ? launchpadOf(address) : null,
    stats: configStats.get(address), pools: configPools.all(address),
  };
}

const usageRows = db.prepare("SELECT day, route, count FROM usage WHERE day >= ? ORDER BY day DESC, count DESC");
const studioRows = db.prepare("SELECT signature, kind, at, account FROM studio_txs ORDER BY at DESC LIMIT 50");
const studioCounts = db.prepare("SELECT kind, COUNT(*) n FROM studio_txs GROUP BY kind");
export function usage(stream: { current: number; peak: number }) {
  const days: Record<string, Record<string, number>> = {};
  const peaks: Record<string, number> = {};
  for (const r of usageRows.all(new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)) as any[]) {
    if (r.route === "ws:peak") peaks[r.day] = r.count;
    else (days[r.day] ??= {})[r.route] = r.count;
  }
  const counts = Object.fromEntries((studioCounts.all() as { kind: string; n: number }[]).map((r) => [r.kind, r.n]));
  return { requests: days, stream: { ...stream, peakByDay: peaks }, studio: { deploys: counts.deploy ?? 0, launches: counts.launch ?? 0, recent: studioRows.all() } };
}
