import { utils } from "@coral-xyz/anchor";
import { statSync } from "node:fs";
import { accountsCoder, CONFIG_SLICE, DBC_PROGRAM_ID, POOL_SLICE, readConfigSlice, readPoolSlice } from "./dbc";
import { classify } from "./integrity";
import { cleanText } from "./metadata";
import { db, saveConfig, savePool } from "./store";

// Full-history load of every DBC config and pool into SQLite. Re-runnable: everything is an upsert.
// Full scans: api.mainnet-beta.solana.com getProgramAccounts, sharded to stay far below its silent
// ~500 MiB response truncation (faster than paging Solami's getProgramAccountsV2: pools in ~4 vs
// ~9 min, measured). With SOLAMI_API_KEY, re-runs only fetch accounts changed since the previous run
// (getProgramAccountsV2 changedSinceSlot; `--full` forces a full scan). Block times always come from
// mainnet-beta: Solami does not serve historical getBlockTime.

const bs58 = utils.bytes.bs58;
const { SOLAMI_API_KEY } = process.env;
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const SOLAMI_RPC = `https://rpc.solami.dev/sol?api_key=${SOLAMI_API_KEY}`;

const DBC_LAUNCH_TIME = 1745388780; // 2025-04-23 06:13 UTC, program deployment
const CLOCK_START_SLOT = 334_000_000; // 2025-04-17, before the deployment (~slot 335.3M)
// Block time samples ~1.1 h apart: linear interpolation is then off by ~3 s median, ~30 s at worst.
const CLOCK_STEP = 10_000;
// Graduations that interpolation puts within this many seconds of creation (or before it) get the
// exact block time of their activation slot, so "completed within 1 s of creation" is exact.
const EXACT_TTG_WINDOW = 40;
const SLOT_ACTIVATION = 0;
const BATCH = 500; // mainnet-beta rejects JSON-RPC request bodies over ~50 KB
const CONCURRENCY = 4;
// Slot skipped or not in long-term storage, bad params: retrying the same call never helps.
const PERMANENT_ERRORS = new Set([-32007, -32009, -32602]);

async function post<T>(body: unknown, url = PUBLIC_RPC): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let text: string;
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      // Bun's fetch errors can carry the URL, which holds the Solami key: never let it reach a log.
      if (attempt === 5) throw new Error(`RPC request failed: ${String(e instanceof Error ? e.message : e).replace(/api_key=[^&\s"]+/g, "api_key=***")}`);
      await Bun.sleep(2000 * attempt);
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`invalid JSON (${(text.length / 2 ** 20).toFixed(0)} MiB): the RPC truncated the response, shard further`);
    }
  }
}

async function rpc<T>(method: string, params: unknown[], url = PUBLIC_RPC): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const { result, error } = await post<{ result?: T; error?: { code: number; message: string } }>({ jsonrpc: "2.0", id: 1, method, params }, url);
    if (!error) return result as T;
    if (PERMANENT_ERRORS.has(error.code) || attempt === 5) throw new Error(`${method}: ${error.message}`);
    await Bun.sleep(2000 * attempt);
  }
}

// Block times of many slots via JSON-RPC batches; skipped (or rate-limited) slots are left out.
async function blockTimes(slots: number[]) {
  const times = new Map<number, number>();
  const batches = [];
  for (let i = 0; i < slots.length; i += BATCH) batches.push(slots.slice(i, i + BATCH));
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(
      batches.slice(i, i + CONCURRENCY).map(async (batch) => {
        const replies = await post<{ id: number; result?: number | null }[]>(
          batch.map((slot, id) => ({ jsonrpc: "2.0", id, method: "getBlockTime", params: [slot] })),
        );
        for (const r of replies) if (typeof r.result === "number") times.set(batch[r.id], r.result);
      }),
    );
  }
  return times;
}

type Filter = { dataSize: number } | { memcmp: { offset: number; bytes: string } };
type Account = { pubkey: string; account: { data: [string, string] } };
const byDiscriminator = (account: string): Filter => ({ memcmp: { offset: 0, bytes: bs58.encode(accountsCoder.accountDiscriminator(account)) } });
const decode = (a: Account): [string, Buffer] => [a.pubkey, Buffer.from(a.account.data[0], "base64")];

