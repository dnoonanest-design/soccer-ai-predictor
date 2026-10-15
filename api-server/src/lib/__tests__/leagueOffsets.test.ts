import { describe, expect, it } from "vitest";
import { fitLeagueOffsets, type CrossLeagueMatch } from "../leagueOffsets";

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function poisson(lambda: number, u: () => number) {
  let k = 0, p = Math.exp(-lambda), cdf = p;
  const x = u();
  while (x > cdf && k < 30) { k++; p *= lambda / k; cdf += p; }
  return k;
}

// League 1 is truly 0.6 stronger (log goals) than league 2; the prior says they are equal.
function matches(n: number, gap = 0.6): CrossLeagueMatch[] {
  const u = rng(5);
  const truth = new Map([[1, 0], [2, -gap]]);
  const rows: CrossLeagueMatch[] = [];
  for (let i = 0; i < n; i++) {
    const [hl, al] = i % 2 ? [1, 2] : [2, 1];
    const baseHome = Math.log(1.45) + (u() - 0.5) * 0.6, baseAway = Math.log(1.15) + (u() - 0.5) * 0.6;
    const d = truth.get(hl)! - truth.get(al)!;
    rows.push({ homeLeague: hl, awayLeague: al, baseHome, baseAway,
      homeGoals: poisson(Math.exp(baseHome + d), u), awayGoals: poisson(Math.exp(baseAway - d), u), weight: 1 });
  }
  return rows;
}

describe("league offsets", () => {
  it("recovers the strength gap between two leagues from cross-league results", () => {
    const fit = fitLeagueOffsets(matches(800), new Map([[1, 0], [2, 0]]), 0.3);
    const gap = fit.offsets.get(1)! - fit.offsets.get(2)!;
    expect(gap).toBeGreaterThan(0.45);
    expect(gap).toBeLessThan(0.75);
    expect(fit.matches.get(1)).toBe(800);
  });

  it("stays at the prior when a league has no cross-league matches", () => {
    const fit = fitLeagueOffsets(matches(200), new Map([[1, 0], [2, 0], [3, -0.2]]), 0.3);
    expect(fit.offsets.get(3)).toBe(-0.2);
  });

  it("stays near the prior with very few matches", () => {
    const fit = fitLeagueOffsets(matches(6), new Map([[1, 0], [2, 0]]), 0.3);
    expect(Math.abs(fit.offsets.get(1)! - fit.offsets.get(2)!)).toBeLessThan(0.45);
  });
});
