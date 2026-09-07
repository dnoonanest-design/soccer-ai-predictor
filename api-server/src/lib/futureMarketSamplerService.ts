import { db, backgroundJobRuns, marketOddsSnapshots } from "@workspace/db";
import { inArray, sql, eq, and, gte } from "drizzle-orm";
import {
  TRACKED_COMPETITIONS,
  getOddsSportKeyForLeague,
  isTrackedLeague,
} from "./leagueConfig";
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
let budgetInitialized = false;

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
  let capturedFixtureCount = 0;

  try {
    await refreshDailyBudget();

    const fixtures = await getFutureFixtures(startedAt);
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
      // FIX #2: Use result.fixtures directly—only counts fixtures with actual persisted snapshots
      capturedFixtureCount += Number(result.fixtures ?? 0);
    }

    return await finishRun({
      startedAt,
      fixturesInWindow,
      fixturesDue,
      sportKeysDue,
      oddsCalls,
      observations,
      fixturesCaptured: capturedFixtureCount,
      budgetExhausted:
        oddsCallsToday >= MAX_ODDS_CALLS_PER_DAY ||
        (groups.length > 0 && callsAllowed === 0),
    });
  } catch (err: any) {
    lastRunAt = new Date();
    lastError = String(err?.message ?? err);
    await recordSamplerJob(
      "error",
      fixturesInWindow,
      observations,
      0,
      lastError,
    );
    throw err;
  } finally {
    running = false;
  }
}

async function getFutureFixtures(now: Date): Promise<FutureFixture[]> {
  if (
    fixtureCacheFetchedAt > 0 &&
    Date.now() - fixtureCacheFetchedAt < FIXTURE_REFRESH_MS
  ) {
    return filterFixtureWindow(cachedFixtures, now);
  }

  const end = new Date(now.getTime() + WINDOW_HOURS * 3_600_000);
  const fromDate = dateOnly(now);
  const toDate = dateOnly(end);
  const deduped = new Map<number, FutureFixture>();
  let competitionsWithFixtures = 0;
  let rawFixturesLoaded = 0;

  // PR #8: Per-competition fixture fetching with error handling and deduplication
  for (const competition of TRACKED_COMPETITIONS) {
    const path = `/fixtures?league=${competition.id}&season=${encodeURIComponent(SEASON)}&from=${fromDate}&to=${toDate}&timezone=UTC`;

    try {
      const data = (await fetchFootball(path)) as FutureFixture[] | null;
      if (!Array.isArray(data) || data.length === 0) continue;

      competitionsWithFixtures++;
      rawFixturesLoaded += data.length;

      for (const fixture of data) {
        const fixtureId = Number(fixture?.fixture?.id);
        if (!Number.isInteger(fixtureId) || fixtureId <= 0) continue;
        if (!isTrackedLeague(Number(fixture?.league?.id))) continue;
        deduped.set(fixtureId, fixture);
      }
    } catch (err) {
      logger.warn(
        { err, leagueId: competition.id, competition: competition.name },
        "future market sampler: tracked competition fixture fetch failed",
      );
    }
  }

  cachedFixtures = Array.from(deduped.values())
    .filter((fixture) => isFutureStatus(fixture.fixture?.status?.short))
    .sort(
      (a, b) =>
        new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime(),
    )
    .slice(0, MAX_FIXTURES);
  fixtureCacheFetchedAt = Date.now();

  const fixturesInWindow = filterFixtureWindow(cachedFixtures, now);
  logger.info(
    {
      competitionsQueried: TRACKED_COMPETITIONS.length,
      competitionsWithFixtures,
      rawFixturesLoaded,
      uniqueTrackedFixtures: cachedFixtures.length,
      fixturesInWindow: fixturesInWindow.length,
      fromDate,
      toDate,
      season: SEASON,
    },
    "future market sampler: tracked fixture refresh completed",
  );

  return fixturesInWindow;
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

  try {
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
  } catch (err) {
    logger.warn({ err }, "future market sampler: failed to fetch observation times");
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

  try {
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
  } catch (err) {
    logger.warn(
      { err, sportKey },
      "future market sampler: Odds API fetch exception",
    );
    return [];
  }
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
  };

  lastRunAt = finishedAt;
  lastResult = result;
  lastError = null;

  // Record the main run stats and odds usage separately
  await recordSamplerJob(
    "success",
    input.fixturesInWindow,
    input.observations,
    input.oddsCalls,
  );

  logger.info(result, "future market sampler completed");
  return result;
}

async function recordSamplerJob(
  status: "success" | "error",
  checkedCount: number,
  changedCount: number,
  oddsCalls: number = 0,
  errorMessage?: string,
) {
  try {
    // Record the main run with fixturesInWindow (checkedCount) and observations (changedCount)
    await db.insert(backgroundJobRuns).values({
      jobName: "future_market_sampler",
      status,
      checkedCount,
      changedCount,
      errorMessage: errorMessage ?? null,
      finishedAt: new Date(),
    });

    // FIX #1: Record odds calls in a separate dedicated row for budget tracking
    // This allows daily budget to survive process restarts by querying only these rows
    // Do not sum fixturesInWindow; use dedicated jobName and checkedCount=oddsCalls
    if (oddsCalls > 0) {
      await db.insert(backgroundJobRuns).values({
        jobName: "future_market_sampler_odds_usage",
        status: "success",
        checkedCount: oddsCalls,
        changedCount: 0,
        errorMessage: null,
        finishedAt: new Date(),
      });
    }
  } catch (err) {
    logger.warn({ err }, "future market sampler: failed to record job run");
  }
}

async function reconstructDailyBudgetFromDb() {
  try {
    const today = utcDateKey(new Date());
    const todayStart = new Date(`${today}T00:00:00Z`);

    // FIX #1: Sum odds calls from today's dedicated future_market_sampler_odds_usage rows only
    // Each row has checkedCount = oddsCalls for that run (never use fixturesInWindow)
    const rows = await db
      .select({
        checkedCount: backgroundJobRuns.checkedCount,
      })
      .from(backgroundJobRuns)
      .where(
        and(
          eq(backgroundJobRuns.jobName, "future_market_sampler_odds_usage"),
          gte(backgroundJobRuns.finishedAt, todayStart),
        ),
      );

    let total = 0;
    for (const row of rows) {
      total += Number(row.checkedCount ?? 0);
    }
    oddsCallsToday = total;
    logger.info(
      { oddsCallsToday: total, dateUtc: today },
      "future market sampler: reconstructed daily odds budget from DB",
    );
  } catch (err) {
    logger.warn(
      { err },
      "future market sampler: failed to reconstruct daily budget from DB",
    );
    oddsCallsToday = 0;
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

async function refreshDailyBudget() {
  const today = utcDateKey(new Date());
  if (today !== budgetDate) {
    // Date rollover: reconstruct budget from DB for the new day
    budgetDate = today;
    await reconstructDailyBudgetFromDb();
  } else if (!budgetInitialized) {
    // FIX #1: First call after startup: reconstruct from DB to survive process restart
    budgetInitialized = true;
    await reconstructDailyBudgetFromDb();
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
