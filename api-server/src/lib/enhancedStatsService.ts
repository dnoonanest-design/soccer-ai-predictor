import { logger } from "./logger";
import { db, modelTrainingRuns } from "@workspace/db";
import { desc } from "drizzle-orm";
import { getLearnedWeights, getOfflineFallbackModel, type LearnedFactorWeights, type OfflineFallbackModel } from "./adaptiveLearningEngine";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const SEASON = parseInt(process.env.FOOTBALL_SEASON ?? "2025", 10);

const LINEUP_TTL         = 30 * 60 * 1000;
const INJURIES_TTL       = 30 * 60 * 1000;
const H2H_TTL            = 60 * 60 * 1000;
const SQUAD_TTL          = 6  * 60 * 60 * 1000;
const COMPETITION_TTL    = 4  * 60 * 60 * 1000;  // standings/competition form: 4 hrs
const EVENTS_LIVE_TTL    =  2 * 60 * 1000;
const EVENTS_FINISHED_TTL = 60 * 60 * 1000;

// ── Trained-weight loader ──────────────────────────────────────────────────────
// Loads the most recent training run from the DB and caches it for 15 minutes.
// The priors (home/draw/away base rates learned from settled predictions) are
// used to nudge the Poisson output toward empirically observed frequencies,
// correcting systematic draw underestimation.

interface TrainedPriors { home: number; draw: number; away: number }
const NEUTRAL_PRIORS: TrainedPriors = { home: 0.45, draw: 0.27, away: 0.28 };
const TRAINED_WEIGHTS_TTL = 15 * 60 * 1000;
let _trainedWeightsCache: { priors: TrainedPriors; fetchedAt: number } | null = null;

async function getTrainedPriors(): Promise<TrainedPriors> {
  if (_trainedWeightsCache && Date.now() - _trainedWeightsCache.fetchedAt < TRAINED_WEIGHTS_TTL) {
    return _trainedWeightsCache.priors;
  }
  try {
    const rows = await db.select({ weightsJson: modelTrainingRuns.weightsJson })
      .from(modelTrainingRuns)
      .orderBy(desc(modelTrainingRuns.createdAt))
      .limit(1);
    if (rows.length > 0) {
      const w = JSON.parse(rows[0].weightsJson);
      const p = w?.priors;
      if (p && typeof p.home === "number" && typeof p.draw === "number" && typeof p.away === "number") {
        const priors: TrainedPriors = { home: p.home, draw: p.draw, away: p.away };
        _trainedWeightsCache = { priors, fetchedAt: Date.now() };
        return priors;
      }
    }
  } catch (err) {
    logger.warn({ err }, "enhancedStats: failed to load trained priors, using neutral defaults");
  }
  _trainedWeightsCache = { priors: NEUTRAL_PRIORS, fetchedAt: Date.now() };
  return NEUTRAL_PRIORS;
}

/**
 * Applies a soft Bayesian nudge toward empirical outcome priors.
 * This corrects Poisson's systematic draw underestimation by blending the
 * model's output with the historically observed home/draw/away base rates.
 * The blend weight is intentionally small (10%) so the statistical signal
 * from xG, form, injuries etc. still dominates.
 */
function applyPriorNudge(
  home: number, draw: number, away: number,
  priors: TrainedPriors,
  priorWeight = 0.10,   // adaptive: learned from settled draw frequency
): { home: number; draw: number; away: number } {
  const PRIOR_WEIGHT = Math.max(0.05, Math.min(0.20, priorWeight));
  const hUnit = home / 100;
  const dUnit = draw / 100;
  const aUnit = away / 100;
  const h = (1 - PRIOR_WEIGHT) * hUnit + PRIOR_WEIGHT * priors.home;
  const d = (1 - PRIOR_WEIGHT) * dUnit + PRIOR_WEIGHT * priors.draw;
  const a = (1 - PRIOR_WEIGHT) * aUnit + PRIOR_WEIGHT * priors.away;
  const total = h + d + a;
  return {
    home: Math.round((h / total) * 10000) / 100,
    draw: Math.round((d / total) * 10000) / 100,
    away: Math.round((a / total) * 10000) / 100,
  };
}

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

// ── S4: Periodic cache pruning to prevent unbounded memory growth ───────────
// Each entry's TTL varies (12s live up to 6hrs squad).  Prune anything older
// than the longest TTL (SQUAD_TTL = 6hrs) once per hour.
function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > SQUAD_TTL) cache.delete(key);
  }
}
if (typeof setInterval !== "undefined") {
  setInterval(pruneCache, 60 * 60 * 1000);   // every hour
}

