import homepage from "../web/index.html";
import { benchmarkBuckets, launchpads, launchpadsAllTime, monthly, QUOTE_MINTS, similar, templateDetail, templates, WINDOWS } from "./aggregates";
import { rebuildEvidence, replayArchive } from "./archive";
import { describeNow, flushConfigs, queueConfig, redescribeConfigs } from "./enrich";
import { checkFundingBatch } from "./funding";
import { flushVerdicts, subscribeFeed } from "./indexer";
import { judgeAll, RULES, RULES_VERSION, rulesStale } from "./integrity";
import { sweepMetadata, sweepQuotes } from "./metadata";
import { outcomesByVerdict, readHistory, snapshotGraduations } from "./postgrad";
import { replay } from "./replay";
import { configDetail, graduationsRecent, hotPools, overview, poolDetail, usage } from "./stats";
import { db } from "./store";
import { pollRpc, streamGrpc, streamHealth, streamMirage } from "./stream";
import { buildStudio } from "./studio";
import { createConfigTx, createPoolTx, sendSigned, studioAction, tokenMeta } from "./tx";

const SOL_MINT = "So11111111111111111111111111111111111111112";
let solUsd = 0;
async function refreshSolPrice() {
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
    solUsd = (await res.json())[SOL_MINT]?.usdPrice ?? solUsd;
  } catch {}
}
refreshSolPrice();
setInterval(refreshSolPrice, 60_000);

// Usage metrics (traction is judged): requests per route per day, buffered and flushed every minute.
const today = () => new Date().toISOString().slice(0, 10);
let hits = new Map<string, number>();
const bumpUsage = db.prepare(`INSERT INTO usage (day, route, count) VALUES (?, ?, ?)
  ON CONFLICT(day, route) DO UPDATE SET count = count + excluded.count`);
const maxUsage = db.prepare(`INSERT INTO usage (day, route, count) VALUES (?, ?, ?)
  ON CONFLICT(day, route) DO UPDATE SET count = MAX(count, excluded.count)`);
const stream = { current: 0, peak: 0 };
setInterval(() => {
  const [flushed, day] = [hits, today()];
  hits = new Map();
  db.transaction(() => {
    flushed.forEach((n, route) => bumpUsage.run(day, route, n));
    maxUsage.run(day, "ws:peak", stream.peak);
  }).immediate();
}, 60_000);

