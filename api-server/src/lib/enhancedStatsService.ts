import { logger } from "./logger";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const SEASON = parseInt(process.env.FOOTBALL_SEASON ?? "2025", 10);

const LINEUP_TTL         = 30 * 60 * 1000;
const INJURIES_TTL       = 30 * 60 * 1000;
const H2H_TTL            = 60 * 60 * 1000;
const SQUAD_TTL          = 6  * 60 * 60 * 1000;
const EVENTS_LIVE_TTL    =  2 * 60 * 1000;
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

// ── League-specific home advantage ───────────────────────────────────────────
// Calibrated from multi-season data (goals scored home vs away per league)
const LEAGUE_HOME_ADV: Record<number, number> = {
  39:  1.07,  // Premier League
  140: 1.08,  // La Liga
  135: 1.09,  // Serie A
  78:  1.06,  // Bundesliga
  61:  1.07,  // Ligue 1
  2:   1.06,  // UEFA Champions League
  3:   1.05,  // UEFA Europa League
  848: 1.05,  // UEFA Conference League
  94:  1.08,  // Primeira Liga
  88:  1.07,  // Eredivisie
  203: 1.09,  // Süper Lig
};
function getHomeAdvantage(leagueId: number): number {
  return LEAGUE_HOME_ADV[leagueId] ?? 1.08;
}

// ── Types ─────────────────────────────────────────────────────────────────────

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
  /** Share of total live-match momentum, normalised to a 0-100 split for UI bars. */
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
  // Final probabilities (all factors applied)
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
  // Base Poisson (before any adjustments)
  base_home_win: number;
  base_draw: number;
  base_away_win: number;
  // Historical context
  h2h?: H2HRecord;
  // Absence data
  home_injuries: AbsentPlayer[];
  away_injuries: AbsentPlayer[];
  // Lineup
  lineup?: LineupInfo;
  // Per-factor multipliers (all relative to 1.0 = no change)
  home_lineup_factor: number;
  away_lineup_factor: number;
  home_injury_factor: number;
  away_injury_factor: number;
  home_form_factor: number;
  away_form_factor: number;
  home_advantage: number;
  // Live score adjusted probabilities (live matches only)
  live_score_home?: number;
  live_score_away?: number;
  live_adjusted_home_win?: number;
  live_adjusted_draw?: number;
  live_adjusted_away_win?: number;
  // Substitution impact (live/finished)
  substitution_impacts?: SubstitutionImpact[];
  home_sub_xg_delta?: number;
  away_sub_xg_delta?: number;
  sub_adjusted_home_win?: number;
  sub_adjusted_draw?: number;
  sub_adjusted_away_win?: number;
  // Player spotlights
  home_spotlights?: TeamSpotlights;
  away_spotlights?: TeamSpotlights;
}

// ── Squad stats ───────────────────────────────────────────────────────────────

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
      goals_per_game:    apps > 0 ? goals   / apps : 0,
      assists_per_game:  apps > 0 ? assists / apps : 0,
      fouls_per_game:    apps > 0 ? fouls   / apps : 0,
    });
  }
  setCache(key, map);
  return map;
}

// ── Name lookup helpers ───────────────────────────────────────────────────────

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

// ── Spotlight helpers ─────────────────────────────────────────────────────────

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

// ── Match Events ──────────────────────────────────────────────────────────────

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

// ── Substitution impact ───────────────────────────────────────────────────────

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

    // FIX: was using goals_per_game twice for statsOut — now correctly uses assists_per_game
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

// ── Lineup ────────────────────────────────────────────────────────────────────

