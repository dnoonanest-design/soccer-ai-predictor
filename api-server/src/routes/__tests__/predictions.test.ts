import { describe, expect, it } from "vitest";
import { upcomingPredictionRange } from "../predictions";

describe("upcoming prediction delivery window", () => {
  it("keeps a fixture available after its kickoff on the current Dublin day", () => {
    const now = new Date("2026-09-10T20:16:32.000Z");
    const kickoff = new Date("2026-09-10T19:00:00.000Z");

    const { start, end } = upcomingPredictionRange(now, 8);

    expect(start.toISOString()).toBe("2026-09-09T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-17T23:00:00.000Z");
    expect(kickoff.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(kickoff.getTime()).toBeLessThan(end.getTime());
  });

  it("uses Dublin midnight correctly outside daylight-saving time", () => {
    const { start, end } = upcomingPredictionRange(
      new Date("2026-12-10T20:16:32.000Z"),
      1,
    );

    expect(start.toISOString()).toBe("2026-12-10T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-11T00:00:00.000Z");
  });
});