// Every route is open to other sites (CORS: the UI on GitHub Pages calls the API through the tunnel);
// GET routes are counted.
const CORS = { "access-control-allow-origin": "*" };
const PREFLIGHT = { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const notFound = (what: string) => json({ error: `unknown ${what}` }, 404);
type Req = Request & { params: Record<string, string> };
const get = (route: string, fn: (req: Req, url: URL) => unknown) => async (req: Req) => {
  hits.set(route, (hits.get(route) ?? 0) + 1);
  try {
    const body = await fn(req, new URL(req.url));
    return body instanceof Response ? body : json(body);
  } catch (e) {
    console.error(route, e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
};

async function handle(req: Request, fn: (body: any) => unknown) {
  try {
    return json(await fn(await req.json()));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 422);
  }
}
const post = (fn: (body: any) => unknown) => ({
  POST: (req: Request) => handle(req, fn),
  OPTIONS: () => new Response(null, { status: 204, headers: PREFLIGHT }),
});

// A Studio token's metadata must resolve at its Pages URL (tx.ts META_URL) by the time the launch lands:
// published as soon as the launch is prepared, one run at a time, requests made meanwhile coalesced.
let publishing = false;
let publishAgain = false;
async function publishMeta() {
  if (publishing) return void (publishAgain = true);
  publishing = true;
  do {
    publishAgain = false;
    const proc = Bun.spawn(["scripts/publish.sh", "meta"], { stdout: "ignore", stderr: "pipe" });
    if (await proc.exited) console.error("token metadata publish failed:", (await new Response(proc.stderr).text()).trim().slice(-300));
  } while (publishAgain);
  publishing = false;
}

// Full-history aggregates come from a Worker (aggregates.ts) that recomputes them on a timer; requests
// for parameters it doesn't precompute are computed here, and briefly cached.
const aggregates = new Map<string, any>();
const worker = new Worker(new URL("./aggregates.ts", import.meta.url));
worker.onmessage = ({ data }: MessageEvent<{ key: string; value: any }>) => {
  if (data.key === "describe") data.value.forEach(queueConfig);
  else if (data.key === "round") console.log("aggregates round", data.value);
  else aggregates.set(data.key, data.value);
};
const shortCache = new Map<string, { at: number; value: unknown }>();
function computed<T>(key: string, fn: () => T, ttlMs = 300_000): T {
  if (aggregates.has(key)) return aggregates.get(key);
  const hit = shortCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = fn();
  shortCache.set(key, { at: Date.now(), value });
  return value;
}

const windowOf = (url: URL) => Number(url.searchParams.get("window") ?? 86400);
const since = (url: URL) => Math.floor(Date.now() / 1000) - windowOf(url);
const allTime = () => computed("launchpadsAllTime", launchpadsAllTime, 600_000);

function launchpadRows(url: URL) {
  const w = windowOf(url);
  return computed(`launchpads:${w}`, () => launchpads(since(url), allTime()), 60_000);
}
function templateRows(url: URL) {
  const organic = url.searchParams.get("organic") === "1" ? 1 : 0;
  return computed(`templates:${windowOf(url)}:${organic}`, () => templates(since(url), !!organic), 60_000);
}
async function templateById(id: string) {
  const odds = aggregates.get("odds") ?? {};
  const cachedDetail = aggregates.get(`template:${id}`) ?? shortCache.get(`template:${id}`)?.value;
  if (cachedDetail) return cachedDetail;
  const describe = new Set<string>();
  let detail = templateDetail(id, odds, describe);
  if (!detail && describe.size) {
    await Promise.all([...describe].map(describeNow));
    detail = templateDetail(id, odds);
  }
  if (detail) shortCache.set(`template:${id}`, { at: Date.now(), value: detail });
  return detail;
}
function benchmarks(url: URL) {
  const q = url.searchParams.get("quote") ?? "SOL";
  const symbol = Object.entries(QUOTE_MINTS).find(([s, mint]) => q === s || q === mint)?.[0];
  if (!symbol) return json({ error: "quote must be SOL or USDC" }, 422);
  const buckets = computed(`benchmarks:${symbol}`, () => benchmarkBuckets(symbol), 600_000);
  return similar(buckets, Number(url.searchParams.get("threshold") ?? 0));
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  routes: {
    "/": homepage,
    "/api/overview": get("overview", (_, url) => ({ ...overview(since(url)), solUsd })),
    "/api/integrity/monthly": get("integrity/monthly", () => computed("monthly", monthly, 600_000)),
    "/api/integrity/postgrad": get("integrity/postgrad", () => computed("postgrad", () => outcomesByVerdict(), 600_000)),
    "/api/launchpads": get("launchpads", (_, url) => launchpadRows(url)),
    "/api/templates": get("templates", (_, url) => templateRows(url)),
    "/api/templates/:id": get("templates/:id", async (req) => (await templateById(req.params.id)) ?? notFound("template")),
    // v1 names, kept until every client moves to /api/templates.
    "/api/families": get("families", (_, url) => templateRows(url)),
    "/api/families/:family": get("families/:family", async (req) => (await templateById(req.params.family)) ?? notFound("template")),
    "/api/configs/:address": get("configs/:address", async (req) => (await configDetail(req.params.address)) ?? notFound("config")),
    "/api/pools/hot": get("pools/hot", () => hotPools(aggregates.get("odds") ?? {})),
    "/api/pools/:address": get("pools/:address", (req) => poolDetail(req.params.address) ?? notFound("pool")),
    "/api/graduations/recent": get("graduations/recent", (_, url) => graduationsRecent(Number(url.searchParams.get("limit") ?? 50))),
    "/api/benchmarks/similar": get("benchmarks/similar", (_, url) => benchmarks(url)),
    "/api/rules": get("rules", () => ({ version: RULES_VERSION, rules: RULES })),
    "/api/usage": get("usage", () => usage(stream)),
    "/api/health": get("health", () => streamHealth),
    "/api/studio/build": post(buildStudio),
    "/api/studio/deploy": post((b) => createConfigTx(b.input, b.wallet)),
    "/api/studio/launch": post(async (b) => {
      const prepared = await createPoolTx(b);
      publishMeta();
      return prepared;
    }),
    "/api/tx/send": post(async (b) => {
      const signature = await sendSigned(b.tx);
      const action = studioAction(b.tx);
      if (action) db.query("INSERT OR IGNORE INTO studio_txs (signature, kind, at, account) VALUES (?, ?, ?, ?)")
        .run(signature, action.kind, Math.floor(Date.now() / 1000), action.account);
      return { signature };
    }),
    // Metadata of tokens launched before it moved to GitHub Pages.
    "/api/meta/:mint": (req) => {
      const meta = tokenMeta(req.params.mint);
      return meta ? new Response(meta, { headers: { "content-type": "application/json", ...CORS } }) : json({}, 404);
    },
    "/api/stream": (req, srv) => {
      hits.set("stream", (hits.get("stream") ?? 0) + 1);
      return srv.upgrade(req) ? undefined : new Response("expected websocket", { status: 400 });
    },
  },
  websocket: {
    open(ws) {
      ws.subscribe("feed");
      stream.peak = Math.max(stream.peak, ++stream.current);
    },
    close() {
      stream.current--;
    },
    message() {},
  },
});

// Runs `fn` every `ms`, never overlapping itself.
function every(ms: number, name: string, fn: () => Promise<unknown> | unknown) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(name, String(e).replace(/api_key=[^&\s"]+/g, "api_key=***").slice(0, 300));
    }
    running = false;
  }, ms);
}

