import { isTrackedLeague } from "./leagueConfig";
import { logger } from "./logger";

const API_BASE = "https://v3.football.api-sports.io";
const API_HOST = "v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY ?? "";

const ENABLED = process.env.API_FOOTBALL_QUOTA_OPTIMIZATION_ENABLED !== "false";
const SCHEDULE_DAYS = clamp(Number(process.env.API_FOOTBALL_SCHEDULE_DAYS ?? 8), 7, 14);
const SCHEDULE_REFRESH_MS = clamp(
  Number(process.env.API_FOOTBALL_SCHEDULE_REFRESH_MS ?? 6 * 60 * 60_000),
  60 * 60_000,
  12 * 60 * 60_000,
);
const SCHEDULE_FAILURE_BACKOFF_MS = clamp(
  Number(process.env.API_FOOTBALL_SCHEDULE_FAILURE_BACKOFF_MS ?? 30 * 60_000),
  5 * 60_000,
  2 * 60 * 60_000,
);
const PROVIDER_FAILURE_CACHE_MS = clamp(
  Number(process.env.API_FOOTBALL_PROVIDER_FAILURE_CACHE_MS ?? 15 * 60_000),
  5 * 60_000,
  60 * 60_000,
);
const DAILY_BUDGET = clamp(
  Number(process.env.API_FOOTBALL_DAILY_BUDGET ?? 7000),
  100,
  150_000,
);
const LIVE_POLL_MS = clamp(
  Number(process.env.API_FOOTBALL_LIVE_POLL_MS ?? 60_000),
  30_000,
  5 * 60_000,
);
const PREMATCH_LEAD_MS = clamp(
  Number(process.env.API_FOOTBALL_PREMATCH_LEAD_MS ?? 30 * 60_000),
  5 * 60_000,
  2 * 60 * 60_000,
);
const ACTIVE_TAIL_MS = clamp(
  Number(process.env.API_FOOTBALL_ACTIVE_TAIL_MS ?? 4 * 60 * 60_000),
  2 * 60 * 60_000,
  6 * 60 * 60_000,
);

const originalFetch = globalThis.fetch.bind(globalThis);

export type ApiFootballQuotaMode = "full" | "conserve" | "protect" | "critical";
type Priority = "critical" | "live" | "normal" | "background";

type StoredResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  fetchedAt: number;
};

type FixtureRecord = {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string; long?: string; elapsed?: number | null };
  };
  league?: { id?: number; name?: string; country?: string };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
  goals?: { home?: number | null; away?: number | null };
  events?: unknown[];
  lineups?: unknown[];
  statistics?: unknown[];
  players?: unknown[];
  [key: string]: unknown;
};

type ApiEnvelope = {
  errors?: unknown;
  response?: unknown;
};

const responseCache = new Map<string, StoredResponse>();
const inFlight = new Map<string, Promise<StoredResponse>>();
const schedule = new Map<number, FixtureRecord>();
const bundles = new Map<number, { fixture: FixtureRecord; fetchedAt: number }>();

const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]);
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

let installed = false;
let scheduleFetchedAt = 0;
let scheduleRefreshes = 0;
let lastScheduleAttemptAt = 0;
let providerCallsToday = 0;
let providerLimit: number | null = null;
let providerRemaining: number | null = null;
let providerQuotaObservedAt: string | null = null;
let budgetDate = utcDay();
let cacheHits = 0;
let bundleCacheHits = 0;
let bundledProviderCalls = 0;
let blockedCalls = 0;
let estimatedCallsSaved = 0;
let liveDiscoveryRequestsAvoided = 0;
let scheduleFallbacksAvoided = 0;
let lastProviderCallAt: string | null = null;
let lastBlockedPath: string | null = null;
let lastScheduleRefreshAt: string | null = null;
let lastScheduleError: string | null = null;
let cachedProviderFailure: StoredResponse | null = null;

