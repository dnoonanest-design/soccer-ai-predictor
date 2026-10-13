/**
 * Shots-aware stacking model (challenger step 7).
 *
 * Tested on 5,243 real matches (top-5 leagues, 2023-24 to 2025-26, walk
 * forward): of all the wider stats tried (shots, corners, fouls, cards,
 * referees, rest days, fixture congestion, league position), only shots added
 * a reliable signal. A softmax regression on four numbers,
 *
 *   log λ_home, log λ_away            from ratings fitted on goals
 *   log λ_home_shots, log λ_away_shots from ratings fitted on shot-based
 *                                      expected goals (a × on target + b × off target)
 *
 * improved Brier by 0.0033 over goals-only ratings (t = 3.35).
 *
 * Pure functions only: deterministic, no I/O.
 */
import { expectedGoalsFromRatings, fitTeamRatings, type FittedRatings, type RatingMatch } from "./teamRatings";

export type StatFixture = {
  id: number;
  leagueId: number;
  date: string;
  home: number;
  away: number;
  homeGoals: number;
  awayGoals: number;
  homeShots: number | null;
  awayShots: number | null;
  homeSot: number | null;
  awaySot: number | null;
};

export type Conversion = { onTarget: number; offTarget: number };
export const DEFAULT_CONVERSION: Conversion = { onTarget: 0.32, offTarget: 0 };

const hasShots = (f: StatFixture) =>
  f.homeShots != null && f.awayShots != null && f.homeSot != null && f.awaySot != null;

/** Goals ≈ a × shots on target + b × other shots, by least squares (2 unknowns). */
export function fitShotConversion(fixtures: StatFixture[]): Conversion {
  let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0, n = 0;
  for (const f of fixtures) {
    if (!hasShots(f)) continue;
    for (const [g, sh, sot] of [[f.homeGoals, f.homeShots!, f.homeSot!], [f.awayGoals, f.awayShots!, f.awaySot!]]) {
      const x1 = sot, x2 = Math.max(0, sh - sot);
      s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; t1 += x1 * g; t2 += x2 * g; n++;
    }
  }
  const det = s11 * s22 - s12 * s12;
  if (n < 200 || Math.abs(det) < 1e-9) return DEFAULT_CONVERSION;
  const a = (t1 * s22 - t2 * s12) / det, b = (s11 * t2 - s12 * t1) / det;
  return { onTarget: Math.max(0.15, Math.min(0.5, a)), offTarget: Math.max(-0.05, Math.min(0.1, b)) };
}

export function shotRows(fixtures: StatFixture[], c: Conversion): RatingMatch[] {
  return fixtures.filter(hasShots).map((f) => ({
    home: String(f.home), away: String(f.away), date: f.date,
    homeGoals: Math.max(0, c.onTarget * f.homeSot! + c.offTarget * (f.homeShots! - f.homeSot!)),
    awayGoals: Math.max(0, c.onTarget * f.awaySot! + c.offTarget * (f.awayShots! - f.awaySot!)),
  }));
}

export function goalRows(fixtures: StatFixture[]): RatingMatch[] {
  return fixtures.map((f) => ({ home: String(f.home), away: String(f.away), date: f.date, homeGoals: f.homeGoals, awayGoals: f.awayGoals }));
}

/** The four model inputs for one fixture. */
export function stackFeatures(goals: FittedRatings, shots: FittedRatings, home: number, away: number): number[] {
  const g = expectedGoalsFromRatings(goals, String(home), String(away));
  const s = expectedGoalsFromRatings(shots, String(home), String(away));
  return [Math.log(g.home), Math.log(g.away), Math.log(s.home), Math.log(s.away)];
}

export type Outcome3 = 0 | 1 | 2; // home, draw, away
export const outcomeOf = (f: { homeGoals: number; awayGoals: number }): Outcome3 =>
  f.homeGoals > f.awayGoals ? 0 : f.homeGoals === f.awayGoals ? 1 : 2;

const WEEK_MS = 7 * 86_400_000;

