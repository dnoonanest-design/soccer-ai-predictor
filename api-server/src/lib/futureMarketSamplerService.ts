import { db, backgroundJobRuns, marketOddsSnapshots } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { getOddsSportKeyForLeague, isTrackedLeague, TRACKED_COMPETITIONS } from "./leagueConfig";
import { logger } from "./logger";
import {
  captureMarketSnapshots,
  type RawOddsEvent,
} from "./marketIntelligenceService";
import { waitForRateLimit } from "./rateLimiter";
import { fetchFootball, type Match } from "./soccerService";

const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const SEASON = process.env.FOOTBALL_SEASON ?? String(new Date().getUTCFullYear());

const ENABLED = process.env.MARKET_FUTURE_SAMPLER_ENABLED === "true";
const WINDOW_HOURS = clampNumber(
  Number(process.env.MARKET_FUTURE_SAMPLER_WINDOW_HOURS ?? 72),
  24,
  168,
);
const SCAN_INTERVAL_MS = clampNumber(
  Number(process.env.MARKET_FUTURE_SAMPLER_SCAN_MS ?? 30 * 60_000),
  15 * 60_000,
  6 * 60 * 60_000,
);
const FIXTURE_REFRESH_MS = clampNumber(
  Number(process.env.MARKET_FUTURE_SAMPLER_FIXTURE_REFRESH_MS ?? 2 * 60 * 60_000),
  30 * 60_000,
  12 * 60 * 60_000,
);
const MAX_FIXTURES = clampNumber(
  Number(process.env.MARKET_FUTURE_SAMPLER_MAX_FIXTURES ?? 120),
  20,
  500,
);
const MAX_ODDS_CALLS_PER_RUN = clampNumber(
  Number(process.env.MARKET_FUTURE_SAMPLER_MAX_ODDS_CALLS_PER_RUN ?? 4),
  1,
  12,
);
const MAX_ODDS_CALLS_PER_DAY = clampNumber(
  Number(process.env.MARKET_FUTURE_SAMPLER_MAX_ODDS_CALLS_PER_DAY ?? 80),
  4,
  1000,
);

const NEAR_INTERVAL_MS = 30 * 60_000;
const MID_INTERVAL_MS = 60 * 60_000;
const FAR_INTERVAL_MS = 2 * 60 * 60_000;

type FutureFixture = {
  fixture: {
    id: number;
    date: string;
    status: { short: string; long?: string; elapsed?: number | null };
  };
  league: {
    id: number;
    name: string;
    logo?: string | null;
    country: string;
  };
  teams: {
    home: { id: number; name: string; logo?: string | null };
    away: { id: number; name: string; logo?: string | null };
  };
  goals?: { home: number | null; away: number | null };
};

type SamplerResult = {
  startedAt: string;
  finishedAt: string;
  fixturesInWindow: number;
  fixturesDue: number;
  sportKeysDue: number;
  oddsCalls: number;
  observations: number;
  fixturesCaptured: number;
  dailyOddsCallsUsed: number;
  dailyOddsCallLimit: number;
  budgetExhausted: boolean;
  apiQuotaInfo?: {
    strategy: string;
    apiFetchCount: number;
    competitionsCovered: number;
    competitionsWithZeroResults: number;
  };
};

let started = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastResult: SamplerResult | null = null;
let lastError: string | null = null;
let cachedFixtures: FutureFixture[] = [];
let fixtureCacheFetchedAt = 0;
let budgetDate = utcDateKey(new Date());
let oddsCallsToday = 0;

