import express, { type Express } from "express";
import path from "node:path";
import fs from "node:fs";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