export function installQuotaOptimizationLayer(): void {
  if (installed || !ENABLED) return;
  installed = true;
  globalThis.fetch = quotaOptimizedFetch as typeof globalThis.fetch;
  logger.info(
    {
      scheduleDays: SCHEDULE_DAYS,
      scheduleRefreshMs: SCHEDULE_REFRESH_MS,
      scheduleFailureBackoffMs: SCHEDULE_FAILURE_BACKOFF_MS,
      dailyBudget: DAILY_BUDGET,
      livePollMs: LIVE_POLL_MS,
      prematchLeadMs: PREMATCH_LEAD_MS,
    },
    "API-Football quota optimisation layer active",
  );
}

export function getQuotaOptimizationStatus() {
  rollBudgetDate();
  const effectiveBudget = effectiveDailyBudget();
  const used = effectiveUsedToday();
  return {
    enabled: ENABLED,
    installed,
    mode: quotaMode(),
    configuredDailyBudget: DAILY_BUDGET,
    effectiveDailyBudget: effectiveBudget,
    providerDailyLimit: providerLimit,
    providerRemaining,
    providerQuotaObservedAt,
    effectiveUsedToday: used,
    utilisationPct: effectiveBudget > 0 ? round2((used / effectiveBudget) * 100) : 0,
    providerCallsToday,
    cacheHits,
    bundleCacheHits,
    bundledProviderCalls,
    blockedCalls,
    estimatedCallsSaved,
    liveDiscoveryRequestsAvoided,
    scheduleFallbacksAvoided,
    schedule: {
      days: SCHEDULE_DAYS,
      trackedFixturesStored: schedule.size,
      refreshMs: SCHEDULE_REFRESH_MS,
      failureBackoffMs: SCHEDULE_FAILURE_BACKOFF_MS,
      refreshes: scheduleRefreshes,
      lastRefreshAt: lastScheduleRefreshAt,
      lastError: lastScheduleError,
    },
    lastProviderCallAt,
    lastBlockedPath,
  };
}

async function quotaOptimizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  if (!ENABLED || !isApiFootballUrl(url)) return originalFetch(input, init);

  rollBudgetDate();
  const parsed = new URL(url);

  if (isLiveDiscovery(parsed)) {
    return replaceLiveDiscovery(init);
  }

  const scheduleFallback = responseFromStoredSchedule(parsed);
  if (scheduleFallback) {
    scheduleFallbacksAvoided++;
    estimatedCallsSaved++;
    return scheduleFallback;
  }

  const bundled = responseFromBundle(parsed);
  if (bundled) {
    bundleCacheHits++;
    estimatedCallsSaved++;
    return bundled;
  }

  const cached = responseCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < cacheTtl(parsed)) {
    cacheHits++;
    estimatedCallsSaved++;
    return restore(cached);
  }

  if (!requestAllowed(priorityFor(parsed))) {
    blockedCalls++;
    lastBlockedPath = `${parsed.pathname}${parsed.search}`;
    if (cached) {
      cacheHits++;
      estimatedCallsSaved++;
      return restore(cached);
    }
    return synthetic(parsed, []);
  }

  const existing = inFlight.get(url);
  if (existing) {
    cacheHits++;
    estimatedCallsSaved++;
    return restore(await existing);
  }

  const work = realRequest(input, init, url, parsed);
  inFlight.set(url, work);
  try {
    return restore(await work);
  } finally {
    inFlight.delete(url);
  }
}

async function realRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
  parsed: URL,
): Promise<StoredResponse> {
  const response = await originalFetch(input, init);
  observeQuota(response.headers);
  providerCallsToday++;
  lastProviderCallAt = new Date().toISOString();

  const stored = await store(response);
  if (stored.status >= 200 && stored.status < 300) {
    responseCache.set(url, stored);
    updateFixtureCaches(parsed, stored);
  }
  return stored;
}

