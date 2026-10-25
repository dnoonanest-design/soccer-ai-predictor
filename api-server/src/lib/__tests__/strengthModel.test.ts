import { describe, expect, it } from "vitest";
import { buildStrengthModel, rawBtts, rawOver25, StrengthState, type StrengthRow } from "../strengthModel";

// Deterministic synthetic league: 20 teams with fixed strengths, home teams score 25% more.
function rng(seed: number) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); }
function poisson(lambda: number, u: () => number) { let k = 0, p = Math.exp(-lambda), c = p; const x = u(); while (x > c && k < 12) { k++; p *= lambda / k; c += p; } return k; }

const STRENGTH = Array.from({ length: 20 }, (_, i) => 0.5 - i * 0.05);
function league(matches: number, seed = 7): StrengthRow[] {
  const u = rng(seed); const rows: StrengthRow[] = []; let t = Date.parse("2022-08-01T15:00:00Z");
  for (let i = 0; i < matches; i++) {
    const home = Math.floor(u() * 20); let away = Math.floor(u() * 20); if (away === home) away = (away + 1) % 20;
    const lh = Math.exp(0.25 + 0.11 + STRENGTH[home] - STRENGTH[away]), la = Math.exp(0.25 - 0.11 + STRENGTH[away] - STRENGTH[home]);
    const hg = poisson(lh, u), ag = poisson(la, u);
    t += 6 * 3600_000;
    rows.push({ fixtureId: i + 1, leagueId: 39, kickoff: t, home: home + 100, away: away + 100, homeGoals: hg, awayGoals: ag,
      homeShots: poisson(lh * 9, u), awayShots: poisson(la * 9, u), homeShotsOnTarget: poisson(lh * 3, u), awayShotsOnTarget: poisson(la * 3, u),
      homeCorners: poisson(4 + lh, u), awayCorners: poisson(4 + la, u), homeXg: lh, awayXg: la });
  }
  return rows;
}

describe("step 9 strength model", () => {
  it("learns the league's home advantage and applies it to both sides", () => {
    const state = new StrengthState();
    for (const r of league(4000)) state.apply(r);
    // Simulated home:away scoring ratio is exp(0.22) = 1.25.
    expect(state.homeAdvantage(39)).toBeGreaterThan(1.15);
    expect(state.homeAdvantage(39)).toBeLessThan(1.35);
  });

  it("uses only matches that kicked off before the forecast time", async () => {
    const rows = league(3000);
    const cut = rows[2000].kickoff;
    const m = await buildStrengthModel(rows, cut, { iterations: 150, yieldEvery: 0 });
    expect(m?.latestMatchAt).toBeLessThan(cut);
  });

  it("gives coherent probabilities and goal markets, and favours the stronger side", async () => {
    const rows = league(4000);
    const m = await buildStrengthModel(rows, rows[3999].kickoff + 1, { iterations: 200, yieldEvery: 0 });
    expect(m).not.toBeNull();
    const strong = m!.forecast(39, 100, 119)!, weak = m!.forecast(39, 119, 100)!;
    expect(strong.probs.home + strong.probs.draw + strong.probs.away).toBeCloseTo(1, 6);
    expect(strong.probs.home).toBeGreaterThan(0.6);
    expect(weak.probs.away).toBeGreaterThan(weak.probs.home);
    for (const f of [strong, weak]) {
      for (const v of [f.markets.over15, f.markets.over25, f.markets.over35, f.markets.btts]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
      expect(f.markets.over15).toBeGreaterThanOrEqual(f.markets.over35);
      expect(f.markets.correctScores.length).toBeGreaterThan(0);
    }
    expect(m!.forecast(39, 100, 999)).toBeNull(); // unseen team: no forecast rather than a guess
  });

  it("beats base rates on later, unseen matches", async () => {
    const rows = league(6000);
    const cut = rows[4500].kickoff;
    const m = (await buildStrengthModel(rows.slice(0, 4500), cut, { iterations: 200, yieldEvery: 0 }))!;
    const test = rows.slice(4500, 5000); // ratings frozen at the cut, a harder test than live use
    const y = (r: StrengthRow) => (r.homeGoals > r.awayGoals ? 0 : r.homeGoals === r.awayGoals ? 1 : 2);
    const counts = [0, 0, 0]; for (const r of rows.slice(0, 4500)) counts[y(r)]++;
    const base = counts.map((c) => c / 4500);
    let llModel = 0, llBase = 0;
    for (const r of test) {
      const p = m.forecast(39, r.home, r.away)!.probs; const pv = [p.home, p.draw, p.away];
      llModel -= Math.log(pv[y(r)]); llBase -= Math.log(base[y(r)]);
    }
    expect(llModel).toBeLessThan(llBase * 0.97);
  });

  it("computes raw goal-market probabilities from expected goals", () => {
    expect(rawOver25(1.5, 1.2)).toBeGreaterThan(0.4);
    expect(rawOver25(1.5, 1.2)).toBeLessThan(0.6);
    expect(rawBtts(1.5, 1.2)).toBeCloseTo((1 - Math.exp(-1.5)) * (1 - Math.exp(-1.2)), 10);
  });
});
