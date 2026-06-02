import { waitForRateLimit } from "./rateLimiter";
import { logger } from "./logger";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const SEASON = parseInt(process.env.FOOTBALL_SEASON ?? "2025", 10);

const LINEUP_TTL          = 30 * 60 * 1000;
const INJURIES_TTL        = 30 * 60 * 1000;
const H2H_TTL             = 60 * 60 * 1000;
const SQUAD_TTL           = 6  * 60 * 60 * 1000;
const EVENTS_LIVE_TTL     =  2 * 60 * 1000;
const EVENTS_FINISHED_TTL = 60 * 60 * 1000;

interface CacheEntry<T> { data: T; fetchedAt: number }
const cache = new Map<string, CacheEntry<unknown>>();
function getCached<T>(key: string, ttl: number): T | null {
  const e = cache.get(key) as CacheEntry<T> | undefined;
  if (!e || Date.now() - e.fetchedAt > ttl) return null;
  return e.data;
}
function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}
async function apiFetch(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) return null;
  const url = `${API_FOOTBALL_BASE}${path}`;
  try {
    const res = await fetch(url, { headers: { "x-apisports-key": API_FOOTBALL_KEY } });
    if (!res.ok) { logger.warn({ status: res.status, url }, "enhanced: api-football failed"); return null; }
    const json = await res.json() as { response?: unknown };
    return json.response ?? null;
  } catch (err) {
    logger.warn({ err, url }, "enhanced: fetch error");
    return null;
  }
}

const LEAGUE_HOME_ADV: Record<number, number> = {
  39:  1.07,
  140: 1.08,
  135: 1.09,
  78:  1.06,
  61:  1.07,
  2:   1.06,
  3:   1.05,
  848: 1.05,
  94:  1.08,
  88:  1.07,
  203: 1.09,
};
function getHomeAdvantage(leagueId: number): number {
  return LEAGUE_HOME_ADV[leagueId] ?? 1.08;
}

export interface H2HRecord {
  matches: number;
  home_wins: number;
  draws: number;
  away_wins: number;
  home_win_rate: number;
  draw_rate: number;
  away_win_rate: number;
}
export interface LineupPlayer {
  id: number;
  name: string;
  number: number;
  position: string;
  goals_per_game: number;
  assists_per_game: number;
}
export interface LineupInfo {
  home: LineupPlayer[];
  away: LineupPlayer[];
  confirmed: boolean;
}
export interface AbsentPlayer {
  name: string;
  team_id: number;
  type: "Injury" | "Suspension" | string;
  reason: string;
}
export interface CorrectScoreProbability {
  score: string;
  probability: number;
}
export interface LiveMomentum {
  home_pressure: number;
  away_pressure: number;
  dominant_team: "home" | "away" | "balanced";
  pressure_alert: string | null;
  next_goal_home: number;
  next_goal_away: number;
  home_attacking_index?: number;
  away_attacking_index?: number;
  home_danger_score?: number;
  away_danger_score?: number;
  home_momentum_pct?: number;
  away_momentum_pct?: number;
  momentum_gap?: number;
  momentum_label?: "Home on top" | "Away on top" | "Balanced";
  data_quality?: "basic" | "enhanced";
}

export interface LiveTeamStatsInput {
  possession?: string | null;
  shots_total?: number | null;
  shots_on_target?: number | null;
  corners?: number | null;
  fouls?: number | null;
  offsides?: number | null;
  yellow_cards?: number | null;
  red_cards?: number | null;
  goalkeeper_saves?: number | null;
  shots_off_target?: number | null;
  blocked_shots?: number | null;
  shots_inside_box?: number | null;
  shots_outside_box?: number | null;
  total_passes?: number | null;
  accurate_passes?: number | null;
  pass_accuracy?: string | null;
  expected_goals_live?: number | null;
  dangerous_attacks?: number | null;
}

export interface LiveMatchStatsInput {
  home?: LiveTeamStatsInput;
  away?: LiveTeamStatsInput;
}

