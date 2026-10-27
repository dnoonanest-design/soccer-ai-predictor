import { describe, expect, it } from "vitest";
import { liveFingerprint, livePredictionState, noteLivePrediction } from "../liveFeed";

describe("live update stream", () => {
  const m = (id: number, minute: number | null, home: number, away: number) => ({ id, status: "live", minute, home, away });

  it("changes when a score, minute or live prediction changes, not when order changes", () => {
    const a = liveFingerprint([m(1, 10, 0, 0), m(2, 50, 1, 1)], 3);
    expect(liveFingerprint([m(2, 50, 1, 1), m(1, 10, 0, 0)], 3)).toBe(a);
    expect(liveFingerprint([m(1, 11, 0, 0), m(2, 50, 1, 1)], 3)).not.toBe(a);
    expect(liveFingerprint([m(1, 10, 1, 0), m(2, 50, 1, 1)], 3)).not.toBe(a);
    expect(liveFingerprint([m(1, 10, 0, 0), m(2, 50, 1, 1)], 4)).not.toBe(a);
    expect(liveFingerprint([m(1, 10, 0, 0)], 3)).not.toBe(a); // a match finished
  });

  it("counts stored live predictions", () => {
    const before = livePredictionState().version;
    noteLivePrediction();
    expect(livePredictionState().version).toBe(before + 1);
    expect(livePredictionState().at).toBeGreaterThan(0);
  });
});
