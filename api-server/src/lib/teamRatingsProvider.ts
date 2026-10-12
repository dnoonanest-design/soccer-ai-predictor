/**
 * Supplies fitted team ratings to the challenger models (plan steps 1-3).
 *
 * For every tracked domestic league it downloads the finished fixtures of the
 * current and previous season (one API call per league-season, cached) and
 * fits attack/defence ratings with teamRatings.fitTeamRatings. Results are
 * keyed by API-Football team id, so cup and UEFA matches can look up each
 * team's domestic rating and adjust for league strength.
 *
 * Plan step 3: where the app has stored final expected goals for a fixture
 * (deep_match_stats), the fit uses a 50/50 blend of goals and xG.
 */
import { pool } from "@workspace/db";
import { fetchFootball } from "./soccerService";
import { TRACKED_COMPETITIONS } from "./leagueConfig";
import { configuredFootballSeason } from "./season";
import { competitionStrengthIndex } from "./competitionStrength";
import { fitTeamRatings, expectedGoalsFromRatings, type FittedRatings, type RatingMatch } from "./teamRatings";
import { logger } from "./logger";

type ApiFixture = {
  fixture?: { id?: number; date?: string; status?: { short?: string } };
  teams?: { home?: { id?: number }; away?: { id?: number } };
  goals?: { home?: number | null; away?: number | null };
  score?: { fulltime?: { home?: number | null; away?: number | null } };
};

export type LeagueRatingSet = {
  leagueId: number;
  goals: FittedRatings;
  /** Goals/xG blend where xG is stored; null when no xG is available. */
  goalsXg: FittedRatings | null;
  xgFixtures: number;
  priors: { home: number; draw: number; away: number };
  fittedAt: number;
};

const REFRESH_MS = Number(process.env.TEAM_RATINGS_REFRESH_MS ?? 12 * 60 * 60_000);
const PREVIOUS_SEASON_TTL_MS = 7 * 24 * 60 * 60_000;
const FINISHED = new Set(["FT", "AET", "PEN"]);

const domesticLeagues = TRACKED_COMPETITIONS.filter((c) => c.kind === "league").map((c) => c.id);
const seasonCache = new Map<string, { fixtures: ApiFixture[]; fetchedAt: number }>();
let ratingSets = new Map<number, LeagueRatingSet>();
/** API-Football team id -> domestic league id it was rated in. */
let teamLeague = new Map<number, number>();
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;
let lastError: string | null = null;

async function loadSeason(leagueId: number, season: number, current: boolean): Promise<ApiFixture[]> {
  const key = `${leagueId}:${season}`;
  const cached = seasonCache.get(key);
  const ttl = current ? REFRESH_MS : PREVIOUS_SEASON_TTL_MS;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.fixtures;
  const data = await fetchFootball(`/fixtures?league=${leagueId}&season=${season}`);
  const fixtures = Array.isArray(data) ? (data as ApiFixture[]) : [];
  seasonCache.set(key, { fixtures, fetchedAt: Date.now() });
  return fixtures;
}

/** Regular-time score, so extra time never leaks into 90-minute ratings. */
function regularTimeScore(f: ApiFixture): { home: number; away: number } | null {
  const short = f.fixture?.status?.short ?? "";
  if (!FINISHED.has(short)) return null;
  const ft = f.score?.fulltime;
  const home = (short === "FT" ? f.goals?.home : ft?.home) ?? ft?.home;
  const away = (short === "FT" ? f.goals?.away : ft?.away) ?? ft?.away;
  return home == null || away == null ? null : { home, away };
}

