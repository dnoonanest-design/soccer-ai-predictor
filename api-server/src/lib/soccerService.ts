import { logger } from "./logger";
import { waitForRateLimit } from "./rateLimiter";
import { getOddsSportKeyForLeague, isTrackedLeague } from "./leagueConfig";
import {
  isApiFootballProviderError,
  markApiFootballFailure,
  markApiFootballSuccess,
} from "./apiFootballReliability";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
const SEASON = process.env.FOOTBALL_SEASON ?? String(new Date().getUTCFullYear());
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

// Per-endpoint cache TTLs (ms). The bookmaker cache is intentionally longer
// than the match cache: market snapshots are stored in 30-minute buckets and
// there is no value in consuming odds-provider quota on every dashboard poll.
const CACHE_TTL = {
  live_fixtures: 30_000,
  soccer_odds: Math.max(
    60_000,
    Number(process.env.ODDS_CACHE_TTL_MS ?? 5 * 60_000),
  ),
  today_fixtures: 300_000,
  team_stats: 3_600_000,
  standings: 3_600_000,
  h2h: 86_400_000,
  player_stats: 60_000,
};

type CacheEntry<T> = { data: T; fetchedAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string, ttl: number): T | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttl) return null;
  return entry.data;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}
/**
 * Resolve the active season for a given league/competition.
 * Queries API-Football's current season first (most accurate, cached 24h).
 * Falls back to configured FOOTBALL_SEASON env var if set.
 * Finally falls back to computing from calendar year (seasons run Sep-Aug).
 * Results cached for 24 hours per competition ID.
 */
export async function resolveSeasonForCompetition(leagueId: number): Promise<number> {
  const cacheKey = `league_current_season:${leagueId}`;
  const cached = getCached<number>(cacheKey, 24 * 3600_000);
  if (cached !== null) return cached;

  // First: Try to fetch current season from API-Football (most authoritative)
  try {
    const leagueData = (await fetchFootball(`/leagues?id=${leagueId}&current=true`)) as Array<{
      season: number;
    }> | null;

    if (Array.isArray(leagueData) && leagueData[0]?.season) {
      const season = leagueData[0].season;
      setCache(cacheKey, season);
      logger.debug({ leagueId, season }, "Resolved season from API-Football current");
      return season;
    }
  } catch (err) {
    // Provider outages/auth failures must not be hidden by a guessed season.
    if (isApiFootballProviderError(err)) throw err;
    logger.debug({ err, leagueId }, "Failed to resolve current season from API-Football, trying fallback");
  }

  // Second: Use configured FOOTBALL_SEASON if explicitly set
  const configuredSeason = Number(SEASON);
  if (Number.isInteger(configuredSeason) && configuredSeason > 2000 && configuredSeason.toString() === SEASON) {
    setCache(cacheKey, configuredSeason);
    logger.debug({ leagueId, season: configuredSeason }, "Using configured FOOTBALL_SEASON");
    return configuredSeason;
  }

  // Third: Compute from calendar year (seasons run Sep-Aug)
  const now = new Date();
  const month = now.getUTCMonth(); // 0=Jan, 11=Dec
  const year = now.getUTCFullYear();
  const fallbackSeason = month < 8 ? year - 1 : year;
  setCache(cacheKey, fallbackSeason);
  logger.debug({ leagueId, season: fallbackSeason }, "Computed season from calendar year");
  return fallbackSeason;
}

let _liveMatchCount = 0;
export function hasLiveMatches(): boolean {
  return _liveMatchCount > 0;
}

interface ApiFootballEnvelope {
  get: string;
  parameters: Record<string, string | number>;
  errors?: string[] | Record<string, string>;
  results: number;
  paging?: { current: number; total: number };
  response: unknown;
}

interface ApiFootballDiagnostics {
  path: string;
  results: number;
  errors: string[];
  rateLimitDaily?: { remaining: number; limit: number };
  rateLimitMinute?: { remaining: number; limit: number };
  responseSeconds?: number;
}

let lastApiFootballDiagnostics: ApiFootballDiagnostics | null = null;

export function getLastApiFootballDiagnostics(): ApiFootballDiagnostics | null {
  return lastApiFootballDiagnostics;
}

function normalizeApiErrors(errors: ApiFootballEnvelope["errors"]): string[] {
  if (Array.isArray(errors)) return errors.map(String).filter(Boolean);
  if (errors && typeof errors === "object") {
    return Object.values(errors)
      .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
      .filter(Boolean);
  }
  if (errors) return [String(errors)];
  return [];
}