export function startFutureMarketSampler() {
  if (started || !ENABLED) return;
  started = true;

  timer = setInterval(() => {
    runFutureMarketSampler().catch((err) =>
      logger.warn({ err }, "future market sampler failed"),
    );
  }, SCAN_INTERVAL_MS);

  startupTimer = setTimeout(() => {
    runFutureMarketSampler().catch((err) =>
      logger.warn({ err }, "future market sampler startup run failed"),
    );
  }, 15_000);

  logger.info(
    {
      WINDOW_HOURS,
      SCAN_INTERVAL_MS,
      FIXTURE_REFRESH_MS,
      MAX_ODDS_CALLS_PER_RUN,
      MAX_ODDS_CALLS_PER_DAY,
      trackedCompetitionCount: TRACKED_COMPETITIONS.length,
      strategy: "country-grouped with fallback to direct league queries",
    },
    "future market sampler started",
  );
}

export function stopFutureMarketSampler() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
  started = false;
}

export function getFutureMarketSamplerStatus() {
  refreshDailyBudget();
  return {
    enabled: ENABLED,
    started,
    running,
    lastRunAt,
    lastResult,
    lastError,
    configuration: {
      windowHours: WINDOW_HOURS,
      scanIntervalMs: SCAN_INTERVAL_MS,
      fixtureRefreshMs: FIXTURE_REFRESH_MS,
      maxFixtures: MAX_FIXTURES,
      maxOddsCallsPerRun: MAX_ODDS_CALLS_PER_RUN,
      maxOddsCallsPerDay: MAX_ODDS_CALLS_PER_DAY,
      cadence: {
        moreThan24HoursBeforeKickoffMs: FAR_INTERVAL_MS,
        sixTo24HoursBeforeKickoffMs: MID_INTERVAL_MS,
        zeroToSixHoursBeforeKickoffMs: NEAR_INTERVAL_MS,
      },
    },
    budget: {
      dateUtc: budgetDate,
      oddsCallsToday,
      remaining: Math.max(0, MAX_ODDS_CALLS_PER_DAY - oddsCallsToday),
    },
  };
}

