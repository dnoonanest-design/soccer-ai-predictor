/**
 * Supplies fitted team ratings to the challenger models.
 *
 * - Tracked domestic leagues: finished fixtures of the current season and four
 *   previous ones (one API call per league-season, cached). Ratings use the
 *   most recent two seasons; the older ones train the step 7 model.
 * - Rating-only leagues: the domestic leagues that European and cup opponents
 *   come from (Belgium, Turkey, Scotland, ...), current and previous season,
 *   so cross-league matches can be rated. They are never predicted directly.
 * - Plan step 3: where the app stored final expected goals for a fixture
 *   (deep_match_stats), a goals/xG blend.
 * - Step 7: per-fixture shots from API-Football match statistics, backfilled
 *   20 fixtures per call into fixture_team_stats, give shot-based ratings and
 *   train a stacking model (stackingModel.ts).
 */
import { pool } from "@workspace/db";
import { fetchFootball } from "./soccerService";
import { TRACKED_COMPETITIONS, getTrackedCompetition } from "./leagueConfig";
import { configuredFootballSeason } from "./season";
import { competitionStrengthIndex } from "./competitionStrength";
import { fitTeamRatings, expectedGoalsFromRatings, type FittedRatings, type RatingMatch } from "./teamRatings";
import {
  fitShotConversion, fitSoftmax, goalRows, predictSoftmax, shotRows, stackFeatures, walkForwardRows,
  blendedLambdas, type Conversion, type SoftmaxModel, type StatFixture,
} from "./stackingModel";
import { logger } from "./logger";
import { getQuotaOptimizationStatus } from "./quotaOptimizationService";

type ApiFixture = {
  fixture?: { id?: number; date?: string; status?: { short?: string } };
  league?: { id?: number };
  teams?: { home?: { id?: number }; away?: { id?: number } };
  goals?: { home?: number | null; away?: number | null };
  score?: { fulltime?: { home?: number | null; away?: number | null } };
  statistics?: Array<{ team?: { id?: number }; statistics?: Array<{ type?: string; value?: unknown }> }>;
};

export type RatingKind = "goals" | "xg" | "shots";

export type LeagueRatingSet = {
  leagueId: number;
  goals: FittedRatings;
  /** Goals/xG blend where xG is stored; null when no xG is available. */
  goalsXg: FittedRatings | null;
  /** Ratings fitted on shot-based expected goals (step 7); null without shot data. */
  shots: FittedRatings | null;
  conversion: Conversion | null;
  xgFixtures: number;
  shotFixtures: number;
  priors: { home: number; draw: number; away: number };
  fittedAt: number;
  ratingOnly: boolean;
};

/**
 * Domestic leagues of frequent European and cup opponents (API-Football ids).
 * Used only to rate those teams in cross-league matches.
 */
export const RATING_ONLY_LEAGUES: ReadonlyArray<{ id: number; name: string; country: string }> = [
  { id: 144, name: "Jupiler Pro League", country: "Belgium" },
  { id: 203, name: "Super Lig", country: "Turkey" },
  { id: 179, name: "Premiership", country: "Scotland" },
  { id: 218, name: "Bundesliga", country: "Austria" },
  { id: 207, name: "Super League", country: "Switzerland" },
  { id: 119, name: "Superliga", country: "Denmark" },
  { id: 103, name: "Eliteserien", country: "Norway" },
  { id: 113, name: "Allsvenskan", country: "Sweden" },
  { id: 345, name: "Czech Liga", country: "Czech Republic" },
  { id: 197, name: "Super League 1", country: "Greece" },
  { id: 210, name: "HNL", country: "Croatia" },
  { id: 286, name: "Super Liga", country: "Serbia" },
  { id: 106, name: "Ekstraklasa", country: "Poland" },
  { id: 333, name: "Premier League", country: "Ukraine" },
  { id: 271, name: "NB I", country: "Hungary" },
  { id: 283, name: "Liga I", country: "Romania" },
  { id: 383, name: "Ligat Ha'al", country: "Israel" },
];

