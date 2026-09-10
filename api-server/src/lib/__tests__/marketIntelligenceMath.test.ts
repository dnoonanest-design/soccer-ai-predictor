import { describe, expect, it } from "vitest";
import {
  calculateNoVigProbabilities,
  calculateProbabilityMovement,
  pickFromProbabilities,
  strongestPositiveMovement,
} from "../marketIntelligenceMath";

describe("market intelligence math", () => {
  it("removes bookmaker margin and normalises a three-way market", () => {
    const probs = calculateNoVigProbabilities(2.0, 3.6, 4.0);
    expect(probs).not.toBeNull();
    expect(probs!.home + probs!.draw + probs!.away).toBeCloseTo(100, 2);
    expect(probs!.home).toBeGreaterThan(probs!.draw);
    expect(probs!.draw).toBeGreaterThan(probs!.away);
  });

  it("rejects incomplete or invalid decimal odds", () => {
    expect(calculateNoVigProbabilities(0, 3.5, 4.0)).toBeNull();
    expect(calculateNoVigProbabilities(2.0, 1, 4.0)).toBeNull();
  });

  it("rejects corrupt or mismatched three-way markets", () => {
    expect(calculateNoVigProbabilities(1, 75, 100)).toBeNull();
    expect(calculateNoVigProbabilities(1.02, 1.02, 1.02)).toBeNull();
    expect(calculateNoVigProbabilities(2, 3.5, 5000)).toBeNull();
  });

  it("measures probability-point movement", () => {
    const movement = calculateProbabilityMovement(
      { home: 40, draw: 30, away: 30 },
      { home: 45, draw: 28, away: 27 },
    );
    expect(movement).toEqual({ home: 5, draw: -2, away: -3 });
    expect(strongestPositiveMovement(movement)).toBe("home");
  });

  it("returns the highest-probability selection", () => {
    expect(pickFromProbabilities({ home: 31, draw: 29, away: 40 })).toBe("away");
  });
});
