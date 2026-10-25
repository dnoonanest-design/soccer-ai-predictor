import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));
const strength = vi.hoisted(() => ({ value: null as null | { probs: { home: number; draw: number; away: number } } }));
vi.mock("../strengthModel", () => ({ forecastStrength: () => strength.value }));

const { __setLivePricesForTests, __setMarketConsensusForTests, blendWithMarket, consensusFromRows, getMarketConsensus, liveMarketInformedForecast, marketInformedForecast, oddsMovementFrom } = await import("../marketBlend");

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

describe("odds-informed in-play forecast", () => {
  const live = { id: 9, status: "live", score: { home: 1, away: 0 } };
  const served = { home: 60, draw: 25, away: 15 };
  const price = (over: Partial<{ h: number; d: number; a: number; scoreHome: number; scoreAway: number; updatedAt: number }>) =>
    ({ h: 70, d: 20, a: 10, scoreHome: 1, scoreAway: 0, updatedAt: now - 30_000, ...over });

  it("blends the live model with fresh prices at the current score", () => {
    __setLivePricesForTests([[9, [price({})]]]);
    const f = liveMarketInformedForecast(live, served, now)!;
    expect(f.phase).toBe("live");
    expect(f.home).toBeCloseTo(69, 1); // 0.1 * 60 + 0.9 * 70
    expect(f.home + f.draw + f.away).toBeCloseTo(100, 6);
  });

  it("ignores a price quoted at a different score (just after a goal)", () => {
    __setLivePricesForTests([[9, [price({ scoreHome: 0, scoreAway: 0 })]]]);
    expect(liveMarketInformedForecast(live, served, now)).toBeNull();
  });

  it("ignores prices the bookmaker has not updated for over two minutes", () => {
    __setLivePricesForTests([[9, [price({ updatedAt: now - 3 * 60_000 })]]]);
    expect(liveMarketInformedForecast(live, served, now)).toBeNull();
  });

  it("is in-play only", () => {
    __setLivePricesForTests([[9, [price({})]]]);
    expect(liveMarketInformedForecast({ ...live, status: "upcoming" }, served, now)).toBeNull();
  });
});

describe("pre-match odds movement", () => {
  const read = (book: string, hours: number, h: number, d: number, a: number) => ({ book, hours, h, d, a });

  it("summarises 3 days, 2 days, 1 day and the latest read, and names the moves", () => {
    const m = oddsMovementFrom([
      read("a", 72.5, 40, 30, 30), read("a", 49, 44, 29, 27), read("a", 25, 47, 28, 25), read("a", 0.1, 50, 27, 23),
      read("b", 71, 40, 30, 30), read("b", 0.2, 50, 27, 23),
    ])!;
    expect(m.points.map((p) => p.label)).toEqual(["3 days", "2 days", "1 day", "Latest"]);
    expect(m.points[0].home).toBe(40);
    expect(m.points[0].bookmakers).toBe(2);
    expect(m.points[3].home).toBe(50);
    expect(m.shortening).toBe("home");
    expect(m.drifting).toBe("away");
  });

  it("leaves out checkpoints with no read nearby and ignores moves under 2 points", () => {
    const m = oddsMovementFrom([read("a", 30, 40, 30, 30), read("a", 1, 41, 30, 29)])!;
    expect(m.points.map((p) => p.label)).toEqual(["1 day", "Latest"]);
    expect(m.shortening).toBeNull();
    expect(m.drifting).toBeNull();
  });
});