type ApiLineupEntry = {
  team: { id: number };
  startXI: Array<{ player: { id: number; name: string; number: number; pos: string } }>;
};
async function fetchLineup(
  fixtureId: number,
  homeTeamId: number, awayTeamId: number,
  leagueId: number
): Promise<LineupInfo | null> {
  const key = `lineup:${fixtureId}`;
  const cached = getCached<LineupInfo>(key, LINEUP_TTL);
  if (cached) return cached;
  const [data, homeSquad, awaySquad] = await Promise.all([
    apiFetch(`/fixtures/lineups?fixture=${fixtureId}`) as Promise<ApiLineupEntry[] | null>,
    fetchSquadStats(homeTeamId, leagueId),
    fetchSquadStats(awayTeamId, leagueId),
  ]);
  if (!Array.isArray(data) || data.length < 2) return null;
  const toPlayers = (entry: ApiLineupEntry, squad: Map<number, SquadPlayerStats>): LineupPlayer[] =>
    entry.startXI.map(({ player: p }) => {
      const s = squad.get(p.id);
      return { id: p.id, name: p.name, number: p.number, position: p.pos, goals_per_game: s?.goals_per_game ?? 0, assists_per_game: s?.assists_per_game ?? 0 };
    });
  const homeEntry = data.find((e) => e.team.id === homeTeamId);
  const awayEntry = data.find((e) => e.team.id === awayTeamId);
  if (!homeEntry || !awayEntry) return null;
  const info: LineupInfo = { home: toPlayers(homeEntry, homeSquad), away: toPlayers(awayEntry, awaySquad), confirmed: true };
  setCache(key, info);
  return info;
}

// ── H2H ──────────────────────────────────────────────────────────────────────

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
      if (he.winner === true) homeWins++;
      else if (ae.winner === true) awayWins++;
      else draws++;
    } else {
      if (ae.winner === true) homeWins++;
      else if (he.winner === true) awayWins++;
      else draws++;
    }
  }
  const total = data.length;
  const record: H2HRecord = { matches: total, home_wins: homeWins, draws, away_wins: awayWins, home_win_rate: homeWins / total, draw_rate: draws / total, away_win_rate: awayWins / total };
  setCache(key, record);
  return record;
}

// ── Injuries ──────────────────────────────────────────────────────────────────

type ApiInjury = { player: { id: number; name: string }; team: { id: number }; fixture: { id: number }; injury: { type: string; reason: string } };
async function fetchInjuries(fixtureId: number, homeTeamId: number, awayTeamId: number): Promise<AbsentPlayer[]> {
  const key = `injuries:${fixtureId}`;
  const cached = getCached<AbsentPlayer[]>(key, INJURIES_TTL);
  if (cached) return cached;
  const data = await apiFetch(`/injuries?fixture=${fixtureId}`) as ApiInjury[] | null;
  if (!Array.isArray(data)) { setCache(key, []); return []; }
  const relevant = new Set([homeTeamId, awayTeamId]);
  const result: AbsentPlayer[] = data.filter((i) => relevant.has(i.team.id)).map((i) => ({ name: i.player.name, team_id: i.team.id, type: i.injury.type, reason: i.injury.reason }));
  setCache(key, result);
  return result;
}

// ── Factor functions ──────────────────────────────────────────────────────────

/**
 * Recent form factor.
 * Parses the last 5 match form string ("WWDLW") with exponential decay
 * (most recent = weight 1.0, older = 0.8^n). Maps to range [0.88, 1.12].
 */
function formFactor(form: string): number {
  if (!form || form.length === 0) return 1.0;
  const recent = form.slice(-5).split("").reverse(); // most recent first
  const decayWeights = [1.0, 0.8, 0.64, 0.51, 0.41];
  let weightedScore = 0, totalWeight = 0;
  recent.forEach((result, i) => {
    const w = decayWeights[i] ?? 0.41;
    const score = result === "W" ? 1.0 : result === "D" ? 0.4 : 0.0;
    weightedScore += w * score;
    totalWeight   += w;
  });
  const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;
  // avgScore 0.5 = neutral (1.0 factor), 1.0 = maximum boost (+12%), 0.0 = maximum reduction (-12%)
  return 0.88 + avgScore * 0.24;
}

/**
 * Injury factor weighted by each absent player's actual contribution.
 * A star striker missing is far more impactful than a squad player.
 * Falls back to flat 0.06 reduction per player if not in squad stats.
 */
