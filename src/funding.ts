import { judgePool, SWARM } from "./integrity";
import { publicSignatures, rpcMany, type Signature } from "./replay";
import { db } from "./store";

// Funding-source signal (rules v3). Many distinct buyers only mean competition if they are independent:
// a bundler funds a swarm of fresh wallets from one wallet minutes before they buy. For a contested
// graduation's largest buyers (by quote bought), this finds the SOL transfer that funded each one in the
// FUND_WINDOW before its first buy (one hop) and what funded that funder in the window before (two hops),
// then the common funder behind the largest share of those buyers' volume. Hubs (exchanges, routers: thousands of
// transactions an hour) fund unrelated wallets and don't count, unless the funder co-signed the buy itself
// (bots buy through throwaway signers they fund in the same transaction; an exchange never signs a
// user's swap). Bounded cost per pool: SAMPLE buyers, one
// signature page and TXS_PER_WALLET transactions per wallet and hop. A wallet whose latest signature page
// doesn't reach back to its buy (a very active bot) stays untraced, which never counts as a swarm.
// Usage: bun src/funding.ts [limit]  (the server checks new contested graduations every few minutes)

export const FUNDING_VERSION = 2;
const SAMPLE = 12;
const FUND_WINDOW_SLOTS = 216_000; // ~24 h
const TXS_PER_WALLET = 10;
const MIN_FUNDING_LAMPORTS = 1e7; // 0.01 SOL: below this it's dust (address poisoning), not funding
const HUB_SPAN_SECONDS = 6 * 3600; // 1,000 transactions in less than this: a hub
const PAGE = 1000;

type ParsedIx = { program?: string; parsed?: { type?: string; info?: Record<string, any> } };
type TokenBalance = { accountIndex: number; owner?: string };
type ParsedTx = {
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: ParsedIx[] } };
  meta: { innerInstructions?: { instructions: ParsedIx[] }[] | null; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
};

// The wallet and the token accounts it owns in this transaction: bots buy through throwaway signers whose
// wrapped-SOL account another wallet funds in the same transaction (and closes again, rent back to itself).
function ownedBy(wallet: string, tx: ParsedTx, ixs: ParsedIx[]) {
  const owned = new Set([wallet]);
  const keys = tx.transaction.message.accountKeys;
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) if (b.owner === wallet) owned.add(keys[b.accountIndex].pubkey);
  for (const ix of ixs) {
    const info = ix.parsed?.info;
    if (info?.account && (info.wallet === wallet || info.owner === wallet)) owned.add(info.account);
  }
  return owned;
}
// cosigned: the funder signed a transaction of `pool` (the buy it paid for).
type Funding = { funder: string; sig: string; slot: number; lamports: number; cosigned: boolean };

const parsedTxs = (sigs: string[]) => rpcMany<ParsedTx | null>(sigs.map((sig) => ({
  method: "getTransaction", params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
})));

// The largest SOL transfer into `wallet` (or a token account it owns) from another wallet in (fromSlot, toSlot], looking first
// at its buy (`buySig`: bots fund throwaway buyers in the buy itself), then at the TXS_PER_WALLET transactions closest to
// toSlot. undefined: that window is past the latest signature page. Signatures come from mainnet-beta: Solami's index
// times out on fresh wallets, the ones that matter here.
async function fundedBy(wallet: string, fromSlot: number, toSlot: number, pool?: string, buySig?: string | null): Promise<Funding | null | undefined> {
  if (buySig) {
    const inBuy = largestFunding(wallet, [{ signature: buySig, slot: toSlot }], await parsedTxs([buySig]), pool);
    if (inBuy) return inBuy;
  }
  const sigs = await publicSignatures([wallet, { limit: PAGE }]);
  if (sigs.length === PAGE && sigs.at(-1)!.slot > toSlot) return undefined;
  const window = sigs.filter((s) => !s.err && s.slot > fromSlot && s.slot <= toSlot).slice(0, TXS_PER_WALLET);
  return largestFunding(wallet, window, await parsedTxs(window.map((s) => s.signature)), pool);
}

function largestFunding(wallet: string, window: { signature: string; slot: number }[], txs: (ParsedTx | null)[], pool?: string): Funding | null {
  let best: Funding | null = null;
  txs.forEach((tx, i) => {
    if (!tx) return;
    const ixs = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
    const owned = ownedBy(wallet, tx, ixs);
    const keys = tx.transaction.message.accountKeys;
    for (const ix of ixs) {
      const info = ix.parsed?.info;
      if (ix.program !== "system" || ix.parsed?.type !== "transfer" || !info || !owned.has(info.destination) || owned.has(info.source)) continue;
      if (info.lamports < MIN_FUNDING_LAMPORTS || info.lamports <= (best?.lamports ?? 0)) continue;
      const cosigned = keys.some((k) => k.pubkey === pool) && keys.some((k) => k.pubkey === info.source && k.signer);
      best = { funder: info.source, sig: window[i].signature, slot: window[i].slot, lamports: info.lamports, cosigned };
    }
  });
  return best;
}

const hubs = new Map<string, boolean>();
async function isHub(wallet: string) {
  if (!hubs.has(wallet)) {
    const sigs = await publicSignatures([wallet, { limit: PAGE }]);
    hubs.set(wallet, sigs.length === PAGE && (sigs[0].blockTime ?? 0) - (sigs.at(-1)!.blockTime ?? 0) < HUB_SPAN_SECONDS);
  }
  return hubs.get(wallet)!;
}

