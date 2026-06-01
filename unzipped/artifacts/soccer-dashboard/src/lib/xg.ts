const MAX_GOALS = 8; // covers >99.9% of realistic scorelines

/** Poisson probability mass function: P(X = k | lambda) */
function poisson(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

export interface XGResult {
  homeXG: number;
  awayXG: number;
  homeWin: number; // 0-100
  draw: number;    // 0-100
  awayWin: number; // 0-100
}

/**
 * Compute xG and Poisson match outcome probabilities from season-average stats.
 *
 * homeXG = avg(home attack, away defence) × home advantage
 * awayXG = avg(away attack, home defence)
 */
export function computeXG(
  homeGoalsPerGame: number,
  homeConcededPerGame: number,
  awayGoalsPerGame: number,
  awayConcededPerGame: number,
  homeAdvantage = 1.10
): XGResult {
  const homeXG = ((homeGoalsPerGame + awayConcededPerGame) / 2) * homeAdvantage;
  const awayXG = (awayGoalsPerGame + homeConcededPerGame) / 2;

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    const pH = poisson(homeXG, h);
    for (let a = 0; a <= MAX_GOALS; a++) {
      const pA = poisson(awayXG, a);
      const joint = pH * pA;
      if (h > a) homeWin += joint;
      else if (h === a) draw += joint;
      else awayWin += joint;
    }
  }

  // Normalise to 100% (trim floating-point drift)
  const total = homeWin + draw + awayWin;
  return {
    homeXG: Math.round(homeXG * 100) / 100,
    awayXG: Math.round(awayXG * 100) / 100,
    homeWin: (homeWin / total) * 100,
    draw: (draw / total) * 100,
    awayWin: (awayWin / total) * 100,
  };
}

/** Signed divergence between model and market (positive = model favours more than market) */
export function divergence(modelPct: number, marketPct: number | null | undefined): number | null {
  if (marketPct == null) return null;
  return modelPct - marketPct;
}
