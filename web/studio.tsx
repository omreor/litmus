import { useEffect, useState } from "react";
import { ColumnChart, LineChart, Placeholder, StackBar, TableView, Tile, type Series } from "./charts";
import { compact, duration, num, pct, short, SOL_MINT } from "./format";
import { usePoll } from "./hooks";
import { DeployPanel } from "./deploy";

export type Fork = { address: string; label: string; info: any; stats?: { pools: number; graduated: number; contestedGraduated: number } };

export type StudioInput = {
  quote: "SOL" | "USDC";
  tokenType: "spl" | "token-2022";
  supply: number;
  initialMcap: number;
  migrationMcap: number;
  shape: "market-cap" | "two-segment" | "weighted";
  supplyOnMigrationPct: number;
  steepness: number;
  leftoverPct: number;
  feeStartBps: number;
  feeEndBps: number;
  feeDecaySeconds: number;
  feeMode: "linear" | "exponential";
  dynamicFee: boolean;
  creatorFeePct: number;
  lp: { partnerLocked: number; partner: number; creatorLocked: number; creator: number };
  migratedPoolFeeBps: number;
};

const DEFAULT_INPUT: StudioInput = {
  quote: "SOL", tokenType: "spl", supply: 1_000_000_000, initialMcap: 30, migrationMcap: 400, shape: "market-cap",
  supplyOnMigrationPct: 20, steepness: 1.5, leftoverPct: 0, feeStartBps: 100, feeEndBps: 100, feeDecaySeconds: 0,
  feeMode: "linear", dynamicFee: false, creatorFeePct: 50, lp: { partnerLocked: 50, partner: 0, creatorLocked: 50, creator: 0 },
  migratedPoolFeeBps: 100,
};
const POOL_FEES = [25, 30, 100, 200, 400, 600];
const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

