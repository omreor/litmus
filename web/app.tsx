import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ColumnChart, LineChart, Meter, StackBar, type Series } from "./charts";
import { ago, compact, duration, feeLabel, lpLabel, num, pct, presetLabel, quoteAmount, quoteSymbol, short, SOL_MINT } from "./format";
import { Studio } from "./studio";

const SERIES_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)"];
const WINDOWS = [
  { label: "1h", seconds: 3600 },
  { label: "6h", seconds: 6 * 3600 },
  { label: "24h", seconds: 86400 },
  { label: "7d", seconds: 7 * 86400 },
];

function usePoll<T>(url: string | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return setData(null);
    let alive = true;
    const load = () => fetch(url).then((r) => (r.ok ? r.json() : null)).then((d) => alive && setData(d)).catch(() => {});
    load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, ms]);
  return data;
}

type FeedItem = { type: "launch" | "graduation" | "config"; ts: number; sig: string; pool?: string; config?: string; name?: string; symbol?: string; mint?: string };

function useFeed(limit = 60) {
  const [items, setItems] = useState<FeedItem[]>([]);
  useEffect(() => {
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/stream`);
      ws.onmessage = (e) => setItems((prev) => [JSON.parse(e.data), ...prev].slice(0, limit));
      ws.onclose = () => !closed && setTimeout(connect, 2000);
    };
    connect();
    return () => {
      closed = true;
      ws.close();
    };
  }, [limit]);
  return items;
}

function App() {
  const [tab, setTab] = useState<"radar" | "presets" | "studio" | "api">("radar");
  const [windowSeconds, setWindowSeconds] = useState(86400);
  const [fork, setFork] = useState<any>(null);
  const health = usePoll<any>("/api/health", 5000);
  const live = health && Date.now() - health.lastUpdateAt < 15_000;
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">Curvature<small>launch intelligence for Meteora DBC</small></div>
        <nav className="tabs">
          {(["radar", "presets", "studio", "api"] as const).map((t) => (
            <button key={t} aria-current={tab === t ? "page" : undefined} onClick={() => setTab(t)}>
              {{ radar: "Radar", presets: "Presets", studio: "Curve Studio", api: "API" }[t]}
            </button>
          ))}
        </nav>
        <div className="status">
          <span className="dot" style={{ background: live ? "var(--good)" : "var(--muted)" }} />
          {live ? `Live via ${health.transport}` : "Connecting"}
          {health?.slot ? <span className="mono muted">slot {health.slot.toLocaleString()}</span> : null}
        </div>
      </header>
      {(tab === "radar" || tab === "presets") && (
        <div className="filters">
          <span>Window</span>
          {WINDOWS.map((w) => (
            <button key={w.label} aria-pressed={windowSeconds === w.seconds} onClick={() => setWindowSeconds(w.seconds)}>{w.label}</button>
          ))}
        </div>
      )}
      {tab === "radar" && <Radar windowSeconds={windowSeconds} />}
      {tab === "presets" && <Presets windowSeconds={windowSeconds} onFork={(info) => { setFork(info); setTab("studio"); }} />}
      {tab === "studio" && <Studio seed={fork} />}
      {tab === "api" && <ApiDocs />}
    </div>
  );
}

function Radar({ windowSeconds }: { windowSeconds: number }) {
  const overview = usePoll<any>(`/api/overview?window=${windowSeconds}`, 5000);
  const hot = usePoll<any[]>("/api/pools/hot", 5000);
  const feed = useFeed();
  const solVolume = overview?.volume.find((v: any) => v.mint === SOL_MINT);
  const volumeSol = solVolume ? quoteAmount(solVolume.volume, SOL_MINT) : 0;
  return (
    <>
      <div className="tiles">
        <Tile label="Launches" value={overview ? compact(overview.launches) : "–"} sub="new DBC pools" />
        <Tile label="Graduations" value={overview ? compact(overview.graduations) : "–"} sub="curves completed" />
        <Tile
          label="Graduation rate" value={overview?.launches ? pct(overview.graduations / overview.launches, 1) : "–"}
          sub="graduations / launches"
        />
        <Tile
          label="Volume" value={overview ? `${compact(volumeSol)} SOL` : "–"}
          sub={overview?.solUsd ? `≈ $${compact(volumeSol * overview.solUsd)} · ${compact(solVolume?.trades ?? 0)} trades` : ""}
        />
        <Tile label="Active pools" value={overview ? compact(overview.active) : "–"} sub="traded in window" />
      </div>
      <div className="grid-2">
        <section className="card">
          <h2>Closest to graduation</h2>
          <p className="caption">Pools traded in the last 10 minutes, by progress to their own migration threshold. Odds: how often pools of the same preset family that got this far went on to graduate.</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Token</th><th>Progress</th><th className="num">Reserve</th><th className="num">Trades</th><th className="num">Odds</th><th className="num">Last trade</th></tr>
              </thead>
              <tbody>
                {hot?.map((p) => (
                  <tr key={p.address}>
                    <td><TokenCell name={p.name} symbol={p.symbol} mint={p.base_mint} pool={p.address} /></td>
                    <td><Meter value={p.progress} /></td>
                    <td className="num">
                      {num(quoteAmount(p.quote_reserve, p.quote_mint ?? SOL_MINT, p.quote_decimals))} / {num(quoteAmount(p.migration_threshold, p.quote_mint ?? SOL_MINT, p.quote_decimals))}{" "}
                      {quoteSymbol(p.quote_mint ?? SOL_MINT, p.quote_symbol)}
                    </td>
                    <td className="num">{p.trades}</td>
                    <td className="num" title={p.odds ? `${p.odds.sample} pools reached ${pct(p.odds.step)}` : "not enough settled pools yet"}>{p.odds ? pct(p.odds.rate) : "–"}</td>
                    <td className="num muted">{ago(p.last_trade_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hot?.length === 0 && <div className="empty">Waiting for trades…</div>}
          </div>
        </section>
        <section className="card">
          <h2>Live feed</h2>
          <p className="caption">Launches, graduations and new configs as they land on mainnet.</p>
          <ul className="feed">
            {feed.map((item) => (
              <li key={`${item.sig}-${item.type}-${item.pool ?? item.config}`}>
                <span className="dot" style={{ background: { launch: "var(--s1)", graduation: "var(--good)", config: "var(--s2)" }[item.type] }} />
                <div className="what">
                  <div className="kind">{{ launch: "Launch", graduation: "Graduated", config: "New config" }[item.type]}</div>
                  {item.type === "config" ? (
                    <span className="mono">{short(item.config!)}</span>
                  ) : (
                    <TokenCell name={item.name} symbol={item.symbol} mint={item.mint} pool={item.pool!} />
                  )}
                </div>
                <a className="when" href={`https://solscan.io/tx/${item.sig}`} target="_blank" rel="noreferrer">{ago(item.ts)}</a>
              </li>
            ))}
            {feed.length === 0 && <li className="empty">Listening…</li>}
          </ul>
        </section>
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function TokenCell({ name, symbol, mint, pool }: { name?: string | null; symbol?: string | null; mint?: string | null; pool: string }) {
  return (
    <a className="token" href={`https://solscan.io/account/${pool}`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
      <b>{name || (mint ? short(mint) : short(pool))}</b>
      <span>{symbol ? `$${symbol}` : "unknown token"}</span>
    </a>
  );
}

function Presets({ windowSeconds, onFork }: { windowSeconds: number; onFork: (info: any) => void }) {
  const families = usePoll<any[]>(`/api/families?window=${windowSeconds}`, 30_000);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = usePoll<any>(selected ? `/api/families/${selected}` : null, 30_000);
  return (
    <>
      <section className="card">
        <h2>Preset families</h2>
        <p className="caption">Configs grouped by template: same quote token, fees, LP split, vesting and migration settings. Many launchpads mint a config per token, so the family is the real "preset".</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Preset</th><th className="num">Launches</th><th className="num">Graduated</th><th className="num">Median time to graduate</th><th className="num">Volume</th><th className="num">Configs</th></tr>
            </thead>
            <tbody>
              {families?.map((f) => (
                <tr key={f.family} className="clickable" aria-selected={selected === f.family} onClick={() => setSelected(f.family)}>
                  <td><div className="token"><b style={{ maxWidth: 480 }}>{presetLabel(f.shape)}</b><span className="mono">{f.family}</span></div></td>
                  <td className="num">{f.launches}</td>
                  <td className="num">{pct(f.gradRate, 1)}</td>
                  <td className="num">{duration(f.medianSecondsToGraduate)}</td>
                  <td className="num">{f.volume ? `${compact(quoteAmount(f.volume, f.shape.quoteMint))} ${quoteSymbol(f.shape.quoteMint)}` : "–"}</td>
                  <td className="num">{f.configs}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {families?.length === 0 && <div className="empty">No launches observed in this window yet.</div>}
        </div>
      </section>
      {detail && <FamilyDetail detail={detail} onFork={onFork} />}
    </>
  );
}

function FamilyDetail({ detail, onFork }: { detail: any; onFork: (info: any) => void }) {
  const top = detail.configs.slice(0, 3);
  const lead = top[0].info;
  const quote = quoteSymbol(lead.shape.quoteMint);
  const series: Series[] = top.map((c: any, i: number) => ({
    name: `${short(c.address)} · ${c.pools} pools`,
    color: SERIES_COLORS[i],
    points: c.info.curve.map((p: any) => ({ x: p.quote, y: p.mcap })),
  }));
  const split = lead.supplySplit;
  return (
    <div className="detail">
      <section className="card">
        <h2>Bonding curves</h2>
        <p className="caption">Market cap ({quote}) against {quote} raised, up to the migration threshold. Top {top.length} configs in this family by launches.</p>
        <LineChart series={series} xLabel={`${quote} raised`} xFormat={(v) => compact(v)} yFormat={(v) => compact(v)} />
      </section>
      <section className="card">
        <h2>Graduation odds by progress</h2>
        <p className="caption">Share of settled pools that graduated after reaching each progress step (pools we saw launch).</p>
        {detail.odds.some((o: any) => o.reached > 0) ? (
          <ColumnChart
            max={1}
            format={(v) => pct(v)}
            bars={detail.odds.map((o: any) => ({
              label: `≥${pct(o.step)}`,
              value: o.reached ? o.graduated / o.reached : 0,
              detail: `${o.graduated} of ${o.reached} graduated`,
            }))}
          />
        ) : (
          <div className="empty">No settled pools yet. A pool counts once it graduates or goes 6 hours without a trade.</div>
        )}
      </section>
      <section className="card">
        <h2>Who gets what</h2>
        <p className="caption">Token supply split for the most-used config. Leftover supply is claimable by the config's leftover receiver after migration.</p>
        <StackBar parts={[
          { label: "Sold on curve", value: split.curve, color: "var(--s1)" },
          { label: "Leftover to receiver", value: split.leftover, color: "var(--s2)" },
          { label: "Migration liquidity", value: split.migrationLp, color: "var(--s3)" },
          { label: "Creator vesting", value: split.vesting, color: "var(--s4)" },
        ]} />
        <dl className="kv" style={{ marginTop: 16 }}>
          <dt>Trading fee</dt><dd>{feeLabel(lead.shape)}{lead.shape.creatorTradingFeePct ? `, ${lead.shape.creatorTradingFeePct}% to creator` : ""}</dd>
          <dt>LP after migration</dt><dd>{lpLabel(lead.shape)}</dd>
          <dt>Migrates to</dt><dd>{lead.shape.migration.target === "damm-v2" ? "DAMM v2" : "DAMM v1"}, {num(lead.shape.migration.poolFeeBps / 100, 2)}% pool fee</dd>
          <dt>Graduation at</dt><dd>{num(lead.migrationThreshold)} {quote} raised · {compact(lead.migrationMcap)} {quote} market cap</dd>
          <dt>Token</dt><dd>{lead.shape.tokenType === "token-2022" ? "Token-2022" : "SPL"}{lead.shape.transferHook ? " with transfer hook" : ""}, supply {compact(lead.shape.supply)}</dd>
          <dt>Fee claimer</dt><dd className="mono">{lead.feeClaimer}</dd>
        </dl>
        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => onFork(lead)}>Fork in Curve Studio</button>
        </div>
      </section>
      <section className="card">
        <h2>Recent launches</h2>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Token</th><th>Peak progress</th><th className="num">Status</th></tr></thead>
            <tbody>
              {detail.recent.map((p: any) => (
                <tr key={p.address}>
                  <td><TokenCell name={p.name} symbol={p.symbol} mint={p.base_mint} pool={p.address} /></td>
                  <td><Meter value={p.graduated_at ? 1 : p.peak ?? 0} /></td>
                  <td className="num">{p.graduated_at ? `graduated in ${duration(p.graduated_at - p.created_at)}` : ago(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ApiDocs() {
  const origin = location.origin;
  const endpoints = [
    ["GET /api/overview?window=86400", "Launches, graduations, active pools and volume per quote token in the window (seconds)."],
    ["GET /api/families?window=86400", "Preset families ranked by launches: graduation rate, median time to graduate, volume, template shape."],
    ["GET /api/families/:family", "Family detail: top configs with sampled bonding curves, graduation odds, recent launches."],
    ["GET /api/configs/:address", "One config: decoded template, curve samples, supply split, pools launched on it."],
    ["GET /api/pools/hot", "Pools closest to graduation right now, with empirical graduation odds."],
    ["GET /api/health", "Stream transport, updates received, last slot."],
    ["WS /api/stream", "Push feed of launches (with name/symbol/uri), graduations and new configs, as JSON messages."],
  ];
  return (
    <section className="card">
      <h2>Data API</h2>
      <p className="caption">Plug DBC launch data into your terminal or launchpad. Free, no key, JSON.</p>
      <table>
        <tbody>
          {endpoints.map(([route, what]) => (
            <tr key={route}><td className="mono" style={{ whiteSpace: "nowrap" }}>{route}</td><td className="muted">{what}</td></tr>
          ))}
        </tbody>
      </table>
      <pre className="mono" style={{ marginTop: 16, background: "var(--page)", padding: 12, borderRadius: 8, overflowX: "auto" }}>
{`const ws = new WebSocket("${origin.replace("http", "ws")}/api/stream");
ws.onmessage = (e) => console.log(JSON.parse(e.data)); // { type: "launch" | "graduation" | "config", ... }`}
      </pre>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
