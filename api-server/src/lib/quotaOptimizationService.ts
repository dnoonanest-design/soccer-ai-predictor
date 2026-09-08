import { logger } from "./logger";

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const API_FOOTBALL_HOST = "v3.football.api-sports.io";
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";

const ENABLED = process.env.API_FOOTBALL_QUOTA_OPTIMIZATION_ENABLED !== "false";
const SCHEDULE_DAYS = clamp(Number(process.env.API_FOOTBALL_SCHEDULE_DAYS ?? 8), 7, 14);
const SCHEDULE_REFRESH_MS = clamp(
  Number(process.env.API_FOOTBALL_SCHEDULE_REFRESH_MS ?? 6 * 60 * 60_000),
  60 * 60_000,
  12 * 60 * 60_000,
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
export type ApiFootballRequestPriority = "critical" | "live" | "normal" | "background";

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
  get?: string;
  parameters?: Record<string, unknown>;
  errors?: unknown;
  results?: number;
  paging?: { current?: number; total?: number };
  response?: unknown;
};

const responseCache = new Map<string, StoredResponse>();
const inFlight = new Map<string, Promise<StoredResponse>>();
const schedule = new Map<number, FixtureRecord>();
const fixtureBundles = new Map<number, { fixture: FixtureRecord; fetchedAt: number }>();

let installed = false;
let scheduleFetchedAt = 0;
let scheduleRefreshes = 0;
let liveDiscoveryRequestsAvoided = 0;
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
let lastProviderCallAt: string | null = null;
let lastBlockedPath: string | null = null;
let lastScheduleRefreshAt: string | null = null;
let lastScheduleError: string | null = null;

const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]);
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

export function installQuotaOptimizationLayer(): void {
  if (installed || !ENABLED) return;
  installed = true;
  globalThis.fetch = quotaOptimizedFetch as typeof globalThis.fetch;
  logger.info(
    {
      scheduleDays: SCHEDULE_DAYS,
      scheduleRefreshMs: SCHEDULE_REFRESH_MS,
      dailyBudget: DAILY_BUDGET,
      livePollMs: LIVE_POLL_MS,
      prematchLeadMs: PREMATCH_LEAD_MS,
    },
    "API-Football quota optimisation layer active",
  );
}

export function getQuotaOptimizationStatus() {
  rollBudgetDate();
  const effectiveBudget = getEffectiveBudget();
  const used = getEffectiveUsed();
  const utilisationPct = effectiveBudget > 0
    ? Math.round((used / effectiveBudget) * 10_000) / 100
    : 0;

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
    utilisationPct,
    providerCallsToday,
    cacheHits,
    bundleCacheHits,
    bundledProviderCalls,
    blockedCalls,
    estimatedCallsSaved,
    liveDiscoveryRequestsAvoided,
    schedule: {
      days: SCHEDULE_DAYS,
      fixturesStored: schedule.size,
      refreshMs: SCHEDULE_REFRESH_MS,
      refreshes: scheduleRefreshes,
      lastRefreshAt: lastScheduleRefreshAt,
      lastError: lastScheduleError,
    },
    lastProviderCallAt,
    lastBlockedPath,
  };
}

async function quotaOptimizedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = requestUrl(input);
  if (!ENABLED || !isApiFootballUrl(url)) {
    return originalFetch(input, init);
  }

  rollBudgetDate();
  const parsed = new URL(url);

  if (parsed.pathname === "/fixtures" && parsed.searchParams.get("live") === "all") {
    return handleLiveDiscoveryReplacement(init);
  }

  const bundled = bundledEndpointResponse(parsed);
  if (bundled) {
    bundleCacheHits++;
    estimatedCallsSaved++;
    return bundled;
  }

  const ttl = cacheTtlFor(parsed);
  const cached = responseCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    cacheHits++;
    estimatedCallsSaved++;
    return restoreResponse(cached);
  }

  const priority = priorityFor(parsed);
  if (!requestAllowed(priority)) {
    blockedCalls++;
    lastBlockedPath = `${parsed.pathname}${parsed.search}`;
    if (cached) {
      cacheHits++;
      estimatedCallsSaved++;
      return restoreResponse(cached);
    }
    return syntheticEnvelopeResponse(parsed, []);
  }

  const existing = inFlight.get(url);
  if (existing) {
    cacheHits++;
    estimatedCallsSaved++;
    return restoreResponse(await existing);
  }

  const work = performProviderRequest(input, init, url, parsed);
  inFlight.set(url, work);
  try {
    return restoreResponse(await work);
  } finally {
    inFlight.delete(url);
  }
}

async function performProviderRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
  parsed: URL,
): Promise<StoredResponse> {
  const response = await originalFetch(input, init);
  observeQuota(response.headers);
  providerCallsToday++;
  lastProviderCallAt = new Date().toISOString();

  const stored = await storeResponse(response);
  if (stored.status >= 200 && stored.status < 300) {
    responseCache.set(url, stored);
    updateFixtureCachesFromStored(parsed, stored);
  }
  return stored;
}

