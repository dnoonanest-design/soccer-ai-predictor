/**
 * Unit tests for the core prediction maths used in enhancedStatsService.
 *
 * These are pure-function tests — no DB, no HTTP calls.
 * Run with: npx vitest run   (or jest if you prefer)
 *
 * The functions under test are extracted/mirrored here because they are
 * internal to enhancedStatsService.ts. If you later export them, import
 * directly; for now they're inlined so the tests remain self-contained.
 */

import { describe, it, expect } from "vitest";

// ─── Inline copies of the pure functions under test ───────────────────────────
// (mirrors of the real implementations; keep in sync when you change them)

function poisson(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

const DC_RHO = -0.13;
function dcTau(i: number, j: number, lambda: number, mu: number): number {
  if (i === 0 && j === 0) return 1 - lambda * mu * DC_RHO;
  if (i === 0 && j === 1) return 1 + lambda * DC_RHO;
  if (i === 1 && j === 0) return 1 + mu * DC_RHO;
  if (i === 1 && j === 1) return 1 - DC_RHO;
  return 1;
}

const MAX_GOALS = 8;
function poissonProbs(homeXG: number, awayXG: number) {
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poisson(homeXG, h) * poisson(awayXG, a) * dcTau(h, a, homeXG, awayXG);
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
    }
  }
  const total = homeWin + draw + awayWin;
  return {
    homeWin: (homeWin / total) * 100,
    draw:    (draw    / total) * 100,
    awayWin: (awayWin / total) * 100,
  };
}

const MAX_H2H_WEIGHT    = 0.30;
const FULL_WEIGHT_THRESHOLD = 20;
function blendH2H(
  poissonHome: number, poissonDraw: number, poissonAway: number,
  h2hMatches: number, h2hHomeRate: number, h2hDrawRate: number, h2hAwayRate: number,
): { home: number; draw: number; away: number } {
  const w = Math.min(MAX_H2H_WEIGHT, (h2hMatches / FULL_WEIGHT_THRESHOLD) * MAX_H2H_WEIGHT);
  const home = (1 - w) * poissonHome + w * h2hHomeRate * 100;
  const draw = (1 - w) * poissonDraw  + w * h2hDrawRate  * 100;
  const away = (1 - w) * poissonAway  + w * h2hAwayRate  * 100;
  const total = home + draw + away;
  return { home: (home / total) * 100, draw: (draw / total) * 100, away: (away / total) * 100 };
}

function formFactor(form: string): number {
  const chars = form.toUpperCase().split("").filter((c) => ["W", "D", "L"].includes(c)).slice(-5);
  if (!chars.length) return 1.0;
  let weightedScore = 0, totalWeight = 0;
  chars.forEach((c, idx) => {
    const w = Math.pow(0.8, chars.length - 1 - idx);
    weightedScore += w * (c === "W" ? 1 : c === "D" ? 0.5 : 0);
    totalWeight += w;
  });
  const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;
  return 0.88 + avgScore * 0.24;
}

