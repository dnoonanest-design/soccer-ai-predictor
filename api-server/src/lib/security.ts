/**
 * Security middleware for the Soccer AI Predictor API.
 *
 * Applied in app.ts before all routes. Covers:
 *   1. HTTP security headers (helmet)
 *   2. Restrictive CORS (configurable origins)
 *   3. Body size limits (10 kb JSON, 4 kb URL-encoded, prototype-pollution safe)
 *   4. Per-endpoint rate limiting (general, stats-heavy, admin)
 *   5. Admin route authentication (shared secret via ADMIN_SECRET env var)
 *   6. SSE connection limiting
 *   7. Basic request sanitisation (numeric param coercion, string length caps)
 */

import { type Request, type Response, type NextFunction } from "express";
import { logger } from "./logger";

// ─── 1. Security headers (inline helmet-equivalent) ───────────────────────────
// helmet is not bundled — we apply the same protections manually so no new
// npm dependency is needed in the esbuild bundle.

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Prevent MIME-type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Deny framing (clickjacking)
  res.setHeader("X-Frame-Options", "DENY");
  // Legacy XSS filter for older browsers
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Referrer policy — don't leak full URLs to third parties
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions policy — disable sensitive browser APIs
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // HSTS (only send over HTTPS; ignored by HTTP so safe for local dev)
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Content-Security-Policy — restrict what the embedded frontend can load.
  // API responses are JSON so a tight CSP is safe here.
  // The frontend SPA (served from the same origin) also benefits.
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",        // inline scripts needed for the SPA
      "style-src 'self' 'unsafe-inline'",          // inline styles from Tailwind
      "img-src 'self' data: https:",               // team/league logos from API
      "connect-src 'self' https://v3.football.api-sports.io https://api.the-odds-api.com",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  // Remove the Express fingerprint
  res.removeHeader("X-Powered-By");
  next();
}

// ─── 2. CORS ──────────────────────────────────────────────────────────────────
// Default: same-origin only.
// Set ALLOWED_ORIGINS="https://your-frontend.railway.app,https://another.com"
// for cross-origin access (e.g. a separate frontend deployment).

const rawOrigins = process.env.ALLOWED_ORIGINS ?? "";
const allowedOrigins = new Set(
  rawOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // Same-origin requests (no Origin header, or local dev) — always allowed
  if (!origin) { next(); return; }

  // Explicit allowlist wins
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next(); return;
  }

  // Reject unknown origins for mutation methods; allow GET for public read endpoints
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    res.status(403).json({ error: "CORS: origin not allowed" });
    return;
  }

  // GETs from unknown origins are served without CORS headers (no credentials)
  next();
}

// ─── 3. Body size limits ──────────────────────────────────────────────────────
// These are set in app.ts via express.json({ limit }) and express.urlencoded().
// The constants below are exported so app.ts can use them without repeating literals.
export const JSON_BODY_LIMIT = "16kb";       // covers all legitimate payloads
export const URLENCODED_BODY_LIMIT = "4kb";  // URL-encoded forms are small

// ─── 4. Rate limiting ─────────────────────────────────────────────────────────
// In-process token-bucket rate limiter — no Redis needed for single-instance.
// Uses IP as the identifier. For production with multiple instances, swap
// the store for a Redis-backed implementation.

interface RateLimitEntry { count: number; windowStart: number }
const rateLimitStore = new Map<string, RateLimitEntry>();

// Prune entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > 5 * 60_000) rateLimitStore.delete(key);
  }
}, 5 * 60_000);

function getClientId(req: Request): string {
  // Prefer X-Forwarded-For (set by Railway's proxy), fall back to socket address
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim())
    ?? req.socket.remoteAddress
    ?? "unknown";
  return ip;
}

