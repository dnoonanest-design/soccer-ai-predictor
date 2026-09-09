import { logger } from "./logger";
import { waitForRateLimit } from "./rateLimiter";
import { getDomesticLeagueStrength } from "./leagueConfig";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const SEASON = parseInt(process.env.FOOTBALL_SEASON ?? "2025", 10);

const TEAM_CACHE_TTL = 10 * 60 * 1000;
const RECENT_FIXTURE_CACHE_TTL = 60 * 60 * 1000;
const LIVE_CACHE_TTL = 12 * 1000;
const RECENT_FORM_SAMPLE = 12;
const MIN_COMPETITION_SAMPLE = 5;

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

async function fetchFootball(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) { logger.warn("API_FOOTBALL_KEY not set"); return null; }
  const url = `${API_FOOTBALL_BASE}${path}`;
  await waitForRateLimit();
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
  data_source?: "competition" | "recent_all_comp" | "blended";
  competition_matches_played?: number;
  recent_matches_used?: number;
  venue_matches_used?: number;
  domestic_strength_index?: number | null;
  data_quality_score?: number;
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

type ApiRecentFixture = {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string };
  };
  league?: {
    id?: number;
    name?: string;
    country?: string;
  };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
  goals?: {
    home?: number | null;
    away?: number | null;
  };
};

type ApiRecentFixturesResp = { response?: ApiRecentFixture[] };

type PreferredVenue = "home" | "away";

function emptyTeamStats(id: number, name: string): TeamStats {
  return {
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
    data_source: "competition",
    competition_matches_played: 0,
    recent_matches_used: 0,
    venue_matches_used: 0,
    domestic_strength_index: null,
    data_quality_score: 40,
  };
}

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
    data_source: "competition",
    competition_matches_played: played,
    recent_matches_used: 0,
    venue_matches_used: 0,
  };
  setCache(key, stats);
  return stats;
}

function isUsableHistoryFixture(fixture: ApiRecentFixture, teamId: number): boolean {
  const status = fixture.fixture?.status?.short ?? "";
  if (!new Set(["FT", "AET", "PEN"]).has(status)) return false;

  const leagueName = (fixture.league?.name ?? "").toLowerCase();
  if (
    leagueName.includes("friendly") ||
    leagueName.includes("u21") || leagueName.includes("u20") ||
    leagueName.includes("u19") || leagueName.includes("u18") ||
    leagueName.includes("youth") || leagueName.includes("reserve") ||
    leagueName.includes("women")
  ) return false;

  const homeId = Number(fixture.teams?.home?.id ?? 0);
  const awayId = Number(fixture.teams?.away?.id ?? 0);
  if (homeId !== teamId && awayId !== teamId) return false;

  return Number.isFinite(Number(fixture.goals?.home)) && Number.isFinite(Number(fixture.goals?.away));
}

async function fetchRecentFixtures(teamId: number): Promise<ApiRecentFixture[]> {
  const key = `recentfixtures:${teamId}`;
  const cached = getCached<ApiRecentFixture[]>(key, RECENT_FIXTURE_CACHE_TTL);
  if (cached) return cached;

  const data = (await fetchFootball(
    `/fixtures?team=${teamId}&last=${RECENT_FORM_SAMPLE}`
  )) as ApiRecentFixturesResp | null;

  const fixtures = Array.isArray(data?.response)
    ? data.response
        .filter((fixture) => isUsableHistoryFixture(fixture, teamId))
        .sort((a, b) => Date.parse(a.fixture?.date ?? "") - Date.parse(b.fixture?.date ?? ""))
        .slice(-RECENT_FORM_SAMPLE)
    : [];

  setCache(key, fixtures);
  return fixtures;
}

async function fetchRecentTeamStats(
  teamId: number,
  teamName: string,
  preferredVenue: PreferredVenue,
): Promise<TeamStats | null> {
  const fixtures = await fetchRecentFixtures(teamId);
  if (fixtures.length === 0) return null;

  let wins = 0, draws = 0, losses = 0, cleanSheets = 0;
  let venueMatches = 0;
  let weightedGoalsFor = 0, weightedGoalsAgainst = 0, totalWeight = 0;
  let weightedDomesticStrength = 0, domesticStrengthWeight = 0;
  const outcomes: string[] = [];

  fixtures.forEach((fixture, index) => {
    const homeId = Number(fixture.teams?.home?.id ?? 0);
    const awayId = Number(fixture.teams?.away?.id ?? 0);
    const homeGoals = Number(fixture.goals?.home ?? 0);
    const awayGoals = Number(fixture.goals?.away ?? 0);
    const teamWasHome = homeId === teamId;
    const goalsFor = teamWasHome ? homeGoals : awayGoals;
    const goalsAgainst = teamWasHome ? awayGoals : homeGoals;

    const outcome = goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D";
    outcomes.push(outcome);
    if (outcome === "W") wins++;
    else if (outcome === "D") draws++;
    else losses++;
    if (goalsAgainst === 0) cleanSheets++;

    const preferred = preferredVenue === "home" ? teamWasHome : awayId === teamId;
    if (preferred) venueMatches++;

    const ageRank = fixtures.length - 1 - index;
    const recencyWeight = Math.pow(0.88, ageRank);
    const venueWeight = preferred ? 1.25 : 0.90;
    const weight = recencyWeight * venueWeight;
    weightedGoalsFor += goalsFor * weight;
    weightedGoalsAgainst += goalsAgainst * weight;
    totalWeight += weight;

    const leagueStrength = getDomesticLeagueStrength(Number(fixture.league?.id ?? 0));
    if (leagueStrength != null) {
      weightedDomesticStrength += leagueStrength * recencyWeight;
      domesticStrengthWeight += recencyWeight;
    }
  });

  if (totalWeight <= 0) return null;

  return {
    ...emptyTeamStats(teamId, teamName),
    form: outcomes.slice(-5).join(""),
    goals_per_game: Math.round((weightedGoalsFor / totalWeight) * 100) / 100,
    conceded_per_game: Math.round((weightedGoalsAgainst / totalWeight) * 100) / 100,
    clean_sheets: cleanSheets,
    matches_played: fixtures.length,
    wins,
    draws,
    losses,
    data_source: "recent_all_comp",
    competition_matches_played: 0,
    recent_matches_used: fixtures.length,
    venue_matches_used: venueMatches,
    domestic_strength_index: domesticStrengthWeight > 0
      ? Math.round((weightedDomesticStrength / domesticStrengthWeight) * 1000) / 1000
      : null,
    data_quality_score: Math.min(78, Math.round((60 + Math.min(4, fixtures.length * 0.35) + Math.min(4, venueMatches * 0.8)) * 100) / 100),
  };
}