const poolRow = db.prepare(`SELECT e.buy_volume, e.creators FROM pool_evidence e WHERE e.pool = ?`);
const topBuyers = db.prepare("SELECT wallet, volume, slot, sig FROM pool_buyers WHERE pool = ? AND slot IS NOT NULL ORDER BY volume DESC LIMIT ?");
const saveFunding = db.prepare(`INSERT OR REPLACE INTO pool_funding
  (pool, version, at, sampled, traced, funder, hops, buyers, share, pool_share, creator, cosigned, receipts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

type Group = { funder: string; hops: 1 | 2; buyers: Set<string>; volume: number; receipts: string[]; cosigned: boolean };

export async function checkFunding(pool: string) {
  const p = poolRow.get(pool) as { buy_volume: number; creators: string } | null;
  if (!p) return null;
  const creators = new Set(JSON.parse(p.creators) as string[]);
  const buyers = (topBuyers.all(pool, SAMPLE + creators.size) as { wallet: string; volume: number; slot: number; sig: string | null }[])
    .filter((b) => !creators.has(b.wallet)).slice(0, SAMPLE);
  const hop1 = await Promise.all(buyers.map((b) => fundedBy(b.wallet, b.slot - FUND_WINDOW_SLOTS, b.slot, pool, b.sig)));
  // Two hops: what funded each funder before it funded a buyer (its earliest funding of one). A funder that
  // co-signed the buy already controls it: no second hop.
  const firstFunding = new Map<string, Funding>();
  for (const f of hop1) if (f && !f.cosigned && (firstFunding.get(f.funder)?.slot ?? Infinity) > f.slot) firstFunding.set(f.funder, f);
  const hop2 = new Map(await Promise.all([...firstFunding.values()].map(async (f) =>
    [f.funder, await fundedBy(f.funder, f.slot - FUND_WINDOW_SLOTS, f.slot - 1)] as const)));

  const groups = new Map<string, Group>();
  const join = (funder: string, hops: 1 | 2, buyer: { wallet: string; volume: number }, receipts: string[], cosigned = false) => {
    const g = groups.get(`${hops}:${funder}`) ?? { funder, hops, buyers: new Set(), volume: 0, receipts: [], cosigned: false };
    groups.set(`${hops}:${funder}`, g);
    g.cosigned ||= cosigned;
    if (g.buyers.has(buyer.wallet)) return;
    g.buyers.add(buyer.wallet);
    g.volume += buyer.volume;
    g.receipts.push(...receipts);
  };
  buyers.forEach((b, i) => {
    const f = hop1[i];
    if (!f) return;
    join(f.funder, 1, b, [f.sig], f.cosigned);
    const root = hop2.get(f.funder);
    if (root) join(root.funder, 2, b, [root.sig, f.sig]);
  });
  // The common funder behind the most buy volume, hubs skipped (checked for the three largest groups only).
  let swarm: Group | null = null;
  for (const g of [...groups.values()].filter((g) => g.buyers.size > 1).sort((a, b) => b.volume - a.volume).slice(0, 3)) {
    if (!g.cosigned && (await isHub(g.funder))) continue;
    swarm = g;
    break;
  }
  const traced = hop1.filter((f) => f !== undefined).length;
  const sampledVolume = buyers.reduce((sum, b) => sum + b.volume, 0);
  const share = swarm && sampledVolume ? swarm.volume / sampledVolume : 0;
  const poolShare = swarm && p.buy_volume ? swarm.volume / p.buy_volume : 0;
  saveFunding.run(pool, FUNDING_VERSION, Math.floor(Date.now() / 1000), buyers.length, traced, swarm?.funder ?? null, swarm?.hops ?? null,
    swarm?.buyers.size ?? 0, share, poolShare, swarm && creators.has(swarm.funder) ? 1 : 0, swarm?.cosigned ? 1 : 0,
    JSON.stringify([...new Set(swarm?.receipts ?? [])].slice(0, 6)));
  return { sampled: buyers.length, traced, funder: swarm?.funder ?? null, buyers: swarm?.buyers.size ?? 0, share };
}

// Contested graduations whose evidence records per-buyer first-buy slots and that weren't checked yet.
const candidates = db.prepare(`SELECT p.address FROM pools p INDEXED BY pools_graduated_verdict JOIN pool_evidence e ON e.pool = p.address
  WHERE p.graduated_at IS NOT NULL AND p.verdict = 1 AND e.version >= 2
    AND NOT EXISTS (SELECT 1 FROM pool_funding f WHERE f.pool = p.address AND f.version = ${FUNDING_VERSION})
  ORDER BY p.graduated_at DESC LIMIT ?`);

// Checks up to `limit` candidates, `concurrency` at a time, and re-judges each one.
export async function checkFundingBatch(limit: number, concurrency = 4) {
  const pools = (candidates.values(limit) as [string][]).map(([p]) => p);
  const tally = { checked: 0, swarms: 0, errors: 0 };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, pools.length) }, async () => {
    while (next < pools.length) {
      const pool = pools[next++];
      try {
        const r = await checkFunding(pool);
        judgePool(pool);
        tally.checked++;
        if (r && r.buyers >= SWARM.buyers && r.share >= SWARM.share) tally.swarms++;
      } catch (e) {
        tally.errors++;
        console.error("funding", pool, String(e instanceof Error ? e.message : e).slice(0, 200));
      }
    }
  }));
  return tally;
}

if (import.meta.main) console.log("funding", await checkFundingBatch(Number(process.argv[2] ?? 1_000_000), Number(process.env.FUNDING_CONCURRENCY ?? 4)));
