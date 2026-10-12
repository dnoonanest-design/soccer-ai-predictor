/**
 * Three-way probability calibration (plan step 4).
 *
 * Maps raw model probabilities to calibrated ones with a temperature and two
 * outcome biases, fitted by minimising log loss:
 *
 *   p'_k ∝ exp(T · log p_k + b_k),   b_away = 0
 *
 * T > 1 sharpens forecasts that are too flat; T < 1 softens overconfident
 * ones; the biases fix systematic home/draw/away lean. Four numbers, so it
 * stays stable with a few hundred settled matches. Pure and deterministic.
 */

export type Outcome = "home" | "draw" | "away";
export type ThreeWayUnit = { home: number; draw: number; away: number };
export type CalibrationParams = { temperature: number; homeBias: number; drawBias: number; samples: number };
export const IDENTITY_CALIBRATION: CalibrationParams = { temperature: 1, homeBias: 0, drawBias: 0, samples: 0 };

const EPS = 1e-6;

export function applyCalibration(p: ThreeWayUnit, c: CalibrationParams): ThreeWayUnit {
  const zh = c.temperature * Math.log(Math.max(EPS, p.home)) + c.homeBias;
  const zd = c.temperature * Math.log(Math.max(EPS, p.draw)) + c.drawBias;
  const za = c.temperature * Math.log(Math.max(EPS, p.away));
  const m = Math.max(zh, zd, za);
  const eh = Math.exp(zh - m), ed = Math.exp(zd - m), ea = Math.exp(za - m);
  const t = eh + ed + ea;
  return { home: eh / t, draw: ed / t, away: ea / t };
}

export function logLoss(p: ThreeWayUnit, actual: Outcome): number {
  return -Math.log(Math.max(EPS, p[actual]));
}

export function brier(p: ThreeWayUnit, actual: Outcome): number {
  return (p.home - (actual === "home" ? 1 : 0)) ** 2 +
    (p.draw - (actual === "draw" ? 1 : 0)) ** 2 +
    (p.away - (actual === "away" ? 1 : 0)) ** 2;
}

/** Fit by gradient descent on mean log loss, with light L2 pull toward identity. */
export function fitCalibration(
  samples: Array<{ probs: ThreeWayUnit; actual: Outcome; weight?: number }>,
  options: { iterations?: number; learningRate?: number; l2?: number } = {},
): CalibrationParams {
  if (samples.length < 50) return { ...IDENTITY_CALIBRATION, samples: samples.length };
  const iterations = options.iterations ?? 400;
  const lr = options.learningRate ?? 0.5;
  const l2 = options.l2 ?? 0.002;
  let T = 1, bh = 0, bd = 0;
  const totalW = samples.reduce((s, x) => s + (x.weight ?? 1), 0);
  for (let it = 0; it < iterations; it++) {
    let gT = 0, gh = 0, gd = 0;
    for (const s of samples) {
      const w = (s.weight ?? 1) / totalW;
      const q = applyCalibration(s.probs, { temperature: T, homeBias: bh, drawBias: bd, samples: 0 });
      const lh = Math.log(Math.max(EPS, s.probs.home)), ld = Math.log(Math.max(EPS, s.probs.draw)), la = Math.log(Math.max(EPS, s.probs.away));
      const yh = s.actual === "home" ? 1 : 0, yd = s.actual === "draw" ? 1 : 0, ya = s.actual === "away" ? 1 : 0;
      // d(-log q_y)/dz_k = q_k - y_k
      gT += w * ((q.home - yh) * lh + (q.draw - yd) * ld + (q.away - ya) * la);
      gh += w * (q.home - yh);
      gd += w * (q.draw - yd);
    }
    T -= lr * (gT + l2 * (T - 1));
    bh -= lr * (gh + l2 * bh);
    bd -= lr * (gd + l2 * bd);
    T = Math.max(0.3, Math.min(3, T));
  }
  return { temperature: T, homeBias: bh, drawBias: bd, samples: samples.length };
}
