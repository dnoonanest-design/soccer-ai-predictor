import { db, factorLearningInsights, matchCircumstances, playerMatchFactors } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Match } from "./soccerService";
import { getMatchEvents, type MatchEvent } from "./eventsService";
import { logger } from "./logger";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const CIRCUMSTANCE_CACHE_MS = Math.max(60_000, Number(process.env.CIRCUMSTANCE_CACHE_MS ?? 15 * 60_000));
const MIN_FACTOR_SAMPLE = Math.max(20, Number(process.env.MIN_FACTOR_SAMPLE ?? 40));

type CacheEntry<T> = { data: T; fetchedAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CIRCUMSTANCE_CACHE_MS) return null;
  return entry.data;
}
function setCached<T>(key: string, data: T) { cache.set(key, { data, fetchedAt: Date.now() }); }

async function fetchFootball<T>(path: string, fallback: T): Promise<T> {
  const cached = getCached<T>(path);
  if (cached) return cached;
  if (!API_FOOTBALL_KEY) return fallback;
  try {
    await waitForRateLimit();
    const res = await fetch(`${API_FOOTBALL_BASE}${path}`, { headers: { "x-apisports-key": API_FOOTBALL_KEY } });
    if (!res.ok) {
      logger.warn({ status: res.status, path }, "circumstance API-Football request failed");
      return fallback;
    }
    const json = await res.json() as { response?: T };
    const data = json.response ?? fallback;
    setCached(path, data);
    return data;
  } catch (err) {
    logger.warn({ err, path }, "circumstance API-Football request errored");
    return fallback;
  }
}

function n(v: unknown): number | null {
  if (v == null) return null;
  const parsed = typeof v === "string" ? Number(v.replace("%", "")) : Number(v);
  return Number.isFinite(parsed) ? parsed : null;
}
function safeInt(v: unknown): number { return Math.max(0, Math.round(n(v) ?? 0)); }
function avg(values: Array<number | null | undefined>): number | null {
  const usable = values.filter((v): v is number => Number.isFinite(Number(v))).map(Number);
  if (!usable.length) return null;
  return Math.round((usable.reduce((a, b) => a + b, 0) / usable.length) * 100) / 100;
}
function formScore(form?: string | null): number | null {
  if (!form) return null;
  const chars = form.toUpperCase().split("").filter((c) => ["W", "D", "L"].includes(c)).slice(-8);
  if (!chars.length) return null;
  const score = chars.reduce((sum, c, idx) => sum + (c === "W" ? 3 : c === "D" ? 1 : 0) * (1 + idx / 10), 0);
  const max = chars.reduce((sum, _c, idx) => sum + 3 * (1 + idx / 10), 0);
  return Math.round((score / Math.max(1, max)) * 1000) / 10;
}

type ApiLineup = { team?: { id?: number; name?: string }; formation?: string; startXI?: Array<{ player?: { id?: number; name?: string; pos?: string; grid?: string } }>; substitutes?: Array<{ player?: { id?: number; name?: string; pos?: string } }> };
type ApiInjury = { team?: { id?: number; name?: string }; player?: { id?: number; name?: string; type?: string; reason?: string } };
type ApiPlayerStats = { team?: { id?: number; name?: string }; players?: Array<{ player?: { id?: number; name?: string }; statistics?: Array<any> }> };

function eventCounts(events: MatchEvent[], side: "home" | "away") {
  const mine = events.filter((e) => e.team_side === side);
  return {
    yellow: mine.filter((e) => e.type === "yellow_card").length,
    red: mine.filter((e) => e.type === "red_card" || e.type === "yellow_red_card").length,
    injurySubs: mine.filter((e) => e.type === "substitution" && `${e.detail} ${e.comments ?? ""}`.toLowerCase().includes("injur")).length,
    goalContributors: new Set(mine.filter((e) => e.type === "goal").flatMap((e) => [e.player, e.assist].filter(Boolean) as string[])).size,
  };
}

