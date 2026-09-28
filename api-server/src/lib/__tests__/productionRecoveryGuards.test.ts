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
    expect(code).toContain("changed: (result.rowCount ?? 0) > 0");
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
});