async function storedFinalXg(fixtureIds: number[]): Promise<Map<number, { home: number; away: number }>> {
  const out = new Map<number, { home: number; away: number }>();
  if (!fixtureIds.length) return out;
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (fixture_id) fixture_id, home_xg, away_xg
         FROM deep_match_stats
        WHERE fixture_id = ANY($1::int[]) AND home_xg IS NOT NULL AND away_xg IS NOT NULL
        ORDER BY fixture_id, COALESCE(minute, 0) DESC, collected_at DESC`,
      [fixtureIds],
    );
    for (const row of result.rows) {
      const home = Number(row.home_xg), away = Number(row.away_xg);
      if (Number.isFinite(home) && Number.isFinite(away)) out.set(Number(row.fixture_id), { home, away });
    }
  } catch (err) {
    logger.warn({ err }, "team ratings: stored xG unavailable; fitting on goals only");
  }
  return out;
}

async function refreshAll(): Promise<void> {
  const season = configuredFootballSeason();
  const now = Date.now();
  const nextSets = new Map<number, LeagueRatingSet>();
  const nextTeamLeague = new Map<number, number>();
  for (const leagueId of domesticLeagues) {
    try {
      const fixtures = [
        ...(await loadSeason(leagueId, season - 1, false)),
        ...(await loadSeason(leagueId, season, true)),
      ];
      const rows: Array<RatingMatch & { id: number }> = [];
      for (const f of fixtures) {
        const score = regularTimeScore(f);
        const id = f.fixture?.id, home = f.teams?.home?.id, away = f.teams?.away?.id, date = f.fixture?.date;
        if (!score || id == null || home == null || away == null || !date) continue;
        rows.push({ id, home: String(home), away: String(away), homeGoals: score.home, awayGoals: score.away, date });
      }
      if (rows.length < 50) continue;
      const xg = await storedFinalXg(rows.map((r) => r.id));
      const goals = fitTeamRatings(rows, now);
      const goalsXg = xg.size >= 30
        ? fitTeamRatings(rows.map((r) => {
            const x = xg.get(r.id);
            return x ? { ...r, homeGoals: 0.5 * r.homeGoals + 0.5 * x.home, awayGoals: 0.5 * r.awayGoals + 0.5 * x.away } : r;
          }), now)
        : null;
      let h = 1, d = 1, a = 1;
      for (const r of rows.slice(-760)) { if (r.homeGoals > r.awayGoals) h++; else if (r.homeGoals === r.awayGoals) d++; else a++; }
      const t = h + d + a;
      nextSets.set(leagueId, { leagueId, goals, goalsXg, xgFixtures: xg.size, priors: { home: h / t, draw: d / t, away: a / t }, fittedAt: now });
      // Current-season membership wins over last season (promotion/relegation).
      const currentTeams = new Set(fixtures.filter((f) => String(f.fixture?.date ?? "") >= `${season}-07-01`).flatMap((f) => [f.teams?.home?.id, f.teams?.away?.id]));
      for (const id of currentTeams) if (id != null) nextTeamLeague.set(id, leagueId);
    } catch (err) {
      logger.warn({ err, leagueId }, "team ratings: league refresh failed; keeping previous fit");
      const previous = ratingSets.get(leagueId);
      if (previous) nextSets.set(leagueId, previous);
    }
  }
  for (const [id, lg] of teamLeague) if (!nextTeamLeague.has(id) && nextSets.has(lg)) nextTeamLeague.set(id, lg);
  ratingSets = nextSets;
  teamLeague = nextTeamLeague;
  lastRefresh = now;
  lastError = null;
  logger.info({ leagues: nextSets.size, teams: nextTeamLeague.size }, "team ratings refreshed");
}

export async function ensureTeamRatings(): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_MS && ratingSets.size > 0) return;
  if (!refreshing) {
    refreshing = refreshAll()
      .catch((err) => { lastError = err instanceof Error ? err.message : String(err); logger.warn({ err }, "team ratings refresh failed"); })
      .finally(() => { refreshing = null; });
  }
  await refreshing;
}

export function getLeagueRatingSet(leagueId: number): LeagueRatingSet | null {
  return ratingSets.get(leagueId) ?? null;
}

export type RatingForecast = {
  lambdaHome: number;
  lambdaAway: number;
  priors: { home: number; draw: number; away: number };
  homeAdvantageFactor: number;
  crossLeague: boolean;
};

/**
 * Expected goals for a fixture from fitted ratings, or null when either team
 * has no domestic rating (e.g. a UEFA opponent from an untracked league).
 * useXg: plan step 3 (goals/xG blend), falling back to goals-only ratings.
 */
export function forecastFromRatings(
  leagueId: number,
  homeTeamId: number,
  awayTeamId: number,
  useXg: boolean,
): RatingForecast | null {
  const pick = (set: LeagueRatingSet) => (useXg && set.goalsXg ? set.goalsXg : set.goals);
  const direct = ratingSets.get(leagueId);
  if (direct) {
    const r = pick(direct);
    const xg = expectedGoalsFromRatings(r, String(homeTeamId), String(awayTeamId));
    return { lambdaHome: xg.home, lambdaAway: xg.away, priors: direct.priors, homeAdvantageFactor: Math.exp(r.homeAdvantage), crossLeague: false };
  }
  // Cup or UEFA match: rate each team in its own league, then adjust for the
  // strength of those leagues (the "Manchester Rule", applied to ratings).
  const hl = teamLeague.get(homeTeamId), al = teamLeague.get(awayTeamId);
  if (hl == null || al == null) return null;
  const hs = ratingSets.get(hl), as = ratingSets.get(al);
  if (!hs || !as) return null;
  const hr = pick(hs), ar = pick(as);
  const ht = hr.teams.get(String(homeTeamId)), at = ar.teams.get(String(awayTeamId));
  if (!ht || !at) return null;
  const sH = Math.log(competitionStrengthIndex(hl)), sA = Math.log(competitionStrengthIndex(al));
  const mu = (hr.mu + ar.mu) / 2, h = (hr.homeAdvantage + ar.homeAdvantage) / 2;
  const lambdaHome = Math.exp(mu + h + (ht.attack + sH) - (at.defence + sA));
  const lambdaAway = Math.exp(mu + (at.attack + sA) - (ht.defence + sH));
  const priors = { home: (hs.priors.home + as.priors.home) / 2, draw: (hs.priors.draw + as.priors.draw) / 2, away: (hs.priors.away + as.priors.away) / 2 };
  return { lambdaHome, lambdaAway, priors, homeAdvantageFactor: Math.exp(h), crossLeague: true };
}

export function getTeamRatingsStatus() {
  return {
    leaguesFitted: ratingSets.size,
    teamsRated: teamLeague.size,
    lastRefreshAt: lastRefresh ? new Date(lastRefresh).toISOString() : null,
    lastError,
    leagues: [...ratingSets.values()].map((s) => ({
      leagueId: s.leagueId,
      matchesUsed: s.goals.matchesUsed,
      homeAdvantageFactor: Math.round(Math.exp(s.goals.homeAdvantage) * 1000) / 1000,
      goalsPerGameAway: Math.round(Math.exp(s.goals.mu) * 100) / 100,
      xgFixtures: s.xgFixtures,
      priors: s.priors,
    })),
  };
}
