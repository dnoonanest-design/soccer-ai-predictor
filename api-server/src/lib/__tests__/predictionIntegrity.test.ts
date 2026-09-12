import { describe, expect, it } from "vitest";
import { getEnhancedPrediction, liveMomentumFromEvents } from "../enhancedStatsService";
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