async function replaceLiveDiscovery(init?: RequestInit): Promise<Response> {
  liveDiscoveryRequestsAvoided++;
  estimatedCallsSaved++;

  await ensureSchedule(init);

  if (schedule.size === 0 && lastScheduleError) {
    return providerFailureOrFallback(init);
  }

  const now = Date.now();
  const candidates = Array.from(schedule.values())
    .filter((fixture) => {
      const leagueId = Number(fixture.league?.id);
      const id = Number(fixture.fixture?.id);
      const kickoff = fixture.fixture?.date ? Date.parse(fixture.fixture.date) : NaN;
      const status = fixture.fixture?.status?.short ?? "";
      if (!isTrackedLeague(leagueId) || !Number.isInteger(id) || id <= 0) return false;
      if (!Number.isFinite(kickoff) || FINISHED_STATUSES.has(status)) return false;
      return kickoff >= now - ACTIVE_TAIL_MS && kickoff <= now + PREMATCH_LEAD_MS;
    })
    .sort((a, b) => Date.parse(a.fixture?.date ?? "") - Date.parse(b.fixture?.date ?? ""));

  if (candidates.length === 0) return synthetic(new URL(`${API_BASE}/fixtures?live=all`), []);

  if (cachedProviderFailure && Date.now() - cachedProviderFailure.fetchedAt < PROVIDER_FAILURE_CACHE_MS) {
    cacheHits++;
    estimatedCallsSaved++;
    return restore(cachedProviderFailure);
  }

  const ids = candidates.map((fixture) => Number(fixture.fixture?.id));
  const allFresh = ids.every((id) => {
    const cached = bundles.get(id);
    return Boolean(cached && Date.now() - cached.fetchedAt < bundleTtl(cached.fixture));
  });

  if (!allFresh && requestAllowed("live")) {
    const failure = await refreshBundles(ids, init);
    if (failure) return restore(failure);
  }

  const current = ids
    .map((id) => bundles.get(id)?.fixture ?? schedule.get(id))
    .filter((fixture): fixture is FixtureRecord => Boolean(fixture));
  const live = current.filter((fixture) => LIVE_STATUSES.has(fixture.fixture?.status?.short ?? ""));
  return synthetic(new URL(`${API_BASE}/fixtures?live=all`), live);
}

async function providerFailureOrFallback(init?: RequestInit): Promise<Response> {
  if (cachedProviderFailure && Date.now() - cachedProviderFailure.fetchedAt < PROVIDER_FAILURE_CACHE_MS) {
    cacheHits++;
    estimatedCallsSaved++;
    return restore(cachedProviderFailure);
  }

  const parsed = new URL(`${API_BASE}/fixtures?live=all`);
  const response = await originalFetch(parsed, providerInit(init));
  observeQuota(response.headers);
  providerCallsToday++;
  lastProviderCallAt = new Date().toISOString();
  const stored = await store(response);
  if (responseHasProviderFailure(stored)) cachedProviderFailure = stored;
  return restore(stored);
}

