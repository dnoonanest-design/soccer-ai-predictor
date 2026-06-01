import { logger } from "./logger";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = 30000; // 30s — events don't need sub-15s freshness

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  return entry.data;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}

async function fetchFootball(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) {
    logger.warn("API_FOOTBALL_KEY not set");
    return null;
  }
  const url = `${API_FOOTBALL_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });
  if (!res.ok) {
    logger.error({ status: res.status, url }, "API-Football request failed");
    return null;
  }
  return res.json();
}

type EventType = "goal" | "yellow_card" | "red_card" | "yellow_red_card" | "substitution" | "var" | "other";

export interface MatchEvent {
  minute: number;
  extra_time: number | null;
  team_side: string;
  team_name: string;
  player: string | null;
  assist: string | null;
  type: EventType;
  detail: string;
  comments: string | null;
}

function classifyType(apiType: string, detail: string): EventType {
  const t = apiType.toLowerCase();
  const d = detail.toLowerCase();
  if (t === "goal") return "goal";
  if (t === "card") {
    if (d.includes("yellow-red") || d.includes("second yellow")) return "yellow_red_card";
    if (d.includes("red")) return "red_card";
    return "yellow_card";
  }
  if (t === "subst") return "substitution";
  if (t === "var") return "var";
  return "other";
}

export async function getMatchEvents(
  matchId: number,
  homeTeamId: number
): Promise<MatchEvent[]> {
  const cacheKey = `events:${matchId}`;
  const cached = getCached<MatchEvent[]>(cacheKey);
  if (cached) return cached;

  const data = (await fetchFootball(`/fixtures/events?fixture=${matchId}`)) as {
    response?: Array<{
      time: { elapsed: number; extra: number | null };
      team: { id: number; name: string };
      player: { id: number | null; name: string | null };
      assist: { id: number | null; name: string | null };
      type: string;
      detail: string;
      comments: string | null;
    }>;
  } | null;

  if (!data?.response) {
    setCache(cacheKey, []);
    return [];
  }

  const events: MatchEvent[] = data.response.map((e) => ({
    minute: e.time.elapsed,
    extra_time: e.time.extra ?? null,
    team_side: e.team.id === homeTeamId ? "home" : "away",
    team_name: e.team.name,
    player: e.player.name ?? null,
    assist: e.assist.name ?? null,
    type: classifyType(e.type, e.detail),
    detail: e.detail,
    comments: e.comments ?? null,
  }));

  // Sort chronologically
  events.sort((a, b) => a.minute - b.minute || (a.extra_time ?? 0) - (b.extra_time ?? 0));

  setCache(cacheKey, events);
  return events;
}