function blendSparseCompetitionStats(
  competition: TeamStats | null,
  recent: TeamStats | null,
  teamId: number,
  teamName: string,
): TeamStats {
  if ((!competition || competition.matches_played === 0) && recent) {
    return {
      ...recent,
      team_id: teamId,
      team: teamName,
      data_source: "recent_all_comp",
      competition_matches_played: competition?.matches_played ?? 0,
    };
  }

  if (!competition) return recent ?? emptyTeamStats(teamId, teamName);

  if (competition.matches_played >= MIN_COMPETITION_SAMPLE || !recent) {
    return {
      ...competition,
      team_id: teamId,
      team: teamName,
      data_source: "competition",
      competition_matches_played: competition.matches_played,
      recent_matches_used: recent?.matches_played ?? 0,
      venue_matches_used: recent?.venue_matches_used ?? 0,
      domestic_strength_index: recent?.domestic_strength_index ?? null,
      data_quality_score: Math.min(100, Math.round((88 + Math.min(6, competition.matches_played * 1.2) + Math.min(4, (recent?.venue_matches_used ?? 0) * 0.8)) * 100) / 100),
    };
  }

  const competitionWeight = Math.min(0.80, competition.matches_played / MIN_COMPETITION_SAMPLE);
  const recentWeight = 1 - competitionWeight;

  return {
    ...recent,
    team_id: teamId,
    team: teamName,
    form: recent.form || competition.form,
    goals_per_game: Math.round((
      competition.goals_per_game * competitionWeight +
      recent.goals_per_game * recentWeight
    ) * 100) / 100,
    conceded_per_game: Math.round((
      competition.conceded_per_game * competitionWeight +
      recent.conceded_per_game * recentWeight
    ) * 100) / 100,
    clean_sheets: Math.round(
      competition.clean_sheets * competitionWeight + recent.clean_sheets * recentWeight
    ),
    data_source: "blended",
    competition_matches_played: competition.matches_played,
    recent_matches_used: recent.matches_played,
    venue_matches_used: recent.venue_matches_used ?? 0,
    domestic_strength_index: recent.domestic_strength_index ?? null,
    data_quality_score: Math.min(91, Math.round((75 + Math.min(6, competition.matches_played * 1.2) + Math.min(4, recent.matches_played * 0.35) + Math.min(4, (recent.venue_matches_used ?? 0) * 0.8)) * 100) / 100),
  };
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

export async function getMatchStats(
  fixtureId: number,
  homeTeamId: number,
  homeTeamName: string,
  awayTeamId: number,
  awayTeamName: string,
  leagueId: number,
  isLiveOrFinished: boolean
): Promise<MatchStatsResult> {
  const [homeCompetition, awayCompetition] = await Promise.all([
    fetchTeamStats(homeTeamId, leagueId),
    fetchTeamStats(awayTeamId, leagueId),
  ]);

  const [homeRecent, awayRecent] = await Promise.all([
    !homeCompetition || homeCompetition.matches_played < MIN_COMPETITION_SAMPLE
      ? fetchRecentTeamStats(homeTeamId, homeTeamName, "home")
      : Promise.resolve(null),
    !awayCompetition || awayCompetition.matches_played < MIN_COMPETITION_SAMPLE
      ? fetchRecentTeamStats(awayTeamId, awayTeamName, "away")
      : Promise.resolve(null),
  ]);

  const liveStats = isLiveOrFinished
    ? await fetchLiveFixtureStats(fixtureId, homeTeamId, awayTeamId)
    : null;

  const homeBase = blendSparseCompetitionStats(
    homeCompetition, homeRecent, homeTeamId, homeTeamName
  );
  const awayBase = blendSparseCompetitionStats(
    awayCompetition, awayRecent, awayTeamId, awayTeamName
  );

  const home: TeamStats = {
    ...homeBase,
    team: homeTeamName,
    ...(liveStats?.home ?? {}),
  };
  const away: TeamStats = {
    ...awayBase,
    team: awayTeamName,
    ...(liveStats?.away ?? {}),
  };

  if (
    home.data_source !== "competition" || away.data_source !== "competition"
  ) {
    logger.info({
      fixtureId,
      leagueId,
      homeTeamId,
      awayTeamId,
      homeSource: home.data_source,
      awaySource: away.data_source,
      homeCompetitionMatches: home.competition_matches_played,
      awayCompetitionMatches: away.competition_matches_played,
      homeRecentMatches: home.recent_matches_used,
      awayRecentMatches: away.recent_matches_used,
      homeVenueMatches: home.venue_matches_used,
      awayVenueMatches: away.venue_matches_used,
    }, "stats: sparse competition history fallback applied");
  }

  return {
    home,
    away,
    season: SEASON,
    has_live_stats: liveStats !== null,
  };
}
