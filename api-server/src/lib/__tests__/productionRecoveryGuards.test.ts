import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("production recovery guards", () => {
  it("does not rewrite an unchanged final result", async () => {
    const code = await source("../predictionStore.ts");
    expect(code).toContain("saveOutcomeWithStatus");
    expect(code).toContain("IS DISTINCT FROM ROW(EXCLUDED.outcome, EXCLUDED.score_home, EXCLUDED.score_away)");
    expect(code).toContain("const changed = (result.rowCount ?? 0) > 0");
    expect(code).toContain("WITH saved AS");
    expect(code).toContain("UPDATE prediction_audit_records a");
    expect(code).toContain("FROM saved s");
    expect(code).toContain("invalidatePredictionAuditIntegrityCache");
  });

  it("quarantines corrected provider outcomes without changing signed settlement fields", async () => {
    const code = await source("../predictionAccuracyAuditService.ts");
    expect(code).toContain("provider-result-correction");
    expect(code).toContain("SET voided_at = COALESCE(a.voided_at, NOW())");
    expect(code).toContain("if (recordValid && rowQuarantined)");
  });

  it("ships an idempotent persistent recovery migration", async () => {
    const sql = await source("../../../../lib/db/018_prediction_recovery_guards.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS player_stats_recovery_queue");
    expect(sql).toContain("WHERE completed_at IS NULL");
    expect(sql).toContain("provider-result-correction");
    expect(sql).toContain("< 500");
  });

  it("wires the recovery migration into the production migration runner", async () => {
    const runner = await source("../../../../lib/db/scripts/migrate.mjs");

    expect(runner).toContain('\"018_prediction_recovery_guards.sql\"');
    expect(runner).toContain('\"019_enforce_ai_model_promotion.sql\"');
  });

  it("enforces adaptive promotion gates at the database boundary", async () => {
    const sql = await source("../../../../lib/db/019_enforce_ai_model_promotion.sql");
    const adaptive = await source("../adaptiveLearningEngine.ts");

    expect(sql).toContain("trg_enforce_ai_model_promotion_policy");
    expect(sql).toContain("sample_size < 500");
    expect(sql).toContain("holdout_rows < 100");
    expect(sql).toContain("before_brier - after_brier < 0.002");
    expect(sql).toContain("before_log_loss - after_log_loss < 0.001");
    expect(sql).toContain("after_accuracy < before_accuracy - 0.01");
    expect(adaptive).toContain('promotionPolicyVersion: "v2-500-100-multimetric"');
    expect(adaptive).toContain("holdoutRows: Math.floor(metrics.sampleSize * 0.2)");
  });

  it("exposes one production acceptance report for lifecycle and market evidence", async () => {
    const service = await source("../productionAcceptanceService.ts");
    const route = await source("../../routes/reliability.ts");
    const workflow = await source("../../../../.github/workflows/market-intelligence-ci.yml");

    expect(service).toContain("realMatchLifecycle");
    expect(service).toContain("missingMarketRatePercent");
    expect(service).toContain("invalidActiveModels");
    expect(route).toContain('/reliability/acceptance');
    expect(workflow).toContain("needs: [build, macos-compatibility]");
    expect(workflow).toContain("Create Railway release marker");
  });

  it("measures coverage by each fixture's latest observation", async () => {
    const code = await source("../statsService.ts");

    expect(code).toContain('measurement: "unique-fixture-latest-observation"');
    expect(code).toContain("coverageByFixture.get(fixtureId)");
    expect(code).toContain("coverageEvaluations = Math.max(0, coverageEvaluations - 1)");
  });

  it("hides voided rows from the public fixture ledger", async () => {
    const code = await source("../../routes/accuracy.ts");

    expect(code.match(/voided_at IS NULL/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("backs off omitted fixtures and reopens recovery after a corrected result", async () => {
    const code = await source("../backgroundLearnerService.ts");

    expect(code).toContain('"provider omitted fixture"');
    expect(code).toContain("fixture not terminal:");
    expect(code).toContain("ON CONFLICT (fixture_id) DO UPDATE");
    expect(code).toContain("completed_at = NULL");
    expect(code).toContain("TRACKED_LEAGUE_IDS");
    expect(code).toContain("outside tracked competition");
  });
});
