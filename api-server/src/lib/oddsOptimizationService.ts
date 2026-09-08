import { logger } from "./logger";

const ODDS_HOST = "api.the-odds-api.com";
const ENABLED = process.env.ODDS_QUOTA_OPTIMIZATION_ENABLED !== "false";

const FAR_TTL_MS = clamp(Number(process.env.ODDS_CACHE_FAR_MS ?? 2 * 60 * 60_000), 30 * 60_000, 6 * 60 * 60_000);
const MID_TTL_MS = clamp(Number(process.env.ODDS_CACHE_MID_MS ?? 60 * 60_000), 15 * 60_000, 3 * 60 * 60_000);
const NEAR_TTL_MS = clamp(Number(process.env.ODDS_CACHE_NEAR_MS ?? 30 * 60_000), 5 * 60_000, 60 * 60_000);
const CLOSE_TTL_MS = clamp(Number(process.env.ODDS_CACHE_CLOSE_MS ?? 10 * 60_000), 2 * 60_000, 30 * 60_000);
const LIVE_TTL_MS = clamp(Number(process.env.ODDS_CACHE_LIVE_MS ?? 5 * 60_000), 60_000, 15 * 60_000);
const EMPTY_TTL_MS = clamp(Number(process.env.ODDS_CACHE_EMPTY_MS ?? 30 * 60_000), 5 * 60_000, 2 * 60 * 60_000);
const FAILURE_BACKOFF_MS = clamp(Number(process.env.ODDS_FAILURE_BACKOFF_MS ?? 15 * 60_000), 60_000, 60 * 60_000);

export type OddsQuotaMode = "full" | "conserve" | "protect" | "critical";

type StoredResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  fetchedAt: number;
};

type CacheEntry = {
  response: StoredResponse;
  ttlMs: number;
  nearestCommenceMs: number | null;
  hasLiveEvent: boolean;
  estimatedCost: number;
};

type OddsEvent = {
  commence_time?: string;
  [key: string]: unknown;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();
const failureCache = new Map<string, StoredResponse>();

let installed = false;
let delegatedFetch: typeof globalThis.fetch | null = null;
let providerRequests = 0;
let providerUsed: number | null = null;
let providerRemaining: number | null = null;
let providerTotal: number | null = null;
let lastRequestCost: number | null = null;
let lastQuotaObservedAt: string | null = null;
let lastProviderCallAt: string | null = null;
let lastProviderError: string | null = null;
let cacheHits = 0;
let staleCacheHits = 0;
let inFlightDeduplications = 0;
let blockedCalls = 0;
let estimatedCreditsSaved = 0;

export function installOddsOptimizationLayer(): void {
  if (installed || !ENABLED) return;
  delegatedFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = oddsOptimizedFetch as typeof globalThis.fetch;
  installed = true;

  logger.info(
    {
      farTtlMs: FAR_TTL_MS,
      midTtlMs: MID_TTL_MS,
      nearTtlMs: NEAR_TTL_MS,
      closeTtlMs: CLOSE_TTL_MS,
      liveTtlMs: LIVE_TTL_MS,
      failureBackoffMs: FAILURE_BACKOFF_MS,
    },
    "Odds API quota optimisation layer active",
  );
}

export function getOddsOptimizationStatus() {
  const utilisationPct = providerTotal && providerUsed != null
    ? Math.round((providerUsed / providerTotal) * 10_000) / 100
    : null;

  return {
    enabled: ENABLED,
    installed,
    mode: quotaMode(),
    provider: {
      used: providerUsed,
      remaining: providerRemaining,
      total: providerTotal,
      lastRequestCost,
      utilisationPct,
      quotaObservedAt: lastQuotaObservedAt,
    },
    requests: {
      providerRequests,
      cacheHits,
      staleCacheHits,
      inFlightDeduplications,
      blockedCalls,
      estimatedCreditsSaved,
    },
    cache: {
      entries: cache.size,
      farTtlMs: FAR_TTL_MS,
      midTtlMs: MID_TTL_MS,
      nearTtlMs: NEAR_TTL_MS,
      closeTtlMs: CLOSE_TTL_MS,
      liveTtlMs: LIVE_TTL_MS,
      emptyTtlMs: EMPTY_TTL_MS,
    },
    lastProviderCallAt,
    lastProviderError,
  };
}

async function oddsOptimizedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const delegate = delegatedFetch ?? globalThis.fetch.bind(globalThis);
  const rawUrl = requestUrl(input);
  const parsed = safeUrl(rawUrl);

  if (!ENABLED || !parsed || parsed.hostname !== ODDS_HOST || !isOddsEndpoint(parsed)) {
    return delegate(input, init);
  }

  const key = canonicalKey(parsed);
  const now = Date.now();
  const estimatedCost = estimateRequestCost(parsed);
  const cached = cache.get(key);

  if (cached && now - cached.response.fetchedAt < cached.ttlMs) {
    cacheHits++;
    estimatedCreditsSaved += cached.estimatedCost;
    return restoreResponse(cached.response, true);
  }

  const mode = quotaMode();
  if (cached && shouldServeStale(mode, cached, now)) {
    staleCacheHits++;
    estimatedCreditsSaved += cached.estimatedCost;
    return restoreResponse(cached.response, true, true);
  }

  const cachedFailure = failureCache.get(key);
  if (cachedFailure && now - cachedFailure.fetchedAt < FAILURE_BACKOFF_MS) {
    blockedCalls++;
    return restoreResponse(cachedFailure, true, true);
  }

  if (!requestAllowed(mode, cached, now)) {
    blockedCalls++;
    if (cached) {
      staleCacheHits++;
      estimatedCreditsSaved += cached.estimatedCost;
      return restoreResponse(cached.response, true, true);
    }
    return syntheticEmptyResponse();
  }

  const existing = inFlight.get(key);
  if (existing) {
    inFlightDeduplications++;
    estimatedCreditsSaved += estimatedCost;
    const result = await existing;
    return restoreResponse(result.response, true);
  }

  const work = fetchAndStore(delegate, input, init, parsed, estimatedCost);
  inFlight.set(key, work);
  try {
    const result = await work;
    if (result.response.status >= 200 && result.response.status < 300) {
      cache.set(key, result);
      failureCache.delete(key);
    } else {
      failureCache.set(key, result.response);
    }
    return restoreResponse(result.response, false);
  } finally {
    inFlight.delete(key);
  }
}

