import {
  ActivationType,
  BaseFeeMode,
  buildCurveWithLiquidityWeights,
  buildCurveWithMarketCap,
  buildCurveWithTwoSegments,
  CollectFeeMode,
  getMigrationThresholdPrice,
  MAX_CURVE_POINT,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  validateConfigParameters,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { sampleCurve } from "./dbc";

export const QUOTES = {
  SOL: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
} as const;

const MIGRATED_FEE_OPTIONS: Record<number, MigrationFeeOption> = {
  25: MigrationFeeOption.FixedBps25,
  30: MigrationFeeOption.FixedBps30,
  100: MigrationFeeOption.FixedBps100,
  200: MigrationFeeOption.FixedBps200,
  400: MigrationFeeOption.FixedBps400,
  600: MigrationFeeOption.FixedBps600,
};
const FEE_PERIODS = 60;
const MIN_LEFTOVER_PCT = 0.01;
const BASE_DECIMALS = TokenDecimal.SIX;
const VALIDATION_RECEIVER = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

export type StudioInput = {
  quote: keyof typeof QUOTES;
  tokenType: "spl" | "token-2022";
  supply: number;
  initialMcap: number;
  migrationMcap: number;
  shape: "market-cap" | "two-segment" | "weighted";
  supplyOnMigrationPct: number;
  steepness: number;
  leftoverPct: number;
  feeStartBps: number;
  feeEndBps: number;
  feeDecaySeconds: number;
  feeMode: "linear" | "exponential";
  dynamicFee: boolean;
  creatorFeePct: number;
  lp: { partnerLocked: number; partner: number; creatorLocked: number; creator: number };
  migratedPoolFeeBps: number;
};

export function buildConfigParameters(input: StudioInput): ConfigParameters {
  const quote = QUOTES[input.quote];
  const decays = input.feeDecaySeconds > 0 && input.feeStartBps > input.feeEndBps;
  const base = {
    token: {
      tokenType: input.tokenType === "spl" ? TokenType.SPLToken : TokenType.Token2022,
      tokenBaseDecimal: BASE_DECIMALS,
      tokenQuoteDecimal: quote.decimals,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: input.supply,
      // The curve builders round up; a tiny leftover absorbs the delta (0 fails for most shapes).
      leftover: Math.round((input.supply * Math.max(input.leftoverPct, MIN_LEFTOVER_PCT)) / 100),
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: (input.feeMode === "linear" ? BaseFeeMode.FeeSchedulerLinear : BaseFeeMode.FeeSchedulerExponential) as
          | BaseFeeMode.FeeSchedulerLinear
          | BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: input.feeStartBps,
          endingFeeBps: decays ? input.feeEndBps : input.feeStartBps,
          numberOfPeriod: decays ? FEE_PERIODS : 0,
          totalDuration: decays ? input.feeDecaySeconds : 0,
        },
      },
      dynamicFeeEnabled: input.dynamicFee,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: input.creatorFeePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MIGRATED_FEE_OPTIONS[input.migratedPoolFeeBps] ?? MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: input.lp.partnerLocked,
      partnerLiquidityPercentage: input.lp.partner,
      creatorPermanentLockedLiquidityPercentage: input.lp.creatorLocked,
      creatorLiquidityPercentage: input.lp.creator,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
  };
  const caps = { initialMarketCap: input.initialMcap, migrationMarketCap: input.migrationMcap };
  if (input.shape === "two-segment") return buildCurveWithTwoSegments({ ...base, ...caps, percentageSupplyOnMigration: input.supplyOnMigrationPct });
  if (input.shape === "weighted") {
    // steepness > 1 back-loads liquidity (price climbs slowly, then fast); < 1 front-loads it.
    const weights = Array.from({ length: MAX_CURVE_POINT }, (_, i) => Math.pow(1 + i, input.steepness - 1));
    return buildCurveWithLiquidityWeights({ ...base, ...caps, liquidityWeights: weights });
  }
  return buildCurveWithMarketCap({ ...base, ...caps });
}

export function buildStudio(input: StudioInput) {
  const quote = QUOTES[input.quote];
  const params = buildConfigParameters(input);
  // validateConfigParameters rejects the default key as leftover receiver; any real key works here.
  validateConfigParameters({ ...params, leftoverReceiver: VALIDATION_RECEIVER } as any);
  const supplyRaw = input.supply * 10 ** BASE_DECIMALS;
  const configLike = {
    token_decimal: BASE_DECIMALS,
    sqrt_start_price: params.sqrtStartPrice,
    curve: params.curve.map((c: { sqrtPrice: BN; liquidity: BN }) => ({ sqrt_price: c.sqrtPrice, liquidity: c.liquidity })),
    migration_sqrt_price: getMigrationThresholdPrice(params.migrationQuoteThreshold, params.sqrtStartPrice, params.curve),
  };
  const curve = sampleCurve(configLike, quote.decimals, supplyRaw);
  const soldPct = curve.at(-1)!.soldPct;
  return {
    curve,
    migrationThreshold: Number(params.migrationQuoteThreshold.toString()) / 10 ** quote.decimals,
    initialMcap: curve[0].mcap,
    migrationMcap: curve.at(-1)!.mcap,
    segments: params.curve.length,
    supplySplit: {
      curve: soldPct,
      leftover: Math.max(input.leftoverPct, MIN_LEFTOVER_PCT),
      vesting: 0,
      migrationLp: Math.max(100 - soldPct - Math.max(input.leftoverPct, MIN_LEFTOVER_PCT), 0),
    },
  };
}
