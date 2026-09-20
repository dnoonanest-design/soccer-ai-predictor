import { describe, expect, it } from "vitest";
import { getEnhancedPrediction, liveMomentumFromEvents, liveScoreAdjustedProbs, scaleMultiplicativeFactor } from "../enhancedStatsService";
import { currentFootballSeason } from "../season";
import { applySettledOutcomeToFixture, normaliseStatus } from "../soccerService";
import { normaliseThreeWayPercent, selectServingProbabilities } from "../canonicalPredictionService";
import { applyCalibration } from "../predictionStore";

describe("prediction integrity firewall", () => {
  it.each(["finished", "cancelled", "postponed"])(
    "blocks prediction generation for %s fixtures",
    async (status) => {
      await expect(
        getEnhancedPrediction(
          1,
          status,
          10,
          20,
          39,
          1.5,
          1.1,
          1.2,
          1.3,
        ),
      ).rejects.toThrow("Prediction generation blocked");
    },
  );
});

describe("fixture status normalisation", () => {
  it("lets a settled local result override a stale provider NS snapshot", () => {
    const fixture = {
      fixture: { id: 1637500, date: "2026-09-08T19:00:00Z", status: { long: "Not Started", short: "NS", elapsed: null } },
      league: { id: 1, name: "Test", logo: "", country: "Test" },
      teams: { home: { id: 10, name: "Alcains", logo: "" }, away: { id: 20, name: "Vitoria Setubal", logo: "" } },
      goals: { home: null, away: null },
    };
    const overlaid = applySettledOutcomeToFixture(fixture, { fixture_id: 1637500, score_home: 0, score_away: 2 });
    expect(overlaid.fixture.status.short).toBe("FT");
    expect(overlaid.goals).toEqual({ home: 0, away: 2 });
    expect(overlaid.score?.fulltime).toEqual({ home: 0, away: 2 });
  });

  it.each(["PST", "CANC", "ABD", "SUSP", "INT"])(
    "does not advertise %s fixtures as upcoming",
    (status) => expect(normaliseStatus(status)).toBe("cancelled"),
  );

  it.each(["1H", "2H", "ET", "BT", "P", "LIVE", "HT"])(
    "keeps %s fixtures live",
    (status) => expect(normaliseStatus(status)).toBe("live"),
  );
});

describe("live momentum integrity", () => {
  it("does not manufacture live momentum from pre-match xG", () => {
    expect(liveMomentumFromEvents([], 10, 20, 35, 2.4, 0.7)).toBeUndefined();
  });

  it("uses current live fixture statistics", () => {
    const momentum = liveMomentumFromEvents([], 10, 20, 35, 2.4, 0.7, {
      home: { possession: "61%", shots_total: 9, shots_on_target: 4, corners: 5 },
      away: { possession: "39%", shots_total: 2, shots_on_target: 0, corners: 1 },
    });
    expect(momentum?.source).toBe("live_stats");
    expect(momentum!.home_momentum_pct!).toBeGreaterThan(momentum!.away_momentum_pct!);
  });

  it("penalises the carded team instead of rewarding its pressure", () => {
    const base = liveMomentumFromEvents([], 10, 20, 35, 1, 1, {
      home: { possession: "50%", shots_total: 3 },
      away: { possession: "50%", shots_total: 3 },
    });
    const carded = liveMomentumFromEvents([{
      time: { elapsed: 34, extra: null }, team: { id: 10, name: "Home" },
      player: { id: 1, name: "Player" }, assist: { id: null, name: null },
      type: "Card", detail: "Red Card",
    }], 10, 20, 35, 1, 1, {
      home: { possession: "50%", shots_total: 3 },
      away: { possession: "50%", shots_total: 3 },
    });
    expect(carded!.home_momentum_pct!).toBeLessThan(base!.home_momentum_pct!);
  });
});

describe("critical prediction-process safeguards", () => {
  it("serves score/time-adjusted probabilities instead of stale pre-match probabilities", () => {
    const selected = selectServingProbabilities({
      home_win: 60, draw: 25, away_win: 15,
      live_adjusted_home_win: 18, live_adjusted_draw: 27, live_adjusted_away_win: 55,
    } as any, true);
    expect(selected.away).toBe(55);
    expect(selected.home + selected.draw + selected.away).toBe(100);
  });

  it("gives substitution-adjusted probabilities priority during live play", () => {
    const selected = selectServingProbabilities({
      home_win: 60, draw: 25, away_win: 15,
      live_adjusted_home_win: 45, live_adjusted_draw: 30, live_adjusted_away_win: 25,
      sub_adjusted_home_win: 35, sub_adjusted_draw: 25, sub_adjusted_away_win: 40,
    } as any, true);
    expect(selected).toEqual({ home: 35, draw: 25, away: 40 });
  });

  it("normalises every prediction table to exactly 100 percent", () => {
    const probs = normaliseThreeWayPercent(2.4, 1.8, 0.9);
    expect(probs.home + probs.draw + probs.away).toBe(100);
  });

  it("refuses unvalidated legacy bucket calibration", () => {
    const unchanged = applyCalibration(52, "home", {
      home: { 50: 1.5 }, draw: {}, away: {}, sampleSize: 10_000, validated: false,
    });
    expect(unchanged).toBe(52);
  });

  it("applies a promoted learned scale to multiplicative statistics", () => {
    expect(scaleMultiplicativeFactor(1.1, 1.25)).toBeCloseTo(1.125);
    expect(scaleMultiplicativeFactor(0.9, 0.5)).toBeCloseTo(0.95);
  });

  it("makes live result probabilities react to telemetry and dismissals", () => {
    const neutral = liveScoreAdjustedProbs(0, 0, 55, 1.5, 1.5, {
      home: { shots_total: 4 }, away: { shots_total: 4 },
    });
    const homeDominant = liveScoreAdjustedProbs(0, 0, 55, 1.5, 1.5, {
      home: { expected_goals_live: 1.7, shots_total: 13, shots_on_target: 6 },
      away: { expected_goals_live: 0.2, shots_total: 2, shots_on_target: 0, red_cards: 1 },
    });
    expect(homeDominant.homeWin).toBeGreaterThan(neutral.homeWin);
    expect(homeDominant.awayWin).toBeLessThan(neutral.awayWin);
  });

  it("resolves the European season centrally", () => {
    expect(currentFootballSeason(new Date("2026-09-15T00:00:00Z"))).toBe(2026);
    expect(currentFootballSeason(new Date("2026-02-15T00:00:00Z"))).toBe(2025);
  });
});