async function ensureSchedule(init?: RequestInit): Promise<void> {
  if (scheduleFetchedAt > 0 && Date.now() - scheduleFetchedAt < SCHEDULE_REFRESH_MS) return;
  if (lastScheduleError && schedule.size === 0 && Date.now() - lastScheduleAttemptAt < SCHEDULE_FAILURE_BACKOFF_MS) return;
  if (!requestAllowed("normal") && schedule.size > 0) return;

  lastScheduleAttemptAt = Date.now();
  const start = new Date();
  const fetched = new Map<number, FixtureRecord>();
  let successfulDays = 0;
  let firstError: string | null = null;

  for (let offset = 0; offset < SCHEDULE_DAYS; offset++) {
    if (!requestAllowed("normal") && fetched.size > 0) break;
    const date = new Date(Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate() + offset,
    )).toISOString().slice(0, 10);
    const url = `${API_BASE}/fixtures?date=${date}&timezone=UTC`;

    try {
      const response = await originalFetch(url, providerInit(init));
      observeQuota(response.headers);
      providerCallsToday++;
      lastProviderCallAt = new Date().toISOString();
      const stored = await store(response);
      responseCache.set(url, stored);
      const json = JSON.parse(stored.body) as ApiEnvelope;
      const errors = normalizeErrors(json.errors);
      if (stored.status < 200 || stored.status >= 300 || errors.length > 0 || !Array.isArray(json.response)) {
        firstError ??= errors.join("; ") || `HTTP ${stored.status}`;
        if (responseHasProviderFailure(stored)) cachedProviderFailure = stored;
        if (errors.length > 0 || stored.status === 401 || stored.status === 403 || stored.status === 429) break;
        continue;
      }

      successfulDays++;
      for (const fixture of json.response as FixtureRecord[]) {
        const id = Number(fixture.fixture?.id);
        const leagueId = Number(fixture.league?.id);
        if (Number.isInteger(id) && id > 0 && isTrackedLeague(leagueId)) fetched.set(id, fixture);
      }
    } catch (error) {
      firstError ??= error instanceof Error ? error.message : String(error);
      break;
    }

    if (offset < SCHEDULE_DAYS - 1) await sleep(180);
  }

  if (successfulDays > 0) {
    schedule.clear();
    for (const [id, fixture] of fetched) schedule.set(id, fixture);
    scheduleFetchedAt = Date.now();
    scheduleRefreshes++;
    lastScheduleRefreshAt = new Date().toISOString();
    lastScheduleError = null;
    cachedProviderFailure = null;
    logger.info(
      { successfulDays, trackedFixturesStored: schedule.size, scheduleDays: SCHEDULE_DAYS },
      "API-Football tracked weekly fixture schedule refreshed",
    );
  } else {
    lastScheduleError = firstError ?? "Schedule refresh returned no valid provider responses";
    logger.warn({ err: lastScheduleError }, "API-Football fixture schedule refresh failed; backoff active");
  }
}

async function refreshBundles(ids: number[], init?: RequestInit): Promise<StoredResponse | null> {
  for (let index = 0; index < ids.length; index += 20) {
    if (!requestAllowed("live")) break;
    const group = ids.slice(index, index + 20);
    if (!group.length) continue;
    const url = `${API_BASE}/fixtures?ids=${group.join("-")}`;
    const existing = responseCache.get(url);
    if (existing && Date.now() - existing.fetchedAt < LIVE_POLL_MS) {
      updateFixtureCaches(new URL(url), existing);
      continue;
    }

    try {
      const response = await originalFetch(url, providerInit(init));
      observeQuota(response.headers);
      providerCallsToday++;
      bundledProviderCalls++;
      lastProviderCallAt = new Date().toISOString();
      const stored = await store(response);
      responseCache.set(url, stored);
      if (responseHasProviderFailure(stored)) {
        cachedProviderFailure = stored;
        return stored;
      }
      cachedProviderFailure = null;
      updateFixtureCaches(new URL(url), stored);
    } catch (error) {
      logger.warn({ err: error, fixtureIds: group }, "API-Football bundled fixture refresh failed");
      throw error;
    }
  }
  return null;
}

function responseFromStoredSchedule(parsed: URL): Response | null {
  if (parsed.pathname !== "/fixtures") return null;
  const leagueId = Number(parsed.searchParams.get("league"));
  const from = parsed.searchParams.get("from");
  const to = parsed.searchParams.get("to");
  if (!Number.isInteger(leagueId) || !isTrackedLeague(leagueId) || !from || !to) return null;

  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T23:59:59Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const fixtures = Array.from(schedule.values()).filter((fixture) => {
    if (Number(fixture.league?.id) !== leagueId) return false;
    const kickoff = fixture.fixture?.date ? Date.parse(fixture.fixture.date) : NaN;
    return Number.isFinite(kickoff) && kickoff >= start && kickoff <= end;
  });
  return synthetic(parsed, fixtures);
}

