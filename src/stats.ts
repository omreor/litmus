import { db } from "./store";

const PROGRESS_STEPS = [0.1, 0.25, 0.5, 0.75, 0.9];
// A pool with no trades for this long is treated as settled (dead or graduated) for odds.
const SETTLE_SECONDS = 6 * 3600;

const now = () => Math.floor(Date.now() / 1000);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function overview(since: number) {
  const pools = db
    .query(`SELECT
      COUNT(*) FILTER (WHERE created_at >= $since) launches,
      COUNT(*) FILTER (WHERE graduated_at >= $since) graduations,
      COUNT(*) FILTER (WHERE last_trade_at >= $since) active
    FROM pools`)
    .get({ $since: since });
  const volume = db
    .query(`SELECT c.quote_mint mint, m.symbol, m.decimals, SUM(h.volume) volume, SUM(h.trades) trades
      FROM config_hourly h JOIN configs c ON c.address = h.config LEFT JOIN mints m ON m.mint = c.quote_mint
      WHERE h.hour >= $hour GROUP BY c.quote_mint ORDER BY volume DESC`)
    .all({ $hour: Math.floor(since / 3600) });
  return { ...(pools as object), volume };
}

export function families(since: number, limit = 50) {
  const rows = db
    .query(`SELECT c.family, MIN(c.info) sample,
      COUNT(DISTINCT c.address) configs,
      COUNT(DISTINCT c.fee_claimer) claimers,
      COUNT(p.address) FILTER (WHERE p.created_at >= $since) launches,
      COUNT(p.address) FILTER (WHERE p.created_at >= $since AND p.graduated_at IS NOT NULL) launched_graduated,
      COUNT(p.address) FILTER (WHERE p.graduated_at >= $since) graduations
    FROM configs c LEFT JOIN pools p ON p.config = c.address
    WHERE c.family IS NOT NULL -- backfilled configs are only described once seen live
    GROUP BY c.family HAVING launches + graduations > 0
    ORDER BY launches DESC LIMIT $limit`)
    .all({ $since: since, $limit: limit }) as any[];
  const volume = db.prepare(`SELECT SUM(h.volume) volume, SUM(h.trades) trades FROM config_hourly h
    JOIN configs c ON c.address = h.config WHERE c.family = ? AND h.hour >= ?`);
  const gradTimes = db.prepare(`SELECT p.graduated_at - p.created_at secs FROM pools p JOIN configs c ON c.address = p.config
    WHERE c.family = ? AND p.created_at >= ? AND p.graduated_at IS NOT NULL`);
  return rows.map(({ sample, ...r }) => {
    const { curve, ...info } = JSON.parse(sample);
    return {
      ...r,
      ...(volume.get(r.family, Math.floor(since / 3600)) as object),
      gradRate: r.launches ? r.launched_graduated / r.launches : null,
      medianSecondsToGraduate: median((gradTimes.all(r.family, since) as any[]).map((x) => x.secs)),
      shape: info.shape,
    };
  });
}

// P(graduate | pool reached X% of its migration threshold), from settled pools we saw launch.
export function graduationOdds(family: string) {
  const pools = db
    .query(`SELECT CAST(p.max_reserve AS REAL) / p.migration_threshold progress, p.graduated_at IS NOT NULL graduated
      FROM pools p JOIN configs c ON c.address = p.config
      WHERE c.family = $family AND p.created_at IS NOT NULL AND p.migration_threshold > 0
        AND (p.graduated_at IS NOT NULL OR p.last_trade_at < $settled)`)
    .all({ $family: family, $settled: now() - SETTLE_SECONDS }) as { progress: number; graduated: number }[];
  return PROGRESS_STEPS.map((step) => {
    const reached = pools.filter((p) => p.graduated || p.progress >= step);
    return { step, reached: reached.length, graduated: reached.filter((p) => p.graduated).length };
  });
}

const MIN_SAMPLE = 5;
let oddsCache = { at: 0, byFamily: new Map<string, ReturnType<typeof graduationOdds>>() };
function familyOdds(family: string) {
  if (Date.now() - oddsCache.at > 60_000) oddsCache = { at: Date.now(), byFamily: new Map() };
  if (!oddsCache.byFamily.has(family)) oddsCache.byFamily.set(family, graduationOdds(family));
  return oddsCache.byFamily.get(family)!;
}

