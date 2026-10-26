import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../logger", () => ({ logger: { warn: () => {}, info: () => {}, debug: () => {} } }));

const { blendCrossDivision, crossDivisionProbs, tierFromEvidence } = await import("../crossDivision");
const { divisionTierFromCompetitions, divisionTierFromLeagueName } = await import("../divisionTier");

describe("club divisions from league names", () => {
  it("reads the tier of each country's pyramid", () => {
    expect(divisionTierFromLeagueName("Tercera División RFEF - Group 17")).toBe(5);
    expect(divisionTierFromLeagueName("Segunda División RFEF - Group 3")).toBe(4);
    expect(divisionTierFromLeagueName("Primera División RFEF - Group 1")).toBe(3);
    expect(divisionTierFromLeagueName("Segunda División")).toBe(2);
    expect(divisionTierFromLeagueName("National League - North")).toBe(6);
    expect(divisionTierFromLeagueName("National League")).toBe(5);
    expect(divisionTierFromLeagueName("Non League Div One - Isthmian North")).toBe(8);
    expect(divisionTierFromLeagueName("National 3 - Group H")).toBe(5);
    expect(divisionTierFromLeagueName("Ligue 3")).toBe(3);
    expect(divisionTierFromLeagueName("Regionalliga - Bayern")).toBe(4);
    expect(divisionTierFromLeagueName("Campeonato de Portugal Prio - Group A")).toBe(4);
    expect(divisionTierFromLeagueName("Derde Divisie - Sunday")).toBe(4);
  });

  it("ignores cups, continental and youth competitions", () => {
    expect(divisionTierFromLeagueName("Copa del Rey")).toBeNull();
    expect(divisionTierFromLeagueName("OFC Champions League")).toBeNull();
    expect(divisionTierFromLeagueName("Premier League U21")).toBeNull();
    expect(divisionTierFromCompetitions(["Copa del Rey", "Tercera División RFEF - Group 17", "Tercera División RFEF - Group 17"])).toBe(5);
  });

  it("puts clubs outside the tracked top two in tier 3 or lower, and clubs with no league listed at the bottom", () => {
    expect(tierFromEvidence(1, null, "spain")).toBe(1);
    expect(tierFromEvidence(null, ["Segunda División", "Segunda División"], "spain")).toBe(3);
    expect(tierFromEvidence(null, ["Copa del Rey"], "spain")).toBe(6);
    expect(tierFromEvidence(null, ["FA Cup", "FA Trophy"], "england")).toBe(9);
    expect(tierFromEvidence(null, [], "england")).toBeNull();
    expect(tierFromEvidence(null, ["Brisbane Premier League"], "england")).toBeNull();
  });
});

describe("cup ties between divisions", () => {
  it("makes the higher-division club favourite, more so the bigger the gap", () => {
    const p = crossDivisionProbs(5, 2);
    expect(p.away).toBeGreaterThan(0.7);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
    expect(crossDivisionProbs(8, 1).away).toBeGreaterThan(crossDivisionProbs(3, 1).away);
    expect(crossDivisionProbs(1, 3).home).toBeGreaterThan(0.6);
  });

  it("keeps 10% of the formula and leaves same-division ties alone", () => {
    const formula = { home_win: 50, draw: 25, away_win: 25 };
    const b = blendCrossDivision(formula, 5, 2)!;
    const g = crossDivisionProbs(5, 2);
    expect(b.away_win).toBeCloseTo(100 * (0.1 * 0.25 + 0.9 * g.away), 1);
    expect(b.home_win + b.draw + b.away_win).toBeCloseTo(100, 6);
    expect(b.away_win).toBeGreaterThan(b.home_win);
    expect(blendCrossDivision(formula, 2, 2)).toBeNull();
    expect(blendCrossDivision(formula, null, 2)).toBeNull();
  });
});