// Yields batches of [address, data]. A full scan is one public getProgramAccounts response per filter
// set (callers shard); a delta since a slot pages through Solami's getProgramAccountsV2, 10k at a time.
async function* scan(filters: Filter[], dataSlice?: { offset: number; length: number }, changedSinceSlot?: number) {
  const config = { encoding: "base64", commitment: "confirmed", filters, dataSlice };
  if (!changedSinceSlot) {
    yield (await rpc<Account[]>("getProgramAccounts", [DBC_PROGRAM_ID, config])).map(decode);
    return;
  }
  let paginationKey: string | null = null;
  do {
    const page: { value: { accounts: Account[]; paginationKey: string | null } } = await rpc(
      "getProgramAccountsV2",
      [DBC_PROGRAM_ID, { ...config, limit: 10_000, changedSinceSlot, ...(paginationKey && { paginationKey }) }],
      SOLAMI_RPC,
    );
    yield page.value.accounts.map(decode);
    paginationKey = page.value.paginationKey;
  } while (paginationKey);
}

const lastSync = (kind: string) => (db.query("SELECT slot FROM sync WHERE kind = ?").get(kind) as { slot: number } | null)?.slot;
const saveSync = db.prepare("INSERT INTO sync (kind, slot) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET slot = excluded.slot");

// Public RPC shards for PoolConfig (one response would be ~300 MB of JSON, ~1.4 GB parsed):
// activation_type and token_decimal (bytes 234, 235). Both are enums the program validates
// (slot/timestamp, 6..9 decimals), so the 8 shards cover every config.
const configShards = (): Filter[][] =>
  [0, 1].flatMap((activation) => [6, 7, 8, 9].map((decimals) => [{ memcmp: { offset: 234, bytes: bs58.encode(Buffer.from([activation, decimals])) } }]));

async function syncConfigs(since?: number) {
  const kinds: [string, number, Filter[][]][] = [
    ["PoolConfig", 1048, since ? [[]] : configShards()],
    ["ConfigWithTransferHook", 1128, [[]]],
  ];
  let n = 0;
  for (const [account, size, shards] of kinds) {
    for (const shard of shards) {
      for await (const batch of scan([{ dataSize: size }, byDiscriminator(account), ...shard], CONFIG_SLICE, since)) {
        db.transaction(() => batch.forEach(([address, data]) => saveConfig(address, readConfigSlice(data))))();
        n += batch.length;
      }
    }
  }
  return n;
}

// Configs created after the config scan, referenced by pools created before the pool scan.
async function fetchConfigs(addresses: string[]) {
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const { value } = await rpc<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [
      chunk, { encoding: "base64", commitment: "confirmed", dataSlice: CONFIG_SLICE },
    ]);
    db.transaction(() => value.forEach((a, j) => a && saveConfig(chunk[j], readConfigSlice(Buffer.from(a.data[0], "base64")))))();
  }
}

const savePartner = db.prepare(`INSERT INTO partners (address, name, website, logo) VALUES (?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET name = excluded.name, website = excluded.website, logo = excluded.logo`);

async function syncPartners() {
  let n = 0;
  for await (const batch of scan([byDiscriminator("PartnerMetadata")])) {
    db.transaction(() => {
      for (const [, data] of batch) {
        const m = accountsCoder.decode("PartnerMetadata", data);
        savePartner.run(m.fee_claimer.toBase58(), cleanText(m.name) || null, cleanText(m.website) || null, cleanText(m.logo) || null);
      }
    })();
    n += batch.length;
  }
  return n;
}

const saveSlotTime = db.prepare("INSERT OR REPLACE INTO slot_times (slot, time) VALUES (?, ?)");
const hasSample = db.prepare("SELECT 1 FROM slot_times WHERE slot >= ? AND slot < ?");
const saveSlotTimes = (times: Map<number, number>) => db.transaction(() => times.forEach((time, slot) => saveSlotTime.run(slot, time)))();

// A block time sample in every CLOCK_STEP window up to the current slot; a skipped slot is
// retried as the next slot.
async function syncClock(currentSlot: number) {
  let targets = [currentSlot];
  for (let s = CLOCK_START_SLOT; s < currentSlot; s += CLOCK_STEP) if (!hasSample.get(s, s + CLOCK_STEP)) targets.push(s);
  for (let round = 0; targets.length && round < 5; round++) {
    const times = await blockTimes(targets);
    saveSlotTimes(times);
    targets = targets.filter((slot) => !times.has(slot)).map((slot) => slot + 1);
  }
}

// Slot -> unix time, linear between the two samples around the slot (extrapolated past the ends);
// exact for sampled slots.
function loadClock() {
  const samples = db.query("SELECT slot, time FROM slot_times ORDER BY slot").values() as [number, number][];
  const toUnix = (slot: number) => {
    let lo = 0;
    let hi = samples.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid][0] <= slot) lo = mid;
      else hi = mid - 1;
    }
    const [[s0, t0], [s1, t1]] = [samples[lo], samples[lo + 1]];
    return Math.round(t0 + ((slot - s0) * (t1 - t0)) / (s1 - s0));
  };
  return { toUnix, sampled: new Set(samples.map(([slot]) => slot)) };
}