await redescribeConfigs();
console.log("archive catch-up", replayArchive());
// Before the stream starts: see rebuildEvidence.
const rebuilt = rebuildEvidence();
if (rebuilt) console.log("evidence rebuilt from the archive", rebuilt);
if (rulesStale()) console.log("rules changed, re-judged", judgeAll());
subscribeFeed((item) => server.publish("feed", JSON.stringify(item)));
every(2000, "enrich", flushConfigs);
every(2000, "metadata", sweepMetadata);
every(600_000, "quotes", sweepQuotes);
every(10_000, "verdicts", flushVerdicts);
every(600_000, "post-graduation", snapshotGraduations);
// Re-reads every graduated pool twice a day, so "still trading" compares two reads: checked every half
// hour for reads older than 12 h, so restarts never push the re-read back.
every(1_800_000, "post-graduation history", () => readHistory());
// Pools trading right now that were created before we watched them get their history replayed, closest
// to graduation first; new contested graduations get their funding-source check.
every(60_000, "hot replay", async () => {
  const done = await replay("hot", 58, 8);
  if (done.pools) console.log("hot replay", done);
});
every(300_000, "funding", async () => {
  const done = await checkFundingBatch(10);
  if (done.checked || done.errors) console.log("funding check", done);
});
// Picks up what src/record.ts archived while this server was down or its stream reconnected.
every(300_000, "archive", replayArchive);
sweepQuotes().catch((e) => console.error("quotes", e));
const { SOLAMI_API_KEY, SOLAMI_GRPC_URL = "https://grpc.solami.dev", MIRAGE_ID } = process.env;
if (SOLAMI_API_KEY && MIRAGE_ID) streamMirage(MIRAGE_ID, SOLAMI_API_KEY);
else if (SOLAMI_API_KEY) await streamGrpc(SOLAMI_GRPC_URL, SOLAMI_API_KEY);
else pollRpc();
setTimeout(() => console.log("archive catch-up", replayArchive()), 90_000);
console.log(`litmus on ${server.url}`);