function responseFromBundle(parsed: URL): Response | null {
  const fixtureId = Number(parsed.searchParams.get("fixture") ?? parsed.searchParams.get("id"));
  if (!Number.isInteger(fixtureId) || fixtureId <= 0) return null;
  const cached = bundles.get(fixtureId);
  if (!cached || Date.now() - cached.fetchedAt > bundleTtl(cached.fixture)) return null;

  const fixture = cached.fixture;
  let data: unknown | undefined;
  if (parsed.pathname === "/fixtures/events") data = fixture.events;
  else if (parsed.pathname === "/fixtures/lineups") data = fixture.lineups;
  else if (parsed.pathname === "/fixtures/statistics") data = fixture.statistics;
  else if (parsed.pathname === "/fixtures/players") data = fixture.players;
  else if (parsed.pathname === "/fixtures" && parsed.searchParams.has("id")) data = [fixture];
  if (data === undefined) return null;
  return synthetic(parsed, Array.isArray(data) ? data : []);
}

function updateFixtureCaches(parsed: URL, stored: StoredResponse): void {
  if (parsed.pathname !== "/fixtures") return;
  let json: ApiEnvelope;
  try {
    json = JSON.parse(stored.body) as ApiEnvelope;
  } catch {
    return;
  }
  if (!Array.isArray(json.response)) return;

  for (const fixture of json.response as FixtureRecord[]) {
    const id = Number(fixture.fixture?.id);
    const leagueId = Number(fixture.league?.id);
    if (!Number.isInteger(id) || id <= 0 || !isTrackedLeague(leagueId)) continue;
    schedule.set(id, fixture);
    if (
      parsed.searchParams.has("ids") ||
      parsed.searchParams.has("id") ||
      fixture.events !== undefined ||
      fixture.statistics !== undefined ||
      fixture.lineups !== undefined ||
      fixture.players !== undefined
    ) {
      bundles.set(id, { fixture, fetchedAt: stored.fetchedAt });
    }
  }
}

function cacheTtl(parsed: URL): number {
  if (parsed.pathname === "/fixtures") {
    if (parsed.searchParams.has("date")) return SCHEDULE_REFRESH_MS;
    if (parsed.searchParams.has("ids") || parsed.searchParams.has("id")) return LIVE_POLL_MS;
    if (parsed.searchParams.has("league") && parsed.searchParams.has("from")) return SCHEDULE_REFRESH_MS;
  }
  if (parsed.pathname === "/teams/statistics") return 6 * 60 * 60_000;
  if (parsed.pathname === "/standings") return 60 * 60_000;
  if (parsed.pathname === "/fixtures/headtohead") return 24 * 60 * 60_000;
  if (parsed.pathname === "/players" && parsed.searchParams.has("team")) return 6 * 60 * 60_000;
  if (parsed.pathname === "/injuries") return 60 * 60_000;
  if (parsed.pathname === "/leagues") return 24 * 60 * 60_000;
  if (["/fixtures/events", "/fixtures/statistics", "/fixtures/players"].includes(parsed.pathname)) return LIVE_POLL_MS;
  if (parsed.pathname === "/fixtures/lineups") return 30 * 60_000;
  return 5 * 60_000;
}

function priorityFor(parsed: URL): Priority {
  if (parsed.pathname === "/fixtures" && (parsed.searchParams.has("ids") || parsed.searchParams.has("id"))) return "live";
  if (["/fixtures/events", "/fixtures/statistics", "/fixtures/players"].includes(parsed.pathname)) return "live";
  if (parsed.pathname === "/fixtures" && parsed.searchParams.has("date")) return "normal";
  if (parsed.pathname === "/fixtures/lineups" || parsed.pathname === "/injuries") return "normal";
  if (["/teams/statistics", "/standings", "/fixtures/headtohead", "/players", "/leagues"].includes(parsed.pathname)) return "background";
  return "normal";
}

function requestAllowed(priority: Priority): boolean {
  const mode = quotaMode();
  if (mode === "full") return true;
  if (mode === "conserve") return priority !== "background";
  if (mode === "protect") return priority === "critical" || priority === "live";
  return priority === "critical" || priority === "live";
}

