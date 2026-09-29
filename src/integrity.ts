import { db } from "./store";

// Contested vs uncontested graduations. Template and launchpad verdicts are priors computed from
// history, each with the evidence values behind it; pool-level evidence overrides them where it
// exists. Bump RULES_VERSION whenever a rule or threshold changes.
export const RULES_VERSION = 1;

const SOL = "So11111111111111111111111111111111111111112";
const DEFAULT_PUBKEY = "11111111111111111111111111111111";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111"; // burns leftovers for 200 unrelated fee claimers

// Curated identities (research/dbc-landscape.md §1.5, §2.1). They win over self-declared on-chain
// PartnerMetadata names.
export const LAUNCHPAD_LABELS: Record<string, { name: string; website?: string }> = {
  BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv: { name: "Bags", website: "https://bags.fm" },
  "5wkyL2FLEcyUUgc3UeGntHTAfWfzDrVuxMnaMm7792Gk": { name: "Moonshot" },
  CWcERiVd7xkUrcJK5QBdcKC5GG8JMATMLNHtCEUguwPz: { name: "Jupiter Studio" },
  E8QjCz3aX31Qk6ieEYzfVsfqmT3dbTaTEABwUUgZVGWL: { name: "Jupiter Studio" },
  "9supzj2Nbnjut3r9UFfWE2RiuAenQMoYaNtZXmmtm5oC": { name: "Believe" },
  "82VbBzGtb8v5wFx1TM6iaMmLyRSLy8WeqA123orjHGzL": { name: "Printr" },
  A9z3ngVK4aSRdCR8i6F2wQh9EbH7CPojyvZuBRxNot8o: { name: "trends.fun", website: "https://trends.fun" },
  BKPxAdgwPHXE3ZPZt5XsAovDgUaUufHgZnSAZ3eRWQNW: { name: "Anoncoin" },
  Fbz8Y9Yg6TkAgA7beWj8eqog3qF6XTrm8xSBuL7FphUW: { name: "daos.fun", website: "https://daos.fun" },
  Aefrfa3ffaznptazDaDnAPK624UwvkujhJTWBCcCSofv: { name: "SOAR", website: "https://launchonsoar.com" },
  "116HTnNMXBLL6LCQ1qAQEZ7E9bDXSJjV6hnZsziospk": { name: "Forge" },
  GZjYfGyUNQfDChcQ66Gc3ZMcQqPEisyRYe1nPyQhP9bp: { name: "Ember Curve", website: "https://embercurve.fun" },
  "1kRMrKuuZhFW26Jt2woYreCKFu54atpaNuQ1wP3CXry": { name: "EasyA Kickstart" },
  "9RaoVypDNRDgy7tLLVPrJRzuR219P5ZxZ46F2TmzJpYc": { name: "bingan", website: "https://bingan.app" },
  "5x2DYtWmhT4SV2jkpTa561DVdkX8mrUi9y5AxkCCjaxN": { name: "RevShare", website: "https://revshare.dev" },
  FG75GTSYMimybJUBEcu6LkcNqm7fkga1iMp3v4nKnDQS: { name: "CyreneAI" },
  HW2Cg9ZYRGZRzXfdgc1pgGxdYduyVvYrYkg1H2PVLo1H: { name: "time.fun", website: "https://time.fun" },
  CFEEFQgVcTFNGgZ497y2wDPuZDYg1h4hNjoQ35mLGFZx: { name: "Candle" },
  GWtwk158mxsiUuy3Nw91rjQRNnra4foFXRt6ek3wFPT: { name: "Orynth" },
};

const partnerRow = db.prepare("SELECT name, website, logo, jupiter FROM partners WHERE address = ?");

