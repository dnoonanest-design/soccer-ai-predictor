/**
 * Step 9: team-strength model (pattern audit, 25 Oct 2026).
 *
 * Six ratings per team, each updated after every match in kickoff order and
 * adjusted for the opponent: results (Elo with margin of victory), goals, a
 * 70/30 xG/goals blend, shots on target, shots and corners. Each per-league
 * scoring model learns its own home advantage and applies it to BOTH sides
 * (home up, away down), which fixes the formula's home under-rating.
 *
 * A multinomial logistic model turns the rating gaps (plus a head-to-head draw
 * tendency for pairs with 5+ meetings and a UEFA-competition flag, which
 * carries the lower European draw rate) into home/draw/away chances. Goal
 * markets come from the xG rating's expected goals: over 2.5 and BTTS are
 * calibrated against each league's recent rate, and correct scores use the
 * Dixon-Coles low-score correction.
 *
 * Walk-forward backtest (13,163 matches, Jul 2025 - Oct 2026, refitted
 * monthly): Brier 0.604 against 0.630 for the original formula. Every feature
 * is computed from matches that kicked off before the one it describes.
 * Nothing here reads bookmaker odds or any generative-AI output.
 */
import { pool } from "@workspace/db";
import { dixonColesMarkets } from "./teamRatings";
import { logger } from "./logger";

export type StrengthRow = {
  fixtureId: number; leagueId: number; kickoff: number;
  home: number; away: number; homeGoals: number; awayGoals: number;
  homeShots: number | null; awayShots: number | null;
  homeShotsOnTarget: number | null; awayShotsOnTarget: number | null;
  homeCorners: number | null; awayCorners: number | null;
  homeXg: number | null; awayXg: number | null;
};

type Unit = { home: number; draw: number; away: number };
type Outcome = 0 | 1 | 2;

export const UEFA_LEAGUES = new Set([2, 3, 848]);
export const STRENGTH_FEATURES = ["elo", "gD", "gT", "xD", "xT", "sotD", "shD", "shT", "coD", "h2hDraw", "uefa"] as const;
const MIN_TEAM_MATCHES = 5;
const H2H_MIN_MEETINGS = 5;
const H2H_NEUTRAL_DRAW = 0.25;
const LEARNING_RATE = 0.03;
const TRAINING_YEARS = 4;

// ── Rating systems ───────────────────────────────────────────────────────────

class EloRatings {
  private readonly r = new Map<number, number>();
  private readonly k: number;
  private readonly homeEdge: number;
  constructor(k = 20, homeEdge = 60) { this.k = k; this.homeEdge = homeEdge; }
  get(team: number) { return this.r.get(team) ?? 1450; }
  diff(home: number, away: number) { return this.get(home) + this.homeEdge - this.get(away); }
  update(home: number, away: number, hg: number, ag: number) {
    const expected = 1 / (1 + Math.pow(10, -this.diff(home, away) / 400));
    const score = hg > ag ? 1 : hg === ag ? 0.5 : 0;
    const margin = Math.abs(hg - ag);
    const mult = margin <= 1 ? 1 : Math.log(margin + 1) * 1.45;
    const delta = this.k * mult * (score - expected);
    this.r.set(home, this.get(home) + delta);
    this.r.set(away, this.get(away) - delta);
  }
}

