import { describe, expect, it } from "vitest";
import {
  isBeforeOddsCaptureCutoff,
  oddsSnapshotCadenceMs,
  isOddsCaptureDue,
  checkpointLabel,
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

describe("pre-match odds checkpoints (3 days, 2 days, 1 day, then match day)", () => {
  const H = 3_600_000;

  it("starts at the 3-day checkpoint, allowing a 3-hour early read", () => {
    expect(isOddsCaptureDue(76, null, null)).toBe(false);
    expect(isOddsCaptureDue(74, null, null)).toBe(true);
  });

  it("reads once per checkpoint between 3 days and 1 day out", () => {
    // Read at 73h covers the 3-day checkpoint until the 2-day window opens at 51h.
    expect(isOddsCaptureDue(60, 73, 13 * H)).toBe(false);
    expect(isOddsCaptureDue(51, 73, 22 * H)).toBe(true);
    expect(isOddsCaptureDue(40, 50, 10 * H)).toBe(false);
    expect(isOddsCaptureDue(27, 50, 23 * H)).toBe(true);
    expect(isOddsCaptureDue(25, 26, H)).toBe(false);
  });

  it("catches up on a missed checkpoint instead of skipping it", () => {
    expect(isOddsCaptureDue(60, null, null)).toBe(true);
    expect(isOddsCaptureDue(45, 74, 29 * H)).toBe(true);
  });

  it("uses the match-day cadence from 1 day out", () => {
    expect(isOddsCaptureDue(12, 13, 30 * 60_000)).toBe(false);
    expect(isOddsCaptureDue(12, 13, H)).toBe(true);
    expect(isOddsCaptureDue(3, 3.2, 15 * 60_000)).toBe(true);
    expect(isOddsCaptureDue(0.5, 0.55, 2 * 60_000)).toBe(false);
  });

  it("labels reads by checkpoint", () => {
    expect(checkpointLabel(73)).toBe("3 days");
    expect(checkpointLabel(49)).toBe("2 days");
    expect(checkpointLabel(25)).toBe("1 day");
    expect(checkpointLabel(5)).toBe("match day");
  });
});
