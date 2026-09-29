import { evidenceOf, type Evidence as PoolEvidence } from "./evidence";
import { db } from "./store";

// Contested vs uncontested vs unverified. Pool rules judge a pool from its own transactions (and from
// account state: completion time, threshold); template and launchpad verdicts are priors computed from
// history, used only for pools without transaction evidence. RULES is the single source of truth for
// thresholds (served at /api/rules); bump RULES_VERSION whenever a rule or threshold changes.
export const RULES_VERSION = 3;

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
  BSs3K3uAa3XqwqdwWD7KM7TUXBAnvzkrXwQoFwkKdt1R: { name: "Perpspad" },
};

// Launchpads that mint a fresh fee claimer and leftover receiver per config but co-sign every config
// creation with one key (research/receipts.md: Perpspad since 2026-09-12). configs.signer holds the key.
export const OPERATOR_KEYS = ["BSs3K3uAa3XqwqdwWD7KM7TUXBAnvzkrXwQoFwkKdt1R"];

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
  db.query(`UPDATE configs SET launchpad = CASE WHEN signer IN (SELECT value FROM json_each($operators)) THEN signer
    WHEN leftover_receiver IN (
      SELECT leftover_receiver FROM configs WHERE leftover_receiver NOT IN ($default, $burn)
      GROUP BY leftover_receiver HAVING COUNT(DISTINCT fee_claimer) >= $min)
    THEN leftover_receiver ELSE fee_claimer END`).run({ $default: DEFAULT_PUBKEY, $burn: INCINERATOR, $min: PER_TOKEN_CLAIMERS, $operators: JSON.stringify(OPERATOR_KEYS) });
}

// Pool rules. Completion within a second of creation: creation times from account state are exact for
// these (timestamp activation, or the block time of the activation slot; see backfill.ts).
export const SAME_SLOT_SECONDS = 1;
const CREATOR_FILL = 0.5;
const FEW_BUYERS = 3;
const NON_CREATOR_VOLUME = 0.5;
const SUB_THRESHOLD_SOL = 1;
// Funding source (funding.ts): at least this many of the largest buyers funded by one wallet (one or two
// hops, shortly before buying), together this share of the largest buyers' volume.
export const SWARM = { buyers: 3, share: 0.5 };
// Priors. Template graduation rates are bimodal (templates with 20+ pools: 1,046 under 5%, 308 at
// 95%+, 138 in between), and organic launches graduate at a few percent, so 80%+ over 20+ pools
// does not happen by chance (binomial, p = 0.1: < 1e-9).
const MIN_POOLS = 20;
const AUTO_COMPLETE_RATE = 0.8;
const SAME_SLOT_SHARE = 0.5;
// The 1-bps fee era (until v0.1.7 raised the minimum to 25 bps): big templates that never graduate.
const VOLUME_FARM = { pools: 200, rate: 0.01, maxFeeBps: 1 };

// Post-graduation: a DAMM v2 pool counts as alive while it holds at least this much liquidity (USD).
export const ALIVE_LIQUIDITY_USD = 1000;

