import { describe, expect, it } from "vitest";
import { evaluateWalkForwardRows, type WalkForwardRow } from "../backtestService";

function row(index: number, actual: WalkForwardRow["actual"]): WalkForwardRow {
  return {
    fixtureId: index,
    leagueId: 39,
    kickoffAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    home: actual === "home" ? 70 : 15,
    draw: actual === "draw" ? 70 : 15,
    away: actual === "away" ? 70 : 15,
    actual,
    modelVersion: "test-v1",
  };
}

describe("chronological model backtest", () => {
  it("uses expanding chronological folds without evaluating the warm-up rows", () => {
    const rows = Array.from({ length: 35 }, (_, index) =>
      row(index, (["home", "draw", "away"] as const)[index % 3]),
    ).reverse();
    const report = evaluateWalkForwardRows(rows, 10, 10);

    expect(report.status).toBe("complete");
    expect(report.folds.map((fold) => fold.trainingSamples)).toEqual([10, 20, 30]);
    expect(report.folds.map((fold) => fold.holdoutSamples)).toEqual([10, 10, 5]);
    expect(report.evaluatedSamples).toBe(25);
    expect(report.model.accuracy).toBe(1);
    expect(report.safeguards.futureOutcomesExcludedFromBaseline).toBe(true);
  });

  it("reports collecting until a genuine chronological holdout exists", () => {
    const report = evaluateWalkForwardRows([row(0, "home")], 50, 50);
    expect(report.status).toBe("collecting");
    expect(report.model.samples).toBe(0);
    expect(report.brierImprovement).toBeNull();
  });

  it("falls back to safe fold sizes for non-finite query values", () => {
    const report = evaluateWalkForwardRows([], Number.NaN, Number.POSITIVE_INFINITY);
    expect(report.minimumTrainingSamples).toBe(250);
    expect(report.foldSize).toBe(50);
  });
});
