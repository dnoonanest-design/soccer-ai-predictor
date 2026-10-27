import { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";

type LiveFeedState = { connected: boolean; lastEventAt: number | null; liveCount: number | null };

const LiveFeedContext = createContext<LiveFeedState>({ connected: false, lastEventAt: null, liveCount: null });

export function useLiveFeed() {
  return useContext(LiveFeedContext);
}

/** Query keys that show live information and should refresh when the server says something changed. */
export function isLiveQuery(key: readonly unknown[], liveIds: Set<number>): boolean {
  const head = String(key[0] ?? "");
  if (head === "/api/matches" || head === "/api/xg" || head === "/api/summary" || head === "stored-predictions") return true;
  const m = head.match(/^\/api\/matches\/(\d+)(?:\/(stats|events))?$/);
  if (m) return liveIds.has(Number(m[1]));
  if (head === "betting-analysis") return liveIds.has(Number(key[1]));
  return false;
}

/**
 * Listens to /api/live/updates and refreshes only the live data on screen when a
 * score, minute, status or live prediction changes. Polling stays on, so if the
 * stream drops (or the browser has no EventSource) nothing goes stale for long.
 */
export function LiveFeedProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveFeedState>({ connected: false, lastEventAt: null, liveCount: null });

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let previousIds = new Set<number>();
    const start = () => {
      if (source || document.visibilityState === "hidden") return;
      source = new EventSource("/api/live/updates");
      source.onopen = () => setState((s) => ({ ...s, connected: true }));
      source.onerror = () => setState((s) => ({ ...s, connected: false }));
      source.addEventListener("live", (event) => {
        let data: { live?: number; ids?: number[] } = {};
        try { data = JSON.parse((event as MessageEvent).data); } catch { /* ignore */ }
        const ids = new Set<number>([...(data.ids ?? []), ...previousIds]); // include matches that just finished
        previousIds = new Set(data.ids ?? []);
        void queryClient.invalidateQueries({ predicate: (q: Query) => isLiveQuery(q.queryKey, ids) });
        setState({ connected: true, lastEventAt: Date.now(), liveCount: data.live ?? null });
      });
    };
    const stop = () => { source?.close(); source = null; setState((s) => ({ ...s, connected: false })); };
    // Hidden tabs do not hold a connection open; coming back reconnects (and focus refetch catches up).
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); stop(); };
  }, [queryClient]);

  return <LiveFeedContext.Provider value={state}>{children}</LiveFeedContext.Provider>;
}
