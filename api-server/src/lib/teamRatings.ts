/**
 * Fitted team ratings (plan step 2).
 *
 * Replaces raw goals-per-game averages with an attack and a defence rating per
 * team, estimated from every result in the window and corrected for who each
 * team played:
 *
 *   log λ_home = μ + h + attack(home) − defence(away)
 *   log λ_away = μ     + attack(away) − defence(home)
 *
 * Recent matches count more (exponential time decay), and every team is pulled
 * toward the league average by a few pseudo-matches, so a team with little
 * data stays close to average instead of swinging on a handful of results.
 * The home advantage h is fitted per league instead of hand-set.
 *
 * Pure functions only: no I/O, deterministic, unit-testable.
 */

export type RatingMatch = {
  home: string;
  away: string;
  /** Goals, or a goals/xG blend when expected goals are available (plan step 3). */
  homeGoals: number;
  awayGoals: number;
  /** Kickoff, ISO string or epoch milliseconds. */
  date: string | number;
};

export type TeamRating = { attack: number; defence: number; weight: number };

export type FittedRatings = {
  mu: number;
  homeAdvantage: number;
  teams: Map<string, TeamRating>;
  /** Rating given to a team with no matches in the window (e.g. promoted). */
  unseen: { attack: number; defence: number };
  matchesUsed: number;
  asOf: number;
};

export type RatingOptions = {
  /** Days for a match's weight to halve. */
  halfLifeDays?: number;
  /** Pseudo-matches at league average added to every team (shrinkage). */
  priorMatches?: number;
  /** Matches older than this are ignored. */
  maxAgeDays?: number;
  iterations?: number;
};

const DAY_MS = 86_400_000;
export const DEFAULT_RATING_OPTIONS: Required<RatingOptions> = {
  halfLifeDays: 240,
  priorMatches: 4,
  maxAgeDays: 730,
  iterations: 60,
};

function toMs(date: string | number): number {
  return typeof date === "number" ? date : Date.parse(date);
}

/** Fit ratings using only matches played strictly before `asOf`. */
export function fitTeamRatings(
  matches: RatingMatch[],
  asOf: string | number,
  options: RatingOptions = {},
): FittedRatings {
  const opts = { ...DEFAULT_RATING_OPTIONS, ...options };
  const asOfMs = toMs(asOf);
  const rows = matches
    .map((m) => ({ ...m, t: toMs(m.date) }))
    .filter((m) =>
      Number.isFinite(m.t) && m.t < asOfMs && asOfMs - m.t <= opts.maxAgeDays * DAY_MS &&
      Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && m.homeGoals >= 0 && m.awayGoals >= 0,
    )
    .map((m) => ({ ...m, w: Math.pow(0.5, (asOfMs - m.t) / (opts.halfLifeDays * DAY_MS)) }));

  const teams = new Map<string, TeamRating>();
  for (const m of rows) {
    for (const name of [m.home, m.away]) {
      const t = teams.get(name) ?? { attack: 0, defence: 0, weight: 0 };
      t.weight += m.w;
      teams.set(name, t);
    }
  }

  const totalW = rows.reduce((s, m) => s + m.w, 0);
  if (totalW <= 0) {
    return { mu: Math.log(1.3), homeAdvantage: Math.log(1.25), teams, unseen: { attack: 0, defence: 0 }, matchesUsed: 0, asOf: asOfMs };
  }
  const homeGoals = rows.reduce((s, m) => s + m.w * m.homeGoals, 0);
  const awayGoals = rows.reduce((s, m) => s + m.w * m.awayGoals, 0);
  let mu = Math.log(Math.max(0.2, awayGoals / totalW));
  let h = Math.log(Math.max(0.5, Math.min(2, (homeGoals + 0.5) / (awayGoals + 0.5))));

  const k = opts.priorMatches;
  const att = (name: string) => teams.get(name)?.attack ?? 0;
  const def = (name: string) => teams.get(name)?.defence ?? 0;

  for (let iter = 0; iter < opts.iterations; iter++) {
    // Attack: observed goals scored vs goals expected from (μ, h, opponent defence).
    const scored = new Map<string, number>(), expScored = new Map<string, number>();
    const conceded = new Map<string, number>(), expConceded = new Map<string, number>();
    const add = (map: Map<string, number>, key: string, v: number) => map.set(key, (map.get(key) ?? 0) + v);
    for (const m of rows) {
      add(scored, m.home, m.w * m.homeGoals);
      add(expScored, m.home, m.w * Math.exp(mu + h - def(m.away)));
      add(scored, m.away, m.w * m.awayGoals);
      add(expScored, m.away, m.w * Math.exp(mu - def(m.home)));
      add(conceded, m.home, m.w * m.awayGoals);
      add(expConceded, m.home, m.w * Math.exp(mu + att(m.away)));
      add(conceded, m.away, m.w * m.homeGoals);
      add(expConceded, m.away, m.w * Math.exp(mu + h + att(m.home)));
    }
    // k pseudo-matches at league average pull each rating toward 0.
    const avgFor = Math.exp(mu + h / 2);
    for (const [name, t] of teams) {
      const prior = k * avgFor;
      t.attack = Math.log((scored.get(name)! + prior) / (expScored.get(name)! + prior));
      t.defence = -Math.log((conceded.get(name)! + prior) / (expConceded.get(name)! + prior));
    }
    // Centre ratings (weighted) so μ carries the league scoring level.
    let wSum = 0, aSum = 0, dSum = 0;
    for (const t of teams.values()) { wSum += t.weight; aSum += t.weight * t.attack; dSum += t.weight * t.defence; }
    for (const t of teams.values()) { t.attack -= aSum / wSum; t.defence -= dSum / wSum; }

    // League level and home advantage.
    let expHome = 0, expAway = 0;
    for (const m of rows) {
      expHome += m.w * Math.exp(att(m.home) - def(m.away));
      expAway += m.w * Math.exp(att(m.away) - def(m.home));
    }
    h = Math.log(Math.max(1e-6, homeGoals) / Math.max(1e-6, expHome)) - Math.log(Math.max(1e-6, awayGoals) / Math.max(1e-6, expAway));
    h = Math.max(-0.2, Math.min(0.6, h));
    mu = Math.log(Math.max(1e-6, homeGoals + awayGoals) / Math.max(1e-6, Math.exp(h) * expHome + expAway));
  }

  // Teams new to the window (usually promoted) start below average: use the
  // mean of the weakest quarter of rated teams.
  const sorted = [...teams.values()].sort((a, b) => (a.attack + a.defence) - (b.attack + b.defence));
  const quarter = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 4)));
  const unseen = {
    attack: quarter.reduce((s, t) => s + t.attack, 0) / quarter.length,
    defence: quarter.reduce((s, t) => s + t.defence, 0) / quarter.length,
  };

  return { mu, homeAdvantage: h, teams, unseen, matchesUsed: rows.length, asOf: asOfMs };
}

