import { Router, type IRouter } from "express";
import { getApiFootballProviderHealth } from "../lib/apiFootballReliability";

const router: IRouter = Router();

// Liveness: the web process is running. Do not restart the app solely because
// an external data provider is unavailable; expose that dependency separately.
router.get("/healthz", (_req, res) => {
  const apiFootball = getApiFootballProviderHealth();
  res.json({
    status: "ok",
    live_data_status: apiFootball.state,
    providers: {
      api_football: apiFootball,
    },
  });
});

// Readiness: whether the predictor can currently serve trustworthy live data.
router.get("/health/readiness", (_req, res) => {
  const apiFootball = getApiFootballProviderHealth();
  const ready = apiFootball.state === "healthy" || apiFootball.state === "unknown";

  return res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "degraded",
    live_data_status: apiFootball.state,
    providers: {
      api_football: apiFootball,
    },
  });
});

export default router;
