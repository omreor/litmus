import { utils } from "@coral-xyz/anchor";
import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import Client, { CommitmentLevel, SubscribeUpdate, type SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { DBC_PROGRAM_ID, type DbcTx } from "./dbc";
import { connection } from "./enrich";
import { handleTransaction } from "./indexer";

const bs58 = utils.bytes.bs58;
const SLOT_SECONDS = 0.4;

export const streamHealth = { transport: "none", connectedAt: 0, updates: 0, lastUpdateAt: 0, slot: 0 };

// Transaction updates carry a slot but no block time; extrapolate from the latest block meta.
let clock = { slot: 0, time: 0 };
const slotTime = (slot: number) =>
  clock.slot ? Math.round(clock.time + (slot - clock.slot) * SLOT_SECONDS) : Math.floor(Date.now() / 1000);

// Shared by gRPC and Mirage: Mirage relays the same SubscribeUpdate frames over a WebSocket.
function handleUpdate(update: SubscribeUpdate) {
  streamHealth.updates++;
  streamHealth.lastUpdateAt = Date.now();
  if (update.blockMeta?.blockTime) {
    clock = { slot: Number(update.blockMeta.slot), time: Number(update.blockMeta.blockTime.timestamp) };
    streamHealth.slot = clock.slot;
  }
  const info = update.transaction?.transaction;
  const message = info?.transaction?.message;
  if (!info?.meta || !message || info.meta.err) return;
  const meta = info.meta;
  const accountKeys = [...message.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses].map((k) => bs58.encode(k));
  const dbc = accountKeys.indexOf(DBC_PROGRAM_ID);
  const slot = Number(update.transaction!.slot);
  handleTransaction({
    sig: bs58.encode(info.signature), slot, blockTime: slotTime(slot), accountKeys,
    ixs: [...message.instructions, ...meta.innerInstructions.flatMap((group) => group.instructions)].filter((ix) => ix.programIdIndex === dbc),
  }, "live");
}

const subscribeRequest: SubscribeRequest = {
  transactions: { dbc: { accountInclude: [DBC_PROGRAM_ID], accountExclude: [], accountRequired: [], vote: false, failed: false } },
  blocksMeta: { clock: {} },
  commitment: CommitmentLevel.CONFIRMED,
  accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, entry: {}, accountsDataSlice: [],
};

export async function streamGrpc(endpoint: string, token: string) {
  const client = new Client(endpoint, token, undefined, { enabled: true });
  await client.connect();
  const stream = await client.subscribe();
  stream.on("data", handleUpdate);
  stream.on("error", (e) => console.error("grpc stream", e));
  stream.write(subscribeRequest);
  Object.assign(streamHealth, { transport: "solami-grpc", connectedAt: Date.now() });
  // Keep load balancers from idling the stream out.
  setInterval(() => stream.write({ ...subscribeRequest, ping: { id: 1 } }), 15_000);
}

// Mirage: the subscription (filter) is created once in the Solami dashboard or via POST /mirage/create.
export function streamMirage(subscriptionId: string, apiKey: string) {
  const ws = new WebSocket(`wss://ws.solami.dev/mirage/stream/${subscriptionId}?api_key=${apiKey}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => Object.assign(streamHealth, { transport: "solami-mirage", connectedAt: Date.now() });
  ws.onmessage = (e) => handleUpdate(SubscribeUpdate.decode(new Uint8Array(e.data as ArrayBuffer)));
  ws.onclose = (e) => {
    console.error("mirage closed", e.code, e.reason);
    // 4002 = bandwidth/balance exhausted: back off instead of hot-looping.
    setTimeout(() => streamMirage(subscriptionId, apiKey), e.code === 4002 ? 60_000 : 2_000);
  };
}

// RPC getTransaction (jsonParsed-free "json" encoding) to DbcTx: DBC instructions only, top-level then CPIs.
export function normalizeRpcTx(sig: string, tx: VersionedTransactionResponse): DbcTx {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const lookups = keys.accountKeysFromLookups;
  const accountKeys = [...keys.staticAccountKeys, ...(lookups?.writable ?? []), ...(lookups?.readonly ?? [])].map((k) => k.toBase58());
  const dbc = accountKeys.indexOf(DBC_PROGRAM_ID);
  return {
    sig, slot: tx.slot, blockTime: tx.blockTime ?? Math.floor(Date.now() / 1000), accountKeys,
    ixs: [
      ...tx.transaction.message.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accountKeyIndexes, data: ix.data })),
      ...(tx.meta?.innerInstructions ?? []).flatMap((group) =>
        group.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: bs58.decode(ix.data) })),
      ),
    ].filter((ix) => ix.programIdIndex === dbc),
  };
}

// ponytail: RPC sampler for local dev only - public RPCs can't keep up with the full DBC firehose,
// so it takes the newest `perPoll` transactions each round and skips the rest.
export async function pollRpc(perPoll = 15, intervalMs = 3000) {
  const program = new PublicKey(DBC_PROGRAM_ID);
  Object.assign(streamHealth, { transport: "rpc-sampler", connectedAt: Date.now() });
  let newest: string | undefined;
  while (true) {
    try {
      const sigs = await connection.getSignaturesForAddress(program, { limit: perPoll, until: newest });
      if (sigs.length) newest = sigs[0].signature;
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        await Bun.sleep(100);
        // web3.js v1 can't parse v1 (SIMD-0385) transactions; skip those in the sampler.
        const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
        if (!tx?.meta) continue;
        handleTransaction(normalizeRpcTx(s.signature, tx), "live");
        Object.assign(streamHealth, { updates: streamHealth.updates + 1, lastUpdateAt: Date.now(), slot: tx.slot });
      }
    } catch (e) {
      console.error("rpc poll", String(e).slice(0, 200));
    }
    await Bun.sleep(intervalMs);
  }
}