/** Online Poisson attack/defence ratings with a per-league level and home advantage. */
class OnlineRates {
  private readonly att = new Map<number, number>();
  private readonly def = new Map<number, number>();
  private readonly mu = new Map<number, number>();
  private readonly ha = new Map<number, number>();
  private readonly base: number;
  private readonly lr: number;
  constructor(base: number, lr = LEARNING_RATE) { this.base = base; this.lr = lr; }
  lambdas(league: number, home: number, away: number): [number, number] {
    const mu = this.mu.get(league) ?? this.base;
    const ha = this.ha.get(league) ?? 0.2;
    // Half the home edge raises the home rate and half lowers the away rate.
    return [
      Math.exp(mu + ha / 2 + (this.att.get(home) ?? -0.1) - (this.def.get(away) ?? -0.1)),
      Math.exp(mu - ha / 2 + (this.att.get(away) ?? -0.1) - (this.def.get(home) ?? -0.1)),
    ];
  }
  homeAdvantage(league: number) { return Math.exp(this.ha.get(league) ?? 0.2); }
  update(league: number, home: number, away: number, yh: number, ya: number) {
    const [lh, la] = this.lambdas(league, home, away);
    const eh = Math.max(-3, Math.min(3, yh - lh)), ea = Math.max(-3, Math.min(3, ya - la));
    this.att.set(home, (this.att.get(home) ?? -0.1) + this.lr * eh);
    this.def.set(away, (this.def.get(away) ?? -0.1) - this.lr * eh);
    this.att.set(away, (this.att.get(away) ?? -0.1) + this.lr * ea);
    this.def.set(home, (this.def.get(home) ?? -0.1) - this.lr * ea);
    this.mu.set(league, (this.mu.get(league) ?? this.base) + 0.002 * (eh + ea));
    // Slow on purpose: a league's home edge should reflect a season or two, not the last few rounds.
    this.ha.set(league, (this.ha.get(league) ?? 0.2) + 0.0015 * (eh - ea));
  }
}

const L = (x: number) => Math.log(Math.max(1e-4, x));
const logit = (p: number) => { const q = Math.max(1e-4, Math.min(1 - 1e-4, p)); return Math.log(q / (1 - q)); };
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function poissonPmf(lambda: number, k: number) { let p = Math.exp(-lambda); for (let i = 1; i <= k; i++) p *= lambda / i; return p; }
export function rawOver25(lh: number, la: number) {
  let under = 0;
  for (let i = 0; i <= 2; i++) for (let j = 0; i + j <= 2; j++) under += poissonPmf(lh, i) * poissonPmf(la, j);
  return 1 - under;
}
export function rawBtts(lh: number, la: number) { return (1 - Math.exp(-lh)) * (1 - Math.exp(-la)); }

/** Everything the ratings know at one moment; advanced one match at a time. */
export class StrengthState {
  private readonly elo = new EloRatings();
  private readonly goals = new OnlineRates(0.25);
  private readonly xg = new OnlineRates(0.25);
  private readonly sot = new OnlineRates(-0.3);
  private readonly shots = new OnlineRates(1.0);
  private readonly corners = new OnlineRates(0.4);
  private readonly played = new Map<number, number>();
  private readonly meetings = new Map<string, number[]>(); // 1 = draw, 0 = not
  private readonly leagueOver = new Map<number, number>();
  private readonly leagueBtts = new Map<number, number>();

  matchesPlayed(team: number) { return this.played.get(team) ?? 0; }
  homeAdvantage(league: number) { return this.goals.homeAdvantage(league); }

  features(league: number, home: number, away: number): number[] {
    const [gh, ga] = this.goals.lambdas(league, home, away);
    const [xh, xa] = this.xg.lambdas(league, home, away);
    const [sth, sta] = this.sot.lambdas(league, home, away);
    const [shh, sha] = this.shots.lambdas(league, home, away);
    const [ch, ca] = this.corners.lambdas(league, home, away);
    const past = (this.meetings.get(pairKey(home, away)) ?? []).slice(-6);
    const h2hDraw = past.length >= H2H_MIN_MEETINGS ? past.reduce((s, x) => s + x, 0) / past.length : H2H_NEUTRAL_DRAW;
    return [
      this.elo.diff(home, away) / 400,
      L(gh) - L(ga), L(gh) + L(ga),
      L(xh) - L(xa), L(xh) + L(xa),
      L(sth) - L(sta),
      L(shh) - L(sha), L(shh) + L(sha),
      L(ch) - L(ca),
      h2hDraw,
      UEFA_LEAGUES.has(league) ? 1 : 0,
    ];
  }

  /** Expected goals (xG rating) and each league's recent over 2.5 / BTTS rates. */
  goalInputs(league: number, home: number, away: number) {
    const [lh, la] = this.xg.lambdas(league, home, away);
    return { lh, la, leagueOver: this.leagueOver.get(league) ?? 0.55, leagueBtts: this.leagueBtts.get(league) ?? 0.52 };
  }