// Empirical odds for a live pool: graduation rate of its family's pools that reached the highest
// progress step this pool has reached. Null until there's a meaningful sample.
function oddsFor(family: string | null, progress: number) {
  if (!family) return null;
  const step = familyOdds(family).findLast((s) => progress >= s.step);
  return step && step.reached >= MIN_SAMPLE ? { rate: step.graduated / step.reached, sample: step.reached, step: step.step } : null;
}

export function hotPools(limit = 30) {
  const rows = db
    .query(`SELECT p.address, p.config, p.base_mint, p.name, p.symbol, c.family, p.created_at, p.last_trade_at, p.trades,
        p.buys, p.volume_quote, c.quote_mint, CAST(p.quote_reserve AS REAL) / p.migration_threshold progress,
        p.quote_reserve, p.migration_threshold, m.symbol quote_symbol, m.decimals quote_decimals
      FROM pools p LEFT JOIN configs c ON c.address = p.config LEFT JOIN mints m ON m.mint = c.quote_mint
      WHERE p.graduated_at IS NULL AND p.last_trade_at >= $since AND p.migration_threshold > 0
      ORDER BY progress DESC LIMIT $limit`)
    .all({ $since: now() - 600, $limit: limit }) as any[];
  return rows.map((r) => ({ ...r, odds: oddsFor(r.family, r.progress) }));
}

export function config(address: string) {
  const row = db.query("SELECT address, fee_claimer, quote_mint, family, info FROM configs WHERE address = ?").get(address) as any;
  if (!row) return null;
  const pools = db
    .query(`SELECT address, base_mint, created_at, graduated_at, trades, volume_quote,
        CAST(quote_reserve AS REAL) / NULLIF(migration_threshold, 0) progress
      FROM pools WHERE config = ? ORDER BY COALESCE(last_trade_at, created_at) DESC LIMIT 100`)
    .all(address);
  return { ...row, info: JSON.parse(row.info), pools };
}

export function family(id: string) {
  const configs = (
    db
      .query(`SELECT c.address, c.fee_claimer, c.info, COUNT(p.address) pools, COUNT(p.graduated_at) graduated
        FROM configs c LEFT JOIN pools p ON p.config = c.address
        WHERE c.family = ? GROUP BY c.address ORDER BY pools DESC LIMIT 12`)
      .all(id) as any[]
  ).map(({ info, ...c }) => ({ ...c, info: JSON.parse(info) }));
  if (!configs.length) return null;
  const recent = db
    .query(`SELECT p.address, p.config, p.name, p.symbol, p.base_mint, p.created_at, p.graduated_at, p.trades,
        p.volume_quote, CAST(p.max_reserve AS REAL) / NULLIF(p.migration_threshold, 0) peak
      FROM pools p JOIN configs c ON c.address = p.config
      WHERE c.family = ? AND p.created_at IS NOT NULL ORDER BY p.created_at DESC LIMIT 25`)
    .all(id);
  return { family: id, configs, odds: graduationOdds(id), recent };
}

const SOL = "So11111111111111111111111111111111111111112";
const THRESHOLD_BUCKETS = [0, 5, 15, 40, 80, 150, Infinity];

// Graduation outcomes of SOL-quoted launches we saw, bucketed by the config's migration threshold.
export function thresholdBenchmarks(since: number) {
  const rows = db
    .query(`SELECT c.threshold / 1e9 threshold, p.graduated_at - p.created_at secs
      FROM pools p JOIN configs c ON c.address = p.config
      WHERE p.created_at >= $since AND c.quote_mint = $sol`)
    .all({ $since: since, $sol: SOL }) as { threshold: number; secs: number | null }[];
  return THRESHOLD_BUCKETS.slice(0, -1).map((min, i) => {
    const max = THRESHOLD_BUCKETS[i + 1];
    const inBucket = rows.filter((r) => r.threshold >= min && r.threshold < max);
    const graduated = inBucket.filter((r) => r.secs !== null);
    return {
      min, max: Number.isFinite(max) ? max : null,
      launches: inBucket.length,
      graduated: graduated.length,
      medianSecondsToGraduate: median(graduated.map((r) => r.secs!)),
    };
  });
}
