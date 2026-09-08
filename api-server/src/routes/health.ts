import { Router, type IRouter } from "express";
import { getApiFootballProviderHealth } from "../lib/apiFootballReliability";
import { getQuotaOptimizationStatus } from "../lib/quotaOptimizationService";

const router: IRouter = Router();

// Liveness: the web process is running. Do not restart the app solely because
// an external data provider is unavailable; expose that dependency separately.
router.get("/healthz", (_req, res) => {
  const apiFootball = getApiFootballProviderHealth();
  const quota = getQuotaOptimizationStatus();
  res.json({
    status: "ok",
    live_data_status: apiFootball.state,
    providers: {
      api_football: apiFootball,
    },
    quota_optimisation: quota,
  });
});

// Readiness: whether the predictor can currently serve trustworthy live data.
router.get("/health/readiness", (_req, res) => {
  const apiFootball = getApiFootballProviderHealth();
  const quota = getQuotaOptimizationStatus();
  const ready = apiFootball.state === "healthy" || apiFootball.state === "unknown";

  return res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "degraded",
    live_data_status: apiFootball.state,
    providers: {
      api_football: apiFootball,
    },
    quota_optimisation: quota,
  });
});

export default router;