function injuryFactor(
  absences: AbsentPlayer[],
  squadMap: Map<number, SquadPlayerStats>,
  teamGpg: number
): number {
  if (absences.length === 0) return 1.0;
  const lookup = buildNameLookup(squadMap);
  // Average contribution per player across the squad (goals + 0.5*assists per game)
  const squadPlayers = Array.from(squadMap.values()).filter((p) => p.appearances >= 3);
  const squadAvgContrib = squadPlayers.length > 0
    ? squadPlayers.reduce((sum, p) => sum + p.goals_per_game + 0.5 * p.assists_per_game, 0) / squadPlayers.length
    : teamGpg / 11;

  let totalImpact = 0;
  for (const absent of absences) {
    const stats = lookupByName(absent.name, lookup);
    if (stats && stats.appearances >= 3) {
      const contrib = stats.goals_per_game + 0.5 * stats.assists_per_game;
      // Relative importance: how much above squad average this player is
      const relativeImpact = contrib / Math.max(squadAvgContrib, 0.01);
      // Average player = ~6% reduction; scale linearly, cap at 18%
      totalImpact += Math.min(0.18, relativeImpact * 0.06);
    } else {
      // Unknown / low-appearance player → assume average impact
      totalImpact += 0.06;
    }
  }
  return Math.max(0.70, 1.0 - totalImpact);
}

/**
 * Lineup quality factor.
 * FIX: previously compared summed XI rate to 30% of GPG (wrong units/scale).
 * Now correctly compares average per-player contribution rate of the starting XI
 * to the squad-wide per-player average (using ID lookup for reliability).
 */
function lineupQualityFactor(
  starters: LineupPlayer[],
  squadMap: Map<number, SquadPlayerStats>
): number {
  // Squad average contribution per player (min 3 appearances)
  const squadPlayers = Array.from(squadMap.values()).filter((p) => p.appearances >= 3);
  if (squadPlayers.length < 3) return 1.0;
  const squadAvg = squadPlayers.reduce(
    (sum, p) => sum + p.goals_per_game + 0.4 * p.assists_per_game, 0
  ) / squadPlayers.length;
  if (squadAvg <= 0) return 1.0;

  // Average contribution rate of starters who appear in the squad database
  const startersInSquad = starters.map((s) => squadMap.get(s.id)).filter(Boolean) as SquadPlayerStats[];
  if (startersInSquad.length < 3) return 1.0;
  const starterAvg = startersInSquad.reduce(
    (sum, p) => sum + p.goals_per_game + 0.4 * p.assists_per_game, 0
  ) / startersInSquad.length;

  const ratio = starterAvg / squadAvg;
  return Math.min(1.20, Math.max(0.82, ratio));
}

// ── Poisson engine with Dixon-Coles correction ────────────────────────────────

const MAX_GOALS = 8;
// Rho ≈ -0.13: Poisson overestimates 0-1/1-0 and underestimates 0-0/1-1.
// Dixon-Coles correction factor τ(i, j, λ, μ, ρ)
const DC_RHO = -0.13;

function dcTau(i: number, j: number, lambda: number, mu: number): number {
  if      (i === 0 && j === 0) return 1 - lambda * mu * DC_RHO;
  else if (i === 0 && j === 1) return 1 + lambda * DC_RHO;
  else if (i === 1 && j === 0) return 1 + mu * DC_RHO;
  else if (i === 1 && j === 1) return 1 - DC_RHO;
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
      const tau = dcTau(h, a, homeXG, awayXG);
      const joint = pH * poisson(awayXG, a) * tau;
      if (h > a) homeWin += joint;
      else if (h === a) draw += joint;
      else awayWin += joint;
    }
  }
  const total = homeWin + draw + awayWin;
  return { homeWin: (homeWin / total) * 100, draw: (draw / total) * 100, awayWin: (awayWin / total) * 100 };
}


function extendedPoissonMarkets(homeXG: number, awayXG: number): {
  over15: number; over25: number; over35: number; btts: number; correctScores: CorrectScoreProbability[];
} {
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
  return {
    over15: round2(over15 * 100),
    over25: round2(over25 * 100),
    over35: round2(over35 * 100),
    btts: round2(btts * 100),
    correctScores: scores.slice(0, 6).map((s) => ({ score: s.score, probability: round2(s.probability) })),
  };
}

function fairOdds(probPct: number): number {
  return probPct > 0 ? round2(100 / probPct) : 0;
}

function confidenceFromModel(home: number, draw: number, away: number, dataPoints: number): { label: "Low" | "Medium" | "High"; score: number } {
  const sorted = [home, draw, away].sort((a, b) => b - a);
  const separation = sorted[0] - sorted[1];
  const dataBoost = Math.min(20, dataPoints * 2);
  const score = Math.max(0, Math.min(100, 35 + separation * 1.1 + dataBoost));
  return { label: score >= 72 ? "High" : score >= 55 ? "Medium" : "Low", score: round2(score) };
}