// Curated name, else Jupiter's launchpad tag (not its unbranded "met-dbc" bucket), else the name the
// fee claimer declared on-chain.
export function launchpadLabel(id: string) {
  const curated = LAUNCHPAD_LABELS[id];
  const p = partnerRow.get(id) as { name: string | null; website: string | null; logo: string | null; jupiter: string | null } | null;
  const jupiter = p?.jupiter && p.jupiter !== "met-dbc" ? p.jupiter : null;
  return { name: curated?.name ?? jupiter ?? p?.name ?? null, website: curated?.website ?? p?.website ?? null, logo: p?.logo ?? null };
}

// Launchpads that mint a fee claimer per token keep a single leftover receiver (Bags: 167k fee
// claimers, one receiver). A receiver shared by this many distinct fee claimers is the identity.
const PER_TOKEN_CLAIMERS = 20;

export function assignLaunchpads() {
  db.query(`UPDATE configs SET launchpad = CASE WHEN leftover_receiver IN (
      SELECT leftover_receiver FROM configs WHERE leftover_receiver NOT IN ($default, $burn)
      GROUP BY leftover_receiver HAVING COUNT(DISTINCT fee_claimer) >= $min)
    THEN leftover_receiver ELSE fee_claimer END`).run({ $default: DEFAULT_PUBKEY, $burn: INCINERATOR, $min: PER_TOKEN_CLAIMERS });
}

// Pool evidence: curve completed within a second of creation. Creation times are exact for these
// (timestamp activation, or the block time of the activation slot; see backfill.ts).
export const SAME_SLOT_SECONDS = 1;

// Shared by stats queries: `p` pools, `c` configs, `t` template prior, `l` launchpad prior.
export const POOL_JOINS = `FROM pools p JOIN configs c ON c.address = p.config
  LEFT JOIN templates t ON t.template = c.template LEFT JOIN launchpads l ON l.id = c.launchpad`;
export const SAME_SLOT = `COALESCE(p.graduated_at - p.created_at <= ${SAME_SLOT_SECONDS}, 0)`;
// Not an organic launch / uncontested graduation: pool evidence, else the template or launchpad prior.
export const FACTORY = `(${SAME_SLOT} OR COALESCE(t.factory, 0) OR COALESCE(l.factory, 0))`;
// Priors. Template graduation rates are bimodal (templates with 20+ pools: 1,046 under 5%, 308 at
// 95%+, 138 in between), and organic launches graduate at a few percent, so 80%+ over 20+ pools
// does not happen by chance (binomial, p = 0.1: < 1e-9).
const MIN_POOLS = 20;
const AUTO_COMPLETE_RATE = 0.8;
const SAME_SLOT_SHARE = 0.5;
const SUB_THRESHOLD_LAMPORTS = 1e9;
// The 1-bps fee era (until v0.1.7 raised the minimum to 25 bps): big templates that never graduate.
const VOLUME_FARM = { pools: 200, rate: 0.01, maxFeeBps: 1 };

type Evidence = {
  pools: number; graduated: number; gradRate: number; sameSlot: number; sameSlotShare: number | null;
  medianSecondsToGraduate: number | null; creators: number; feesQuote: number;
  quoteMint: string; threshold: number; cliffFeeBps: number;
};

const pct = (x: number) => (x === 1 ? "100%" : `${(x * 100).toFixed(1)}%`);

function priorReasons(e: Evidence, isTemplate: boolean) {
  const reasons: string[] = [];
  if (isTemplate && e.quoteMint === SOL && e.threshold < SUB_THRESHOLD_LAMPORTS)
    reasons.push(`sub-1-SOL threshold: ${e.threshold / 1e9} SOL buys the whole curve`);
  if (e.pools >= MIN_POOLS && e.gradRate >= AUTO_COMPLETE_RATE)
    reasons.push(`auto-completing: ${pct(e.gradRate)} of ${e.pools.toLocaleString("en-US")} pools graduated`);
  if (e.graduated >= MIN_POOLS && e.sameSlotShare !== null && e.sameSlotShare >= SAME_SLOT_SHARE)
    reasons.push(`completes at creation: ${pct(e.sameSlotShare)} of graduations within ${SAME_SLOT_SECONDS}s of launch`);
  if (isTemplate && e.pools >= VOLUME_FARM.pools && e.gradRate < VOLUME_FARM.rate && e.cliffFeeBps <= VOLUME_FARM.maxFeeBps)
    reasons.push(`volume farm: ${e.cliffFeeBps} bps fee, ${e.graduated} of ${e.pools.toLocaleString("en-US")} pools graduated`);
  return reasons;
}

