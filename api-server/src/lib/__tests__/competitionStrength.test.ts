import { describe, expect, it } from "vitest";
import {
  MANCHESTER_RULE,
  competitionStrengthIndex,
  manchesterRulePerformanceWeight,
  relativeStrengthAdjustment,
} from "../competitionStrength";

describe(`Manchester Rule: ${MANCHESTER_RULE}`, () => {
  it("rates the Premier League above the Azerbaijani league", () => {
    expect(competitionStrengthIndex(39, "Premier League", "England"))
      .toBeGreaterThan(competitionStrengthIndex(419, "Premyer Liqa", "Azerbaijan"));
  });

  it("moves cross-league expected goals toward the stronger club", () => {
    const adjustment = relativeStrengthAdjustment(1.18, 0.78);
    expect(adjustment.home).toBeGreaterThan(1.35);
    expect(adjustment.away).toBeLessThan(0.75);
  });

  it("does not treat identical results in strong and weak leagues as equal", () => {
    const premierLeagueResult = manchesterRulePerformanceWeight(1.18);
    const azerbaijaniLeagueResult = manchesterRulePerformanceWeight(0.78);
    expect(premierLeagueResult).toBeGreaterThan(1);
    expect(azerbaijaniLeagueResult).toBeLessThan(1);
    expect(premierLeagueResult).toBeGreaterThan(azerbaijaniLeagueResult);
  });

  it("does not distort equal-strength opponents", () => {
    expect(relativeStrengthAdjustment(1.1, 1.1)).toEqual({ home: 1, away: 1 });
  });

  it("shrinks competition strength toward neutral for sparse history", () => {
    const full = relativeStrengthAdjustment(1.18, 0.78, 5, 5);
    const sparse = relativeStrengthAdjustment(1.18, 0.78, 1, 1);
    expect(sparse.home).toBeLessThan(full.home);
    expect(sparse.away).toBeGreaterThan(full.away);
  });

  it("reverses the erroneous United-Sabah xG ordering", () => {
    const adjustment = relativeStrengthAdjustment(1.18, 0.78, 12, 12);
    const unitedXg = 1.58 * adjustment.home;
    const sabahXg = 2.04 * adjustment.away;
    expect(unitedXg).toBeGreaterThan(sabahXg);
  });
});
