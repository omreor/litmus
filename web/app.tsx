import { Component, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ColumnChart, LineChart, Meter, Placeholder, StackBar, TableView, Tile, type Series } from "./charts";
import {
  ago, compact, duration, feeLabel, launchpadName, lpLabel, monthLabel, monthName, num, pct, presetLabel, quoteAmount, quoteSymbol, short, SOL_MINT,
} from "./format";
import { contestedOf, useFeed, useGraduations, usePoll, useTick, type Judged, type Launchpad } from "./hooks";
import { Studio, type Fork } from "./studio";

const SERIES_COLORS = ["var(--s1)", "var(--s2)", "var(--s3)"];
const VERDICTS = [
  { name: "Contested", color: "var(--s1)" },
  { name: "Uncontested", color: "var(--muted)" },
];
const WINDOWS = [
  { label: "1h", seconds: 3600 },
  { label: "6h", seconds: 6 * 3600 },
  { label: "24h", seconds: 86400 },
  { label: "7d", seconds: 7 * 86400 },
  { label: "30d", seconds: 30 * 86400 },
];
const TABS = { radar: "Radar", launchpads: "Launchpads", templates: "Templates", integrity: "Integrity", studio: "Studio", api: "API" };
type Tab = keyof typeof TABS;
const TITLES: Record<Tab, string> = {
  radar: "Live radar", launchpads: "Launchpad leaderboard", templates: "Templates", integrity: "Raw vs judged graduations",
  studio: "Fork a config", api: "Data API",
};
// Below this many pools a rate is noise: it's shown as "–" or ranked last.
const MIN_SAMPLE = 20;

// Sub-1 amounts keep two significant digits: a 0.00001 SOL threshold must not read as 0.
const amount = (v: number) => (v >= 10_000 ? compact(v) : v >= 1 ? num(v, 2) : v.toLocaleString("en", { maximumSignificantDigits: 2 }));

const tabFromHash = () => {
  const hash = location.hash.slice(1);
  return (Object.hasOwn(TABS, hash) ? hash : "radar") as Tab;
};

function App() {
  const [tab, setTab] = useState(tabFromHash);
  const [windowSeconds, setWindowSeconds] = useState(86400);
  const [hideUncontested, setHideUncontested] = useState(true);
  const [fork, setFork] = useState<Fork | null>(null);
  const health = usePoll<any>("/api/health", 5000).data;
  const live = health && Date.now() - health.lastUpdateAt < 15_000;
  useEffect(() => {
    const onHashChange = () => {
      setTab(tabFromHash());
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);
  useEffect(() => {
    document.title = `${TITLES[tab]} · Litmus`;
  }, [tab]);
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#radar">Litmus <small>the truth layer for Meteora DBC launches</small></a>
        <nav className="tabs" aria-label="Sections">
          {Object.entries(TABS).map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={tab === id ? "page" : undefined}>{label}</a>
          ))}
        </nav>
        <div className="status">
          <span className="dot" style={{ background: live ? "var(--good)" : "var(--muted)" }} />
          {live ? `Live via ${health.transport}` : "Connecting"}
          {health?.slot ? <span className="mono muted">slot {health.slot.toLocaleString()}</span> : null}
        </div>
      </header>
      {(tab === "radar" || tab === "launchpads" || tab === "templates") && (
        <div className="filters">
          <div className="group" role="group" aria-label="Time window">
            <span>Window</span>
            {WINDOWS.map((w) => (
              <button key={w.label} aria-pressed={windowSeconds === w.seconds} onClick={() => setWindowSeconds(w.seconds)}>{w.label}</button>
            ))}
          </div>
          {tab !== "launchpads" && (
            <label className="check">
              <input type="checkbox" checked={hideUncontested} onChange={(e) => setHideUncontested(e.target.checked)} />
              Hide uncontested
            </label>
          )}
        </div>
      )}
      <Boundary key={tab}>
        {tab === "radar" && <Radar windowSeconds={windowSeconds} hideUncontested={hideUncontested} />}
        {tab === "launchpads" && <Launchpads windowSeconds={windowSeconds} />}
        {tab === "templates" && (
          <Templates
            windowSeconds={windowSeconds} hideUncontested={hideUncontested}
            onFork={(f) => {
              setFork(f);
              location.hash = "studio";
            }}
          />
        )}
        {tab === "integrity" && <Integrity />}
        {tab === "studio" && <Studio seed={fork} />}
        {tab === "api" && <ApiDocs />}
      </Boundary>
    </div>
  );
}

