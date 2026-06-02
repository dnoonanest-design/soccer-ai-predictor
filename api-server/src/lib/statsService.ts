import { logger } from "./logger";
import { waitForRateLimit } from "./rateLimiter";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const SEASON = parseInt(process.env.FOOTBALL_SEASON ?? "2025", 10);

const TEAM_CACHE_TTL = 10 * 60 * 1000;
const LIVE_CACHE_TTL = 12 * 1000;

interface CacheEntry<T> { data: T; fetchedAt: number; }
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string, ttl: number): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() - entry.fetchedAt > ttl) return null;
  return entry.data;
}
function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}


}

async function fetchFootball(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) { logger.warn("API_FOOTBALL_KEY not set"); return null; }
  const url = `${API_FOOTBALL_BASE}${path}`;
  await waitForRateLimit(); // FIXED: was missing entirely
  const res = await fetch(url, { headers: { "x-apisports-key": API_FOOTBALL_KEY } });
  if (!res.ok) { logger.error({ status: res.status, url }, "API-Football failed"); return null; }
  return res.json();
}

export interface TeamStats {
  team_id: number;
  team: string;
  form: string;
  goals_per_game: number;
  conceded_per_game: number;
  clean_sheets: number;
  matches_played: number;
  wins: number;
  draws: number;
  losses: number;
  possession: string | null;
  shots_total: number | null;
  shots_on_target: number | null;
  corners: number | null;
  fouls: number | null;
  offsides: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  goalkeeper_saves: number | null;
  shots_off_target: number | null;
  blocked_shots: number | null;
  shots_inside_box: number | null;
  shots_outside_box: number | null;
  total_passes: number | null;
  accurate_passes: number | null;
  pass_accuracy: string | null;
  expected_goals_live: number | null;
  dangerous_attacks: number | null;
}

export interface MatchStatsResult {
  home: TeamStats;
  away: TeamStats;
  season: number;
  has_live_stats: boolean;
}

type ApiTeamStatsResp = {
  response?: {
    form?: string;
    fixtures?: {
      played?: { total?: number };
      wins?: { total?: number };
      draws?: { total?: number };
      loses?: { total?: number };
    };
    goals?: {
      for?: { average?: { total?: string } };
      against?: { average?: { total?: string } };
    };
    clean_sheet?: { total?: number };
  };
};

type ApiFixtureStatResp = {
  response?: Array<{
    team: { id: number; name: string };
    statistics: Array<{ type: string; value: string | number | null }>;
  }>;
};
type TeamStatEntry = NonNullable<ApiFixtureStatResp["response"]>[number];

async function fetchTeamStats(teamId: number, leagueId: number): Promise<TeamStats | null> {
  const key = `teamstats:${teamId}:${leagueId}`;
  const cached = getCached<TeamStats>(key, TEAM_CACHE_TTL);
  if (cached) return cached;

  const data = (await fetchFootball(
    `/teams/statistics?team=${teamId}&league=${leagueId}&season=${SEASON}`
  )) as ApiTeamStatsResp | null;

  const r = data?.response;
  if (!r) return null;

  const played = r.fixtures?.played?.total ?? 0;
  const wins   = r.fixtures?.wins?.total ?? 0;
  const draws  = r.fixtures?.draws?.total ?? 0;
  const losses = r.fixtures?.loses?.total ?? 0;
  const gpg    = parseFloat(r.goals?.for?.average?.total ?? "0") || 0;
  const cpg    = parseFloat(r.goals?.against?.average?.total ?? "0") || 0;
  const cs     = r.clean_sheet?.total ?? 0;
  const rawForm = r.form ?? "";
  const form = rawForm.slice(-5);

  const stats: TeamStats = {
    team_id: teamId,
    team: "",
    form,
    goals_per_game: gpg,
    conceded_per_game: cpg,
    clean_sheets: cs,
    matches_played: played,
    wins,
    draws,
    losses,
    possession: null,
    shots_total: null,
    shots_on_target: null,
    corners: null,
    fouls: null,
    offsides: null,
    yellow_cards: null,
    red_cards: null,
    goalkeeper_saves: null,
    shots_off_target: null,
    blocked_shots: null,
    shots_inside_box: null,
    shots_outside_box: null,
    total_passes: null,
    accurate_passes: null,
    pass_accuracy: null,
    expected_goals_live: null,
    dangerous_attacks: null,
  };
  setCache(key, stats);
  return stats;
}

