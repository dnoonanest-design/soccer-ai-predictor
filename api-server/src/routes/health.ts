import { Router, type IRouter } from "express";
import { getApiFootballProviderHealth } from "../lib/apiFootballReliability";
import { getQuotaOptimizationStatus } from "../lib/quotaOptimizationService";
import { getOddsOptimizationStatus } from "../lib/oddsOptimizationService";
import { getLiveDiscoveryConcurrencyGuardStatus } from "../lib/liveDiscoveryConcurrencyGuard";

const router: IRouter = Router();

// Liveness: the web process is running. Do not restart the app solely because
// an external data provider is unavailable; expose those dependencies separately.
router.get("/healthz", (_req, res) => {
  const apiFootball = getApiFootballProviderHealth();
  const footballQuota = getQuotaOptimizationStatus();
  const oddsQuota = getOddsOptimizationStatus();
  const liveDiscoveryGuard = getLiveDiscoveryConcurrencyGuardStatus();
  res.json({
    status: "ok",
    live_data_status: apiFootball.state,
    providers: {
      api_football: apiFootball,
    },
    quota_optimisation: {
      api_football: footballQuota,
      odds_api: oddsQuota,
      live_discovery_guard: liveDiscoveryGuard,
    },
  });
});

// Readiness: whether the predictor can currently serve trustworthy live data.
// Bookmaker odds remain an independent intelligence layer, so an odds-provider
// quota state does not make the core football predictor unready.
router.get("/health/readiness", (_req, res) => {
  const apiFootball = getApiFootballProviderHealth();
  const footballQuota = getQuotaOptimizationStatus();
  const oddsQuota = getOddsOptimizationStatus();
  const liveDiscoveryGuard = getLiveDiscoveryConcurrencyGuardStatus();
  const ready = apiFootball.state === "healthy" || apiFootball.state === "unknown";

  return res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "degraded",
    live_data_status: apiFootball.state,
    providers: {
      api_football: apiFootball,
    },
    quota_optimisation: {
      api_football: footballQuota,
      odds_api: oddsQuota,
      live_discovery_guard: liveDiscoveryGuard,
    },
  });
});

export default router;