  apply(r: StrengthRow) {
    this.elo.update(r.home, r.away, r.homeGoals, r.awayGoals);
    this.goals.update(r.leagueId, r.home, r.away, r.homeGoals, r.awayGoals);
    this.xg.update(r.leagueId, r.home, r.away,
      r.homeXg != null ? 0.7 * r.homeXg + 0.3 * r.homeGoals : r.homeGoals,
      r.awayXg != null ? 0.7 * r.awayXg + 0.3 * r.awayGoals : r.awayGoals);
    if (r.homeShotsOnTarget != null && r.awayShotsOnTarget != null) this.sot.update(r.leagueId, r.home, r.away, r.homeShotsOnTarget / 3, r.awayShotsOnTarget / 3);
    if (r.homeShots != null && r.awayShots != null) this.shots.update(r.leagueId, r.home, r.away, r.homeShots / 3, r.awayShots / 3);
    if (r.homeCorners != null && r.awayCorners != null) this.corners.update(r.leagueId, r.home, r.away, r.homeCorners / 3, r.awayCorners / 3);
    const key = pairKey(r.home, r.away);
    const m = this.meetings.get(key) ?? []; m.push(r.homeGoals === r.awayGoals ? 1 : 0); if (m.length > 12) m.shift(); this.meetings.set(key, m);
    const over = r.homeGoals + r.awayGoals > 2 ? 1 : 0, btts = r.homeGoals > 0 && r.awayGoals > 0 ? 1 : 0;
    this.leagueOver.set(r.leagueId, (this.leagueOver.get(r.leagueId) ?? 0.55) + 0.02 * (over - (this.leagueOver.get(r.leagueId) ?? 0.55)));
    this.leagueBtts.set(r.leagueId, (this.leagueBtts.get(r.leagueId) ?? 0.52) + 0.02 * (btts - (this.leagueBtts.get(r.leagueId) ?? 0.52)));
    this.played.set(r.home, this.matchesPlayed(r.home) + 1);
    this.played.set(r.away, this.matchesPlayed(r.away) + 1);
  }
}

// ── Fitting ──────────────────────────────────────────────────────────────────

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

type Standardiser = { mean: number[]; sd: number[] };
function standardiser(X: number[][]): Standardiser {
  const d = X[0]?.length ?? 0, n = X.length;
  const mean = new Array<number>(d).fill(0), sd = new Array<number>(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  return { mean, sd };
}

export type MultinomialModel = { std: Standardiser; W: number[][]; b: number[] };
export function predictMultinomial(m: MultinomialModel, x: number[]): Unit {
  const z = [0, 1, 2].map((k) => { let s = m.b[k]; for (let j = 0; j < x.length; j++) s += m.W[k][j] * (x[j] - m.std.mean[j]) / m.std.sd[j]; return s; });
  const top = Math.max(z[0], z[1], z[2]);
  const e = z.map((v) => Math.exp(v - top)); const t = e[0] + e[1] + e[2];
  return { home: e[0] / t, draw: e[1] / t, away: e[2] / t };
}

export async function fitMultinomial(X: number[][], y: Outcome[], options: { l2?: number; iterations?: number; learningRate?: number; yieldEvery?: number } = {}): Promise<MultinomialModel> {
  const l2 = options.l2 ?? 2e-3, iterations = options.iterations ?? 300, lr = options.learningRate ?? 0.6, yieldEvery = options.yieldEvery ?? 20;
  const std = standardiser(X); const n = X.length, d = std.mean.length;
  const Z = X.map((x) => x.map((v, j) => (v - std.mean[j]) / std.sd[j]));
  const W = [new Array<number>(d).fill(0), new Array<number>(d).fill(0), new Array<number>(d).fill(0)], b = [0, 0, 0];
  for (let it = 0; it < iterations; it++) {
    const gW = [new Array<number>(d).fill(0), new Array<number>(d).fill(0), new Array<number>(d).fill(0)], gb = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      const s = [0, 1, 2].map((k) => { let v = b[k]; for (let j = 0; j < d; j++) v += W[k][j] * z[j]; return v; });
      const top = Math.max(s[0], s[1], s[2]); const e = s.map((v) => Math.exp(v - top)); const t = e[0] + e[1] + e[2];
      for (let k = 0; k < 3; k++) { const g = (e[k] / t - (y[i] === k ? 1 : 0)) / n; gb[k] += g; for (let j = 0; j < d; j++) gW[k][j] += g * z[j]; }
    }
    for (let k = 0; k < 3; k++) { b[k] -= lr * gb[k]; for (let j = 0; j < d; j++) W[k][j] -= lr * (gW[k][j] + l2 * W[k][j]); }
    if (yieldEvery > 0 && it % yieldEvery === 0) await pause();
  }
  return { std, W, b };
}

