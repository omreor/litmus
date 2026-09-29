import { readdirSync, readFileSync } from "node:fs";
import { constants, gunzipSync } from "node:zlib";
import { decodeDbcTx, type DbcTx } from "./dbc";
import { applyEvidence, EVIDENCE_VERSION, resetEvidence, seenWindowSlots } from "./evidence";
import { handleTransaction } from "./indexer";
import { judgePool } from "./integrity";
import { db } from "./store";

// Replays the DBC transaction archive written by src/record.ts (hourly gzipped JSONL, one line per
// transaction: sig, slot, seen, keys, DBC instructions) through the live indexer. Incremental: lines
// older than the newest applied slot minus the dedupe window are skipped, and the dedupe table
// (evidence.ts firstSighting) drops transactions the live stream already applied.

const HOUR_MS = 3_600_000;
const lastSync = (kind: string) => (db.query("SELECT slot FROM sync WHERE kind = ?").get(kind) as { slot: number } | null)?.slot ?? 0;
const saveSync = db.prepare("INSERT INTO sync (kind, slot) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET slot = excluded.slot");

type Line = { sig: string; slot: number; seen: number; keys: string[]; ixs: { accounts: number[]; data: string }[] };

const archiveFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort();

// Transactions of one hourly file with a slot above `from`, in file order. Concatenated gzip members
// (record.ts appends one per flush); node's gunzip reads them all. Sync flush tolerates a member being
// appended right now; its partial last line is skipped.
function* transactions(path: string, from: number): Generator<DbcTx> {
  const text = gunzipSync(readFileSync(path), { finishFlush: constants.Z_SYNC_FLUSH }).toString();
  for (const raw of text.split("\n")) {
    const slot = Number(raw.match(/"slot":(\d+)/)?.[1] ?? 0);
    if (slot <= from) continue;
    let line: Line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    yield {
      sig: line.sig, slot, blockTime: line.seen, accountKeys: line.keys,
      ixs: line.ixs.map((ix) => ({ accounts: ix.accounts, data: Buffer.from(ix.data, "base64") })),
    };
  }
}

export function replayArchive(dir = process.env.ARCHIVE_DIR ?? ".scratch/raw") {
  const started = performance.now();
  const from = lastSync("archive") - seenWindowSlots;
  const fromTime = lastSync("archive_seen") * 1000 - 3 * HOUR_MS;
  let [lines, newest, newestSeen] = [0, lastSync("archive"), lastSync("archive_seen")];
  for (const file of archiveFiles(dir)) {
    if (Date.parse(`${file.slice(0, 13)}:00:00Z`) + HOUR_MS < fromTime) continue;
    db.transaction(() => {
      for (const tx of transactions(`${dir}/${file}`, from)) {
        handleTransaction(tx, "archive");
        lines++;
        if (tx.slot > newest) [newest, newestSeen] = [tx.slot, tx.blockTime];
      }
    }).immediate();
  }
  saveSync.run("archive", newest);
  saveSync.run("archive_seen", newestSeen);
  return { lines, newest, seconds: Math.round((performance.now() - started) / 1000) };
}

// Rebuilds, from the archive alone, the evidence the live stream or the archive built with an older
// EVIDENCE_VERSION. Run after replayArchive and before the stream starts: transactions past the newest
// slot replayArchive applied are left to it. Pools created before the archive began get incomplete
// evidence and go back to the RPC replay.
export function rebuildEvidence(dir = process.env.ARCHIVE_DIR ?? ".scratch/raw") {
  const pools = new Set(db.query("SELECT pool FROM pool_evidence WHERE source IN ('live', 'archive') AND version IS NOT ?").values(EVIDENCE_VERSION).flat() as string[]);
  if (!pools.size) return null;
  const until = lastSync("archive");
  const applied = new Set<string>();
  db.transaction(() => pools.forEach(resetEvidence)).immediate();
  for (const file of archiveFiles(dir)) {
    db.transaction(() => {
      for (const tx of transactions(`${dir}/${file}`, 0)) {
        if (tx.slot > until || applied.has(tx.sig)) continue;
        applied.add(tx.sig);
        for (const step of decodeDbcTx(tx)) if (step.kind !== "config" && pools.has(step.pool)) applyEvidence(tx, step, "archive");
      }
    }).immediate();
  }
  db.transaction(() => pools.forEach(judgePool)).immediate();
  return { pools: pools.size, transactions: applied.size };
}

if (import.meta.main) console.log("archive replay", replayArchive(process.argv[2]));
