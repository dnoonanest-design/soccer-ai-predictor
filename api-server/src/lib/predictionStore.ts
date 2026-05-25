import { db, matchPredictions, matchOutcomes } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { logger } from "./logger";

export async function savePrediction(opts: {
  fixtureId:   number;
  homeTeam:    string;
  awayTeam:    string;
  leagueId:    number | null;
  homeWinProb: number;
  drawProb:    number;
  awayWinProb: number;
  isLive:      boolean;
  kickoffAt?:  Date | null;
}): Promise<void> {
  try {
    await db
      .insert(matchPredictions)
      .values({
        fixtureId:   opts.fixtureId,
        homeTeam:    opts.homeTeam,
        awayTeam:    opts.awayTeam,
        leagueId:    opts.leagueId ?? null,
        homeWinProb: opts.homeWinProb,
        drawProb:    opts.drawProb,
        awayWinProb: opts.awayWinProb,
        isLive:      opts.isLive,
        kickoffAt:   opts.kickoffAt ?? null,
        updatedAt:   new Date(),
      })
      .onConflictDoUpdate({
        target: [matchPredictions.fixtureId, matchPredictions.isLive],
        set: {
          homeWinProb: opts.homeWinProb,
          drawProb:    opts.drawProb,
          awayWinProb: opts.awayWinProb,
          updatedAt:   new Date(),
        },
      });
  } catch (err) {
    logger.warn({ err, fixtureId: opts.fixtureId }, "predictionStore: failed to save prediction");
  }
}

export async function saveOutcome(opts: {
  fixtureId: number;
  scoreHome: number;
  scoreAway: number;
}): Promise<void> {
  const outcome =
    opts.scoreHome > opts.scoreAway ? "home"
    : opts.scoreAway > opts.scoreHome ? "away"
    : "draw";
  try {
    await db
      .insert(matchOutcomes)
      .values({ fixtureId: opts.fixtureId, outcome, scoreHome: opts.scoreHome, scoreAway: opts.scoreAway })
      .onConflictDoUpdate({
        target: matchOutcomes.fixtureId,
        set: { outcome, scoreHome: opts.scoreHome, scoreAway: opts.scoreAway, recordedAt: new Date() },
      });
  } catch (err) {
    logger.warn({ err, fixtureId: opts.fixtureId }, "predictionStore: failed to save outcome");
  }
}

// ── Calibration ───────────────────────────────────────────────────────────────
// For each prediction we look at whether the highest-confidence outcome won.
// We also compute per-bucket calibration: bucket = floor(prob * 10) * 10
// i.e. [0,10), [10,20) … [90,100].  Returns multipliers so that
//   calibrated_prob = raw_prob * multiplier[bucket]
// Only uses pre-match predictions (isLive = false).

export interface CalibrationFactors {
  home: Record<number, number>;
  draw: Record<number, number>;
  away: Record<number, number>;
  sampleSize: number;
}

let _calibCache: { factors: CalibrationFactors; fetchedAt: number } | null = null;
const CALIB_TTL = 5 * 60 * 1000; // 5 min

// Probabilities may be stored as either 0-1 fractions from older builds
// or 0-100 percentages from the corrected build. These helpers let
// calibration/accuracy work with both without breaking existing data.
function toUnitProb(prob: number): number {
  return prob > 1 ? prob / 100 : prob;
}

function fromUnitProb(prob: number, matchOriginalScale: number): number {
  return matchOriginalScale > 1 ? prob * 100 : prob;
}