function buildReasons(opts: {
  homeFormFactor: number; awayFormFactor: number; homeInjuryFactor: number; awayInjuryFactor: number;
  homeLineupFactor: number; awayLineupFactor: number; homeXG: number; awayXG: number; h2h: H2HRecord | null;
  homeName: string; awayName: string;
}): string[] {
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
  const score =
    (liveXg * 22) +
    ((stats.shots_on_target ?? 0) * 9) +
    ((stats.shots_inside_box ?? 0) * 5) +
    ((stats.corners ?? 0) * 4) +
    ((stats.dangerous_attacks ?? 0) * 0.55) +
    ((stats.shots_total ?? 0) * 2) +
    ((stats.blocked_shots ?? 0) * 1.5) +
    Math.max(0, possession - 45) * 0.35 +
    Math.max(0, passAccuracy - 75) * 0.25 -
    ((stats.red_cards ?? 0) * 18) -
    ((stats.yellow_cards ?? 0) * 2);
  return Math.max(0, Math.min(100, score));
}

function liveMomentumFromEvents(
  events: ApiEvent[], homeTeamId: number, awayTeamId: number, minute: number | null,
  homeXG: number, awayXG: number, liveStats?: LiveMatchStatsInput
): LiveMomentum | undefined {
  if (minute == null) return undefined;
  const windowStart = Math.max(0, minute - 15);
  const recent = events.filter((e) => {
    const elapsed = Number(e?.time?.elapsed);
    return Number.isFinite(elapsed) && elapsed >= windowStart && elapsed <= minute;
  });
  const homeIndex = attackingIndex(liveStats?.home, homeXG);
  const awayIndex = attackingIndex(liveStats?.away, awayXG);
  let homePressure = Math.min(82, homeIndex);
  let awayPressure = Math.min(82, awayIndex);
  for (const e of recent) {
    // Goals and cards matter, but live momentum should primarily reflect pressure,
    // not just the scoreline. Keep event weights smaller than xG/shots/corners.
    const weight = e.type === "Goal" ? 10 : e.type === "Card" ? 5 : e.type === "subst" ? 2 : 2;
    if (e?.team?.id === homeTeamId) homePressure += weight;
    if (e?.team?.id === awayTeamId) awayPressure += weight;
  }
  homePressure = Math.max(0, Math.min(100, homePressure));
  awayPressure = Math.max(0, Math.min(100, awayPressure));
  const diff = homePressure - awayPressure;
  const dominant = Math.abs(diff) < 10 ? "balanced" : diff > 0 ? "home" : "away";
  const total = homePressure + awayPressure || 1;
  const nextHome = round2((homePressure / total) * 100);
  const nextAway = round2(100 - nextHome);
  const maxPressure = Math.max(homePressure, awayPressure);
  const momentumTotal = homePressure + awayPressure || 1;
  const homeMomentumPct = round2((homePressure / momentumTotal) * 100);
  const awayMomentumPct = round2(100 - homeMomentumPct);
  const momentumLabel = Math.abs(homeMomentumPct - awayMomentumPct) < 8
    ? "Balanced"
    : homeMomentumPct > awayMomentumPct
      ? "Home on top"
      : "Away on top";
  const alert = maxPressure >= 72 && Math.abs(diff) >= 15
    ? `${dominant === "home" ? "Home" : "Away"} pressure is high from live xG/shots/corners/pass data.`
    : maxPressure >= 62 && Math.abs(diff) >= 10
      ? `${dominant === "home" ? "Home" : "Away"} pressure is building.`
      : null;
  return {
    home_pressure: round2(homePressure),
    away_pressure: round2(awayPressure),
    dominant_team: dominant,
    pressure_alert: alert,
    next_goal_home: nextHome,
    next_goal_away: nextAway,
    home_attacking_index: round2(homeIndex),
    away_attacking_index: round2(awayIndex),
    home_danger_score: round2((liveStats?.home?.expected_goals_live ?? homeXG) * 25 + (liveStats?.home?.shots_inside_box ?? 0) * 4 + (liveStats?.home?.corners ?? 0) * 3),
    away_danger_score: round2((liveStats?.away?.expected_goals_live ?? awayXG) * 25 + (liveStats?.away?.shots_inside_box ?? 0) * 4 + (liveStats?.away?.corners ?? 0) * 3),
    home_momentum_pct: homeMomentumPct,
    away_momentum_pct: awayMomentumPct,
    momentum_gap: round2(Math.abs(homeMomentumPct - awayMomentumPct)),
    momentum_label: momentumLabel,
    data_quality: liveStats?.home || liveStats?.away ? "enhanced" : "basic",
  };
}

