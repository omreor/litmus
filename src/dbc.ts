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

const bs58 = utils.bytes.bs58;
const pubkeyAt = (b: Buffer, o: number) => bs58.encode(b.subarray(o, o + 32));

// Byte ranges the backfill downloads (getProgramAccounts dataSlice). Readers take account offsets.
// ConfigWithTransferHook embeds PoolConfig at offset 8 and TransferHookPool embeds the pool state the
// same way, so one slice layout serves both kinds.
export const CONFIG_SLICE = { offset: 8, length: 264 }; // quote_mint .. migration_quote_threshold
export const POOL_SLICE = { offset: 72, length: 280 }; // config .. finish_curve_timestamp

export function readConfigSlice(s: Buffer) {
  const at = (offset: number) => offset - CONFIG_SLICE.offset;
  return {
    quoteMint: pubkeyAt(s, at(8)),
    feeClaimer: pubkeyAt(s, at(40)),
    leftoverReceiver: pubkeyAt(s, at(72)),
    threshold: Number(s.readBigUInt64LE(at(264))),
    cliffFeeBps: Math.round(Number(s.readBigUInt64LE(at(104))) / 1e5), // numerator / 1e9 * 1e4
    baseFeeMode: s[at(130)],
    dynamicFee: s[at(136)],
    collectFeeMode: s[at(232)],
    migrationOption: s[at(233)],
    activationType: s[at(234)],
    tokenDecimals: s[at(235)],
    tokenType: s[at(237)],
    migrationFeeOption: s[at(243)],
    creatorFeePct: s[at(245)],
  };
}
export type ConfigFields = ReturnType<typeof readConfigSlice>;

// Template = the launch terms that matter for outcomes, ignoring who owns the config and per-token
// curve amounts. Thresholds are rounded to 2 significant digits so near-identical copies
// (10.95 vs 11.2 SOL) group together.
export function templateOf(c: ConfigFields) {
  const fingerprint = [
    c.quoteMint, c.threshold ? Number(c.threshold.toPrecision(2)) : 0, c.cliffFeeBps, c.baseFeeMode, c.migrationOption,
    c.migrationFeeOption, c.collectFeeMode, c.creatorFeePct, c.tokenType, c.tokenDecimals, c.activationType, c.dynamicFee,
  ];
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 12);
}

export function readPoolSlice(s: Buffer) {
  const at = (offset: number) => offset - POOL_SLICE.offset;
  return {
    config: pubkeyAt(s, at(72)),
    creator: pubkeyAt(s, at(104)),
    baseMint: pubkeyAt(s, at(136)),
    quoteReserve: s.readBigUInt64LE(at(240)),
    activationPoint: Number(s.readBigUInt64LE(at(296))),
    // metrics.total_protocol_quote_fee + total_trading_quote_fee (lifetime, quote side only)
    feesQuote: s.readBigUInt64LE(at(320)) + s.readBigUInt64LE(at(336)),
    finishedAt: Number(s.readBigUInt64LE(at(344))),
  };
}

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

export const dbcIxName = (data: Uint8Array) => instructionCoder.decode(Buffer.from(data))?.name ?? null;

const SWAP_IXS = new Set(["swap", "swap2", "swap2_with_transfer_hook"]);
const SWAP_POOL = 2;
const SWAP_PAYER = 9;
const INIT_CREATOR = 2;
const initPayer = new Map(
  [...INIT_POOL_IXS].map((name) => [name, (idl as any).instructions.find((ix: any) => ix.name === name).accounts.findIndex((a: any) => a.name === "payer")]),
);

// A transaction reduced to its DBC instructions (top-level and CPI, events included) in execution order,
// with account indices into accountKeys. Built from gRPC updates, RPC getTransaction results and the
// .scratch/raw archive alike.
export type DbcTx = { sig: string; slot: number; blockTime: number; accountKeys: string[]; ixs: { accounts: ArrayLike<number>; data: Uint8Array }[] };