export async function runFutureMarketSampler(): Promise<SamplerResult | { skipped: true; reason: string }> {
  if (!ENABLED) return { skipped: true, reason: "future market sampler disabled" };
  if (running) return { skipped: true, reason: "future market sampler already running" };

  running = true;
  const startedAt = new Date();
  let fixturesInWindow = 0;
  let fixturesDue = 0;
  let sportKeysDue = 0;
  let oddsCalls = 0;
  let observations = 0;
  const capturedFixtureIds = new Set<number>();
  let apiFetchCount = 0;
  let competitionsCovered = 0;
  let competitionsWithZeroResults = 0;

  try {
    refreshDailyBudget();

    const { fixtures, fetchCount, covered, empty } = await getFutureFixtures(startedAt);
    apiFetchCount = fetchCount;
    competitionsCovered = covered;
    competitionsWithZeroResults = empty;
    fixturesInWindow = fixtures.length;

    if (!fixtures.length) {
      return await finishRun({
        startedAt,
        fixturesInWindow,
        fixturesDue: 0,
        sportKeysDue: 0,
        oddsCalls: 0,
        observations: 0,
        fixturesCaptured: 0,
        budgetExhausted: oddsCallsToday >= MAX_ODDS_CALLS_PER_DAY,
        apiFetchCount,
        competitionsCovered,
        competitionsWithZeroResults,
      });
    }

    const latestByFixture = await getLatestObservationTimes(
      fixtures.map((fixture) => fixture.fixture.id),
    );

    const nowMs = startedAt.getTime();
    const dueFixtures = fixtures.filter((fixture) => {
      const kickoffMs = new Date(fixture.fixture.date).getTime();
      const hoursToKickoff = (kickoffMs - nowMs) / 3_600_000;
      if (hoursToKickoff <= 0 || hoursToKickoff > WINDOW_HOURS) return false;

      const latest = latestByFixture.get(fixture.fixture.id);
      if (!latest) return true;
      return nowMs - latest.getTime() >= cadenceForHours(hoursToKickoff);
    });

    fixturesDue = dueFixtures.length;

    const bySportKey = new Map<string, FutureFixture[]>();
    for (const fixture of dueFixtures) {
      const sportKey = getOddsSportKeyForLeague(fixture.league.id);
      if (!sportKey) continue;
      const group = bySportKey.get(sportKey) ?? [];
      group.push(fixture);
      bySportKey.set(sportKey, group);
    }

    const groups = Array.from(bySportKey.entries())
      .map(([sportKey, group]) => ({
        sportKey,
        fixtures: group.sort(
          (a, b) =>
            new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime(),
        ),
      }))
      .sort(
        (a, b) =>
          new Date(a.fixtures[0].fixture.date).getTime() -
          new Date(b.fixtures[0].fixture.date).getTime(),
      );

    sportKeysDue = groups.length;

    const remainingDailyBudget = Math.max(
      0,
      MAX_ODDS_CALLS_PER_DAY - oddsCallsToday,
    );
    const callsAllowed = Math.min(
      MAX_ODDS_CALLS_PER_RUN,
      remainingDailyBudget,
    );

    for (const group of groups.slice(0, callsAllowed)) {
      const events = await fetchOddsForSport(group.sportKey);
      oddsCalls++;
      oddsCallsToday++;

      if (!events.length) continue;

      const matches = group.fixtures.map(toMatch);
      const result = await captureMarketSnapshots(matches, events);
      observations += Number(result.observations ?? 0);
      for (const fixture of group.fixtures) {
        if (Number(result.observations ?? 0) > 0) {
          capturedFixtureIds.add(fixture.fixture.id);
        }
      }
    }

    return await finishRun({
      startedAt,
      fixturesInWindow,
      fixturesDue,
      sportKeysDue,
      oddsCalls,
      observations,
      fixturesCaptured: capturedFixtureIds.size,
      budgetExhausted:
        oddsCallsToday >= MAX_ODDS_CALLS_PER_DAY ||
        (groups.length > 0 && callsAllowed === 0),
      apiFetchCount,
      competitionsCovered,
      competitionsWithZeroResults,
    });
  } catch (err: any) {
    lastRunAt = new Date();
    lastError = String(err?.message ?? err);
    await recordSamplerJob(
      "error",
      fixturesInWindow,
      observations,
      lastError,
    );
    throw err;
  } finally {
    running = false;
  }
}

