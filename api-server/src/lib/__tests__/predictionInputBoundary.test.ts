import { describe, expect, it } from "vitest";
import { toPredictionMatch } from "../predictionInputBoundary";
import type { Match } from "../soccerService";

const fixture: Match = {
  id: 10,
  league_id: 39,
  league_name: "Premier League",
  league_logo: null,
  country: "England",
  home_team: { id: 1, name: "Home FC", logo: null },
  away_team: { id: 2, name: "Away FC", logo: null },
  status: "upcoming",
  status_detail: "NS",
  minute: null,
  score: { home: null, away: null },
  score_ht: null,
  kickoff: "2026-10-20T15:00:00Z",
  odds: {
    home_win: 45,
    draw: 30,
    away_win: 25,
    home_odds: 2.1,
    draw_odds: 3.2,
    away_odds: 4.0,
    bookmaker: "Pinnacle",
    bookmaker_key: "pinnacle",
    last_updated: "2026-10-15T12:00:00Z",
  },
};

describe("prediction input boundary", () => {
  it("removes bookmaker odds before model code receives a fixture", () => {
    const input = toPredictionMatch(fixture);
    expect(input).not.toHaveProperty("odds");
    expect(input).toEqual(toPredictionMatch({
      ...fixture,
      odds: {
        home_win: 1,
        draw: 98,
        away_win: 1,
        home_odds: 99,
        draw_odds: 1.01,
        away_odds: 99,
        bookmaker: "Different source",
        bookmaker_key: "different",
        last_updated: "2030-01-01T00:00:00Z",
      },
    }));
  });
});
