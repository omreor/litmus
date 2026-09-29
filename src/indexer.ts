import { DBC_PROGRAM_ID, decodeEventIx, decodeTokenMetadata, type DbcEvent } from "./dbc";
import { queueConfig } from "./enrich";
import { cleanText } from "./metadata";
import { recordGraduation, recordLaunch, recordSwap } from "./store";

export type FeedItem =
  | { type: "launch"; ts: number; sig: string; pool: string; config: string; creator: string; mint: string; name?: string; symbol?: string; uri?: string }
  | { type: "graduation"; ts: number; sig: string; pool: string; config: string; quoteReserve: string }
  | { type: "config"; ts: number; sig: string; config: string; feeClaimer: string; quoteMint: string };

const listeners = new Set<(item: FeedItem) => void>();
export const subscribeFeed = (fn: (item: FeedItem) => void) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (item: FeedItem) => listeners.forEach((fn) => fn(item));

const QUOTE_TO_BASE = 1;
const key = (v: { toBase58(): string }) => v.toBase58();

type TokenMetadata = { name: string; symbol: string; uri: string };

export function handleEvent({ name, data: e }: DbcEvent, blockTime: number, sig: string, meta?: TokenMetadata) {
  if (e.config) queueConfig(key(e.config));
  switch (name) {
    case "EvtInitializePool":
    case "EvtInitializePoolWithTransferHook": {
      const [pool, config, creator, mint] = [key(e.pool), key(e.config), key(e.creator), key(e.base_mint)];
      recordLaunch(pool, config, creator, mint, blockTime, meta);
      return emit({ type: "launch", ts: blockTime, sig, pool, config, creator, mint, ...meta });
    }
    case "EvtSwap2":
    case "EvtSwap2WithTransferHook": {
      const buy = e.trade_direction === QUOTE_TO_BASE;
      const volume = buy ? e.swap_result.included_fee_input_amount : e.swap_result.output_amount;
      return recordSwap({
        pool: key(e.pool), config: key(e.config), buy, ts: Number(e.current_timestamp),
        reserve: BigInt(e.quote_reserve_amount), threshold: BigInt(e.migration_threshold), volume: BigInt(volume),
      });
    }
    case "EvtCurveComplete":
    case "EvtCurveCompleteWithTransferHook": {
      const [pool, config] = [key(e.pool), key(e.config)];
      recordGraduation(pool, config, BigInt(e.quote_reserve), blockTime);
      return emit({ type: "graduation", ts: blockTime, sig, pool, config, quoteReserve: e.quote_reserve.toString() });
    }
    case "EvtCreateConfig":
    case "EvtCreateConfigV2":
    case "EvtCreateConfigV2WithTransferHook":
      return emit({
        type: "config", ts: blockTime, sig, config: key(e.config), feeClaimer: key(e.fee_claimer), quoteMint: key(e.quote_mint),
      });
  }
}

type Ix = { programIdIndex: number; data: Uint8Array };

// Source-agnostic: works for RPC getTransaction results and Yellowstone gRPC updates once both are
// normalised to account keys + instruction data. The pool-init call can be top-level or a CPI from a
// launchpad program; its name/symbol/uri args get paired with the launch event of the same tx.
export function handleTransaction(tx: { sig: string; blockTime: number; accountKeys: string[]; instructions: Ix[]; innerInstructions: Ix[] }) {
  const dbc = [...tx.instructions, ...tx.innerInstructions].filter((ix) => tx.accountKeys[ix.programIdIndex] === DBC_PROGRAM_ID);
  const events = dbc.map((ix) => decodeEventIx(ix.data)).filter((e) => e !== null);
  const metadata = dbc.map((ix) => (events.length ? decodeTokenMetadata(ix.data) : null)).filter((m) => m !== null);
  for (const event of events) {
    const meta = event.name.startsWith("EvtInitializePool") ? metadata.shift() : undefined;
    handleEvent(event, tx.blockTime, tx.sig, meta && { name: cleanText(meta.name), symbol: cleanText(meta.symbol), uri: meta.uri });
  }
}
