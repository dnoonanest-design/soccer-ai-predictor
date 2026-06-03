import { logger } from "./logger";
import { waitForRateLimit } from "./rateLimiter";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — H2H history is stable

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
  await waitForRateLimit();
  const res = await fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });
  if (!res.ok) {
    logger.error({ status: res.status, url }, "API-Football request failed");
    return null;
  }
  return res.json();
}

export interface H2HMatch {
  date: string;
  competition: string;
  home_team: string;
  home_team_id: number;
  away_team: string;
  away_team_id: number;
  home_score: number;
  away_score: number;
  result: "win" | "draw" | "loss";
}

export interface H2HSummary {
  wins: number;
  draws: number;
  losses: number;
  goals_scored: number;
  goals_conceded: number;
}

export interface H2HResult {
  ref_team_id: number;
  ref_team: string;
  opponent_team: string;
  matches: H2HMatch[];
  summary: H2HSummary;
}

export async function getH2H(
  refTeamId: number,
  refTeamName: string,
  opponentTeamId: number,
  opponentTeamName: string
): Promise<H2HResult> {
  const cacheKey = `h2h:${Math.min(refTeamId, opponentTeamId)}-${Math.max(refTeamId, opponentTeamId)}`;
  const cached = getCached<H2HResult>(cacheKey);
  if (cached) {
    // Re-orient from cached data in case teams are swapped
    return reorient(cached, refTeamId, refTeamName, opponentTeamName);
  }

  const data = (await fetchFootball(
    `/fixtures/headtohead?h2h=${refTeamId}-${opponentTeamId}&last=5`
  )) as {
    response?: Array<{
      fixture: { date: string };
      league: { name: string };
      teams: {
        home: { id: number; name: string };
        away: { id: number; name: string };
      };
      goals: { home: number | null; away: number | null };
    }>;
  } | null;

  if (!data?.response || data.response.length === 0) {
    const empty: H2HResult = {
      ref_team_id: refTeamId,
      ref_team: refTeamName,
      opponent_team: opponentTeamName,
      matches: [],
      summary: { wins: 0, draws: 0, losses: 0, goals_scored: 0, goals_conceded: 0 },
    };
    setCache(cacheKey, empty);
    return empty;
  }

  const matches: H2HMatch[] = data.response.map((f) => {
    const homeScore = f.goals.home ?? 0;
    const awayScore = f.goals.away ?? 0;
    const refIsHome = f.teams.home.id === refTeamId;
    const refGoals = refIsHome ? homeScore : awayScore;
    const oppGoals = refIsHome ? awayScore : homeScore;

    let result: "win" | "draw" | "loss";
    if (refGoals > oppGoals) result = "win";
    else if (refGoals === oppGoals) result = "draw";
    else result = "loss";

    return {
      date: f.fixture.date,
      competition: f.league.name,
      home_team: f.teams.home.name,
      home_team_id: f.teams.home.id,
      away_team: f.teams.away.name,
      away_team_id: f.teams.away.id,
      home_score: homeScore,
      away_score: awayScore,
      result,
    };
  });

  const summary: H2HSummary = matches.reduce(
    (acc, m) => ({
      wins: acc.wins + (m.result === "win" ? 1 : 0),
      draws: acc.draws + (m.result === "draw" ? 1 : 0),
      losses: acc.losses + (m.result === "loss" ? 1 : 0),
      goals_scored:
        acc.goals_scored +
        (m.home_team_id === refTeamId ? m.home_score : m.away_score),
      goals_conceded:
        acc.goals_conceded +
        (m.home_team_id === refTeamId ? m.away_score : m.home_score),
    }),
    { wins: 0, draws: 0, losses: 0, goals_scored: 0, goals_conceded: 0 }
  );

  const result: H2HResult = {
    ref_team_id: refTeamId,
    ref_team: refTeamName,
    opponent_team: opponentTeamName,
    matches,
    summary,
  };
  setCache(cacheKey, result);
  return result;
}

function reorient(cached: H2HResult, refTeamId: number, refTeamName: string, opponentTeamName: string): H2HResult {
  if (cached.ref_team_id === refTeamId) return cached;
  // Flip — cached was from opponent's perspective
  const flipped = cached.matches.map((m) => ({
    ...m,
    result: m.result === "win" ? ("loss" as const) : m.result === "loss" ? ("win" as const) : ("draw" as const),
  }));
  const s = cached.summary;
  return {
    ref_team_id: refTeamId,
    ref_team: refTeamName,
    opponent_team: opponentTeamName,
    matches: flipped,
    summary: {
      wins: s.losses,
      draws: s.draws,
      losses: s.wins,
      goals_scored: s.goals_conceded,
      goals_conceded: s.goals_scored,
    },
  };
}
