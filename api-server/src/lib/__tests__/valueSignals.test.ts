import { describe, expect, it, vi } from "vitest";

const strength = vi.hoisted(() => ({ value: null as null | { probs: { home: number; draw: number; away: number } } }));
vi.mock("../strengthModel", () => ({ forecastStrength: () => strength.value }));

const { valueSignal, valueSignalsFor } = await import("../valueSignals");

describe("value flags", () => {
  it("flags a believable edge on a normal price", () => {
    const v = valueSignal(52, 2.1)!; // implied 47.6%, edge +9.2%
    expect(v.is_value).toBe(true);
    expect(v.excluded).toBeUndefined();
  });

  it("does not flag long shots, however big the edge looks", () => {
    const v = valueSignal(26.76, 10)!; // the 26 Oct example: "+167.6%" at odds of 10.0
    expect(v.edge_pct).toBeCloseTo(167.6, 1);
    expect(v.is_value).toBe(false);
    expect(v.excluded).toBe("long_shot");
  });

  it("does not flag gaps too large to be believable", () => {
    const v = valueSignal(60, 2.2)!; // 60% vs 45.5% implied: 14.5 points, +32% edge
    expect(v.is_value).toBe(false);
    expect(v.excluded).toBe("gap_too_large");
  });

  it("leaves negative edges unflagged and unlabelled", () => {
    const v = valueSignal(37.6, 1.35)!;
    expect(v.is_value).toBe(false);
    expect(v.excluded).toBeUndefined();
  });

  it("uses step 9 only, and gives no flags when it cannot forecast", () => {
    const match = { league_id: 61, home_team: { id: 1 }, away_team: { id: 2 }, odds: { home_odds: 2.1, draw_odds: 3.4, away_odds: 3.6 } };
    strength.value = null;
    expect(valueSignalsFor(match)).toBeNull();
    strength.value = { probs: { home: 0.52, draw: 0.27, away: 0.21 } };
    const v = valueSignalsFor(match)!;
    expect(v.model).toBe("step9-strength-ratings");
    expect(v.model_probabilities.home).toBe(52);
    expect(v.home?.is_value).toBe(true);
    expect(v.away?.is_value).toBe(false);
  });
});