// Public RPC shards for VirtualPool: one memcmp over account bytes 299..305 = high byte of the
// little-endian u64 activation_point (~77-day slot or ~194-day unix-time buckets; its upper 4 bytes
// are zero for both), then pool_type and is_migrated. Keeps each response at most a few hundred MB.
function poolShards(currentSlot: number): Filter[][] {
  const now = Math.floor(Date.now() / 1000);
  const buckets = [];
  for (let b = CLOCK_START_SLOT >> 24; b <= currentSlot >> 24; b++) buckets.push(b);
  for (let b = DBC_LAUNCH_TIME >> 24; b <= now >> 24; b++) buckets.push(b);
  return buckets.flatMap((b) =>
    [0, 1].flatMap((poolType) =>
      [0, 1].map((migrated) => [{ memcmp: { offset: 299, bytes: bs58.encode(Buffer.from([b, 0, 0, 0, 0, poolType, migrated])) } }]),
    ),
  );
}

async function syncPools(currentSlot: number, since?: number) {
  const activation = new Map(db.query("SELECT address, activation_type FROM configs").values() as [string, number][]);
  const clock = loadClock();
  const kinds: [string, Filter[][]][] = [["VirtualPool", since ? [[]] : poolShards(currentSlot)], ["TransferHookPool", [[]]]];
  let [n, exact] = [0, 0];
  for (const [account, shardList] of kinds) {
    for (const shard of shardList) {
      const started = performance.now();
      for await (const batch of scan([{ dataSize: 424 }, byDiscriminator(account), ...shard], POOL_SLICE, since)) {
        const pools = batch.map(([address, data]) => ({ address, ...readPoolSlice(data) }));
        const missing = [...new Set(pools.map((p) => p.config).filter((c) => !activation.has(c)))];
        if (missing.length) {
          await fetchConfigs(missing);
          for (const [address, type] of db.query(`SELECT address, activation_type FROM configs WHERE address IN (${missing.map(() => "?").join()})`).values(...missing))
            activation.set(address as string, type as number);
        }
        const near = pools.filter(
          (p) => activation.get(p.config) === SLOT_ACTIVATION && p.finishedAt && p.finishedAt - clock.toUnix(p.activationPoint) <= EXACT_TTG_WINDOW,
        );
        const times = await blockTimes([...new Set(near.map((p) => p.activationPoint).filter((slot) => !clock.sampled.has(slot)))]);
        saveSlotTimes(times);
        exact += times.size;
        db.transaction(() => {
          for (const p of pools) {
            const type = activation.get(p.config);
            const createdAt =
              type === undefined ? null : type === SLOT_ACTIVATION ? (times.get(p.activationPoint) ?? clock.toUnix(p.activationPoint)) : p.activationPoint;
            savePool({ ...p, createdAt, graduatedAt: p.finishedAt || null });
          }
        })();
        n += pools.length;
      }
      Bun.gc(true); // a shard's parsed JSON is ~1 GB; don't let several pile up before the GC runs
      if (shardList.length > 1) console.log(`  ${account} shard ${shardList.indexOf(shard) + 1}/${shardList.length}: ${n} pools, ${exact} exact block times (${((performance.now() - started) / 1000).toFixed(1)}s)`);
    }
  }
  return n;
}

const saveJupiterLabel = db.prepare(`INSERT INTO partners (address, jupiter) VALUES (?, ?)
  ON CONFLICT(address) DO UPDATE SET jupiter = excluded.jupiter`);

