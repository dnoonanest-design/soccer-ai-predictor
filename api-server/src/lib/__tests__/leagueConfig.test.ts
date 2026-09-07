import { describe, expect, it } from "vitest";
import {
  getOddsSportKeyForLeague,
  isTrackedLeague,
  TRACKED_LEAGUE_IDS,
} from "../leagueConfig";

const EXPECTED_SCOPE = [
  39, 40, 45, 48, // England
  61, 62, 66, // France
  140, 141, 143, // Spain
  94, 95, 96, // Portugal
  78, 79, 81, // Germany
  135, 136, 137, // Italy
  88, 89, 90, // Netherlands
  2, 3, 848, // UEFA
];

const OUT_OF_SCOPE = [
  1, // World Cup
  4, // Euros
  5, // Nations League
  71, // Brazil Serie A
  103, // Norway Eliteserien
  113, // Sweden Allsvenskan
  119, // Denmark Superliga
  128, // Argentina
  144, // Belgium
  169, // Switzerland
  203, // Turkey
  253, // MLS
  307, // Saudi Pro League
];

describe("league configuration", () => {
  it("contains only the intended European club competition scope", () => {
    expect(Array.from(TRACKED_LEAGUE_IDS).sort((a, b) => a - b)).toEqual(
      [...EXPECTED_SCOPE].sort((a, b) => a - b),
    );

    for (const leagueId of EXPECTED_SCOPE) {
      expect(isTrackedLeague(leagueId)).toBe(true);
    }
    for (const leagueId of OUT_OF_SCOPE) {
      expect(isTrackedLeague(leagueId)).toBe(false);
    }
  });

  it("maps supported competitions to specific The Odds API sport keys", () => {
    expect(getOddsSportKeyForLeague(39)).toBe("soccer_epl");
    expect(getOddsSportKeyForLeague(40)).toBe("soccer_efl_champ");
    expect(getOddsSportKeyForLeague(62)).toBe("soccer_france_ligue_two");
    expect(getOddsSportKeyForLeague(79)).toBe("soccer_germany_bundesliga2");
    expect(getOddsSportKeyForLeague(136)).toBe("soccer_italy_serie_b");
    expect(getOddsSportKeyForLeague(141)).toBe("soccer_spain_segunda_division");
    expect(getOddsSportKeyForLeague(2)).toBe("soccer_uefa_champs_league");
    expect(getOddsSportKeyForLeague(3)).toBe("soccer_uefa_europa_league");
    expect(getOddsSportKeyForLeague(848)).toBe(
      "soccer_uefa_europa_conference_league",
    );
  });

  it("keeps core coverage when the odds provider has no dedicated market key", () => {
    for (const leagueId of [95, 96, 89, 90]) {
      expect(isTrackedLeague(leagueId)).toBe(true);
      expect(getOddsSportKeyForLeague(leagueId)).toBeNull();
    }
  });
});