async function getFutureFixtures(
  now: Date,
): Promise<{
  fixtures: FutureFixture[];
  fetchCount: number;
  covered: number;
  empty: number;
}> {
  if (
    fixtureCacheFetchedAt > 0 &&
    Date.now() - fixtureCacheFetchedAt < FIXTURE_REFRESH_MS
  ) {
    return {
      fixtures: filterFixtureWindow(cachedFixtures, now),
      fetchCount: 0,
      covered: 0,
      empty: 0,
    };
  }

  const end = new Date(now.getTime() + WINDOW_HOURS * 3_600_000);
  const fromDate = dateOnly(now);
  const toDate = dateOnly(end);

  const allFixtures = new Map<number, FutureFixture>();
  let apiFetchCount = 0;
  let competitionsCovered = 0;
  let competitionsEmpty = 0;

  // Strategy 1: Try broad date range first (single call, most efficient)
  // This works if API-Football returns all fixtures for all tracked leagues in the date range
  const broadPath = `/fixtures?from=${fromDate}&to=${toDate}&season=${encodeURIComponent(SEASON)}&timezone=UTC`;
  const broadData = (await fetchFootball(broadPath)) as FutureFixture[] | null;
  apiFetchCount++;

  const trackedByLeagueId = new Map(
    TRACKED_COMPETITIONS.map((comp) => [comp.id, comp]),
  );

  if (Array.isArray(broadData) && broadData.length > 0) {
    // Broad query returned results. Filter to tracked leagues and future status.
    for (const fixture of broadData) {
      const leagueId = Number(fixture.league?.id);
      if (trackedByLeagueId.has(leagueId) && isFutureStatus(fixture.fixture?.status?.short)) {
        allFixtures.set(fixture.fixture.id, fixture);
      }
    }

    // Track which competitions got results
    for (const comp of TRACKED_COMPETITIONS) {
      const hasFixture = Array.from(allFixtures.values()).some(
        (f) => f.league.id === comp.id,
      );
      if (hasFixture) {
        competitionsCovered++;
      } else {
        competitionsEmpty++;
      }
    }

    logger.info(
      {
        strategy: "broad date range",
        apiFetchCount,
        fixturesFound: allFixtures.size,
        competitionsCovered,
        competitionsEmpty,
      },
      "fixture fetcher: broad query succeeded",
    );
  } else {
    // Broad query failed or returned empty. Fall back to per-league queries.
    // This ensures we catch fixtures even if the API doesn't return all in one broad query.
    logger.warn(
      { broadQueryResult: broadData ? "empty" : "error", apiFetchCount },
      "fixture fetcher: broad query did not return results, falling back to per-league queries",
    );

    for (const competition of TRACKED_COMPETITIONS) {
      const path = `/fixtures?from=${fromDate}&to=${toDate}&league=${competition.id}&season=${encodeURIComponent(SEASON)}&timezone=UTC`;
      const data = (await fetchFootball(path)) as FutureFixture[] | null;
      apiFetchCount++;

      if (!Array.isArray(data) || data.length === 0) {
        competitionsEmpty++;
        continue;
      }

      const filtered = data.filter((fixture) =>
        isFutureStatus(fixture.fixture?.status?.short),
      );

      if (filtered.length === 0) {
        competitionsEmpty++;
        continue;
      }

      competitionsCovered++;

      for (const fixture of filtered) {
        allFixtures.set(fixture.fixture.id, fixture);
      }
    }

    logger.info(
      {
        strategy: "per-league fallback",
        apiFetchCount,
        fixturesFound: allFixtures.size,
        competitionsCovered,
        competitionsEmpty,
      },
      "fixture fetcher: per-league fallback completed",
    );
  }

  cachedFixtures = Array.from(allFixtures.values()).slice(0, MAX_FIXTURES);
  fixtureCacheFetchedAt = Date.now();

  return {
    fixtures: filterFixtureWindow(cachedFixtures, now),
    fetchCount: apiFetchCount,
    covered: competitionsCovered,
    empty: competitionsEmpty,
  };
}

function filterFixtureWindow(fixtures: FutureFixture[], now: Date) {
  const startMs = now.getTime();
  const endMs = startMs + WINDOW_HOURS * 3_600_000;
  return fixtures
    .filter((fixture) => {
      const kickoffMs = new Date(fixture.fixture.date).getTime();
      return kickoffMs > startMs && kickoffMs <= endMs;
    })
    .sort(
      (a, b) =>
        new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime(),
    )
    .slice(0, MAX_FIXTURES);
}

async function getLatestObservationTimes(fixtureIds: number[]) {
  const result = new Map<number, Date>();
  if (!fixtureIds.length) return result;

  const rows = await db
    .select({
      fixtureId: marketOddsSnapshots.fixtureId,
      latestObservedAt: sql<Date | null>`max(${marketOddsSnapshots.observedAt})`.as(
        "latest_observed_at",
      ),
    })
    .from(marketOddsSnapshots)
    .where(inArray(marketOddsSnapshots.fixtureId, fixtureIds))
    .groupBy(marketOddsSnapshots.fixtureId);

  for (const row of rows) {
    if (row.latestObservedAt) {
      result.set(row.fixtureId, new Date(row.latestObservedAt));
    }
  }
  return result;
}

async function fetchOddsForSport(sportKey: string): Promise<RawOddsEvent[]> {
  if (!ODDS_API_KEY) {
    logger.warn("future market sampler: ODDS_API_KEY not set");
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
  const response = await fetch(url);
  if (!response.ok) {
    logger.warn(
      { status: response.status, sportKey },
      "future market sampler: Odds API request failed",
    );
    return [];
  }

  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as RawOddsEvent[]) : [];
}

