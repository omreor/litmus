import { useEffect, useState } from "react";

export function usePoll<T>(url: string | null, ms: number) {
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

export type FeedItem = { type: "launch" | "graduation" | "config"; ts: number; sig: string; pool?: string; config?: string; name?: string; symbol?: string; mint?: string };

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
