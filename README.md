# Litmus

The truth layer for [Meteora's Dynamic Bonding Curve](https://docs.meteora.ag/core-products/dbc/what-is-dbc) (DBC) launches.

**Live: https://omreor.github.io/litmus/** (the API runs on a small VPS; if it's unreachable the page falls back to the latest published snapshot and says so).

More than 3,000 DBC bonding curves complete every day. Raw chain stats, DefiLlama and Meteora's DBC API count all of them. Litmus judges every pool and graduation since DBC went live in April 2025:

- **contested**: independent buyers competed to fill the curve, confirmed from its own transactions;
- **uncontested**: a rule fired, the curve was filled without real competition (the creator or one bundle filled it, it completed in its creation slot, the threshold was trivial, or it sits on an auto-completing template);
- **unverified**: no rule fired, but the transactions that would confirm competition haven't been replayed yet.

Every verdict ships with **receipts**: the evidence values and the transaction signatures behind it. As of 2026-09-29 15:43 UTC, of 94,332 graduations in the last 30 days, 495 were contested, 68 unverified and 93,769 uncontested; since April 2025, 909,994 of 920,078 graduations (98.9%) were uncontested (`/api/overview?window=2592000`, `/api/integrity/monthly`).

"Graduation" means the curve completed (`finish_curve_timestamp`). Migration to DAMM v2 is a separate step.

## What's in it

| Part | What it does |
|---|---|
| Radar | Launches, graduations and volume per window with the verdict split; pools closest to graduation; live feed; "Hide uncontested" |
| Integrity | Raw vs judged graduations as they land, month to date, graduations and launches per month by verdict, the rules |
| Launchpads | Leaderboard by graduations with uncontested ones excluded, contested graduations, uncontested share |
| Templates | Configs grouped by parameter template, with a template prior, bonding curves, odds by progress, supply split and recent launches judged one by one, with post-graduation liquidity |
| Studio | Fork any config by address, compare with outcome priors for similar thresholds, design with the DBC SDK builders, deploy it as your own config (you are fee claimer) and launch tokens on it from your wallet |
| Data API | REST and a WebSocket feed with `verdict`, `contested`, `evidence`, `signals`, `receipts` and `launchpad` on every item |
| Backfill | Every DBC config and pool since 2025-04-23 (528k configs, 1.7M pools) |
| Archive and replay | Every DBC transaction archived as it lands; history replayed per pool from Solami RPC to confirm or refute competition |

## How a pool is judged

The rules, with their thresholds and version, are served by `GET /api/rules` and listed on the [Integrity tab](https://omreor.github.io/litmus/#integrity); `src/integrity.ts` is their single source.

- **Pool evidence decides.** The signals cost real money to fake: the creator's fill in the creation slot, fills bundled into the creation slot, distinct buyers before completion, the share of volume from non-creator wallets, same-slot completion, and the threshold size.
- **Template and launchpad history is a prior, not the verdict.** It only applies to pools without transaction evidence, so the verdict is not circular.
- **A dev first-buy is normal.** It only counts when it fills most of the curve.
- **Contested needs proof**: more than a few independent buyers seen from creation and no rule fired. Without that evidence and without a rule firing, a pool is unverified.
- **After graduation** Litmus reads the pool's DAMM v2 pool: liquidity now, whether LP was pulled, and snapshots one and seven days after graduation for pools graduating from now on.

Launchpad identity is the config's fee claimer, except for pads that mint a claimer per token (Bags: their shared leftover receiver) or rotate claimers per config (Perpspad: the wallet that created the config). Names come from a curated table, then Jupiter's `launchpad` label, then on-chain `PartnerMetadata`.

## Accuracy

Verdicts (rules v3) were re-checked one by one against each pool's own transactions on 2026-09-29 by an AI agent on the team (a self-review, not an independent audit): a random sample of graduations from the previous 30 days, every transaction re-read from mainnet rather than taken from Litmus' stored evidence, every pool linked and every disagreement kept.

| Verdict | Reviewed | Agree | Disagree | Precision (95% CI) |
|---|---|---|---|---|
| Uncontested | 34 | 34 | 0 | 100% (90% to 100%) |
| Contested | 32 | 27 | 4 (1 can't tell) | 87% (71% to 95%) |
| Unverified | 23 | - | - | no claim; by hand 17 were contested, 6 uncontested |
| Funded swarm (rule check) | 8 | 8 | 0 | 8 of 8 |

Precision = agree / (agree + disagree), Wilson interval.

- Read uncontested as safe to cite and contested as an upper bound, off by about one in eight. Every miss had the same shape: one party supplied most of the curve in a way the rules don't catch yet (wallet clusters funded more than a day before they bought; one dominant non-creator buyer).
- The sample is small and the reviewer is the Litmus data engineer (an AI agent), not an independent third party. Judgment calls are counted as labeled.
- Every reviewed pool, its hand label, what its transactions show and its receipts: [PRECISION.md](PRECISION.md).

## Run it

Requires [Bun](https://bun.sh) 1.3+ and, for real data, a [Solami](https://solami.dev) API key.

```sh
bun install
SOLAMI_API_KEY=sk_... bun src/server.ts
```

Open http://localhost:3000. Bun also reads variables from a `.env` file in the repo root (gitignored).

| Variable | Default | Purpose |
|---|---|---|
| `SOLAMI_API_KEY` | none | Enables the Yellowstone gRPC stream and Solami RPC. Without it the app samples the newest DBC transactions from a public RPC every 3 s (fine for UI work, not for numbers). |
| `SOLAMI_GRPC_URL` | `https://grpc.solami.dev` | Yellowstone gRPC endpoint. |
| `MIRAGE_ID` | none | Use a Solami Mirage subscription (filter `account_include: [dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN]`) instead of gRPC. |
| `RPC_URL` | Solami RPC with a key, else `https://solana-rpc.publicnode.com` | RPC for account lookups and sending transactions. |
| `DB_PATH` | `litmus.sqlite` | SQLite file. |
| `PORT` | `3000` | HTTP port. |
| `HOST` | `0.0.0.0` | Address the server binds; `127.0.0.1` behind a reverse proxy. |
| `META_URL` | `https://omreor.github.io/litmus/data/meta/` | Base URL of the metadata (`<mint>.json`) of tokens launched from the Studio; it goes into the token's on-chain URI. The server runs `scripts/publish.sh meta` on every launch to publish it there. |
| `ARCHIVE_DIR` | `.scratch/raw` | Where `record.ts` archives transactions; the server replays it on start and every 5 minutes. |

A fresh database only holds what the server streams from the moment it starts. Load history with:

```sh
DB_PATH=litmus.sqlite bun src/backfill.ts          # every config and pool since April 2025; re-runs with a key fetch only changed accounts
DB_PATH=litmus.sqlite bun src/backfill.ts --full   # force a full rescan
SOLAMI_API_KEY=sk_... DB_PATH=litmus.sqlite bun src/replay.ts full 58       # replay every transaction of candidate pools (last 58 days)
SOLAMI_API_KEY=sk_... DB_PATH=litmus.sqlite bun src/replay.ts creation 58   # replay creation slots of graduated pools
SOLAMI_API_KEY=sk_... DB_PATH=litmus.sqlite bun src/postgrad.ts             # read every graduated pool's DAMM v2 pool once
SOLAMI_API_KEY=sk_... bun src/record.ts .scratch/raw                         # archive every DBC transaction (hourly gzipped JSONL)
```

The full backfill uses `getProgramAccounts` on public mainnet-beta (sharded, about 4 minutes for pools); block times always come from mainnet-beta. Solami serves `getTransaction` for about the last 60 days, so replay only reaches pools created in that window. The server replays the archive written by `record.ts` on start and every 5 minutes.

Notes:
- **The Studio sends real mainnet transactions** from your wallet; a config costs about 0.01 SOL in rent. If you host your own, set `META_URL` to where you serve token metadata (and `REMOTE` for `scripts/publish.sh`), or tokens you launch point at the live site's metadata folder.
- Type-check with `bunx tsc --noEmit`; tests with `bun test`.

### Hosting it like the live site

Run `bun src/server.ts` (and `bun src/record.ts`) as services behind a reverse proxy with HTTPS, and `scripts/publish.sh` every 15 minutes:

```sh
LIVE_URL=https://your.api.host scripts/publish.sh   # static UI + JSON snapshots + live.json, force-pushed to the gh-pages branch
```

`publish.sh` also reads `API` (http://localhost:3300), `DB_PATH`, `REMOTE` (the gh-pages remote) and `OUT`. Its requests identify themselves, so `/api/usage` counts them apart from external traffic.

The page reads `live.json`, probes that API's `/api/health` for 3 s and goes live; otherwise it renders the snapshots in `data/` with a "snapshot as of" banner, and the feed and the Studio pause.

## Data API

Free, no key, JSON, CORS open on `GET /api/*`. `window` is in seconds. Quote amounts are raw integers with their `decimals` unless noted. In the API, `organic` means "not judged uncontested" (contested + unverified), and `factory` means uncontested.

| Route | Returns |
|---|---|
| `GET /api/overview?window=86400` | Launches, graduations, active pools; `contested` and `organic` counts; volume per quote token; SOL/USD |
| `GET /api/integrity/monthly` | Every month since April 2025: pools and graduations by verdict (`contested*`, `unverified*`, `factory*`), fee-implied SOL volume and the volume-farm share |
| `GET /api/graduations/recent?limit=50` | Latest judged graduations, same shape as stream items |
| `GET /api/rules` | `{ version, rules: [{ id, name, description, threshold }] }` |
| `GET /api/launchpads?window=86400` | Launchpads by identity: window and all-time counts, contested graduations, median time to graduate, uncontested share, post-graduation survival |
| `GET /api/templates?window=86400&organic=1` | Templates with graduation rate, rate with uncontested pools excluded, prior and reasons (`organic=1` drops uncontested templates) |
| `GET /api/templates/:id` | Configs with sampled curves, graduation odds by progress, recent pools with verdicts and post-graduation outcome |
| `GET /api/configs/:address` | Any config, decoded from chain on first request: parameters, curve, supply split, template, launchpad, stats, recent pools |
| `GET /api/pools/:address` | One pool: verdict, evidence, signals, receipts, launchpad, progress, post-graduation outcome |
| `GET /api/pools/hot` | Pools traded in the last 10 minutes, closest to graduation, with verdict and empirical odds |
| `GET /api/benchmarks/similar?quote=SOL&threshold=85` | Outcome priors for configs with a similar threshold, all history, by threshold bucket |
| `GET /api/usage` | External requests per route per day (our snapshot publisher counted apart), distinct external IPs per day (counted from daily-salted hashes), stream subscribers, Studio deploys and launches |
| `GET /api/health` | Stream transport, updates received, last update, slot |
| `WS /api/stream` | Launches, graduations and new configs as they land, each with verdict fields and launchpad |

`/api/families` and `/api/families/:family` remain as aliases of the template routes. Studio routes: `POST /api/studio/build`, `/api/studio/deploy`, `/api/studio/launch`, `/api/tx/send`, and `GET /api/meta/:mint` for launched tokens' metadata.

```js
const ws = new WebSocket("ws://localhost:3000/api/stream");
ws.onmessage = (e) => {
  const item = JSON.parse(e.data); // { type: "launch" | "graduation" | "config", verdict, contested, evidence, signals, receipts, launchpad, ... }
  if (item.type === "graduation" && item.verdict === "contested") console.log(item.launchpad?.name, item.evidence, item.receipts);
};
```

## Solami usage

| Product | Where | Used for |
|---|---|---|
| Yellowstone gRPC | `src/stream.ts` | One subscription filtered server-side to confirmed, non-vote, successful DBC transactions; block meta for timestamps |
| Yellowstone gRPC (archive) | `src/record.ts` | A second subscription writing every DBC transaction to hourly gzipped JSONL for replay |
| Mirage | `src/stream.ts` | The same frames over a WebSocket, as an alternative transport |
| RPC | `src/enrich.ts`, `src/metadata.ts`, `src/postgrad.ts`, `src/tx.ts` | Batched account reads for configs, mints and DAMM v2 pools; sending Studio transactions |
| RPC `getProgramAccountsV2` | `src/backfill.ts` | Re-runs fetch only accounts changed since the last run (`changedSinceSlot`) |
| RPC `getTransaction` | `src/replay.ts` | Per-pool history replay behind contested verdicts |

## Project layout

```
src/server.ts      routes, WebSocket feed, background jobs
src/stream.ts      Solami gRPC and Mirage transports; public-RPC sampler for dev
src/indexer.ts     transaction -> DBC events -> store, evidence, verdicts, feed
src/dbc.ts         IDL coders, event and config decoding, curve sampling, supply split, templates
src/integrity.ts   rules, priors, launchpad identity and labels, verdicts
src/evidence.ts    per-pool transaction evidence (fills, buyers, volume, receipts)
src/aggregates.ts  full-history aggregates in a worker (launchpads, templates, monthly, odds, benchmarks)
src/stats.ts       overview, hot pools, pool and config detail, recent graduations, usage
src/backfill.ts    full-history load; src/replay.ts history replay; src/record.ts + src/archive.ts archive
src/postgrad.ts    DAMM v2 post-graduation reads; src/damm.ts pool decoding
src/studio.ts      SDK curve builders and validation; src/tx.ts config and pool transactions
web/               React UI (Bun HTML imports): app.tsx, studio.tsx, deploy.tsx, charts.tsx, hooks.ts (apiUrl, live/snapshot)
scripts/           publish.sh
```

## Limitations

- gRPC transaction updates carry a slot, not a time; the live indexer extrapolates from the latest block meta.
- Contested verdicts exist only where transactions were seen from creation (live, archive or replay), so older history is mostly uncontested or unverified.
- Post-graduation snapshots at +1d and +7d exist only for pools graduating after snapshots started; older pools have their current state.
- Volume is quote-side: buys count the fee-inclusive input, sells the output.

## License

MIT
