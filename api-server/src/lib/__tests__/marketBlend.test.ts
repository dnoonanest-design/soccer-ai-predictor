import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));
const strength = vi.hoisted(() => ({ value: null as null | { probs: { home: number; draw: number; away: number } } }));
vi.mock("../strengthModel", () => ({ forecastStrength: () => strength.value }));

const { __setMarketConsensusForTests, blendWithMarket, consensusFromRows, getMarketConsensus, marketInformedForecast } = await import("../marketBlend");

const now = Date.parse("2026-10-25T12:00:00Z");
const match = { id: 5, league_id: 39, status: "upcoming", kickoff: "2026-10-25T15:00:00Z", home_team: { id: 1 }, away_team: { id: 2 } };

describe("odds-informed forecast", () => {
  it("averages bookmakers after removing each one's margin", () => {
    const c = consensusFromRows([{ h: 50, d: 25, a: 25, observedAt: 1 }, { h: 40, d: 30, a: 30, observedAt: 2 }])!;
    expect(c.home).toBeCloseTo(0.45, 6);
    expect(c.home + c.draw + c.away).toBeCloseTo(1, 9);
    expect(c.bookmakers).toBe(2);
    expect(c.observedAt).toBe(2);
  });

  it("blends with most weight on the market", () => {
    const p = blendWithMarket({ home: 0.7, draw: 0.2, away: 0.1 }, { home: 0.5, draw: 0.3, away: 0.2 }, 0.1);
    expect(p.home).toBeCloseTo(0.52, 6);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
  });

  it("never uses prices observed after the forecast time, or stale ones", () => {
    __setMarketConsensusForTests([[5, { home: 0.5, draw: 0.3, away: 0.2, bookmakers: 1, observedAt: now - 60_000 }]]);
    expect(getMarketConsensus(5, now)).not.toBeNull();
    expect(getMarketConsensus(5, now - 120_000)).toBeNull();
    expect(getMarketConsensus(5, now + 40 * 3600_000)).toBeNull();
  });

  it("blends step 9 when it can forecast, otherwise shows the market alone", () => {
    __setMarketConsensusForTests([[5, { home: 0.5, draw: 0.3, away: 0.2, bookmakers: 3, observedAt: now - 60_000 }]]);
    strength.value = { probs: { home: 0.7, draw: 0.2, away: 0.1 } };
    const blended = marketInformedForecast(match, now)!;
    expect(blended.model).toBe("step9-strength-ratings");
    expect(blended.home).toBeCloseTo(52, 1);
    expect(blended.home + blended.draw + blended.away).toBeCloseTo(100, 6);
    strength.value = null;
    const market = marketInformedForecast(match, now)!;
    expect(market.model).toBe("market-only");
    expect(market.home).toBe(50);
  });

  it("is pre-match only and needs stored odds", () => {
    __setMarketConsensusForTests([[5, { home: 0.5, draw: 0.3, away: 0.2, bookmakers: 1, observedAt: now - 60_000 }]]);
    expect(marketInformedForecast({ ...match, status: "live" }, now)).toBeNull();
    expect(marketInformedForecast({ ...match, id: 6 }, now)).toBeNull();
    expect(marketInformedForecast(match, Date.parse(match.kickoff))).toBeNull();
  });
});