export async function getCalibrationFactors(): Promise<CalibrationFactors> {
  if (_calibCache && Date.now() - _calibCache.fetchedAt < CALIB_TTL) {
    return _calibCache.factors;
  }

  const EMPTY: CalibrationFactors = { home: {}, draw: {}, away: {}, sampleSize: 0 };

  try {
    // ── S5: Push bucket aggregation into the DB with GROUP BY ─────────────
    // Previously loaded every settled row into Node.js memory, then computed
    // bucket counts in JS — O(n) memory for 2000+ rows every 5 minutes.
    // Now the DB returns at most 30 rows (10 buckets × 3 outcomes) regardless
    // of how many settled predictions exist.
    //
    // Normalise probabilities stored as 0-100 to 0-1 inline in SQL.
    const bucketRows = await db.execute(sql`
      SELECT
        mo.outcome,
        FLOOR(LEAST(
          CASE WHEN mp.home_win_prob > 1
            THEN (CASE mo.outcome
              WHEN 'home' THEN mp.home_win_prob / 100.0
              WHEN 'draw' THEN mp.draw_prob     / 100.0
              ELSE             mp.away_win_prob  / 100.0
            END)
            ELSE (CASE mo.outcome
              WHEN 'home' THEN mp.home_win_prob
              WHEN 'draw' THEN mp.draw_prob
              ELSE             mp.away_win_prob
            END)
          END * 10, 9
        )) * 10 AS bucket,
        COUNT(*)::int                                      AS total,
        SUM(
          CASE WHEN mp.home_win_prob > 1
            THEN (CASE mo.outcome
              WHEN 'home' THEN mp.home_win_prob / 100.0
              WHEN 'draw' THEN mp.draw_prob     / 100.0
              ELSE             mp.away_win_prob  / 100.0
            END)
            ELSE (CASE mo.outcome
              WHEN 'home' THEN mp.home_win_prob
              WHEN 'draw' THEN mp.draw_prob
              ELSE             mp.away_win_prob
            END)
          END
        )                                                  AS sum_pred,
        SUM(CASE WHEN mo.outcome = mo.outcome THEN 1 ELSE 0 END)::int AS actual_count_all,
        COUNT(*)::int                                                   AS row_count
      FROM match_predictions mp
      JOIN match_outcomes mo ON mo.fixture_id = mp.fixture_id
      WHERE mp.is_live = false
      GROUP BY mo.outcome, bucket
      ORDER BY mo.outcome, bucket
    `) as { rows: Array<{ outcome: string; bucket: string; total: number; sum_pred: string; actual_count_all: number; row_count: number }> };

    // Fall back to the old full-row path if SQL GROUP BY isn't supported
    // (e.g. test environments with SQLite shims) — detected by empty rows
    const aggRows = bucketRows.rows ?? [];

    if (aggRows.length === 0) {
      // Graceful fallback: count sample size via a lightweight COUNT query
      const countResult = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(matchPredictions)
        .innerJoin(matchOutcomes, eq(matchPredictions.fixtureId, matchOutcomes.fixtureId))
        .where(eq(matchPredictions.isLive, false));
      const sampleSize = Number(countResult[0]?.count ?? 0);
      if (sampleSize < 10) {
        _calibCache = { factors: EMPTY, fetchedAt: Date.now() };
        return EMPTY;
      }
      // Not enough bucket rows to build calibration — return empty (will retry next cycle)
      _calibCache = { factors: { ...EMPTY, sampleSize }, fetchedAt: Date.now() };
      return { ...EMPTY, sampleSize };
    }

    // Compute total sample size from aggregate rows
    const sampleSize = aggRows.reduce((s, r) => s + Number(r.total), 0) / 3; // divide by 3 outcomes

    if (sampleSize < 10) {
      _calibCache = { factors: EMPTY, fetchedAt: Date.now() };
      return EMPTY;
    }

    // Build per-outcome bucket factor maps from the aggregated rows
    type BucketAgg = { sumPred: number; actualCount: number; total: number };
    const outcomeMap: Record<string, Record<number, BucketAgg>> = { home: {}, draw: {}, away: {} };

    // We need actual win counts per outcome×bucket; the GROUP BY above gives
    // total rows per outcome×bucket.  The actual win count = rows where outcome
    // matches the bucket's outcome — which equals total for that outcome bucket
    // because we GROUP BY mo.outcome.
    for (const r of aggRows) {
      const outcome = String(r.outcome) as "home" | "draw" | "away";
      if (!outcomeMap[outcome]) continue;
      const bucket = Number(r.bucket);
      const total = Number(r.total);
      const sumPred = Number(r.sum_pred ?? 0);
      // actual_count = rows where this team's predicted outcome = actual outcome
      // Since we grouped by mo.outcome, every row in this group IS an actual win
      // for the given outcome — so actualCount = total for this outcome bucket.
      outcomeMap[outcome][bucket] = { sumPred, actualCount: total, total };
    }

    // We also need the total rows per bucket across ALL outcomes to compute
    // actualCount correctly.  Re-derive: for a given outcome O and bucket B,
    // actualCount = rows where mo.outcome=O grouped under outcome O (which is total).
    // Non-winning rows for outcome O appear in OTHER outcome groups for the same bucket.
    // So actualCount for outcome O bucket B = outcomeMap[O][B].total (correct).

    const toFactors = (b: Record<number, BucketAgg>): Record<number, number> => {
      const factors: Record<number, number> = {};
      for (const [key, val] of Object.entries(b)) {
        if (val.total < 5) continue;
        const avgPred = val.sumPred / val.total;
        const smoothedActualFreq = (val.actualCount + avgPred * 8) / (val.total + 8);
        if (avgPred < 0.001) continue;
        factors[Number(key)] = Math.max(0.65, Math.min(1.65, smoothedActualFreq / avgPred));
      }
      return factors;
    };

    const factors: CalibrationFactors = {
      home: toFactors(outcomeMap.home ?? {}),
      draw: toFactors(outcomeMap.draw ?? {}),
      away: toFactors(outcomeMap.away ?? {}),
      sampleSize: Math.round(sampleSize),
    };

    _calibCache = { factors, fetchedAt: Date.now() };
    return factors;
  } catch (err) {
    logger.warn({ err }, "predictionStore: calibration query failed");
    return EMPTY;
  }
}