function normaliseStatName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickStat(
  stats: Array<{ type: string; value: string | number | null }>,
  ...names: string[]
): string | number | null {
  const wanted = new Set(names.map(normaliseStatName));
  return stats.find((s) => wanted.has(normaliseStatName(s.type)))?.value ?? null;
}

function toNumber(v: string | number | null): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace("%", "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInt(v: string | number | null): number | null {
  const n = toNumber(v);
  return n == null ? null : Math.trunc(n);
}

function hasAnyLiveMetric(stats: Partial<TeamStats>): boolean {
  return Object.entries(stats).some(([key, value]) =>
    key !== "team" && key !== "team_id" && value !== null && value !== undefined
  );
}

async function fetchLiveFixtureStats(
  fixtureId: number,
  homeTeamId: number,
  awayTeamId: number
): Promise<{ home: Partial<TeamStats>; away: Partial<TeamStats> } | null> {
  const key = `fixturestats:${fixtureId}`;
  type LFResult = { home: Partial<TeamStats>; away: Partial<TeamStats> };
  const cached = getCached<LFResult>(key, LIVE_CACHE_TTL);
  if (cached) return cached;

  const data = (await fetchFootball(
    `/fixtures/statistics?fixture=${fixtureId}`
  )) as ApiFixtureStatResp | null;
  if (!data?.response || data.response.length === 0) return null;

  const parse = (teamEntry: TeamStatEntry): Partial<TeamStats> => {
    const s = teamEntry.statistics ?? [];
    const possession = pickStat(s, "Ball Possession", "Possession");
    const passPct = pickStat(s, "Passes %", "Passes Percent", "Pass Accuracy", "Passes Accuracy");
    return {
      possession: possession == null ? null : String(possession),
      shots_total: toInt(pickStat(s, "Total Shots", "Shots Total")),
      shots_on_target: toInt(pickStat(s, "Shots on Goal", "Shots on Target")),
      corners: toInt(pickStat(s, "Corner Kicks", "Corners")),
      fouls: toInt(pickStat(s, "Fouls")),
      offsides: toInt(pickStat(s, "Offsides")),
      yellow_cards: toInt(pickStat(s, "Yellow Cards", "Yellow Card")),
      red_cards: toInt(pickStat(s, "Red Cards", "Red Card")),
      goalkeeper_saves: toInt(pickStat(s, "Goalkeeper Saves", "Keeper Saves", "Saves")),
      shots_off_target: toInt(pickStat(s, "Shots off Goal", "Shots off Target")),
      blocked_shots: toInt(pickStat(s, "Blocked Shots")),
      shots_inside_box: toInt(pickStat(s, "Shots insidebox", "Shots inside box", "Shots in Box")),
      shots_outside_box: toInt(pickStat(s, "Shots outsidebox", "Shots outside box", "Shots out Box")),
      total_passes: toInt(pickStat(s, "Total passes", "Total Passes", "Passes Total")),
      accurate_passes: toInt(pickStat(s, "Passes accurate", "Accurate Passes", "Passes Accurate")),
      pass_accuracy: passPct == null ? null : String(passPct),
      expected_goals_live: toNumber(pickStat(s, "expected_goals", "Expected Goals", "xG", "Expected goals")),
      dangerous_attacks: toInt(pickStat(s, "Dangerous Attacks", "Dangerous attacks")),
    };
  };

  const homeEntry = data.response.find((e) => e.team.id === homeTeamId);
  const awayEntry = data.response.find((e) => e.team.id === awayTeamId);
  const result: LFResult = {
    home: homeEntry ? parse(homeEntry) : {},
    away: awayEntry ? parse(awayEntry) : {},
  };

  if (!hasAnyLiveMetric(result.home) && !hasAnyLiveMetric(result.away)) return null;

  setCache(key, result);
  return result;
}

const MAX_GOALS = 8;

