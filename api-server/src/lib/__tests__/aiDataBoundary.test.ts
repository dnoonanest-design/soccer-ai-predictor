import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("AI temporal data boundary", () => {
  it("keeps similar-match memory on strictly pre-kickoff snapshots", async () => {
    const code = await source("../aiAwareLearningService.ts");
    expect(code).toContain("ps.status = 'upcoming'");
    expect(code).toContain("ps.minute IS NULL");
    expect(code).toContain("mp.kickoff_at IS NOT NULL");
    expect(code).toContain("ps.created_at < mp.kickoff_at");
    expect(code).not.toContain("mp.kickoff_at IS NULL OR ps.created_at < mp.kickoff_at");
  });

  it("trains the adaptive learner only from verified, settled canonical snapshots", async () => {
    const code = await source("../adaptiveLearningEngine.ts");
    expect(code).toContain("verifyPredictionAuditIntegrity");
    expect(code).toContain("canonicalPrematchAuditCte");
    expect(code).toContain("c.settled_at IS NOT NULL");
    expect(code).toContain("c.actual_outcome IN ('home','draw','away')");
    expect(code).toContain("x.updated_at <= c.captured_at");
  });

  it("keeps similar-match memory diagnostic-only", async () => {
    const code = await source("../aiAwareLearningService.ts");
    expect(code).toContain("const accepted = false");
    expect(code).toContain("similarMatchWeight: 0");
  });

  it("connects only persisted adaptive calibration to pre-match inference", async () => {
    const code = await source("../enhancedStatsService.ts");
    expect(code).toContain("const learnedWeights = await getLearnedWeights()");
    expect(code).toContain("!isLive && learnedWeights.sampleSize >= MIN_SAMPLE_FOR_WEIGHT_UPDATE");
    expect(code).toContain("globalOutcomePriors");
  });

  it("routes every production forecast through one canonical pipeline", async () => {
    const files = [
      "../../routes/stats.ts",
      "../../routes/premium.ts",
      "../backgroundLearnerService.ts",
      "../futurePredictionBaselineService.ts",
      "../predictionAccuracyAuditService.ts",
    ];
    for (const file of files) {
      const code = await source(file);
      expect(code).toContain("createCanonicalPrediction");
      expect(code).not.toContain("applyCalibration(");
      expect(code).not.toContain("applyCircumstanceCalibration(");
      expect(code).not.toContain("getEnhancedPrediction(");
    }
    const statsRoute = await source("../../routes/stats.ts");
    expect(statsRoute).not.toContain("getAllXGPredictions");
    expect(statsRoute).toContain("canonical_prediction_snapshots");
  });

  it("keeps pre-match competition-strength evidence connected", async () => {
    const code = await source("../canonicalPredictionService.ts");
    expect(code).toContain("modelStatsPayload(stats)");
    expect(code).toContain("Strength index/sample size are pre-match features");
  });

  it("uses one 500-match promotion threshold throughout AI reporting", async () => {
    const adaptive = await source("../adaptiveLearningEngine.ts");
    const background = await source("../backgroundLearnerService.ts");
    const memory = await source("../aiMemoryUpdateService.ts");
    expect(adaptive).toContain("MIN_SAMPLE_FOR_WEIGHT_UPDATE = 500");
    expect(adaptive).toContain("afterLogLoss <= beforeLogLoss - MIN_LOG_LOSS_IMPROVEMENT");
    expect(adaptive).toContain("afterAccuracy >= beforeAccuracy - MAX_ACCURACY_REGRESSION");
    expect(adaptive).toContain("adaptive-chronological-challenger");
    expect(background).toContain("MIN_SAMPLE_FOR_WEIGHT_UPDATE");
    expect(memory).toContain("MIN_SAMPLE_FOR_WEIGHT_UPDATE");
    expect(memory).not.toContain("sampleSize >= 60");
    expect(memory).not.toContain("maximumBrierForPromotion: 0.24");
  });
});