// Keeps one view's unexpected payload from blanking the whole app; remounts on tab change.
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="card empty" role="alert">This view couldn't render the data it received ({this.state.error}).</div>;
  }
}

// Evidence as display lines; v2 `reasons` / `factoryReasons` stand in when a payload has no evidence yet.
const evidenceOf = (x: Judged) =>
  x.evidence ? Object.entries(x.evidence).map(([key, value]) => `${key}: ${typeof value === "number" ? num(value, 2) : value}`) : x.reasons ?? x.factoryReasons ?? [];

// Verdict badge; opens a popover with the evidence and the transactions behind it.
function Verdict({ of: x, prior = false }: { of: Judged; prior?: boolean }) {
  const id = useId();
  const contested = contestedOf(x);
  if (contested === undefined) return null;
  const label = contested ? "Contested" : "Uncontested";
  const evidence = evidenceOf(x);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      <button className={contested ? "flag contested" : "flag uncontested"} popoverTarget={id} onClick={stop} title="Show evidence">{label}</button>
      <div id={id} popover="auto" className="evidence" onClick={stop}>
        <h3>{label}</h3>
        <p className="caption">
          {prior
            ? "Template prior: pools on these parameters complete without real competition. Each pool is still judged on its own evidence."
            : contested ? "Independent buyers competed to fill the curve." : "The curve was completed without real competition."}
        </p>
        {evidence.length > 0 ? <ul>{evidence.map((e) => <li key={e}>{e}</li>)}</ul> : <p className="muted">No evidence attached.</p>}
        {x.receipts?.length ? (
          <p className="receipts">
            Receipts{" "}
            {x.receipts.map((sig) => (
              <a key={sig} className="mono" href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer">{short(sig)}</a>
            ))}
          </p>
        ) : null}
        <button className="btn ghost" popoverTarget={id} popoverTargetAction="hide">Close</button>
      </div>
    </>
  );
}