const pct = (x: number) => (x === 1 ? "100%" : x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`);
const count = (n: number) => n.toLocaleString("en-US");

export const RULES = [
  { id: "same-slot", name: "Same-slot completion", threshold: "creation slot", description: "The curve completed in the slot it was created in." },
  {
    id: "creator-fill", name: "Creator fill", threshold: `>= ${pct(CREATOR_FILL)} of threshold`,
    description: "The creator or the wallet that signed the creation filled this much of the curve in the creation slot. A small dev first-buy is fine.",
  },
  {
    id: "bundle-fill", name: "Creation-slot fill", threshold: `>= ${pct(CREATOR_FILL)} of threshold`,
    description: "Buys bundled into the creation slot, by any wallets, left the curve this full.",
  },
  { id: "few-buyers", name: "Few buyers", threshold: `<= ${FEW_BUYERS} wallets`, description: "The curve completed with this few distinct buyers." },
  {
    id: "funded-swarm", name: "Funded swarm", threshold: `>= ${SWARM.buyers} buyers, >= ${pct(SWARM.share)} of the largest buyers' volume`,
    description: "Many buyers, one source: the largest buyers (up to 12, by amount bought) were funded with SOL by the same wallet, directly or one wallet removed, within a day before buying. Exchanges and other hubs don't count unless they co-signed the buys.",
  },
  {
    id: "creator-volume", name: "Creator volume", threshold: `< ${pct(NON_CREATOR_VOLUME)} from others`,
    description: "Most trading volume before graduation came from the creator side.",
  },
  { id: "sub-1-sol", name: "Sub-1-SOL threshold", threshold: `< ${SUB_THRESHOLD_SOL} SOL`, description: "The curve completes on a trivial buy." },
  {
    id: "volume-farm", name: "Volume farm", threshold: `>= ${VOLUME_FARM.pools} pools, < ${pct(VOLUME_FARM.rate)} graduate, <= ${VOLUME_FARM.maxFeeBps} bps fee`,
    description: "Templates launched in bulk at a near-zero fee where almost no pool ever graduates.",
  },
  {
    id: "template-prior", name: "Template prior", threshold: `>= ${MIN_POOLS} pools, >= ${pct(AUTO_COMPLETE_RATE)} completed`,
    description: `Only for pools without transaction evidence: the template auto-completes (or >= ${pct(SAME_SLOT_SHARE)} complete at creation).`,
  },
  {
    id: "launchpad-prior", name: "Launchpad prior", threshold: `>= ${MIN_POOLS} pools, >= ${pct(AUTO_COMPLETE_RATE)} completed`,
    description: "The same prior for the launchpad identity behind the config.",
  },
  {
    id: "contested", name: "Contested", threshold: `> ${FEW_BUYERS} buyers, no rule fired`,
    description: "Transactions seen from creation, independent buyers, no rule fired. No evidence and no rule: unverified.",
  },
  {
    id: "alive", name: "Alive after graduation", threshold: `>= $${ALIVE_LIQUIDITY_USD.toLocaleString("en-US")} liquidity, trading`,
    description: "Not a verdict rule: the DAMM v2 pool still holds this much liquidity and earns fees at +1d / +7d.",
  },
];

type Stats = {
  pools: number; graduated: number; gradRate: number; sameSlot: number; sameSlotShare: number | null;
  medianSecondsToGraduate: number | null; creators: number; feesQuote: number;
  quoteMint: string; threshold: number; cliffFeeBps: number;
};

function priorReasons(e: Stats, isTemplate: boolean) {
  const reasons: [string, string][] = [];
  const prior = isTemplate ? "template-prior" : "launchpad-prior";
  if (isTemplate && e.quoteMint === SOL && e.threshold < SUB_THRESHOLD_SOL * 1e9)
    reasons.push(["sub-1-sol", `sub-1-SOL threshold: ${e.threshold / 1e9} SOL buys the whole curve`]);
  if (e.pools >= MIN_POOLS && e.gradRate >= AUTO_COMPLETE_RATE)
    reasons.push([prior, `auto-completing: ${pct(e.gradRate)} of ${count(e.pools)} pools graduated`]);
  if (e.graduated >= MIN_POOLS && e.sameSlotShare !== null && e.sameSlotShare >= SAME_SLOT_SHARE)
    reasons.push([prior, `completes at creation: ${pct(e.sameSlotShare)} of graduations within ${SAME_SLOT_SECONDS}s of launch`]);
  if (isTemplate && e.pools >= VOLUME_FARM.pools && e.gradRate < VOLUME_FARM.rate && e.cliffFeeBps <= VOLUME_FARM.maxFeeBps)
    reasons.push(["volume-farm", `volume farm: ${e.cliffFeeBps} bps fee, ${e.graduated} of ${count(e.pools)} pools graduated`]);
  return reasons;
}

