import type { DbcStep, DbcTx } from "./dbc";
import { db } from "./store";

// Per-pool transaction evidence, fed the same steps by the live stream, the .scratch/raw archive replay and
// the RPC history replay: who created the pool, how much of the curve the creator side bought in the
// creation slot, distinct buyers, volume by creator vs everyone else, and where the curve completed.

export type Evidence = {
  pool: string; complete: number; creation_slot: number | null; creation_sig: string | null; creators: string;
  creator_fill: number; creator_fill_sig: string | null; slot_fill: number; buy_volume: number; sell_volume: number;
  creator_volume: number; buyers: number; trades: number; completion_slot: number | null; completion_sig: string | null; source: string;
  partial: number; version: number | null;
};

// Bump when applyEvidence or the decoder changes what a transaction contributes. Rows keep the version they
// were built with (applying new transactions to an older row doesn't upgrade it); older rows are rebuilt
// from the archive (archive.ts rebuildEvidence) or replayed again (replay.ts redo). Version 2: every swap
// counted once (it was counted twice from its EvtSwap + EvtSwap2 events), per-buyer volume and first buy.
export const EVIDENCE_VERSION = 2;

const COLUMNS = [
  "pool", "complete", "creation_slot", "creation_sig", "creators", "creator_fill", "creator_fill_sig", "slot_fill", "buy_volume",
  "sell_volume", "creator_volume", "buyers", "trades", "completion_slot", "completion_sig", "source", "partial", "version",
] as const;
const getEvidence = db.prepare("SELECT * FROM pool_evidence WHERE pool = ?");
const saveEvidence = db.prepare(`INSERT OR REPLACE INTO pool_evidence (${COLUMNS.join()}) VALUES (${COLUMNS.map((c) => `$${c}`).join()})`);
const addBuyer = db.prepare("INSERT OR IGNORE INTO pool_buyers (pool, wallet, volume, slot, sig) VALUES (?, ?, ?, ?, ?)");
const addBuyerVolume = db.prepare("UPDATE pool_buyers SET volume = volume + ? WHERE pool = ? AND wallet = ?");
const poolCreator = db.prepare("SELECT creator FROM pools WHERE address = ?");

export const evidenceOf = (pool: string) => getEvidence.get(pool) as Evidence | null;

function fresh(pool: string, source: string): Evidence {
  const creator = (poolCreator.get(pool) as { creator: string | null } | null)?.creator;
  return {
    pool, complete: 0, creation_slot: null, creation_sig: null, creators: JSON.stringify(creator ? [creator] : []), creator_fill: 0,
    creator_fill_sig: null, slot_fill: 0, buy_volume: 0, sell_volume: 0, creator_volume: 0, buyers: 0, trades: 0,
    completion_slot: null, completion_sig: null, source, partial: 0, version: EVIDENCE_VERSION,
  };
}

// Creator side = the pool creator plus whoever signed the creation: launchpads and bundlers often create
// with one key and buy with the other. Fills are net reserve contributions (fees excluded, sells
// subtracted); slot_fill is the pool's quote reserve at the end of its creation slot, whoever bought.
export function applyEvidence(tx: DbcTx, step: DbcStep, source: string, partial = false) {
  if (step.kind === "config") return;
  const e = evidenceOf(step.pool) ?? fresh(step.pool, source);
  if (partial) e.partial = 1;
  if (step.kind === "launch") {
    e.complete = 1;
    e.creation_slot = tx.slot;
    e.creation_sig = tx.sig;
    e.creators = JSON.stringify([...new Set([step.creator, step.signer ?? step.creator, tx.accountKeys[0]])]);
  } else if (step.kind === "swap") {
    const quote = Number(step.quote);
    const byCreator = tx.sig === e.creation_sig || (JSON.parse(e.creators) as string[]).includes(step.trader);
    e.trades++;
    if (byCreator) e.creator_volume += quote;
    if (step.buy) {
      e.buy_volume += quote;
      if (addBuyer.run(step.pool, step.trader, quote, tx.slot, tx.sig).changes) e.buyers++;
      else addBuyerVolume.run(quote, step.pool, step.trader);
    } else e.sell_volume += quote;
    if (e.creation_slot !== null && tx.slot === e.creation_slot) {
      e.slot_fill = step.reserve !== null ? Number(step.reserve) : e.slot_fill + Number(step.net);
      if (byCreator) {
        e.creator_fill += Number(step.net);
        if (step.buy) e.creator_fill_sig ??= tx.sig;
      }
    }
  } else {
    e.completion_slot = tx.slot;
    e.completion_sig = tx.sig;
  }
  saveEvidence.run(Object.fromEntries(COLUMNS.map((c) => [`$${c}`, e[c]])));
}

const deleteEvidence = db.prepare("DELETE FROM pool_evidence WHERE pool = ?");
const deleteBuyers = db.prepare("DELETE FROM pool_buyers WHERE pool = ?");
export const resetEvidence = (pool: string) => (deleteEvidence.run(pool), deleteBuyers.run(pool));

// Every transaction is applied once, whichever path delivers it first; the archive replay overlaps the live
// stream around restarts. Rows older than SEEN_SLOTS behind the newest are pruned.
const SEEN_SLOTS = 20_000; // ~2.2 h
const markSeen = db.prepare("INSERT OR IGNORE INTO seen_txs (sig, slot) VALUES (?, ?)");
const pruneSeen = db.prepare("DELETE FROM seen_txs WHERE slot < ?");
let newestSlot = 0;
export function firstSighting(sig: string, slot: number) {
  if (slot > newestSlot + 1000) {
    newestSlot = slot;
    pruneSeen.run(slot - SEEN_SLOTS);
  }
  return markSeen.run(sig, slot).changes > 0;
}
export const seenWindowSlots = SEEN_SLOTS;
