import { logger } from "./logger";

export type ApiFootballProviderState = "unknown" | "healthy" | "degraded" | "offline";

export type ApiFootballProviderHealth = {
  state: ApiFootballProviderState;
  configured: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastPath: string | null;
  lastError: string | null;
  httpStatus: number | null;
};

export type ApiFootballFailureKind =
  | "configuration"
  | "authentication"
  | "subscription"
  | "rate_limit"
  | "transport"
  | "provider"
  | "malformed_response";

export class ApiFootballProviderError extends Error {
  readonly path: string;
  readonly kind: ApiFootballFailureKind;
  readonly httpStatus: number | null;

  constructor(
    message: string,
    options: {
      path: string;
      kind: ApiFootballFailureKind;
      httpStatus?: number | null;
    },
  ) {
    super(message);
    this.name = "ApiFootballProviderError";
    this.path = options.path;
    this.kind = options.kind;
    this.httpStatus = options.httpStatus ?? null;
  }
}

let providerHealth: ApiFootballProviderHealth = {
  state: process.env.API_FOOTBALL_KEY ? "unknown" : "offline",
  configured: Boolean(process.env.API_FOOTBALL_KEY),
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastFailureAt: process.env.API_FOOTBALL_KEY ? null : new Date().toISOString(),
  consecutiveFailures: process.env.API_FOOTBALL_KEY ? 0 : 1,
  lastPath: null,
  lastError: process.env.API_FOOTBALL_KEY ? null : "API_FOOTBALL_KEY not set",
  httpStatus: null,
};

export function getApiFootballProviderHealth(): ApiFootballProviderHealth {
  return { ...providerHealth };
}

export function markApiFootballSuccess(path: string): void {
  const now = new Date().toISOString();
  providerHealth = {
    ...providerHealth,
    state: "healthy",
    configured: true,
    lastCheckedAt: now,
    lastSuccessAt: now,
    consecutiveFailures: 0,
    lastPath: path,
    lastError: null,
    httpStatus: null,
  };
}

export function classifyApiFootballFailure(
  message: string,
  httpStatus?: number | null,
): { kind: ApiFootballFailureKind; state: ApiFootballProviderState } {
  const text = message.toLowerCase();

  if (httpStatus === 401 || /api[_ -]?football[_ -]?key not set|missing.*key/.test(text)) {
    return { kind: "configuration", state: "offline" };
  }
  if (
    httpStatus === 403 ||
    /suspend|invalid.*key|api key|authentication|unauthori[sz]ed|forbidden/.test(text)
  ) {
    return { kind: "authentication", state: "offline" };
  }
  if (/free plans?|subscription|plan does not|do not have access|account.*access/.test(text)) {
    return { kind: "subscription", state: "offline" };
  }
  if (httpStatus === 429 || /rate.?limit|too many requests|quota/.test(text)) {
    return { kind: "rate_limit", state: "degraded" };
  }
  if (httpStatus != null && httpStatus >= 500) {
    return { kind: "provider", state: "degraded" };
  }
  if (httpStatus != null && httpStatus >= 400) {
    return { kind: "provider", state: "degraded" };
  }
  return { kind: "transport", state: "degraded" };
}

export function markApiFootballFailure(options: {
  path: string;
  message: string;
  httpStatus?: number | null;
  kind?: ApiFootballFailureKind;
  state?: ApiFootballProviderState;
}): ApiFootballProviderError {
  const now = new Date().toISOString();
  const classified = classifyApiFootballFailure(
    options.message,
    options.httpStatus,
  );
  const kind = options.kind ?? classified.kind;
  const state = options.state ?? classified.state;

  providerHealth = {
    ...providerHealth,
    state,
    configured: Boolean(process.env.API_FOOTBALL_KEY),
    lastCheckedAt: now,
    lastFailureAt: now,
    consecutiveFailures: providerHealth.consecutiveFailures + 1,
    lastPath: options.path,
    lastError: options.message,
    httpStatus: options.httpStatus ?? null,
  };

  logger.warn(
    {
      path: options.path,
      kind,
      state,
      httpStatus: options.httpStatus ?? null,
      consecutiveFailures: providerHealth.consecutiveFailures,
    },
    "API-Football provider health degraded",
  );

  return new ApiFootballProviderError(options.message, {
    path: options.path,
    kind,
    httpStatus: options.httpStatus,
  });
}

export function isApiFootballProviderError(
  error: unknown,
): error is ApiFootballProviderError {
  return error instanceof ApiFootballProviderError;
}