function teamLineup(lineups: ApiLineup[], teamId: number, teamName: string) {
  return lineups.find((l) => l.team?.id === teamId) ?? lineups.find((l) => (l.team?.name ?? "").toLowerCase() === teamName.toLowerCase());
}
function teamInjuries(injuries: ApiInjury[], teamId: number) { return injuries.filter((i) => i.team?.id === teamId); }
function teamPlayers(players: ApiPlayerStats[], teamId: number) { return players.find((p) => p.team?.id === teamId); }

function playerRating(stat: any): number | null { return n(stat?.games?.rating); }
function influenceFromStat(stat: any): number {
  const rating = playerRating(stat) ?? 6;
  const goals = safeInt(stat?.goals?.total);
  const assists = safeInt(stat?.goals?.assists);
  const shots = safeInt(stat?.shots?.total);
  const keyPasses = safeInt(stat?.passes?.key);
  const red = safeInt(stat?.cards?.red);
  const yellow = safeInt(stat?.cards?.yellow);
  return Math.round((rating * 3 + goals * 8 + assists * 6 + shots * 0.8 + keyPasses * 1.2 - red * 10 - yellow * 2) * 10) / 10;
}

async function savePlayerFactors(match: Match, lineups: ApiLineup[], injuries: ApiInjury[], playerStats: ApiPlayerStats[], events: MatchEvent[]) {
  const rows: any[] = [];
  for (const side of ["home", "away"] as const) {
    const team = side === "home" ? match.home_team : match.away_team;
    const lineup = teamLineup(lineups, team.id, team.name);
    const injuryNames = new Set(teamInjuries(injuries, team.id).map((i) => (i.player?.name ?? "").toLowerCase()).filter(Boolean));
    const injuryEventNames = new Set(events.filter((e) => e.team_side === side && e.type === "substitution" && `${e.detail} ${e.comments ?? ""}`.toLowerCase().includes("injur")).map((e) => (e.player ?? "").toLowerCase()).filter(Boolean));
    const starterNames = new Set((lineup?.startXI ?? []).map((x) => x.player?.name).filter(Boolean).map((x) => String(x).toLowerCase()));
    const stats = teamPlayers(playerStats, team.id)?.players ?? [];
    for (const p of stats) {
      const stat = p.statistics?.[0] ?? {};
      const name = p.player?.name ?? "Unknown";
      rows.push({
        fixtureId: match.id,
        teamSide: side,
        teamName: team.name,
        playerId: p.player?.id ?? null,
        playerName: name,
        role: starterNames.has(name.toLowerCase()) ? "starter" : "squad",
        position: stat?.games?.position ?? null,
        starter: starterNames.has(name.toLowerCase()),
        captain: Boolean(stat?.games?.captain),
        rating: playerRating(stat),
        minutes: n(stat?.games?.minutes),
        goals: safeInt(stat?.goals?.total),
        assists: safeInt(stat?.goals?.assists),
        shots: safeInt(stat?.shots?.total),
        keyPasses: safeInt(stat?.passes?.key),
        yellowCards: safeInt(stat?.cards?.yellow),
        redCards: safeInt(stat?.cards?.red),
        injuredDuringMatch: injuryEventNames.has(name.toLowerCase()),
        missingBeforeMatch: injuryNames.has(name.toLowerCase()),
        influenceScore: influenceFromStat(stat),
        rawJson: { player: p.player, statistics: p.statistics },
      });
    }
    for (const missing of injuryNames) {
      if (!rows.some((r) => r.fixtureId === match.id && r.teamSide === side && r.playerName.toLowerCase() === missing)) {
        rows.push({ fixtureId: match.id, teamSide: side, teamName: team.name, playerName: missing, missingBeforeMatch: true, influenceScore: -5, rawJson: {} });
      }
    }
  }
  for (const row of rows.slice(0, 80)) {
    try {
      await db.insert(playerMatchFactors).values(row).onConflictDoUpdate({
        target: [playerMatchFactors.fixtureId, playerMatchFactors.teamSide, playerMatchFactors.playerName],
        set: { ...row, collectedAt: new Date() },
      });
    } catch (err) { logger.warn({ err, fixtureId: match.id }, "failed to store player factor"); }
  }
}

