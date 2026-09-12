import { describe, expect, it } from "vitest";
import { toUnitProbability } from "../probabilityScale";

describe("AI-aware probability normalisation", () => {
  it("preserves legacy unit probabilities", () => {
    expect(toUnitProbability(0.5711, 0.34)).toBeCloseTo(0.5711);
  });

  it("converts current percentage probabilities", () => {
    expect(toUnitProbability(57.11, 0.34)).toBeCloseTo(0.5711);
  });

  it("uses the fallback for unusable input", () => {
    expect(toUnitProbability("not-a-number", 0.28)).toBe(0.28);
  });
});
