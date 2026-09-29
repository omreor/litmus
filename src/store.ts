import { Database } from "bun:sqlite";
import { templateOf, type ConfigFields } from "./dbc";

export const db = new Database(process.env.DB_PATH ?? "curvature.sqlite", { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS pools (
  address TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  creator TEXT,
  base_mint TEXT,
  name TEXT,
  symbol TEXT,
  uri TEXT,
  meta_checked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  quote_reserve INTEGER NOT NULL DEFAULT 0,
  max_reserve INTEGER NOT NULL DEFAULT 0,
  migration_threshold INTEGER,
  volume_quote INTEGER NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  buys INTEGER NOT NULL DEFAULT 0,
  last_trade_at INTEGER,
  graduated_at INTEGER
);
CREATE INDEX IF NOT EXISTS pools_config ON pools(config);
CREATE INDEX IF NOT EXISTS pools_created ON pools(created_at);
CREATE TABLE IF NOT EXISTS configs (
  address TEXT PRIMARY KEY,
  fee_claimer TEXT,
  quote_mint TEXT,
  family TEXT,
  info TEXT,
  data BLOB
);
CREATE INDEX IF NOT EXISTS configs_claimer ON configs(fee_claimer);
CREATE INDEX IF NOT EXISTS configs_family ON configs(family);
CREATE TABLE IF NOT EXISTS config_hourly (
  config TEXT NOT NULL,
  hour INTEGER NOT NULL,
  volume INTEGER NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (config, hour)
);
CREATE TABLE IF NOT EXISTS mints (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  decimals INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS token_meta (
  mint TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS partners (
  address TEXT PRIMARY KEY,
  name TEXT,
  website TEXT,
  logo TEXT
);
CREATE TABLE IF NOT EXISTS templates (
  template TEXT PRIMARY KEY,
  factory INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS launchpads (
  id TEXT PRIMARY KEY,
  via TEXT NOT NULL,
  factory INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slot_times (
  slot INTEGER PRIMARY KEY,
  time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync (
  kind TEXT PRIMARY KEY,
  slot INTEGER NOT NULL
);
`);

// Columns added after the first schema; databases created before them get them here.
const addColumns = (table: string, columns: string[]) => {
  const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const column of columns) if (!have.has(column.split(" ")[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
};
addColumns("configs", [
  "leftover_receiver TEXT", "threshold INTEGER", "cliff_fee_bps INTEGER", "base_fee_mode INTEGER", "dynamic_fee INTEGER",
  "collect_fee_mode INTEGER", "migration_option INTEGER", "activation_type INTEGER", "token_decimals INTEGER",
  "token_type INTEGER", "migration_fee_option INTEGER", "creator_fee_pct INTEGER", "template TEXT", "launchpad TEXT", "signer TEXT",
]);
addColumns("pools", ["fees_quote INTEGER"]);
addColumns("partners", ["jupiter TEXT"]);
db.exec(`
CREATE INDEX IF NOT EXISTS configs_template ON configs(template);
CREATE INDEX IF NOT EXISTS configs_launchpad ON configs(launchpad);
`);

// A pool can already exist from an earlier swap/graduation row if events arrive out of order.
const insertPool = db.prepare(`
INSERT INTO pools (address, config, creator, base_mint, name, symbol, uri, meta_checked, created_at)
VALUES ($pool, $config, $creator, $mint, $name, $symbol, $uri, 1, $ts)
ON CONFLICT(address) DO UPDATE SET creator = $creator, base_mint = $mint, name = $name, symbol = $symbol, uri = $uri,
  meta_checked = 1, created_at = COALESCE(created_at, $ts)`);
// Pools first seen mid-life (launched before we started streaming) get created_at NULL so they
// never skew launch-window stats.
const upsertSwap = db.prepare(`
INSERT INTO pools (address, config, quote_reserve, max_reserve, migration_threshold, volume_quote, trades, buys, last_trade_at)
VALUES ($pool, $config, $reserve, $reserve, $threshold, $volume, 1, $buy, $ts)
ON CONFLICT(address) DO UPDATE SET
  quote_reserve = $reserve,
  max_reserve = MAX(max_reserve, $reserve),
  migration_threshold = $threshold,
  volume_quote = volume_quote + $volume,
  trades = trades + 1,
  buys = buys + $buy,
  last_trade_at = $ts`);
const bumpHourly = db.prepare(`
INSERT INTO config_hourly (config, hour, volume, trades) VALUES ($config, $hour, $volume, 1)
ON CONFLICT(config, hour) DO UPDATE SET volume = volume + $volume, trades = trades + 1`);
const markGraduated = db.prepare(`
INSERT INTO pools (address, config, quote_reserve, max_reserve, graduated_at) VALUES ($pool, $config, $reserve, $reserve, $ts)
ON CONFLICT(address) DO UPDATE SET
  graduated_at = COALESCE(graduated_at, $ts), quote_reserve = $reserve, max_reserve = MAX(max_reserve, $reserve)`);

export const recordLaunch = (
  pool: string, config: string, creator: string, mint: string, ts: number,
  meta?: { name: string; symbol: string; uri: string },
) =>
  insertPool.run({
    $pool: pool, $config: config, $creator: creator, $mint: mint, $ts: ts,
    $name: meta?.name ?? null, $symbol: meta?.symbol ?? null, $uri: meta?.uri ?? null,
  });

export const recordSwap = (s: {
  pool: string; config: string; reserve: bigint; threshold: bigint; volume: bigint; buy: boolean; ts: number;
}) => {
  upsertSwap.run({
    $pool: s.pool, $config: s.config, $reserve: s.reserve, $threshold: s.threshold,
    $volume: s.volume, $buy: s.buy ? 1 : 0, $ts: s.ts,
  });
  bumpHourly.run({ $config: s.config, $hour: Math.floor(s.ts / 3600), $volume: s.volume });
};

export const recordGraduation = (pool: string, config: string, quoteReserve: bigint, ts: number) =>
  markGraduated.run({ $pool: pool, $config: config, $reserve: quoteReserve, $ts: ts });

// Launchpad identity: the fee claimer, unless the leftover receiver is a known per-token-claimer
// launchpad such as Bags (integrity.ts assignLaunchpads recomputes all identities from history).
const upsertConfig = db.prepare(`
INSERT INTO configs (address, fee_claimer, leftover_receiver, quote_mint, threshold, cliff_fee_bps, base_fee_mode, dynamic_fee,
  collect_fee_mode, migration_option, activation_type, token_decimals, token_type, migration_fee_option, creator_fee_pct, template, launchpad)
VALUES ($address, $feeClaimer, $leftoverReceiver, $quoteMint, $threshold, $cliffFeeBps, $baseFeeMode, $dynamicFee,
  $collectFeeMode, $migrationOption, $activationType, $tokenDecimals, $tokenType, $migrationFeeOption, $creatorFeePct, $template,
  CASE WHEN EXISTS (SELECT 1 FROM launchpads WHERE id = $leftoverReceiver AND via = 'leftover_receiver')
    THEN $leftoverReceiver ELSE $feeClaimer END)
ON CONFLICT(address) DO UPDATE SET
  fee_claimer = excluded.fee_claimer, leftover_receiver = excluded.leftover_receiver, quote_mint = excluded.quote_mint,
  threshold = excluded.threshold, cliff_fee_bps = excluded.cliff_fee_bps, base_fee_mode = excluded.base_fee_mode,
  dynamic_fee = excluded.dynamic_fee, collect_fee_mode = excluded.collect_fee_mode, migration_option = excluded.migration_option,
  activation_type = excluded.activation_type, token_decimals = excluded.token_decimals, token_type = excluded.token_type,
  migration_fee_option = excluded.migration_fee_option, creator_fee_pct = excluded.creator_fee_pct,
  template = excluded.template, launchpad = COALESCE(configs.launchpad, excluded.launchpad)`);

export function saveConfig(address: string, fields: ConfigFields) {
  const params: Record<string, string | number> = { $address: address, $template: templateOf(fields) };
  for (const [key, value] of Object.entries(fields)) params[`$${key}`] = value;
  upsertConfig.run(params);
}

// Account state from the backfill: creation and curve-completion times derived from the account win
// (reproducible across re-runs); the creator the live stream saw at launch is kept (it can be
// transferred later).
const upsertPool = db.prepare(`
INSERT INTO pools (address, config, creator, base_mint, created_at, quote_reserve, max_reserve, graduated_at, fees_quote)
VALUES ($address, $config, $creator, $baseMint, $createdAt, $quoteReserve, $quoteReserve, $graduatedAt, $feesQuote)
ON CONFLICT(address) DO UPDATE SET
  config = excluded.config, creator = COALESCE(pools.creator, excluded.creator), base_mint = excluded.base_mint,
  created_at = COALESCE(excluded.created_at, pools.created_at), graduated_at = COALESCE(excluded.graduated_at, pools.graduated_at),
  quote_reserve = excluded.quote_reserve, max_reserve = MAX(pools.max_reserve, excluded.quote_reserve), fees_quote = excluded.fees_quote`);

export const savePool = (p: {
  address: string; config: string; creator: string; baseMint: string; createdAt: number | null;
  quoteReserve: bigint; graduatedAt: number | null; feesQuote: bigint;
}) =>
  upsertPool.run({
    $address: p.address, $config: p.config, $creator: p.creator, $baseMint: p.baseMint, $createdAt: p.createdAt,
    $quoteReserve: p.quoteReserve, $graduatedAt: p.graduatedAt, $feesQuote: p.feesQuote,
  });