async function handleLiveDiscoveryReplacement(init?: RequestInit): Promise<Response> {
  liveDiscoveryRequestsAvoided++;
  estimatedCallsSaved++;

  await ensureSchedule(init);
  const now = Date.now();
  const candidates = Array.from(schedule.values())
    .filter((fixture) => {
      const id = fixture.fixture?.id;
      const kickoff = fixture.fixture?.date ? Date.parse(fixture.fixture.date) : NaN;
      const status = fixture.fixture?.status?.short ?? "";
      if (!id || !Number.isFinite(kickoff) || FINISHED_STATUSES.has(status)) return false;
      return kickoff >= now - ACTIVE_TAIL_MS && kickoff <= now + PREMATCH_LEAD_MS;
    })
    .sort((a, b) => Date.parse(a.fixture?.date ?? "") - Date.parse(b.fixture?.date ?? ""));

  if (candidates.length === 0) {
    return syntheticEnvelopeResponse(new URL(`${API_FOOTBALL_BASE}/fixtures?live=all`), []);
  }

  const ids = candidates
    .map((fixture) => Number(fixture.fixture?.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  const freshest = ids.every((id) => {
    const cached = fixtureBundles.get(id);
    if (!cached) return false;
    return Date.now() - cached.fetchedAt < bundleTtl(cached.fixture);
  });

  if (!freshest && requestAllowed("live")) {
    await refreshFixtureBundles(ids, init);
  }

  const current = ids
    .map((id) => fixtureBundles.get(id)?.fixture ?? schedule.get(id))
    .filter((fixture): fixture is FixtureRecord => Boolean(fixture));
  const live = current.filter((fixture) => LIVE_STATUSES.has(fixture.fixture?.status?.short ?? ""));

  return syntheticEnvelopeResponse(new URL(`${API_FOOTBALL_BASE}/fixtures?live=all`), live);
}

async function ensureSchedule(init?: RequestInit): Promise<void> {
  if (scheduleFetchedAt > 0 && Date.now() - scheduleFetchedAt < SCHEDULE_REFRESH_MS) return;
  if (!requestAllowed("normal") && schedule.size > 0) return;

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
    const url = `${API_FOOTBALL_BASE}/fixtures?date=${date}&timezone=UTC`;

    try {
      const response = await originalFetch(url, providerInit(init));
      observeQuota(response.headers);
      providerCallsToday++;
      lastProviderCallAt = new Date().toISOString();
      const stored = await storeResponse(response);
      responseCache.set(url, stored);
      const json = JSON.parse(stored.body) as ApiEnvelope;
      const errors = normalizeErrors(json.errors);
      if (stored.status < 200 || stored.status >= 300 || errors.length > 0 || !Array.isArray(json.response)) {
        firstError ??= errors.join("; ") || `HTTP ${stored.status}`;
        continue;
      }
      successfulDays++;
      for (const raw of json.response as FixtureRecord[]) {
        const id = Number(raw.fixture?.id);
        if (Number.isInteger(id) && id > 0) fetched.set(id, raw);
      }
    } catch (error) {
      firstError ??= error instanceof Error ? error.message : String(error);
    }

    if (offset < SCHEDULE_DAYS - 1) await sleep(180);
  }

  if (successfulDays > 0) {
    for (const [id, fixture] of fetched) schedule.set(id, fixture);
    scheduleFetchedAt = Date.now();
    scheduleRefreshes++;
    lastScheduleRefreshAt = new Date().toISOString();
    lastScheduleError = null;
    logger.info(
      { successfulDays, fixturesStored: schedule.size, scheduleDays: SCHEDULE_DAYS },
      "API-Football weekly fixture schedule refreshed",
    );
  } else {
    lastScheduleError = firstError ?? "Schedule refresh returned no valid provider responses";
    logger.warn({ err: lastScheduleError }, "API-Football fixture schedule refresh failed");
  }
}

async function refreshFixtureBundles(ids: number[], init?: RequestInit): Promise<void> {
  for (let index = 0; index < ids.length; index += 20) {
    if (!requestAllowed("live")) break;
    const group = ids.slice(index, index + 20);
    if (!group.length) continue;
    const url = `${API_FOOTBALL_BASE}/fixtures?ids=${group.join("-")}`;

    const existing = responseCache.get(url);
    if (existing && Date.now() - existing.fetchedAt < LIVE_POLL_MS) {
      updateFixtureCachesFromStored(new URL(url), existing);
      continue;
    }

    try {
      const response = await originalFetch(url, providerInit(init));
      observeQuota(response.headers);
      providerCallsToday++;
      bundledProviderCalls++;
      lastProviderCallAt = new Date().toISOString();
      const stored = await storeResponse(response);
      responseCache.set(url, stored);
      updateFixtureCachesFromStored(new URL(url), stored);
    } catch (error) {
      logger.warn({ err: error, fixtureIds: group }, "API-Football bundled fixture refresh failed");
    }
  }
}

function bundledEndpointResponse(parsed: URL): Response | null {
  const fixtureIdRaw = parsed.searchParams.get("fixture") ?? parsed.searchParams.get("id");
  const fixtureId = Number(fixtureIdRaw);
  if (!Number.isInteger(fixtureId) || fixtureId <= 0) return null;

  const bundle = fixtureBundles.get(fixtureId);
  if (!bundle || Date.now() - bundle.fetchedAt > bundleTtl(bundle.fixture)) return null;
  const fixture = bundle.fixture;

  let response: unknown | undefined;
  if (parsed.pathname === "/fixtures/events") response = fixture.events;
  else if (parsed.pathname === "/fixtures/lineups") response = fixture.lineups;
  else if (parsed.pathname === "/fixtures/statistics") response = fixture.statistics;
  else if (parsed.pathname === "/fixtures/players") response = fixture.players;
  else if (parsed.pathname === "/fixtures" && parsed.searchParams.has("id")) response = [fixture];

  if (response === undefined) return null;
  return syntheticEnvelopeResponse(parsed, Array.isArray(response) ? response : []);
}

function updateFixtureCachesFromStored(parsed: URL, stored: StoredResponse): void {
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
    if (!Number.isInteger(id) || id <= 0) continue;
    schedule.set(id, fixture);
    if (
      parsed.searchParams.has("ids") ||
      parsed.searchParams.has("id") ||
      fixture.events !== undefined ||
      fixture.statistics !== undefined ||
      fixture.lineups !== undefined ||
      fixture.players !== undefined
    ) {
      fixtureBundles.set(id, { fixture, fetchedAt: stored.fetchedAt });
    }
  }
}