/**
 * Walk-forward training rows for one league: for each week, ratings are
 * fitted only on matches before that week, then used to describe that week's
 * matches. No row ever sees its own result.
 */
export async function walkForwardRows(
  fixtures: StatFixture[],
  fromMs: number,
  toMs: number,
  conversion: Conversion,
  minHistory = 150,
  yieldEvery?: () => Promise<void>,
): Promise<{ x: number[][]; y: Outcome3[] }> {
  const sorted = [...fixtures].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const x: number[][] = [], y: Outcome3[] = [];
  const allGoals = goalRows(sorted), allShots = shotRows(sorted, conversion);
  for (let week = Math.floor(fromMs / WEEK_MS) * WEEK_MS; week < toMs; week += WEEK_MS) {
    const inWeek = sorted.filter((f) => { const t = Date.parse(f.date); return t >= week && t < week + WEEK_MS && hasShots(f); });
    if (!inWeek.length) continue;
    const prior = allGoals.filter((r) => Date.parse(String(r.date)) < week);
    const priorShots = allShots.filter((r) => Date.parse(String(r.date)) < week);
    if (prior.length < minHistory || priorShots.length < minHistory) continue;
    const g = fitTeamRatings(prior, week), s = fitTeamRatings(priorShots, week);
    for (const f of inWeek) { x.push(stackFeatures(g, s, f.home, f.away)); y.push(outcomeOf(f)); }
    if (yieldEvery) await yieldEvery();
  }
  return { x, y };
}

// ── Softmax (multinomial logistic) regression with L2 ───────────────────────

export type SoftmaxModel = { mean: number[]; std: number[]; w: number[][]; b: number[]; samples: number };

export function fitSoftmax(x: number[][], y: Outcome3[], l2 = 1e-3, iterations = 600, rate = 0.5): SoftmaxModel | null {
  const n = x.length;
  if (n < 300) return null;
  const k = x[0].length;
  const mean = Array.from({ length: k }, (_, j) => x.reduce((s, r) => s + r[j], 0) / n);
  const std = Array.from({ length: k }, (_, j) => Math.sqrt(x.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / n) || 1);
  const z = x.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
  const w = [0, 1, 2].map(() => new Array(k).fill(0));
  const counts = [0, 0, 0]; for (const c of y) counts[c]++;
  const b = counts.map((c) => Math.log((c + 1) / (n + 3)));
  for (let it = 0; it < iterations; it++) {
    const gw = [0, 1, 2].map(() => new Array(k).fill(0)), gb = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = softmaxRow(z[i], w, b);
      for (let c = 0; c < 3; c++) {
        const err = p[c] - (y[i] === c ? 1 : 0);
        gb[c] += err / n;
        for (let j = 0; j < k; j++) gw[c][j] += (err * z[i][j]) / n;
      }
    }
    for (let c = 0; c < 3; c++) {
      b[c] -= rate * gb[c];
      for (let j = 0; j < k; j++) w[c][j] -= rate * (gw[c][j] + l2 * w[c][j]);
    }
  }
  return { mean, std, w, b, samples: n };
}

function softmaxRow(z: number[], w: number[][], b: number[]): number[] {
  const s = [0, 1, 2].map((c) => b[c] + w[c].reduce((acc, wj, j) => acc + wj * z[j], 0));
  const m = Math.max(...s);
  const e = s.map((v) => Math.exp(v - m));
  const t = e[0] + e[1] + e[2];
  return e.map((v) => v / t);
}

export function predictSoftmax(model: SoftmaxModel, features: number[]): { home: number; draw: number; away: number } {
  const z = features.map((v, j) => (v - model.mean[j]) / model.std[j]);
  const [home, draw, away] = softmaxRow(z, model.w, model.b);
  return { home, draw, away };
}

/** Goal-market strengths: 70% goals, 30% shots (log-linear), which improved over/under and BTTS in testing. */
export function blendedLambdas(features: number[]): { home: number; away: number } {
  return { home: Math.exp(0.7 * features[0] + 0.3 * features[2]), away: Math.exp(0.7 * features[1] + 0.3 * features[3]) };
}
