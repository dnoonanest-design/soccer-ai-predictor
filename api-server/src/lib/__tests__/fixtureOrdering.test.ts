import { describe, expect, it } from "vitest";
import {
  getCompetitionImportance,
  sortFixturesForDisplay,
} from "../fixtureOrdering";

function fixture(
  id: number,
  leagueId: number,
  kickoff: string,
  status = "upcoming",
) {
  return {
    id,
    league_id: leagueId,
    kickoff,
    status,
    home_team: { name: `Home ${id}` },
    away_team: { name: `Away ${id}` },
  };
}

describe("fixture display ordering", () => {
  it("orders dates chronologically before applying importance", () => {
    const laterChampionsLeague = fixture(1, 2, "2026-09-13T18:00:00Z");
    const earlierSecondDivision = fixture(2, 40, "2026-09-12T20:00:00Z");

    expect(
      sortFixturesForDisplay([laterChampionsLeague, earlierSecondDivision]).map(
        (f) => f.id,
      ),
    ).toEqual([2, 1]);
  });

  it("groups dates using Dublin local time", () => {
    const afterMidnightInDublin = fixture(1, 40, "2026-09-12T23:30:00Z");
    const sameDublinDayChampionsLeague = fixture(2, 2, "2026-09-13T00:30:00Z");

    expect(
      sortFixturesForDisplay([
        afterMidnightInDublin,
        sameDublinDayChampionsLeague,
      ]).map((f) => f.id),
    ).toEqual([2, 1]);
  });

  it("puts live matches first, then ranks competitions by importance", () => {
    const items = [
      fixture(1, 40, "2026-09-12T19:00:00Z"),
      fixture(2, 2, "2026-09-12T20:00:00Z"),
      fixture(3, 39, "2026-09-12T18:00:00Z", "live"),
      fixture(4, 45, "2026-09-12T17:00:00Z"),
    ];

    expect(sortFixturesForDisplay(items).map((f) => f.id)).toEqual([
      3, 2, 4, 1,
    ]);
  });

  it("classifies the product competition tiers", () => {
    expect(getCompetitionImportance(2).label).toBe("Elite European");
    expect(getCompetitionImportance(45).label).toBe("Domestic Cup");
    expect(getCompetitionImportance(39).label).toBe("Top Division");
    expect(getCompetitionImportance(40).label).toBe("Second Division");
  });
});