export async function fetchFootball(path: string): Promise<unknown> {
  if (!API_FOOTBALL_KEY) {
    throw markApiFootballFailure({
      path,
      message: "API_FOOTBALL_KEY not set",
      kind: "configuration",
      state: "offline",
    });
  }

  const url = `${API_FOOTBALL_BASE}${path}`;
  const startMs = Date.now();
  let res: Response;

  try {
    await waitForRateLimit();
    res = await fetch(url, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
    });
  } catch (err) {
    if (isApiFootballProviderError(err)) throw err;
    throw markApiFootballFailure({
      path,
      message: `API-Football transport failure: ${err instanceof Error ? err.message : String(err)}`,
      kind: "transport",
      state: "degraded",
    });
  }

  const responseMs = Date.now() - startMs;

  if (!res.ok) {
    throw markApiFootballFailure({
      path,
      message: `API-Football HTTP ${res.status}`,
      httpStatus: res.status,
    });
  }

  let json: ApiFootballEnvelope;
  try {
    json = (await res.json()) as ApiFootballEnvelope;
  } catch (err) {
    throw markApiFootballFailure({
      path,
      message: `API-Football returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      kind: "malformed_response",
      state: "degraded",
    });
  }

  if (!json || typeof json !== "object" || !("response" in json)) {
    throw markApiFootballFailure({
      path,
      message: "API-Football response envelope is missing the response field",
      kind: "malformed_response",
      state: "degraded",
    });
  }

  const apiErrors = normalizeApiErrors(json.errors);

  // Extract diagnostics from response headers and envelope
  const diagnostics: ApiFootballDiagnostics = {
    path,
    results: json.results ?? 0,
    errors: apiErrors,
    responseSeconds: Math.round(responseMs / 1000),
  };

  // Parse rate limit headers (API-Football v3 official headers, case-insensitive)
  // Daily: x-ratelimit-requests-limit / x-ratelimit-requests-remaining
  const rateLimitDaily = res.headers.get("x-ratelimit-requests-limit");
  const rateLimitDailyRemaining = res.headers.get("x-ratelimit-requests-remaining");
  if (rateLimitDaily && rateLimitDailyRemaining) {
    diagnostics.rateLimitDaily = {
      limit: Number(rateLimitDaily),
      remaining: Number(rateLimitDailyRemaining),
    };
  }

  // Per-minute: x-ratelimit-limit / x-ratelimit-remaining
  const rateLimitMinute = res.headers.get("x-ratelimit-limit");
  const rateLimitMinuteRemaining = res.headers.get("x-ratelimit-remaining");
  if (rateLimitMinute && rateLimitMinuteRemaining) {
    diagnostics.rateLimitMinute = {
      limit: Number(rateLimitMinute),
      remaining: Number(rateLimitMinuteRemaining),
    };
  }

  lastApiFootballDiagnostics = diagnostics;

  // API-Football commonly reports subscription/auth failures inside a HTTP 200
  // envelope. Treat any envelope error as a provider failure, never as zero data.
  if (apiErrors.length > 0) {
    const message = apiErrors.join("; ");
    throw markApiFootballFailure({
      path,
      message,
    });
  }

  markApiFootballSuccess(path);

  if (json.results === 0) {
    logger.debug({ path }, "API-Football returned a valid zero-result response");
  }

  return json.response;
}

export interface Team {
  id: number;
  name: string;
  logo: string | null;
}

export interface Odds {
  home_win: number | null;
  draw: number | null;
  away_win: number | null;
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
}

export interface Score {
  home: number | null;
  away: number | null;
}

export interface Match {
  id: number;
  league_id: number;
  league_name: string;
  league_logo: string | null;
  country: string;
  home_team: Team;
  away_team: Team;
  status: string;
  status_detail: string;
  minute: number | null;
  score: Score;
  score_ht: Score | null;
  kickoff: string;
  odds: Odds;
}

export interface League {
  id: number;
  name: string;
  logo: string | null;
  country: string;
  match_count: number;
  live_count: number;
}

export interface DashboardSummary {
  live_count: number;
  upcoming_count: number;
  finished_count: number;
  total_matches: number;
  leagues_active: number;
  last_updated: string;
}

type ApiFootballFixture = {
  fixture: {
    id: number;
    date: string;
    status: { long: string; short: string; elapsed: number | null };
  };
  league: { id: number; name: string; logo: string; country: string };
  teams: {
    home: { id: number; name: string; logo: string };
    away: { id: number; name: string; logo: string };
  };
  goals: { home: number | null; away: number | null };
  score?: {
    halftime?: { home: number | null; away: number | null } | null;
    fulltime?: { home: number | null; away: number | null } | null;
  };
};

export type OddsApiEvent = {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title?: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number }>;
    }>;
  }>;
};

function normaliseStatus(short: string): string {
  if (["1H", "2H", "ET", "BT", "P", "LIVE", "HT"].includes(short)) {
    return "live";
  }
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) {
    return "finished";
  }
  return "upcoming";
}

function oddsToProb(decimal: number): number {
  if (decimal <= 0) return 0;
  return Math.round((1 / decimal) * 100 * 10) / 10;
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function stripClubSuffix(value: string) {
  return value.replace(/(?:footballclub|clubdefutbol|calcio|afc|fc|cf)$/g, "");
}

function namesMatch(a: string, b: string) {
  if (!a || !b) return false;
  const left = stripClubSuffix(a);
  const right = stripClubSuffix(b);
  if (left === right) return true;

  // Deliberately conservative. Missing an odds match is safer than attaching
  // another club's prices to a fixture (for example City vs United).
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length < 7) return false;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.65;
}

function extractOdds(
  homeTeam: string,
  awayTeam: string,
  oddsEvents: OddsApiEvent[],
  expectedSportKey: string | null,
): Odds {
  const nullOdds: Odds = {
    home_win: null,
    draw: null,
    away_win: null,
    home_odds: null,
    draw_odds: null,
    away_odds: null,
  };

  if (!expectedSportKey) return nullOdds;

  const normHome = normalizeName(homeTeam);
  const normAway = normalizeName(awayTeam);
  const event = oddsEvents.find((candidate) => {
    if (candidate.sport_key !== expectedSportKey) return false;
    return (
      namesMatch(normHome, normalizeName(candidate.home_team)) &&
      namesMatch(normAway, normalizeName(candidate.away_team))
    );
  });
  if (!event) return nullOdds;

  const bookmaker =
    event.bookmakers.find((book) => book.key === "pinnacle") ??
    event.bookmakers.find((book) => book.key === "betfair_ex_eu") ??
    event.bookmakers.find((book) => book.key === "betfair") ??
    event.bookmakers[0];
  if (!bookmaker) return nullOdds;

  const h2h = bookmaker.markets.find((market) => market.key === "h2h");
  if (!h2h) return nullOdds;

  const homeOutcome = h2h.outcomes.find((outcome) =>
    namesMatch(normalizeName(outcome.name), normHome),
  );
  const awayOutcome = h2h.outcomes.find((outcome) =>
    namesMatch(normalizeName(outcome.name), normAway),
  );
  const drawOutcome = h2h.outcomes.find(
    (outcome) => outcome.name.toLowerCase() === "draw",
  );

  const homeDecimal = homeOutcome?.price ?? null;
  const awayDecimal = awayOutcome?.price ?? null;
  const drawDecimal = drawOutcome?.price ?? null;

  let homeProb = homeDecimal ? oddsToProb(homeDecimal) : null;
  let drawProb = drawDecimal ? oddsToProb(drawDecimal) : null;
  let awayProb = awayDecimal ? oddsToProb(awayDecimal) : null;

  if (homeProb !== null && drawProb !== null && awayProb !== null) {
    const total = homeProb + drawProb + awayProb;
    if (total > 0) {
      homeProb = Math.round((homeProb / total) * 100 * 10) / 10;
      drawProb = Math.round((drawProb / total) * 100 * 10) / 10;
      awayProb = Math.round((100 - homeProb - drawProb) * 10) / 10;
    }
  }

  return {
    home_win: homeProb,
    draw: drawProb,
    away_win: awayProb,
    home_odds: homeDecimal,
    draw_odds: drawDecimal,
    away_odds: awayDecimal,
  };
}

function requireFixtureArray(data: unknown, path: string): ApiFootballFixture[] {
  if (Array.isArray(data)) return data as ApiFootballFixture[];
  throw markApiFootballFailure({
    path,
    message: "API-Football returned an unexpected fixture payload",
    kind: "malformed_response",
    state: "degraded",
  });
}

async function getTodayFixtures(): Promise<ApiFootballFixture[]> {
  const cached = getCached<ApiFootballFixture[]>(
    "today_fixtures",
    CACHE_TTL.today_fixtures,
  );
  if (cached) return cached;

  const today = new Date().toISOString().split("T")[0];
  const primaryPath = `/fixtures?date=${today}&timezone=UTC`;
  let data = requireFixtureArray(await fetchFootball(primaryPath), primaryPath);

  // Some provider datasets may require a season-qualified request. Use it only
  // as a fallback so a stale or differently-labelled season cannot hide real
  // fixtures that exist on today's calendar date. Provider errors are allowed
  // to propagate; they must never be converted into a legitimate empty list.
  if (data.length === 0) {
    const fallbackPath = `/fixtures?date=${today}&season=${SEASON}&timezone=UTC`;
    const fallbackData = requireFixtureArray(
      await fetchFootball(fallbackPath),
      fallbackPath,
    );
    if (fallbackData.length > 0) data = fallbackData;
  }

  const fixtures = data.filter((fixture) =>
    isTrackedLeague(fixture.league.id),
  );
  setCache("today_fixtures", fixtures);
  return fixtures;
}

async function getLiveFixtures(): Promise<ApiFootballFixture[]> {
  const cached = getCached<ApiFootballFixture[]>(
    "live_fixtures",
    CACHE_TTL.live_fixtures,
  );
  if (cached) return cached;

  const path = "/fixtures?live=all";
  const data = requireFixtureArray(await fetchFootball(path), path);
  const fixtures = data.filter((fixture) =>
    isTrackedLeague(fixture.league.id),
  );
  _liveMatchCount = fixtures.length;
  setCache("live_fixtures", fixtures);
  return fixtures;
}

async function fetchOddsForSport(sportKey: string): Promise<OddsApiEvent[]> {
  const cacheKey = `soccer_odds:${sportKey}`;
  const cached = getCached<OddsApiEvent[]>(cacheKey, CACHE_TTL.soccer_odds);
  if (cached) return cached;

  if (!ODDS_API_KEY) {
    logger.warn("ODDS_API_KEY not set");
    setCache(cacheKey, [] as OddsApiEvent[]);
    return [];
  }

  const params = new URLSearchParams({
    apiKey: ODDS_API_KEY,
    regions: "eu",
    markets: "h2h",
    oddsFormat: "decimal",
    dateFormat: "iso",
  });
  const url = `${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/odds?${params}`;

  await waitForRateLimit();
  const res = await fetch(url);
  if (!res.ok) {
    // Never log the URL because it contains the API key in the query string.
    logger.error(
      { status: res.status, sportKey },
      "Odds API request failed",
    );
    setCache(cacheKey, [] as OddsApiEvent[]);
    return [];
  }

  const data = (await res.json()) as unknown;
  const events = Array.isArray(data) ? (data as OddsApiEvent[]) : [];
  setCache(cacheKey, events);
  return events;
}

async function getSoccerOdds(
  fixtures: ApiFootballFixture[],
): Promise<OddsApiEvent[]> {
  const sportKeys = Array.from(
    new Set(
      fixtures
        .filter(
          (fixture) =>
            normaliseStatus(fixture.fixture.status.short) !== "finished",
        )
        .map((fixture) => getOddsSportKeyForLeague(fixture.league.id))
        .filter((key): key is string => Boolean(key)),
    ),
  );

  if (!sportKeys.length) return [];

  const events = new Map<string, OddsApiEvent>();
  // Sequential calls respect the shared limiter and avoid provider bursts.
  for (const sportKey of sportKeys) {
    const sportEvents = await fetchOddsForSport(sportKey);
    for (const event of sportEvents) {
      events.set(`${event.sport_key}:${event.id}`, event);
    }
  }

  return Array.from(events.values());
}

export async function getAllMatches(
  leagueId?: number | null,
  status?: string | null,
): Promise<Match[]> {
  // Keep provider requests sequential to preserve the shared throttle.
  const todayFixtures = await getTodayFixtures();
  const liveFixtures = await getLiveFixtures();

  // The live endpoint is authoritative for live status. The daily fixture
  // response is cached separately and can retain an old HT/1H/2H snapshot
  // after a match resumes or finishes. Never let that stale snapshot create a
  // false live match after it has disappeared from /fixtures?live=all.
  const liveIds = new Set(
    liveFixtures.map((fixture) => fixture.fixture.id),
  );
  const combined = new Map<number, ApiFootballFixture>();
  for (const fixture of todayFixtures) {
    const fixtureId = fixture.fixture.id;
    const dailyStatus = normaliseStatus(fixture.fixture.status.short);
    if (dailyStatus === "live" && !liveIds.has(fixtureId)) {
      logger.warn(
        {
          fixtureId,
          cachedStatus: fixture.fixture.status.short,
          cachedMinute: fixture.fixture.status.elapsed,
        },
        "suppressing stale live fixture from daily cache",
      );
      continue;
    }
    combined.set(fixtureId, fixture);
  }
  for (const fixture of liveFixtures) combined.set(fixture.fixture.id, fixture);
  const combinedFixtures = Array.from(combined.values());

  const hasActiveMatches = combinedFixtures.some(
    (fixture) => normaliseStatus(fixture.fixture.status.short) !== "finished",
  );
  const oddsEvents = hasActiveMatches
    ? await getSoccerOdds(combinedFixtures)
    : [];

  let matches = combinedFixtures.map((fixture) =>
    fixtureToMatch(fixture, oddsEvents),
  );

  if (leagueId != null) {
    matches = matches.filter((match) => match.league_id === leagueId);
  }

  if (status && status !== "all") {
    if (status === "live") {
      matches = matches.filter((match) => liveIds.has(match.id));
    } else {
      matches = matches.filter((match) => match.status === status);
    }
  }

  matches.sort((a, b) => {
    const order: Record<string, number> = { live: 0, upcoming: 1, finished: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  // Passive market capture reuses the odds response above. The intelligence
  // layer makes no additional odds-provider call and cannot alter the model.
  if (
    process.env.MARKET_INTELLIGENCE_ENABLED !== "false" &&
    oddsEvents.length > 0 &&
    matches.some((match) => match.status === "upcoming")
  ) {
    void import("./marketIntelligenceService")
      .then(({ captureMarketSnapshots }) =>
        captureMarketSnapshots(matches, oddsEvents),
      )
      .catch((err) =>
        logger.warn({ err }, "market intelligence capture failed"),
      );
  }

  return matches;
}

function fixtureToMatch(
  fixture: ApiFootballFixture,
  oddsEvents: OddsApiEvent[],
): Match {
  const status = normaliseStatus(fixture.fixture.status.short);
  const expectedSportKey = getOddsSportKeyForLeague(fixture.league.id);

  return {
    id: fixture.fixture.id,
    league_id: fixture.league.id,
    league_name: fixture.league.name,
    league_logo: fixture.league.logo || null,
    country: fixture.league.country,
    home_team: {
      id: fixture.teams.home.id,
      name: fixture.teams.home.name,
      logo: fixture.teams.home.logo || null,
    },
    away_team: {
      id: fixture.teams.away.id,
      name: fixture.teams.away.name,
      logo: fixture.teams.away.logo || null,
    },
    status,
    status_detail: fixture.fixture.status.short,
    minute: fixture.fixture.status.elapsed ?? null,
    score: { home: fixture.goals.home, away: fixture.goals.away },
    score_ht:
      fixture.score?.halftime?.home != null &&
      fixture.score?.halftime?.away != null
        ? {
            home: fixture.score.halftime.home,
            away: fixture.score.halftime.away,
          }
        : null,
    kickoff: fixture.fixture.date,
    odds: extractOdds(
      fixture.teams.home.name,
      fixture.teams.away.name,
      oddsEvents,
      expectedSportKey,
    ),
  };
}

export async function getMatchById(id: number): Promise<Match | null> {
  const matches = await getAllMatches();
  return matches.find((match) => match.id === id) ?? null;
}

export async function getLeagues(): Promise<League[]> {
  const matches = await getAllMatches();
  const leagueMap = new Map<
    number,
    { name: string; logo: string | null; country: string; matches: Match[] }
  >();

  for (const match of matches) {
    if (!leagueMap.has(match.league_id)) {
      leagueMap.set(match.league_id, {
        name: match.league_name,
        logo: match.league_logo,
        country: match.country,
        matches: [],
      });
    }
    leagueMap.get(match.league_id)!.matches.push(match);
  }

  return Array.from(leagueMap.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    logo: data.logo,
    country: data.country,
    match_count: data.matches.length,
    live_count: data.matches.filter((match) => match.status === "live").length,
  }));
}

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const matches = await getAllMatches();
  const live = matches.filter((match) => match.status === "live").length;
  const upcoming = matches.filter((match) => match.status === "upcoming").length;
  const finished = matches.filter((match) => match.status === "finished").length;
  const leagueIds = new Set(matches.map((match) => match.league_id));

  return {
    live_count: live,
    upcoming_count: upcoming,
    finished_count: finished,
    total_matches: matches.length,
    leagues_active: leagueIds.size,
    last_updated: new Date().toISOString(),
  };
}