// Jupiter's tokens API tags each mint with the launchpad it attributes it to; the most common tag over
// an identity's recent mints labels identities that are not curated (including Jupiter's "met-dbc"
// bucket for unbranded DBC).
async function jupiterLabels(identities = 300, perIdentity = 5) {
  const rows = db.query(`SELECT id, base_mint FROM (
      SELECT l.id, p.base_mint, ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY p.created_at DESC) rn
      FROM (SELECT id FROM launchpads ORDER BY json_extract(evidence, '$.pools') DESC LIMIT ?) l
      JOIN configs c ON c.launchpad = l.id JOIN pools p ON p.config = c.address)
    WHERE rn <= ?`).values(identities, perIdentity) as [string, string][];
  const identityOf = new Map(rows.map(([id, mint]) => [mint, id]));
  const votes = new Map<string, Map<string, number>>();
  for (let i = 0; i < rows.length; i += 100) {
    const mints = rows.slice(i, i + 100).map(([, mint]) => mint);
    const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.join(",")}`);
    if (!res.ok) throw new Error(`jupiter tokens: HTTP ${res.status}`);
    for (const token of (await res.json()) as { id: string; launchpad?: string }[]) {
      const id = identityOf.get(token.id);
      if (!id || !token.launchpad) continue;
      const tally = votes.get(id) ?? new Map<string, number>();
      tally.set(token.launchpad, (tally.get(token.launchpad) ?? 0) + 1);
      votes.set(id, tally);
    }
    await Bun.sleep(1000); // keyless endpoint: stay well below its rate limit
  }
  db.transaction(() => votes.forEach((tally, id) => saveJupiterLabel.run(id, [...tally].sort((a, b) => b[1] - a[1])[0][0])))();
  return votes.size;
}

const saveSigner = db.prepare("UPDATE configs SET signer = ? WHERE address = ?");

// Fee payer of the transaction that created a config: names the operator behind launchpads that use
// a fresh fee claimer per config (e.g. Perpspad). Sampled: the configs with the fewest pools of each
// top template and launchpad, and only when the first signature page reaches the creation.
async function sampleSigners(groups = 40, perGroup = 3) {
  const configs = db.query(`WITH counts AS (
      SELECT c.address, c.template, c.launchpad, c.signer, COUNT(p.address) n FROM configs c LEFT JOIN pools p ON p.config = c.address
      GROUP BY c.address)
    SELECT address FROM (SELECT address, signer, ROW_NUMBER() OVER (PARTITION BY template ORDER BY n, address) rn FROM counts
      WHERE template IN (SELECT template FROM templates ORDER BY json_extract(evidence, '$.pools') DESC LIMIT $groups))
      WHERE rn <= $per AND signer IS NULL
    UNION
    SELECT address FROM (SELECT address, signer, ROW_NUMBER() OVER (PARTITION BY launchpad ORDER BY n, address) rn FROM counts
      WHERE launchpad IN (SELECT id FROM launchpads ORDER BY json_extract(evidence, '$.pools') DESC LIMIT $groups))
      WHERE rn <= $per AND signer IS NULL`)
    .values({ $groups: groups, $per: perGroup })
    .flat() as string[];
  let found = 0;
  for (let i = 0; i < configs.length; i += CONCURRENCY) {
    await Promise.all(
      configs.slice(i, i + CONCURRENCY).map(async (config) => {
        const signatures = await rpc<{ signature: string }[]>("getSignaturesForAddress", [config, { limit: 1000 }]);
        if (!signatures.length || signatures.length === 1000) return;
        const tx = await rpc<{ transaction: { message: { accountKeys: string[] } } } | null>("getTransaction", [
          signatures.at(-1)!.signature, { encoding: "json", maxSupportedTransactionVersion: 0 },
        ]).catch(() => null);
        const signer = tx?.transaction.message.accountKeys[0];
        if (!signer) return;
        saveSigner.run(signer, config);
        found++;
      }),
    );
  }
  return `${found} of ${configs.length}`;
}

const started = performance.now();
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(0)}s`;
const slot = await rpc<number>("getSlot", [{ commitment: "confirmed" }]);
// --full rescans everything (reconciliation, or after a change to how rows are derived).
const since = (kind: string) => (SOLAMI_API_KEY && !process.argv.includes("--full") ? lastSync(kind) : undefined);
console.log(`slot ${slot}: ${since("pools") ? `changes since slot ${since("pools")} via Solami getProgramAccountsV2` : "full scan via mainnet-beta"}`);

console.log(`configs: ${await syncConfigs(since("configs"))} (${elapsed()})`);
saveSync.run("configs", slot);
console.log(`partner metadata: ${await syncPartners()} (${elapsed()})`);
await syncClock(slot);
console.log(`clock samples: ${(db.query("SELECT COUNT(*) n FROM slot_times").get() as { n: number }).n} (${elapsed()})`);
console.log(`pools: ${await syncPools(slot, since("pools"))} (${elapsed()})`);
saveSync.run("pools", slot);
console.log("classified", classify(), `(${elapsed()})`);
console.log(`jupiter labels: ${await jupiterLabels()} identities (${elapsed()})`);
console.log(`config creation signers: ${await sampleSigners()} sampled configs (${elapsed()})`);

db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const counts = db.query("SELECT (SELECT COUNT(*) FROM configs) configs, (SELECT COUNT(*) FROM pools) pools").get();
console.log("totals", counts, `db ${(statSync(db.filename).size / 2 ** 20).toFixed(0)} MiB, ${elapsed()}`);
