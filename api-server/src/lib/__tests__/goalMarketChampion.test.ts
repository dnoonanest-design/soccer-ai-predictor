import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));
vi.mock("../strengthModel", () => ({ ensureStrengthModel: async () => {}, forecastStrength: () => null }));

const { goalGateEvidence, withGoalNumbers, GOAL_RULES } = await import("../goalMarketChampion");

function rows(n: number, challengerBetter: boolean) {
  // Deterministic pseudo-random outcomes; the better side is closer to the truth.
  let s = 7; const u = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  return Array.from({ length: n }, () => {
    const pO = 0.3 + 0.4 * u(), pB = 0.3 + 0.4 * u();
    const oa = u() < pO, ba = u() < pB;
    const good = { o25: pO, bt: pB }, flat = { o25: 0.55, bt: 0.52 };
    const ch = challengerBetter ? good : flat, champ = challengerBetter ? flat : good;
    return { o25: ch.o25, bt: ch.bt, co25: champ.o25, cbt: champ.bt, oa, ba };
  });
}

describe("goal-market gate", () => {
  it("promotes only with enough matches and a clear gain on both markets combined", () => {
    const strong = goalGateEvidence(rows(2000, true));
    expect(strong.combinedGain).toBeGreaterThan(GOAL_RULES.minBrierGain);
    expect(strong.tStat).toBeGreaterThan(GOAL_RULES.minTStat);
    expect(strong.eligible).toBe(true);
    const few = goalGateEvidence(rows(100, true));
    expect(few.eligible).toBe(false);
    expect(few.reasons[0]).toContain("needs");
    const worse = goalGateEvidence(rows(2000, false));
    expect(worse.eligible).toBe(false);
    expect(worse.reasons.some((r) => r.includes("must not get worse"))).toBe(true);
  });

  it("keeps over 1.5 >= over 2.5 >= over 3.5", () => {
    expect(withGoalNumbers({ over15: 60, over25: 62, over35: 70, btts: 50 })).toEqual({ over_15: 62, over_25: 62, over_35: 62, btts: 50 });
    expect(withGoalNumbers({ over15: 80, over25: 55, over35: 30, btts: 48 })).toEqual({ over_15: 80, over_25: 55, over_35: 30, btts: 48 });
  });
});