export interface SubstitutionImpact {
  minute: number;
  team: "home" | "away";
  team_name: string;
  player_out: string;
  player_in: string;
  player_out_rate: number;
  player_in_rate: number;
  xg_delta: number;
  rating: "positive" | "neutral" | "negative";
}
export interface PlayerSpotlight {
  name: string;
  total: number;
  per_game: number;
  prob: number;
}
export interface TeamSpotlights {
  top_scorer: PlayerSpotlight;
  top_assister: PlayerSpotlight;
  top_fouler: PlayerSpotlight;
}
export interface EnhancedPrediction {
  home_win: number;
  draw: number;
  away_win: number;
  home_xg: number;
  away_xg: number;
  over_15: number;
  over_25: number;
  over_35: number;
  btts: number;
  correct_scores: CorrectScoreProbability[];
  fair_home_odds: number;
  fair_draw_odds: number;
  fair_away_odds: number;
  confidence: "Low" | "Medium" | "High";
  confidence_score: number;
  reasons: string[];
  live_momentum?: LiveMomentum;
  base_home_win: number;
  base_draw: number;
  base_away_win: number;
  h2h?: H2HRecord;
  home_injuries: AbsentPlayer[];
  away_injuries: AbsentPlayer[];
  lineup?: LineupInfo;
  home_lineup_factor: number;
  away_lineup_factor: number;
  home_injury_factor: number;
  away_injury_factor: number;
  home_form_factor: number;
  away_form_factor: number;
  home_advantage: number;
  live_score_home?: number;
  live_score_away?: number;
  live_adjusted_home_win?: number;
  live_adjusted_draw?: number;
  live_adjusted_away_win?: number;
  substitution_impacts?: SubstitutionImpact[];
  home_sub_xg_delta?: number;
  away_sub_xg_delta?: number;
  sub_adjusted_home_win?: number;
  sub_adjusted_draw?: number;
  sub_adjusted_away_win?: number;
  home_spotlights?: TeamSpotlights;
  away_spotlights?: TeamSpotlights;
}

type ApiPlayer = {
  player: { id: number; name: string };
  statistics: Array<{
    games: { appearences: number | null; position: string | null };
    goals: { total: number | null; assists: number | null };
    fouls: { committed: number | null; drawn: number | null } | null;
  }>;
};
export interface SquadPlayerStats {
  id: number;
  name: string;
  position: string;
  appearances: number;
  goals: number;
  assists: number;
  fouls_committed: number;
  goals_per_game: number;
  assists_per_game: number;
  fouls_per_game: number;
}

async function fetchSquadStats(teamId: number, leagueId: number): Promise<Map<number, SquadPlayerStats>> {
  const key = `squadstats:${teamId}:${leagueId}`;
  const cached = getCached<Map<number, SquadPlayerStats>>(key, SQUAD_TTL);
  if (cached) return cached;
  const data = await apiFetch(
    `/players?team=${teamId}&league=${leagueId}&season=${SEASON}&page=1`
  ) as ApiPlayer[] | null;
  const map = new Map<number, SquadPlayerStats>();
  if (!Array.isArray(data)) { setCache(key, map); return map; }
  for (const entry of data) {
    const stat = entry.statistics[0];
    if (!stat) continue;
    const apps    = stat.games.appearences ?? 0;
    const goals   = stat.goals.total ?? 0;
    const assists = stat.goals.assists ?? 0;
    const fouls   = stat.fouls?.committed ?? 0;
    const pos     = stat.games.position ?? "M";
    map.set(entry.player.id, {
      id: entry.player.id,
      name: entry.player.name,
      position: pos,
      appearances: apps,
      goals,
      assists,
      fouls_committed: fouls,
      goals_per_game:   apps > 0 ? goals   / apps : 0,
      assists_per_game: apps > 0 ? assists / apps : 0,
      fouls_per_game:   apps > 0 ? fouls   / apps : 0,
    });
  }
  setCache(key, map);
  return map;
}

