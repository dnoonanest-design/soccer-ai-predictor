import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));

const { buildBettingAnalysis, compressTimeline, pickFrom } = await import("../bettingAnalysis");

const teams = { home: "Cuarte", away: "Girona" };
const base = { fixtureId: 1, minute: null, score: { home: null, away: null }, teams, liveRows: [], bookmakers: null };

describe("betting analysis", () => {
  it("names the favourite and how clear it is", () => {
    expect(pickFrom({ home: 12, draw: 15, away: 73 }, teams)).toEqual({ outcome: "away", label: "Girona to win", percent: 73, strength: "strong" });
    expect(pickFrom({ home: 36, draw: 33, away: 31 }, teams)!.strength).toBe("too close to call");
    expect(pickFrom({ home: 46, draw: 28, away: 26 }, teams)!.strength).toBe("slight");
  });

  it("before kick-off: our prediction and a plain note", () => {
    const a = buildBettingAnalysis({ ...base, status: "upcoming", prematch: { home: 11.72, draw: 15.35, away: 72.93 },
      bookmakers: { home: 10, draw: 14, away: 76, source: "Bet365", updated_at: null } });
    expect(a.phase).toBe("pre-match");
    expect(a.current).toEqual({ home: 11.7, draw: 15.4, away: 72.9 });
    expect(a.note).toBe("Before kick-off: Girona to win, 72.9% (Cuarte 11.7%, draw 15.4%). Strong favourite.");
    expect(a.bookmakers!.away).toBe(76);
  });

  it("during the match: the latest live reading, the change since kick-off and the movement", () => {
    const a = buildBettingAnalysis({ ...base, status: "live", minute: 63, score: { home: 1, away: 0 },
      prematch: { home: 12, draw: 15, away: 73 },
      liveRows: [
        { minute: 10, home: 13, draw: 16, away: 71 }, { minute: 10, home: 14, draw: 16, away: 70 },
        { minute: 40, home: 45, draw: 30, away: 25 }, { minute: 63, home: 58, draw: 27, away: 15 },
      ] });
    expect(a.current).toEqual({ home: 58, draw: 27, away: 15 });
    expect(a.change).toEqual({ home: 46, draw: 12, away: -58 });
    expect(a.timeline.map((t) => t.minute)).toEqual([0, 10, 40, 63]);
    expect(a.timeline[1].home).toBe(14); // latest reading in that minute
    expect(a.note).toBe("63' · 1-0: Cuarte to win, 58% (draw 27%, Girona 15%) — up 46 points since kick-off.");
  });

  it("live with no readings yet, and full time", () => {
    expect(buildBettingAnalysis({ ...base, status: "live", prematch: null }).note).toBe("Live prediction not available yet.");
    const done = buildBettingAnalysis({ ...base, status: "finished", score: { home: 0, away: 3 }, prematch: { home: 12, draw: 15, away: 73 } });
    expect(done.note).toBe("Full time 0-3. Before kick-off we had Girona to win at 73%.");
    expect(done.current).toBeNull();
  });

  it("ignores readings without a minute", () => {
    expect(compressTimeline([{ minute: null, home: 1, draw: 1, away: 1 }])).toEqual([]);
  });
});
