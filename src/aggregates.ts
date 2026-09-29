import { judgementOf, launchpadLabel, medians, verdictFields } from "./integrity";
import { postGraduationBy, postGraduationOf } from "./postgrad";
import { db } from "./store";

// Full-history aggregates behind the leaderboards, templates, integrity history and priors. They scan
// up to all 1.7M pools, so a Worker (bottom of this file) recomputes them on a timer and posts the
// results to the server, which serves them from memory; the same functions answer uncommon
// parameters directly. `organic` in the API = not judged uncontested (contested or unverified).

export const WINDOWS = [3600, 6 * 3600, 86400, 7 * 86400, 30 * 86400];
const DBC_LAUNCH_TIME = 1745388780;
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const QUOTE_MINTS: Record<string, string> = { SOL, USDC };
const PROGRESS_STEPS = [0.1, 0.25, 0.5, 0.75, 0.9];
// A pool with no trades for this long is treated as settled (dead or graduated) for odds.
const SETTLE_SECONDS = 6 * 3600;
const MIN_SAMPLE = 20;
// A contested graduation rate over fewer contested pools than this is noise: served as null.
const MIN_RATE_SAMPLE = 10;
const LIST_LIMIT = 50;

const now = () => Math.floor(Date.now() / 1000);
const month = (column: string) => `strftime('%Y-%m', ${column}, 'unixepoch')`;

export function monthly() {
  const created = db.query(`SELECT ${month("created_at")} month, COUNT(*) pools, COALESCE(SUM(verdict = 0), 0) factoryPools, COALESCE(SUM(verdict = 1), 0) contestedPools,
      COALESCE(SUM(verdict IS NULL), 0) unverifiedPools, COALESCE(SUM(rules LIKE '%volume-farm%'), 0) volumeFarmPools
    FROM pools WHERE created_at >= ? GROUP BY month`).all(DBC_LAUNCH_TIME) as any[];
  const graduated = new Map((db.query(`SELECT ${month("graduated_at")} month, COUNT(*) graduations, COALESCE(SUM(verdict = 0), 0) factoryGraduations,
      COALESCE(SUM(verdict = 1), 0) contestedGraduations, COALESCE(SUM(verdict IS NULL), 0) unverifiedGraduations
    FROM pools WHERE graduated_at >= ? GROUP BY month`).all(DBC_LAUNCH_TIME) as any[]).map((r) => [r.month, r]));
  // Volume-farm finding: SOL volume implied by lifetime fees / starting fee rate, by launch month.
  const volume = new Map((db.query(`SELECT ${month("p.created_at")} month,
      COALESCE(SUM(p.fees_quote * 1e4 / MAX(c.cliff_fee_bps, 1)), 0) / 1e9 feeImpliedVolumeSol,
      COALESCE(SUM(p.fees_quote * 1e4 / MAX(c.cliff_fee_bps, 1)) FILTER (WHERE p.rules LIKE '%volume-farm%'), 0) / 1e9 volumeFarmVolumeSol
    FROM pools p JOIN configs c ON c.address = p.config WHERE p.created_at >= ? AND c.quote_mint = ? GROUP BY month`).all(DBC_LAUNCH_TIME, SOL) as any[])
    .map(({ month, ...v }) => [month, { feeImpliedVolumeSol: Math.round(v.feeImpliedVolumeSol), volumeFarmVolumeSol: Math.round(v.volumeFarmVolumeSol) }]));
  const empty = { graduations: 0, factoryGraduations: 0, contestedGraduations: 0, unverifiedGraduations: 0 };
  return created.map((r) => ({ ...r, ...(graduated.get(r.month) ?? empty), ...volume.get(r.month), month: r.month }));
}

type Pad = { id: string; name: string | null; website: string | null; logo: string | null };
const padOf = (id: string): Pad => ({ id, ...launchpadLabel(id) });