function buildNameLookup(squad: Map<number, SquadPlayerStats>): Map<string, SquadPlayerStats> {
  const m = new Map<string, SquadPlayerStats>();
  for (const s of squad.values()) {
    m.set(s.name.toLowerCase(), s);
    const parts = s.name.split(" ");
    if (parts.length > 1) m.set(parts[parts.length - 1].toLowerCase(), s);
  }
  return m;
}
function lookupByName(name: string, lookup: Map<string, SquadPlayerStats>): SquadPlayerStats | undefined {
  const lower = name.toLowerCase();
  if (lookup.has(lower)) return lookup.get(lower);
  for (const [key, val] of lookup) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return undefined;
}

function poissonAtLeastOne(lambda: number): number {
  if (lambda <= 0) return 0;
  return (1 - Math.exp(-lambda)) * 100;
}
function buildSpotlights(squad: Map<number, SquadPlayerStats>): TeamSpotlights | undefined {
  const players = Array.from(squad.values()).filter((p) => p.appearances >= 3);
  if (players.length === 0) return undefined;
  const topScorer   = players.reduce((a, b) => b.goals           > a.goals           ? b : a);
  const topAssister = players.reduce((a, b) => b.assists         > a.assists         ? b : a);
  const topFouler   = players.reduce((a, b) => b.fouls_committed > a.fouls_committed ? b : a);
  return {
    top_scorer:   { name: topScorer.name,   total: topScorer.goals,           per_game: round2(topScorer.goals_per_game),    prob: round2(poissonAtLeastOne(topScorer.goals_per_game)) },
    top_assister: { name: topAssister.name, total: topAssister.assists,       per_game: round2(topAssister.assists_per_game),prob: round2(poissonAtLeastOne(topAssister.assists_per_game)) },
    top_fouler:   { name: topFouler.name,   total: topFouler.fouls_committed, per_game: round2(topFouler.fouls_per_game),    prob: round2(poissonAtLeastOne(topFouler.fouls_per_game)) },
  };
}

type ApiEvent = {
  time: { elapsed: number; extra: number | null };
  team: { id: number; name: string };
  player: { id: number; name: string };
  assist: { id: number | null; name: string | null };
  type: string;
  detail: string;
};
async function fetchMatchEvents(fixtureId: number, isLive: boolean): Promise<ApiEvent[]> {
  const ttl = isLive ? EVENTS_LIVE_TTL : EVENTS_FINISHED_TTL;
  const key = `events:${fixtureId}`;
  const cached = getCached<ApiEvent[]>(key, ttl);
  if (cached) return cached;
  const data = await apiFetch(`/fixtures/events?fixture=${fixtureId}`) as ApiEvent[] | null;
  const result = Array.isArray(data) ? data : [];
  setCache(key, result);
  return result;
}

function computeSubstitutionImpacts(
  events: ApiEvent[],
  homeTeamId: number, awayTeamId: number,
  homeTeamName: string, awayTeamName: string,
  homeSquad: Map<number, SquadPlayerStats>,
  awaySquad: Map<number, SquadPlayerStats>,
  matchMinute: number
): SubstitutionImpact[] {
  const homeLookup = buildNameLookup(homeSquad);
  const awayLookup = buildNameLookup(awaySquad);
  const subs = events.filter((e) => e.type === "subst");
  const impacts: SubstitutionImpact[] = [];
  for (const sub of subs) {
    const isHome = sub.team.id === homeTeamId;
    const isAway = sub.team.id === awayTeamId;
    if (!isHome && !isAway) continue;
    const playerIn  = sub.player.name ?? "";
    const playerOut = sub.assist.name ?? "";
    const minute    = sub.time.elapsed;
    const lookup    = isHome ? homeLookup : awayLookup;
    const statsIn   = lookupByName(playerIn, lookup);
    const statsOut  = lookupByName(playerOut, lookup);
    const rateIn  = statsIn  ? statsIn.goals_per_game  + 0.5 * statsIn.assists_per_game  : 0;
    const rateOut = statsOut ? statsOut.goals_per_game + 0.5 * statsOut.assists_per_game : 0;
    const remainingFraction = Math.max(0, (90 - minute) / 90);
    const xgDelta = round2((rateIn - rateOut) * remainingFraction);
    const rating: SubstitutionImpact["rating"] =
      xgDelta > 0.01 ? "positive" : xgDelta < -0.01 ? "negative" : "neutral";
    impacts.push({
      minute,
      team: isHome ? "home" : "away",
      team_name: isHome ? homeTeamName : awayTeamName,
      player_out: playerOut || "—",
      player_in:  playerIn  || "—",
      player_out_rate: round2(rateOut),
      player_in_rate:  round2(rateIn),
      xg_delta: xgDelta,
      rating,
    });
  }
  impacts.sort((a, b) => a.minute - b.minute);
  return impacts;
}