// ── S1: In-flight request deduplication ────────────────────────────────────
// If two concurrent requests arrive for the same API path before either
// completes, they share a single in-flight promise instead of firing two
// identical API calls. This halves quota usage under concurrent load.
const _inFlight = new Map<string, Promise<unknown>>();

// ── S2: 5-second timeout on all external API calls ─────────────────────────
// Prevents the route handler hanging indefinitely when API-Football is slow.
const API_TIMEOUT_MS = 5000;

async function apiFetch(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) return null;
  // Return the existing in-flight promise for this path if one is running
  if (_inFlight.has(path)) return _inFlight.get(path)!;
  const url = `${API_FOOTBALL_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const promise = fetch(url, {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) { logger.warn({ status: res.status, url }, "enhanced: api-football failed"); return null; }
      const json = await res.json() as { response?: unknown };
      return json.response ?? null;
    })
    .catch((err: unknown) => {
      if ((err as any)?.name === "AbortError") logger.warn({ url }, "enhanced: api call timed out after 5s");
      else logger.warn({ err, url }, "enhanced: fetch error");
      return null;
    })
    .finally(() => {
      clearTimeout(timer);
      _inFlight.delete(path);
    });
  _inFlight.set(path, promise);
  return promise;
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

// ── A1: League-average goals per game for Dixon-Coles normalisation ──────────
// Without normalisation, a Bundesliga team (avg 3.1 total gpg) appears
// stronger than an equally-ranked Serie A team (avg 2.5 total gpg) purely
// because of league scoring environment.  Dividing each team's gpg by the
// league average before computing xG removes this systematic inter-league bias.
// Values are approximate 2024/25 season averages; update annually or fetch
// dynamically from /leagues/standings once you have sufficient season data.
const LEAGUE_AVG_GPG: Record<number, { home: number; away: number }> = {
  39:  { home: 1.53, away: 1.17 },  // Premier League
  140: { home: 1.52, away: 1.08 },  // La Liga
  135: { home: 1.44, away: 1.06 },  // Serie A
  78:  { home: 1.65, away: 1.22 },  // Bundesliga
  61:  { home: 1.53, away: 1.14 },  // Ligue 1
  2:   { home: 1.60, away: 1.25 },  // Champions League
  3:   { home: 1.55, away: 1.20 },  // Europa League
  848: { home: 1.50, away: 1.15 },  // Conference League
  94:  { home: 1.58, away: 1.12 },  // Primeira Liga
  88:  { home: 1.62, away: 1.18 },  // Eredivisie
  203: { home: 1.60, away: 1.20 },  // Süper Lig
};
const DEFAULT_LEAGUE_AVG = { home: 1.50, away: 1.15 };

// Runtime learned xG overrides (populated from adaptive engine, in-memory only)
let _runtimeXgOverride: Record<number, { home: number; away: number }> = {};
export function applyLeagueXgOverrides(overrides: Record<number, { home: number; away: number }>): void {
  _runtimeXgOverride = overrides;
}

function getLeagueAvg(leagueId: number): { home: number; away: number } {
  // Priority: runtime-learned > static table > global default
  return _runtimeXgOverride[leagueId] ?? LEAGUE_AVG_GPG[leagueId] ?? DEFAULT_LEAGUE_AVG;
}

/**
 * Compute normalised home/away expected goals using the Dixon-Coles
 * attack-strength / defence-weakness model relative to league averages.
 *
 *   homeXG = (homeAttack × awayDefence) × lgAvg.home × homeAdv
 *   awayXG = (awayAttack × homeDefence) × lgAvg.away
 *
 * where attack = team_gpg / lg_home_avg, defence = team_cpg / lg_away_avg.
 * Returns the raw formula xG values (before any form/injury/lineup factors).
 */
function computeNormalisedXG(
  homeGpg: number, homeCpg: number,
  awayGpg: number, awayCpg: number,
  leagueId: number,
  homeAdv: number,
): { baseHomeXG: number; baseAwayXG: number } {
  const lg = getLeagueAvg(leagueId);
  const homeAttack  = homeGpg  / Math.max(lg.home, 0.5);
  const homeDefence = homeCpg  / Math.max(lg.away, 0.5);
  const awayAttack  = awayGpg  / Math.max(lg.away, 0.5);
  const awayDefence = awayCpg  / Math.max(lg.home, 0.5);
  return {
    baseHomeXG: Math.max(0.01, homeAttack  * awayDefence * lg.home * homeAdv),
    baseAwayXG: Math.max(0.01, awayAttack  * homeDefence * lg.away),
  };
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
export interface CompetitionRecord {
  /** Table position in the competition (1 = top) */
  position: number;
  /** Total teams in the competition */
  total_teams: number;
  /** Points accumulated in this competition this season */
  points: number;
  /** Goals scored per game in this competition */
  goals_per_game: number;
  /** Goals conceded per game in this competition */
  conceded_per_game: number;
  /** Win rate in this competition (0-1) */
  win_rate: number;
  /** Home win rate in this competition (0-1) */
  home_win_rate: number;
  /** Away win rate in this competition (0-1) */
  away_win_rate: number;
  /** Matches played in this competition */
  played: number;
  /** Recent form string in this competition only (last 5, most recent last) */
  competition_form: string;
  /** xG-based factor derived from competition performance (1.0 = neutral) */
  competition_factor: number;
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
  // Competition history (in-competition record, standings, competition-specific form)
  home_competition?: CompetitionRecord;
  away_competition?: CompetitionRecord;
  /** Factor applied to home xG from competition history (1.0 = neutral) */
  home_competition_factor: number;
  /** Factor applied to away xG from competition history (1.0 = neutral) */
  away_competition_factor: number;
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
  // ── A4: Fetch both page 1 and page 2 in parallel ────────────────────────
  // The API returns ~20 players per page; a full squad is 25-30. Page 1 covers
  // the most-used players (ordered by appearances) but injury/suspension data
  // can reference any squad member.  Both pages are cached for SQUAD_TTL (6hrs).
  const [page1, page2] = await Promise.all([
    apiFetch(`/players?team=${teamId}&league=${leagueId}&season=${SEASON}&page=1`) as Promise<ApiPlayer[] | null>,
    apiFetch(`/players?team=${teamId}&league=${leagueId}&season=${SEASON}&page=2`) as Promise<ApiPlayer[] | null>,
  ]);
  const allPlayers: ApiPlayer[] = [
    ...(Array.isArray(page1) ? page1 : []),
    ...(Array.isArray(page2) ? page2 : []),
  ];
  const map = new Map<number, SquadPlayerStats>();
  for (const entry of allPlayers) {
    const stat = entry.statistics[0];
    if (!stat) continue;
    const apps    = stat.games.appearences ?? 0;
    const goals   = stat.goals.total ?? 0;
    const assists = stat.goals.assists ?? 0;
    const fouls   = stat.fouls?.committed ?? 0;
    const pos     = stat.games.position ?? "M";
    // Deduplicate: keep the entry with more appearances if a player appears on both pages
    const existing = map.get(entry.player.id);
    if (existing && existing.appearances >= apps) continue;
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
  // Exact full-name match first
  if (lookup.has(lower)) return lookup.get(lower);
  // ── B5: Improved partial match — minimum 4-char key, prefer longest match ──
  // The old code returned the first substring match, which could mis-identify
  // a player named "Silva" as any other player whose key contained "silva".
  // Now we require keys ≥4 chars (avoids "ali" matching "alia") and prefer
  // the longest matching key (most specific).
  let best: SquadPlayerStats | undefined;
  let bestKeyLen = 0;
  for (const [key, val] of lookup) {
    if (key.length < 4) continue;
    if (lower.includes(key) || key.includes(lower)) {
      if (key.length > bestKeyLen) { best = val; bestKeyLen = key.length; }
    }
  }
  return best;
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

// ── Competition history ────────────────────────────────────────────────────────
//
// Fetches two data points per team:
//   1. Current standings in the competition → position, points, home/away record
//   2. Last 5 fixtures in this competition only → competition-specific form
//
// These are combined into a CompetitionRecord and a competitionHistoryFactor
// that adjusts the team's xG. The factor captures things the season-average
// stats miss, such as a mid-table team who is 2nd in the Champions League
// group, or a top-6 side who is dramatically underperforming domestically.

type ApiStanding = {
  rank: number;
  team: { id: number; name: string };
  points: number;
  goalsDiff: number;
  all: { played: number; win: number; draw: number; lose: number; goals: { for: number; against: number } };
  home: { played: number; win: number; draw: number; lose: number };
  away: { played: number; win: number; draw: number; lose: number };
  form: string | null;
};

type ApiCompFixture = {
  fixture: { id: number; status: { short: string } };
  teams: { home: { id: number; winner: boolean | null }; away: { id: number; winner: boolean | null } };
};

/**
 * Builds a CompetitionRecord for a team in a specific league/season.
 * Returns null if the API key is missing or both data sources fail.
 */
// ── Standings cache (league-level, shared between both teams in a match) ──────
// The standings endpoint returns the ENTIRE league table, so both teams in a
// match can share a single API call. Cache key is league-based, not team-based.
async function fetchLeagueStandings(leagueId: number): Promise<unknown> {
  const key = `standings:${leagueId}`;                           // shared across teams
  const cached = getCached<unknown>(key, COMPETITION_TTL);
  if (cached) return cached;
  const data = await apiFetch(`/standings?league=${leagueId}&season=${SEASON}`);
  setCache(key, data);
  return data;
}

async function fetchCompetitionRecord(
  teamId: number,
  leagueId: number,
  isHome: boolean,   // whether this team is playing at home in the upcoming match
): Promise<CompetitionRecord | null> {
  const key = `comprecord:${teamId}:${leagueId}`;
  const cached = getCached<CompetitionRecord>(key, COMPETITION_TTL);
  if (cached) return cached;

  // Fetch standings (shared league cache) and team fixtures in parallel.
  // fetchLeagueStandings uses a league-level cache so both home and away team
  // calls within the same request resolve to the same cached promise/value.
  const [standingsRaw, fixturesRaw] = await Promise.all([
    fetchLeagueStandings(leagueId),
    apiFetch(`/fixtures?team=${teamId}&league=${leagueId}&season=${SEASON}&last=6`) as Promise<unknown>,
  ]);

  // ── Parse standings ──────────────────────────────────────────────────────
  // The standings endpoint returns Array<Array<ApiStanding>> (grouped by group)
  let standing: ApiStanding | null = null;
  let totalTeams = 20; // sensible default
  if (Array.isArray(standingsRaw)) {
    for (const group of standingsRaw as unknown[][]) {
      if (!Array.isArray(group)) continue;
      totalTeams = Math.max(totalTeams, group.length);
      const found = (group as ApiStanding[]).find((s) => s?.team?.id === teamId);
      if (found) { standing = found; totalTeams = group.length; break; }
    }
  }

  // ── Parse recent competition fixtures ────────────────────────────────────
  const fixtures = Array.isArray(fixturesRaw) ? (fixturesRaw as ApiCompFixture[]) : [];
  const finished = fixtures.filter(
    (f) => f?.fixture?.status?.short === "FT" || f?.fixture?.status?.short === "AET" || f?.fixture?.status?.short === "PEN",
  );
  // Build a form string from finished fixtures (W/D/L from this team's perspective)
  const formChars = finished.slice(-5).map((f) => {
    const isThisTeamHome = f.teams.home.id === teamId;
    const winner = isThisTeamHome ? f.teams.home.winner : f.teams.away.winner;
    const loser  = isThisTeamHome ? f.teams.away.winner : f.teams.home.winner;
    if (winner === true) return "W";
    if (loser  === true) return "L";
    return "D";
  });
  const competitionForm = formChars.join("");

  if (!standing) {
    // No standing data — build a minimal record from fixture history only
    if (finished.length === 0) return null;
    const wins   = formChars.filter((c) => c === "W").length;
    const draws  = formChars.filter((c) => c === "D").length;
    const played = formChars.length;
    const partial: CompetitionRecord = {
      position: Math.round(totalTeams / 2),
      total_teams: totalTeams,
      points: wins * 3 + draws,
      goals_per_game: 0,
      conceded_per_game: 0,
      win_rate: played > 0 ? wins / played : 0.33,
      home_win_rate: 0.33,
      away_win_rate: 0.33,
      played,
      competition_form: competitionForm,
      competition_factor: competitionFormFactor(competitionForm),
    };
    setCache(key, partial);
    return partial;
  }

  // ── Derive competition factor ────────────────────────────────────────────
  const played      = standing.all.played;
  const wins        = standing.all.win;
  const draws       = standing.all.draw;
  const goalsFor    = standing.all.goals.for;
  const goalsAgainst = standing.all.goals.against;
  const gpg         = played > 0 ? goalsFor    / played : 0;
  const cpg         = played > 0 ? goalsAgainst / played : 0;
  const winRate     = played > 0 ? wins / played : 0.33;

  const homePlayed  = standing.home.played;
  const homeWins    = standing.home.win;
  const awayPlayed  = standing.away.played;
  const awayWins    = standing.away.win;
  const homeWinRate = homePlayed > 0 ? homeWins / homePlayed : winRate;
  const awayWinRate = awayPlayed > 0 ? awayWins / awayPlayed : winRate;

  // Position factor: top-quarter teams get a boost, bottom-quarter a penalty.
  // Scale: rank 1 → +8%, rank=totalTeams → -8%, linear interpolation.
  const positionFactor = computePositionFactor(standing.rank, totalTeams);

  // Competition-specific form factor (last 5 in this competition)
  const compFormFactor = competitionFormFactor(competitionForm);

  // Home/away specific performance in this competition
  const venueWinRate = isHome ? homeWinRate : awayWinRate;
  // Compare venue-specific win rate against overall league average (~0.45 home, ~0.28 away)
  const leagueAvgVenueWinRate = isHome ? 0.45 : 0.28;
  const venueFactor = 0.97 + Math.max(-0.07, Math.min(0.07, (venueWinRate - leagueAvgVenueWinRate) * 0.5));

  // ── B3: Form weight correction for domestic leagues ──────────────────────
  // The overall formFactor (Step 2) uses the API's cross-competition form
  // string which, for domestic league matches, already covers the same results
  // as the competition form string here — the two signals are correlated.
  // For European competitions (CL/EL/etc.) the form strings are genuinely
  // independent, so the full 40% weight is appropriate.
  // For domestic leagues we drop the form weight to 20% and shift it into
  // position (which is always independent of overall form).
  const DOMESTIC_LEAGUES = new Set([39, 140, 135, 78, 61, 94, 88, 203, 144, 71, 253]);
  const isDomestic = DOMESTIC_LEAGUES.has(leagueId);
  const positionWeight = isDomestic ? 0.60 : 0.40;
  const formWeight     = isDomestic ? 0.20 : 0.40;

  // Combine: position + form + venue performance (20% always)
  const rawFactor = positionFactor * positionWeight + compFormFactor * formWeight + venueFactor * 0.20;
  // Normalise so a neutral team (mid-table, balanced form) = 1.0, cap at ±12%
  const competitionFactor = Math.max(0.88, Math.min(1.12, rawFactor));

  const record: CompetitionRecord = {
    position:          standing.rank,
    total_teams:       totalTeams,
    points:            standing.points,
    goals_per_game:    Math.round(gpg  * 100) / 100,
    conceded_per_game: Math.round(cpg  * 100) / 100,
    win_rate:          Math.round(winRate     * 1000) / 1000,
    home_win_rate:     Math.round(homeWinRate * 1000) / 1000,
    away_win_rate:     Math.round(awayWinRate * 1000) / 1000,
    played,
    competition_form:  competitionForm,
    competition_factor: Math.round(competitionFactor * 1000) / 1000,
  };

  setCache(key, record);
  return record;
}

/**
 * Position factor: rank 1 in N-team league → 1.08, rank N → 0.92, linear.
 * Minimum 4 teams assumed to avoid degenerate 2-team competitions.
 */
function computePositionFactor(rank: number, totalTeams: number): number {
  const t = Math.max(4, totalTeams);
  // percentile: 1 (best) → 1.0, t (worst) → 0.0
  const percentile = 1 - (rank - 1) / (t - 1);
  // map [0, 1] → [0.92, 1.08]
  return 0.92 + percentile * 0.16;
}

/**
 * Form factor from competition-only form string.
 * Uses the same exponential-decay approach as formFactor() but applied
 * only to results in this specific competition.
 */
function competitionFormFactor(form: string): number {
  if (!form || form.length === 0) return 1.0;
  const chars = form.slice(-5).split("").reverse(); // most recent first
  const decayWeights = [1.0, 0.8, 0.64, 0.51, 0.41];
  let weightedScore = 0, totalWeight = 0;
  chars.forEach((c, i) => {
    const w = decayWeights[i] ?? 0.41;
    const score = c === "W" ? 1.0 : c === "D" ? 0.4 : 0.0;
    weightedScore += w * score;
    totalWeight   += w;
  });
  const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;
  return 0.92 + avgScore * 0.16; // maps [0,1] → [0.92, 1.08]
}

type ApiFixture = { fixture: { id: number }; teams: { home: { id: number; winner: boolean | null }; away: { id: number; winner: boolean | null } } };
async function fetchH2H(homeTeamId: number, awayTeamId: number): Promise<H2HRecord | null> {
  const key = `h2h:${homeTeamId}:${awayTeamId}`;
  const cached = getCached<H2HRecord>(key, H2H_TTL);
  if (cached) return cached;
  const data = await apiFetch(`/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}&last=20`) as ApiFixture[] | null;  // B1: fetch 20 so blendH2H can reach its full 30% weight threshold
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

function confidenceFromModel(
  home: number, draw: number, away: number, dataPoints: number,
  baseHome = 0, baseDraw = 0, baseAway = 0,   // A3: base Poisson probs for divergence penalty
): { label: "Low" | "Medium" | "High"; score: number } {
  const sorted = [home, draw, away].sort((a, b) => b - a);
  const separation = sorted[0] - sorted[1];
  const dataBoost = Math.min(20, dataPoints * 2);
  // ── A3: Penalise heavily-adjusted predictions ──────────────────────────
  // When form, injuries, lineup and competition factors move the output far
  // from the base Poisson (high divergence), each factor carries uncertainty.
  // A 50pt total shift from base should reduce confidence by ~15 points.
  const divergence = Math.abs(home - baseHome) + Math.abs(draw - baseDraw) + Math.abs(away - baseAway);
  const divergencePenalty = Math.min(15, divergence * 0.30);
  const score = Math.max(0, Math.min(100, 35 + separation * 1.1 + dataBoost - divergencePenalty));
  return { label: score >= 72 ? "High" : score >= 55 ? "Medium" : "Low", score: round2(score) };
}

function buildReasons(opts: {
  homeFormFactor: number; awayFormFactor: number; homeInjuryFactor: number; awayInjuryFactor: number;
  homeLineupFactor: number; awayLineupFactor: number; homeXG: number; awayXG: number; h2h: H2HRecord | null;
  homeName: string; awayName: string;
  homeComp?: CompetitionRecord | null; awayComp?: CompetitionRecord | null;
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

  // Competition history reasons
  const hc = opts.homeComp, ac = opts.awayComp;
  if (hc && hc.played >= 3 && ac && ac.played >= 3) {
    const posDiff = (ac.position / ac.total_teams) - (hc.position / hc.total_teams);
    if (posDiff >= 0.25) {
      reasons.push(`${opts.homeName || "Home"} sits significantly higher in the ${hc.total_teams}-team standings (P${hc.position} vs P${ac.position}).`);
    } else if (posDiff <= -0.25) {
      reasons.push(`${opts.awayName || "Away"} sits significantly higher in the ${ac.total_teams}-team standings (P${ac.position} vs P${hc.position}).`);
    }
    if (hc.competition_factor - ac.competition_factor >= 0.05) {
      reasons.push(`${opts.homeName || "Home"} has stronger competition-specific form (factor ${hc.competition_factor.toFixed(2)} vs ${ac.competition_factor.toFixed(2)}).`);
    } else if (ac.competition_factor - hc.competition_factor >= 0.05) {
      reasons.push(`${opts.awayName || "Away"} has stronger competition-specific form (factor ${ac.competition_factor.toFixed(2)} vs ${hc.competition_factor.toFixed(2)}).`);
    }
  } else if (hc && hc.played >= 3 && hc.competition_factor >= 1.06) {
    reasons.push(`${opts.homeName || "Home"} is performing strongly in this competition (P${hc.position}/${hc.total_teams}, factor ${hc.competition_factor.toFixed(2)}).`);
  } else if (ac && ac.played >= 3 && ac.competition_factor >= 1.06) {
    reasons.push(`${opts.awayName || "Away"} is performing strongly in this competition (P${ac.position}/${ac.total_teams}, factor ${ac.competition_factor.toFixed(2)}).`);
  }

  if (reasons.length === 0) reasons.push("No strong edge detected; probabilities are mainly season-strength based.");
  return reasons.slice(0, 6);
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
  const maxPressure = Math.max(homePressure, awayPressure);

  // ── A5: next_goal_home vs home_momentum_pct are now distinct metrics ──────
  // next_goal_home: fast signal — pure pressure-based probability the next
  //   goal is scored by the home team (raw shot/danger-pressure ratio).
  // home_momentum_pct: slower, smoother — pressure blended with attacking
  //   index (xG, pass accuracy, shots on target) for UI momentum bars.
  const pressureTotal = homePressure + awayPressure || 1;
  const nextHome = round2((homePressure / pressureTotal) * 100);
  const nextAway = round2(100 - nextHome);

  // Blend pressure with attacking index for a smoother momentum percentage
  const homeBlended = homePressure * 0.60 + homeIndex * 0.40;
  const awayBlended = awayPressure * 0.60 + awayIndex * 0.40;
  const blendedTotal = homeBlended + awayBlended || 1;
  const homeMomentumPct = round2((homeBlended / blendedTotal) * 100);
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
  // ── A2: Dynamic momentum multipliers ──────────────────────────────────────
  // The original hardcoded ±18%/−15% didn't account for match minute (chasing
  // in the 88th is more urgent than the 55th) or goal deficit size (−2 is more
  // urgent than −1).  Urgency scales from 0.3 at kickoff to 1.0 at 90 minutes.
  const urgency = Math.min(1.0, (minute / 90) * 0.7 + 0.3);
  const deficitGoals = Math.abs(scoreDiff);
  // Chase boost: +10% per goal behind, multiplied by urgency; max +30%
  const chaseBoost = 1.0 + Math.min(0.30, deficitGoals * 0.10) * urgency;
  // Protect reduction: −8% per goal ahead, dampened early; max −20%
  const protectReduction = 1.0 - Math.min(0.20, deficitGoals * 0.08) * (1 - urgency * 0.30);
  const homeMomentum = scoreDiff < 0 ? chaseBoost : scoreDiff > 0 ? protectReduction : 1.0;
  const awayMomentum = scoreDiff > 0 ? chaseBoost : scoreDiff < 0 ? protectReduction : 1.0;

  const remHomeXG = Math.max(0.01, adjHomeXG * remainFrac * homeMomentum);
  const remAwayXG = Math.max(0.01, adjAwayXG * remainFrac * awayMomentum);

  // ── B4: Apply DC correction to remaining-game Poisson ──────────────────
  // The main poissonProbs() uses dcTau for 0-0/1-1/0-1/1-0 low-score
  // corrections. The live remainder loop previously used raw Poisson, making
  // the model inconsistent between pre-match and live paths.
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let rh = 0; rh <= MAX_GOALS; rh++) {
    const pH = poisson(remHomeXG, rh);
    for (let ra = 0; ra <= MAX_GOALS; ra++) {
      // Apply DC tau correction to remainder goals (not the cumulative score)
      const tau = dcTau(rh, ra, remHomeXG, remAwayXG);
      const joint = pH * poisson(remAwayXG, ra) * tau;
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
  // Full 30% weight only when ≥20 H2H meetings are available.
  // Below that the weight scales linearly, preventing a 3-match H2H record
  // (which could be a fluke) from shifting probabilities by ~9 points.
  const MAX_H2H_WEIGHT = 0.30;
  const FULL_WEIGHT_THRESHOLD = 20;
  const w = Math.min(MAX_H2H_WEIGHT, (h2h.matches / FULL_WEIGHT_THRESHOLD) * MAX_H2H_WEIGHT);
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

  // ── Step 1: League-specific home advantage (learned override if available) ──
  // learnedHomeAdv is set from the adaptive engine after Step 4; for Step 3
  // we use the hardcoded table initially, then Step 7 applies any override.
  const homeAdv = getHomeAdvantage(leagueId);

  // ── Step 2: Form factors (recent form weighted by recency) ────────────────
  const homeFormFactor = formFactor(homeForm);
  const awayFormFactor = formFactor(awayForm);

  // ── Step 3: Normalised base xG (Dixon-Coles attack/defence vs league average)
  // Using league-average-normalised xG removes inter-league scoring bias so
  // that a mid-table Bundesliga team isn't systematically over-rated vs a
  // mid-table Serie A side purely because Bundesliga games score more.
  const { baseHomeXG, baseAwayXG } = computeNormalisedXG(
    homeGpg, homeCpg, awayGpg, awayCpg, leagueId, homeAdv,
  );
  const base = poissonProbs(baseHomeXG, baseAwayXG);

  // ── Step 4: Fetch all enhancement data in parallel ────────────────────────
  const [h2h, injuries, lineup, events, homeSquad, awaySquad, trainedPriors, homeComp, awayComp, adaptiveWeights] = await Promise.allSettled([
    fetchH2H(homeTeamId, awayTeamId),
    fetchInjuries(fixtureId, homeTeamId, awayTeamId),
    fetchLineup(fixtureId, homeTeamId, awayTeamId, leagueId),
    isLive || matchMinute != null
      ? fetchMatchEvents(fixtureId, isLive)
      : Promise.resolve([] as ApiEvent[]),
    fetchSquadStats(homeTeamId, leagueId),
    fetchSquadStats(awayTeamId, leagueId),
    getTrainedPriors(),
    fetchCompetitionRecord(homeTeamId, leagueId, true),
    fetchCompetitionRecord(awayTeamId, leagueId, false),
    getLearnedWeights(),
  ]);

  const h2hResult      = h2h.status          === "fulfilled" ? h2h.value          : null;
  const allInjuries    = injuries.status      === "fulfilled" ? injuries.value      : [] as AbsentPlayer[];
  const lineupResult   = lineup.status        === "fulfilled" ? lineup.value        : null;
  const eventsList     = events.status        === "fulfilled" ? events.value        : [] as ApiEvent[];
  const homeSquadMap   = homeSquad.status     === "fulfilled" ? homeSquad.value     : new Map<number, SquadPlayerStats>();
  const awaySquadMap   = awaySquad.status     === "fulfilled" ? awaySquad.value     : new Map<number, SquadPlayerStats>();
  const priors         = trainedPriors.status === "fulfilled" ? trainedPriors.value : NEUTRAL_PRIORS;
  const homeCompRecord = homeComp.status       === "fulfilled" ? homeComp.value       : null;
  const awayCompRecord = awayComp.status       === "fulfilled" ? awayComp.value       : null;
  const learnedWeights = adaptiveWeights.status === "fulfilled" ? adaptiveWeights.value : null;
  const homeCompFactor = homeCompRecord?.competition_factor ?? 1.0;
  const awayCompFactor = awayCompRecord?.competition_factor ?? 1.0;
  // Adaptive scale factors from the learning engine (default 1.0 when not yet learned)
  const formScale        = learnedWeights?.formFactorScale        ?? 1.0;
  const injuryScale      = learnedWeights?.injuryFactorScale      ?? 1.0;
  const lineupScale      = learnedWeights?.lineupFactorScale      ?? 1.0;
  const competitionScale = learnedWeights?.competitionFactorScale ?? 1.0;
  const adaptiveDrawNudge = learnedWeights?.drawNudgeWeight       ?? 0.10;
  // Learned league-level home advantage override (falls back to hardcoded table)
  const learnedHomeAdv   = learnedWeights?.leagueHomeAdvOverride?.[leagueId];

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

  // ── Step 7: Adjusted xG with adaptive factor scales ─────────────────────────
  // Each multiplicative factor is raised to the power of its learned scale.
  // scale=1.0 (default) leaves the factor unchanged.
  // scale>1.0 amplifies the factor; scale<1.0 dampens it.
  // The learned home advantage override replaces the hardcoded value when available.
  const effectiveHomeAdv = learnedHomeAdv ?? homeAdv;
  // Re-compute base xG with the effective home advantage
  const { baseHomeXG: effBaseHomeXG, baseAwayXG: effBaseAwayXG } = computeNormalisedXG(
    homeGpg, homeCpg, awayGpg, awayCpg, leagueId, effectiveHomeAdv,
  );
  // Apply adaptive scale to each factor (scale the deviation from 1.0, not the whole factor)
  const scaledHomeForm        = 1.0 + (homeFormFactor   - 1.0) * formScale;
  const scaledAwayForm        = 1.0 + (awayFormFactor   - 1.0) * formScale;
  const scaledHomeInjury      = 1.0 + (homeInjuryFactor - 1.0) * injuryScale;
  const scaledAwayInjury      = 1.0 + (awayInjuryFactor - 1.0) * injuryScale;
  const scaledHomeLineup      = 1.0 + (homeLineupFactor - 1.0) * lineupScale;
  const scaledAwayLineup      = 1.0 + (awayLineupFactor - 1.0) * lineupScale;
  const scaledHomeComp        = 1.0 + (homeCompFactor   - 1.0) * competitionScale;
  const scaledAwayComp        = 1.0 + (awayCompFactor   - 1.0) * competitionScale;
  const adjHomeXG = effBaseHomeXG * scaledHomeForm * scaledHomeLineup * scaledHomeInjury * scaledHomeComp;
  const adjAwayXG = effBaseAwayXG * scaledAwayForm * scaledAwayLineup * scaledAwayInjury * scaledAwayComp;
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

  // ── Step 8b: Trained-prior nudge with adaptive draw weight ──────────────────
  // The draw nudge weight is now learned from settled match data rather than
  // hardcoded. adaptiveDrawNudge starts at 0.10 and adjusts based on measured
  // draw bias in the prediction history.
  const nudged = applyPriorNudge(finalHome, finalDraw, finalAway, priors, adaptiveDrawNudge);
  finalHome = nudged.home;
  finalDraw = nudged.draw;
  finalAway = nudged.away;

  const markets = extendedPoissonMarkets(adjHomeXG, adjAwayXG);
  const confidence = confidenceFromModel(finalHome, finalDraw, finalAway, (lineupResult ? 3 : 0) + homeInjuries.length + awayInjuries.length + (h2hResult?.matches ?? 0), base.homeWin, base.draw, base.awayWin);
  const reasons = buildReasons({ homeFormFactor, awayFormFactor, homeInjuryFactor, awayInjuryFactor, homeLineupFactor, awayLineupFactor, homeXG: adjHomeXG, awayXG: adjAwayXG, h2h: h2hResult, homeName: homeTeamName, awayName: awayTeamName, homeComp: homeCompRecord, awayComp: awayCompRecord });
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
    home_competition:        homeCompRecord ?? undefined,
    away_competition:        awayCompRecord ?? undefined,
    home_competition_factor: round2(homeCompFactor),
    away_competition_factor: round2(awayCompFactor),
  };
}