export async function collectMatchCircumstances(match: Match, homeForm?: string | null, awayForm?: string | null) {
  const lineups = await fetchFootball<ApiLineup[]>(`/fixtures/lineups?fixture=${match.id}`, []);
  const injuries = await fetchFootball<ApiInjury[]>(`/injuries?fixture=${match.id}`, []);
  const playerStats = await fetchFootball<ApiPlayerStats[]>(`/fixtures/players?fixture=${match.id}`, []);
  const events = await getMatchEvents(match.id, match.home_team.id).catch(() => [] as MatchEvent[]);

  const homeLineup = teamLineup(lineups, match.home_team.id, match.home_team.name);
  const awayLineup = teamLineup(lineups, match.away_team.id, match.away_team.name);
  const homeInjuries = teamInjuries(injuries, match.home_team.id);
  const awayInjuries = teamInjuries(injuries, match.away_team.id);
  const homeEvents = eventCounts(events, "home");
  const awayEvents = eventCounts(events, "away");
  const homeStats = teamPlayers(playerStats, match.home_team.id)?.players ?? [];
  const awayStats = teamPlayers(playerStats, match.away_team.id)?.players ?? [];
  const homeRatings = homeStats.map((p) => playerRating(p.statistics?.[0] ?? {}));
  const awayRatings = awayStats.map((p) => playerRating(p.statistics?.[0] ?? {}));
  const homeInfluence = homeStats.map((p) => influenceFromStat(p.statistics?.[0] ?? {}));
  const awayInfluence = awayStats.map((p) => influenceFromStat(p.statistics?.[0] ?? {}));
  const hForm = formScore(homeForm);
  const aForm = formScore(awayForm);

  const homeScore = Math.round(((avg(homeInfluence) ?? 0) + (hForm ?? 50) * 0.25 + homeEvents.goalContributors * 4 - homeInjuries.length * 2 - homeEvents.red * 12 - homeEvents.injurySubs * 5) * 10) / 10;
  const awayScore = Math.round(((avg(awayInfluence) ?? 0) + (aForm ?? 50) * 0.25 + awayEvents.goalContributors * 4 - awayInjuries.length * 2 - awayEvents.red * 12 - awayEvents.injurySubs * 5) * 10) / 10;

  const values = {
    fixtureId: match.id,
    leagueId: match.league_id ?? null,
    homeTeam: match.home_team.name,
    awayTeam: match.away_team.name,
    status: match.status,
    minute: match.minute ?? null,
    homeFormation: homeLineup?.formation ?? null,
    awayFormation: awayLineup?.formation ?? null,
    homeStartingXiCount: homeLineup?.startXI?.length ?? null,
    awayStartingXiCount: awayLineup?.startXI?.length ?? null,
    homeMissingPlayers: homeInjuries.length,
    awayMissingPlayers: awayInjuries.length,
    homeStartersOut: homeInjuries.filter((i) => i.player?.type || i.player?.reason).length,
    awayStartersOut: awayInjuries.filter((i) => i.player?.type || i.player?.reason).length,
    homeYellowCards: homeEvents.yellow,
    awayYellowCards: awayEvents.yellow,
    homeRedCards: homeEvents.red,
    awayRedCards: awayEvents.red,
    homeInMatchInjuries: homeEvents.injurySubs,
    awayInMatchInjuries: awayEvents.injurySubs,
    homeGoalContributionPlayers: homeEvents.goalContributors,
    awayGoalContributionPlayers: awayEvents.goalContributors,
    homeAvgPlayerRating: avg(homeRatings),
    awayAvgPlayerRating: avg(awayRatings),
    homeStarPlayerRating: homeRatings.filter((x): x is number => x != null).sort((a, b) => b - a)[0] ?? null,
    awayStarPlayerRating: awayRatings.filter((x): x is number => x != null).sort((a, b) => b - a)[0] ?? null,
    homeFormScore: hForm,
    awayFormScore: aForm,
    circumstanceScoreHome: homeScore,
    circumstanceScoreAway: awayScore,
    rawLineupsJson: lineups as any,
    rawInjuriesJson: injuries as any,
    rawPlayersJson: playerStats as any,
    rawEventsJson: events as any,
    updatedAt: new Date(),
  };

  await db.insert(matchCircumstances).values(values).onConflictDoUpdate({
    target: matchCircumstances.fixtureId,
    set: values,
  });
  await savePlayerFactors(match, lineups, injuries, playerStats, events);
  return values;
}