const REFRESH_MS = Number(process.env.TEAM_RATINGS_REFRESH_MS ?? 12 * 60 * 60_000);
const PREVIOUS_SEASON_TTL_MS = 7 * 24 * 60 * 60_000;
const TRAINING_SEASONS = Number(process.env.STACKING_TRAINING_SEASONS ?? 5);
const STATS_BACKFILL_CALLS_PER_RUN = Number(process.env.STATS_BACKFILL_CALLS_PER_RUN ?? 100);
const STATS_BACKFILL_MS = Number(process.env.STATS_BACKFILL_MS ?? 2 * 60 * 60_000);
const STATS_BACKFILL_MAX_UTILISATION_PCT = Number(process.env.STATS_BACKFILL_MAX_UTILISATION_PCT ?? 60);
const MIN_STACKING_ROWS = 3000;
const FINISHED = new Set(["FT", "AET", "PEN"]);
const WEEK_MS = 7 * 86_400_000;

const domesticLeagues = TRACKED_COMPETITIONS.filter((c) => c.kind === "league").map((c) => c.id);
const ratingOnlyIds = new Set(RATING_ONLY_LEAGUES.map((l) => l.id));

/** Only the fields the fit needs. */
type SlimFixture = { id: number; date: string; home: number; away: number; homeGoals: number; awayGoals: number };
/** fixtures = finished matches only; teams = every team on the season's schedule. */
const seasonCache = new Map<string, { fixtures: SlimFixture[]; teams: number[]; fetchedAt: number }>();
let ratingSets = new Map<number, LeagueRatingSet>();
/** API-Football team id -> domestic league id it was rated in. */
let teamLeague = new Map<number, number>();
let stacking: SoftmaxModel | null = null;
let stackingTrainedAt = 0;
let stackingTraining: Promise<void> | null = null;
/** Walk-forward rows per league and week; a past week's rows never change once its shots are known. */
const stackRowMemo = new Map<string, { x: number[][]; y: Array<0 | 1 | 2>; shotFixtures: number }>();
let lastRefresh = 0;
let refreshing: Promise<void> | null = null;
let lastError: string | null = null;
let backfillTimer: NodeJS.Timeout | null = null;
let backfillRunning = false;
let lastBackfill: { at: string; calls: number; stored: number; remaining: number; error: string | null } | null = null;

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

