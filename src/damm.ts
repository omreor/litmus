import { utils } from "@coral-xyz/anchor";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PublicKey } from "@solana/web3.js";

// Meteora DAMM v2 (cp-amm) pools that graduated DBC pools migrate into. DBC migration creates the
// pool with token A = base mint and token B = quote mint (only the PDA seeds sort the two mints).

export const DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

const BATCH = 100; // getMultipleAccounts limit
const CONCURRENCY = 8;
const POOL_BYTES = 697; // through layout_version, the last field decoded below
const TOKEN_AMOUNT = { offset: 64, length: 8 }; // SPL token and token-2022 accounts alike

const bs58 = utils.bytes.bs58;
const pubkeyAt = (b: Buffer, o: number) => bs58.encode(b.subarray(o, o + 32));
const u128At = (b: Buffer, o: number) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);

// Each migration fee option has one fixed DAMM v2 config (Customizable included), part of the PDA seeds.
export function dammV2PoolAddress(baseMint: string, quoteMint: string, migrationFeeOption: number) {
  const config = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (!config) throw new Error(`unknown migration fee option ${migrationFeeOption}`);
  return deriveDammV2PoolAddress(config, new PublicKey(baseMint), new PublicKey(quoteMint)).toBase58();
}

// Offsets include the 8-byte discriminator; layout from programs/cp-amm/src/state/pool.rs (1112 bytes).
export function decodeDammV2Pool(data: Buffer) {
  return {
    // pool_fees.base_fee.base_fee_info.data starts with cliff_fee_numerator in every base fee mode
    cliffFeeNumerator: data.readBigUInt64LE(8),
    tokenAMint: pubkeyAt(data, 168),
    tokenBMint: pubkeyAt(data, 200),
    tokenAVault: pubkeyAt(data, 232),
    tokenBVault: pubkeyAt(data, 264),
    liquidity: u128At(data, 360),
    sqrtMinPrice: u128At(data, 424),
    sqrtMaxPrice: u128At(data, 440),
    sqrtPrice: u128At(data, 456),
    permanentLockLiquidity: u128At(data, 552),
    // metrics: total_lp_x_fee (u128) + total_protocol_x_fee (u64). Referral cuts are not counted.
    feesA: u128At(data, 568) + data.readBigUInt64LE(600),
    feesB: u128At(data, 584) + data.readBigUInt64LE(608),
    // Reserves the pool tracks itself, excluding unclaimed fees; only valid for layout version 1.
    tokenAAmount: data.readBigUInt64LE(680),
    tokenBAmount: data.readBigUInt64LE(688),
    layoutVersion: data[696],
  };
}

export type DammPool = {
  tokenAMint: string;
  tokenBMint: string;
  liquidity: bigint;
  permanentLockLiquidity: bigint;
  sqrtPrice: bigint;
  reserveA: bigint;
  reserveB: bigint;
  feeRate: number; // base fee only (cliff numerator / 1e9), dynamic fee excluded
  feesA: bigint;
  feesB: bigint;
};

type Account = { data: [string, string]; owner: string } | null;

async function getMultipleAccounts(addresses: string[], rpcUrl: string, dataSlice: { offset: number; length: number }) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getMultipleAccounts",
    params: [addresses, { encoding: "base64", dataSlice }],
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const { result, error } = (await res.json()) as { result?: { value: Account[] }; error?: { message: string } };
      if (error) throw new Error(error.message);
      return result!.value;
    } catch (e) {
      // Bun's fetch errors can carry the URL, which may hold an API key: never let it reach a log.
      if (attempt === 5) throw new Error(`getMultipleAccounts: ${String(e instanceof Error ? e.message : e).replace(/api_key=[^&\s"]+/g, "api_key=***")}`);
      await Bun.sleep(1000 * attempt);
    }
  }
}

async function readAccounts(addresses: string[], rpcUrl: string, dataSlice: { offset: number; length: number }) {
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += BATCH) batches.push(addresses.slice(i, i + BATCH));
  const accounts: Account[] = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const results = await Promise.all(batches.slice(i, i + CONCURRENCY).map((b) => getMultipleAccounts(b, rpcUrl, dataSlice)));
    for (const r of results) accounts.push(...r);
  }
  return accounts;
}

// Current state of DAMM v2 pools; null where no cp-amm account exists (not migrated yet, or never).
export async function readDammPools(addresses: string[], rpcUrl: string) {
  const accounts = await readAccounts(addresses, rpcUrl, { offset: 0, length: POOL_BYTES });
  const pools = accounts.map((a) => (a?.owner === DAMM_V2_PROGRAM_ID ? decodeDammV2Pool(Buffer.from(a.data[0], "base64")) : null));

  // Layout v0 pools (untouched since cp-amm started tracking reserves; none in a 2k sample) fall back
  // to vault balances, which also hold unclaimed fees.
  const legacy = pools.filter((p) => p?.layoutVersion === 0) as ReturnType<typeof decodeDammV2Pool>[];
  const vaults = await readAccounts(legacy.flatMap((p) => [p.tokenAVault, p.tokenBVault]), rpcUrl, TOKEN_AMOUNT);
  const amount = (a: Account) => (a ? Buffer.from(a.data[0], "base64").readBigUInt64LE(0) : 0n);
  legacy.forEach((p, i) => {
    p.tokenAAmount = amount(vaults[2 * i]);
    p.tokenBAmount = amount(vaults[2 * i + 1]);
  });

  const out = new Map<string, DammPool | null>();
  for (const [i, p] of pools.entries()) {
    out.set(addresses[i], p && {
      tokenAMint: p.tokenAMint,
      tokenBMint: p.tokenBMint,
      liquidity: p.liquidity,
      permanentLockLiquidity: p.permanentLockLiquidity,
      sqrtPrice: p.sqrtPrice,
      reserveA: p.tokenAAmount,
      reserveB: p.tokenBAmount,
      feeRate: Number(p.cliffFeeNumerator) / 1e9,
      feesA: p.feesA,
      feesB: p.feesB,
    });
  }
  return out;
}