function quotaMode(): ApiFootballQuotaMode {
  const budget = effectiveDailyBudget();
  const used = effectiveUsedToday();
  const ratio = budget > 0 ? used / budget : 1;
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.85) return "protect";
  if (ratio >= 0.70) return "conserve";
  return "full";
}

function effectiveDailyBudget(): number {
  return providerLimit && providerLimit > 0 ? Math.min(DAILY_BUDGET, providerLimit) : DAILY_BUDGET;
}

function effectiveUsedToday(): number {
  if (providerLimit != null && providerRemaining != null) return Math.max(0, providerLimit - providerRemaining);
  return providerCallsToday;
}

function observeQuota(headers: Headers): void {
  const limit = Number(headers.get("x-ratelimit-requests-limit"));
  const remaining = Number(headers.get("x-ratelimit-requests-remaining"));
  if (Number.isFinite(limit) && limit > 0) providerLimit = limit;
  if (Number.isFinite(remaining) && remaining >= 0) providerRemaining = remaining;
  if ((Number.isFinite(limit) && limit > 0) || (Number.isFinite(remaining) && remaining >= 0)) {
    providerQuotaObservedAt = new Date().toISOString();
  }
}

function responseHasProviderFailure(stored: StoredResponse): boolean {
  if (stored.status < 200 || stored.status >= 300) return true;
  try {
    const json = JSON.parse(stored.body) as ApiEnvelope;
    return normalizeErrors(json.errors).length > 0;
  } catch {
    return true;
  }
}

function bundleTtl(fixture: FixtureRecord): number {
  const status = fixture.fixture?.status?.short ?? "";
  if (LIVE_STATUSES.has(status)) return LIVE_POLL_MS;
  const kickoff = fixture.fixture?.date ? Date.parse(fixture.fixture.date) : NaN;
  const msToKickoff = Number.isFinite(kickoff) ? kickoff - Date.now() : 0;
  if (msToKickoff > 15 * 60_000) return 5 * 60_000;
  if (msToKickoff > 0) return 2 * 60_000;
  return LIVE_POLL_MS;
}

function providerInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  if (API_KEY && !headers.has("x-apisports-key")) headers.set("x-apisports-key", API_KEY);
  return { ...init, headers };
}

function synthetic(parsed: URL, response: unknown[]): Response {
  return new Response(JSON.stringify({
    get: parsed.pathname.replace(/^\//, ""),
    parameters: Object.fromEntries(parsed.searchParams.entries()),
    errors: [],
    results: response.length,
    paging: { current: 1, total: 1 },
    response,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-quota-optimised": "true",
    },
  });
}

async function store(response: Response): Promise<StoredResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.text(),
    fetchedAt: Date.now(),
  };
}

function restore(stored: StoredResponse): Response {
  return new Response(stored.body, {
    status: stored.status,
    statusText: stored.statusText,
    headers: stored.headers,
  });
}

function isLiveDiscovery(parsed: URL): boolean {
  return parsed.pathname === "/fixtures" && parsed.searchParams.get("live") === "all";
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isApiFootballUrl(url: string): boolean {
  try {
    return new URL(url).hostname === API_HOST;
  } catch {
    return false;
  }
}

function normalizeErrors(errors: unknown): string[] {
  if (Array.isArray(errors)) return errors.map(String).filter(Boolean);
  if (errors && typeof errors === "object") return Object.values(errors as Record<string, unknown>).map(String).filter(Boolean);
  if (errors) return [String(errors)];
  return [];
}

function rollBudgetDate(): void {
  const today = utcDay();
  if (today === budgetDate) return;
  budgetDate = today;
  providerCallsToday = 0;
  providerLimit = null;
  providerRemaining = null;
  providerQuotaObservedAt = null;
  blockedCalls = 0;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function clamp(value: number, min: number, max: number): number {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, safe));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