// Median of `value` per key, from rows ordered by key then value.
function medians(sql: string) {
  const out = new Map<string, number>();
  let key: string | null = null;
  let values: number[] = [];
  const flush = () => key !== null && out.set(key, values[Math.floor(values.length / 2)]);
  for (const row of db.query(sql).iterate() as IterableIterator<{ key: string; value: number }>) {
    if (row.key !== key) {
      flush();
      key = row.key;
      values = [];
    }
    values.push(row.value);
  }
  flush();
  return out;
}

function evidenceBy(column: "template" | "launchpad") {
  const ttg = medians(`SELECT c.${column} key, p.graduated_at - p.created_at value FROM pools p JOIN configs c ON c.address = p.config
    WHERE p.graduated_at IS NOT NULL ORDER BY key, value`);
  const rows = db.query(`SELECT c.${column} key, COUNT(*) pools, COUNT(p.graduated_at) graduated,
      SUM(${SAME_SLOT}) same_slot, COUNT(DISTINCT p.creator) creators,
      COALESCE(SUM(p.fees_quote), 0) fees_quote, MIN(c.quote_mint) quote_mint, MIN(c.threshold) threshold, MAX(c.cliff_fee_bps) cliff_fee_bps
    FROM pools p JOIN configs c ON c.address = p.config GROUP BY key`).all() as any[];
  return rows.map((r): [string, Evidence] => [r.key, {
    pools: r.pools, graduated: r.graduated, gradRate: r.graduated / r.pools, sameSlot: r.same_slot,
    sameSlotShare: r.graduated ? r.same_slot / r.graduated : null, medianSecondsToGraduate: ttg.get(r.key) ?? null,
    creators: r.creators, feesQuote: r.fees_quote, quoteMint: r.quote_mint, threshold: r.threshold, cliffFeeBps: r.cliff_fee_bps,
  }]);
}

// Recomputes every template and launchpad prior from history. Launchpads keep identities with enough
// pools to judge, plus every leftover-receiver identity (saveConfig looks those up for new configs).
export function classify() {
  assignLaunchpads();
  const viaLeftover = new Set(
    db.query("SELECT DISTINCT launchpad FROM configs WHERE launchpad = leftover_receiver AND fee_claimer != leftover_receiver").values().flat(),
  );
  const templates = evidenceBy("template");
  const launchpads = evidenceBy("launchpad").filter(([id, e]) => e.pools >= MIN_POOLS || viaLeftover.has(id));
  const saveTemplate = db.prepare("INSERT INTO templates (template, factory, reasons, evidence) VALUES (?, ?, ?, ?)");
  const saveLaunchpad = db.prepare("INSERT INTO launchpads (id, via, factory, reasons, evidence) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.exec("DELETE FROM templates; DELETE FROM launchpads");
    for (const [id, e] of templates) {
      const reasons = priorReasons(e, true);
      saveTemplate.run(id, reasons.length ? 1 : 0, JSON.stringify(reasons), JSON.stringify(e));
    }
    for (const [id, e] of launchpads) {
      const reasons = priorReasons(e, false);
      const via = viaLeftover.has(id) ? "leftover_receiver" : "fee_claimer";
      saveLaunchpad.run(id, via, reasons.length ? 1 : 0, JSON.stringify(reasons), JSON.stringify(e));
    }
  })();
  return { templates: templates.length, launchpads: launchpads.length };
}