export function launchpadsAllTime() {
  const ttg = medians(`SELECT c.launchpad key, p.graduated_at - p.created_at value FROM pools p JOIN configs c ON c.address = p.config
    WHERE p.graduated_at IS NOT NULL AND p.verdict IS NOT 0 ORDER BY key, value`);
  const post = postGraduationBy("launchpad");
  const rows = db.query(`SELECT c.launchpad id, COUNT(*) pools, COUNT(p.graduated_at) graduations, COALESCE(SUM(p.verdict IS NOT 0), 0) organicPools,
      COALESCE(SUM(p.graduated_at IS NOT NULL AND p.verdict IS NOT 0), 0) organicGraduations, COALESCE(SUM(p.graduated_at IS NOT NULL AND p.verdict = 1), 0) contestedGraduations,
      COALESCE(SUM(p.verdict = 0), 0) uncontestedPools
    FROM pools p JOIN configs c ON c.address = p.config GROUP BY c.launchpad HAVING pools >= ${MIN_SAMPLE}`).all() as any[];
  return Object.fromEntries(rows.map(({ id, uncontestedPools, ...r }: any) => [id as string, {
    factoryShare: uncontestedPools / r.pools, allTime: { ...r, medianSecondsToGraduate: ttg.get(id) ?? null }, postGraduation: post.get(id) ?? null,
  }]));
}

export function launchpads(since: number, allTime: ReturnType<typeof launchpadsAllTime>) {
  const window = db.query(`SELECT c.launchpad id, COALESCE(SUM(p.created_at >= $since), 0) launches, COALESCE(SUM(p.created_at >= $since AND p.verdict IS NOT 0), 0) organicLaunches,
      COALESCE(SUM(p.graduated_at >= $since), 0) graduations, COALESCE(SUM(p.graduated_at >= $since AND p.verdict IS NOT 0), 0) organicGraduations
    FROM pools p JOIN configs c ON c.address = p.config WHERE p.created_at >= $since OR p.graduated_at >= $since GROUP BY c.launchpad`).all({ $since: since }) as any[];
  const inWindow = new Map(window.map(({ id, ...w }) => [id, w]));
  const zero = { launches: 0, organicLaunches: 0, graduations: 0, organicGraduations: 0 };
  const rows = Object.entries(allTime).map(([id, a]) => ({ ...padOf(id), ...a, window: inWindow.get(id) ?? zero }));
  const ranked = rows.toSorted((a, b) => b.window.organicGraduations - a.window.organicGraduations || b.allTime.organicGraduations - a.allTime.organicGraduations);
  const top = ranked.slice(0, LIST_LIMIT);
  // The busiest identities in the window too, so the factories behind raw numbers show up.
  const busiest = rows.toSorted((a, b) => b.window.launches - a.window.launches).slice(0, 10).filter((r) => r.window.launches && !top.includes(r));
  return [...top, ...busiest];
}

type Info = { shape: any; migrationThreshold: number; feeClaimer: string };
const quoteOf = db.prepare("SELECT symbol, decimals FROM mints WHERE mint = ?");
export function quote(mint: string) {
  const m = quoteOf.get(mint) as { symbol: string | null; decimals: number } | null;
  return { mint, symbol: mint === SOL ? "SOL" : mint === USDC ? "USDC" : (m?.symbol ?? null), decimals: mint === SOL ? 9 : mint === USDC ? 6 : (m?.decimals ?? 9) };
}
const templatePrior = db.prepare("SELECT factory, reasons FROM templates WHERE template = ?");
const configRow = db.prepare("SELECT address, quote_mint, threshold, launchpad, info FROM configs WHERE address = ?");

