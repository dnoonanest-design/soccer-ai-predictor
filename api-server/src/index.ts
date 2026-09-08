import "dotenv/config";
import app from "./app";
import { logger } from "./lib/logger";
import { installQuotaOptimizationLayer } from "./lib/quotaOptimizationService";
import { installOddsOptimizationLayer } from "./lib/oddsOptimizationService";
import { startBackgroundLearner, stopBackgroundLearner } from "./lib/backgroundLearnerService";
import {
  startFutureMarketSampler,
  stopFutureMarketSampler,
} from "./lib/futureMarketSamplerService";
import {
  startPredictionAccuracyAudit,
  stopPredictionAccuracyAudit,
} from "./lib/predictionAccuracyAuditService";
import {
  startFuturePredictionBaseline,
  stopFuturePredictionBaseline,
} from "./lib/futurePredictionBaselineService";

// Install provider optimisers before any background worker starts. The football
// layer owns schedule-aware fixture batching; the odds layer then wraps the
// resulting fetch pipeline so bookmaker calls are cached/deduplicated without
// bypassing the football protections.
installQuotaOptimizationLayer();
installOddsOptimizationLayer();

// Replit normally provides PORT, but default to 3000 so local/iPad/browser
// testing does not crash before the app starts.
const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (!Number.isFinite(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");
  startBackgroundLearner();
  startFutureMarketSampler();
  startFuturePredictionBaseline();
  startPredictionAccuracyAudit();
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

function shutdown() {
  stopPredictionAccuracyAudit();
  stopFuturePredictionBaseline();
  stopFutureMarketSampler();
  stopBackgroundLearner();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
