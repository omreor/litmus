import { readdirSync, readFileSync } from "node:fs";
import { constants, gunzipSync } from "node:zlib";
import { seenWindowSlots } from "./evidence";
import { handleTransaction } from "./indexer";
import { db } from "./store";

// Replays the DBC transaction archive written by src/record.ts (hourly gzipped JSONL, one line per
// transaction: sig, slot, seen, keys, DBC instructions) through the live indexer. Incremental: lines
// older than the newest applied slot minus the dedupe window are skipped, and the dedupe table
// (evidence.ts firstSighting) drops transactions the live stream already applied.

const HOUR_MS = 3_600_000;
const lastSync = (kind: string) => (db.query("SELECT slot FROM sync WHERE kind = ?").get(kind) as { slot: number } | null)?.slot ?? 0;
const saveSync = db.prepare("INSERT INTO sync (kind, slot) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET slot = excluded.slot");

type Line = { sig: string; slot: number; seen: number; keys: string[]; ixs: { accounts: number[]; data: string }[] };

export function replayArchive(dir = process.env.ARCHIVE_DIR ?? ".scratch/raw") {
  const started = performance.now();
  const from = lastSync("archive") - seenWindowSlots;
  const fromTime = lastSync("archive_seen") * 1000 - 3 * HOUR_MS;
  let [lines, newest, newestSeen] = [0, lastSync("archive"), lastSync("archive_seen")];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort();
  for (const file of files) {
    if (Date.parse(`${file.slice(0, 13)}:00:00Z`) + HOUR_MS < fromTime) continue;
    // Concatenated gzip members (record.ts appends one per flush); node's gunzip reads them all. Sync
    // flush tolerates a member being appended right now; its partial last line is skipped below.
    const text = gunzipSync(readFileSync(`${dir}/${file}`), { finishFlush: constants.Z_SYNC_FLUSH }).toString();
    db.transaction(() => {
      for (const raw of text.split("\n")) {
        const slot = Number(raw.match(/"slot":(\d+)/)?.[1] ?? 0);
        if (slot <= from) continue;
        let line: Line;
        try {
          line = JSON.parse(raw);
        } catch {
          continue;
        }
        handleTransaction({
          sig: line.sig, slot, blockTime: line.seen, accountKeys: line.keys,
          ixs: line.ixs.map((ix) => ({ accounts: ix.accounts, data: Buffer.from(ix.data, "base64") })),
        }, "archive");
        lines++;
        if (slot > newest) [newest, newestSeen] = [slot, line.seen];
      }
    }).immediate();
  }
  saveSync.run("archive", newest);
  saveSync.run("archive_seen", newestSeen);
  return { lines, newest, seconds: Math.round((performance.now() - started) / 1000) };
}

if (import.meta.main) console.log("archive replay", replayArchive(process.argv[2]));
