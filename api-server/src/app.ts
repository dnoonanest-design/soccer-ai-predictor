import express, { type Express } from "express";
import path from "node:path";
import fs from "node:fs";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  JSON_BODY_LIMIT,
  URLENCODED_BODY_LIMIT,
  adminRateLimit,
  corsMiddleware,
  generalRateLimit,
  pushRateLimit,
  requireAdminKey,
  securityHeaders,
  sseConnectionLimit,
  statsRateLimit,
} from "./lib/security";

const app: Express = express();

// Railway terminates TLS one hop in front of the application. Trust exactly
// that proxy so rate limiting sees the real client IP without accepting an
// arbitrary forwarded chain.
app.set("trust proxy", 1);

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

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));
app.use("/api", generalRateLimit);

const adminMutationPaths = [
  /^\/training\/run$/,
  /^\/background\/run\//,
  /^\/ai\/run-learning-cycle$/,
  /^\/ai\/generate-biweekly-update$/,
  /^\/outcomes\/settle-finished$/,
  /^\/reliability\/full-match\/run$/,
  /^\/push\/test$/,
  /^\/tracker$/,
  /^\/tracker\/\d+\/settle$/,
];

app.use("/api", (req, res, next) => {
  if (req.method === "GET" && req.path === "/live/stream") {
    return sseConnectionLimit(req, res, next);
  }
  if (req.path === "/push/subscribe" && req.method === "POST") {
    return pushRateLimit(req, res, next);
  }
  if (
    req.method === "GET" &&
    (/^\/matches\/\d+\/(?:stats|events|squad)$/.test(req.path) || req.path === "/xg")
  ) {
    return statsRateLimit(req, res, next);
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    adminMutationPaths.some((pattern) => pattern.test(req.path))
  ) {
    return adminRateLimit(req, res, () => requireAdminKey(req, res, next));
  }
  next();
});

app.use("/api", router);

// Railway/production: serve the built React dashboard from the same service.
// This keeps deployment simple: one Railway web service handles API + iPad/PWA frontend.
const dashboardDist = path.resolve(import.meta.dirname, "..", "..", "dashboard-dist");
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
