import { Database } from "bun:sqlite";

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
