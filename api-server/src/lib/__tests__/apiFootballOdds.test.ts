import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }));
vi.mock("../soccerService", () => ({ fetchFootball: async () => [], getAllMatches: async () => [] }));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));
vi.mock("../leagueConfig", () => ({ isTrackedLeague: () => true }));

const { apifReadDue, displayOddsFrom, fillMissingOdds, noOddsBackoffHours, parseLive, parsePrematch, readMarkets } = await import("../apiFootballOdds");

const prematch = {
  league: { id: 39 }, fixture: { id: 1001, date: "2026-10-27T15:00:00+00:00" }, update: "2026-10-26T12:00:00+00:00",
  bookmakers: [
    { id: 8, name: "Bet365", bets: [
      { id: 1, name: "Match Winner", values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.40" }, { value: "Away", odd: "3.60" }] },
      { id: 5, name: "Goals Over/Under", values: [{ value: "Over 1.5", odd: "1.30" }, { value: "Over 2.5", odd: "1.95" }, { value: "Under 2.5", odd: "1.85" }] },
      { id: 6, name: "Goals Over/Under First Half", values: [{ value: "Over 2.5", odd: "6.00" }, { value: "Under 2.5", odd: "1.10" }] },
      { id: 8, name: "Both Teams Score", values: [{ value: "Yes", odd: "1.80" }, { value: "No", odd: "2.00" }] },
    ] },
    { id: 11, name: "1xBet", bets: [{ id: 2, name: "Home/Away", values: [{ value: "Home", odd: "1.6" }] }] },
  ],
};

describe("API-Football pre-match odds", () => {
  it("reads match result, full-match over/under 2.5 and BTTS, ignoring first-half lines", () => {
    const p = parsePrematch(prematch)!;
    expect(p.fixtureId).toBe(1001);
    expect(p.books).toHaveLength(1); // the bookmaker with none of the three markets is dropped
    expect(p.books[0]).toEqual({ id: 8, name: "Bet365", home: 2.1, draw: 3.4, away: 3.6, over25: 1.95, under25: 1.85, bttsYes: 1.8, bttsNo: 2 });
  });

  it("rejects invalid prices", () => {
    const m = readMarkets([{ name: "Match Winner", values: [{ value: "Home", odd: "1" }, { value: "Draw", odd: "x" }, { value: "Away", odd: "4.5" }] }]);
    expect(m.home).toBeNull();
    expect(m.draw).toBeNull();
    expect(m.away).toBe(4.5);
  });
});

describe("API-Football live odds", () => {
  const live = {
    fixture: { id: 2002, status: { elapsed: 63 } }, league: { id: 140 }, teams: { home: { goals: 1 }, away: { goals: 0 } },
    status: { stopped: false, blocked: false, finished: false }, update: "2026-10-26T16:03:00+00:00",
    odds: [
      { id: 59, name: "Fulltime Result", values: [{ value: "Home", odd: "1.40" }, { value: "Draw", odd: "4.33", suspended: true }, { value: "Away", odd: "9.00" }] },
      { id: 36, name: "Over/Under Line", values: [{ value: "Over", odd: "1.70", handicap: "2.5" }, { value: "Under", odd: "2.10", handicap: "2.5" }, { value: "Over", odd: "1.20", handicap: "1.5" }] },
    ],
  };

  it("reads live prices with minute and score, skipping suspended ones", () => {
    const p = parseLive(live)!;
    expect(p).toMatchObject({ fixtureId: 2002, minute: 63, scoreHome: 1, scoreAway: 0, usable: true });
    expect(p.odds.home).toBe(1.4);
    expect(p.odds.draw).toBeNull(); // suspended
    expect(p.odds.over25).toBe(1.7);
    expect(p.odds.under25).toBe(2.1);
  });

  it("marks stopped or blocked markets as unusable", () => {
    expect(parseLive({ ...live, status: { stopped: true } })!.usable).toBe(false);
    expect(parseLive({ ...live, status: { blocked: true } })!.usable).toBe(false);
  });
});

describe("API-Football pre-match read schedule", () => {
  it("reads once at each of 3 days, 2 days and 1 day, catching up a missed one", () => {
    expect(apifReadDue(80, null)).toBe(false);
    expect(apifReadDue(74, null)).toBe(true);
    expect(apifReadDue(60, 14)).toBe(false); // read at 74h covers the 3-day checkpoint
    expect(apifReadDue(50, 24)).toBe(true);  // 2-day window
    expect(apifReadDue(40, 34)).toBe(true);  // 2-day missed: catch up
  });

  it("then every 3 hours, hourly from 6 hours, and every 30 minutes in the last hour", () => {
    expect(apifReadDue(12, 2)).toBe(false);
    expect(apifReadDue(12, 3)).toBe(true);
    expect(apifReadDue(4, 0.5)).toBe(false);
    expect(apifReadDue(4, 1)).toBe(true);
    expect(apifReadDue(0.6, 0.5)).toBe(true);
    expect(apifReadDue(-0.1, null)).toBe(false);
  });
});

describe("API-Football fixtures with no odds yet", () => {
  it("waits before re-reading a fixture that returned nothing, so later fixtures get their turn", () => {
    expect(noOddsBackoffHours(60)).toBe(6);
    expect(noOddsBackoffHours(12)).toBe(2);
    expect(noOddsBackoffHours(3)).toBe(0.5);
  });
});

describe("API-Football price on match cards", () => {
  const row = (bookId: number, name: string, h: number, d: number, a: number) => ({ bookId, name, h, d, a, updated: "2026-10-26T10:00:00.000Z" });

  it("prefers Bet365 and shows its prices with the margin removed", () => {
    const o = displayOddsFrom([row(11, "1xBet", 6, 4, 1.5), row(8, "Bet365", 5, 4, 1.6)])!;
    expect(o.bookmaker).toBe("Bet365 (via API-Football)");
    expect(o.bookmaker_key).toBe("apif-8");
    expect(o.away_odds).toBe(1.6);
    expect(o.home_win + o.draw + o.away_win).toBeCloseTo(100, 6);
    expect(o.away_win).toBeGreaterThan(o.home_win);
  });

  it("falls back to any bookmaker, and ignores invalid prices", () => {
    expect(displayOddsFrom([row(99, "Other", 2, 3, 4)])!.bookmaker_key).toBe("apif-99");
    expect(displayOddsFrom([row(8, "Bet365", 1, 3, 4)])).toBeNull();
  });

  it("leaves matches unchanged when there is nothing stored", async () => {
    const m = [{ id: 1, status: "upcoming", odds: null }, { id: 2, status: "upcoming", odds: { home_odds: 2 } }];
    expect(await fillMissingOdds(m)).toEqual(m);
  });
});
