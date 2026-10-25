import { describe, expect, it, vi } from "vitest";
import type { PlayerAppearance } from "../teamSheets";

const { queries } = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }> }));
vi.mock("@workspace/db", () => ({
  pool: { query: async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return { rowCount: 1, rows: [] }; } },
}));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));

const { availability, buildTeamSheet, recordPrematchTeamSheets } = await import("../teamSheets");

const xi = (team: number, ids: number[]) => ({
  team: { id: team, name: `T${team}` }, formation: "4-3-3",
  startXI: ids.map((id) => ({ player: { id, name: `P${id}`, pos: "M" } })),
  substitutes: [{ player: { id: 99, name: "Sub", pos: "F" } }],
});
const injury = (team: number, id: number, type = "Missing Fixture") => ({ team: { id: team }, player: { id, name: `P${id}`, type, reason: "Knee Injury" } });

describe("pre-kickoff team sheets", () => {
  it("keeps names and ids of starters and missing players, per side", () => {
    const s = buildTeamSheet("home", 1, "T1", [xi(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), xi(2, [21])], [injury(1, 12), injury(2, 30), injury(1, 12)]);
    expect(s.startingXi?.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(s.formation).toBe("4-3-3");
    expect(s.missing).toEqual([{ id: 12, name: "P12", type: "Missing Fixture", reason: "Knee Injury" }]); // deduplicated, other team excluded
  });

  it("treats a partial lineup as not yet published", () => {
    const s = buildTeamSheet("away", 2, "T2", [xi(2, [21, 22, 23])], []);
    expect(s.startingXi).toBeNull();
    expect(s.formation).toBeNull();
  });

  it("gives the same hash for the same sheet and a new hash when it changes", () => {
    const a = buildTeamSheet("home", 1, "T1", [], [injury(1, 12), injury(1, 13)]);
    const b = buildTeamSheet("home", 1, "T1", [], [injury(1, 13), injury(1, 12)]);
    const c = buildTeamSheet("home", 1, "T1", [xi(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])], [injury(1, 12), injury(1, 13)]);
    expect(a.contentHash).toBe(b.contentHash);
    expect(c.contentHash).not.toBe(a.contentHash);
  });

  it("stores nothing at or after kickoff, or for matches already started", async () => {
    queries.length = 0;
    const kickoff = "2026-10-25T15:00:00Z";
    const match = { id: 7, league_id: 39, kickoff, status: "upcoming", home_team: { id: 1, name: "T1" }, away_team: { id: 2, name: "T2" } };
    const lineups = [xi(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), xi(2, [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])];
    expect(await recordPrematchTeamSheets(match, lineups, [], Date.parse(kickoff))).toBe(0);
    expect(await recordPrematchTeamSheets({ ...match, status: "live" }, lineups, [], Date.parse(kickoff) - 60_000)).toBe(0);
    expect(queries).toHaveLength(0);
    expect(await recordPrematchTeamSheets(match, lineups, [], Date.parse(kickoff) - 60_000)).toBe(2);
    expect(queries[0].sql).toContain("INSERT INTO prematch_team_sheets");
    expect(queries[0].sql).toContain("ON CONFLICT (fixture_id, side, content_hash) DO NOTHING");
  });
});

describe("availability measures", () => {
  // Five earlier matches: players 1-11 start every time; 12 starts three; 13 comes on late.
  const history: PlayerAppearance[] = [];
  for (let f = 1; f <= 5; f++) {
    for (let p = 1; p <= 11; p++) history.push({ fixtureId: f, playerId: p, minutes: p === 11 && f <= 3 ? 0 : 90, started: !(p === 11 && f <= 3), rating: p === 9 ? 8.0 : 6.8 });
    if (f <= 3) history.push({ fixtureId: f, playerId: 12, minutes: 90, started: true, rating: 7.0 });
    history.push({ fixtureId: f, playerId: 13, minutes: 10, started: false, rating: null });
  }

  it("needs a few earlier matches", () => {
    expect(availability({ startingXi: null, missing: [] }, history.filter((h) => h.fixtureId <= 2))).toBeNull();
  });

  it("measures how much of the usual side is missing", () => {
    const a = availability({ startingXi: null, missing: [{ id: 9, name: "P9", type: "Missing Fixture", reason: null }, { id: 13, name: "P13", type: "Missing Fixture", reason: null }] }, history)!;
    expect(a.historyMatches).toBe(5);
    expect(a.regulars).toBe(11); // 1-10 and 12 started at least half
    expect(a.missingRegulars).toBe(1); // 9; 13 is a bench player
    expect(a.missingMinutesShare).toBeGreaterThan(0.08);
    expect(a.missingMinutesShare).toBeLessThan(0.11);
    expect(a.missingRatingGap).toBeGreaterThan(1); // the star is missing
    expect(a.xiRegularShare).toBeNull();
  });

  it("ignores players only listed as questionable", () => {
    const a = availability({ startingXi: null, missing: [{ id: 9, name: "P9", type: "Questionable", reason: null }] }, history)!;
    expect(a.missingRegulars).toBe(0);
    expect(a.missingMinutesShare).toBe(0);
    expect(a.missingRatingGap).toBeNull();
  });

  it("scores a rotated starting XI below the usual one", () => {
    const usual = availability({ startingXi: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map((id) => ({ id, name: `P${id}` })), missing: [] }, history)!;
    const rotated = availability({ startingXi: [1, 2, 3, 4, 5, 13, 40, 41, 42, 43, 44].map((id) => ({ id, name: `P${id}` })), missing: [] }, history)!;
    expect(usual.xiRegularShare).toBe(1);
    expect(rotated.xiRegularShare).toBeCloseTo(5 / 11, 3);
    expect(rotated.xiMinutesShare!).toBeLessThan(usual.xiMinutesShare!);
  });
});
