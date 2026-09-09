import { describe, expect, it } from "vitest";
import { isPredictionWriteAllowed } from "../predictionIntegrity";

const now = new Date("2026-09-09T12:00:00Z");

describe("prediction data-leakage barrier", () => {
  it("allows a genuine prediction before kickoff", () => {
    expect(isPredictionWriteAllowed({ isLive: false, status: "upcoming", kickoffAt: new Date("2026-09-09T15:00:00Z"), outcomeExists: false, now })).toBe(true);
  });

  it("rejects a pre-match prediction after kickoff", () => {
    expect(isPredictionWriteAllowed({ isLive: false, status: "upcoming", kickoffAt: new Date("2026-09-09T11:00:00Z"), outcomeExists: false, now })).toBe(false);
  });

  it("rejects every prediction once that fixture's result exists", () => {
    expect(isPredictionWriteAllowed({ isLive: false, status: "upcoming", kickoffAt: new Date("2026-09-09T15:00:00Z"), outcomeExists: true, now })).toBe(false);
  });

  it("rejects finished-match snapshots", () => {
    expect(isPredictionWriteAllowed({ isLive: false, status: "finished", kickoffAt: new Date("2026-09-09T15:00:00Z"), outcomeExists: false, now })).toBe(false);
  });
});