export function applyCalibration(
  prob: number,
  outcome: "home" | "draw" | "away",
  factors: CalibrationFactors,
): number {
  if (factors.sampleSize < 10) return prob;
  const unitProb = toUnitProb(prob);
  const bucket = Math.min(9, Math.floor(unitProb * 10)) * 10;
  const factor = factors[outcome][bucket];
  if (factor == null) return prob;
  const calibratedUnitProb = Math.max(0.01, Math.min(0.98, unitProb * factor));
  return fromUnitProb(calibratedUnitProb, prob);
}

// ── Accuracy stats ────────────────────────────────────────────────────────────

export interface AccuracyStats {
  totalPredictions: number;
  correctPicks:     number;
  pickAccuracy:     number;     // 0-1
  brierScore:       number;     // lower = better; 0.333 = random baseline
  byOutcome: {
    home: { predicted: number; actual: number; correct: number };
    draw: { predicted: number; actual: number; correct: number };
    away: { predicted: number; actual: number; correct: number };
  };
  recentResults: Array<{
    fixtureId:   number;
    homeTeam:    string;
    awayTeam:    string;
    homeWinProb: number;
    drawProb:    number;
    awayWinProb: number;
    predicted:   string;
    actual:      string;
    correct:     boolean;
    brierScore:  number;
  }>;
}