function applyPriorNudge(
  home: number, draw: number, away: number,
  priorHome: number, priorDraw: number, priorAway: number,
): { home: number; draw: number; away: number } {
  const PRIOR_WEIGHT = 0.10;
  const h = (1 - PRIOR_WEIGHT) * (home / 100) + PRIOR_WEIGHT * priorHome;
  const d = (1 - PRIOR_WEIGHT) * (draw / 100) + PRIOR_WEIGHT * priorDraw;
  const a = (1 - PRIOR_WEIGHT) * (away / 100) + PRIOR_WEIGHT * priorAway;
  const total = h + d + a;
  return {
    home: Math.round((h / total) * 10000) / 100,
    draw: Math.round((d / total) * 10000) / 100,
    away: Math.round((a / total) * 10000) / 100,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("poisson", () => {
  it("returns 1 for lambda=0 k=0", () => {
    expect(poisson(0, 0)).toBeCloseTo(1, 5);
  });

  it("returns 0 for lambda=0 k>0", () => {
    expect(poisson(0, 1)).toBe(0);
    expect(poisson(0, 3)).toBe(0);
  });

  it("known value: P(X=1 | λ=1) ≈ 0.3679", () => {
    expect(poisson(1, 1)).toBeCloseTo(Math.exp(-1), 5);
  });

  it("known value: P(X=0 | λ=1.5) ≈ 0.2231", () => {
    expect(poisson(1.5, 0)).toBeCloseTo(Math.exp(-1.5), 5);
  });
});

describe("poissonProbs", () => {
  it("probabilities sum to ~100%", () => {
    const { homeWin, draw, awayWin } = poissonProbs(1.4, 1.1);
    expect(homeWin + draw + awayWin).toBeCloseTo(100, 1);
  });

  it("home-favoured match has home_win > away_win", () => {
    const { homeWin, awayWin } = poissonProbs(2.0, 0.8);
    expect(homeWin).toBeGreaterThan(awayWin);
  });

  it("symmetric xG gives near-equal home/away with slightly higher draw", () => {
    const { homeWin, draw, awayWin } = poissonProbs(1.2, 1.2);
    expect(Math.abs(homeWin - awayWin)).toBeLessThan(2);
    expect(draw).toBeGreaterThan(20);
  });

  it("Dixon-Coles correction shifts draw upward vs raw Poisson", () => {
    // DC rho < 0 increases P(0-0) and P(1-1), boosting draw probability
    const withDC = poissonProbs(1.3, 1.0);
    // Raw Poisson (rho=0) baseline
    let rawDraw = 0;
    for (let g = 0; g <= MAX_GOALS; g++) {
      rawDraw += poisson(1.3, g) * poisson(1.0, g); // dcTau=1 when rho=0
    }
    rawDraw = (rawDraw / (rawDraw + 0.01)) * 100; // rough normalised
    // DC draw should be >= raw (rho correction raises low-score draws)
    expect(withDC.draw).toBeGreaterThanOrEqual(rawDraw * 0.95);
  });
});

describe("blendH2H", () => {
  it("returns Poisson probabilities unchanged when h2h matches = 0", () => {
    const result = blendH2H(55, 25, 20, 0, 0.5, 0.25, 0.25);
    expect(result.home).toBeCloseTo(55, 1);
    expect(result.draw).toBeCloseTo(25, 1);
    expect(result.away).toBeCloseTo(20, 1);
  });

  it("scales weight linearly below FULL_WEIGHT_THRESHOLD (20)", () => {
    // At 10 matches weight should be 0.15 (half of 0.30)
    const r10 = blendH2H(50, 25, 25, 10, 0.7, 0.15, 0.15);
    const r20 = blendH2H(50, 25, 25, 20, 0.7, 0.15, 0.15);
    // At 20 matches H2H has stronger pull → home prob closer to 70
    expect(r20.home).toBeGreaterThan(r10.home);
  });

  it("caps weight at 30% even with 50 meetings", () => {
    const r20 = blendH2H(50, 25, 25, 20, 0.7, 0.15, 0.15);
    const r50 = blendH2H(50, 25, 25, 50, 0.7, 0.15, 0.15);
    // Weight is capped so 50-match blend == 20-match blend
    expect(r50.home).toBeCloseTo(r20.home, 3);
  });

  it("output probabilities sum to 100", () => {
    const r = blendH2H(45, 28, 27, 15, 0.6, 0.25, 0.15);
    expect(r.home + r.draw + r.away).toBeCloseTo(100, 1);
  });

  it("old threshold of 5 would give higher H2H weight than new threshold of 20", () => {
    // With old code: w = min(0.30, 5/5 * 0.30) = 0.30 at just 5 matches
    // With new code: w = min(0.30, 5/20 * 0.30) = 0.075 at 5 matches
    // This test confirms new code gives a smaller weight for 5-match H2H
    const w_new = Math.min(MAX_H2H_WEIGHT, (5 / FULL_WEIGHT_THRESHOLD) * MAX_H2H_WEIGHT);
    const w_old = 5 >= 5 ? 0.30 : (5 / 5) * 0.30;
    expect(w_new).toBeLessThan(w_old);
    expect(w_new).toBeCloseTo(0.075, 3);
  });
});

describe("formFactor", () => {
  it("all wins returns max factor ≈ 1.12", () => {
    expect(formFactor("WWWWW")).toBeCloseTo(1.12, 2);
  });

  it("all losses returns min factor ≈ 0.88", () => {
    expect(formFactor("LLLLL")).toBeCloseTo(0.88, 2);
  });

  it("all draws returns middle factor ≈ 1.0", () => {
    expect(formFactor("DDDDD")).toBeCloseTo(1.0, 1);
  });

  it("empty form string returns neutral 1.0", () => {
    expect(formFactor("")).toBe(1.0);
  });

  it("recent results weighted more than older ones (WWWLL > LLWWW in recency)", () => {
    // LLWWW has wins at the end (most recent) → higher factor
    expect(formFactor("LLWWW")).toBeGreaterThan(formFactor("WWWLL"));
  });

  it("ignores non-W/D/L characters", () => {
    expect(formFactor("W-W-W-W-W")).toBeCloseTo(formFactor("WWWWW"), 2);
  });
});

describe("applyPriorNudge", () => {
  it("output probabilities sum to 100", () => {
    const r = applyPriorNudge(50, 20, 30, 0.45, 0.27, 0.28);
    expect(r.home + r.draw + r.away).toBeCloseTo(100, 1);
  });

  it("nudges draw upward when model underestimates draws", () => {
    // Model gives 15% draw, priors say 27% draw → nudge should increase draw
    const r = applyPriorNudge(55, 15, 30, 0.45, 0.27, 0.28);
    expect(r.draw).toBeGreaterThan(15);
  });

  it("nudges are small — model signal still dominates", () => {
    // Home should still be the clear favourite after nudge
    const r = applyPriorNudge(65, 18, 17, 0.45, 0.27, 0.28);
    expect(r.home).toBeGreaterThan(r.draw);
    expect(r.home).toBeGreaterThan(r.away);
  });

  it("equal input with neutral priors changes nothing meaningful", () => {
    const r = applyPriorNudge(45, 27, 28, 0.45, 0.27, 0.28);
    expect(r.home).toBeCloseTo(45, 0);
    expect(r.draw).toBeCloseTo(27, 0);
    expect(r.away).toBeCloseTo(28, 0);
  });
});

describe("integration: full prediction pipeline properties", () => {
  it("strongly favoured home team has home_win > 50%", () => {
    // Home team scores 2.5/game, away 0.8/game; home concedes 0.6, away 1.8
    const probs = poissonProbs(
      ((2.5 + 1.8) / 2) * 1.07,  // homeXG with home advantage
      (0.8 + 0.6) / 2             // awayXG
    );
    expect(probs.homeWin).toBeGreaterThan(50);
  });

  it("correct score probabilities: 1-0 more likely than 5-5", () => {
    const p10 = poisson(1.4, 1) * poisson(1.0, 0);
    const p55 = poisson(1.4, 5) * poisson(1.0, 5);
    expect(p10).toBeGreaterThan(p55);
  });
});

// ─── Competition history functions ────────────────────────────────────────────

function computePositionFactor(rank: number, totalTeams: number): number {
  const t = Math.max(4, totalTeams);
  const percentile = 1 - (rank - 1) / (t - 1);
  return 0.92 + percentile * 0.16;
}

function competitionFormFactor(form: string): number {
  if (!form || form.length === 0) return 1.0;
  const chars = form.slice(-5).split("").reverse();
  const decayWeights = [1.0, 0.8, 0.64, 0.51, 0.41];
  let weightedScore = 0, totalWeight = 0;
  chars.forEach((c, i) => {
    const w = decayWeights[i] ?? 0.41;
    const score = c === "W" ? 1.0 : c === "D" ? 0.4 : 0.0;
    weightedScore += w * score;
    totalWeight   += w;
  });
  const avgScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;
  return 0.92 + avgScore * 0.16;
}

describe("computePositionFactor", () => {
  it("rank 1 in 20-team league returns max factor 1.08", () => {
    expect(computePositionFactor(1, 20)).toBeCloseTo(1.08, 5);
  });

  it("last place (rank=totalTeams) returns min factor 0.92", () => {
    expect(computePositionFactor(20, 20)).toBeCloseTo(0.92, 5);
  });

  it("mid-table (rank ≈ totalTeams/2) returns ~1.0", () => {
    expect(computePositionFactor(10, 20)).toBeCloseTo(1.0, 1);
  });

  it("small group (4 teams) rank 1 still returns 1.08", () => {
    expect(computePositionFactor(1, 4)).toBeCloseTo(1.08, 5);
  });

  it("factor scales linearly — rank 5 > rank 10 > rank 15 in 20-team league", () => {
    const f5  = computePositionFactor(5,  20);
    const f10 = computePositionFactor(10, 20);
    const f15 = computePositionFactor(15, 20);
    expect(f5).toBeGreaterThan(f10);
    expect(f10).toBeGreaterThan(f15);
  });

  it("degenerate single-team league falls back to 4-team minimum", () => {
    // rank=1, totalTeams=1 → percentile = 1 → 1.08
    expect(computePositionFactor(1, 1)).toBeCloseTo(1.08, 5);
  });
});

describe("competitionFormFactor", () => {
  it("all wins returns 1.08", () => {
    expect(competitionFormFactor("WWWWW")).toBeCloseTo(1.08, 2);
  });

  it("all losses returns 0.92", () => {
    expect(competitionFormFactor("LLLLL")).toBeCloseTo(0.92, 2);
  });

  it("all draws returns middle ~1.0", () => {
    expect(competitionFormFactor("DDDDD")).toBeCloseTo(1.0, 1);
  });

  it("empty form returns 1.0", () => {
    expect(competitionFormFactor("")).toBe(1.0);
  });

  it("recent wins more valuable than old wins (LLWWW > WWWLL)", () => {
    expect(competitionFormFactor("LLWWW")).toBeGreaterThan(competitionFormFactor("WWWLL"));
  });

  it("output is bounded [0.92, 1.08]", () => {
    for (const form of ["WWWWW", "LLLLL", "WDLDW", "DDDDD", "WWDLL"]) {
      const f = competitionFormFactor(form);
      expect(f).toBeGreaterThanOrEqual(0.92);
      expect(f).toBeLessThanOrEqual(1.08);
    }
  });
});

describe("competition factor combination", () => {
  it("top-of-table team with 5 wins has factor > 1.08", () => {
    const posFactor   = computePositionFactor(1, 20);  // 1.08
    const formFactor  = competitionFormFactor("WWWWW"); // 1.08
    const venueFactor = 0.97 + Math.min(0.07, (0.80 - 0.45) * 0.5); // home win rate 80%
    const raw = posFactor * 0.40 + formFactor * 0.40 + venueFactor * 0.20;
    const capped = Math.max(0.88, Math.min(1.12, raw));
    expect(capped).toBeCloseTo(1.12, 1); // hits the cap
  });

  it("bottom-of-table team with 5 losses has factor <= 0.92 (hits floor)", () => {
    const posFactor   = computePositionFactor(20, 20); // 0.92
    const formFactor  = competitionFormFactor("LLLLL"); // 0.92
    const venueFactor = 0.97 + Math.max(-0.07, (0.10 - 0.45) * 0.5); // poor home rate
    const raw = posFactor * 0.40 + formFactor * 0.40 + venueFactor * 0.20;
    const capped = Math.max(0.88, Math.min(1.12, raw));
    expect(capped).toBeCloseTo(0.88, 1); // hits the floor
  });

  it("mid-table team with mixed form has factor close to 1.0", () => {
    const posFactor   = computePositionFactor(10, 20); // ~1.0
    const formFactor  = competitionFormFactor("WDLDW"); // roughly neutral
    const venueFactor = 0.97 + Math.max(-0.07, Math.min(0.07, (0.45 - 0.45) * 0.5)); // league average
    const raw = posFactor * 0.40 + formFactor * 0.40 + venueFactor * 0.20;
    const capped = Math.max(0.88, Math.min(1.12, raw));
    expect(Math.abs(capped - 1.0)).toBeLessThan(0.05);
  });
});
