import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair, PublicKey, VersionedTransaction, type Transaction } from "@solana/web3.js";
import { DBC_PROGRAM_ID, dbcIxName } from "./dbc";
import { connection } from "./enrich";
import { db } from "./store";
import { buildConfigParameters, QUOTES, type StudioInput } from "./studio";

const client = new DynamicBondingCurveClient(connection, "confirmed");

// The new account (config or mint) signs here; the user's wallet adds the fee-payer signature.
async function prepare(tx: Transaction, payer: PublicKey, newAccount: Keypair) {
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(newAccount);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

export async function createConfigTx(input: StudioInput, wallet: string) {
  const owner = new PublicKey(wallet);
  const config = Keypair.generate();
  const tx = await client.partner.createConfig({
    ...buildConfigParameters(input),
    config: config.publicKey,
    feeClaimer: owner,
    leftoverReceiver: owner,
    quoteMint: new PublicKey(QUOTES[input.quote].mint),
    payer: owner,
  });
  return { config: config.publicKey.toBase58(), tx: await prepare(tx, owner, config) };
}

// Token metadata lives at a stable URL for good (it's in the mint's on-chain uri): GitHub Pages, where
// scripts/publish.sh writes data/meta/<mint>.json. Forks publishing elsewhere set META_URL.
const META_URL = process.env.META_URL ?? "https://omreor.github.io/litmus/data/meta/";
const saveMeta = db.prepare("INSERT OR REPLACE INTO token_meta (mint, json) VALUES (?, ?)");
export const tokenMeta = (mint: string) => (db.query("SELECT json FROM token_meta WHERE mint = ?").get(mint) as { json: string } | null)?.json;

export async function createPoolTx(p: { config: string; wallet: string; name: string; symbol: string; image?: string }) {
  const creator = new PublicKey(p.wallet);
  const mint = Keypair.generate();
  const address = mint.publicKey.toBase58();
  // Metaplex-style off-chain metadata (on-chain uri max 200 chars); the caller publishes it.
  saveMeta.run(address, JSON.stringify({ name: p.name, symbol: p.symbol, image: p.image || undefined, description: `Launched with Litmus on config ${p.config}` }));
  const tx = await client.creator.createPool({
    name: p.name.slice(0, 32), symbol: p.symbol.slice(0, 10), uri: `${META_URL}${address}.json`,
    payer: creator, poolCreator: creator, config: new PublicKey(p.config), baseMint: mint.publicKey,
  });
  return { mint: address, tx: await prepare(tx, creator, mint) };
}

export async function sendSigned(base64: string) {
  const signature = await connection.sendRawTransaction(Buffer.from(base64, "base64"), { skipPreflight: false, maxRetries: 3 });
  const { value } = await connection.confirmTransaction(signature, "confirmed");
  if (value.err) throw new Error(`transaction failed: ${JSON.stringify(value.err)}`);
  return signature;
}

// What a Studio transaction did, for usage metrics: a config deploy or a token launch (with its mint).
export function studioAction(base64: string) {
  const { message } = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  for (const ix of message.compiledInstructions) {
    if (keys[ix.programIdIndex] !== DBC_PROGRAM_ID) continue;
    const name = dbcIxName(ix.data);
    if (name?.startsWith("create_config")) return { kind: "deploy", account: keys[ix.accountKeyIndexes[0]] };
    if (name?.startsWith("initialize_virtual_pool")) return { kind: "launch", account: keys[ix.accountKeyIndexes[3]] };
  }
  return null;
}