function cacheTtlFor(parsed: URL): number {
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
  if (parsed.pathname === "/fixtures/events") return LIVE_POLL_MS;
  if (parsed.pathname === "/fixtures/statistics") return LIVE_POLL_MS;
  if (parsed.pathname === "/fixtures/players") return LIVE_POLL_MS;
  if (parsed.pathname === "/fixtures/lineups") return 30 * 60_000;
  return 5 * 60_000;
}

function priorityFor(parsed: URL): ApiFootballRequestPriority {
  if (parsed.pathname === "/fixtures" && (parsed.searchParams.has("ids") || parsed.searchParams.has("id"))) return "live";
  if (["/fixtures/events", "/fixtures/statistics", "/fixtures/players"].includes(parsed.pathname)) return "live";
  if (parsed.pathname === "/fixtures" && parsed.searchParams.has("date")) return "normal";
  if (parsed.pathname === "/fixtures/lineups" || parsed.pathname === "/injuries") return "normal";
  if (["/teams/statistics", "/standings", "/fixtures/headtohead", "/players", "/leagues"].includes(parsed.pathname)) return "background";
  return "normal";
}

function requestAllowed(priority: ApiFootballRequestPriority): boolean {
  const mode = quotaMode();
  if (mode === "full") return true;
  if (mode === "conserve") return priority !== "background";
  if (mode === "protect") return priority === "critical" || priority === "live";
  return priority === "critical" || priority === "live";
}

function quotaMode(): ApiFootballQuotaMode {
  const budget = getEffectiveBudget();
  const used = getEffectiveUsed();
  if (budget <= 0) return "critical";
  const ratio = used / budget;
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.85) return "protect";
  if (ratio >= 0.70) return "conserve";
  return "full";
}

function getEffectiveBudget(): number {
  if (providerLimit && providerLimit > 0) return Math.min(DAILY_BUDGET, providerLimit);
  return DAILY_BUDGET;
}

function getEffectiveUsed(): number {
  if (providerLimit != null && providerRemaining != null) {
    return Math.max(0, providerLimit - providerRemaining);
  }
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

function providerInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  if (API_FOOTBALL_KEY && !headers.has("x-apisports-key")) headers.set("x-apisports-key", API_FOOTBALL_KEY);
  return { ...init, headers };
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

function syntheticEnvelopeResponse(parsed: URL, response: unknown[]): Response {
  const body = JSON.stringify({
    get: parsed.pathname.replace(/^\//, ""),
    parameters: Object.fromEntries(parsed.searchParams.entries()),
    errors: [],
    results: response.length,
    paging: { current: 1, total: 1 },
    response,
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "x-quota-optimised": "true" },
  });
}

async function storeResponse(response: Response): Promise<StoredResponse> {
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

function restoreResponse(stored: StoredResponse): Response {
  return new Response(stored.body, {
    status: stored.status,
    statusText: stored.statusText,
    headers: stored.headers,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isApiFootballUrl(url: string): boolean {
  try {
    return new URL(url).hostname === API_FOOTBALL_HOST;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
