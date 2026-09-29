export const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTES: Record<string, { symbol: string; decimals: number }> = {
  [SOL_MINT]: { symbol: "SOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
};

export const quoteSymbol = (mint: string, symbol?: string | null) => QUOTES[mint]?.symbol ?? symbol ?? short(mint);
export const quoteAmount = (raw: number, mint: string, decimals?: number | null) => raw / 10 ** (QUOTES[mint]?.decimals ?? decimals ?? 9);
export const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

const compactFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const compact = (n: number) => compactFormat.format(n);
export const pct = (x: number | null | undefined, digits = 0) => (x == null ? "–" : `${(x * 100).toFixed(digits)}%`);
export const num = (n: number, digits = 1) => n.toLocaleString("en", { maximumFractionDigits: digits });

// "36m", not "36m 0s".
const pair = (major: number, majorUnit: string, minor: number, minorUnit: string) =>
  `${major}${majorUnit}${minor ? ` ${minor}${minorUnit}` : ""}`;

export function duration(seconds: number | null | undefined) {
  if (seconds == null) return "–";
  if (seconds === 0) return "same block";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return pair(Math.floor(s / 60), "m", s % 60, "s");
  if (s < 86400) return pair(Math.floor(s / 3600), "h", Math.floor((s % 3600) / 60), "m");
  return `${(s / 86400).toFixed(1)}d`;
}

export const ago = (ts: number | null | undefined) => (ts ? `${duration(Date.now() / 1000 - ts)} ago` : "–");

// Months arrive as "2026-09".
const monthDate = (month: string) => new Date(`${month}-01T00:00:00Z`);
export const monthLabel = (month: string) => `${monthDate(month).toLocaleString("en", { month: "short", timeZone: "UTC" })} '${month.slice(2, 4)}`;
export const monthName = (month: string) => monthDate(month).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });

export const launchpadName = (launchpad: { id: string; name: string | null }) => launchpad.name ?? `Unlabeled launchpad ${short(launchpad.id)}`;

export type Shape = {
  quoteMint: string;
  tokenType: string;
  transferHook: string | null;
  baseFee: { mode: string; startBps: number; factors: number[] };
  dynamicFee: boolean;
  collectFeeMode: number;
  creatorTradingFeePct: number;
  migration: { target: string; feePct: number; poolFeeBps: number };
  lp: { partnerLocked: number; partner: number; creatorLocked: number; creator: number; creatorVestingPct: number; partnerVestingPct: number };
  lockedVesting: unknown;
  supply: number;
};

export function feeLabel(shape: Shape) {
  const { mode, startBps, factors } = shape.baseFee;
  const base = `${num(startBps / 100, 2)}%`;
  const scheduled = mode !== "rate-limiter" && factors[0] > 0;
  const creator = shape.creatorTradingFeePct ? `, ${shape.creatorTradingFeePct}% to creator` : "";
  const inToken = shape.collectFeeMode === 1 ? " in output token" : "";
  return `${base}${scheduled ? " decaying" : ""}${mode === "rate-limiter" ? " rate-limited" : ""}${shape.dynamicFee ? " + dynamic" : ""} fee${inToken}${creator}`;
}

export function lpLabel({ lp }: Shape) {
  const parts = [
    lp.creatorLocked && `${lp.creatorLocked}% creator locked`,
    lp.creator && `${lp.creator}% creator`,
    lp.partnerLocked && `${lp.partnerLocked}% partner locked`,
    lp.partner && `${lp.partner}% partner`,
  ].filter(Boolean);
  return parts.join(", ") || "none";
}

export const presetLabel = (shape: Shape, symbol?: string | null) =>
  [quoteSymbol(shape.quoteMint, symbol), feeLabel(shape), `LP ${lpLabel(shape)}`, shape.tokenType === "token-2022" ? "Token-2022" : "SPL"].join(" · ");