function templateLabel(pad: Pad | null, q: ReturnType<typeof quote>, threshold: number, info: Info) {
  const amount = threshold / 10 ** q.decimals;
  const fee = info.shape.baseFee.startBps / 100;
  return [pad?.name, `${amount >= 1000 ? Math.round(amount).toLocaleString("en-US") : Number(amount.toPrecision(3))} ${q.symbol ?? "tokens"}`, `${Number(fee.toPrecision(3))}% fee`]
    .filter(Boolean).join(" · ");
}

// Template identity for API rows: the busiest described config stands in for its shape and label;
// `describe` collects templates whose configs have not been decoded yet (the server fetches them).
function templateHead(template: string, configs: { address: string; n: number }[], pads: { id: string; n: number }[], describe: Set<string>) {
  const described = configs.map((c) => configRow.get(c.address) as any).find((c) => c?.info);
  if (!described) {
    if (configs[0]) describe.add(configs[0].address);
    return null;
  }
  const info = JSON.parse(described.info) as Info;
  const total = pads.reduce((s, p) => s + p.n, 0);
  const pad = pads[0] && pads[0].n / total > 0.5 ? padOf(pads[0].id) : null;
  const q = quote(described.quote_mint);
  const prior = templatePrior.get(template) as { factory: number; reasons: string } | null;
  return {
    template, label: templateLabel(pad, q, described.threshold, info), shape: info.shape, launchpad: pad ? { id: pad.id, name: pad.name } : null,
    quote: q, threshold: described.threshold, factory: !!prior?.factory, factoryReasons: prior ? (JSON.parse(prior.reasons) as string[]) : [],
    config: described.address,
  };
}

const byContestedOutcome = (a: any, b: any) =>
  Number(b.pools >= MIN_SAMPLE) - Number(a.pools >= MIN_SAMPLE) || (b.organicGradRate ?? -1) - (a.organicGradRate ?? -1) || b.pools - a.pools;

function groupRows<T extends { template: string }>(rows: T[]) {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.template, [...(out.get(r.template) ?? []), r]);
  return out;
}

export function templates(since: number, organicOnly: boolean, describe = new Set<string>()) {
  const rows = db.query(`SELECT c.template, COUNT(*) pools, COUNT(p.graduated_at) graduated, COALESCE(SUM(p.verdict IS NOT 0), 0) organicPools,
      COALESCE(SUM(p.graduated_at IS NOT NULL AND p.verdict IS NOT 0), 0) organicGraduated
    FROM pools p JOIN configs c ON c.address = p.config WHERE p.created_at >= ? GROUP BY c.template`).all(since) as any[];
  const ttg = medians(`SELECT c.template key, p.graduated_at - p.created_at value FROM pools p JOIN configs c ON c.address = p.config
    WHERE p.created_at >= ${since} AND p.graduated_at IS NOT NULL AND p.verdict IS NOT 0 ORDER BY key, value`);
  const configs = groupRows(db.query(`SELECT c.template, c.address, COUNT(*) n FROM pools p JOIN configs c ON c.address = p.config
    WHERE p.created_at >= ? GROUP BY c.address ORDER BY n DESC`).all(since) as { template: string; address: string; n: number }[]);
  const pads = groupRows(db.query(`SELECT c.template, c.launchpad id, COUNT(*) n FROM pools p JOIN configs c ON c.address = p.config
    WHERE p.created_at >= ? GROUP BY c.template, c.launchpad ORDER BY n DESC`).all(since) as { template: string; id: string; n: number }[]);
  const post = postGraduationBy("template");
  const out = [];
  for (const r of rows) {
    const gradRate = r.graduated / r.pools;
    const organicGradRate = r.organicPools >= MIN_RATE_SAMPLE ? r.organicGraduated / r.organicPools : null;
    const prior = templatePrior.get(r.template) as { factory: number } | null;
    if (organicOnly && (prior?.factory || !r.organicPools)) continue;
    out.push({ ...r, gradRate, organicGradRate });
  }
  const ranked = out.sort(byContestedOutcome);
  const result = [];
  for (const r of ranked) {
    if (result.length === LIST_LIMIT) break;
    const head = templateHead(r.template, configs.get(r.template) ?? [], pads.get(r.template) ?? [], describe);
    if (head) result.push({ ...head, ...r, medianSecondsToGraduate: ttg.get(r.template) ?? null, postGraduation: post.get(r.template) ?? null });
  }
  return result;
}

