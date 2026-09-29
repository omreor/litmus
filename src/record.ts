// Archives every DBC transaction (keys + DBC instructions only) as hourly gzipped JSONL so any
// future schema can be rebuilt by replay. Usage: SOLAMI_API_KEY=... bun src/record.ts [dir]
import { utils } from "@coral-xyz/anchor";
import Client, { CommitmentLevel, type SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { appendFileSync, mkdirSync } from "node:fs";
import { DBC_PROGRAM_ID } from "./dbc";

const dir = process.argv[2] ?? ".scratch/raw";
mkdirSync(dir, { recursive: true });
const bs58 = utils.bytes.bs58;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let hour = "";
let lines: string[] = [];
function flush() {
  if (!lines.length) return;
  appendFileSync(`${dir}/${hour}.jsonl.gz`, Bun.gzipSync(lines.join("\n") + "\n")); // concatenated gzip members
  lines = [];
}

function record(update: SubscribeUpdate) {
  const info = update.transaction?.transaction;
  const message = info?.transaction?.message;
  if (!info?.meta || !message || info.meta.err) return;
  const meta = info.meta;
  const keys = [...message.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses].map((k) => bs58.encode(k));
  const dbc = keys.indexOf(DBC_PROGRAM_ID);
  const pick = (ix: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }, inner: boolean) =>
    ix.programIdIndex === dbc ? [{ inner, accounts: [...ix.accounts], data: b64(ix.data) }] : [];
  const now = new Date();
  const h = now.toISOString().slice(0, 13);
  if (h !== hour) [flush(), (hour = h)];
  lines.push(JSON.stringify({
    sig: bs58.encode(info.signature), slot: Number(update.transaction!.slot), seen: Math.floor(now.getTime() / 1000), keys,
    ixs: [...message.instructions.flatMap((ix) => pick(ix, false)), ...meta.innerInstructions.flatMap((g) => g.instructions.flatMap((ix) => pick(ix, true)))],
  }));
}

const client = new Client(process.env.SOLAMI_GRPC_URL ?? "https://grpc.solami.dev", process.env.SOLAMI_API_KEY!, undefined, { enabled: true });
await client.connect();
const stream = await client.subscribe();
stream.on("data", record);
stream.on("error", (e) => console.error(new Date().toISOString(), "grpc", String(e).slice(0, 300)));
const request = {
  transactions: { dbc: { accountInclude: [DBC_PROGRAM_ID], accountExclude: [], accountRequired: [], vote: false, failed: false } },
  commitment: CommitmentLevel.CONFIRMED,
  accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
};
stream.write(request);
setInterval(flush, 60_000);
setInterval(() => stream.write({ ...request, ping: { id: 1 } }), 15_000);
console.log(new Date().toISOString(), "recording DBC transactions to", dir);
