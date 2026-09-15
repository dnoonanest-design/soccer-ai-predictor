import { describe, expect, it } from "vitest";
import { getEnhancedPrediction, liveMomentumFromEvents, liveScoreAdjustedProbs, scaleMultiplicativeFactor } from "../enhancedStatsService";
import { currentFootballSeason } from "../season";
import { normaliseStatus } from "../soccerService";

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
