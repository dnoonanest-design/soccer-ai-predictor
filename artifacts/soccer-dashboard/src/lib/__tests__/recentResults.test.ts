import { describe, expect, it } from "vitest";
import { summariseResults, type TeamRecentResult } from "../recentResults";

const m = (venue: "home" | "away", home: number, away: number, result: "W" | "D" | "L"): TeamRecentResult => ({
  fixture_id: Math.random(), date: "2026-10-20T19:00:00Z", competition: "Premier League",
  home_team: "A", away_team: "B", home_score: home, away_score: away, venue, opponent: "X", result,
});

describe("recent results summary", () => {
  it("counts results and goals from the team's own side, home or away", () => {
    const s = summariseResults([m("home", 2, 0, "W"), m("away", 3, 1, "L"), m("away", 0, 2, "W"), m("home", 1, 1, "D")]);
    expect(s).toEqual({ w: 2, d: 1, l: 1, gf: 2 + 1 + 2 + 1, ga: 0 + 3 + 0 + 1, played: 4 });
  });

  it("handles a team with no completed matches", () => {
    expect(summariseResults([])).toEqual({ w: 0, d: 0, l: 0, gf: 0, ga: 0, played: 0 });
  });
});