// P(graduate | pool reached X% of its threshold) per template, from settled pools watched from creation
// in real time (live stream or archive), the only ones whose peak reserve is known: history pools carry
// their reserve at backfill time and RPC replays only cover graduations, both of which would inflate odds.
export function odds() {
  const counts = new Map<string, { reached: number[]; graduated: number[] }>();
  const rows = db.query(`SELECT c.template, MIN(CAST(p.max_reserve AS REAL) / c.threshold, 1) progress, p.graduated_at IS NOT NULL graduated
    FROM pool_evidence e JOIN pools p ON p.address = e.pool JOIN configs c ON c.address = p.config
    WHERE e.complete = 1 AND e.source IN ('live', 'archive') AND c.threshold > 0
      AND (p.graduated_at IS NOT NULL OR COALESCE(p.last_trade_at, p.created_at) < ?)`).iterate(now() - SETTLE_SECONDS);
  for (const r of rows as IterableIterator<{ template: string; progress: number; graduated: number }>) {
    let c = counts.get(r.template);
    if (!c) counts.set(r.template, (c = { reached: PROGRESS_STEPS.map(() => 0), graduated: PROGRESS_STEPS.map(() => 0) }));
    PROGRESS_STEPS.forEach((step, i) => {
      if (!r.graduated && r.progress < step) return;
      c.reached[i]++;
      if (r.graduated) c.graduated[i]++;
    });
  }
  return Object.fromEntries([...counts].map(([t, c]) => [t, PROGRESS_STEPS.map((step, i) => ({ step, reached: c.reached[i], graduated: c.graduated[i] }))]));
}

// Buckets of the migration threshold in whole quote units; the last one is open-ended.
const BUCKETS: Record<string, number[]> = { SOL: [0, 1, 5, 15, 40, 80, 150], USDC: [0, 1_000, 5_000, 15_000, 40_000, 80_000, 150_000] };

export function benchmarkBuckets(symbol: string) {
  const edges = BUCKETS[symbol];
  const decimals = quote(QUOTE_MINTS[symbol]).decimals;
  const buckets = edges.map((min, i) => ({ min, max: edges[i + 1] ?? null, pools: 0, organicPools: 0, graduated: 0, organicGraduated: 0, ttg: [] as number[] }));
  const rows = db.query(`SELECT c.threshold, p.graduated_at - p.created_at ttg, p.verdict FROM pools p JOIN configs c ON c.address = p.config
    WHERE c.quote_mint = ?`).iterate(QUOTE_MINTS[symbol]);
  for (const r of rows as IterableIterator<{ threshold: number; ttg: number | null; verdict: number | null }>) {
    const units = r.threshold / 10 ** decimals;
    const b = buckets.findLast((x) => units >= x.min)!;
    const organic = r.verdict !== 0;
    b.pools++;
    if (organic) b.organicPools++;
    if (r.ttg !== null) {
      b.graduated++;
      if (organic) {
        b.organicGraduated++;
        b.ttg.push(r.ttg);
      }
    }
  }
  return buckets.map(({ ttg, ...b }) => ({ ...b, medianSecondsToGraduate: ttg.length ? ttg.sort((x, y) => x - y)[ttg.length >> 1] : null }));
}

export function similar(buckets: ReturnType<typeof benchmarkBuckets>, threshold: number) {
  const b = buckets.findLast((x) => threshold >= x.min) ?? buckets[0];
  return {
    sample: b.pools, organicSample: b.organicPools, gradRate: b.pools ? b.graduated / b.pools : null,
    organicGradRate: b.organicPools ? b.organicGraduated / b.organicPools : null, medianSecondsToGraduate: b.medianSecondsToGraduate,
    byThreshold: buckets.map(({ medianSecondsToGraduate, ...x }) => x),
  };
}

