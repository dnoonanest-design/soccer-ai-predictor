import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../soccerService", () => ({ fetchFootball: async () => [], resolveSeasonForCompetition: async () => 2026 }));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));

const { leaders, lineupStatus, playerStats, presentationTtl, scoringForm, squadContext } = await import("../matchPresentationService");

const row = (id: number, s: { apps: number; goals?: number; assists?: number; fouls?: number; rating?: number; yellow?: number }) => ({
  player: { id, name: `P${id}` },
  statistics: [{ games: { appearences: s.apps, minutes: s.apps * 80, rating: s.rating ?? null }, goals: { total: s.goals ?? 0, assists: s.assists ?? 0 }, fouls: { committed: s.fouls ?? 0 }, cards: { yellow: s.yellow ?? 0, red: 0 } }],
});

describe("player leaders", () => {
  const players = playerStats([
    row(1, { apps: 10, goals: 7, assists: 1, fouls: 4, rating: 7.4 }),
    row(2, { apps: 10, goals: 3, assists: 5, fouls: 15, rating: 7.1, yellow: 4 }),
    row(3, { apps: 1, goals: 1, rating: 9.0 }),
    row(4, { apps: 8, goals: 0, fouls: 9, rating: 6.6 }),
  ]);

  it("ranks scorers, assists and fouls, and needs 3+ games to lead on rating", () => {
    expect(leaders(players, "goals").map((p) => p.id)).toEqual([1, 2, 3]);
    expect(leaders(players, "assists").map((p) => p.id)).toEqual([2, 1]);
    expect(leaders(players, "fouls").map((p) => p.id)).toEqual([2, 4, 1]);
    expect(leaders(players, "rating").map((p) => p.id)).toEqual([1, 2, 4]); // the 9.0 cameo is excluded
    expect(players.find((p) => p.id === 2)!.yellow).toBe(4);
  });

  it("adds up a player's competition blocks into one entry", () => {
    const merged = playerStats([{ player: { id: 9, name: "P9" }, statistics: [
      { games: { appearences: 5 }, goals: { total: 2 } }, { games: { appearences: 3 }, goals: { total: 1 } },
    ] }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].goals).toBe(3);
    expect(merged[0].appearances).toBe(8);
  });
});

describe("lineup status", () => {
  const lineup = { team: { id: 50 }, startXI: Array.from({ length: 11 }, (_, i) => ({ player: { id: i + 1 } })), substitutes: [{ player: { id: 20 } }] };
  const injuries = [
    { team: { id: 50 }, player: { id: 30, type: "Missing Fixture", reason: "Hamstring Injury" } },
    { team: { id: 50 }, player: { id: 31, type: "Questionable", reason: "Knock" } },
    { team: { id: 99 }, player: { id: 32, type: "Missing Fixture", reason: "Suspended" } },
  ];

  it("marks starters, bench, out and not in squad once lineups are published", () => {
    const ctx = squadContext(lineup, injuries, 50);
    expect(lineupStatus(3, ctx).status).toBe("starting");
    expect(lineupStatus(20, ctx).status).toBe("bench");
    expect(lineupStatus(30, ctx)).toEqual({ status: "injured_or_suspended", reason: "Hamstring Injury" });
    expect(lineupStatus(77, ctx).status).toBe("not_in_squad");
  });

  it("before lineups, shows only injury news", () => {
    const ctx = squadContext(undefined, injuries, 50);
    expect(lineupStatus(3, ctx).status).toBeNull();
    expect(lineupStatus(30, ctx).status).toBe("injured_or_suspended");
    expect(lineupStatus(31, ctx).status).toBe("doubtful");
    expect(lineupStatus(32, ctx).status).toBeNull(); // other team's absentee
  });
});

describe("goal-scoring form", () => {
  const app = (f: number, day: number, p: number, minutes: number, goals: number) => ({ fixtureId: f, date: Date.parse(`2026-10-${String(day).padStart(2, "0")}T15:00:00Z`), playerId: p, name: `P${p}`, minutes, goals });

  it("counts consecutive scoring matches, skipping games he did not play", () => {
    const rows = [
      app(1, 25, 7, 90, 1), app(2, 21, 7, 0, 0), app(3, 18, 7, 85, 2), app(4, 14, 7, 90, 1), app(5, 10, 7, 90, 0),
      app(1, 25, 8, 90, 0), app(3, 18, 8, 90, 3),
    ];
    const f = scoringForm(rows);
    expect(f.matches).toBe(5);
    expect(f.entries[0]).toMatchObject({ id: 7, scoring_streak: 3, goals_last5: 4, matches_last5: 4 });
    expect(f.entries[1]).toMatchObject({ id: 8, scoring_streak: 0, goals_last5: 3 }); // 3 in 5, streak broken last game
  });

  it("leaves out players who are not on a run", () => {
    expect(scoringForm([app(1, 25, 9, 90, 1), app(2, 20, 9, 90, 0)]).entries).toEqual([]);
  });
});

describe("refresh timing", () => {
  const now = Date.parse("2026-10-26T14:00:00Z");
  it("rebuilds every minute close to kickoff until lineups are published", () => {
    expect(presentationTtl("upcoming", "2026-10-26T15:00:00Z", false, now)).toBe(60_000);
    expect(presentationTtl("upcoming", "2026-10-26T15:00:00Z", true, now)).toBe(10 * 60_000);
    expect(presentationTtl("upcoming", "2026-10-27T15:00:00Z", false, now)).toBe(10 * 60_000);
  });
});
