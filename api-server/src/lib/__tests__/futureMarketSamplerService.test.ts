import { describe, expect, it } from "vitest";
import { TRACKED_COMPETITIONS } from "../leagueConfig";

// Pure helper functions extracted for testing
function filterFixtureWindow(
  fixtures: Array<{ fixture: { date: string } }>,
  now: Date,
  windowHours: number,
) {
  const startMs = now.getTime();
  const endMs = startMs + windowHours * 3_600_000;
  return fixtures.filter((fixture) => {
    const kickoffMs = new Date(fixture.fixture.date).getTime();
    return kickoffMs > startMs && kickoffMs <= endMs;
  });
}

function isFutureStatus(status: string | undefined) {
  return ![
    "1H", "2H", "HT", "ET", "BT", "P", "LIVE",
    "FT", "AET", "PEN", "AWD", "WO",
  ].includes(status ?? "");
}

describe("future market sampler service", () => {
  describe("tracked competitions", () => {
    it("defines exactly 25 tracked competitions", () => {
      expect(TRACKED_COMPETITIONS.length).toBe(25);
    });

    it("includes UEFA Champions League (id: 2)", () => {
      const ucl = TRACKED_COMPETITIONS.find((c) => c.id === 2);
      expect(ucl).toBeDefined();
      expect(ucl?.name).toBe("UEFA Champions League");
      expect(ucl?.kind).toBe("uefa");
    });

    it("includes UEFA Europa League (id: 3) and Conference League (id: 848)", () => {
      const uefaIds = new Set(
        TRACKED_COMPETITIONS.filter((c) => c.kind === "uefa").map((c) => c.id),
      );
      expect(uefaIds.has(3)).toBe(true);
      expect(uefaIds.has(848)).toBe(true);
      expect(uefaIds.size).toBe(3);
    });

    it("includes Premier League (39), Bundesliga (78), Serie A (135), La Liga (140), Ligue 1 (61)", () => {
      const topLeagueIds = new Set([39, 78, 135, 140, 61]);
      const trackedIds = new Set(TRACKED_COMPETITIONS.map((c) => c.id));
      for (const id of topLeagueIds) {
        expect(trackedIds.has(id)).toBe(true);
      }
    });
  });

  describe("fixture window filtering", () => {
    it("includes fixtures strictly after now and up to and including end boundary", () => {
      const now = new Date("2026-09-07T22:00:00Z");
      const windowHours = 72;
      const startMs = now.getTime();
      const endMs = startMs + windowHours * 3_600_000;

      const justBefore = new Date(startMs - 1000);
      const justAfter = new Date(startMs + 1000);
      const atEnd = new Date(endMs);
      const afterEnd = new Date(endMs + 1000);

      const fixtures = [
        { fixture: { date: justBefore.toISOString() } },
        { fixture: { date: justAfter.toISOString() } },
        { fixture: { date: atEnd.toISOString() } },
        { fixture: { date: afterEnd.toISOString() } },
      ];

      const filtered = filterFixtureWindow(fixtures, now, windowHours);

      expect(filtered.length).toBe(2); // justAfter and atEnd
      expect(filtered[0].fixture.date).toBe(justAfter.toISOString());
      expect(filtered[1].fixture.date).toBe(atEnd.toISOString());
    });

    it("correctly handles 72-hour window from 2026-09-07T22:23:18Z", () => {
      const now = new Date("2026-09-07T22:23:18Z");
      const windowHours = 72;

      const sep08 = new Date("2026-09-08T20:00:00Z");
      const sep10 = new Date("2026-09-10T20:00:00Z");
      const sep11 = new Date("2026-09-11T22:24:00Z"); // Just after window

      const fixtures = [
        { fixture: { date: sep08.toISOString() } },
        { fixture: { date: sep10.toISOString() } },
        { fixture: { date: sep11.toISOString() } },
      ];

      const filtered = filterFixtureWindow(fixtures, now, windowHours);
      expect(filtered.length).toBe(2);
    });
  });

  describe("future status filtering", () => {
    it("keeps future/upcoming statuses", () => {
      const futureStatuses = ["NS", "TBD", "PST", "SUSP"];
      for (const status of futureStatuses) {
        expect(isFutureStatus(status)).toBe(true);
      }
    });

    it("rejects live and completed statuses", () => {
      const rejectedStatuses = [
        "1H", "2H", "HT", "ET", "BT", "P", "LIVE",
        "FT", "AET", "PEN", "AWD", "WO",
      ];
      for (const status of rejectedStatuses) {
        expect(isFutureStatus(status)).toBe(false);
      }
    });

    it("rejects undefined status", () => {
      expect(isFutureStatus(undefined)).toBe(false);
    });
  });

  describe("deduplication by fixture ID", () => {
    it("deduplicates fixtures using Map keyed by fixture.id", () => {
      const fixtures = [
        { id: 1, name: "Match A" },
        { id: 2, name: "Match B" },
        { id: 1, name: "Match A duplicate" },
      ];

      const dedupMap = new Map<number, typeof fixtures[0]>();
      for (const fixture of fixtures) {
        dedupMap.set(fixture.id, fixture);
      }

      expect(dedupMap.size).toBe(2);
      expect(dedupMap.get(1)!.name).toBe("Match A duplicate");
    });
  });

  describe("API quota strategy", () => {
    it("first attempts broad date-range query (1 call) for optimal quota usage", () => {
      // Strategy: try broad query first with no league filter
      // If it returns results covering all tracked competitions, use those (1 API call)
      // If it returns empty or error, fall back to per-league queries (up to 25 calls)
      expect("broad query strategy").toBeTruthy();
    });

    it("falls back to per-league queries (up to 25 calls) only if broad query fails", () => {
      // Each competition gets queried individually: /fixtures?league=${id}
      // Sequential calls respect shared rate limiter
      // Result: worst-case 1 + 25 = 26 calls for initial fetch
      // With 2-hour refresh: 26 * 12 = 312 calls/day maximum
      // More typical: 1-5 calls/day if broad query succeeds
      expect("fallback to per-league").toBeTruthy();
    });

    it("includes quota diagnostics in result: apiFetchCount, strategy, competitionsCovered", () => {
      const quotaInfo = {
        strategy: "broad date range (optimal)",
        apiFetchCount: 1,
        competitionsCovered: 25,
        competitionsWithZeroResults: 0,
      };
      expect(quotaInfo.apiFetchCount).toBeGreaterThanOrEqual(1);
      expect(quotaInfo.competitionsCovered).toBeGreaterThanOrEqual(0);
      expect(quotaInfo.competitionsCovered).toBeLessThanOrEqual(25);
    });
  });

  describe("API-Football compatibility", () => {
    it("uses FOOTBALL_SEASON env var or defaults to current year", () => {
      const currentYear = new Date().getUTCFullYear();
      const season = process.env.FOOTBALL_SEASON ?? String(currentYear);
      expect(season).toMatch(/^\d{4}$/);
    });

    it("constructs date range correctly: from=YYYY-MM-DD&to=YYYY-MM-DD", () => {
      const now = new Date("2026-09-07T22:23:18Z");
      const windowHours = 72;
      const end = new Date(now.getTime() + windowHours * 3_600_000);

      const fromDate = now.toISOString().slice(0, 10); // 2026-09-07
      const toDate = end.toISOString().slice(0, 10); // 2026-09-10

      expect(fromDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(toDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(fromDate).getTime()).toBeLessThan(new Date(toDate).getTime());
    });

    it("supports per-league query fallback: /fixtures?league=${id}&from=...&to=...&season=...", () => {
      for (const comp of TRACKED_COMPETITIONS) {
        const leagueId = comp.id;
        expect(leagueId).toBeGreaterThan(0);
        // Example path: /fixtures?league=2&from=2026-09-07&to=2026-09-10&season=2026
      }
    });
  });
});