// Median of `value` per key, from rows ordered by key then value.
export function medians(sql: string) {
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

function statsBy(column: "template" | "launchpad") {
  const ttg = medians(`SELECT c.${column} key, p.graduated_at - p.created_at value FROM pools p JOIN configs c ON c.address = p.config
    WHERE p.graduated_at IS NOT NULL ORDER BY key, value`);
  const rows = db.query(`SELECT c.${column} key, COUNT(*) pools, COUNT(p.graduated_at) graduated,
      SUM(COALESCE(p.graduated_at - p.created_at <= ${SAME_SLOT_SECONDS}, 0)) same_slot, COUNT(DISTINCT p.creator) creators,
      COALESCE(SUM(p.fees_quote), 0) fees_quote, MIN(c.quote_mint) quote_mint, MIN(c.threshold) threshold, MAX(c.cliff_fee_bps) cliff_fee_bps
    FROM pools p JOIN configs c ON c.address = p.config GROUP BY key`).all() as any[];
  return rows.map((r): [string, Stats] => [r.key, {
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
  const templates = statsBy("template");
  const launchpads = statsBy("launchpad").filter(([id, e]) => e.pools >= MIN_POOLS || viaLeftover.has(id));
  const saveTemplate = db.prepare("INSERT INTO templates (template, factory, reasons, rules, evidence) VALUES (?, ?, ?, ?, ?)");
  const saveLaunchpad = db.prepare("INSERT INTO launchpads (id, via, factory, reasons, rules, evidence) VALUES (?, ?, ?, ?, ?, ?)");
  const columns = (reasons: [string, string][]) => [reasons.length ? 1 : 0, JSON.stringify(reasons.map((r) => r[1])), JSON.stringify(reasons.map((r) => r[0]))] as const;
  db.transaction(() => {
    db.exec("DELETE FROM templates; DELETE FROM launchpads");
    for (const [id, e] of templates) saveTemplate.run(id, ...columns(priorReasons(e, true)), JSON.stringify(e));
    for (const [id, e] of launchpads) saveLaunchpad.run(id, viaLeftover.has(id) ? "leftover_receiver" : "fee_claimer", ...columns(priorReasons(e, false)), JSON.stringify(e));
  }).immediate();
  return { templates: templates.length, launchpads: launchpads.length, ...judgeAll() };
}

export type Prior = { rules: string[]; reasons: string[] };
export type Funding = {
  sampled: number; traced: number; funder: string | null; hops: number | null; buyers: number; share: number; pool_share: number; creator: number;
  cosigned: number; receipts: string;
};
export type PoolFacts = {
  createdAt: number | null; graduatedAt: number | null; quoteMint: string; threshold: number; decimals: number;
  template: Prior | null; launchpad: Prior | null; funding?: Funding | null;
};
export type Signals = {
  creatorFillPct: number | null; creationSlotFillPct: number | null; distinctBuyers: number | null;
  nonCreatorVolumePct: number | null; sameSlotCompletion: boolean | null; thresholdQuote: number; fundedSwarmPct: number | null;
};
export type Judgement = {
  verdict: "contested" | "uncontested" | "unverified"; rules: string[]; reasons: string[];
  evidence: Record<string, string>; signals: Signals; receipts: string[];
};

// One pool's verdict. Pool rules fire from transaction evidence (only counted when it covers the pool
// from creation) and account state; priors apply only when there is no transaction evidence.
export function judge(f: PoolFacts, ev: PoolEvidence | null): Judgement {
  // creation: the creation slot was seen (fills exact); complete: the whole life was seen (counts exact too).
  const creation = ev?.complete ? ev : null;
  const complete = creation && !creation.partial ? creation : null;
  const graduated = f.graduatedAt !== null;
  const volume = complete ? complete.buy_volume + complete.sell_volume : 0;
  const signals: Signals = {
    // Net fills can pass 100% when others sold in the same slot; a curve can't be more than full.
    creatorFillPct: creation && f.threshold ? Math.min(Math.max(creation.creator_fill, 0) / f.threshold, 1) : null,
    creationSlotFillPct: creation && f.threshold ? Math.min(creation.slot_fill / f.threshold, 1) : null,
    distinctBuyers: complete ? complete.buyers : null,
    nonCreatorVolumePct: complete && volume ? 1 - complete.creator_volume / volume : null,
    sameSlotCompletion: !graduated ? (complete ? false : null)
      : creation?.completion_slot != null ? creation.completion_slot === creation.creation_slot
      : f.createdAt !== null ? f.graduatedAt! - f.createdAt <= SAME_SLOT_SECONDS : null,
    thresholdQuote: f.threshold / 10 ** f.decimals,
    fundedSwarmPct: complete && f.funding ? f.funding.share : null,
  };
  const rules: string[] = [];
  const reasons: string[] = [];
  const evidence: Record<string, string> = {};
  const firedKeys = new Set<string>();
  const fundingReceipts: string[] = [];
  const fire = (rule: string, reason: string, key: string) => (rules.push(rule), reasons.push(reason), firedKeys.add(key));
  // Evidence behind a verdict first, the rest after it.
  const result = (verdict: Judgement["verdict"]): Judgement => ({
    verdict, rules: [...new Set(rules)], reasons, signals, receipts,
    evidence: Object.fromEntries(Object.entries(evidence).sort(([a], [b]) => Number(firedKeys.has(b)) - Number(firedKeys.has(a)))),
  });

  if (signals.sameSlotCompletion) {
    evidence["same-slot completion"] = creation?.completion_slot != null ? `slot ${count(creation.completion_slot)}` : `completed within ${SAME_SLOT_SECONDS}s of launch`;
    fire("same-slot", `same-slot completion (${evidence["same-slot completion"]})`, "same-slot completion");
  }
  if (signals.creatorFillPct !== null) {
    evidence["creator fill"] = `${pct(signals.creatorFillPct)} of the threshold in the creation slot`;
    if (signals.creatorFillPct >= CREATOR_FILL) fire("creator-fill", `creator fill ${evidence["creator fill"]}`, "creator fill");
  }
  if (signals.creationSlotFillPct !== null && signals.creationSlotFillPct >= CREATOR_FILL && !rules.includes("creator-fill")) {
    evidence["creation-slot fill"] = `${pct(signals.creationSlotFillPct)} of the threshold, bundled with the launch`;
    fire("bundle-fill", `creation-slot fill ${evidence["creation-slot fill"]}`, "creation-slot fill");
  }
  if (signals.distinctBuyers !== null) {
    evidence["distinct buyers"] = `${count(signals.distinctBuyers)}${graduated ? " before graduation" : " so far"}`;
    if (graduated && signals.distinctBuyers <= FEW_BUYERS) fire("few-buyers", `${signals.distinctBuyers} distinct buyers`, "distinct buyers");
  }
  if (signals.nonCreatorVolumePct !== null) {
    evidence["volume from non-creators"] = pct(signals.nonCreatorVolumePct);
    if (graduated && signals.nonCreatorVolumePct < NON_CREATOR_VOLUME) fire("creator-volume", `only ${pct(signals.nonCreatorVolumePct)} of volume from non-creators`, "volume from non-creators");
  }
  const funding = complete ? f.funding : null;
  if (funding) {
    const by = funding.funder
      ? `${funding.creator ? "the creator " : ""}${funding.funder.slice(0, 4)}…${funding.funder.slice(-4)}${funding.hops === 2 ? " (two hops)" : ""}${funding.cosigned ? ", which co-signed their buys" : ""}`
      : null;
    evidence["funding source"] = by
      ? `${funding.buyers} of the ${funding.sampled} largest buyers funded by ${by}: ${pct(funding.share)} of their volume, ${pct(funding.pool_share)} of all buy volume`
      : `no common funder among the ${funding.sampled} largest buyers (${funding.traced} traced)`;
    if (graduated && funding.buyers >= SWARM.buyers && funding.share >= SWARM.share) {
      fire("funded-swarm", `funded swarm: ${evidence["funding source"]}`, "funding source");
      fundingReceipts.push(...(JSON.parse(funding.receipts) as string[]));
    }
  }
  if (f.quoteMint === SOL && f.threshold < SUB_THRESHOLD_SOL * 1e9) {
    evidence.threshold = `${signals.thresholdQuote} SOL`;
    fire("sub-1-sol", `threshold ${evidence.threshold}`, "threshold");
  }
  const farm = f.template?.rules.indexOf("volume-farm") ?? -1;
  if (farm >= 0) {
    evidence["volume farm"] = f.template!.reasons[farm].replace("volume farm: ", "");
    fire("volume-farm", f.template!.reasons[farm], "volume farm");
  }
  const receipts = creation ? [...new Set([creation.creation_sig, creation.creator_fill_sig, creation.completion_sig, ...fundingReceipts].filter((s) => s !== null))] : [];
  if (rules.length) return result("uncontested");
  // Priors don't decide against transaction evidence, but stay visible next to it, marked as outweighed.
  const priorNotes = () =>
    ([[f.template, "template"], [f.launchpad, "launchpad"]] as const).forEach(([prior, name]) =>
      prior?.rules.forEach((rule, i) => rule === `${name}-prior` && (evidence[`${name} prior (outweighed by transactions)`] ??= prior.reasons[i])),
    );
  if (complete && complete.buyers > FEW_BUYERS) {
    priorNotes();
    return result("contested");
  }

  for (const [prior, name] of [[f.template, "template"], [f.launchpad, "launchpad"]] as const) {
    prior?.rules.forEach((rule, i) => {
      if (rule !== `${name}-prior`) return;
      evidence[name] = prior.reasons[i];
      fire(rule, `${name} ${prior.reasons[i]}`, name);
    });
  }
  if (rules.length) return result("uncontested");
  evidence.transactions = complete ? `${complete.buyers} buyer${complete.buyers === 1 ? "" : "s"} so far`
    : creation ? "creation slot replayed; later trades not replayed" : "not replayed yet";
  return result("unverified");
}

const VERDICT_CODE = { contested: 1, uncontested: 0, unverified: null } as const;

// API fields for a judgement: `contested` is null when unverified; organic/reasons are the v2 aliases.
export const verdictFields = (j: Judgement) => ({
  verdict: j.verdict, contested: VERDICT_CODE[j.verdict] === null ? null : j.verdict === "contested", organic: j.verdict !== "uncontested",
  evidence: j.evidence, signals: j.signals, receipts: j.receipts, reasons: j.reasons,
});

const priorOf = (row: { rules: string | null; reasons: string } | null): Prior | null =>
  row?.rules ? { rules: JSON.parse(row.rules), reasons: JSON.parse(row.reasons) } : null;
const templatePrior = db.prepare("SELECT rules, reasons FROM templates WHERE template = ?");
const launchpadPrior = db.prepare("SELECT rules, reasons FROM launchpads WHERE id = ?");
const poolFactsRow = db.prepare(`SELECT p.created_at, p.graduated_at, c.quote_mint, c.threshold, c.template, c.launchpad, COALESCE(m.decimals, 9) decimals
  FROM pools p LEFT JOIN configs c ON c.address = p.config LEFT JOIN mints m ON m.mint = c.quote_mint WHERE p.address = ?`);
const saveVerdict = db.prepare("UPDATE pools SET verdict = ?, rules = ? WHERE address = ?");
const fundingRow = db.prepare("SELECT sampled, traced, funder, hops, buyers, share, pool_share, creator, cosigned, receipts FROM pool_funding WHERE pool = ?");

export function judgementOf(pool: string) {
  const r = poolFactsRow.get(pool) as any;
  if (!r) return null;
  return judge({
    createdAt: r.created_at, graduatedAt: r.graduated_at, quoteMint: r.quote_mint ?? SOL, threshold: r.threshold ?? 0, decimals: r.decimals,
    template: r.template ? priorOf(templatePrior.get(r.template) as any) : null, launchpad: r.launchpad ? priorOf(launchpadPrior.get(r.launchpad) as any) : null,
    funding: fundingRow.get(pool) as Funding | null,
  }, evidenceOf(pool));
}

// Judges one pool and stores the verdict for the aggregates.
export function judgePool(pool: string) {
  const j = judgementOf(pool);
  if (j) saveVerdict.run(VERDICT_CODE[j.verdict], j.rules.join(",") || null, pool);
  return j;
}

// Re-judges every pool (after classify, a replay, or a rules change), in rowid chunks so the scan never
// holds the write lock for long.
export function judgeAll(chunk = 50_000) {
  const load = (sql: string) => new Map((db.query(sql).all() as any[]).map((r) => [r.id, priorOf(r)]));
  const templates = load("SELECT template id, rules, reasons FROM templates");
  const launchpads = load("SELECT id, rules, reasons FROM launchpads");
  const maxRowid = (db.query("SELECT MAX(rowid) n FROM pools").get() as { n: number }).n ?? 0;
  const rows = db.prepare(`SELECT p.address, p.created_at, p.graduated_at, p.verdict, p.rules, c.quote_mint, c.threshold, c.template, c.launchpad,
      e.pool e_pool, e.*, f.pool f_pool, f.sampled f_sampled, f.traced f_traced, f.funder f_funder, f.hops f_hops, f.buyers f_buyers,
      f.share f_share, f.pool_share f_pool_share, f.creator f_creator, f.cosigned f_cosigned, f.receipts f_receipts
    FROM pools p LEFT JOIN configs c ON c.address = p.config LEFT JOIN pool_evidence e ON e.pool = p.address LEFT JOIN pool_funding f ON f.pool = p.address
    WHERE p.rowid > ? AND p.rowid <= ?`);
  const counts = { contested: 0, uncontested: 0, unverified: 0, changed: 0 };
  for (let from = 0; from < maxRowid; from += chunk) {
    const updates: [number | null, string | null, string][] = [];
    for (const r of rows.all(from, from + chunk) as any[]) {
      const j = judge({
        createdAt: r.created_at, graduatedAt: r.graduated_at, quoteMint: r.quote_mint ?? SOL, threshold: r.threshold ?? 0, decimals: 9,
        template: templates.get(r.template) ?? null, launchpad: launchpads.get(r.launchpad) ?? null,
        funding: r.f_pool ? {
          sampled: r.f_sampled, traced: r.f_traced, funder: r.f_funder, hops: r.f_hops, buyers: r.f_buyers, share: r.f_share, pool_share: r.f_pool_share, creator: r.f_creator,
          cosigned: r.f_cosigned, receipts: r.f_receipts,
        } : null,
      }, r.e_pool ? r : null);
      counts[j.verdict]++;
      const [verdict, rules] = [VERDICT_CODE[j.verdict], j.rules.join(",") || null];
      if (verdict !== r.verdict || rules !== r.rules) updates.push([verdict, rules, r.address]);
    }
    db.transaction(() => updates.forEach((u) => saveVerdict.run(...u))).immediate();
    counts.changed += updates.length;
  }
  db.query("INSERT INTO sync (kind, slot) VALUES ('rules', ?) ON CONFLICT(kind) DO UPDATE SET slot = excluded.slot").run(RULES_VERSION);
  return counts;
}

export const rulesStale = () => (db.query("SELECT slot FROM sync WHERE kind = 'rules'").get() as { slot: number } | null)?.slot !== RULES_VERSION;