// Map a decoded on-chain config onto Studio inputs.
function fromConfig(info: any): StudioInput {
  const s = info.shape;
  return {
    ...DEFAULT_INPUT,
    quote: s.quoteMint === SOL_MINT ? "SOL" : "USDC",
    tokenType: s.tokenType,
    supply: s.supply,
    initialMcap: round(info.initialMcap),
    migrationMcap: round(info.migrationMcap),
    shape: "two-segment",
    supplyOnMigrationPct: round(info.supplySplit.migrationLp),
    leftoverPct: round(info.supplySplit.leftover),
    feeStartBps: s.baseFee.startBps,
    feeEndBps: s.baseFee.startBps,
    dynamicFee: s.dynamicFee,
    creatorFeePct: s.creatorTradingFeePct,
    // The form has no LP vesting; vested LP maps to locked LP, the closest split it supports.
    lp: {
      partnerLocked: s.lp.partnerLocked + (s.lp.partnerVestingPct ?? 0), partner: s.lp.partner,
      creatorLocked: s.lp.creatorLocked + (s.lp.creatorVestingPct ?? 0), creator: s.lp.creator,
    },
    migratedPoolFeeBps: POOL_FEES.includes(s.migration.poolFeeBps) ? s.migration.poolFeeBps : 100,
  };
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function NumberInput({ value, onChange, step = 1, min = 0 }: { value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return <input type="number" value={value} step={step} min={min} onChange={(e) => onChange(Number(e.target.value))} />;
}

export function Studio({ seed }: { seed: Fork | null }) {
  const [fork, setFork] = useState(seed);
  const [input, setInput] = useState<StudioInput>(() => (seed ? fromConfig(seed.info) : DEFAULT_INPUT));
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof StudioInput>(key: K) => (value: StudioInput[K]) => setInput((prev) => ({ ...prev, [key]: value }));
  const setLp = (key: keyof StudioInput["lp"]) => (value: number) => setInput((prev) => ({ ...prev, lp: { ...prev.lp, [key]: value } }));

  useEffect(() => {
    const id = setTimeout(async () => {
      const res = await fetch("/api/studio/build", { method: "POST", body: JSON.stringify(input) });
      const body = await res.json();
      if (res.ok) {
        setResult(body);
        setError(null);
      } else setError(body.error);
    }, 250);
    return () => clearTimeout(id);
  }, [input]);

  const lpTotal = input.lp.partnerLocked + input.lp.partner + input.lp.creatorLocked + input.lp.creator;
  const series: Series[] = [];
  if (result) series.push({ name: "Your curve", color: "var(--s1)", points: result.curve.map((p: any) => ({ x: p.quote, y: p.mcap })) });
  if (fork) series.push({ name: `Forked: ${fork.label}`, color: "var(--s2)", points: fork.info.curve.map((p: any) => ({ x: p.quote, y: p.mcap })) });
  // Priors follow the last valid build, or the fork itself while the form doesn't build.
  const priorsThreshold: number | undefined = result?.migrationThreshold ?? fork?.info.migrationThreshold;
  const loadFork = (f: Fork) => {
    setFork(f);
    setInput(fromConfig(f.info));
  };

  return (
    <div className="studio">
      <ForkBar fork={fork} onFork={loadFork} />
      <section className="card form">
        <h2>Parameters</h2>
        <p className="caption">Loaded from the fork, or defaults. Every change is rebuilt with Meteora's DBC SDK and validated like the program would.</p>
        <fieldset>
          <legend>Economics</legend>
          <Field label="Quote token">
            <select value={input.quote} onChange={(e) => set("quote")(e.target.value as StudioInput["quote"])}>
              <option>SOL</option><option>USDC</option>
            </select>
          </Field>
          <Field label="Total supply"><NumberInput value={input.supply} onChange={set("supply")} step={1_000_000} /></Field>
          <div className="pair">
            <Field label={`Start mcap (${input.quote})`}><NumberInput value={input.initialMcap} onChange={set("initialMcap")} /></Field>
            <Field label={`Graduation mcap (${input.quote})`}><NumberInput value={input.migrationMcap} onChange={set("migrationMcap")} /></Field>
          </div>
          <Field label="Leftover to receiver (% of supply)" hint="Kept out of the curve and LP; claimable after migration.">
            <NumberInput value={input.leftoverPct} onChange={set("leftoverPct")} step={0.5} />
          </Field>
        </fieldset>
        <fieldset>
          <legend>Curve shape</legend>
          <Field label="Shape">
            <select value={input.shape} onChange={(e) => set("shape")(e.target.value as StudioInput["shape"])}>
              <option value="market-cap">Single segment (constant liquidity)</option>
              <option value="two-segment">Two segments (set migration liquidity)</option>
              <option value="weighted">Weighted 16 segments</option>
            </select>
          </Field>
          {input.shape === "two-segment" && (
            <Field label="Supply paired as migration liquidity (%)"><NumberInput value={input.supplyOnMigrationPct} onChange={set("supplyOnMigrationPct")} step={1} /></Field>
          )}
          {input.shape === "weighted" && (
            <Field label={`Steepness ${input.steepness.toFixed(2)}`} hint="Above 1 back-loads liquidity: cheap early, steep late.">
              <input type="range" min={0.2} max={3} step={0.05} value={input.steepness} onChange={(e) => set("steepness")(Number(e.target.value))} />
            </Field>
          )}
        </fieldset>
        <fieldset>
          <legend>Fees</legend>
          <div className="pair">
            <Field label="Starting fee (bps)"><NumberInput value={input.feeStartBps} onChange={set("feeStartBps")} step={25} /></Field>
            <Field label="Ending fee (bps)"><NumberInput value={input.feeEndBps} onChange={set("feeEndBps")} step={25} /></Field>
          </div>
          <div className="pair">
            <Field label="Decay over (s)"><NumberInput value={input.feeDecaySeconds} onChange={set("feeDecaySeconds")} step={60} /></Field>
            <Field label="Decay">
              <select value={input.feeMode} onChange={(e) => set("feeMode")(e.target.value as StudioInput["feeMode"])}>
                <option value="linear">Linear</option><option value="exponential">Exponential</option>
              </select>
            </Field>
          </div>
          <small className="muted">A high starting fee that decays deters snipers.</small>
          <Field label="Creator share of trading fees (%)"><NumberInput value={input.creatorFeePct} onChange={set("creatorFeePct")} /></Field>
          <label className="check"><input type="checkbox" checked={input.dynamicFee} onChange={(e) => set("dynamicFee")(e.target.checked)} /> Dynamic (volatility) fee</label>
        </fieldset>
        <fieldset>
          <legend>Liquidity after graduation</legend>
          <div className="pair">
            <Field label="Partner locked %"><NumberInput value={input.lp.partnerLocked} onChange={setLp("partnerLocked")} /></Field>
            <Field label="Partner claimable %"><NumberInput value={input.lp.partner} onChange={setLp("partner")} /></Field>
            <Field label="Creator locked %"><NumberInput value={input.lp.creatorLocked} onChange={setLp("creatorLocked")} /></Field>
            <Field label="Creator claimable %"><NumberInput value={input.lp.creator} onChange={setLp("creator")} /></Field>
          </div>
          <small className="muted">At least 10% must stay locked at day 1 (program rule).</small>
          {lpTotal !== 100 && <p className="warn">LP shares add up to {lpTotal}%, they must total 100%.</p>}
          <Field label="DAMM v2 pool fee">
            <select value={input.migratedPoolFeeBps} onChange={(e) => set("migratedPoolFeeBps")(Number(e.target.value))}>
              {POOL_FEES.map((b) => <option key={b} value={b}>{num(b / 100, 2)}%</option>)}
            </select>
          </Field>
          <Field label="Token program">
            <select value={input.tokenType} onChange={(e) => set("tokenType")(e.target.value as StudioInput["tokenType"])}>
              <option value="spl">SPL Token</option><option value="token-2022">Token-2022</option>
            </select>
          </Field>
        </fieldset>
      </section>
      <div className="studio-out">
        {priorsThreshold != null && <Priors threshold={priorsThreshold} quote={input.quote} />}
        <section className="card">
          <h2>Bonding curve</h2>
          <p className="caption">Market cap ({input.quote}) against {input.quote} raised, from launch to graduation.</p>
          {error && <p className="warn">{error}</p>}
          {series.length > 0 && <LineChart series={series} xLabel={`${input.quote} raised`} xFormat={(v) => compact(v)} yFormat={(v) => compact(v)} />}
        </section>
        {result && (
          <section className="card">
            <h2>What this config does</h2>
            <dl className="kv">
              <dt>Graduates at</dt><dd><b>{num(result.migrationThreshold, 2)} {input.quote}</b> raised</dd>
              <dt>Market cap</dt><dd>{compact(result.initialMcap)} → {compact(result.migrationMcap)} {input.quote} ({num(result.migrationMcap / result.initialMcap, 1)}x)</dd>
              <dt>Supply sold on curve</dt><dd>{num(result.supplySplit.curve, 1)}%</dd>
              <dt>Curve segments</dt><dd>{result.segments}</dd>
            </dl>
            <div style={{ marginTop: 16 }}>
              <StackBar parts={[
                { label: "Sold on curve", value: result.supplySplit.curve, color: "var(--s1)" },
                { label: "Leftover to receiver", value: result.supplySplit.leftover, color: "var(--s2)" },
                { label: "Migration liquidity", value: result.supplySplit.migrationLp, color: "var(--s3)" },
              ]} />
            </div>
          </section>
        )}
        <DeployPanel input={input} valid={!!result && !error && lpTotal === 100} />
      </div>
    </div>
  );
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EXAMPLE = { address: "FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM", label: "Moonshot's main config" };

function ForkBar({ fork, onFork }: { fork: Fork | null; onFork: (fork: Fork) => void }) {
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const load = async (value: string) => {
    const trimmed = value.trim();
    setAddress(trimmed);
    if (!BASE58.test(trimmed)) return setStatus("That isn't a Solana address.");
    setStatus("Loading config…");
    try {
      const res = await fetch(`/api/configs/${trimmed}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const label = body.launchpad?.name ? `${body.launchpad.name} ${short(trimmed)}` : short(trimmed);
      onFork({ address: trimmed, label, info: body.info, stats: body.stats });
      setStatus(null);
    } catch (e) {
      setStatus(`Couldn't load that config (${e instanceof Error ? e.message : e}).`);
    }
  };
  return (
    <section className="card fork">
      <h2>Fork any config with outcome priors</h2>
      <p className="caption">
        Paste a DBC config address from any launchpad. Litmus decodes it from chain, loads its parameters below and shows how configs shaped like it
        actually did.
      </p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          load(address);
        }}
      >
        <input aria-label="Config address" placeholder="Config address" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" />
        <button className="btn">Fork</button>
      </form>
      <p className="muted" role="status">
        {status ?? (fork ? (
          <>
            Forked <a className="mono" href={`https://solscan.io/account/${fork.address}`} target="_blank" rel="noreferrer">{fork.label}</a>
            {fork.stats &&
              `: ${num(fork.stats.pools, 0)} pools, ${num(fork.stats.graduated, 0)} graduated, ${num(fork.stats.contestedGraduated, 0)} contested`}
            . Its curve is drawn next to yours.
          </>
        ) : (
          <>Try <button type="button" className="link" onClick={() => load(EXAMPLE.address)}>{EXAMPLE.label}</button>.</>
        ))}
      </p>
    </section>
  );
}

type Bucket = { min: number; max: number | null; pools: number; organicPools: number; graduated: number; organicGraduated: number };
const bucketLabel = (b: Bucket) => (b.max == null ? `${num(b.min)}+` : `${num(b.min)}-${num(b.max)}`);
const rate = (graduated: number, pools: number) => (pools ? graduated / pools : 0);
const outOf = (graduated: number, pools: number) => `${num(graduated, 0)} of ${num(pools, 0)} (${pct(rate(graduated, pools), 1)})`;

// How every pool with a similar threshold did since April 2025; the API's "organic" is the contested subset.
function Priors({ threshold, quote }: { threshold: number; quote: string }) {
  const poll = usePoll<any>(`/api/benchmarks/similar?quote=${quote}&threshold=${Number(threshold.toFixed(2))}`, 60_000);
  const b = poll.data;
  const buckets: Bucket[] = b?.byThreshold ?? [];
  const mine = buckets.findIndex((x) => threshold >= x.min && (x.max == null || threshold < x.max));
  return (
    <section className={poll.stale ? "card stale" : "card"}>
      <h2>Outcome priors</h2>
      <p className="caption">
        Configs shaped like yours: every {quote}-quoted DBC pool since April 2025 with a migration threshold near {threshold.toLocaleString("en", { maximumSignificantDigits: 3 })} {quote}.
      </p>
      {b ? (
        <>
          <div className="tiles inset">
            <Tile label="Contested graduation rate" value={pct(b.organicGradRate, 1)} sub={`${num(b.organicSample, 0)} contested pools`} />
            <Tile label="Counting uncontested too" value={pct(b.gradRate, 1)} sub={`${num(b.sample, 0)} pools`} />
            <Tile label="Median time to graduate" value={duration(b.medianSecondsToGraduate)} />
          </div>
          <ColumnChart
            series={[{ name: "All pools", color: "var(--muted)" }, { name: "Contested", color: "var(--s1)" }]}
            format={(v) => pct(v, 1)}
            tickFormat={(v) => pct(v)}
            highlight={mine >= 0 ? { index: mine, label: "yours" } : undefined}
            columns={buckets.map((x) => ({
              label: bucketLabel(x),
              title: `${bucketLabel(x)} ${quote} threshold`,
              values: [rate(x.graduated, x.pools), rate(x.organicGraduated, x.organicPools)],
              detail: `${num(x.pools, 0)} pools, ${num(x.organicPools, 0)} contested`,
            }))}
          />
          <TableView
            head={[`Threshold (${quote})`, "All pools graduated", "Contested graduated"]}
            rows={buckets.map((x) => [bucketLabel(x), outOf(x.graduated, x.pools), outOf(x.organicGraduated, x.organicPools)])}
          />
        </>
      ) : (
        <Placeholder poll={poll} empty="" height={300} />
      )}
    </section>
  );
}
