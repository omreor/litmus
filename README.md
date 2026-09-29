# Curvature

Live launch intelligence and curve design for [Meteora's Dynamic Bonding Curve](https://docs.meteora.ag/core-products/dbc/what-is-dbc) (DBC).

Hundreds of thousands of DBC configs exist on mainnet, most minted one per token by launchpads. Curvature decodes every launch, trade and graduation as it lands, groups configs into **preset families** (same fees, LP split, vesting and migration settings), and turns that into numbers a launchpad or token creator can act on:

- **Radar**: live launches and graduations, pools closest to graduation, and each pool's empirical odds of graduating given how far it got.
- **Presets**: every family ranked by launches, graduation rate, time to graduate and volume. For each one: its bonding curves, graduation odds by progress, and who gets what (curve, migration LP, leftover to the config owner, vesting).
- **Curve Studio**: design a curve with the DBC SDK builders, validated like the program would, compare it with any live preset, deploy it as your own config and launch tokens on it from your wallet.
- **Data API**: the same data as JSON and a WebSocket push feed.

## How it works

```
Solami Yellowstone gRPC (or Mirage WebSocket) --> decode DBC event CPIs + pool-init args --> SQLite
                                                                                    |
Solami RPC: config accounts, pool accounts, token metadata                     Bun server --> REST + WS --> React UI
```

- DBC emits events through `emit_cpi!`, so they live in inner instructions, not logs. Curvature decodes `EvtInitializePool`, `EvtSwap2` (exact `quote_reserve / migration_threshold` progress), `EvtCurveComplete` and `EvtCreateConfig*` with the program's IDL, and reads token name/symbol/uri from the `initialize_virtual_pool_*` instruction args.
- New configs are fetched once, decoded (`PoolConfig` and `ConfigWithTransferHook`), their curve sampled segment by segment, and fingerprinted into a family.
- Pools first seen mid-life get their mint and metadata resolved from the pool account, Metaplex metadata or the Token-2022 metadata extension.

## Run it

Requires [Bun](https://bun.sh) 1.3+.

```sh
bun install
SOLAMI_API_KEY=sk_... bun src/server.ts
```

Open http://localhost:3000.

| Variable | Default | Purpose |
|---|---|---|
| `SOLAMI_API_KEY` | none | Solami key (`sk_...`). Enables the gRPC stream and Solami RPC. Without it the app samples recent transactions from a public RPC (slow, dev only). |
| `SOLAMI_GRPC_URL` | `https://grpc.solami.dev` | Yellowstone gRPC endpoint. |
| `MIRAGE_ID` | none | Use a Solami Mirage subscription (filter `account_include: [dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN]`) instead of gRPC. |
| `RPC_URL` | Solami RPC if a key is set | Override the RPC used for account lookups and sending transactions. |
| `DB_PATH` | `curvature.sqlite` | SQLite file. |
| `PORT` | `3000` | HTTP port. |
| `PUBLIC_URL` | `http://localhost:3000` | Public origin, used in metadata URIs of tokens launched from the Studio. |

## Data API

| Route | Returns |
|---|---|
| `GET /api/overview?window=86400` | Launches, graduations, active pools, volume per quote token |
| `GET /api/families?window=86400` | Preset families with graduation rate, median time to graduate, volume |
| `GET /api/families/:family` | Top configs with sampled curves, graduation odds, recent launches |
| `GET /api/configs/:address` | Decoded config, curve, supply split, pools |
| `GET /api/pools/hot` | Pools closest to graduation with empirical odds |
| `GET /api/health` | Stream transport and freshness |
| `WS /api/stream` | Push feed: launches (with name/symbol/uri), graduations, new configs |

## License

MIT