export type BinaryModel = { std: Standardiser; w: number[]; b: number };
export function predictBinary(m: BinaryModel, x: number[]) {
  let z = m.b; for (let j = 0; j < x.length; j++) z += m.w[j] * (x[j] - m.std.mean[j]) / m.std.sd[j];
  return sigmoid(z);
}
export function fitBinary(X: number[][], y: number[], iterations = 300, lr = 0.5, l2 = 1e-3): BinaryModel {
  const std = standardiser(X); const n = X.length, d = std.mean.length;
  const Z = X.map((x) => x.map((v, j) => (v - std.mean[j]) / std.sd[j]));
  const w = new Array<number>(d).fill(0); let b = 0;
  for (let it = 0; it < iterations; it++) {
    const gw = new Array<number>(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) { let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j]; const g = (sigmoid(z) - y[i]) / n; gb += g; for (let j = 0; j < d; j++) gw[j] += g * Z[i][j]; }
    b -= lr * gb; for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] + l2 * w[j]);
  }
  return { std, w, b };
}

// ── Model ────────────────────────────────────────────────────────────────────

export type StrengthForecast = {
  probs: Unit;
  lambdas: { home: number; away: number };
  markets: { homeXg: number; awayXg: number; over15: number; over25: number; over35: number; btts: number; correctScores: Array<{ score: string; probability: number }> };
};

export type StrengthModel = {
  trainedAt: number;
  trainingMatches: number;
  latestMatchAt: number | null;
  forecast(leagueId: number, homeTeamId: number, awayTeamId: number): StrengthForecast | null;
};

/** Replay rows in kickoff order, fit the outcome and goal-market models, return a forecaster at the latest state. */
export async function buildStrengthModel(rows: StrengthRow[], now = Date.now(), options: { iterations?: number; yieldEvery?: number } = {}): Promise<StrengthModel | null> {
  const sorted = [...rows].sort((a, b) => a.kickoff - b.kickoff || a.fixtureId - b.fixtureId);
  const state = new StrengthState();
  const cutoff = now - TRAINING_YEARS * 365 * 86_400_000;
  const X: number[][] = [], y: Outcome[] = [], gX: number[][] = [], oY: number[] = [], bX: number[][] = [], bY: number[] = [];
  for (const r of sorted) {
    if (r.kickoff >= now) break;
    const eligible = r.kickoff >= cutoff && state.matchesPlayed(r.home) >= MIN_TEAM_MATCHES && state.matchesPlayed(r.away) >= MIN_TEAM_MATCHES;
    if (eligible) {
      X.push(state.features(r.leagueId, r.home, r.away));
      y.push(r.homeGoals > r.awayGoals ? 0 : r.homeGoals === r.awayGoals ? 1 : 2);
      const g = state.goalInputs(r.leagueId, r.home, r.away);
      gX.push([logit(rawOver25(g.lh, g.la)), logit(g.leagueOver)]); oY.push(r.homeGoals + r.awayGoals > 2 ? 1 : 0);
      bX.push([logit(rawBtts(g.lh, g.la)), logit(g.leagueBtts)]); bY.push(r.homeGoals > 0 && r.awayGoals > 0 ? 1 : 0);
    }
    state.apply(r);
  }
  if (X.length < 500) return null;
  const outcome = await fitMultinomial(X, y, { iterations: options.iterations, yieldEvery: options.yieldEvery });
  const over = fitBinary(gX, oY), btts = fitBinary(bX, bY);
  const latest = sorted.filter((r) => r.kickoff < now).at(-1)?.kickoff ?? null;
  return {
    trainedAt: now,
    trainingMatches: X.length,
    latestMatchAt: latest,
    forecast(leagueId, home, away) {
      if (state.matchesPlayed(home) < MIN_TEAM_MATCHES || state.matchesPlayed(away) < MIN_TEAM_MATCHES) return null;
      const probs = predictMultinomial(outcome, state.features(leagueId, home, away));
      const g = state.goalInputs(leagueId, home, away);
      const grid = dixonColesMarkets(g.lh, g.la);
      const pct = (v: number) => Math.round(v * 10_000) / 100;
      return {
        probs,
        lambdas: { home: g.lh, away: g.la },
        markets: {
          homeXg: Math.round(g.lh * 100) / 100, awayXg: Math.round(g.la * 100) / 100,
          over15: grid.over15, over35: grid.over35, correctScores: grid.correctScores,
          over25: pct(predictBinary(over, [logit(rawOver25(g.lh, g.la)), logit(g.leagueOver)])),
          btts: pct(predictBinary(btts, [logit(rawBtts(g.lh, g.la)), logit(g.leagueBtts)])),
        },
      };
    },
  };
}