function normalise(home: number, draw: number, away: number) {
  const raw = [home, draw, away].map((v) => Number.isFinite(v) && v > 0 ? v : 0.001);
  const total = raw.reduce((sum, value) => sum + value, 0);
  let h = Math.round((raw[0] / total) * 10000) / 100;
  let d = Math.round((raw[1] / total) * 10000) / 100;
  let a = Math.round((100 - h - d) * 100) / 100;
  if (!Number.isFinite(a) || a < 0) {
    const renorm = [h, d, Math.max(0.01, a)].map((v) => Math.max(0.01, v));
    const rt = renorm.reduce((sum, value) => sum + value, 0);
    h = Math.round((renorm[0] / rt) * 10000) / 100;
    d = Math.round((renorm[1] / rt) * 10000) / 100;
    a = Math.round((100 - h - d) * 100) / 100;
  }
  return { home: h, draw: d, away: a };
}

export async function applyCircumstanceCalibration(match: Match, probs: { home: number; draw: number; away: number }) {
  try {
    const rows = await db.select().from(matchCircumstances).where(eq(matchCircumstances.fixtureId, match.id)).limit(1);
    const c = rows[0];
    if (!c) return { ...probs, adjustment: null };
    const learnedRows = await db.select().from(factorLearningInsights).where(and(eq(factorLearningInsights.active, true), sql`${factorLearningInsights.factorName} IN ('circumstance_score_delta','red_card_delta','injury_delta','star_rating_delta','form_score_delta')`)).orderBy(desc(factorLearningInsights.createdAt)).limit(10);
    const weights = new Map(learnedRows.map((r) => [r.factorName, Number(r.learnedWeight ?? 0)]));
    const scoreDelta = Number(c.circumstanceScoreHome ?? 0) - Number(c.circumstanceScoreAway ?? 0);
    const redDelta = Number(c.awayRedCards ?? 0) - Number(c.homeRedCards ?? 0);
    const injuryDelta = (Number(c.awayMissingPlayers ?? 0) + Number(c.awayInMatchInjuries ?? 0) * 2) - (Number(c.homeMissingPlayers ?? 0) + Number(c.homeInMatchInjuries ?? 0) * 2);
    const starDelta = Number(c.homeStarPlayerRating ?? 0) - Number(c.awayStarPlayerRating ?? 0);
    const formDelta = Number(c.homeFormScore ?? 50) - Number(c.awayFormScore ?? 50);
    const homeBoost = Math.max(-8, Math.min(8,
      scoreDelta * (weights.get('circumstance_score_delta') || 0.035) +
      redDelta * (weights.get('red_card_delta') || 4.0) +
      injuryDelta * (weights.get('injury_delta') || 0.45) +
      starDelta * (weights.get('star_rating_delta') || 1.1) +
      formDelta * (weights.get('form_score_delta') || 0.035)
    ));
    const awayBoost = -homeBoost;
    const drawShift = -Math.abs(homeBoost) * 0.2;
    return { ...normalise(probs.home + homeBoost, probs.draw + drawShift, probs.away + awayBoost), adjustment: { homeBoost, factors: { scoreDelta, redDelta, injuryDelta, starDelta, formDelta } } };
  } catch (err) {
    logger.warn({ err, fixtureId: match.id }, "circumstance calibration failed");
    return { ...probs, adjustment: null };
  }
}

