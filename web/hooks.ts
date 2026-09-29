import { useEffect, useState } from "react";

// Where the API lives. Served by Bun (no live.json): same origin. On GitHub Pages: the tunnel named in
// live.json when its /api/health answers within 3 s, else the JSON snapshots published next to the page.
export type Source = { mode: "local" | "live" | "snapshot"; base: string; at: number | null };

async function resolveSource(): Promise<Source> {
  let live: { url: string | null; at: number } | null = null;
  try {
    const res = await fetch("live.json", { cache: "no-store" });
    if (res.ok) live = await res.json();
  } catch {}
  if (!live) return { mode: "local", base: "", at: null };
  try {
    if (live.url && (await fetch(`${live.url}/api/health`, { signal: AbortSignal.timeout(3000) })).ok) return { mode: "live", base: live.url, at: live.at };
  } catch {}
  return { mode: "snapshot", base: "", at: live.at };
}

export const source = await resolveSource();

// Snapshot files are named after the route: /api/templates?window=3600&organic=1 -> data/templates_window_3600_organic_1.json
// (scripts/publish.sh writes them).
export const apiUrl = (path: string) =>
  source.mode === "snapshot" ? `data/${path.replace(/^\/api\//, "").replace(/[/?&=]/g, "_")}.json` : source.base + path;

export type Poll<T> = { data: T | null; error: string | null; stale: boolean };

// `stale` is true while the data on screen belongs to a previous URL (a filter just changed).
export function usePoll<T>(url: string | null, ms: number): Poll<T> {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null }>({ url: null, data: null, error: null });
  useEffect(() => {
    if (!url) return setState({ url, data: null, error: null });
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(apiUrl(url));
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (alive) setState({ url, data: body, error: null });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (alive) setState((prev) => ({ url, data: prev.url === url ? prev.data : null, error }));
      }
    };
    load();
    const id = source.mode === "snapshot" ? undefined : setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, ms]);
  return { data: state.data, error: state.error, stale: state.url !== url };
}

export type Launchpad = { id: string; name: string | null };

export type Verdict = "contested" | "uncontested" | "unverified";

// Verdict fields of pools and stream items, plus the v2 aliases organic/reasons; templates carry a prior (factory/factoryReasons).
export type Judged = {
  verdict?: Verdict;
  contested?: boolean | null;
  evidence?: Record<string, string | number> | null;
  receipts?: string[];
  organic?: boolean;
  reasons?: string[];
  factory?: boolean;
  factoryReasons?: string[];
};

// A template's prior only ever flags it uncontested; pools and stream items carry their own verdict.
export const verdictOf = (x: Judged): Verdict | undefined => x.verdict ?? (x.factory ? "uncontested" : undefined);

export type FeedItem = Judged & {
  type: "launch" | "graduation" | "config";
  ts: number;
  sig: string;
  pool?: string;
  config?: string;
  name?: string;
  symbol?: string;
  mint?: string;
  launchpad?: Launchpad | null;
};

export function useFeed(limit = 60) {
  const [items, setItems] = useState<FeedItem[]>([]);
  useEffect(() => {
    if (source.mode === "snapshot") return;
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${(source.base || location.origin).replace(/^http/, "ws")}/api/stream`);
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

export type Graduation = FeedItem & { fresh: boolean };

// Every graduation seen this session, newest first: seeded from /api/graduations/recent so it's never
// empty, then merged with the live stream (`feed`, from useFeed). Deduped by transaction and pool; `fresh` marks live arrivals.
export function useGraduations(feed: FeedItem[]) {
  const recent = usePoll<FeedItem[]>("/api/graduations/recent?limit=50", 60_000);
  const [seen, setSeen] = useState<{ items: Graduation[]; keys: Set<string> }>({ items: [], keys: new Set() });
  const merge = (incoming: FeedItem[]) =>
    setSeen((prev) => {
      const added = incoming.filter((i) => i.type === "graduation" && !prev.keys.has(`${i.sig}-${i.pool}`));
      if (!added.length) return prev;
      const newest = prev.items[0]?.ts ?? Infinity;
      return {
        keys: new Set([...prev.keys, ...added.map((i) => `${i.sig}-${i.pool}`)]),
        items: [...added.map((i) => ({ ...i, fresh: i.ts >= newest })), ...prev.items].sort((a, b) => b.ts - a.ts),
      };
    });
  useEffect(() => {
    if (recent.data) merge(recent.data);
  }, [recent.data]);
  useEffect(() => merge(feed), [feed]);
  return { items: seen.items, recent };
}

// Re-renders every `ms` so relative times stay current between live events.
export function useTick(ms: number) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
}
