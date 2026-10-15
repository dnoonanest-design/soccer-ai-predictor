import { describe, expect, it } from "vitest";
import { decimalToFractional, findModelEdges, findModelGaps } from "../odds";

describe("dashboard model/market quality gates", () => {
  const validModel = { home_win: 50, draw: 25, away_win: 25 };

  it("requires a complete three-way market before calculating edges", () => {
    expect(findModelEdges(
      { home_win: 42, draw: 28, away_win: null },
      validModel,
      5,
    )).toEqual([]);
  });

  it("rejects malformed market and model totals", () => {
    expect(findModelEdges(
      { home_win: 90, draw: 25, away_win: 5 },
      { home_win: 90, draw: 5, away_win: 5 },
      5,
    )).toEqual([]);
  });

  it("flags very large gaps for review and keeps them out of model edges", () => {
    const market = { home_win: 90, draw: 7, away_win: 3 };
    const model = { home_win: 34, draw: 29, away_win: 37 };

    expect(findModelGaps(market, model)).toMatchObject([
      { outcome: "HOME", delta: 56, market: 90, history: 34 },
      { outcome: "AWAY", delta: 34, market: 3, history: 37 },
    ]);
    expect(findModelEdges(market, model, 5)).toEqual([
      { outcome: "DRAW", delta: 22, market: 7, modelProbability: 29 },
    ]);
  });
});


describe("bookmaker fractional price formatting", () => {
  it("uses familiar reduced bookmaker fractions for rounded decimal prices", () => {
    expect(decimalToFractional(1.83)).toBe("5/6");
    expect(decimalToFractional(1.91)).toBe("10/11");
    expect(decimalToFractional(1.67)).toBe("4/6");
    expect(decimalToFractional(2.5)).toBe("6/4");
    expect(decimalToFractional(3.25)).toBe("9/4");
  });

  it("handles invalid prices safely", () => {
    expect(decimalToFractional(1)).toBe("-");
    expect(decimalToFractional(null)).toBe("-");
    expect(decimalToFractional(Number.NaN)).toBe("-");
  });
});
