import { describe, expect, it } from "vitest";
import { extractOdds, type OddsApiEvent } from "../soccerService";

describe("bookmaker odds metadata", () => {
  it("returns prices, selected bookmaker, and its market update timestamp", () => {
    const events: OddsApiEvent[] = [{
      id: "event-1",
      sport_key: "soccer_epl",
      home_team: "Home FC",
      away_team: "Away FC",
      bookmakers: [{
        key: "pinnacle",
        title: "Pinnacle",
        markets: [{
          key: "h2h",
          last_update: "2026-10-15T12:30:00Z",
          outcomes: [
            { name: "Home FC", price: 2.1 },
            { name: "Draw", price: 3.2 },
            { name: "Away FC", price: 4.0 },
          ],
        }],
      }],
    }];

    expect(extractOdds("Home FC", "Away FC", events, "soccer_epl")).toMatchObject({
      home_odds: 2.1,
      draw_odds: 3.2,
      away_odds: 4.0,
      bookmaker: "Pinnacle",
      bookmaker_key: "pinnacle",
      last_updated: "2026-10-15T12:30:00Z",
    });
  });
});
