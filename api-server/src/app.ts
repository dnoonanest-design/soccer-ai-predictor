import express, { type Express } from "express";
import path from "node:path";
import fs from "node:fs";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  securityHeaders,
  corsMiddleware,
  generalRateLimit,
  JSON_BODY_LIMIT,
  URLENCODED_BODY_LIMIT,
} from "./lib/security";

const app: Express = express();

// ── Security headers first — applied before any route or logging ──────────────
app.use(securityHeaders);

// ── CORS — replaces the open cors() wildcard ──────────────────────────────────
app.use(corsMiddleware);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── Body parsing — explicit size limits, no prototype pollution ───────────────
// extended: false uses the built-in querystring parser which does NOT support
// nested objects, preventing __proto__ pollution via URL-encoded bodies.
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));

// ── General rate limit — 120 req/min per IP across all /api routes ────────────
app.use("/api", generalRateLimit);

app.use("/api", router);

// Railway/production: serve the built React dashboard from the same service.
// This keeps deployment simple: one Railway web service handles API + iPad/PWA frontend.
const dashboardDist = path.resolve(import.meta.dirname, "..", "..", "soccer-dashboard", "dist", "public");
if (process.env.NODE_ENV === "production" && fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist, {
    maxAge: "1h",
    etag: true,
    index: false,
  }));

  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(dashboardDist, "index.html"));
  });
}

export default app;