function poisson(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

export interface XGPrediction {
  match_id: number;
  home_xg: number;
  away_xg: number;
  home_win: number;
  draw: number;
  away_win: number;
}

function computeXG(
  homeGpg: number, homeCpg: number,
  awayGpg: number, awayCpg: number,
  homeAdvantage = 1.10
): { homeXG: number; awayXG: number; homeWin: number; draw: number; awayWin: number } {
  const homeXG = ((homeGpg + awayCpg) / 2) * homeAdvantage;
  const awayXG = (awayGpg + homeCpg) / 2;
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    const pH = poisson(homeXG, h);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = pH * poisson(awayXG, a);
      if (h > a) homeWin += joint;
      else if (h === a) draw += joint;
      else awayWin += joint;
    }
  }
  const total = homeWin + draw + awayWin;
  return {
    homeXG: Math.round(homeXG * 100) / 100,
    awayXG: Math.round(awayXG * 100) / 100,
    homeWin: (homeWin / total) * 100,
    draw: (draw / total) * 100,
    awayWin: (awayWin / total) * 100,
  };
}

export async function getAllXGPredictions(
  matches: Array<{
    id: number;
    home_team: { id: number; name: string };
    away_team: { id: number; name: string };
    league_id: number;
  }>
): Promise<XGPrediction[]> {
  const statsMap = new Map<string, TeamStats | null>();
  for (const m of matches) {
    const hKey = `teamstats:${m.home_team.id}:${m.league_id}`;
    const aKey = `teamstats:${m.away_team.id}:${m.league_id}`;
    statsMap.set(hKey, getCached<TeamStats>(hKey, TEAM_CACHE_TTL));
    statsMap.set(aKey, getCached<TeamStats>(aKey, TEAM_CACHE_TTL));
  }

  const predictions: XGPrediction[] = [];
  for (const m of matches) {
    const home = statsMap.get(`teamstats:${m.home_team.id}:${m.league_id}`);
    const away = statsMap.get(`teamstats:${m.away_team.id}:${m.league_id}`);
    if (!home || !away || home.matches_played === 0 || away.matches_played === 0) continue;
    const xg = computeXG(
      home.goals_per_game, home.conceded_per_game,
      away.goals_per_game, away.conceded_per_game
    );
    predictions.push({
      match_id: m.id,
      home_xg: xg.homeXG,
      away_xg: xg.awayXG,
      home_win: xg.homeWin,
      draw: xg.draw,
      away_win: xg.awayWin,
    });
  }
  return predictions;
}

// ── FIXED: Sequential fetching instead of Promise.all ────────────────────────
export async function getMatchStats(
  fixtureId: number,
  homeTeamId: number,
  homeTeamName: string,
  awayTeamId: number,
  awayTeamName: string,
  leagueId: number,
  isLiveOrFinished: boolean
): Promise<MatchStatsResult> {

  const homeStats = await fetchTeamStats(homeTeamId, leagueId);
  const awayStats = await fetchTeamStats(awayTeamId, leagueId);
  const liveStats = isLiveOrFinished
    ? await fetchLiveFixtureStats(fixtureId, homeTeamId, awayTeamId)
    : null;

  const empty = (id: number, name: string): TeamStats => ({
    team_id: id, team: name, form: "",
    goals_per_game: 0, conceded_per_game: 0,
    clean_sheets: 0, matches_played: 0,
    wins: 0, draws: 0, losses: 0,
    possession: null, shots_total: null, shots_on_target: null,
    corners: null, fouls: null, offsides: null,
    yellow_cards: null, red_cards: null, goalkeeper_saves: null,
    shots_off_target: null, blocked_shots: null,
    shots_inside_box: null, shots_outside_box: null,
    total_passes: null, accurate_passes: null, pass_accuracy: null,
    expected_goals_live: null, dangerous_attacks: null,
  });

  const home: TeamStats = {
    ...(homeStats ?? empty(homeTeamId, homeTeamName)),
    team: homeTeamName,
    ...(liveStats?.home ?? {}),
  };
  const away: TeamStats = {
    ...(awayStats ?? empty(awayTeamId, awayTeamName)),
    team: awayTeamName,
    ...(liveStats?.away ?? {}),
  };

  return {
    home,
    away,
    season: SEASON,
    has_live_stats: liveStats !== null,
  };
}
