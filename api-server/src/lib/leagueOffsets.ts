/**
 * League strength offsets for cross-league matches.
 *
 * Team ratings are fitted inside each league and centred there, so a team
 * that dominates a weaker league looks as strong as one that dominates a
 * stronger league. One offset per league puts every rating on a common scale:
 *
 *   log λ_home = base_home + o(home league) − o(away league)
 *   log λ_away = base_away + o(away league) − o(home league)
 *
 * The offsets are fitted by Poisson maximum likelihood on matches between
 * teams from different leagues (UEFA competitions, domestic cups), with a
 * Gaussian prior centred on the hand-set competition strength table so a
 * league with few such matches stays close to it.
 *
 * Pure functions only.
 */

export type CrossLeagueMatch = {
  homeLeague: number;
  awayLeague: number;
  /** log λ from the two teams' domestic ratings, before any league offset. */
  baseHome: number;
  baseAway: number;
  homeGoals: number;
  awayGoals: number;
  /** Time-decay weight. */
  weight: number;
};

export type LeagueOffsets = {
  offsets: Map<number, number>;
  matches: Map<number, number>;
};

export function fitLeagueOffsets(
  rows: CrossLeagueMatch[],
  priors: Map<number, number>,
  priorSd = 0.3,
  sweeps = 60,
): LeagueOffsets {
  const offsets = new Map<number, number>(priors);
  const matches = new Map<number, number>();
  for (const r of rows) {
    if (!offsets.has(r.homeLeague)) offsets.set(r.homeLeague, 0);
    if (!offsets.has(r.awayLeague)) offsets.set(r.awayLeague, 0);
    matches.set(r.homeLeague, (matches.get(r.homeLeague) ?? 0) + 1);
    matches.set(r.awayLeague, (matches.get(r.awayLeague) ?? 0) + 1);
  }
  const byLeague = new Map<number, CrossLeagueMatch[]>();
  for (const r of rows) {
    if (r.homeLeague === r.awayLeague) continue;
    for (const l of [r.homeLeague, r.awayLeague]) {
      const list = byLeague.get(l) ?? [];
      list.push(r);
      byLeague.set(l, list);
    }
  }
  const precision = 1 / (priorSd * priorSd);
  for (let s = 0; s < sweeps; s++) {
    let maxStep = 0;
    for (const [league, list] of byLeague) {
      const o = offsets.get(league)!;
      let grad = -(o - (priors.get(league) ?? 0)) * precision;
      let hess = precision;
      for (const r of list) {
        const d = offsets.get(r.homeLeague)! - offsets.get(r.awayLeague)!;
        const lh = Math.exp(r.baseHome + d), la = Math.exp(r.baseAway - d);
        // Sign: +1 when this league is the home side's, −1 when the away side's.
        const sign = r.homeLeague === league ? 1 : -1;
        grad += r.weight * sign * ((r.homeGoals - lh) - (r.awayGoals - la));
        hess += r.weight * (lh + la);
      }
      const step = Math.max(-0.25, Math.min(0.25, grad / hess));
      offsets.set(league, o + step);
      maxStep = Math.max(maxStep, Math.abs(step));
    }
    if (maxStep < 1e-5) break;
  }
  return { offsets, matches };
}
