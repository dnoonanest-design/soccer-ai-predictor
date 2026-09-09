import { beforeAll, describe, expect, it } from "vitest";

type MarketModule = typeof import("../marketIntelligenceService");
let market: MarketModule;

beforeAll(async () => {
  // Pure math tests do not connect, but the DB package validates configuration
  // when its module is loaded.
  process.env.DATABASE_URL ||= "postgres://unused:unused@127.0.0.1:1/unused";
  market = await import("../marketIntelligenceService");
});

describe("removeBookmakerMargin", () => {
  it("removes overround and returns probabilities summing to one", () => {
    const result = market.removeBookmakerMargin({ home: 2, draw: 3.4, away: 4 });
    expect(result).not.toBeNull();
    expect(result!.fair.home + result!.fair.draw + result!.fair.away).toBeCloseTo(1, 10);
    expect(result!.overround).toBeGreaterThan(0);
  });

  it("rejects incomplete or invalid decimal odds", () => {
    expect(market.removeBookmakerMargin({ home: 2, draw: 1, away: 4 })).toBeNull();
  });
});

describe("calculateMarketAssessment", () => {
  it("keeps an independent output and applies only a controlled adjustment", () => {
    const result = market.calculateMarketAssessment({
      independent: { home: 62, draw: 23, away: 15 },
      opening: Array(4).fill({ home: 0.50, draw: 0.28, away: 0.22 }),
      latest: Array(4).fill({ home: 0.56, draw: 0.25, away: 0.19 }),
    });
    expect(result).not.toBeNull();
    expect(result!.independent.home).toBeCloseTo(0.62, 4);
    expect(result!.marketWeight).toBeLessThanOrEqual(0.15);
    expect(result!.assisted.home).toBeLessThan(result!.independent.home);
    expect(result!.assisted.home).toBeGreaterThan(result!.market.home);
    expect(result!.assisted.home + result!.assisted.draw + result!.assisted.away).toBeCloseTo(1, 4);
  });

  it("reduces influence when only one bookmaker is present", () => {
    const one = market.calculateMarketAssessment({
      independent: { home: 0.6, draw: 0.25, away: 0.15 },
      opening: [{ home: 0.45, draw: 0.3, away: 0.25 }],
      latest: [{ home: 0.6, draw: 0.23, away: 0.17 }],
    });
    const four = market.calculateMarketAssessment({
      independent: { home: 0.6, draw: 0.25, away: 0.15 },
      opening: Array(4).fill({ home: 0.45, draw: 0.3, away: 0.25 }),
      latest: Array(4).fill({ home: 0.6, draw: 0.23, away: 0.17 }),
    });
    expect(one!.marketWeight).toBeLessThan(four!.marketWeight);
  });

  it("returns null when no market data exists", () => {
    expect(market.calculateMarketAssessment({
      independent: { home: 0.5, draw: 0.3, away: 0.2 },
      opening: [],
      latest: [],
    })).toBeNull();
  });
});

