import { logger } from "./logger";
import { waitForRateLimit } from "./rateLimiter";
import { blendCrossLeaguePrior, type TeamStrengthProfile } from "./crossLeagueStrength";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const SEASON = parseInt(process.env.FOOTBALL_SEASON ?? "2025", 10);

const LINEUP_TTL         = 30 * 60 * 1000;
const INJURIES_TTL       = 30 * 60 * 1000;
const H2H_TTL            = 60 * 60 * 1000;
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
  await waitForRateLimit();
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
  39: 1.07, 140: 1.08, 135: 1.09, 78: 1.06, 61: 1.07,
  2: 1.06, 3: 1.05, 848: 1.05, 94: 1.08, 88: 1.07, 203: 1.09,
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
  data_source?: "competition" | "recent_all_comp" | "blended";
  matches_played?: number;
  competition_matches_played?: number;
  recent_matches_used?: number;
  venue_matches_used?: number;
  opposition_strength_factor?: number;
  strength_profile?: TeamStrengthProfile;
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
  data_quality_prior_weight?: number;
  cross_league_prior_weight?: number;
  strength_rating_gap?: number;
  strength_model_version?: string;
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
  const data = await apiFetch(`/players?team=${teamId}&league=${leagueId}&season=${SEASON}&page=1`) as ApiPlayer[] | null;
  const map = new Map<number, SquadPlayerStats>();
  if (!Array.isArray(data)) { setCache(key, map); return map; }
  for (const entry of data) {
    const stat = entry.statistics[0];
    if (!stat) continue;
    const apps = stat.games.appearences ?? 0;
    const goals = stat.goals.total ?? 0;
    const assists = stat.goals.assists ?? 0;
    const fouls = stat.fouls?.committed ?? 0;
    map.set(entry.player.id, {
      id: entry.player.id,
      name: entry.player.name,
      position: stat.games.position ?? "M",
      appearances: apps,
      goals,
      assists,
      fouls_committed: fouls,
      goals_per_game: apps > 0 ? goals / apps : 0,
      assists_per_game: apps > 0 ? assists / apps : 0,
      fouls_per_game: apps > 0 ? fouls / apps : 0,
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
  const topScorer = players.reduce((a, b) => b.goals > a.goals ? b : a);
  const topAssister = players.reduce((a, b) => b.assists > a.assists ? b : a);
  const topFouler = players.reduce((a, b) => b.fouls_committed > a.fouls_committed ? b : a);
  return {
    top_scorer: { name: topScorer.name, total: topScorer.goals, per_game: round2(topScorer.goals_per_game), prob: round2(poissonAtLeastOne(topScorer.goals_per_game)) },
    top_assister: { name: topAssister.name, total: topAssister.assists, per_game: round2(topAssister.assists_per_game), prob: round2(poissonAtLeastOne(topAssister.assists_per_game)) },
    top_fouler: { name: topFouler.name, total: topFouler.fouls_committed, per_game: round2(topFouler.fouls_per_game), prob: round2(poissonAtLeastOne(topFouler.fouls_per_game)) },
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
  const impacts: SubstitutionImpact[] = [];
  for (const sub of events.filter((e) => e.type === "subst")) {
    const isHome = sub.team.id === homeTeamId;
    const isAway = sub.team.id === awayTeamId;
    if (!isHome && !isAway) continue;
    const playerIn = sub.player.name ?? "";
    const playerOut = sub.assist.name ?? "";
    const lookup = isHome ? homeLookup : awayLookup;
    const statsIn = lookupByName(playerIn, lookup);
    const statsOut = lookupByName(playerOut, lookup);
    const rateIn = statsIn ? statsIn.goals_per_game + 0.5 * statsIn.assists_per_game : 0;
    const rateOut = statsOut ? statsOut.goals_per_game + 0.5 * statsOut.assists_per_game : 0;
    const xgDelta = round2((rateIn - rateOut) * Math.max(0, (90 - sub.time.elapsed) / 90));
    impacts.push({
      minute: sub.time.elapsed,
      team: isHome ? "home" : "away",
      team_name: isHome ? homeTeamName : awayTeamName,
      player_out: playerOut || "—",
      player_in: playerIn || "—",
      player_out_rate: round2(rateOut),
      player_in_rate: round2(rateIn),
      xg_delta: xgDelta,
      rating: xgDelta > 0.01 ? "positive" : xgDelta < -0.01 ? "negative" : "neutral",
    });
  }
  impacts.sort((a, b) => a.minute - b.minute);
  return impacts;
}

type ApiLineupEntry = {
  team: { id: number };
  startXI: Array<{ player: { id: number; name: string; number: number; pos: string } }>;
};
async function fetchLineup(fixtureId: number, homeTeamId: number, awayTeamId: number, leagueId: number): Promise<LineupInfo | null> {
  const key = `lineup:${fixtureId}`;
  const cached = getCached<LineupInfo>(key, LINEUP_TTL);
  if (cached) return cached;
  const data = await apiFetch(`/fixtures/lineups?fixture=${fixtureId}`) as ApiLineupEntry[] | null;
  if (!Array.isArray(data) || data.length < 2) return null;
  const homeSquad = await fetchSquadStats(homeTeamId, leagueId);
  const awaySquad = await fetchSquadStats(awayTeamId, leagueId);
  const toPlayers = (entry: ApiLineupEntry, squad: Map<number, SquadPlayerStats>): LineupPlayer[] =>
    entry.startXI.map(({ player: p }) => {
      const s = squad.get(p.id);
      return { id: p.id, name: p.name, number: p.number, position: p.pos, goals_per_game: s?.goals_per_game ?? 0, assists_per_game: s?.assists_per_game ?? 0 };
    });
  const homeEntry = data.find((e) => e.team.id === homeTeamId);
  const awayEntry = data.find((e) => e.team.id === awayTeamId);
  if (!homeEntry || !awayEntry) return null;
  const info = { home: toPlayers(homeEntry, homeSquad), away: toPlayers(awayEntry, awaySquad), confirmed: true };
  setCache(key, info);
  return info;
}

type ApiFixture = { fixture: { id: number }; teams: { home: { id: number; winner: boolean | null }; away: { id: number; winner: boolean | null } } };
async function fetchH2H(homeTeamId: number, awayTeamId: number): Promise<H2HRecord | null> {
  const key = `h2h:${homeTeamId}:${awayTeamId}`;
  const cached = getCached<H2HRecord>(key, H2H_TTL);
  if (cached) return cached;
  const data = await apiFetch(`/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}&last=10`) as ApiFixture[] | null;
  if (!Array.isArray(data) || data.length === 0) return null;
  let homeWins = 0, draws = 0, awayWins = 0;
  for (const f of data) {
    const he = f.teams.home, ae = f.teams.away;
    if (he.id === homeTeamId) {
      if (he.winner === true) homeWins++; else if (ae.winner === true) awayWins++; else draws++;
    } else {
      if (ae.winner === true) homeWins++; else if (he.winner === true) awayWins++; else draws++;
    }
  }
  const total = data.length;
  const record = { matches: total, home_wins: homeWins, draws, away_wins: awayWins, home_win_rate: homeWins / total, draw_rate: draws / total, away_win_rate: awayWins / total };
  setCache(key, record);
  return record;
}

type ApiInjury = { player: { id: number; name: string }; team: { id: number }; fixture: { id: number }; injury: { type: string; reason: string } };
async function fetchInjuries(fixtureId: number, homeTeamId: number, awayTeamId: number): Promise<AbsentPlayer[]> {
  const key = `injuries:${fixtureId}`;
  const cached = getCached<AbsentPlayer[]>(key, INJURIES_TTL);
  if (cached) return cached;
  const data = await apiFetch(`/injuries?fixture=${fixtureId}`) as ApiInjury[] | null;
  if (!Array.isArray(data)) { setCache(key, []); return []; }
  const relevant = new Set([homeTeamId, awayTeamId]);
  const result = data.filter((i) => relevant.has(i.team.id)).map((i) => ({ name: i.player.name, team_id: i.team.id, type: i.injury.type, reason: i.injury.reason }));
  setCache(key, result);
  return result;
}

function formFactor(form: string): number {
  if (!form) return 1;
  const recent = form.slice(-5).split("").reverse();
  const weights = [1, 0.8, 0.64, 0.51, 0.41];
  let score = 0, total = 0;
  recent.forEach((r, i) => {
    const w = weights[i] ?? 0.41;
    score += w * (r === "W" ? 1 : r === "D" ? 0.4 : 0);
    total += w;
  });
  return 0.88 + (total > 0 ? score / total : 0.5) * 0.24;
}
function injuryFactor(absences: AbsentPlayer[], squad: Map<number, SquadPlayerStats>, teamGpg: number): number {
  if (absences.length === 0) return 1;
  const lookup = buildNameLookup(squad);
  const players = Array.from(squad.values()).filter((p) => p.appearances >= 3);
  const avg = players.length ? players.reduce((s, p) => s + p.goals_per_game + 0.5 * p.assists_per_game, 0) / players.length : teamGpg / 11;
  let impact = 0;
  for (const absent of absences) {
    const p = lookupByName(absent.name, lookup);
    impact += p && p.appearances >= 3 ? Math.min(0.18, ((p.goals_per_game + 0.5 * p.assists_per_game) / Math.max(avg, 0.01)) * 0.06) : 0.06;
  }
  return Math.max(0.70, 1 - impact);
}
export function lineupQualityFactor(starters: LineupPlayer[], squad: Map<number, SquadPlayerStats>): number {
  const players = Array.from(squad.values()).filter((p) => p.appearances >= 3);
  if (players.length < 3) return 1;
  const squadAvg = players.reduce((s, p) => s + p.goals_per_game + 0.4 * p.assists_per_game, 0) / players.length;
  if (squadAvg <= 0) return 1;
  const starterPlayers = starters.map((s) => squad.get(s.id)).filter(Boolean) as SquadPlayerStats[];
  if (starterPlayers.length < 3) return 1;
  const starterAvg = starterPlayers.reduce((s, p) => s + p.goals_per_game + 0.4 * p.assists_per_game, 0) / starterPlayers.length;
  // This is a within-team signal, not an absolute comparison between clubs.
  // Keep it a modest availability adjustment so a strong lineup for a weaker
  // club cannot masquerade as superior squad quality.
  return Math.min(1.06, Math.max(0.94, starterAvg / squadAvg));
}

export function applyDataQualityPrior(
  probs: { home: number; draw: number; away: number },
  home?: LiveTeamStatsInput,
  away?: LiveTeamStatsInput,
) {
  const quality = (s?: LiveTeamStatsInput) => {
    const sample = Math.max(0, Number(s?.matches_played ?? s?.recent_matches_used ?? 0));
    const sourceWeight = s?.data_source === "competition" ? 0.90 : s?.data_source === "blended" ? 0.78 : 0.65;
    return Math.min(sourceWeight, sourceWeight * Math.min(1, sample / 12));
  };
  const hq = quality(home), aq = quality(away);
  const sourceMismatch = Boolean(home?.data_source && away?.data_source && home.data_source !== away.data_source);
  const venueWeak = [home, away].some((s) => s?.data_source === "recent_all_comp" && Number(s.venue_matches_used ?? 0) < 3);
  const priorWeight = Math.min(0.35,
    (sourceMismatch ? 0.12 : 0) + (venueWeak ? 0.08 : 0) + (1 - Math.min(hq, aq)) * 0.20,
  );
  if (priorWeight <= 0.001) return { ...probs, priorWeight: 0 };
  const prior = { home: 45, draw: 27, away: 28 };
  const homeP = probs.home * (1 - priorWeight) + prior.home * priorWeight;
  const drawP = probs.draw * (1 - priorWeight) + prior.draw * priorWeight;
  const awayP = probs.away * (1 - priorWeight) + prior.away * priorWeight;
  const total = homeP + drawP + awayP;
  return { home: homeP / total * 100, draw: drawP / total * 100, away: awayP / total * 100, priorWeight };
}

const MAX_GOALS = 8;
const DC_RHO = -0.13;
function dcTau(i: number, j: number, lambda: number, mu: number): number {
  if (i === 0 && j === 0) return 1 - lambda * mu * DC_RHO;
  if (i === 0 && j === 1) return 1 + lambda * DC_RHO;
  if (i === 1 && j === 0) return 1 + mu * DC_RHO;
  if (i === 1 && j === 1) return 1 - DC_RHO;
  return 1;
}
function poisson(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}
function poissonProbs(homeXG: number, awayXG: number) {
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    const pH = poisson(homeXG, h);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = pH * poisson(awayXG, a) * dcTau(h, a, homeXG, awayXG);
      if (h > a) homeWin += joint; else if (h === a) draw += joint; else awayWin += joint;
    }
  }
  const total = homeWin + draw + awayWin;
  return { homeWin: (homeWin / total) * 100, draw: (draw / total) * 100, awayWin: (awayWin / total) * 100 };
}
function extendedPoissonMarkets(homeXG: number, awayXG: number) {
  let over15 = 0, over25 = 0, over35 = 0, btts = 0;
  const scores: CorrectScoreProbability[] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    const pH = poisson(homeXG, h);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const joint = pH * poisson(awayXG, a) * dcTau(h, a, homeXG, awayXG);
      const goals = h + a;
      if (goals > 1.5) over15 += joint;
      if (goals > 2.5) over25 += joint;
      if (goals > 3.5) over35 += joint;
      if (h > 0 && a > 0) btts += joint;
      if (h <= 5 && a <= 5) scores.push({ score: `${h}-${a}`, probability: joint * 100 });
    }
  }
  scores.sort((x, y) => y.probability - x.probability);
  return { over15: round2(over15 * 100), over25: round2(over25 * 100), over35: round2(over35 * 100), btts: round2(btts * 100), correctScores: scores.slice(0, 6).map((s) => ({ score: s.score, probability: round2(s.probability) })) };
}
function fairOdds(probPct: number): number { return probPct > 0 ? round2(100 / probPct) : 0; }
function confidenceFromModel(home: number, draw: number, away: number, dataPoints: number) {
  const sorted = [home, draw, away].sort((a, b) => b - a);
  const score = Math.max(0, Math.min(100, 35 + (sorted[0] - sorted[1]) * 1.1 + Math.min(20, dataPoints * 2)));
  return { label: (score >= 72 ? "High" : score >= 55 ? "Medium" : "Low") as "Low" | "Medium" | "High", score: round2(score) };
}
function buildReasons(opts: { homeFormFactor: number; awayFormFactor: number; homeInjuryFactor: number; awayInjuryFactor: number; homeLineupFactor: number; awayLineupFactor: number; homeXG: number; awayXG: number; h2h: H2HRecord | null; homeName: string; awayName: string }): string[] {
  const reasons: string[] = [];
  const xgDiff = opts.homeXG - opts.awayXG;
  if (Math.abs(xgDiff) >= 0.25) reasons.push(`${xgDiff > 0 ? opts.homeName || "Home" : opts.awayName || "Away"} has the stronger expected-goals profile.`);
  if (opts.homeFormFactor - opts.awayFormFactor >= 0.04) reasons.push(`${opts.homeName || "Home"} has better recent form.`);
  if (opts.awayFormFactor - opts.homeFormFactor >= 0.04) reasons.push(`${opts.awayName || "Away"} has better recent form.`);
  if (opts.homeInjuryFactor <= 0.94) reasons.push(`${opts.homeName || "Home"} is weakened by absences.`);
  if (opts.awayInjuryFactor <= 0.94) reasons.push(`${opts.awayName || "Away"} is weakened by absences.`);
  if (opts.homeLineupFactor >= 1.06) reasons.push(`${opts.homeName || "Home"} lineup rates above squad average.`);
  if (opts.awayLineupFactor >= 1.06) reasons.push(`${opts.awayName || "Away"} lineup rates above squad average.`);
  if (opts.h2h && opts.h2h.matches >= 5) reasons.push(`Head-to-head sample included from the last ${opts.h2h.matches} meetings.`);
  if (reasons.length === 0) reasons.push("No strong edge detected; probabilities are mainly season-strength based.");
  return reasons.slice(0, 5);
}
function pctToNumber(v?: string | null): number | null {
  if (!v) return null;
  const parsed = parseFloat(String(v).replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function attackingIndex(stats: LiveTeamStatsInput | undefined, fallbackXG: number): number {
  if (!stats) return Math.min(65, fallbackXG * 28);
  const possession = pctToNumber(stats.possession) ?? 50;
  const passAccuracy = pctToNumber(stats.pass_accuracy) ?? 75;
  const liveXg = stats.expected_goals_live ?? fallbackXG;
  const score = liveXg * 22 + (stats.shots_on_target ?? 0) * 9 + (stats.shots_inside_box ?? 0) * 5 + (stats.corners ?? 0) * 4 + (stats.dangerous_attacks ?? 0) * 0.55 + (stats.shots_total ?? 0) * 2 + (stats.blocked_shots ?? 0) * 1.5 + Math.max(0, possession - 45) * 0.35 + Math.max(0, passAccuracy - 75) * 0.25 - (stats.red_cards ?? 0) * 18 - (stats.yellow_cards ?? 0) * 2;
  return Math.max(0, Math.min(100, score));
}
function liveMomentumFromEvents(events: ApiEvent[], homeTeamId: number, awayTeamId: number, minute: number | null, homeXG: number, awayXG: number, liveStats?: LiveMatchStatsInput): LiveMomentum | undefined {
  if (minute == null) return undefined;
  const recent = events.filter((e) => Number(e.time.elapsed) >= Math.max(0, minute - 15) && Number(e.time.elapsed) <= minute);
  const homeIndex = attackingIndex(liveStats?.home, homeXG);
  const awayIndex = attackingIndex(liveStats?.away, awayXG);
  let homePressure = Math.min(82, homeIndex), awayPressure = Math.min(82, awayIndex);
  for (const e of recent) {
    const weight = e.type === "Goal" ? 10 : e.type === "Card" ? 5 : e.type === "subst" ? 2 : 2;
    if (e.team.id === homeTeamId) homePressure += weight;
    if (e.team.id === awayTeamId) awayPressure += weight;
  }
  homePressure = Math.max(0, Math.min(100, homePressure));
  awayPressure = Math.max(0, Math.min(100, awayPressure));
  const diff = homePressure - awayPressure;
  const dominant = Math.abs(diff) < 10 ? "balanced" : diff > 0 ? "home" : "away";
  const total = homePressure + awayPressure || 1;
  const homePct = round2((homePressure / total) * 100);
  const awayPct = round2(100 - homePct);
  return {
    home_pressure: round2(homePressure), away_pressure: round2(awayPressure), dominant_team: dominant,
    pressure_alert: Math.max(homePressure, awayPressure) >= 72 && Math.abs(diff) >= 15 ? `${dominant === "home" ? "Home" : "Away"} pressure is high from live xG/shots/corners/pass data.` : null,
    next_goal_home: homePct, next_goal_away: awayPct,
    home_attacking_index: round2(homeIndex), away_attacking_index: round2(awayIndex),
    home_danger_score: round2((liveStats?.home?.expected_goals_live ?? homeXG) * 25 + (liveStats?.home?.shots_inside_box ?? 0) * 4 + (liveStats?.home?.corners ?? 0) * 3),
    away_danger_score: round2((liveStats?.away?.expected_goals_live ?? awayXG) * 25 + (liveStats?.away?.shots_inside_box ?? 0) * 4 + (liveStats?.away?.corners ?? 0) * 3),
    home_momentum_pct: homePct, away_momentum_pct: awayPct, momentum_gap: round2(Math.abs(homePct - awayPct)),
    momentum_label: Math.abs(homePct - awayPct) < 8 ? "Balanced" : homePct > awayPct ? "Home on top" : "Away on top",
    data_quality: liveStats?.home || liveStats?.away ? "enhanced" : "basic",
  };
}
function liveScoreAdjustedProbs(hGoals: number, aGoals: number, minute: number, adjHomeXG: number, adjAwayXG: number) {
  const effectiveMax = minute >= 90 ? minute + 5 : 90;
  const remainFrac = Math.max(0, (effectiveMax - minute) / effectiveMax);
  if (remainFrac <= 0.01) return { homeWin: hGoals > aGoals ? 100 : 0, draw: hGoals === aGoals ? 100 : 0, awayWin: aGoals > hGoals ? 100 : 0 };
  const scoreDiff = hGoals - aGoals;
  const remHomeXG = Math.max(0.01, adjHomeXG * remainFrac * (scoreDiff < 0 ? 1.18 : scoreDiff > 0 ? 0.85 : 1));
  const remAwayXG = Math.max(0.01, adjAwayXG * remainFrac * (scoreDiff > 0 ? 1.18 : scoreDiff < 0 ? 0.85 : 1));
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let rh = 0; rh <= MAX_GOALS; rh++) for (let ra = 0; ra <= MAX_GOALS; ra++) {
    const joint = poisson(remHomeXG, rh) * poisson(remAwayXG, ra);
    const finalH = hGoals + rh, finalA = aGoals + ra;
    if (finalH > finalA) homeWin += joint; else if (finalH === finalA) draw += joint; else awayWin += joint;
  }
  const total = homeWin + draw + awayWin;
  return { homeWin: (homeWin / total) * 100, draw: (draw / total) * 100, awayWin: (awayWin / total) * 100 };
}
export function blendH2H(poissonHome: number, poissonDraw: number, poissonAway: number, h2h: H2HRecord) {
  // H2H is sparse and often stale. It is supporting evidence, never a primary
  // driver; twenty meetings are required to reach the 15% ceiling.
  const w = Math.min(0.15, (h2h.matches / 20) * 0.15);
  const home = (1 - w) * poissonHome + w * h2h.home_win_rate * 100;
  const draw = (1 - w) * poissonDraw + w * h2h.draw_rate * 100;
  const away = (1 - w) * poissonAway + w * h2h.away_win_rate * 100;
  const total = home + draw + away;
  return { home: (home / total) * 100, draw: (draw / total) * 100, away: (away / total) * 100 };
}
function round2(n: number) { return Math.round(n * 100) / 100; }

export async function getEnhancedPrediction(
  fixtureId: number, homeTeamId: number, awayTeamId: number, leagueId: number,
  homeGpg: number, homeCpg: number, awayGpg: number, awayCpg: number,
  homeTeamName = "", awayTeamName = "", matchMinute: number | null = null, isLive = false,
  liveScoreHome: number | null = null, liveScoreAway: number | null = null,
  homeForm = "", awayForm = "", liveStats?: LiveMatchStatsInput
): Promise<EnhancedPrediction> {
  const homeAdv = getHomeAdvantage(leagueId);
  const homeFormFactor = formFactor(homeForm);
  const awayFormFactor = formFactor(awayForm);
  const homeScheduleStrength = Math.max(0.80, Math.min(1.20, Number(liveStats?.home?.opposition_strength_factor ?? 1)));
  const awayScheduleStrength = Math.max(0.80, Math.min(1.20, Number(liveStats?.away?.opposition_strength_factor ?? 1)));
  const adjustedHomeAttack = homeGpg * homeScheduleStrength;
  const adjustedAwayAttack = awayGpg * awayScheduleStrength;
  const adjustedHomeConceded = homeCpg / homeScheduleStrength;
  const adjustedAwayConceded = awayCpg / awayScheduleStrength;
  const baseHomeXG = ((adjustedHomeAttack + adjustedAwayConceded) / 2) * homeAdv;
  const baseAwayXG = (adjustedAwayAttack + adjustedHomeConceded) / 2;
  const base = poissonProbs(baseHomeXG, baseAwayXG);

  // Shared rate limiter serializes these API calls even when the promises are scheduled together.
  const [h2h, injuries, lineup, events, homeSquad, awaySquad] = await Promise.allSettled([
    fetchH2H(homeTeamId, awayTeamId),
    fetchInjuries(fixtureId, homeTeamId, awayTeamId),
    fetchLineup(fixtureId, homeTeamId, awayTeamId, leagueId),
    isLive || matchMinute != null ? fetchMatchEvents(fixtureId, isLive) : Promise.resolve([] as ApiEvent[]),
    fetchSquadStats(homeTeamId, leagueId),
    fetchSquadStats(awayTeamId, leagueId),
  ]);
  const h2hResult = h2h.status === "fulfilled" ? h2h.value : null;
  const allInjuries = injuries.status === "fulfilled" ? injuries.value : [] as AbsentPlayer[];
  const lineupResult = lineup.status === "fulfilled" ? lineup.value : null;
  const eventsList = events.status === "fulfilled" ? events.value : [] as ApiEvent[];
  const homeSquadMap = homeSquad.status === "fulfilled" ? homeSquad.value : new Map<number, SquadPlayerStats>();
  const awaySquadMap = awaySquad.status === "fulfilled" ? awaySquad.value : new Map<number, SquadPlayerStats>();
  const homeInjuries = allInjuries.filter((i) => i.team_id === homeTeamId);
  const awayInjuries = allInjuries.filter((i) => i.team_id === awayTeamId);
  const homeInjuryFactor = injuryFactor(homeInjuries, homeSquadMap, homeGpg);
  const awayInjuryFactor = injuryFactor(awayInjuries, awaySquadMap, awayGpg);
  let homeLineupFactor = 1, awayLineupFactor = 1;
  if (lineupResult) {
    homeLineupFactor = lineupQualityFactor(lineupResult.home, homeSquadMap);
    awayLineupFactor = lineupQualityFactor(lineupResult.away, awaySquadMap);
  }
  const adjHomeXG = baseHomeXG * homeFormFactor * homeLineupFactor * homeInjuryFactor;
  const adjAwayXG = baseAwayXG * awayFormFactor * awayLineupFactor * awayInjuryFactor;
  const adjusted = poissonProbs(adjHomeXG, adjAwayXG);
  let finalHome = adjusted.homeWin, finalDraw = adjusted.draw, finalAway = adjusted.awayWin;
  if (h2hResult && h2hResult.matches > 0) {
    const blended = blendH2H(finalHome, finalDraw, finalAway, h2hResult);
    finalHome = blended.home; finalDraw = blended.draw; finalAway = blended.away;
  }
  let dataQualityPriorWeight = 0;
  let crossLeaguePriorWeight = 0;
  let strengthRatingGap = 0;
  if (!isLive) {
    const guarded = applyDataQualityPrior(
      { home: finalHome, draw: finalDraw, away: finalAway },
      liveStats?.home,
      liveStats?.away,
    );
    finalHome = guarded.home;
    finalDraw = guarded.draw;
    finalAway = guarded.away;
    dataQualityPriorWeight = guarded.priorWeight;

    const strengthAdjusted = blendCrossLeaguePrior(
      { home: finalHome, draw: finalDraw, away: finalAway },
      liveStats?.home?.strength_profile,
      liveStats?.away?.strength_profile,
    );
    finalHome = strengthAdjusted.home;
    finalDraw = strengthAdjusted.draw;
    finalAway = strengthAdjusted.away;
    crossLeaguePriorWeight = strengthAdjusted.priorWeight;
    strengthRatingGap = strengthAdjusted.ratingGap;
  }
  const markets = extendedPoissonMarkets(adjHomeXG, adjAwayXG);
  const rawConfidence = confidenceFromModel(finalHome, finalDraw, finalAway, (lineupResult ? 3 : 0) + homeInjuries.length + awayInjuries.length + (h2hResult?.matches ?? 0));
  const qualityCeiling = 70 - dataQualityPriorWeight * 80 - (crossLeaguePriorWeight > 0 ? 3 : 0);
  const confidenceScore = round2(Math.min(rawConfidence.score, qualityCeiling));
  const confidence = {
    score: confidenceScore,
    label: (confidenceScore >= 72 ? "High" : confidenceScore >= 55 ? "Medium" : "Low") as "Low" | "Medium" | "High",
  };
  const reasons = buildReasons({ homeFormFactor, awayFormFactor, homeInjuryFactor, awayInjuryFactor, homeLineupFactor, awayLineupFactor, homeXG: adjHomeXG, awayXG: adjAwayXG, h2h: h2hResult, homeName: homeTeamName, awayName: awayTeamName });
  if (dataQualityPriorWeight >= 0.15) {
    reasons.unshift("Confidence reduced because the teams' available statistical samples are not directly comparable.");
  }
  if (crossLeaguePriorWeight > 0) {
    reasons.unshift(`Cross-league club strength applied (${strengthRatingGap > 0 ? homeTeamName || "home" : awayTeamName || "away"} rating advantage).`);
  }
  const liveMomentum = isLive ? liveMomentumFromEvents(eventsList, homeTeamId, awayTeamId, matchMinute, adjHomeXG, adjAwayXG, liveStats) : undefined;

  let liveAdjHomeWin: number | undefined, liveAdjDraw: number | undefined, liveAdjAwayWin: number | undefined;
  if (isLive && liveScoreHome != null && liveScoreAway != null && matchMinute != null) {
    const p = liveScoreAdjustedProbs(liveScoreHome, liveScoreAway, matchMinute, adjHomeXG, adjAwayXG);
    liveAdjHomeWin = round2(p.homeWin); liveAdjDraw = round2(p.draw); liveAdjAwayWin = round2(p.awayWin);
  }
  let substitutionImpacts: SubstitutionImpact[] | undefined;
  let homeSubXgDelta: number | undefined, awaySubXgDelta: number | undefined;
  let subAdjHomeWin: number | undefined, subAdjDraw: number | undefined, subAdjAwayWin: number | undefined;
  if (eventsList.length > 0) {
    substitutionImpacts = computeSubstitutionImpacts(eventsList, homeTeamId, awayTeamId, homeTeamName, awayTeamName, homeSquadMap, awaySquadMap, matchMinute ?? 90);
    if (substitutionImpacts.length > 0) {
      homeSubXgDelta = round2(substitutionImpacts.filter((s) => s.team === "home").reduce((sum, s) => sum + s.xg_delta, 0));
      awaySubXgDelta = round2(substitutionImpacts.filter((s) => s.team === "away").reduce((sum, s) => sum + s.xg_delta, 0));
      const p = poissonProbs(Math.max(0.01, adjHomeXG + homeSubXgDelta), Math.max(0.01, adjAwayXG + awaySubXgDelta));
      if (h2hResult && h2hResult.matches > 0) {
        const b = blendH2H(p.homeWin, p.draw, p.awayWin, h2hResult);
        subAdjHomeWin = round2(b.home); subAdjDraw = round2(b.draw); subAdjAwayWin = round2(b.away);
      } else {
        subAdjHomeWin = round2(p.homeWin); subAdjDraw = round2(p.draw); subAdjAwayWin = round2(p.awayWin);
      }
    }
  }
  return {
    home_win: round2(finalHome), draw: round2(finalDraw), away_win: round2(finalAway),
    home_xg: round2(adjHomeXG), away_xg: round2(adjAwayXG),
    over_15: markets.over15, over_25: markets.over25, over_35: markets.over35, btts: markets.btts,
    correct_scores: markets.correctScores,
    fair_home_odds: fairOdds(finalHome), fair_draw_odds: fairOdds(finalDraw), fair_away_odds: fairOdds(finalAway),
    confidence: confidence.label, confidence_score: confidence.score, reasons, live_momentum: liveMomentum,
    base_home_win: round2(base.homeWin), base_draw: round2(base.draw), base_away_win: round2(base.awayWin),
    h2h: h2hResult ?? undefined, home_injuries: homeInjuries, away_injuries: awayInjuries, lineup: lineupResult ?? undefined,
    home_lineup_factor: round2(homeLineupFactor), away_lineup_factor: round2(awayLineupFactor),
    home_injury_factor: round2(homeInjuryFactor), away_injury_factor: round2(awayInjuryFactor),
    home_form_factor: round2(homeFormFactor), away_form_factor: round2(awayFormFactor), home_advantage: round2(homeAdv),
    live_score_home: liveScoreHome ?? undefined, live_score_away: liveScoreAway ?? undefined,
    live_adjusted_home_win: liveAdjHomeWin, live_adjusted_draw: liveAdjDraw, live_adjusted_away_win: liveAdjAwayWin,
    substitution_impacts: substitutionImpacts, home_sub_xg_delta: homeSubXgDelta, away_sub_xg_delta: awaySubXgDelta,
    sub_adjusted_home_win: subAdjHomeWin, sub_adjusted_draw: subAdjDraw, sub_adjusted_away_win: subAdjAwayWin,
    home_spotlights: buildSpotlights(homeSquadMap), away_spotlights: buildSpotlights(awaySquadMap),
    data_quality_prior_weight: round2(dataQualityPriorWeight),
    cross_league_prior_weight: round2(crossLeaguePriorWeight),
    strength_rating_gap: round2(strengthRatingGap),
    strength_model_version: liveStats?.home?.strength_profile?.version ?? liveStats?.away?.strength_profile?.version,
  };
}
