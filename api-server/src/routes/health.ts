import { Router, type IRouter } from "express";
import { readFileSync } from "node:fs";
import { getApiFootballProviderHealth } from "../lib/apiFootballReliability";
import { getQuotaOptimizationStatus } from "../lib/quotaOptimizationService";
import { getOddsOptimizationStatus } from "../lib/oddsOptimizationService";
import { getLiveDiscoveryConcurrencyGuardStatus } from "../lib/liveDiscoveryConcurrencyGuard";
import { getDatabaseReadiness } from "../lib/databaseReadinessService";
import { getBackgroundRuntimeStatus } from "../lib/backgroundLearnerService";
import { getMatchSnapshotStatus } from "../lib/soccerService";
import { getStatsCoverageStatus } from "../lib/statsService";
import { getFuturePredictionBaselineStatus } from "../lib/futurePredictionBaselineService";

const router: IRouter = Router();

function getReleaseIdentity() {
  let validatedCommit: string | null = null;
  try {
    validatedCommit = readFileSync(".railway-release", "utf8").trim().slice(0, 12) || null;
  } catch {
    // Local development and tests do not require a Railway release marker.
  }
  return {
    deployedCommit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
    validatedCommit,
  };
}

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
router.get("/health/readiness", async (_req, res) => {
  const apiFootball = getApiFootballProviderHealth();
  const footballQuota = getQuotaOptimizationStatus();
  const oddsQuota = getOddsOptimizationStatus();
  const liveDiscoveryGuard = getLiveDiscoveryConcurrencyGuardStatus();
  const database = await getDatabaseReadiness();
  const background = getBackgroundRuntimeStatus();
  const providerReady = apiFootball.state === "healthy" || apiFootball.state === "unknown";
  const backgroundReady = process.env.NODE_ENV !== "production" || (background.enabled && background.started);
  const ready = providerReady && database.ready && backgroundReady;

  return res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "degraded",
    release: getReleaseIdentity(),
    live_data_status: apiFootball.state,
    database,
    administration: {
      manualOperationsEnabled: Boolean(process.env.ADMIN_SECRET?.trim()),
    },
    background: {
      ...background,
      predictionRole: "deterministic-model",
      generativeAiRole: "explanation-only",
    },
    prediction_pipeline: {
      fixtureSnapshot: getMatchSnapshotStatus(),
      statsCoverage: getStatsCoverageStatus(),
      baselineWorker: getFuturePredictionBaselineStatus(),
    },
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
