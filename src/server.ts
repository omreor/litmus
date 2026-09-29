import homepage from "../web/index.html";
import { flushConfigs, redescribeConfigs } from "./enrich";
import { sweepMetadata } from "./metadata";
import { subscribeFeed } from "./indexer";
import { config, families, family, graduationOdds, hotPools, overview } from "./stats";
import { pollRpc, streamGrpc, streamHealth, streamMirage } from "./stream";
import { buildStudio } from "./studio";
import { createConfigTx, createPoolTx, sendSigned, tokenMeta } from "./tx";

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

async function handle(req: Request, fn: (body: any) => unknown) {
  try {
    return Response.json(await fn(await req.json()));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
}

const since = (req: Request) =>
  Math.floor(Date.now() / 1000) - Number(new URL(req.url).searchParams.get("window") ?? 86400);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": homepage,
    "/api/overview": (req) => Response.json({ ...overview(since(req)), solUsd }),
    "/api/families": (req) => Response.json(families(since(req))),
    "/api/families/:family": (req) => {
      const f = family(req.params.family);
      return f ? Response.json(f) : Response.json({ error: "unknown family" }, { status: 404 });
    },
    "/api/families/:family/odds": (req) => Response.json(graduationOdds(req.params.family)),
    "/api/configs/:address": (req) => {
      const c = config(req.params.address);
      return c ? Response.json(c) : Response.json({ error: "unknown config" }, { status: 404 });
    },
    "/api/pools/hot": () => Response.json(hotPools()),
    "/api/health": () => Response.json(streamHealth),
    "/api/studio/build": { POST: (req) => handle(req, buildStudio) },
    "/api/studio/deploy": { POST: (req) => handle(req, (b) => createConfigTx(b.input, b.wallet)) },
    "/api/studio/launch": { POST: (req) => handle(req, createPoolTx) },
    "/api/tx/send": { POST: (req) => handle(req, async (b) => ({ signature: await sendSigned(b.tx) })) },
    "/api/meta/:mint": (req) => {
      const json = tokenMeta(req.params.mint);
      return json ? new Response(json, { headers: { "content-type": "application/json" } }) : Response.json({}, { status: 404 });
    },
    "/api/stream": (req, srv) => (srv.upgrade(req) ? undefined : new Response("expected websocket", { status: 400 })),
  },
  websocket: {
    open(ws) {
      ws.subscribe("feed");
    },
    message() {},
  },
});

await redescribeConfigs();
subscribeFeed((item) => server.publish("feed", JSON.stringify(item)));
setInterval(() => flushConfigs().catch((e) => console.error("enrich", e)), 2000);
setInterval(() => sweepMetadata().catch((e) => console.error("metadata", e)), 5000);
const { SOLAMI_API_KEY, SOLAMI_GRPC_URL = "https://grpc.solami.dev", MIRAGE_ID } = process.env;
if (SOLAMI_API_KEY && MIRAGE_ID) streamMirage(MIRAGE_ID, SOLAMI_API_KEY);
else if (SOLAMI_API_KEY) await streamGrpc(SOLAMI_GRPC_URL, SOLAMI_API_KEY);
else pollRpc();
console.log(`curvature on ${server.url}`);