// ── Live score adjustment ─────────────────────────────────────────────────────
/**
 * Given the current score and match minute, compute win/draw/loss probabilities
 * for the remaining game using conditional Poisson.
 *
 * Key behaviours:
 * - A team chasing a deficit presses harder (+18% xG intensity)
 * - A team protecting a lead sits back (-15% xG intensity)
 * - Remaining xG scales linearly with time left (corrected for stoppage time)
 */
function liveScoreAdjustedProbs(
  hGoals: number,
  aGoals: number,
  minute: number,
  adjHomeXG: number,
  adjAwayXG: number
): { homeWin: number; draw: number; awayWin: number } {
  // Allow a small stoppage-time buffer
  const effectiveMax = minute >= 90 ? minute + 5 : 90;
  const remainFrac = Math.max(0, (effectiveMax - minute) / effectiveMax);

  if (remainFrac <= 0.01) {
    return {
      homeWin: hGoals > aGoals ? 100 : 0,
      draw:    hGoals === aGoals ? 100 : 0,
      awayWin: aGoals > hGoals ? 100 : 0,
    };
  }

  const scoreDiff = hGoals - aGoals;
  // Momentum factors: losing team pushes harder; winning team conserves energy
  const homeMomentum = scoreDiff < 0 ? 1.18 : scoreDiff > 0 ? 0.85 : 1.0;
  const awayMomentum = scoreDiff > 0 ? 1.18 : scoreDiff < 0 ? 0.85 : 1.0;

  const remHomeXG = Math.max(0.01, adjHomeXG * remainFrac * homeMomentum);
  const remAwayXG = Math.max(0.01, adjAwayXG * remainFrac * awayMomentum);

  let homeWin = 0, draw = 0, awayWin = 0;
  for (let rh = 0; rh <= MAX_GOALS; rh++) {
    const pH = poisson(remHomeXG, rh);
    for (let ra = 0; ra <= MAX_GOALS; ra++) {
      const joint = pH * poisson(remAwayXG, ra);
      const finalH = hGoals + rh;
      const finalA = aGoals + ra;
      if (finalH > finalA) homeWin += joint;
      else if (finalH === finalA) draw += joint;
      else awayWin += joint;
    }
  }
  const total = homeWin + draw + awayWin;
  return {
    homeWin: (homeWin / total) * 100,
    draw:    (draw    / total) * 100,
    awayWin: (awayWin / total) * 100,
  };
}

// ── H2H blend ─────────────────────────────────────────────────────────────────

function blendH2H(
  poissonHome: number, poissonDraw: number, poissonAway: number,
  h2h: H2HRecord
): { home: number; draw: number; away: number } {
  const w = h2h.matches >= 5 ? 0.30 : (h2h.matches / 5) * 0.30;
  const home = (1 - w) * poissonHome + w * h2h.home_win_rate * 100;
  const draw = (1 - w) * poissonDraw  + w * h2h.draw_rate    * 100;
  const away = (1 - w) * poissonAway  + w * h2h.away_win_rate * 100;
  const total = home + draw + away;
  return { home: (home / total) * 100, draw: (draw / total) * 100, away: (away / total) * 100 };
}

function round2(n: number) { return Math.round(n * 100) / 100; }

// ── Main export ────────────────────────────────────────────────────────────────