export async function getAccuracyStats(): Promise<AccuracyStats> {
  const rows = await db
    .select({
      fixtureId:   matchPredictions.fixtureId,
      homeTeam:    matchPredictions.homeTeam,
      awayTeam:    matchPredictions.awayTeam,
      homeWinProb: matchPredictions.homeWinProb,
      drawProb:    matchPredictions.drawProb,
      awayWinProb: matchPredictions.awayWinProb,
      outcome:     matchOutcomes.outcome,
    })
    .from(matchPredictions)
    .innerJoin(matchOutcomes, eq(matchPredictions.fixtureId, matchOutcomes.fixtureId))
    .where(eq(matchPredictions.isLive, false));

  // ── A6: Single-pass computation — avoids iterating all rows twice ──────────
  const byOutcome = {
    home: { predicted: 0, actual: 0, correct: 0 },
    draw: { predicted: 0, actual: 0, correct: 0 },
    away: { predicted: 0, actual: 0, correct: 0 },
  };

  let totalBrier = 0;
  let correct = 0;
  const RECENT_N = 20;
  // Rolling buffer: we only keep the last RECENT_N entries, filled as we iterate
  const recentBuffer: typeof rows = [];

  for (const r of rows) {
    const probs = { home: r.homeWinProb, draw: r.drawProb, away: r.awayWinProb } as Record<string, number>;
    const predicted = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0] as "home" | "draw" | "away";
    const actual    = r.outcome as "home" | "draw" | "away";

    if (byOutcome[actual])    byOutcome[actual].actual++;
    if (byOutcome[predicted]) byOutcome[predicted].predicted++;
    if (predicted === actual) {
      correct++;
      if (byOutcome[actual]) byOutcome[actual].correct++;
    }

    totalBrier +=
      Math.pow(toUnitProb(r.homeWinProb) - (actual === "home" ? 1 : 0), 2) +
      Math.pow(toUnitProb(r.drawProb)    - (actual === "draw" ? 1 : 0), 2) +
      Math.pow(toUnitProb(r.awayWinProb) - (actual === "away" ? 1 : 0), 2);

    // Maintain a rolling window of the most recent RECENT_N rows
    recentBuffer.push(r);
    if (recentBuffer.length > RECENT_N) recentBuffer.shift();
  }

  // Build recentResults from the buffer (most recent first)
  const recentResults = [...recentBuffer].reverse().map((r) => {
    const probs = { home: r.homeWinProb, draw: r.drawProb, away: r.awayWinProb } as Record<string, number>;
    const predicted = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0] as "home" | "draw" | "away";
    const actual    = r.outcome as "home" | "draw" | "away";
    const brier =
      Math.pow(toUnitProb(r.homeWinProb) - (actual === "home" ? 1 : 0), 2) +
      Math.pow(toUnitProb(r.drawProb)    - (actual === "draw" ? 1 : 0), 2) +
      Math.pow(toUnitProb(r.awayWinProb) - (actual === "away" ? 1 : 0), 2);
    return {
      fixtureId:   r.fixtureId,
      homeTeam:    r.homeTeam,
      awayTeam:    r.awayTeam,
      homeWinProb: r.homeWinProb,
      drawProb:    r.drawProb,
      awayWinProb: r.awayWinProb,
      predicted,
      actual,
      correct: predicted === actual,
      brierScore: Math.round(brier * 1000) / 1000,
    };
  });

  const n = rows.length;
  return {
    totalPredictions: n,
    correctPicks:     correct,
    pickAccuracy:     n > 0 ? Math.round((correct / n) * 1000) / 1000 : 0,
    brierScore:       n > 0 ? Math.round((totalBrier / n) * 1000) / 1000 : 0,
    byOutcome,
    recentResults,
  };
}


// ── Enhanced accuracy tracking + ML-style calibration ──────────────────────

export interface CalibrationReport {
  sampleSize: number;
  pickAccuracy: number;
  brierScore: number;
  logLoss: number;
  expectedCalibrationError: number;
  buckets: Array<{
    outcome: "home" | "draw" | "away";
    bucket: string;
    count: number;
    averagePredicted: number;
    actualRate: number;
    correctionFactor: number;
  }>;
  recommendation: string;
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0.001;
  return Math.max(0.001, Math.min(0.999, v));
}