export type TokenMetadata = { name: string; symbol: string; uri: string };
export type DbcStep =
  | { kind: "launch"; pool: string; config: string; creator: string; mint: string; signer: string | null; meta?: TokenMetadata }
  // quote: what the trader paid or received; net: the change in the pool's quote reserve (fees excluded)
  | { kind: "swap"; pool: string; config: string; trader: string; buy: boolean; quote: bigint; net: bigint; reserve: bigint | null; threshold: bigint | null; ts: number }
  | { kind: "complete"; pool: string; config: string; quoteReserve: bigint }
  | { kind: "config"; config: string; feeClaimer: string; quoteMint: string };

const QUOTE_TO_BASE = 1;
const b58 = (v: { toBase58(): string }) => v.toBase58();
// The program emits a legacy event next to its v2 counterpart for the same action (every swap: EvtSwap +
// EvtSwap2; config creation: EvtCreateConfig + EvtCreateConfigV2). Only the v2 event counts.
const SUPERSEDED_BY: Record<string, string[]> = {
  EvtSwap: ["EvtSwap2", "EvtSwap2WithTransferHook"],
  EvtCreateConfig: ["EvtCreateConfigV2", "EvtCreateConfigV2WithTransferHook"],
};

// Events carry no trader: it's the payer of the swap instruction that emitted them, paired per pool in order.
export function decodeDbcTx(tx: DbcTx): DbcStep[] {
  const traders = new Map<string, string[]>();
  const inits: { meta: TokenMetadata; signer: string | null }[] = [];
  const events: DbcEvent[] = [];
  for (const ix of tx.ixs) {
    const event = decodeEventIx(ix.data);
    if (event) {
      events.push(event);
      continue;
    }
    const decoded = instructionCoder.decode(Buffer.from(ix.data));
    if (!decoded) continue;
    const key = (i: number) => tx.accountKeys[ix.accounts[i]] ?? null;
    if (SWAP_IXS.has(decoded.name)) {
      const pool = key(SWAP_POOL);
      if (pool) traders.set(pool, [...(traders.get(pool) ?? []), key(SWAP_PAYER) ?? tx.accountKeys[0]]);
    } else if (INIT_POOL_IXS.has(decoded.name)) {
      inits.push({ meta: (decoded.data as any).params, signer: key(initPayer.get(decoded.name)) ?? key(INIT_CREATOR) });
    }
  }
  const names = new Set(events.map((e) => e.name));
  return events.filter((e) => !SUPERSEDED_BY[e.name]?.some((v2) => names.has(v2))).flatMap(({ name, data: e }): DbcStep[] => {
    switch (name) {
      case "EvtInitializePool":
      case "EvtInitializePoolWithTransferHook": {
        const init = inits.shift();
        return [{ kind: "launch", pool: b58(e.pool), config: b58(e.config), creator: b58(e.creator), mint: b58(e.base_mint), signer: init?.signer ?? null, meta: init?.meta }];
      }
      case "EvtSwap2":
      case "EvtSwap2WithTransferHook":
      case "EvtSwap": {
        const pool = b58(e.pool);
        const buy = e.trade_direction === QUOTE_TO_BASE;
        const v2 = name !== "EvtSwap";
        const quote = BigInt(buy ? (v2 ? e.swap_result.included_fee_input_amount : e.amount_in) : e.swap_result.output_amount);
        const net = buy ? BigInt(v2 ? e.swap_result.excluded_fee_input_amount : e.swap_result.actual_input_amount) : -quote;
        return [{
          kind: "swap", pool, config: b58(e.config), trader: traders.get(pool)?.shift() ?? tx.accountKeys[0], buy, quote, net,
          reserve: v2 ? BigInt(e.quote_reserve_amount) : null, threshold: v2 ? BigInt(e.migration_threshold) : null, ts: Number(e.current_timestamp),
        }];
      }
      case "EvtCurveComplete":
      case "EvtCurveCompleteWithTransferHook":
        return [{ kind: "complete", pool: b58(e.pool), config: b58(e.config), quoteReserve: BigInt(e.quote_reserve) }];
      case "EvtCreateConfig":
      case "EvtCreateConfigV2":
      case "EvtCreateConfigV2WithTransferHook":
        return [{ kind: "config", config: b58(e.config), feeClaimer: b58(e.fee_claimer), quoteMint: b58(e.quote_mint) }];
    }
    return [];
  });
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
