import { describe, expect, it } from "vitest";
import { dixonColesMarkets, dixonColesOutcomes, expectedGoalsFromRatings, fitTeamRatings, shrinkTowardPriors, type RatingMatch } from "../teamRatings";
import { applyCalibration, brier, fitCalibration, IDENTITY_CALIBRATION } from "../outcomeCalibration";

// Deterministic pseudo-random numbers so the synthetic league is identical every run.
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function poissonSample(lambda: number, u: () => number) {
  let k = 0, p = Math.exp(-lambda), cdf = p;
  const x = u();
  while (x > cdf && k < 15) { k++; p *= lambda / k; cdf += p; }
  return k;
}

const TRUE_ATTACK: Record<string, number> = { A: 0.45, B: 0.2, C: 0, D: -0.15, E: -0.25, F: -0.25 };
const TRUE_DEFENCE: Record<string, number> = { A: 0.35, B: 0.15, C: 0, D: -0.1, E: -0.2, F: -0.2 };

function syntheticLeague(seasons = 4): RatingMatch[] {
  const u = rng(7);
  const teams = Object.keys(TRUE_ATTACK);
  const out: RatingMatch[] = [];
  let day = Date.parse("2023-08-01");
  for (let s = 0; s < seasons; s++) {
    for (const h of teams) for (const a of teams) {
      if (h === a) continue;
      const lh = Math.exp(Math.log(1.1) + 0.25 + TRUE_ATTACK[h] - TRUE_DEFENCE[a]);
      const la = Math.exp(Math.log(1.1) + TRUE_ATTACK[a] - TRUE_DEFENCE[h]);
      out.push({ home: h, away: a, homeGoals: poissonSample(lh, u), awayGoals: poissonSample(la, u), date: new Date(day).toISOString() });
      day += 2 * 86_400_000;
    }
  }
  return out;
}

describe("fitted team ratings (plan step 2)", () => {
  const matches = syntheticLeague();
  const asOf = Date.parse(matches.at(-1)!.date as string) + 86_400_000;
  const fit = fitTeamRatings(matches, asOf, { halfLifeDays: 10_000, maxAgeDays: 10_000 });

  it("ranks teams in their true order of strength", () => {
    const strength = (t: string) => fit.teams.get(t)!.attack + fit.teams.get(t)!.defence;
    expect(strength("A")).toBeGreaterThan(strength("B"));
    expect(strength("B")).toBeGreaterThan(strength("D"));
    expect(strength("D")).toBeGreaterThan(strength("F") - 0.15);
  });

  it("recovers a home advantage close to the simulated one", () => {
    // A long sample: over a few seasons the observed home edge is mostly luck.
    const long = syntheticLeague(40);
    const longFit = fitTeamRatings(long, Date.parse(long.at(-1)!.date as string) + 86_400_000, { halfLifeDays: 1e6, maxAgeDays: 1e6 });
    expect(Math.exp(longFit.homeAdvantage)).toBeGreaterThan(1.2);
    expect(Math.exp(longFit.homeAdvantage)).toBeLessThan(1.38);
  });

  it("never uses matches played on or after the forecast date", () => {
    const cutoff = Date.parse(matches[40].date as string);
    const early = fitTeamRatings(matches, cutoff);
    expect(early.matchesUsed).toBe(40);
  });

  it("gives an unseen team a below-average rating instead of failing", () => {
    const xg = expectedGoalsFromRatings(fit, "Newcomer", "C");
    expect(xg.homeKnown).toBe(false);
    expect(Number.isFinite(xg.home) && xg.home > 0).toBe(true);
  });

  it("pulls teams with little data toward average", () => {
    const thin = fitTeamRatings(matches.slice(0, 6), asOf, { priorMatches: 8 });
    for (const t of thin.teams.values()) expect(Math.abs(t.attack)).toBeLessThan(0.5);
  });
});

describe("score grid and shrinkage", () => {
  it("returns home/draw/away probabilities that sum to 1", () => {
    const p = dixonColesOutcomes(1.6, 1.1);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 6);
    expect(p.home).toBeGreaterThan(p.away);
  });

  it("gives goal markets from the same grid as the 1X2 numbers", () => {
    const o = dixonColesOutcomes(1.6, 1.1);
    const m = dixonColesMarkets(1.6, 1.1);
    expect(m.over25).toBeCloseTo(o.over25 * 100, 1);
    expect(m.btts).toBeCloseTo(o.btts * 100, 1);
    expect(m.over15).toBeGreaterThan(m.over25);
    expect(m.over25).toBeGreaterThan(m.over35);
    expect(m.correctScores.length).toBe(6);
  });

  it("shrinks toward league base rates, not 33/33/33 (plan step 1)", () => {
    const priors = { home: 0.46, draw: 0.25, away: 0.29 };
    const s = shrinkTowardPriors({ home: 0.2, draw: 0.3, away: 0.5 }, priors, 1);
    expect(s.home).toBeCloseTo(0.46, 6);
    expect(s.draw).toBeCloseTo(0.25, 6);
  });
});

describe("three-way calibration (plan step 4)", () => {
  it("leaves a model alone when there is too little evidence", () => {
    expect(fitCalibration([])).toEqual({ ...IDENTITY_CALIBRATION, samples: 0 });
  });

  it("sharpens forecasts that are systematically too flat", () => {
    const u = rng(11);
    const samples = Array.from({ length: 1500 }, () => {
      const trueHome = 0.25 + 0.5 * u();
      const truth = { home: trueHome, draw: 0.25, away: 0.75 - trueHome };
      const flat = { home: 0.5 * truth.home + 0.5 / 3, draw: 0.5 * truth.draw + 0.5 / 3, away: 0.5 * truth.away + 0.5 / 3 };
      const x = u();
      const actual = (x < truth.home ? "home" : x < truth.home + truth.draw ? "draw" : "away") as "home" | "draw" | "away";
      return { probs: flat, actual };
    });
    const c = fitCalibration(samples);
    expect(c.temperature).toBeGreaterThan(1);
    const before = samples.reduce((s, x) => s + brier(x.probs, x.actual), 0);
    const after = samples.reduce((s, x) => s + brier(applyCalibration(x.probs, c), x.actual), 0);
    expect(after).toBeLessThan(before);
  });
});