async function loadSeason(leagueId: number, season: number, current: boolean): Promise<{ fixtures: SlimFixture[]; teams: number[] }> {
  const key = `${leagueId}:${season}`;
  const cached = seasonCache.get(key);
  const ttl = current ? REFRESH_MS : PREVIOUS_SEASON_TTL_MS;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached;
  const data = await fetchFootball(`/fixtures?league=${leagueId}&season=${season}`);
  const raw = Array.isArray(data) ? (data as ApiFixture[]) : [];
  const fixtures: SlimFixture[] = [];
  const teams = new Set<number>();
  for (const f of raw) {
    if (f.teams?.home?.id != null) teams.add(f.teams.home.id);
    if (f.teams?.away?.id != null) teams.add(f.teams.away.id);
    const score = regularTimeScore(f);
    const id = f.fixture?.id, home = f.teams?.home?.id, away = f.teams?.away?.id, date = f.fixture?.date;
    if (!score || id == null || home == null || away == null || !date) continue;
    fixtures.push({ id, date, home, away, homeGoals: score.home, awayGoals: score.away });
  }
  const entry = { fixtures, teams: [...teams], fetchedAt: Date.now() };
  seasonCache.set(key, entry);
  return entry;
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

type StoredShots = { homeShots: number | null; awayShots: number | null; homeSot: number | null; awaySot: number | null };

async function storedShots(fixtureIds: number[]): Promise<Map<number, StoredShots>> {
  const out = new Map<number, StoredShots>();
  if (!fixtureIds.length) return out;
  try {
    const result = await pool.query(
      `SELECT fixture_id, home_shots, away_shots, home_shots_on_target, away_shots_on_target
         FROM fixture_team_stats WHERE fixture_id = ANY($1::int[])`,
      [fixtureIds],
    );
    const n = (v: unknown) => (v == null ? null : Number(v));
    for (const r of result.rows) {
      out.set(Number(r.fixture_id), { homeShots: n(r.home_shots), awayShots: n(r.away_shots), homeSot: n(r.home_shots_on_target), awaySot: n(r.away_shots_on_target) });
    }
  } catch (err) {
    logger.warn({ err }, "team ratings: shot statistics unavailable");
  }
  return out;
}

function statFixtures(leagueId: number, fixtures: SlimFixture[], shots: Map<number, StoredShots>): StatFixture[] {
  return fixtures.map((f) => {
    const s = shots.get(f.id);
    return { id: f.id, leagueId, date: f.date, home: f.home, away: f.away, homeGoals: f.homeGoals, awayGoals: f.awayGoals,
      homeShots: s?.homeShots ?? null, awayShots: s?.awayShots ?? null, homeSot: s?.homeSot ?? null, awaySot: s?.awaySot ?? null };
  });
}

async function loadLeague(leagueId: number, season: number, seasons: number) {
  const loaded: Array<{ season: number; fixtures: SlimFixture[]; teams: number[] }> = [];
  for (let s = season - seasons + 1; s <= season; s++) {
    try {
      loaded.push({ season: s, ...(await loadSeason(leagueId, s, s === season)) });
    } catch (err) {
      // Older seasons are optional (e.g. a league without coverage that far back).
      if (s === season || s === season - 1) throw err;
      logger.warn({ err, leagueId, season: s }, "team ratings: older season unavailable");
    }
  }
  return loaded;
}

async function refreshAll(): Promise<void> {
  const season = configuredFootballSeason();
  const now = Date.now();
  const nextSets = new Map<number, LeagueRatingSet>();
  const nextTeamLeague = new Map<number, number>();
  const trainingByLeague = new Map<number, StatFixture[]>();
  const leagues = [
    ...domesticLeagues.map((id) => ({ id, ratingOnly: false, seasons: TRAINING_SEASONS })),
    ...RATING_ONLY_LEAGUES.map((l) => ({ id: l.id, ratingOnly: true, seasons: 2 })),
  ];
  for (const { id: leagueId, ratingOnly, seasons } of leagues) {
    try {
      const loaded = await loadLeague(leagueId, season, seasons);
      const fixtures = loaded.flatMap((l) => l.fixtures);
      const currentSeason = loaded.find((l) => l.season === season);
      const recent = fixtures.filter((f) => now - Date.parse(f.date) <= 730 * 86_400_000);
      const rows: Array<RatingMatch & { id: number }> = recent.map((f) => ({
        id: f.id, home: String(f.home), away: String(f.away), homeGoals: f.homeGoals, awayGoals: f.awayGoals, date: f.date,
      }));
      if (rows.length < 50) continue;
      const xg = await storedFinalXg(rows.map((r) => r.id));
      const goals = fitTeamRatings(rows, now);
      const goalsXg = xg.size >= 30
        ? fitTeamRatings(rows.map((r) => {
            const x = xg.get(r.id);
            return x ? { ...r, homeGoals: 0.5 * r.homeGoals + 0.5 * x.home, awayGoals: 0.5 * r.awayGoals + 0.5 * x.away } : r;
          }), now)
        : null;
      const shots = await storedShots(fixtures.map((f) => f.id));
      const stat = statFixtures(leagueId, fixtures, shots);
      const conversion = fitShotConversion(stat);
      const recentShotRows = shotRows(stat.filter((f) => now - Date.parse(f.date) <= 730 * 86_400_000), conversion);
      const shotRatings = recentShotRows.length >= 150 ? fitTeamRatings(recentShotRows, now) : null;
      if (!ratingOnly) trainingByLeague.set(leagueId, stat);
      let h = 1, d = 1, a = 1;
      for (const r of rows.slice(-760)) { if (r.homeGoals > r.awayGoals) h++; else if (r.homeGoals === r.awayGoals) d++; else a++; }
      const t = h + d + a;
      nextSets.set(leagueId, {
        leagueId, goals, goalsXg, shots: shotRatings, conversion: shotRatings ? conversion : null,
        xgFixtures: xg.size, shotFixtures: recentShotRows.length,
        priors: { home: h / t, draw: d / t, away: a / t }, fittedAt: now, ratingOnly,
      });
      // Membership from the whole current-season schedule, including fixtures
      // not yet played (a newly promoted side may have few results so far).
      // Tracked leagues win over rating-only ones if a team appears in both.
      for (const id of currentSeason?.teams ?? []) {
        if (id == null) continue;
        if (ratingOnly && nextTeamLeague.has(id)) continue;
        nextTeamLeague.set(id, leagueId);
      }
    } catch (err) {
      logger.warn({ err, leagueId }, "team ratings: league refresh failed; keeping previous fit");
      const previous = ratingSets.get(leagueId);
      if (previous) nextSets.set(leagueId, previous);
    }
    await pause();
  }
  for (const [id, lg] of teamLeague) if (!nextTeamLeague.has(id) && nextSets.has(lg)) nextTeamLeague.set(id, lg);
  ratingSets = nextSets;
  teamLeague = nextTeamLeague;
  lastRefresh = now;
  lastError = null;
  logger.info({ leagues: nextSets.size, teams: nextTeamLeague.size }, "team ratings refreshed");
  // Training can take a while on first start; ratings are usable meanwhile.
  if (!stackingTraining) {
    stackingTraining = trainStacking(trainingByLeague, now)
      .catch((err) => logger.warn({ err }, "step 7 training failed"))
      .finally(() => { stackingTraining = null; });
  }
}

/** Test hook: wait for any step 7 training in progress. */
export async function __waitForStackingTraining() { await stackingTraining; }

/** Step 7: walk-forward rows from every tracked league, pooled, then a softmax fit. */
async function trainStacking(byLeague: Map<number, StatFixture[]>, now: number) {
  const xs: number[][] = [];
  const ys: Array<0 | 1 | 2> = [];
  const currentWeek = Math.floor(now / WEEK_MS) * WEEK_MS;
  for (const [leagueId, fixtures] of byLeague) {
    const withShots = fixtures.filter((f) => f.homeShots != null && f.homeSot != null);
    if (withShots.length < 300) continue;
    const conversion = fitShotConversion(fixtures);
    const first = Math.min(...fixtures.map((f) => Date.parse(f.date)));
    for (let week = Math.floor(first / WEEK_MS) * WEEK_MS; week < currentWeek; week += WEEK_MS) {
      const inWeek = fixtures.filter((f) => { const t = Date.parse(f.date); return t >= week && t < week + WEEK_MS; });
      const shotCount = inWeek.filter((f) => f.homeShots != null && f.homeSot != null).length;
      if (!shotCount) continue;
      const key = `${leagueId}:${week}`;
      let memo = stackRowMemo.get(key);
      if (!memo || memo.shotFixtures !== shotCount) {
        const prior = fixtures.filter((f) => Date.parse(f.date) < week + WEEK_MS);
        const r = await walkForwardRows(prior, week, week + WEEK_MS, conversion);
        memo = { x: r.x, y: r.y, shotFixtures: shotCount };
        stackRowMemo.set(key, memo);
        await pause();
      }
      xs.push(...memo.x); ys.push(...memo.y);
    }
  }
  if (xs.length < MIN_STACKING_ROWS) {
    logger.info({ rows: xs.length, needed: MIN_STACKING_ROWS }, "step 7: waiting for more shot statistics");
    return;
  }
  const model = fitSoftmax(xs, ys);
  if (model) {
    stacking = model;
    stackingTrainedAt = now;
    logger.info({ rows: model.samples }, "step 7 stacking model trained");
  }
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
  const set = ratingSets.get(leagueId);
  return set && !set.ratingOnly ? set : null;
}

// ── Shot statistics backfill (step 7) ────────────────────────────────────────

function statValue(list: Array<{ type?: string; value?: unknown }> | undefined, type: string): number | null {
  const v = list?.find((s) => s.type === type)?.value;
  if (v == null) return null;
  const n = Number(String(v).replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

export function parseFixtureStatistics(f: ApiFixture) {
  const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
  const side = (id: number | undefined) => f.statistics?.find((s) => s.team?.id === id)?.statistics;
  const h = side(homeId), a = side(awayId);
  return {
    homeShots: statValue(h, "Total Shots"), awayShots: statValue(a, "Total Shots"),
    homeSot: statValue(h, "Shots on Goal"), awaySot: statValue(a, "Shots on Goal"),
    homeCorners: statValue(h, "Corner Kicks"), awayCorners: statValue(a, "Corner Kicks"),
    homeXg: statValue(h, "expected_goals"), awayXg: statValue(a, "expected_goals"),
  };
}

/** Fetch match statistics for finished fixtures that have none stored yet. */
export async function backfillShotStatistics(maxCalls = STATS_BACKFILL_CALLS_PER_RUN) {
  if (backfillRunning) return lastBackfill;
  backfillRunning = true;
  let calls = 0, stored = 0, error: string | null = null, remaining = 0;
  try {
    await ensureTeamRatings();
    const wanted: Array<{ id: number; leagueId: number; season: number; f: SlimFixture }> = [];
    for (const [key, entry] of seasonCache) {
      const [leagueId, season] = key.split(":").map(Number);
      for (const f of entry.fixtures) wanted.push({ id: f.id, leagueId, season, f });
    }
    const have = new Set<number>();
    for (let i = 0; i < wanted.length; i += 5000) {
      const ids = wanted.slice(i, i + 5000).map((w) => w.id);
      const r = await pool.query(`SELECT fixture_id FROM fixture_team_stats WHERE fixture_id = ANY($1::int[])`, [ids]);
      for (const row of r.rows) have.add(Number(row.fixture_id));
    }
    // Newest first: recent matches matter most to the current ratings.
    const missing = wanted.filter((w) => !have.has(w.id)).sort((a, b) => Date.parse(b.f.date) - Date.parse(a.f.date));
    remaining = missing.length;
    const byId = new Map(missing.map((m) => [m.id, m]));
    for (let i = 0; i < missing.length && calls < maxCalls; i += 20) {
      // Live and pre-match work comes first: stop once 60% of today's budget is used.
      if (getQuotaOptimizationStatus().utilisationPct >= STATS_BACKFILL_MAX_UTILISATION_PCT) {
        error = `paused: API budget above ${STATS_BACKFILL_MAX_UTILISATION_PCT}% for today`;
        break;
      }
      const batch = missing.slice(i, i + 20);
      const data = await fetchFootball(`/fixtures?ids=${batch.map((b) => b.id).join("-")}`);
      calls++;
      const list = Array.isArray(data) ? (data as ApiFixture[]) : [];
      for (const f of list) {
        const meta = byId.get(Number(f.fixture?.id));
        if (!meta) continue;
        const s = parseFixtureStatistics(f);
        await pool.query(
          `INSERT INTO fixture_team_stats (fixture_id, league_id, season, kickoff_at, home_team_id, away_team_id, home_goals, away_goals,
             home_shots, away_shots, home_shots_on_target, away_shots_on_target, home_corners, away_corners, home_xg, away_xg)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (fixture_id) DO NOTHING`,
          [meta.id, meta.leagueId, meta.season, new Date(meta.f.date), meta.f.home, meta.f.away, meta.f.homeGoals, meta.f.awayGoals,
            s.homeShots, s.awayShots, s.homeSot, s.awaySot, s.homeCorners, s.awayCorners, s.homeXg, s.awayXg],
        );
        stored++;
        remaining--;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "shot statistics backfill failed");
  } finally {
    backfillRunning = false;
  }
  lastBackfill = { at: new Date().toISOString(), calls, stored, remaining, error };
  if (stored > 0) lastRefresh = 0; // refit with the new data on the next request
  return lastBackfill;
}

export function startShotStatisticsBackfill() {
  if (backfillTimer || process.env.STATS_BACKFILL_ENABLED === "false") return;
  const first = setTimeout(() => { void backfillShotStatistics(); }, 5 * 60_000);
  first.unref();
  backfillTimer = setInterval(() => { void backfillShotStatistics(); }, STATS_BACKFILL_MS);
  backfillTimer.unref();
}

export function stopShotStatisticsBackfill() {
  if (backfillTimer) clearInterval(backfillTimer);
  backfillTimer = null;
}

// ── Forecasts ────────────────────────────────────────────────────────────────

export type RatingForecast = {
  lambdaHome: number;
  lambdaAway: number;
  priors: { home: number; draw: number; away: number };
  homeAdvantageFactor: number;
  crossLeague: boolean;
};

function strengthIndex(leagueId: number): number {
  const extra = RATING_ONLY_LEAGUES.find((l) => l.id === leagueId);
  if (extra) return competitionStrengthIndex(leagueId, extra.name, extra.country);
  const tracked = getTrackedCompetition(leagueId);
  return competitionStrengthIndex(leagueId, tracked?.name ?? "", tracked?.country ?? "");
}

function pick(set: LeagueRatingSet, kind: RatingKind | boolean): FittedRatings | null {
  const k: RatingKind = kind === true ? "xg" : kind === false ? "goals" : kind;
  if (k === "xg") return set.goalsXg ?? set.goals;
  if (k === "shots") return set.shots;
  return set.goals;
}

/**
 * Expected goals for a fixture from fitted ratings, or null when either team
 * has no domestic rating. kind: "goals" (step 2), "xg" or true (step 3,
 * falling back to goals), "shots" (step 7 input; null without shot data).
 */
export function forecastFromRatings(
  leagueId: number,
  homeTeamId: number,
  awayTeamId: number,
  kind: RatingKind | boolean,
): RatingForecast | null {
  const direct = ratingSets.get(leagueId);
  if (direct && !direct.ratingOnly) {
    const r = pick(direct, kind);
    if (!r) return null;
    const xg = expectedGoalsFromRatings(r, String(homeTeamId), String(awayTeamId));
    return { lambdaHome: xg.home, lambdaAway: xg.away, priors: direct.priors, homeAdvantageFactor: Math.exp(r.homeAdvantage), crossLeague: false };
  }
  // Cup or UEFA match: rate each team in its own league, then adjust for the
  // strength of those leagues (the "Manchester Rule", applied to ratings).
  const hl = teamLeague.get(homeTeamId), al = teamLeague.get(awayTeamId);
  if (hl == null || al == null) return null;
  const hs = ratingSets.get(hl), as = ratingSets.get(al);
  if (!hs || !as) return null;
  const hr = pick(hs, kind), ar = pick(as, kind);
  if (!hr || !ar) return null;
  const ht = hr.teams.get(String(homeTeamId)), at = ar.teams.get(String(awayTeamId));
  if (!ht || !at) return null;
  const sH = Math.log(strengthIndex(hl)), sA = Math.log(strengthIndex(al));
  const mu = (hr.mu + ar.mu) / 2, h = (hr.homeAdvantage + ar.homeAdvantage) / 2;
  const lambdaHome = Math.exp(mu + h + (ht.attack + sH) - (at.defence + sA));
  const lambdaAway = Math.exp(mu + (at.attack + sA) - (ht.defence + sH));
  const priors = { home: (hs.priors.home + as.priors.home) / 2, draw: (hs.priors.draw + as.priors.draw) / 2, away: (hs.priors.away + as.priors.away) / 2 };
  return { lambdaHome, lambdaAway, priors, homeAdvantageFactor: Math.exp(h), crossLeague: true };
}

/** Step 7 forecast: stacking model on goal and shot strengths, plus goal-market strengths. */
export function forecastStacked(leagueId: number, homeTeamId: number, awayTeamId: number) {
  if (!stacking) return null;
  const g = forecastFromRatings(leagueId, homeTeamId, awayTeamId, "goals");
  const s = forecastFromRatings(leagueId, homeTeamId, awayTeamId, "shots");
  if (!g || !s) return null;
  const features = [Math.log(g.lambdaHome), Math.log(g.lambdaAway), Math.log(s.lambdaHome), Math.log(s.lambdaAway)];
  return { probs: predictSoftmax(stacking, features), lambdas: blendedLambdas(features) };
}

export function getTeamRatingsStatus() {
  const sets = [...ratingSets.values()];
  return {
    leaguesFitted: sets.filter((s) => !s.ratingOnly).length,
    ratingOnlyLeaguesFitted: sets.filter((s) => s.ratingOnly).length,
    teamsRated: teamLeague.size,
    lastRefreshAt: lastRefresh ? new Date(lastRefresh).toISOString() : null,
    lastError,
    shotStatistics: {
      fixturesWithShots: sets.reduce((sum, s) => sum + s.shotFixtures, 0),
      lastBackfill,
      stackingModel: stacking ? { trainedAt: new Date(stackingTrainedAt).toISOString(), trainingMatches: stacking.samples } : null,
      stackingNeeds: MIN_STACKING_ROWS,
    },
    leagues: sets.map((s) => ({
      leagueId: s.leagueId,
      ratingOnly: s.ratingOnly,
      matchesUsed: s.goals.matchesUsed,
      homeAdvantageFactor: Math.round(Math.exp(s.goals.homeAdvantage) * 1000) / 1000,
      goalsPerGameAway: Math.round(Math.exp(s.goals.mu) * 100) / 100,
      xgFixtures: s.xgFixtures,
      shotFixtures: s.shotFixtures,
      priors: s.priors,
    })),
  };
}

// Kept for callers that only need the stats-leagues list in tests and docs.
export const STATS_LEAGUE_IDS = [...domesticLeagues, ...ratingOnlyIds];
// Re-export for tests.
export { goalRows };
