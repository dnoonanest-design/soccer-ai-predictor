import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));
const strength = vi.hoisted(() => ({ value: null as null | { probs: { home: number; draw: number; away: number } } }));
vi.mock("../strengthModel", () => ({ forecastStrength: () => strength.value }));

const { __setLivePricesForTests, __setMarketConsensusForTests, blendWithMarket, consensusFromRows, getMarketConsensus, liveMarketInformedForecast, marketInformedForecast, marketForServedPrediction, oddsMovementFrom, servedWithMarket, goalConsensusFrom, goalsWithMarket, goalMarketsForServedPrediction } = await import("../marketBlend");
const { sealedWithoutOdds, withLatestMarket } = await import("../servedPredictionMarket");

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

describe("bookmaker odds in the served prediction", () => {
  const market = { home: 0.5, draw: 0.3, away: 0.2, bookmakers: 4, observedAt: now - 60_000 };
  const served = { home_win: 30, draw: 30, away_win: 40 };

  it("keeps 70% of our own prediction and takes 30% from the bookmakers, keeping our own numbers", () => {
    const r = servedWithMarket(served, "legacy", market)!;
    expect(r.probs.home_win).toBeCloseTo(36, 1); // 0.7 * 30 + 0.3 * 50
    expect(r.probs.home_win + r.probs.draw + r.probs.away_win).toBeCloseTo(100, 6);
    expect(r.independent).toEqual({ home: 30, draw: 30, away: 40, model: "legacy" });
    expect(r.market_blend.model_weight).toBe(0.7);
    expect(r.market_blend.bookmakers).toBe(4);
  });

  it("uses the same 70/30 balance for step 9 if it serves", () => {
    const r = servedWithMarket(served, "step9-strength-ratings", market)!;
    expect(r.probs.home_win).toBeCloseTo(36, 1);
  });

  it("only changes upcoming matches with fresh stored odds", async () => {
    __setMarketConsensusForTests([[5, market]]);
    expect(await marketForServedPrediction(5, "upcoming", "2026-10-25T15:00:00Z", served, "legacy", now)).not.toBeNull();
    expect(await marketForServedPrediction(5, "live", "2026-10-25T15:00:00Z", served, "legacy", now)).toBeNull();
    expect(await marketForServedPrediction(6, "upcoming", "2026-10-25T15:00:00Z", served, "legacy", now)).toBeNull();
    expect(await marketForServedPrediction(5, "upcoming", "2026-10-25T11:00:00Z", served, "legacy", now)).toBeNull();
  });
});

describe("bookmaker goal markets in the served prediction", () => {
  it("averages each bookmaker's no-vig over 2.5 and BTTS prices", () => {
    const c = goalConsensusFrom([
      { o: 1.9, u: 1.9, y: 1.8, n: 2.0, observedAt: 1 },
      { o: 2.1, u: 1.75, y: null, n: null, observedAt: 2 },
    ])!;
    expect(c.over25).toBeCloseTo((0.5 + (1 / 2.1) / (1 / 2.1 + 1 / 1.75)) / 2, 6);
    expect(c.btts).toBeCloseTo((1 / 1.8) / (1 / 1.8 + 1 / 2), 6);
    expect(c.bookmakers).toBe(2);
    expect(goalConsensusFrom([{ o: null, u: null, y: null, n: null, observedAt: 1 }])).toBeNull();
  });

  it("blends over 2.5 and BTTS 70/30 with the bookmakers, keeps the model's, and keeps over 1.5 >= 2.5 >= 3.5", () => {
    const r = goalsWithMarket({ over_15: 60, over_25: 62, over_35: 40, btts: 61 }, { over25: 0.75, btts: 0.5, bookmakers: 6, observedAt: now })!;
    expect(r.goals).toEqual({ over_15: 65.9, over_25: 65.9, over_35: 40, btts: 57.7 });
    expect(r.independent_goals).toEqual({ over_25: 62, btts: 61 });
    expect(r.goal_market_blend.markets).toEqual(["over_25", "btts"]);
    const low = goalsWithMarket({ over_15: 70, over_25: 62, over_35: 60, btts: null }, { over25: 0.4, btts: null, bookmakers: 1, observedAt: now })!;
    expect(low.goals.over_25).toBe(55.4);
    expect(low.goals.over_35).toBe(55.4);
    expect(low.goal_market_blend.markets).toEqual(["over_25"]);
  });

  it("only changes upcoming matches with stored goal prices", async () => {
    __setMarketConsensusForTests([], [[5, { over25: 0.6, btts: 0.55, bookmakers: 3, observedAt: now - 60_000 }]]);
    const served = { over_15: 75, over_25: 60, over_35: 35, btts: 58 };
    expect(await goalMarketsForServedPrediction(5, "upcoming", "2026-10-25T15:00:00Z", served, now)).not.toBeNull();
    expect(await goalMarketsForServedPrediction(5, "live", "2026-10-25T15:00:00Z", served, now)).toBeNull();
    expect(await goalMarketsForServedPrediction(6, "upcoming", "2026-10-25T15:00:00Z", served, now)).toBeNull();
  });
});

describe("bookmaker odds on stored predictions", () => {
  const fixture = (over: Record<string, unknown> = {}) => ({
    fixture_id: 5, kickoff: "2026-10-25T15:00:00Z", model_version: "v4", generated_at: "2026-10-25T08:00:00Z",
    prediction: { home_win: 50, draw: 25, away_win: 25, predicted_outcome: "home", over_25: 50, btts: 50, pick_confidence: 50 },
    ...over,
  });
  const market = () => __setMarketConsensusForTests([[5, { home: 0.2, draw: 0.25, away: 0.55, bookmakers: 5, observedAt: now - 60_000 }]], [[5, { over25: 0.7, btts: 0.6, bookmakers: 5, observedAt: now - 60_000 }]]);

  it("blends 70/30 into a prediction sealed before the odds arrived, keeping our own numbers", async () => {
    market();
    const [f] = await withLatestMarket([fixture()], now, new Map([[5, Date.parse("2026-10-25T10:00:00Z")]]));
    expect(f.prediction.home_win).toBeCloseTo(41, 1); // 0.7 * 50 + 0.3 * 20
    expect(f.prediction.away_win).toBeCloseTo(34, 1);
    expect(f.prediction.predicted_outcome).toBe("home");
    expect(f.prediction.over_25).toBe(56);
    expect((f.prediction as any).model_only.home_win).toBe(50);
  });

  it("never adds odds twice: a prediction sealed after the first price already includes them", async () => {
    market();
    const sealedWithOdds = fixture({ generated_at: "2026-10-27T08:00:00Z" });
    expect(await withLatestMarket([sealedWithOdds], now, new Map([[5, Date.parse("2026-10-27T07:00:00Z")]]))).toEqual([sealedWithOdds]);
    expect(sealedWithoutOdds("2026-10-27T08:00:00Z", Date.parse("2026-10-27T09:00:00Z"))).toBe(true);
    expect(sealedWithoutOdds("2026-10-25T08:00:00Z", Date.parse("2026-10-24T09:00:00Z"))).toBe(true); // before blending existed
    expect(sealedWithoutOdds(null, null)).toBe(false);
  });

  it("leaves started matches, matches without odds and other serving models unchanged", async () => {
    market();
    const started = fixture({ kickoff: "2026-10-25T11:00:00Z" });
    const noOdds = fixture({ fixture_id: 6 });
    const step9 = fixture({ model_version: "step9-strength-ratings" });
    expect(await withLatestMarket([started, noOdds, step9], now, new Map())).toEqual([started, noOdds, step9]);
  });
});