export async function getEnhancedPrediction(
  fixtureId: number,
  homeTeamId: number,
  awayTeamId: number,
  leagueId: number,
  homeGpg: number,
  homeCpg: number,
  awayGpg: number,
  awayCpg: number,
  homeTeamName = "",
  awayTeamName = "",
  matchMinute: number | null = null,
  isLive = false,
  liveScoreHome: number | null = null,
  liveScoreAway: number | null = null,
  homeForm = "",
  awayForm = "",
  liveStats?: LiveMatchStatsInput
): Promise<EnhancedPrediction> {

  // ── Step 1: League-specific home advantage ────────────────────────────────
  const homeAdv = getHomeAdvantage(leagueId);

  // ── Step 2: Form factors (recent form weighted by recency) ────────────────
  const homeFormFactor = formFactor(homeForm);
  const awayFormFactor = formFactor(awayForm);

  // ── Step 3: Base Poisson (with form already folded in) ────────────────────
  const baseHomeXG = ((homeGpg + awayCpg) / 2) * homeAdv;
  const baseAwayXG = (awayGpg + homeCpg) / 2;
  const base = poissonProbs(baseHomeXG, baseAwayXG);

  // ── Step 4: Fetch all enhancement data in parallel ────────────────────────
  const [h2h, injuries, lineup, events, homeSquad, awaySquad] = await Promise.allSettled([
    fetchH2H(homeTeamId, awayTeamId),
    fetchInjuries(fixtureId, homeTeamId, awayTeamId),
    fetchLineup(fixtureId, homeTeamId, awayTeamId, leagueId),
    isLive || matchMinute != null
      ? fetchMatchEvents(fixtureId, isLive)
      : Promise.resolve([] as ApiEvent[]),
    fetchSquadStats(homeTeamId, leagueId),
    fetchSquadStats(awayTeamId, leagueId),
  ]);

  const h2hResult    = h2h.status      === "fulfilled" ? h2h.value      : null;
  const allInjuries  = injuries.status === "fulfilled" ? injuries.value  : [] as AbsentPlayer[];
  const lineupResult = lineup.status   === "fulfilled" ? lineup.value    : null;
  const eventsList   = events.status   === "fulfilled" ? events.value    : [] as ApiEvent[];
  const homeSquadMap = homeSquad.status === "fulfilled" ? homeSquad.value : new Map<number, SquadPlayerStats>();
  const awaySquadMap = awaySquad.status === "fulfilled" ? awaySquad.value : new Map<number, SquadPlayerStats>();

  const homeInjuries = allInjuries.filter((i) => i.team_id === homeTeamId);
  const awayInjuries = allInjuries.filter((i) => i.team_id === awayTeamId);

  // ── Step 5: Injury factors (player-contribution weighted) ─────────────────
  const homeInjuryFactor = injuryFactor(homeInjuries, homeSquadMap, homeGpg);
  const awayInjuryFactor = injuryFactor(awayInjuries, awaySquadMap, awayGpg);

  // ── Step 6: Lineup quality factors (FIX: per-player ID lookup) ────────────
  let homeLineupFactor = 1.0;
  let awayLineupFactor = 1.0;
  if (lineupResult) {
    homeLineupFactor = lineupQualityFactor(lineupResult.home, homeSquadMap);
    awayLineupFactor = lineupQualityFactor(lineupResult.away, awaySquadMap);
  }

  // ── Step 7: Adjusted xG (form × lineup × injury × home advantage) ────────
  const adjHomeXG = baseHomeXG * homeFormFactor * homeLineupFactor * homeInjuryFactor;
  const adjAwayXG = baseAwayXG * awayFormFactor * awayLineupFactor * awayInjuryFactor;
  const adjusted = poissonProbs(adjHomeXG, adjAwayXG);

  // ── Step 8: H2H blend (capped at 30% weight, down from 35%) ──────────────
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
  const confidence = confidenceFromModel(finalHome, finalDraw, finalAway, (lineupResult ? 3 : 0) + homeInjuries.length + awayInjuries.length + (h2hResult?.matches ?? 0));
  const reasons = buildReasons({ homeFormFactor, awayFormFactor, homeInjuryFactor, awayInjuryFactor, homeLineupFactor, awayLineupFactor, homeXG: adjHomeXG, awayXG: adjAwayXG, h2h: h2hResult, homeName: homeTeamName, awayName: awayTeamName });
  const liveMomentum = isLive ? liveMomentumFromEvents(eventsList, homeTeamId, awayTeamId, matchMinute, adjHomeXG, adjAwayXG, liveStats) : undefined;

  // ── Step 9: Live score adjustment ────────────────────────────────────────
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

  // ── Step 10: Substitution impact ─────────────────────────────────────────
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

  // ── Step 11: Player spotlights ────────────────────────────────────────────
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
