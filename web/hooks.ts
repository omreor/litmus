import { useEffect, useState } from "react";

export type Poll<T> = { data: T | null; error: string | null; stale: boolean };

// `stale` is true while the data on screen belongs to a previous URL (a filter just changed).
export function usePoll<T>(url: string | null, ms: number): Poll<T> {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: string | null }>({ url: null, data: null, error: null });
  useEffect(() => {
    if (!url) return setState({ url, data: null, error: null });
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(url);
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (alive) setState({ url, data: body, error: null });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        if (alive) setState((prev) => ({ url, data: prev.url === url ? prev.data : null, error }));
      }
    };
    load();
    const id = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [url, ms]);
  return { data: state.data, error: state.error, stale: state.url !== url };
}

export type Launchpad = { id: string; name: string | null };

// Verdict fields: contested/evidence/receipts, plus the v2 aliases organic/reasons (pools) and factory/factoryReasons (templates).
export type Judged = {
  contested?: boolean;
  evidence?: Record<string, string | number> | null;
  receipts?: string[];
  organic?: boolean;
  reasons?: string[];
  factory?: boolean;
  factoryReasons?: string[];
};

export const contestedOf = (x: Judged) => x.contested ?? x.organic ?? (x.factory === undefined ? undefined : !x.factory);

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

export type Graduation = FeedItem & { fresh: boolean };

// Every graduation seen this session, newest first: seeded from /api/graduations/recent so it's never
// empty, then merged with the live stream. Deduped by transaction and pool; `fresh` marks live arrivals.
export function useGraduations() {
  const recent = usePoll<FeedItem[]>("/api/graduations/recent?limit=50", 60_000);
  const feed = useFeed();
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
