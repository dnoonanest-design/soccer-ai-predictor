import { describe, expect, it } from "vitest";
import {
  isBeforeOddsCaptureCutoff,
  oddsSnapshotCadenceMs,
  ODDS_CAPTURE_KICKOFF_CUTOFF_MS,
} from "../marketOddsSamplingPolicy";

describe("market odds snapshot schedule", () => {
  it("samples throughout a three day pre-match window at tighter intervals near kickoff", () => {
    expect(oddsSnapshotCadenceMs(48)).toBe(2 * 60 * 60_000);
    expect(oddsSnapshotCadenceMs(12)).toBe(60 * 60_000);
    expect(oddsSnapshotCadenceMs(3)).toBe(15 * 60_000);
    expect(oddsSnapshotCadenceMs(0.5)).toBe(5 * 60_000);
    expect(oddsSnapshotCadenceMs(0.03)).toBe(60_000);
  });

  it("stops taking pre-match snapshots at one minute before kickoff", () => {
    const now = Date.UTC(2026, 9, 20, 12);
    expect(
      isBeforeOddsCaptureCutoff(now + ODDS_CAPTURE_KICKOFF_CUTOFF_MS + 1, now),
    ).toBe(true);
    expect(
      isBeforeOddsCaptureCutoff(now + ODDS_CAPTURE_KICKOFF_CUTOFF_MS, now),
    ).toBe(false);
    expect(isBeforeOddsCaptureCutoff(now + 30_000, now)).toBe(false);
  });
});