function toMatch(fixture: FutureFixture): Match {
  return {
    id: fixture.fixture.id,
    league_id: fixture.league.id,
    league_name: fixture.league.name,
    league_logo: fixture.league.logo ?? null,
    country: fixture.league.country,
    home_team: {
      id: fixture.teams.home.id,
      name: fixture.teams.home.name,
      logo: fixture.teams.home.logo ?? null,
    },
    away_team: {
      id: fixture.teams.away.id,
      name: fixture.teams.away.name,
      logo: fixture.teams.away.logo ?? null,
    },
    status: "upcoming",
    status_detail: fixture.fixture.status.short,
    minute: null,
    score: { home: null, away: null },
    score_ht: null,
    kickoff: fixture.fixture.date,
    odds: {
      home_win: null,
      draw: null,
      away_win: null,
      home_odds: null,
      draw_odds: null,
      away_odds: null,
    },
  };
}

async function finishRun(input: {
  startedAt: Date;
  fixturesInWindow: number;
  fixturesDue: number;
  sportKeysDue: number;
  oddsCalls: number;
  observations: number;
  fixturesCaptured: number;
  budgetExhausted: boolean;
  apiFetchCount: number;
  competitionsCovered: number;
  competitionsWithZeroResults: number;
}): Promise<SamplerResult> {
  const finishedAt = new Date();
  const result: SamplerResult = {
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    fixturesInWindow: input.fixturesInWindow,
    fixturesDue: input.fixturesDue,
    sportKeysDue: input.sportKeysDue,
    oddsCalls: input.oddsCalls,
    observations: input.observations,
    fixturesCaptured: input.fixturesCaptured,
    dailyOddsCallsUsed: oddsCallsToday,
    dailyOddsCallLimit: MAX_ODDS_CALLS_PER_DAY,
    budgetExhausted: input.budgetExhausted,
    apiQuotaInfo: {
      strategy:
        input.apiFetchCount === 1
          ? "broad date range (optimal)"
          : `per-league fallback (${input.apiFetchCount} calls)`,
      apiFetchCount: input.apiFetchCount,
      competitionsCovered: input.competitionsCovered,
      competitionsWithZeroResults: input.competitionsWithZeroResults,
    },
  };

  lastRunAt = finishedAt;
  lastResult = result;
  lastError = null;

  await recordSamplerJob(
    "success",
    input.fixturesInWindow,
    input.observations,
  );

  logger.info(result, "future market sampler completed");
  return result;
}

async function recordSamplerJob(
  status: "success" | "error",
  checkedCount: number,
  changedCount: number,
  errorMessage?: string,
) {
  try {
    await db.insert(backgroundJobRuns).values({
      jobName: "future_market_sampler",
      status,
      checkedCount,
      changedCount,
      errorMessage: errorMessage ?? null,
      finishedAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err }, "future market sampler: failed to record job run");
  }
}

function cadenceForHours(hoursToKickoff: number) {
  if (hoursToKickoff <= 6) return NEAR_INTERVAL_MS;
  if (hoursToKickoff <= 24) return MID_INTERVAL_MS;
  return FAR_INTERVAL_MS;
}

function isFutureStatus(status: string | undefined) {
  return ![
    "1H",
    "2H",
    "HT",
    "ET",
    "BT",
    "P",
    "LIVE",
    "FT",
    "AET",
    "PEN",
    "AWD",
    "WO",
  ].includes(status ?? "");
}

function refreshDailyBudget() {
  const today = utcDateKey(new Date());
  if (today !== budgetDate) {
    budgetDate = today;
    oddsCallsToday = 0;
  }
}

function utcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function clampNumber(value: number, min: number, max: number) {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, safe));
}

