import { describe, expect, it } from "vitest";
import {
  blendedLambdas,
  fitShotConversion,
  fitSoftmax,
  predictSoftmax,
  walkForwardRows,
  type StatFixture,
} from "../stackingModel";
import { parseFixtureStatistics } from "../teamRatingsProvider";

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function poisson(lambda: number, u: () => number) {
  let k = 0, p = Math.exp(-lambda), cdf = p;
  const x = u();
  while (x > cdf && k < 40) { k++; p *= lambda / k; cdf += p; }
  return k;
}
function binomial(n: number, p: number, u: () => number) {
  let k = 0;
  for (let i = 0; i < n; i++) if (u() < p) k++;
  return k;
}

// Twelve teams, five seasons, goals = Binomial(shots on target, 0.3).
function league(): StatFixture[] {
  const u = rng(11);
  const strength = [0.5, 0.35, 0.2, 0.1, 0.05, 0, 0, -0.05, -0.1, -0.2, -0.3, -0.4];
  const out: StatFixture[] = [];
  let day = Date.parse("2022-08-01"), id = 1;
  for (let season = 0; season < 5; season++) {
    for (let h = 0; h < 12; h++) for (let a = 0; a < 12; a++) {
      if (h === a) continue;
      const hSot = poisson(Math.exp(Math.log(4.2) + 0.15 + strength[h] - strength[a]), u);
      const aSot = poisson(Math.exp(Math.log(4.2) + strength[a] - strength[h]), u);
      const hOff = poisson(7, u), aOff = poisson(7, u);
      out.push({
        id: id++, leagueId: 1, date: new Date(day).toISOString(), home: h + 1, away: a + 1,
        homeGoals: binomial(hSot, 0.3, u), awayGoals: binomial(aSot, 0.3, u),
        homeShots: hSot + hOff, awayShots: aSot + aOff, homeSot: hSot, awaySot: aSot,
      });
      day += 86_400_000 / 3;
    }
  }
  return out;
}

describe("stacking model (step 7)", () => {
  it("recovers the shot-to-goal conversion by least squares", () => {
    const c = fitShotConversion(league());
    expect(Math.abs(c.onTarget - 0.3)).toBeLessThan(0.03);
    expect(Math.abs(c.offTarget)).toBeLessThan(0.03);
  });

  it("walk-forward rows never see their own week's results", async () => {
    const fixtures = league();
    const c = fitShotConversion(fixtures);
    const from = Date.parse(fixtures[300].date), to = Date.parse(fixtures[fixtures.length - 1].date) + 1;
    const a = await walkForwardRows(fixtures, from, to, c, 150);
    // Change every result in the last 30 matches: features for those matches must not move.
    const changed = fixtures.map((f, i) => (i >= fixtures.length - 30 ? { ...f, homeGoals: 9, awayGoals: 0, homeSot: 20, awaySot: 0 } : f));
    const b = await walkForwardRows(changed, from, to, c, 150);
    expect(a.x.length).toBe(b.x.length);
    const lastWeek = Math.floor(Date.parse(fixtures[fixtures.length - 30].date) / (7 * 86_400_000)) * 7 * 86_400_000;
    const unaffected = fixtures.filter((f) => Date.parse(f.date) >= from && Date.parse(f.date) < lastWeek).length;
    expect(unaffected).toBeGreaterThan(100);
    for (let i = 0; i < unaffected; i++) expect(JSON.stringify(b.x[i])).toBe(JSON.stringify(a.x[i]));
  }, 60_000);

  it("fits a softmax that favours the stronger side and sums to one", async () => {
    const fixtures = league();
    const c = fitShotConversion(fixtures);
    const rows = await walkForwardRows(fixtures, Date.parse(fixtures[200].date), Date.now(), c, 150);
    expect(fitSoftmax(rows.x.slice(0, 100), rows.y.slice(0, 100))).toBe(null);
    const model = fitSoftmax(rows.x, rows.y);
    expect(model == null).toBe(false);
    const strong = predictSoftmax(model!, [Math.log(2.4), Math.log(0.7), Math.log(2.3), Math.log(0.8)]);
    const weak = predictSoftmax(model!, [Math.log(0.8), Math.log(2.0), Math.log(0.9), Math.log(1.9)]);
    expect(strong.home).toBeGreaterThan(strong.away);
    expect(weak.away).toBeGreaterThan(weak.home);
    expect(strong.home + strong.draw + strong.away).toBeCloseTo(1, 9);
  }, 60_000);

  it("blends goal and shot strengths 70/30 in log space for goal markets", () => {
    const l = blendedLambdas([Math.log(2), Math.log(1), Math.log(1), Math.log(2)]);
    expect(l.home).toBeCloseTo(Math.pow(2, 0.7), 9);
    expect(l.away).toBeCloseTo(Math.pow(2, 0.3), 9);
  });

  it("parses API-Football fixture statistics, null when missing", () => {
    const f: any = {
      teams: { home: { id: 5 }, away: { id: 6 } },
      statistics: [
        { team: { id: 6 }, statistics: [{ type: "Total Shots", value: 9 }, { type: "Shots on Goal", value: 3 }, { type: "Corner Kicks", value: null }] },
        { team: { id: 5 }, statistics: [{ type: "Total Shots", value: 15 }, { type: "Shots on Goal", value: 6 }, { type: "expected_goals", value: "1.84" }] },
      ],
    };
    const s = parseFixtureStatistics(f);
    expect(s.homeShots).toBe(15);
    expect(s.awaySot).toBe(3);
    expect(s.homeXg).toBe(1.84);
    expect(s.awayCorners).toBe(null);
    expect(parseFixtureStatistics({ teams: f.teams } as any).homeShots).toBe(null);
  });
});