export function expectedGoalsFromRatings(ratings: FittedRatings, home: string, away: string) {
  const hr = ratings.teams.get(home) ?? { ...ratings.unseen, weight: 0 };
  const ar = ratings.teams.get(away) ?? { ...ratings.unseen, weight: 0 };
  return {
    home: Math.exp(ratings.mu + ratings.homeAdvantage + hr.attack - ar.defence),
    away: Math.exp(ratings.mu + ar.attack - hr.defence),
    homeKnown: ratings.teams.has(home),
    awayKnown: ratings.teams.has(away),
  };
}

// ── Score grid ───────────────────────────────────────────────────────────────

const MAX_GOALS = 10;

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let log = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) log -= Math.log(i);
  return Math.exp(log);
}

function dcTau(i: number, j: number, lh: number, la: number, rho: number): number {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

/** Home/draw/away probabilities (0-1) plus goal markets from a Dixon-Coles grid. */
export function dixonColesOutcomes(lambdaHome: number, lambdaAway: number, rho = -0.13) {
  let home = 0, draw = 0, away = 0, over25 = 0, btts = 0, total = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    const ph = poissonPmf(lambdaHome, i);
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = Math.max(0, ph * poissonPmf(lambdaAway, j) * dcTau(i, j, lambdaHome, lambdaAway, rho));
      total += p;
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
      if (i + j > 2.5) over25 += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  return { home: home / total, draw: draw / total, away: away / total, over25: over25 / total, btts: btts / total };
}

export type GoalMarkets = {
  /** Percentages (0-100), matching the app's served prediction fields. */
  over15: number;
  over25: number;
  over35: number;
  btts: number;
  correctScores: Array<{ score: string; probability: number }>;
};

/**
 * Goal markets from the same score grid as dixonColesOutcomes, so a promoted
 * ratings model serves 1X2 and goal markets that agree with each other.
 */
export function dixonColesMarkets(lambdaHome: number, lambdaAway: number, rho = -0.13): GoalMarkets {
  let total = 0, o15 = 0, o25 = 0, o35 = 0, btts = 0;
  const scores: Array<{ score: string; p: number }> = [];
  for (let i = 0; i <= MAX_GOALS; i++) {
    const ph = poissonPmf(lambdaHome, i);
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = Math.max(0, ph * poissonPmf(lambdaAway, j) * dcTau(i, j, lambdaHome, lambdaAway, rho));
      total += p;
      if (i + j > 1.5) o15 += p;
      if (i + j > 2.5) o25 += p;
      if (i + j > 3.5) o35 += p;
      if (i > 0 && j > 0) btts += p;
      if (i <= 5 && j <= 5) scores.push({ score: `${i}-${j}`, p });
    }
  }
  const pct = (v: number) => Math.round((v / total) * 10_000) / 100;
  scores.sort((a, b) => b.p - a.p);
  return {
    over15: pct(o15), over25: pct(o25), over35: pct(o35), btts: pct(btts),
    correctScores: scores.slice(0, 6).map((s) => ({ score: s.score, probability: pct(s.p) })),
  };
}

/** Shrink a probability set toward league base rates (plan step 1), weight in 0-1. */
export function shrinkTowardPriors(
  probs: { home: number; draw: number; away: number },
  priors: { home: number; draw: number; away: number },
  weight: number,
) {
  const w = Math.max(0, Math.min(1, weight));
  const h = (1 - w) * probs.home + w * priors.home;
  const d = (1 - w) * probs.draw + w * priors.draw;
  const a = (1 - w) * probs.away + w * priors.away;
  const t = h + d + a;
  return { home: h / t, draw: d / t, away: a / t };
}
