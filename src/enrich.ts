import { Connection, PublicKey } from "@solana/web3.js";
import { describeConfig } from "./dbc";
import { db } from "./store";

const { RPC_URL, SOLAMI_API_KEY } = process.env;
export const connection = new Connection(
  RPC_URL ?? (SOLAMI_API_KEY ? `https://rpc.solami.dev/sol?api_key=${SOLAMI_API_KEY}` : "https://solana-rpc.publicnode.com"),
  "confirmed",
);

const decimals = new Map([
  ["So11111111111111111111111111111111111111112", 9],
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6],
]);
async function mintDecimals(mint: string) {
  if (!decimals.has(mint)) {
    const info = await connection.getAccountInfo(new PublicKey(mint));
    decimals.set(mint, info?.data[44] ?? 9); // SPL mint layout: u8 decimals at byte 44
  }
  return decimals.get(mint)!;
}

const isKnown = db.prepare("SELECT 1 FROM configs WHERE address = ?");
const insertConfig = db.prepare(
  "INSERT OR REPLACE INTO configs (address, fee_claimer, quote_mint, family, info, data) VALUES (?, ?, ?, ?, ?, ?)",
);

const pending = new Set<string>();
export function queueConfig(address: string) {
  if (!pending.has(address) && !isKnown.get(address)) pending.add(address);
}

export async function flushConfigs() {
  const batch = [...pending].slice(0, 100); // getMultipleAccounts limit
  if (!batch.length) return;
  batch.forEach((a) => pending.delete(a));
  const infos = await connection.getMultipleAccountsInfo(batch.map((a) => new PublicKey(a)));
  for (const [i, info] of infos.entries()) {
    if (!info) continue;
    const quoteMint = new PublicKey(info.data.subarray(8, 40)).toBase58();
    try {
      const { curve, ...d } = describeConfig(info.data, await mintDecimals(quoteMint));
      insertConfig.run(batch[i], d.feeClaimer, quoteMint, d.family, JSON.stringify({ ...d, curve }), info.data);
    } catch (e) {
      console.error("config decode failed", batch[i], e);
    }
  }
}

// Bump when describeConfig's output changes; stored raw account data lets us recompute in place.
const DESCRIBE_VERSION = 2;

export async function redescribeConfigs() {
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (user_version === DESCRIBE_VERSION) return;
  const rows = db.query("SELECT address, quote_mint, data FROM configs").all() as { address: string; quote_mint: string; data: Uint8Array }[];
  const update = db.prepare("UPDATE configs SET family = ?, info = ? WHERE address = ?");
  for (const row of rows) {
    try {
      const { curve, ...d } = describeConfig(Buffer.from(row.data), await mintDecimals(row.quote_mint));
      update.run(d.family, JSON.stringify({ ...d, curve }), row.address);
    } catch (e) {
      console.error("redescribe failed", row.address, e);
    }
  }
  db.exec(`PRAGMA user_version = ${DESCRIBE_VERSION}`);
  console.log(`redescribed ${rows.length} configs`);
}
