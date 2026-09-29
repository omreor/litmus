import { PublicKey } from "@solana/web3.js";
import { connection } from "./enrich";
import { db } from "./store";

const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_METADATA_EXTENSION = 19;
const MINT_EXTENSIONS_OFFSET = 166; // 165-byte base (padded to token-account size) + 1-byte account type
const BATCH = 100;

type TokenMeta = { name?: string; symbol?: string; uri?: string; decimals: number };

// Bidi overrides and zero-width chars let token names spoof other text (e.g. reversed tickers).
export const cleanText = (s: string) => s.replace(/[\u0000\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "").trim();

function borshString(buf: Buffer, offset: number): [string, number] {
  const len = buf.readUInt32LE(offset);
  return [cleanText(buf.subarray(offset + 4, offset + 4 + len).toString("utf8")), offset + 4 + len];
}

// name, symbol, uri as consecutive borsh strings starting at `offset`.
function readNameSymbolUri(buf: Buffer, offset: number) {
  const [name, a] = borshString(buf, offset);
  const [symbol, b] = borshString(buf, a);
  const [uri] = borshString(buf, b);
  return { name, symbol, uri };
}

function token2022Metadata(data: Buffer) {
  for (let o = MINT_EXTENSIONS_OFFSET; o + 4 <= data.length; ) {
    const [type, len] = [data.readUInt16LE(o), data.readUInt16LE(o + 2)];
    if (type === TOKEN_METADATA_EXTENSION) return readNameSymbolUri(data, o + 4 + 64); // skip update authority + mint
    if (type === 0) break;
    o += 4 + len;
  }
  return null;
}

async function fetchTokenMeta(mints: string[]) {
  const keys = mints.map((m) => new PublicKey(m));
  const infos = await connection.getMultipleAccountsInfo(keys);
  const out = new Map<string, TokenMeta>();
  const metaplex: [string, number][] = [];
  infos.forEach((info, i) => {
    if (!info) return;
    const decimals = info.data[44];
    const ext = info.owner.toBase58() === TOKEN_2022 ? token2022Metadata(info.data) : null;
    if (ext) out.set(mints[i], { ...ext, decimals });
    else metaplex.push([mints[i], decimals]);
  });
  if (metaplex.length) {
    const pdas = metaplex.map(([m]) =>
      PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), new PublicKey(m).toBuffer()], METADATA_PROGRAM)[0],
    );
    const metas = await connection.getMultipleAccountsInfo(pdas);
    metas.forEach((info, i) => {
      const [mint, decimals] = metaplex[i];
      // Metaplex layout: key (1) + update authority (32) + mint (32), then name/symbol/uri.
      out.set(mint, info ? { ...readNameSymbolUri(info.data, 65), decimals } : { decimals });
    });
  }
  return out;
}

const poolsWithoutMint = db.prepare(`SELECT address FROM pools WHERE base_mint IS NULL LIMIT ${BATCH}`);
const setBaseMint = db.prepare("UPDATE pools SET base_mint = ? WHERE address = ?");
const poolsWithoutName = db.prepare(`SELECT DISTINCT base_mint FROM pools WHERE name IS NULL AND base_mint IS NOT NULL AND meta_checked = 0 LIMIT ${BATCH}`);
const setPoolMeta = db.prepare("UPDATE pools SET name = ?, symbol = ?, uri = COALESCE(uri, ?), meta_checked = 1 WHERE base_mint = ?");
const unknownQuotes = db.prepare(`SELECT DISTINCT quote_mint FROM configs WHERE quote_mint NOT IN (SELECT mint FROM mints) LIMIT ${BATCH}`);
const saveMint = db.prepare("INSERT OR REPLACE INTO mints (mint, symbol, name, decimals) VALUES (?, ?, ?, ?)");

// Fills in what the stream can't tell us: base mints of pools first seen mid-life (swap events
// don't carry the mint), their names, and quote-token symbols/decimals.
export async function sweepMetadata() {
  const pools = (poolsWithoutMint.all() as { address: string }[]).map((r) => r.address);
  if (pools.length) {
    const infos = await connection.getMultipleAccountsInfo(pools.map((p) => new PublicKey(p)));
    infos.forEach((info, i) => info && setBaseMint.run(new PublicKey(info.data.subarray(136, 168)).toBase58(), pools[i]));
  }
  const mints = (poolsWithoutName.all() as { base_mint: string }[]).map((r) => r.base_mint);
  if (mints.length) {
    const metas = await fetchTokenMeta(mints);
    for (const mint of mints) {
      const m = metas.get(mint);
      setPoolMeta.run(m?.name || null, m?.symbol || null, m?.uri || null, mint);
    }
  }
  const quotes = (unknownQuotes.all() as { quote_mint: string }[]).map((r) => r.quote_mint);
  if (quotes.length) {
    const metas = await fetchTokenMeta(quotes);
    for (const mint of quotes) {
      const m = metas.get(mint);
      saveMint.run(mint, m?.symbol || null, m?.name || null, m?.decimals ?? 9);
    }
  }
}
