import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair, PublicKey, type Transaction } from "@solana/web3.js";
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

const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3000";
const saveMeta = db.prepare("INSERT OR REPLACE INTO token_meta (mint, json) VALUES (?, ?)");
export const tokenMeta = (mint: string) => (db.query("SELECT json FROM token_meta WHERE mint = ?").get(mint) as { json: string } | null)?.json;

export async function createPoolTx(p: { config: string; wallet: string; name: string; symbol: string; image?: string }) {
  const creator = new PublicKey(p.wallet);
  const mint = Keypair.generate();
  const address = mint.publicKey.toBase58();
  // Metaplex-style off-chain metadata, served by this app at a short URI (on-chain uri max 200 chars).
  saveMeta.run(address, JSON.stringify({ name: p.name, symbol: p.symbol, image: p.image || undefined, description: `Launched with Curvature on config ${p.config}` }));
  const tx = await client.creator.createPool({
    name: p.name.slice(0, 32), symbol: p.symbol.slice(0, 10), uri: `${PUBLIC_URL}/api/meta/${address}`,
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