// ── Live instance ────────────────────────────────────────────────────────────

const REFRESH_MS = Number(process.env.STRENGTH_MODEL_REFRESH_MS ?? 24 * 60 * 60_000);
let model: StrengthModel | null = null;
let lastAttempt = 0;
let lastError: string | null = null;
let building: Promise<void> | null = null;

export async function loadStrengthRows(): Promise<StrengthRow[]> {
  const result = await pool.query(
    `SELECT fixture_id, league_id, kickoff_at, home_team_id, away_team_id, home_goals, away_goals,
            home_shots, away_shots, home_shots_on_target, away_shots_on_target, home_corners, away_corners, home_xg, away_xg
       FROM fixture_team_stats
      WHERE kickoff_at >= NOW() - INTERVAL '6 years'
      ORDER BY kickoff_at, fixture_id`,
  );
  const n = (v: unknown) => (v == null ? null : Number(v));
  return result.rows.map((x: any) => ({
    fixtureId: Number(x.fixture_id), leagueId: Number(x.league_id), kickoff: new Date(x.kickoff_at).getTime(),
    home: Number(x.home_team_id), away: Number(x.away_team_id), homeGoals: Number(x.home_goals), awayGoals: Number(x.away_goals),
    homeShots: n(x.home_shots), awayShots: n(x.away_shots), homeShotsOnTarget: n(x.home_shots_on_target), awayShotsOnTarget: n(x.away_shots_on_target),
    homeCorners: n(x.home_corners), awayCorners: n(x.away_corners), homeXg: n(x.home_xg), awayXg: n(x.away_xg),
  }));
}

/** Build or refresh the live model; failures keep the previous one. */
export async function ensureStrengthModel(): Promise<void> {
  if (model && Date.now() - model.trainedAt < REFRESH_MS) return;
  if (!model && Date.now() - lastAttempt < 10 * 60_000 && !building) return;
  if (!building) {
    lastAttempt = Date.now();
    building = (async () => {
      const rows = await loadStrengthRows();
      const next = await buildStrengthModel(rows);
      if (next) { model = next; lastError = null; logger.info({ trainingMatches: next.trainingMatches }, "step 9 strength model trained"); }
      else lastError = `not enough history (${rows.length} matches)`;
    })()
      .catch((err) => { lastError = err instanceof Error ? err.message : String(err); logger.warn({ err }, "step 9 strength model training failed"); })
      .finally(() => { building = null; });
  }
  await building;
}

export function forecastStrength(leagueId: number, homeTeamId: number, awayTeamId: number): StrengthForecast | null {
  return model?.forecast(leagueId, homeTeamId, awayTeamId) ?? null;
}

export function getStrengthModelStatus() {
  return {
    trained: Boolean(model),
    trainedAt: model ? new Date(model.trainedAt).toISOString() : null,
    trainingMatches: model?.trainingMatches ?? 0,
    latestMatchAt: model?.latestMatchAt ? new Date(model.latestMatchAt).toISOString() : null,
    lastError,
  };
}

/** Test hook. */
export function __setStrengthModelForTests(m: StrengthModel | null) { model = m; }