type ApiLineupEntry = {
  team: { id: number };
  startXI: Array<{ player: { id: number; name: string; number: number; pos: string } }>;
};

// ── FIXED: sequential fetching instead of Promise.all ────────────────────────
async function fetchLineup(
  fixtureId: number,
  homeTeamId: number, awayTeamId: number,
  leagueId: number
): Promise<LineupInfo
  const awaySquadMap = await fetchSquadStats(awayTeamId, leagueId).catch(() => new Map<number, SquadPlayerStats>());

  const homeInjuries = allInjuries.filter((i) => i.team_id === homeTeamId);
  const awayInjuries = allInjuries.filter((i) => i.team_id === awayTeamId);

  const homeInjuryFactor = injuryFactor(homeInjuries, homeSquadMap, homeGpg);
  const awayInjuryFactor = injuryFactor(awayInjuries, awaySquadMap, awayGpg);

  let homeLineupFactor = 1.0;
  let awayLineupFactor = 1.0;
  if (lineupResult) {
    homeLineupFactor = lineupQualityFactor(lineupResult.home, homeSquadMap);
    awayLineupFactor = lineupQualityFactor(lineupResult.away, awaySquadMap);
  }

  const adjHomeXG = baseHomeXG * homeFormFactor * homeLineupFactor * homeInjuryFactor;
  const adjAwayXG = baseAwayXG * awayFormFactor * awayLineupFactor * awayInjuryFactor;
  const adjusted = poissonProbs(adjHomeXG, adjAwayXG);

  let finalHome = adjusted.homeWin;
  let finalDraw = adjusted.draw;
  let finalAway = adjusted.awayWin;
  if (h2hResult && h2hResult.matches > 0) {
    const blended = blendH2H(adjusted.homeWin, adjusted.draw, adjusted.awayWin, h2hResult);
    finalHome = blended.home;
    finalDraw = blended.draw;
    finalAway = blended.away;
  }

  const markets = extendedPoissonMarkets(adjHomeXG, adjAwayXG);
  const confidence = confidenceFromModel(
    finalHome, finalDraw, finalAway,
    (lineupResult ? 3 : 0) + homeInjuries.length + awayInjuries.length + (h2hResult?.matches ?? 0)
  );
  const reasons = buildReasons({
    homeFormFactor, awayFormFactor, homeInjuryFactor, awayInjuryFactor,
    homeLineupFactor, awayLineupFactor, homeXG: adjHomeXG, awayXG: adjAwayXG,
    h2h: h2hResult, homeName: homeTeamName, awayName: awayTeamName
  });
  const liveMomentum = isLive
    ? liveMomentumFromEvents(eventsList, homeTeamId, awayTeamId, matchMinute, adjHomeXG, adjAwayXG, liveStats)
    : undefined;

  let liveAdjHomeWin: number | undefined;
  let liveAdjDraw: number | undefined;
  let liveAdjAwayWin: number | undefined;
  const hasScore = liveScoreHome != null && liveScoreAway != null && matchMinute != null;
  if (isLive && hasScore) {
    const liveProbs = liveScoreAdjustedProbs(
      liveScoreHome!, liveScoreAway!, matchMinute!,
      adjHomeXG, adjAwayXG
    );
    liveAdjHomeWin = round2(liveProbs.homeWin);
    liveAdjDraw    = round2(liveProbs.draw);
    liveAdjAwayWin = round2(liveProbs.awayWin);
  }

  let substitutionImpacts: SubstitutionImpact[] | undefined;
  let homeSubXgDelta: number | undefined;
  let awaySubXgDelta: number | undefined;
  let subAdjHomeWin: number | undefined;
  let subAdjDraw: number | undefined;
  let subAdjAwayWin: number | undefined;

  if (eventsList.length > 0) {
    const currentMinute = matchMinute ?? 90;
    substitutionImpacts = computeSubstitutionImpacts(
      eventsList,
      homeTeamId, awayTeamId,
      homeTeamName, awayTeamName,
      homeSquadMap, awaySquadMap,
      currentMinute
    );
    if (substitutionImpacts.length > 0) {
      homeSubXgDelta = round2(substitutionImpacts.filter((s) => s.team === "home").reduce((sum, s) => sum + s.xg_delta, 0));
      awaySubXgDelta = round2(substitutionImpacts.filter((s) => s.team === "away").reduce((sum, s) => sum + s.xg_delta, 0));
      const subHomeXG = Math.max(0.01, adjHomeXG + (homeSubXgDelta ?? 0));
      const subAwayXG = Math.max(0.01, adjAwayXG + (awaySubXgDelta ?? 0));
      const subProbs = poissonProbs(subHomeXG, subAwayXG);
      if (h2hResult && h2hResult.matches > 0) {
        const reBlended = blendH2H(subProbs.homeWin, subProbs.draw, subProbs.awayWin, h2hResult);
        subAdjHomeWin = round2(reBlended.home);
        subAdjDraw    = round2(reBlended.draw);
        subAdjAwayWin = round2(reBlended.away);
      } else {
        subAdjHomeWin = round2(subProbs.homeWin);
        subAdjDraw    = round2(subProbs.draw);
        subAdjAwayWin = round2(subProbs.awayWin);
      }
    }
  }

  const homeSpotlights = buildSpotlights(homeSquadMap);
  const awaySpotlights = buildSpotlights(awaySquadMap);

  return {
    home_win:       round2(finalHome),
    draw:           round2(finalDraw),
    away_win:       round2(finalAway),
    home_xg:        round2(adjHomeXG),
    away_xg:        round2(adjAwayXG),
    over_15:        markets.over15,
    over_25:        markets.over25,
    over_35:        markets.over35,
    btts:           markets.btts,
    correct_scores: markets.correctScores,
    fair_home_odds: fairOdds(finalHome),
    fair_draw_odds: fairOdds(finalDraw),
    fair_away_odds: fairOdds(finalAway),
    confidence:     confidence.label,
    confidence_score: confidence.score,
    reasons,
    live_momentum:  liveMomentum,
    base_home_win:  round2(base.homeWin),
    base_draw:      round2(base.draw),
    base_away_win:  round2(base.awayWin),
    h2h:            h2hResult ?? undefined,
    home_injuries:  homeInjuries,
    away_injuries:  awayInjuries,
    lineup:         lineupResult ?? undefined,
    home_lineup_factor:  round2(homeLineupFactor),
    away_lineup_factor:  round2(awayLineupFactor),
    home_injury_factor:  round2(homeInjuryFactor),
    away_injury_factor:  round2(awayInjuryFactor),
    home_form_factor:    round2(homeFormFactor),
    away_form_factor:    round2(awayFormFactor),
    home_advantage:      round2(homeAdv),
    live_score_home:     liveScoreHome  ?? undefined,
    live_score_away:     liveScoreAway  ?? undefined,
    live_adjusted_home_win: liveAdjHomeWin,
    live_adjusted_draw:     liveAdjDraw,
    live_adjusted_away_win: liveAdjAwayWin,
    substitution_impacts: substitutionImpacts,
    home_sub_xg_delta:    homeSubXgDelta,
    away_sub_xg_delta:    awaySubXgDelta,
    sub_adjusted_home_win: subAdjHomeWin,
    sub_adjusted_draw:     subAdjDraw,
    sub_adjusted_away_win: subAdjAwayWin,
    home_spotlights: homeSpotlights,
    away_spotlights: awaySpotlights,
  };
}