async function fetchAndStore(
  delegate: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  parsed: URL,
  estimatedCost: number,
): Promise<CacheEntry> {
  const response = await delegate(input, init);
  providerRequests++;
  lastProviderCallAt = new Date().toISOString();
  observeQuota(response.headers);

  const stored = await storeResponse(response);
  if (stored.status < 200 || stored.status >= 300) {
    lastProviderError = `Odds API HTTP ${stored.status}`;
    return {
      response: stored,
      ttlMs: FAILURE_BACKOFF_MS,
      nearestCommenceMs: null,
      hasLiveEvent: false,
      estimatedCost,
    };
  }

  lastProviderError = null;
  const timing = analyseTiming(stored.body);
  return {
    response: stored,
    ttlMs: ttlForTiming(timing.nearestCommenceMs, timing.hasLiveEvent, timing.eventCount),
    nearestCommenceMs: timing.nearestCommenceMs,
    hasLiveEvent: timing.hasLiveEvent,
    estimatedCost,
  };
}

function analyseTiming(body: string) {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { nearestCommenceMs: null as number | null, hasLiveEvent: false, eventCount: 0 };
  }

  if (!Array.isArray(data)) {
    // Single-event odds endpoints return an object. Treat its commence time as one event.
    const event = data as OddsEvent | null;
    const time = event?.commence_time ? Date.parse(event.commence_time) : NaN;
    return {
      nearestCommenceMs: Number.isFinite(time) ? time : null,
      hasLiveEvent: Number.isFinite(time) ? time <= Date.now() && time >= Date.now() - 4 * 60 * 60_000 : false,
      eventCount: event ? 1 : 0,
    };
  }

  const now = Date.now();
  const times = (data as OddsEvent[])
    .map((event) => event.commence_time ? Date.parse(event.commence_time) : NaN)
    .filter((time) => Number.isFinite(time));
  const future = times.filter((time) => time > now).sort((a, b) => a - b);
  const hasLiveEvent = times.some((time) => time <= now && time >= now - 4 * 60 * 60_000);

  return {
    nearestCommenceMs: future[0] ?? null,
    hasLiveEvent,
    eventCount: data.length,
  };
}