function Radar({ windowSeconds, hideUncontested }: { windowSeconds: number; hideUncontested: boolean }) {
  const overviewPoll = usePoll<any>(`/api/overview?window=${windowSeconds}`, 5000);
  const hotPoll = usePoll<any[]>("/api/pools/hot", 5000);
  const feed = useFeed();
  const overview = overviewPoll.data;
  const hot = hideUncontested ? hotPoll.data?.filter((p) => contestedOf(p) !== false) : hotPoll.data;
  const items = hideUncontested ? feed.filter((item) => contestedOf(item) !== false) : feed;
  const solVolume = overview?.volume.find((v: any) => v.mint === SOL_MINT);
  const volumeSol = solVolume ? quoteAmount(solVolume.volume, SOL_MINT) : 0;
  const launches = hideUncontested ? overview?.organic.launches : overview?.launches;
  const graduations = hideUncontested ? overview?.organic.graduations : overview?.graduations;
  const split = (all: number, contested: number) =>
    hideUncontested ? `${compact(all - contested)} uncontested hidden` : `${compact(contested)} contested`;
  return (
    <>
      <div className={overviewPoll.stale ? "tiles stale" : "tiles"}>
        <Tile
          label={hideUncontested ? "Contested launches" : "Launches"} value={overview ? compact(launches) : "–"}
          sub={overview && split(overview.launches, overview.organic.launches)}
        />
        <Tile
          label={hideUncontested ? "Contested graduations" : "Graduations"} value={overview ? compact(graduations) : "–"}
          sub={overview && split(overview.graduations, overview.organic.graduations)}
        />
        <Tile
          label="Graduation rate" value={launches >= MIN_SAMPLE ? pct(graduations / launches, 1) : "–"}
          sub={overview && launches < MIN_SAMPLE ? `needs ${MIN_SAMPLE}+ launches in window` : "graduations / launches"}
        />
        <Tile
          label="Volume" value={overview ? `${compact(volumeSol)} SOL` : "–"}
          sub={overview?.solUsd ? `≈ $${compact(volumeSol * overview.solUsd)} · ${compact(solVolume?.trades ?? 0)} trades, all pools` : ""}
        />
        <Tile label="Active pools" value={overview ? compact(overview.active) : "–"} sub="traded in window, all pools" />
      </div>
      <div className="grid-2">
        <section className="card">
          <h2>Closest to graduation</h2>
          <p className="caption">Pools traded in the last 10 minutes, by progress to their own migration threshold. Odds: how often pools of the same template that got this far went on to graduate.</p>
          <div className="table-scroll live">
            <table>
              <thead>
                <tr><th>Token</th><th>Progress</th><th className="num wide">Reserve</th><th className="num wide">Trades</th><th className="num">Odds</th><th className="num">Last trade</th></tr>
              </thead>
              <tbody>
                {hot?.map((p) => (
                  <tr key={p.address}>
                    <td><TokenCell name={p.name} symbol={p.symbol} mint={p.base_mint} pool={p.address} launchpad={p.launchpad} judged={p} /></td>
                    <td><Meter value={p.progress} /></td>
                    <td className="num wide">
                      {amount(quoteAmount(p.quote_reserve, p.quote_mint ?? SOL_MINT, p.quote_decimals))} / {amount(quoteAmount(p.migration_threshold, p.quote_mint ?? SOL_MINT, p.quote_decimals))}{" "}
                      {quoteSymbol(p.quote_mint ?? SOL_MINT, p.quote_symbol)}
                    </td>
                    <td className="num wide">{num(p.trades, 0)}</td>
                    <td className="num" title={p.odds ? `${p.odds.sample} pools reached ${pct(p.odds.step)}` : "not enough settled pools yet"}>{p.odds ? pct(p.odds.rate, 1) : "–"}</td>
                    <td className="num muted time">{ago(p.last_trade_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hot?.length === 0 && hotPoll.data?.length ? (
              <div className="empty">Only uncontested pools are near graduation. Untick Hide uncontested to see them.</div>
            ) : (
              <Placeholder poll={hotPoll} empty="Waiting for trades…" />
            )}
          </div>
        </section>
        <section className="card">
          <h2>Live feed</h2>
          <p className="caption">Launches, graduations and new configs as they land on mainnet{hideUncontested ? ", uncontested ones hidden" : ""}.</p>
          <ul className="feed">
            {items.map((item) => (
              <li key={`${item.sig}-${item.type}-${item.pool ?? item.config}`}>
                <span className="dot" style={{ background: { launch: "var(--s1)", graduation: "var(--good)", config: "var(--s2)" }[item.type] }} />
                <div className="what">
                  <div className="kind">
                    {{ launch: "Launch", graduation: "Graduated", config: "New config" }[item.type]}
                    {item.launchpad ? ` · ${launchpadName(item.launchpad)}` : ""}
                  </div>
                  {item.type === "config" ? (
                    <span className="mono">{short(item.config!)}</span>
                  ) : (
                    <TokenCell name={item.name} symbol={item.symbol} mint={item.mint} pool={item.pool!} judged={item} />
                  )}
                </div>
                <a className="when" href={`https://solscan.io/tx/${item.sig}`} target="_blank" rel="noreferrer">{ago(item.ts)}</a>
              </li>
            ))}
            {items.length === 0 && <li className="empty">{feed.length ? "Only uncontested activity so far. Untick Hide uncontested to see it." : "Listening…"}</li>}
          </ul>
        </section>
      </div>
    </>
  );
}

// `judged` shows an Uncontested badge; contested rows stay unbadged to keep tables quiet.
function TokenCell(props: {
  name?: string | null; symbol?: string | null; mint?: string | null; pool: string; launchpad?: Launchpad | null; judged?: Judged;
}) {
  const { name, symbol, mint, pool, launchpad, judged } = props;
  return (
    <div className="token">
      <div className="name-row">
        <a href={`https://solscan.io/account/${pool}`} target="_blank" rel="noreferrer"><b dir="auto">{name || short(mint ?? pool)}</b></a>
        {judged && contestedOf(judged) === false && <Verdict of={judged} />}
      </div>
      <span>
        {symbol ? <>$<bdi>{symbol}</bdi></> : "unknown token"}
        {launchpad ? ` · ${launchpadName(launchpad)}` : ""}
      </span>
    </div>
  );
}

// Share of graduated pools whose DAMM v2 pool still had liquidity and volume 7 days on.
function Alive7d({ post }: { post?: { graduated: number; aliveD7: number } | null }) {
  if (!post?.graduated) return <span className="muted">–</span>;
  return <>{pct(post.aliveD7 / post.graduated, 1)}<div className="sub">of {num(post.graduated, 0)}</div></>;
}

function Launchpads({ windowSeconds }: { windowSeconds: number }) {
  const poll = usePoll<any[]>(`/api/launchpads?window=${windowSeconds}`, 30_000);
  const rows = poll.data?.toSorted(
    (a, b) => b.window.organicGraduations - a.window.organicGraduations || b.allTime.organicGraduations - a.allTime.organicGraduations,
  );
  const hasPost = rows?.some((l) => l.postGraduation !== undefined);
  return (
    <section className="card">
      <h2>Launchpad leaderboard</h2>
      <p className="caption">
        Ranked by contested graduations in the window. Launchpads are identified from on-chain partner metadata, Jupiter's launchpad labels
        and the wallets behind their configs. Contested grad rate and median time to graduate (over contested graduations) are all-time since April 2025
        {hasPost ? "; alive at 7d is the share of graduated pools whose DAMM v2 pool still had liquidity and volume a week later" : ""}.
        Uncontested share: the launchpad's pools <a href="#integrity">judged uncontested</a>.
      </p>
      <div className={poll.stale ? "table-scroll stale" : "table-scroll"}>
        <table>
          <thead>
            <tr>
              <th className="num">#</th><th>Launchpad</th><th className="num">Contested graduations</th><th className="num wide">Contested launches</th>
              <th className="num">Contested grad rate</th>{hasPost && <th className="num">Alive at 7d</th>}<th className="num wide">Pools, all-time</th>
              <th className="num wide">Median time to graduate</th><th className="num">Uncontested share</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((l, i) => (
              <tr key={l.id}>
                <td className="num muted">{i + 1}</td>
                <td><LaunchpadCell launchpad={l} /></td>
                <td className="num"><b>{num(l.window.organicGraduations, 0)}</b><div className="sub">of {num(l.window.graduations, 0)}</div></td>
                <td className="num wide">{num(l.window.organicLaunches, 0)}<div className="sub">of {num(l.window.launches, 0)}</div></td>
                <td className="num">
                  {l.allTime.organicPools >= MIN_SAMPLE ? pct(l.allTime.organicGraduations / l.allTime.organicPools, 1) : "–"}
                  <div className="sub">of {num(l.allTime.organicPools, 0)}</div>
                </td>
                {hasPost && <td className="num"><Alive7d post={l.postGraduation} /></td>}
                <td className="num wide">{num(l.allTime.pools, 0)}</td>
                <td className="num wide">{duration(l.allTime.medianSecondsToGraduate)}</td>
                <td className="num">{pct(l.factoryShare, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Placeholder poll={poll} empty="No launchpad activity in this window." />
      </div>
    </section>
  );
}

function LaunchpadCell({ launchpad }: { launchpad: { id: string; name: string | null; website?: string | null } }) {
  const website = launchpad.website?.startsWith("https://") ? launchpad.website : null;
  return (
    <div className="token">
      <a href={`https://solscan.io/account/${launchpad.id}`} target="_blank" rel="noreferrer">
        <b dir="auto" className={launchpad.name ? undefined : "mono"}>{launchpadName(launchpad)}</b>
      </a>
      <span>
        {website ? (
          <a href={website} target="_blank" rel="noreferrer">{website.slice(8).split("/")[0]}</a>
        ) : launchpad.name ? short(launchpad.id) : "unlabeled"}
      </span>
    </div>
  );
}

// Rank by contested graduation rate; templates with too few pools in the window to judge go last.
const byContestedOutcome = (a: any, b: any) =>
  Number(b.pools >= MIN_SAMPLE) - Number(a.pools >= MIN_SAMPLE) || (b.organicGradRate ?? -1) - (a.organicGradRate ?? -1) || b.pools - a.pools;

function Templates({ windowSeconds, hideUncontested, onFork }: { windowSeconds: number; hideUncontested: boolean; onFork: (fork: Fork) => void }) {
  const poll = usePoll<any[]>(`/api/templates?window=${windowSeconds}${hideUncontested ? "&organic=1" : ""}`, 30_000);
  const rows = poll.data?.toSorted(byContestedOutcome);
  const hasPost = rows?.some((t) => t.postGraduation !== undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows?.find((t) => t.template === selected) ?? rows?.[0];
  const detail = usePoll<any>(current ? `/api/templates/${current.template}` : null, 30_000);
  const detailRef = useRef<HTMLDivElement>(null);
  const select = (id: string) => {
    setSelected(id);
    detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <>
      <section className="card">
        <h2>Templates</h2>
        <p className="caption">
          Configs grouped by parameter template: quote, threshold, fees, LP split and migration. Launchpads mint a config per token, so the
          template is the real preset. Ranked by contested graduation rate, with uncontested pools set aside; templates with under {MIN_SAMPLE} pools
          in the window come last. Median time to graduate counts contested graduations only. A template's Uncontested badge is a prior from its
          history: each pool is still judged on its own evidence.
        </p>
        <div className={poll.stale ? "table-scroll stale" : "table-scroll"}>
          <table>
            <thead>
              <tr>
                <th>Template</th><th className="wide">Launchpad</th><th className="num wide">Threshold</th><th className="num">Pools</th>
                <th className="num wide">Graduated</th><th className="num">Contested rate</th>{hasPost && <th className="num">Alive at 7d</th>}
                <th className="num wide">Median time to graduate</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((t) => (
                <tr key={t.template} className={t === current ? "clickable selected" : "clickable"} onClick={() => select(t.template)}>
                  <td>
                    <div className="token">
                      <div className="name-row">
                        <button className="link" aria-pressed={t === current}><b>{t.label}</b></button>
                        {contestedOf(t) === false && <Verdict of={t} prior />}
                      </div>
                      <span>{presetLabel(t.shape)}</span>
                    </div>
                  </td>
                  <td className="wide">{t.launchpad ? launchpadName(t.launchpad) : <span className="muted">–</span>}</td>
                  <td className="num wide">{amount(quoteAmount(t.threshold, t.quote.mint, t.quote.decimals))} {quoteSymbol(t.quote.mint, t.quote.symbol)}</td>
                  <td className="num">{num(t.pools, 0)}</td>
                  <td className="num wide">{pct(t.gradRate, 1)}</td>
                  <td className="num"><b>{pct(t.organicGradRate, 1)}</b></td>
                  {hasPost && <td className="num"><Alive7d post={t.postGraduation} /></td>}
                  <td className="num wide">{duration(t.medianSecondsToGraduate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Placeholder poll={poll} empty={hideUncontested ? "No contested templates launched in this window." : "No launches in this window yet."} />
        </div>
      </section>
      {current && (
        <div ref={detailRef} className={detail.stale ? "anchor stale" : "anchor"}>
          {detail.data ? <TemplateDetail detail={detail.data} row={current} onFork={onFork} /> : <Placeholder poll={detail} empty="" height={320} />}
        </div>
      )}
    </>
  );
}

function TemplateDetail({ detail, row, onFork }: { detail: any; row: any; onFork: (fork: Fork) => void }) {
  const top = detail.configs.slice(0, 3);
  const lead = top[0];
  const info = lead.info;
  const quote = quoteSymbol(info.shape.quoteMint, row.quote?.symbol);
  const series: Series[] = top.map((c: any, i: number) => ({
    name: `${short(c.address)} · ${num(c.pools, 0)} pools`,
    color: SERIES_COLORS[i],
    points: c.info.curve.map((p: any) => ({ x: p.quote, y: p.mcap })),
  }));
  const split = info.supplySplit;
  const hasPost = detail.recent.some((p: any) => p.postGraduation !== undefined);
  return (
    <div className="detail">
      <section className="card full">
        <div className="detail-head">
          <div>
            <div className="name-row"><h2>{detail.label}</h2>{contestedOf(detail) === false && <Verdict of={detail} prior />}</div>
            <p className="caption">
              {row.launchpad ? launchpadName(row.launchpad) : "No launchpad identified"} · {num(row.pools, 0)} pools in window ·{" "}
              {pct(row.gradRate, 1)} graduated, {pct(row.organicGradRate, 1)} contested · median {duration(row.medianSecondsToGraduate)} to a contested graduation
            </p>
          </div>
          <button className="btn" onClick={() => onFork({ address: lead.address, label: detail.label, info })}>Fork with priors</button>
        </div>
      </section>
      <section className="card">
        <h2>Bonding curves</h2>
        <p className="caption">Market cap ({quote}) against {quote} raised, up to the migration threshold. Top {top.length} configs on this template by launches.</p>
        <LineChart series={series} xLabel={`${quote} raised`} xFormat={(v) => compact(v)} yFormat={(v) => compact(v)} />
      </section>
      <section className="card">
        <h2>Graduation odds by progress</h2>
        <p className="caption">Share of settled pools that graduated after reaching each progress step.</p>
        {detail.odds.some((o: any) => o.reached > 0) ? (
          <ColumnChart
            max={1}
            format={(v) => pct(v, 1)}
            series={[{ name: "Graduated", color: "var(--s1)" }]}
            columns={detail.odds.map((o: any) => ({
              label: `≥${pct(o.step)}`,
              title: `Reached ${pct(o.step)} of threshold`,
              values: [o.reached ? o.graduated / o.reached : 0],
              detail: `${num(o.graduated, 0)} of ${num(o.reached, 0)} graduated`,
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
          <dt>Trading fee</dt><dd>{feeLabel(info.shape)}</dd>
          <dt>LP after migration</dt><dd>{lpLabel(info.shape)}</dd>
          <dt>Migrates to</dt><dd>{info.shape.migration.target === "damm-v2" ? "DAMM v2" : "DAMM v1"}, {num(info.shape.migration.poolFeeBps / 100, 2)}% pool fee</dd>
          <dt>Graduation at</dt><dd>{amount(info.migrationThreshold)} {quote} raised · {compact(info.migrationMcap)} {quote} market cap</dd>
          <dt>Token</dt><dd>{info.shape.tokenType === "token-2022" ? "Token-2022" : "SPL"}{info.shape.transferHook ? " with transfer hook" : ""}, supply {compact(info.shape.supply)}</dd>
          <dt>Fee claimer</dt><dd className="mono">{info.feeClaimer}</dd>
        </dl>
      </section>
      <section className="card full">
        <h2>Recent launches</h2>
        <p className="caption">
          Each pool is judged on its own evidence{hasPost ? "; post-graduation shows its DAMM v2 pool's liquidity and 24h volume 1 and 7 days after graduating" : ""}.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Token</th><th>Verdict</th><th>Peak progress</th><th className="num">Status</th>{hasPost && <th className="num">Post-graduation</th>}</tr>
            </thead>
            <tbody>
              {detail.recent.map((p: any) => (
                <tr key={p.address}>
                  <td><TokenCell name={p.name} symbol={p.symbol} mint={p.base_mint} pool={p.address} /></td>
                  <td><Verdict of={p} /><div className="sub evidence-line">{evidenceOf(p).join(" · ")}</div></td>
                  <td><Meter value={p.graduated_at ? 1 : p.peak ?? 0} /></td>
                  <td className="num">{p.graduated_at ? `graduated in ${duration(p.graduated_at - p.created_at)}` : `launched ${ago(p.created_at)}`}</td>
                  {hasPost && <td className="num"><PostGraduation post={p.postGraduation} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {detail.recent.length === 0 && <div className="empty">No launches seen on this template yet.</div>}
        </div>
      </section>
    </div>
  );
}

type PoolDay = { liquidityUsd: number; volumeUsd: number } | null;
function PostGraduation({ post }: { post?: { d1: PoolDay; d7: PoolDay; lpPulled: boolean } | null }) {
  if (!post) return <span className="muted">–</span>;
  if (post.lpPulled) return <>LP pulled</>;
  const day = (d: PoolDay, n: number) => (d ? `D+${n} $${compact(d.liquidityUsd)} liq · $${compact(d.volumeUsd)} vol` : `D+${n} pending`);
  return <>{day(post.d1, 1)}<div className="sub">{day(post.d7, 7)}</div></>;
}

function Integrity() {
  const poll = usePoll<any[]>("/api/integrity/monthly", 300_000);
  const months = poll.data;
  const latest = months?.findLast((m) => m.graduations > 0);
  const toDate = latest?.month === new Date().toISOString().slice(0, 7);
  const totalGraduations = months?.reduce((s, m) => s + m.graduations, 0) ?? 0;
  const totalUncontested = months?.reduce((s, m) => s + m.factoryGraduations, 0) ?? 0;
  const chart = (all: "pools" | "graduations", uncontested: "factoryPools" | "factoryGraduations", noun: string) =>
    months?.length ? (
      <>
        <ColumnChart
          stacked series={VERDICTS} format={(v) => num(v, 0)} tickFormat={compact} height={220}
          columns={months.map((m) => ({
            label: monthLabel(m.month),
            title: monthName(m.month),
            values: [m[all] - m[uncontested], m[uncontested]],
            detail: `${pct(m[all] ? m[uncontested] / m[all] : null, 1)} of ${noun} uncontested`,
          }))}
        />
        <TableView
          head={["Month", "Contested", "Uncontested", "Uncontested share"]}
          rows={months.map((m) => [monthName(m.month), num(m[all] - m[uncontested], 0), num(m[uncontested], 0), pct(m[all] ? m[uncontested] / m[all] : null, 1)])}
        />
      </>
    ) : (
      <Placeholder poll={poll} empty="No history yet." height={248} />
    );
  return (
    <>
      <RawVsJudged />
      <div className="grid-even">
        <section className="card hero">
          {latest ? (
            <>
              <div className="label">{monthName(latest.month)}{toDate ? ", month to date" : ""}</div>
              <div className="figure">
                {num(latest.graduations - latest.factoryGraduations, 0)}<span> of {num(latest.graduations, 0)}</span>
              </div>
              <p className="lede">
                Meteora DBC graduations were contested: independent buyers competed to fill the curve. The other{" "}
                {pct(latest.factoryGraduations / latest.graduations, 1)} completed without real competition.
              </p>
              <p className="muted">
                Raw chain stats, DefiLlama and Meteora's DBC API count every completed curve. Litmus judges each one since April 2025 from on-chain
                evidence and links the transactions, so launchpads and templates can be compared on contested outcomes.
              </p>
              <div className="tiles inset">
                <Tile
                  label="Contested since April 2025" value={pct((totalGraduations - totalUncontested) / totalGraduations, 1)}
                  sub={`${compact(totalGraduations - totalUncontested)} of ${compact(totalGraduations)} graduations`}
                />
                <Tile
                  label="Contested launches this month" value={pct(latest.pools ? (latest.pools - latest.factoryPools) / latest.pools : null, 1)}
                  sub={`${compact(latest.pools - latest.factoryPools)} of ${compact(latest.pools)} pools`}
                />
              </div>
            </>
          ) : (
            <Placeholder poll={poll} empty="No graduations recorded yet." height={220} />
          )}
        </section>
        <Rules />
      </div>
      <div className={poll.stale ? "grid-even stale" : "grid-even"}>
        <section className="card">
          <h2>Graduations per month</h2>
          <p className="caption">Contested vs uncontested, since DBC went live in April 2025.</p>
          {chart("graduations", "factoryGraduations", "graduations")}
        </section>
        <section className="card">
          <h2>Launches per month</h2>
          <p className="caption">New pools by verdict. A pool is uncontested when its setup or creation slot left no room for competition.</p>
          {chart("pools", "factoryPools", "launches")}
        </section>
      </div>
    </>
  );
}

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const SPLIT_ROWS = 7;

// The demo's centerpiece: each graduation as raw chain stats count it (left) and as Litmus judges it (right).
function RawVsJudged() {
  const { items, recent } = useGraduations();
  useTick(5000);
  const contested = items.filter((g) => contestedOf(g) === true).length;
  const uncontested = items.filter((g) => contestedOf(g) === false).length;
  const since = items.at(-1)?.ts;
  return (
    <section className="card split">
      <h2>Raw vs judged</h2>
      <p className="caption">
        Every DBC graduation as it lands: first as raw chain stats, DefiLlama and Meteora's DBC API count it, then as Litmus judges it, with its
        evidence and transactions.
      </p>
      <div className="split-grid">
        <div className="split-count">
          <div className="label">Raw chain stats</div>
          <div className="count">{num(items.length, 0)}<span> graduations</span></div>
          <div className="sub">{since ? `since ${clock(since)}` : "waiting for the first one"}</div>
        </div>
        <div className="split-count">
          <div className="label">Litmus verdict</div>
          <div className="count">{num(contested, 0)}<span> contested</span></div>
          <div className="sub">{num(uncontested, 0)} uncontested{items.length ? ` · ${pct(contested / items.length, 1)} contested` : ""}</div>
        </div>
      </div>
      {items.length ? (
        <ol className="split-rows" aria-label="Latest graduations, raw and judged">
          {items.slice(0, SPLIT_ROWS).map((g) => (
            <li key={`${g.sig}-${g.pool}`} className={[contestedOf(g) && "contested", g.fresh && "fresh"].filter(Boolean).join(" ")}>
              <div className="raw">
                <div className="name-row">
                  <span className="dot" style={{ background: "var(--good)" }} />
                  <span className="kind">Graduated</span>
                  <b dir="auto">{g.name || short(g.pool ?? g.sig)}</b>
                </div>
                <div className="sub">
                  {g.symbol ? <>$<bdi>{g.symbol}</bdi> · </> : null}pool {short(g.pool ?? "")} ·{" "}
                  <a href={`https://solscan.io/tx/${g.sig}`} target="_blank" rel="noreferrer">{ago(g.ts)}</a>
                </div>
              </div>
              <div className="judged">
                <div className="name-row">
                  <Verdict of={g} />
                  {g.launchpad && <span className="kind">{launchpadName(g.launchpad)}</span>}
                  <span className="receipts">
                    {(g.receipts?.length ? g.receipts : [g.sig]).slice(0, 2).map((sig) => (
                      <a key={sig} className="mono" href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noreferrer">{short(sig)}</a>
                    ))}
                  </span>
                </div>
                <div className="sub">{evidenceOf(g).join(" · ") || "No evidence attached."}</div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Placeholder poll={recent} empty="No graduations yet. Listening…" height={SPLIT_ROWS * 64} />
      )}
    </section>
  );
}

type Rule = { id: string; name: string; description: string; threshold?: string | number | null };

function Rules() {
  const poll = usePoll<{ version: string; rules: Rule[] }>("/api/rules", 300_000);
  return (
    <section className="card">
      <h2>How a graduation is judged</h2>
      <p className="caption">
        Contested: independent buyers competed to fill the curve. Uncontested: it was completed without real competition. A verdict keeps the rules
        that matched as evidence, with the transactions behind them.{poll.data ? ` Rules version ${poll.data.version}.` : ""}
      </p>
      {poll.data ? (
        <dl className="signals">
          {poll.data.rules.map((rule) => (
            <div key={rule.id}>
              <dt>{rule.name}{rule.threshold != null && <span className="badge">{rule.threshold}</span>}</dt>
              <dd>{rule.description}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <Placeholder poll={poll} empty="" height={160} />
      )}
    </section>
  );
}

const ENDPOINTS = [
  ["GET /api/overview?window=86400", "Launches, graduations and active pools in the window (seconds), the contested subset (organic), volume per quote token, SOL/USD."],
  ["GET /api/integrity/monthly", "Every month since April 2025: pools and graduations, and how many of each were uncontested (factoryPools, factoryGraduations)."],
  ["GET /api/graduations/recent?limit=50", "Latest judged graduations, in the same shape as stream items: verdict, evidence, receipts, launchpad."],
  ["GET /api/rules", "The versioned rules behind every verdict: id, name, description, threshold."],
  ["GET /api/launchpads?window=86400", "Launchpads by identity address with all-time contested outcomes, activity in the window and uncontested share. name is null when unlabeled."],
  ["GET /api/templates?window=86400&organic=1", "Parameter templates with graduation rate, contested graduation rate, median time to graduate, launchpad and template prior. organic=1 drops uncontested templates."],
  ["GET /api/templates/:id", "One template: configs with sampled bonding curves, graduation odds by progress, recent launches with verdicts."],
  ["GET /api/configs/:address", "Any config, decoded from chain on first request: parameters, curve, supply split, template, launchpad, pools."],
  ["GET /api/pools/hot", "Pools closest to graduation right now, with empirical odds, verdict, evidence and launchpad."],
  ["GET /api/benchmarks/similar?quote=SOL&threshold=85", "Outcome priors: every pool with a similar migration threshold since April 2025, all vs contested, by threshold bucket."],
  ["GET /api/health", "Stream transport, updates received, last slot."],
  ["GET /api/usage", "Requests per route per day, stream subscribers, Studio deploys and launches."],
  ["WS /api/stream", "Push feed of launches, graduations and new configs as they land, each with verdict, evidence, receipts and launchpad."],
];

const STREAM_ITEM = `type StreamItem = {
  type: "launch" | "graduation" | "config";
  ts: number;          // unix seconds
  sig: string;         // transaction signature
  config: string;
  pool?: string;       // launch, graduation
  mint?: string; creator?: string; name?: string; symbol?: string; uri?: string; // launch
  quoteReserve?: string;                     // graduation, raw quote amount
  feeClaimer?: string; quoteMint?: string;   // config
  contested: boolean;  // false: completed without real competition
  evidence: Record<string, string>; // e.g. { "creator fill": "94% in the creation slot" }
  receipts: string[];  // transaction signatures backing the evidence
  launchpad: { id: string; name: string | null } | null;
  organic: boolean; reasons: string[];       // v2 aliases of contested and evidence
};`;

function ApiDocs() {
  const origin = location.origin;
  return (
    <section className="card">
      <h2>Data API</h2>
      <p className="caption">
        Verdict-aware DBC data for terminals and launchpads. Free, no key, JSON, CORS open on GET routes. window is in seconds; quote amounts are
        raw integers with their decimals unless noted.
      </p>
      <dl className="endpoints">
        {ENDPOINTS.map(([route, what]) => {
          const [method, path] = route.split(" ");
          return (
            <div key={route}>
              <dt className="mono">
                <span className="badge">{method}</span>{" "}
                {method === "GET" && !path.includes(":") ? <a href={path} target="_blank" rel="noreferrer">{path}</a> : path}
              </dt>
              <dd>{what}</dd>
            </div>
          );
        })}
      </dl>
      <h2 className="spaced">Stream items</h2>
      <p className="caption">Every message on /api/stream is one JSON object of this shape.</p>
      <pre className="code">{STREAM_ITEM}</pre>
      <pre className="code">
{`const ws = new WebSocket("${origin.replace("http", "ws")}/api/stream");
ws.onmessage = (e) => {
  const item = JSON.parse(e.data);
  if (item.type === "graduation" && item.contested) console.log(item.launchpad?.name, item.evidence, item.receipts);
};`}
      </pre>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
