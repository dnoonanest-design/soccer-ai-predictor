import { logger } from "./logger";

const API_FOOTBALL_HOST = "v3.football.api-sports.io";

let installed = false;
let delegatedFetch: typeof globalThis.fetch | null = null;
let liveDiscoveryInFlight: Promise<Response> | null = null;
let deduplicatedRequests = 0;
let lastDeduplicatedAt: string | null = null;

/**
 * API-Football live discovery is special inside the quota optimiser because it
 * may bootstrap the multi-day fixture schedule before serving /fixtures?live=all.
 * If two workers ask for live discovery at the same instant during startup,
 * both requests could otherwise enter that bootstrap path before the schedule
 * cache is ready. This outer guard makes the whole live-discovery transaction
 * single-flight while preserving every existing quota/odds wrapper underneath.
 */
export function installLiveDiscoveryConcurrencyGuard(): void {
  if (installed) return;
  delegatedFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = guardedFetch as typeof globalThis.fetch;
  installed = true;
  logger.info("API-Football live discovery concurrency guard active");
}

export function getLiveDiscoveryConcurrencyGuardStatus() {
  return {
    installed,
    inFlight: liveDiscoveryInFlight !== null,
    deduplicatedRequests,
    lastDeduplicatedAt,
  };
}

async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const delegate = delegatedFetch ?? globalThis.fetch.bind(globalThis);
  const parsed = safeUrl(requestUrl(input));

  if (!isLiveDiscovery(parsed)) {
    return delegate(input, init);
  }

  if (liveDiscoveryInFlight) {
    deduplicatedRequests++;
    lastDeduplicatedAt = new Date().toISOString();
    return (await liveDiscoveryInFlight).clone();
  }

  const work = delegate(input, init);
  liveDiscoveryInFlight = work;
  try {
    // Return a clone so the original response remains untouched for any
    // concurrent waiter that joined the same in-flight request.
    return (await work).clone();
  } finally {
    liveDiscoveryInFlight = null;
  }
}

function isLiveDiscovery(parsed: URL | null): boolean {
  return Boolean(
    parsed &&
    parsed.hostname === API_FOOTBALL_HOST &&
    parsed.pathname === "/fixtures" &&
    parsed.searchParams.get("live") === "all"
  );
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