export async function analyzeCircumstanceInfluence() {
  const rows = await db.execute(sql`
    WITH joined AS (
      SELECT c.*, o.outcome, o.score_home, o.score_away,
        CASE WHEN o.score_home > o.score_away THEN 1 WHEN o.score_home = o.score_away THEN 0 ELSE -1 END AS home_result,
        (o.score_home - o.score_away) AS goal_diff
      FROM match_circumstances c
      JOIN match_outcomes o ON o.fixture_id = c.fixture_id
    ), factors AS (
      SELECT 'circumstance_score_delta' AS factor_name, 'team_context' AS factor_group, league_id,
        (circumstance_score_home - circumstance_score_away) AS value, home_result, goal_diff FROM joined
      UNION ALL SELECT 'red_card_delta', 'discipline', league_id, (away_red_cards - home_red_cards), home_result, goal_diff FROM joined
      UNION ALL SELECT 'injury_delta', 'availability', league_id, ((away_missing_players + away_in_match_injuries * 2) - (home_missing_players + home_in_match_injuries * 2)), home_result, goal_diff FROM joined
      UNION ALL SELECT 'star_rating_delta', 'player_quality', league_id, (COALESCE(home_star_player_rating,0) - COALESCE(away_star_player_rating,0)), home_result, goal_diff FROM joined
      UNION ALL SELECT 'form_score_delta', 'team_form', league_id, (COALESCE(home_form_score,50) - COALESCE(away_form_score,50)), home_result, goal_diff FROM joined
    )
    SELECT factor_name, factor_group, league_id,
      COUNT(*)::int AS sample_size,
      AVG(CASE WHEN value > 0 THEN CASE WHEN home_result = 1 THEN 1 ELSE 0 END END)::float AS win_rate_when_positive,
      AVG(CASE WHEN value < 0 THEN CASE WHEN home_result = -1 THEN 1 ELSE 0 END END)::float AS win_rate_when_negative,
      AVG(CASE WHEN value <> 0 THEN goal_diff * CASE WHEN value > 0 THEN 1 ELSE -1 END END)::float AS avg_goal_diff_impact,
      CASE WHEN stddev_pop(value) = 0 THEN 0 ELSE corr(value, goal_diff) END::float AS correlation
    FROM factors
    WHERE value IS NOT NULL
    GROUP BY factor_name, factor_group, league_id
    HAVING COUNT(*) >= ${MIN_FACTOR_SAMPLE}
  `);

  const resultRows = Array.isArray((rows as any).rows) ? (rows as any).rows : (rows as any);
  let stored = 0;
  await db.update(factorLearningInsights).set({ active: false }).where(eq(factorLearningInsights.active, true));
  for (const r of resultRows) {
    const corr = Number(r.correlation ?? 0);
    const impact = Number(r.avg_goal_diff_impact ?? 0);
    const sample = Number(r.sample_size ?? 0);
    const learnedWeight = Math.max(-5, Math.min(5, corr * 2.5 + impact * 0.35));
    const confidence = Math.min(95, Math.round(Math.sqrt(sample) * Math.min(1, Math.abs(corr) + Math.abs(impact) / 5) * 20));
    await db.insert(factorLearningInsights).values({
      factorName: String(r.factor_name), factorGroup: String(r.factor_group), leagueId: r.league_id ?? null,
      sampleSize: sample, winRateWhenPositive: n(r.win_rate_when_positive), winRateWhenNegative: n(r.win_rate_when_negative),
      avgGoalDiffImpact: n(r.avg_goal_diff_impact), correlation: n(r.correlation), learnedWeight, confidence,
      notes: `Auto-learned from ${sample} settled matches. Positive values favour home; negative values favour away.`, active: true,
    });
    stored++;
  }
  return { analysed: resultRows.length, stored, minSample: MIN_FACTOR_SAMPLE };
}

export async function getCircumstanceLearningReport() {
  const [recentInsights, recentCircumstances] = await Promise.all([
    db.select().from(factorLearningInsights).where(eq(factorLearningInsights.active, true)).orderBy(desc(factorLearningInsights.createdAt)).limit(50),
    db.select().from(matchCircumstances).orderBy(desc(matchCircumstances.updatedAt)).limit(20),
  ]);
  return { recentInsights, recentCircumstances };
}
