import { Connection, PublicKey } from "@solana/web3.js";
import { CONFIG_SLICE, DBC_PROGRAM_ID, describeConfig, readConfigSlice } from "./dbc";
import { db, saveConfig } from "./store";

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

// Backfilled configs only carry the fingerprint columns; full data is fetched once one shows up live.
const isKnown = db.prepare("SELECT 1 FROM configs WHERE address = ? AND data IS NOT NULL");
const describe = db.prepare("UPDATE configs SET family = ?, info = ?, data = ? WHERE address = ?");

const pending = new Set<string>();
export function queueConfig(address: string) {
  if (!pending.has(address) && !isKnown.get(address)) pending.add(address);
}

export async function flushConfigs() {
  const batch = [...pending].slice(0, 100); // getMultipleAccounts limit
  batch.forEach((a) => pending.delete(a));
  await describeConfigs(batch);
}

// Fetches, decodes and stores configs (fingerprint columns, template, full description).
async function describeConfigs(addresses: string[]) {
  if (!addresses.length) return;
  const infos = await connection.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)));
  for (const [i, info] of infos.entries()) {
    if (!info || info.owner.toBase58() !== DBC_PROGRAM_ID) continue;
    const fields = readConfigSlice(info.data.subarray(CONFIG_SLICE.offset, CONFIG_SLICE.offset + CONFIG_SLICE.length));
    try {
      saveConfig(addresses[i], fields);
      const { curve, ...d } = describeConfig(info.data, await mintDecimals(fields.quoteMint));
      describe.run(d.family, JSON.stringify({ ...d, curve }), info.data, addresses[i]);
    } catch (e) {
      console.error("config decode failed", addresses[i], e);
    }
  }
}

// For API requests about a config we haven't decoded; false when it isn't a DBC config.
export async function describeNow(address: string) {
  try {
    new PublicKey(address);
  } catch {
    return false;
  }
  await describeConfigs([address]);
  return !!isKnown.get(address);
}

// Bump when describeConfig's output changes; stored raw account data lets us recompute in place.
const DESCRIBE_VERSION = 2;

export async function redescribeConfigs() {
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (user_version === DESCRIBE_VERSION) return;
  const rows = db.query("SELECT address, quote_mint, data FROM configs WHERE data IS NOT NULL").all() as { address: string; quote_mint: string; data: Uint8Array }[];
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
