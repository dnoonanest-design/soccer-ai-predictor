import { describe, expect, it } from "vitest";
import { decimalToFractional, findModelEdges, findModelGaps, formatOdds } from "../odds";

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
    // The draw gap (22 points at a 7% market price) is a long shot with an
    // implausible gap, so it is not an edge either.
    expect(findModelEdges(market, model, 5)).toEqual([]);
  });

  it("flags only believable gaps on non-long-shot prices", () => {
    expect(findModelEdges({ home_win: 45, draw: 28, away_win: 27 }, { home_win: 52, draw: 26, away_win: 22 }, 5)).toEqual([
      { outcome: "HOME", delta: 7, market: 45, modelProbability: 52 },
    ]);
    // 15 points above the market: more likely model error.
    expect(findModelEdges({ home_win: 45, draw: 28, away_win: 27 }, { home_win: 60, draw: 22, away_win: 18 }, 5)).toEqual([]);
    // Odds longer than 6.0 (market under 16.7%).
    expect(findModelEdges({ home_win: 70, draw: 18, away_win: 12 }, { home_win: 60, draw: 20, away_win: 20 }, 5)).toEqual([]);
  });
});


describe("bookmaker fractional price formatting", () => {
  it("uses familiar bookmaker quotes instead of unusual ratios", () => {
    expect(decimalToFractional(1.36)).toBe("1/3");
    expect(decimalToFractional(1.83)).toBe("5/6");
    expect(decimalToFractional(1.91)).toBe("10/11");
    expect(decimalToFractional(1.67)).toBe("4/6");
    expect(decimalToFractional(2.5)).toBe("6/4");
    expect(decimalToFractional(3.25)).toBe("9/4");
    expect(decimalToFractional(7.77)).toBe("7/1");
  });

  it("handles invalid prices safely", () => {
    expect(decimalToFractional(1)).toBe("-");
    expect(decimalToFractional(null)).toBe("-");
    expect(decimalToFractional(Number.NaN)).toBe("-");
  });
});


describe("bookmaker decimal price formatting", () => {
  it("keeps two decimal places as bookmaker displays do", () => {
    expect(formatOdds(1.8, "decimal")).toBe("1.80");
    expect(formatOdds(2.5, "decimal")).toBe("2.50");
    expect(formatOdds(4.3333333, "decimal")).toBe("4.33");
    expect(formatOdds(7.77, "decimal")).toBe("7.77");
  });

  it("shows unavailable decimal prices safely", () => {
    expect(formatOdds(null, "decimal")).toBe("—");
    expect(formatOdds(1, "decimal")).toBe("—");
  });
});
