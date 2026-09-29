import { useEffect, useState } from "react";
import { ColumnChart, LineChart, StackBar, type Series } from "./charts";
import { compact, duration, num, pct, SOL_MINT } from "./format";
import { usePoll } from "./hooks";
import { DeployPanel } from "./deploy";

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

// Map a decoded on-chain config (from the Presets page) onto Studio inputs.
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
    lp: { partnerLocked: s.lp.partnerLocked, partner: s.lp.partner, creatorLocked: s.lp.creatorLocked, creator: s.lp.creator },
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

export function Studio({ seed }: { seed: any }) {
  const [input, setInput] = useState<StudioInput>(() => (seed ? fromConfig(seed) : DEFAULT_INPUT));
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
  if (seed) series.push({ name: "Forked config", color: "var(--s2)", points: seed.curve.map((p: any) => ({ x: p.quote, y: p.mcap })) });

  return (
    <div className="studio">
      <section className="card form">
        <h2>Design a launch</h2>
        <p className="caption">Every change is rebuilt with Meteora's DBC SDK and validated like the program would.</p>
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
        {result && <Benchmarks threshold={result.migrationThreshold} quote={input.quote} />}
        <DeployPanel input={input} valid={!!result && !error && lpTotal === 100} />
      </div>
    </div>
  );
}

type Bucket = { min: number; max: number | null; launches: number; graduated: number; medianSecondsToGraduate: number | null };
const bucketLabel = (b: Bucket) => (b.max === null ? `${b.min}+` : `${b.min}-${b.max}`);

function Benchmarks({ threshold, quote }: { threshold: number; quote: string }) {
  const buckets = usePoll<Bucket[]>("/api/benchmarks/thresholds?window=604800", 60_000);
  if (quote !== "SOL") return null;
  const mine = buckets?.find((b) => threshold >= b.min && (b.max === null || threshold < b.max));
  return (
    <section className="card">
      <h2>How similar launches did</h2>
      <p className="caption">Graduation rate of SOL-quoted launches seen in the last 7 days, by migration threshold. Your curve's bucket is highlighted.</p>
      {mine && mine.launches > 0 ? (
        <p>
          Of <b>{mine.launches}</b> launches with {bucketLabel(mine)} SOL thresholds, <b>{mine.graduated}</b> graduated
          ({pct(mine.graduated / mine.launches, 1)}){mine.graduated ? `, median ${duration(mine.medianSecondsToGraduate)} after launch` : ""}.
        </p>
      ) : (
        <p className="muted">No launches seen yet with a threshold near {num(threshold)} SOL.</p>
      )}
      {buckets && (
        <ColumnChart
          format={(v) => pct(v, 1)}
          bars={buckets.map((b) => ({
            label: `${bucketLabel(b)} SOL`,
            value: b.launches ? b.graduated / b.launches : 0,
            detail: `${b.graduated} of ${b.launches} graduated`,
            color: b === mine ? "var(--s1)" : "var(--muted)",
          }))}
        />
      )}
    </section>
  );
}
