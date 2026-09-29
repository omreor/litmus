import { BN, BorshAccountsCoder, BorshEventCoder, BorshInstructionCoder, utils } from "@coral-xyz/anchor";
import {
  DynamicBondingCurveIdl as idl,
  getDeltaAmountBaseUnsigned,
  getDeltaAmountQuoteUnsigned,
  Rounding,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

const eventCoder = new BorshEventCoder(idl as any);
const instructionCoder = new BorshInstructionCoder(idl as any);
export const accountsCoder = new BorshAccountsCoder(idl as any);

// Anchor emit_cpi! prefixes the event with this 8-byte tag (sha256("anchor:event")[..8]).
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export type DbcEvent = { name: string; data: Record<string, any> };

export function decodeEventIx(data: Uint8Array): DbcEvent | null {
  if (data.length < 16 || !EVENT_IX_TAG.equals(Buffer.from(data.subarray(0, 8)))) return null;
  return eventCoder.decode(Buffer.from(data.subarray(8)).toString("base64"));
}

export const decodeEventIxBase58 = (data: string) => decodeEventIx(utils.bytes.bs58.decode(data));

const INIT_POOL_IXS = new Set([
  "initialize_virtual_pool_with_spl_token",
  "initialize_virtual_pool_with_token2022",
  "initialize_virtual_pool_with_token2022_transfer_hook",
]);

export function decodeTokenMetadata(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  const ix = instructionCoder.decode(Buffer.from(data));
  return ix && INIT_POOL_IXS.has(ix.name) ? (ix.data as any).params : null;
}

const FEE_DENOMINATOR = 1e9;
const Q64 = 2 ** 64;
const BASE_FEE_MODES = ["linear-scheduler", "exponential-scheduler", "rate-limiter"] as const;

const num = (v: BN | number) => (typeof v === "number" ? v : Number(v.toString()));
const priceFromSqrt = (sqrtPrice: BN, baseDecimals: number, quoteDecimals: number) =>
  (num(sqrtPrice) / Q64) ** 2 * 10 ** (baseDecimals - quoteDecimals);

export type CurvePoint = { quote: number; soldPct: number; price: number; mcap: number };

// Walk the piecewise constant-liquidity curve from the start price to the migration price.
export function sampleCurve(c: any, quoteDecimals: number, supplyRaw: number, samplesPerSegment = 8): CurvePoint[] {
  const baseDecimals = c.token_decimal;
  const supply = supplyRaw / 10 ** baseDecimals;
  const end: BN = c.migration_sqrt_price;
  const point = (sqrt: BN, baseSold: BN, quote: BN): CurvePoint => {
    const price = priceFromSqrt(sqrt, baseDecimals, quoteDecimals);
    return { quote: num(quote) / 10 ** quoteDecimals, soldPct: (num(baseSold) / supplyRaw) * 100, price, mcap: price * supply };
  };
  let lower: BN = c.sqrt_start_price;
  let baseSold = new BN(0);
  let quote = new BN(0);
  const points = [point(lower, baseSold, quote)];
  for (const seg of c.curve) {
    if (seg.liquidity.isZero() || lower.gte(end)) break;
    const upper = BN.min(seg.sqrt_price, end);
    for (let k = 1; k <= samplesPerSegment; k++) {
      const p = lower.add(upper.sub(lower).muln(k).divn(samplesPerSegment));
      const b = baseSold.add(getDeltaAmountBaseUnsigned(lower, p, seg.liquidity, Rounding.Down));
      const q = quote.add(getDeltaAmountQuoteUnsigned(lower, p, seg.liquidity, Rounding.Down));
      points.push(point(p, b, q));
      if (k === samplesPerSegment) [baseSold, quote] = [b, q];
    }
    lower = upper;
  }
  return points;
}

// Where the token supply ends up: sold on the curve, paired as migration liquidity, vested to the
// creator, and whatever is left over (claimable by the config's leftover receiver after migration).
function supplySplit(c: any, supplyRaw: number) {
  const v = c.locked_vesting_config;
  const vesting = num(v.amount_per_period) * num(v.number_of_period) + num(v.cliff_unlock_amount);
  const curve = num(c.swap_base_amount);
  const migrationLp = num(c.migration_base_threshold);
  const pct = (x: number) => (x / supplyRaw) * 100;
  return { curve: pct(curve), migrationLp: pct(migrationLp), vesting: pct(vesting), leftover: pct(Math.max(supplyRaw - curve - migrationLp - vesting, 0)) };
}

const TRANSFER_HOOK_CONFIG = accountsCoder.accountDiscriminator("ConfigWithTransferHook");

// ConfigWithTransferHook embeds the same PoolConfig layout at offset 8, plus the hook program.
export function decodeConfig(data: Buffer) {
  if (!TRANSFER_HOOK_CONFIG.equals(data.subarray(0, 8))) return { ...accountsCoder.decode("PoolConfig", data), transfer_hook_program: null };
  const wrapped = accountsCoder.decode("ConfigWithTransferHook", data);
  return { ...wrapped.config, transfer_hook_program: wrapped.transfer_hook_program };
}

export function describeConfig(data: Buffer, quoteDecimals: number) {
  const c = decodeConfig(data);
  const supplyRaw = c.fixed_token_supply_flag
    ? num(c.pre_migration_token_supply)
    : num(c.swap_base_amount) + num(c.migration_base_threshold);
  const base = c.pool_fees.base_fee;
  const baseFeeMode = BASE_FEE_MODES[base.base_fee_mode] ?? "unknown";
  const curve = sampleCurve(c, quoteDecimals, supplyRaw);
  const shape = {
    quoteMint: c.quote_mint.toBase58(),
    tokenType: c.token_type ? "token-2022" : "spl",
    transferHook: c.transfer_hook_program?.toBase58() ?? null,
    tokenDecimals: c.token_decimal,
    activation: c.activation_type ? "timestamp" : "slot",
    baseFee: {
      mode: baseFeeMode,
      startBps: (num(base.cliff_fee_numerator) / FEE_DENOMINATOR) * 1e4,
      // scheduler: (periods, frequency, reduction); rate limiter: (increment bps, max duration, reference amount)
      factors: [base.first_factor, num(base.second_factor), num(base.third_factor)],
    },
    dynamicFee: !!c.pool_fees.dynamic_fee.initialized,
    collectFeeMode: c.collect_fee_mode,
    creatorTradingFeePct: c.creator_trading_fee_percentage,
    poolCreationFee: num(c.pool_creation_fee),
    migration: {
      target: c.migration_option ? "damm-v2" : "damm-v1",
      feeOption: c.migration_fee_option,
      feePct: c.migration_fee_percentage,
      creatorFeePct: c.creator_migration_fee_percentage,
      poolFeeBps: c.migrated_pool_fee_bps,
    },
    lp: {
      partnerLocked: c.partner_permanent_locked_liquidity_percentage,
      partner: c.partner_liquidity_percentage,
      creatorLocked: c.creator_permanent_locked_liquidity_percentage,
      creator: c.creator_liquidity_percentage,
      creatorVestingPct: c.creator_liquidity_vesting_info.vesting_percentage,
      partnerVestingPct: c.partner_liquidity_vesting_info.vesting_percentage,
    },
    lockedVesting: !num(c.locked_vesting_config.amount_per_period) && !num(c.locked_vesting_config.cliff_unlock_amount) ? null : {
      perPeriod: num(c.locked_vesting_config.amount_per_period),
      periods: num(c.locked_vesting_config.number_of_period),
      cliffUnlock: num(c.locked_vesting_config.cliff_unlock_amount),
    },
    supply: supplyRaw / 10 ** c.token_decimal,
    segments: c.curve.filter((s: any) => !s.liquidity.isZero()).length,
  };
  return {
    feeClaimer: c.fee_claimer.toBase58(),
    leftoverReceiver: c.leftover_receiver.toBase58(),
    // Launchpads often mint a config per token with per-token curve amounts, so the family key is
    // the template only (fees, LP split, vesting, migration); curve numbers stay per config.
    family: new Bun.CryptoHasher("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 12),
    mcapMultiple: curve.at(-1)!.mcap / curve[0].mcap,
    soldPctAtMigration: curve.at(-1)!.soldPct,
    supplySplit: supplySplit(c, supplyRaw),
    shape,
    migrationThreshold: num(c.migration_quote_threshold) / 10 ** quoteDecimals,
    initialMcap: curve[0].mcap,
    migrationMcap: curve.at(-1)!.mcap,
    curve,
  };
}