function ttlForTiming(nearestCommenceMs: number | null, hasLiveEvent: boolean, eventCount: number): number {
  if (eventCount === 0) return EMPTY_TTL_MS;
  if (hasLiveEvent) return LIVE_TTL_MS;
  if (nearestCommenceMs == null) return MID_TTL_MS;

  const hours = (nearestCommenceMs - Date.now()) / 3_600_000;
  if (hours <= 1) return CLOSE_TTL_MS;
  if (hours <= 6) return NEAR_TTL_MS;
  if (hours <= 24) return MID_TTL_MS;
  return FAR_TTL_MS;
}

function shouldServeStale(mode: OddsQuotaMode, entry: CacheEntry, now: number): boolean {
  const age = now - entry.response.fetchedAt;
  if (mode === "full") return false;
  if (mode === "conserve") return age < Math.max(entry.ttlMs * 2, 20 * 60_000);
  if (mode === "protect") return age < Math.max(entry.ttlMs * 4, 2 * 60 * 60_000);
  return age < 24 * 60 * 60_000;
}

function requestAllowed(mode: OddsQuotaMode, entry: CacheEntry | undefined, now: number): boolean {
  if (mode === "full" || mode === "conserve") return true;
  if (mode === "protect") {
    if (!entry) return true;
    if (entry.hasLiveEvent) return true;
    return entry.nearestCommenceMs != null && entry.nearestCommenceMs - now <= 6 * 60 * 60_000;
  }
  if (!entry) return false;
  if (entry.hasLiveEvent) return true;
  return entry.nearestCommenceMs != null && entry.nearestCommenceMs - now <= 60 * 60_000;
}

function quotaMode(): OddsQuotaMode {
  if (providerUsed == null || providerTotal == null || providerTotal <= 0) return "full";
  const ratio = providerUsed / providerTotal;
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.85) return "protect";
  if (ratio >= 0.70) return "conserve";
  return "full";
}

function observeQuota(headers: Headers): void {
  const used = Number(headers.get("x-requests-used"));
  const remaining = Number(headers.get("x-requests-remaining"));
  const last = Number(headers.get("x-requests-last"));

  if (Number.isFinite(used) && used >= 0) providerUsed = used;
  if (Number.isFinite(remaining) && remaining >= 0) providerRemaining = remaining;
  if (providerUsed != null && providerRemaining != null) providerTotal = providerUsed + providerRemaining;
  if (Number.isFinite(last) && last >= 0) lastRequestCost = last;

  if (providerUsed != null || providerRemaining != null || lastRequestCost != null) {
    lastQuotaObservedAt = new Date().toISOString();
  }
}

function estimateRequestCost(parsed: URL): number {
  const markets = splitCsv(parsed.searchParams.get("markets") ?? "h2h").length || 1;
  const regions = splitCsv(parsed.searchParams.get("regions") ?? "us").length || 1;
  return Math.max(1, markets * regions);
}

function splitCsv(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function isOddsEndpoint(parsed: URL): boolean {
  return parsed.pathname.startsWith("/v4/") && parsed.pathname.endsWith("/odds");
}

function canonicalKey(parsed: URL): string {
  const params = Array.from(parsed.searchParams.entries())
    .filter(([key]) => key.toLowerCase() !== "apikey")
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  return `${parsed.origin}${parsed.pathname}?${new URLSearchParams(params).toString()}`;
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

function restoreResponse(stored: StoredResponse, optimised: boolean, stale = false): Response {
  const headers = new Headers(stored.headers);
  if (optimised) headers.set("x-odds-optimised", "true");
  if (stale) headers.set("x-odds-stale", "true");
  return new Response(stored.body, {
    status: stored.status,
    statusText: stored.statusText,
    headers,
  });
}

function syntheticEmptyResponse(): Response {
  return new Response("[]", {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-odds-optimised": "true",
      "x-odds-quota-protected": "true",
    },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, safe));
}