const templateConfigs = db.prepare(`SELECT c.address, COUNT(p.address) pools, COUNT(p.graduated_at) graduated, c.info
  FROM configs c LEFT JOIN pools p ON p.config = c.address WHERE c.template = ? GROUP BY c.address ORDER BY pools DESC LIMIT 12`);
const templatePads = db.prepare(`SELECT c.launchpad id, COUNT(*) n FROM configs c WHERE c.template = ? GROUP BY c.launchpad ORDER BY n DESC LIMIT 5`);
const templateRecent = db.prepare(`SELECT p.address, p.name, p.symbol, p.base_mint, p.created_at, p.graduated_at,
    MIN(CAST(p.max_reserve AS REAL) / NULLIF(c.threshold, 0), 1) peak
  FROM configs c JOIN pools p ON p.config = c.address WHERE c.template = ? ORDER BY p.created_at DESC LIMIT 25`);

export function templateDetail(id: string, oddsByTemplate: Record<string, unknown>, describe = new Set<string>()) {
  const configs = templateConfigs.all(id) as any[];
  if (!configs.length) return null;
  const head = templateHead(id, configs.map((c) => ({ address: c.address, n: c.pools })), templatePads.all(id) as any[], describe);
  const top = configs.filter((c) => c.info).slice(0, 3);
  configs.slice(0, 3).filter((c) => !c.info).forEach((c) => describe.add(c.address));
  if (!head || !top.length) return null;
  const recent = (templateRecent.all(id) as any[]).map((p) => {
    const j = judgementOf(p.address);
    return { ...p, ...(j && verdictFields(j)), postGraduation: p.graduated_at ? postGraduationOf(p.address) : null };
  });
  return {
    template: id, label: head.label, shape: head.shape, factory: head.factory, factoryReasons: head.factoryReasons,
    configs: top.map((c) => ({ address: c.address, pools: c.pools, graduated: c.graduated, info: JSON.parse(c.info) })),
    odds: oddsByTemplate[id] ?? PROGRESS_STEPS.map((step) => ({ step, reached: 0, graduated: 0 })), recent,
  };
}

// Worker loop: windowed lists every minute, all-time aggregates and hot template details every 10.
declare const self: Worker;
if (!Bun.isMainThread) {
  const post = (key: string, value: unknown) => self.postMessage({ key, value });
  let allTime: ReturnType<typeof launchpadsAllTime> | null = null;
  let oddsByTemplate: Record<string, unknown> = {};
  for (let round = 0; ; round++) {
    const started = performance.now();
    const describe = new Set<string>();
    try {
      if (round % 10 === 0) {
        post("monthly", monthly());
        allTime = launchpadsAllTime();
        oddsByTemplate = odds();
        post("odds", oddsByTemplate);
        for (const symbol of Object.keys(BUCKETS)) post(`benchmarks:${symbol}`, benchmarkBuckets(symbol));
      }
      const listed = new Set<string>();
      for (const w of WINDOWS) {
        post(`launchpads:${w}`, launchpads(now() - w, allTime!));
        for (const organic of [false, true]) {
          const rows = templates(now() - w, organic, describe);
          rows.slice(0, 20).forEach((t) => listed.add(t.template));
          post(`templates:${w}:${organic ? 1 : 0}`, rows);
        }
      }
      if (round % 10 === 0) for (const id of listed) post(`template:${id}`, templateDetail(id, oddsByTemplate, describe));
      post("describe", [...describe]);
      post("round", { round, seconds: Math.round((performance.now() - started) / 1000) });
    } catch (e) {
      console.error("aggregates", e);
    }
    await Bun.sleep(60_000);
  }
}