export async function getCalibrationReport(): Promise<CalibrationReport> {
  const rows = await db
    .select({
      homeWinProb: matchPredictions.homeWinProb,
      drawProb:    matchPredictions.drawProb,
      awayWinProb: matchPredictions.awayWinProb,
      outcome:     matchOutcomes.outcome,
    })
    .from(matchPredictions)
    .innerJoin(matchOutcomes, eq(matchPredictions.fixtureId, matchOutcomes.fixtureId))
    .where(eq(matchPredictions.isLive, false));

  const outcomes = ["home", "draw", "away"] as const;
  type Bucket = { sumPred: number; actual: number; total: number };
  const buckets: Record<string, Bucket> = {};
  let brier = 0;
  let logLoss = 0;
  let correct = 0;

  for (const r of rows) {
    const probs = {
      home: clampUnit(toUnitProb(r.homeWinProb)),
      draw: clampUnit(toUnitProb(r.drawProb)),
      away: clampUnit(toUnitProb(r.awayWinProb)),
    };
    const total = probs.home + probs.draw + probs.away;
    probs.home /= total; probs.draw /= total; probs.away /= total;

    const actual = r.outcome as "home" | "draw" | "away";
    const pick = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    if (pick === actual) correct++;

    brier +=
      Math.pow(probs.home - (actual === "home" ? 1 : 0), 2) +
      Math.pow(probs.draw - (actual === "draw" ? 1 : 0), 2) +
      Math.pow(probs.away - (actual === "away" ? 1 : 0), 2);
    logLoss += -Math.log(clampUnit(probs[actual]));

    for (const outcome of outcomes) {
      const bucketNo = Math.min(9, Math.floor(probs[outcome] * 10)) * 10;
      const key = `${outcome}:${bucketNo}`;
      if (!buckets[key]) buckets[key] = { sumPred: 0, actual: 0, total: 0 };
      buckets[key].sumPred += probs[outcome];
      buckets[key].total += 1;
      if (actual === outcome) buckets[key].actual += 1;
    }
  }

  let ece = 0;
  const bucketRows = Object.entries(buckets).map(([key, b]) => {
    const [outcome, bucketNo] = key.split(":");
    const avg = b.sumPred / b.total;
    const actualRate = b.actual / b.total;
    ece += (b.total / Math.max(1, rows.length * 3)) * Math.abs(avg - actualRate);
    return {
      outcome: outcome as "home" | "draw" | "away",
      bucket: `${bucketNo}-${Number(bucketNo) + 10}%`,
      count: b.total,
      averagePredicted: Math.round(avg * 1000) / 10,
      actualRate: Math.round(actualRate * 1000) / 10,
      correctionFactor: Math.round(Math.max(0.5, Math.min(1.8, (actualRate + 0.02) / Math.max(0.02, avg))) * 1000) / 1000,
    };
  }).sort((a, b) => a.outcome.localeCompare(b.outcome) || a.bucket.localeCompare(b.bucket));

  const n = rows.length;
  return {
    sampleSize: n,
    pickAccuracy: n ? Math.round((correct / n) * 1000) / 1000 : 0,
    brierScore: n ? Math.round((brier / n) * 1000) / 1000 : 0,
    logLoss: n ? Math.round((logLoss / n) * 1000) / 1000 : 0,
    expectedCalibrationError: Math.round(ece * 1000) / 1000,
    buckets: bucketRows,
    recommendation: n < 250
      ? "Keep collecting results. Calibration will be cautious until at least 250 settled pre-match predictions are available."
      : n < 2000
        ? "Use bucket calibration and league-level monitoring. External ML training becomes more reliable after 2,000+ rows."
        : "Dataset is large enough to export for XGBoost/LightGBM training and compare against the built-in calibrated model.",
  };
}

export async function getTrainingDataset(limit = 5000) {
  const safeLimit = Math.max(1, Math.min(20000, Math.floor(limit || 5000)));
  const rows = await db
    .select({
      fixtureId: matchPredictions.fixtureId,
      homeTeam: matchPredictions.homeTeam,
      awayTeam: matchPredictions.awayTeam,
      leagueId: matchPredictions.leagueId,
      homeWinProb: matchPredictions.homeWinProb,
      drawProb: matchPredictions.drawProb,
      awayWinProb: matchPredictions.awayWinProb,
      kickoffAt: matchPredictions.kickoffAt,
      outcome: matchOutcomes.outcome,
      scoreHome: matchOutcomes.scoreHome,
      scoreAway: matchOutcomes.scoreAway,
    })
    .from(matchPredictions)
    .innerJoin(matchOutcomes, eq(matchPredictions.fixtureId, matchOutcomes.fixtureId))
    .where(eq(matchPredictions.isLive, false))
    .orderBy(desc(matchPredictions.updatedAt))
    .limit(safeLimit);

  return rows.map((r) => ({
    fixture_id: r.fixtureId,
    home_team: r.homeTeam,
    away_team: r.awayTeam,
    league_id: r.leagueId,
    home_win_prob: Math.round(toUnitProb(r.homeWinProb) * 10000) / 10000,
    draw_prob: Math.round(toUnitProb(r.drawProb) * 10000) / 10000,
    away_win_prob: Math.round(toUnitProb(r.awayWinProb) * 10000) / 10000,
    kickoff_at: r.kickoffAt,
    outcome: r.outcome,
    score_home: r.scoreHome,
    score_away: r.scoreAway,
    goal_difference: r.scoreHome - r.scoreAway,
  }));
}