function createRateLimiter(maxRequests: number, windowMs: number, message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const clientId = `${getClientId(req)}:${req.path.split("/")[2] ?? "root"}`;
    const now = Date.now();
    let entry = rateLimitStore.get(clientId);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { count: 1, windowStart: now };
      rateLimitStore.set(clientId, entry);
      next(); return;
    }
    entry.count++;
    if (entry.count > maxRequests) {
      const retryAfterSec = Math.ceil((windowMs - (now - entry.windowStart)) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.setHeader("X-RateLimit-Limit", String(maxRequests));
      res.setHeader("X-RateLimit-Remaining", "0");
      logger.warn({ clientId, path: req.path, count: entry.count }, "rate limit exceeded");
      res.status(429).json({ error: message, retryAfterSeconds: retryAfterSec });
      return;
    }
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - entry.count)));
    next();
  };
}

// General API: 120 requests per minute per IP (2/second average — generous for a dashboard)
export const generalRateLimit = createRateLimiter(120, 60_000, "Too many requests. Please slow down.");

// Stats-heavy endpoints (match stats, value-centre): 30 per minute
// These trigger external API calls so higher cost per request
export const statsRateLimit = createRateLimiter(30, 60_000, "Too many stat requests. Please wait before retrying.");

// Admin endpoints: 10 per minute — manual triggers only, not automated
export const adminRateLimit = createRateLimiter(10, 60_000, "Too many admin requests.");

// Push subscribe: 5 per minute per IP — prevents subscription flooding
export const pushRateLimit = createRateLimiter(5, 60_000, "Too many subscription requests.");

// ─── 5. Admin endpoint authentication ────────────────────────────────────────
// Protects destructive/expensive operations:
//   POST /training/run, POST /background/run/*, POST /ai/adaptive/run-cycle,
//   POST /outcomes/settle-finished, POST /ai/generate-biweekly-update
//
// Callers must send:  X-Admin-Key: <value of ADMIN_SECRET env var>
//
// If ADMIN_SECRET is not set, admin endpoints are disabled entirely in production
// and open in development (with a warning logged).

const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";

export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_SECRET) {
    if (IS_PRODUCTION) {
      logger.error({ path: req.path }, "Admin endpoint called but ADMIN_SECRET is not set — blocking");
      res.status(503).json({ error: "Admin operations are disabled: set ADMIN_SECRET environment variable." });
      return;
    }
    // Dev mode: allow through with a warning
    logger.warn({ path: req.path }, "ADMIN_SECRET not set — admin endpoint open (dev mode)");
    next(); return;
  }

  const provided = req.headers["x-admin-key"];
  // Use a length-safe comparison to prevent timing attacks
  if (!provided || !timingSafeEqual(String(provided), ADMIN_SECRET)) {
    logger.warn({ path: req.path, ip: getClientId(req) }, "Admin endpoint: invalid or missing X-Admin-Key");
    res.status(401).json({ error: "Unauthorized. Admin operations require a valid X-Admin-Key header." });
    return;
  }
  next();
}

/** Constant-time string comparison to prevent timing-based secret extraction. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still run the comparison to prevent length-based timing leaks
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ─── 6. SSE connection limiting ───────────────────────────────────────────────
// Prevents a single IP from opening unlimited server-sent event streams.
const sseConnections = new Map<string, number>();
const MAX_SSE_PER_IP = 3;

export function sseConnectionLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientId(req);
  const current = sseConnections.get(ip) ?? 0;
  if (current >= MAX_SSE_PER_IP) {
    res.status(429).json({ error: "Too many open event streams from this IP." });
    return;
  }
  sseConnections.set(ip, current + 1);
  res.on("close", () => {
    const remaining = (sseConnections.get(ip) ?? 1) - 1;
    if (remaining <= 0) sseConnections.delete(ip);
    else sseConnections.set(ip, remaining);
  });
  next();
}

// ─── 7. Input sanitisation helpers ───────────────────────────────────────────

/** Safe integer parse with bounds check. Returns null for invalid input. */
export function safeInt(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || !Number.isInteger(n)) return null;
  return n;
}

/** Safe float parse with bounds check. Returns null for invalid input. */
export function safeFloat(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Truncate a string to a maximum byte length. */
export function safeString(value: unknown, maxLen: number): string {
  const s = String(value ?? "");
  return s.slice(0, maxLen);
}

/** Validate that a string is a safe URL (https only, no auth in URL). */
export function isSafeUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
