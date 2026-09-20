import { db, matchPredictions, matchOutcomes, pool } from "@workspace/db";
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
}): Promise<boolean> {
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
    return true;
  } catch (err) {
    logger.warn({ err, fixtureId: opts.fixtureId }, "predictionStore: failed to save outcome");
    return false;
  }
}

/**
 * Return recent pre-match predictions that still need a final result.
 * Exact pending IDs let settlement catch up after midnight without repeatedly
 * downloading complete historical match days.
 */
export async function getUnsettledPredictionFixtureIds(daysBack = 14): Promise<number[]> {
  const safeDays = Math.max(1, Math.min(60, Math.floor(daysBack)));
  const now = new Date();
  const cutoff = new Date(now.getTime() - safeDays * 24 * 60 * 60_000);
  const rows = await db
    .selectDistinct({ fixtureId: matchPredictions.fixtureId })
    .from(matchPredictions)
    .leftJoin(matchOutcomes, eq(matchPredictions.fixtureId, matchOutcomes.fixtureId))
    .where(and(
      eq(matchPredictions.isLive, false),
      sql`${matchOutcomes.fixtureId} IS NULL`,
      sql`${matchPredictions.kickoffAt} IS NOT NULL`,
      sql`${matchPredictions.kickoffAt} <= ${now}`,
      sql`${matchPredictions.kickoffAt} >= ${cutoff}`,
    ));

  const auditRows = await pool.query<{ fixture_id: number }>(
    `SELECT DISTINCT fixture_id
       FROM prediction_audit_records
      WHERE settled_at IS NULL
        AND voided_at IS NULL
        AND kickoff_at IS NOT NULL
        AND kickoff_at <= $1
        AND kickoff_at >= $2`,
    [now, cutoff],
  );

  return Array.from(new Set([
    ...rows.map((row) => row.fixtureId),
    ...auditRows.rows.map((row) => Number(row.fixture_id)),
  ]));
}

// ── Calibration ───────────────────────────────────────────────────────────────
// Legacy calibration reporting. Serving factors remain neutral: production
// parameters are promoted only by adaptiveLearningEngine after holdout proof.

export interface CalibrationFactors {
  home: Record<number, number>;
  draw: Record<number, number>;
  away: Record<number, number>;
  sampleSize: number;
  /** Legacy bucket factors are never production-valid without holdout proof. */
  validated: boolean;
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

  const EMPTY: CalibrationFactors = { home: {}, draw: {}, away: {}, sampleSize: 0, validated: false };

  try {
    // JOIN predictions (pre-match only) with outcomes
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

    // Historical bucket calibration used the same small sample for fitting and
    // serving. Keep only its sample count for reporting. Production adjustment
    // is owned exclusively by adaptiveLearningEngine's chronological holdout.
    const factors: CalibrationFactors = {
      home: {}, draw: {}, away: {},
      sampleSize: rows.length,
      validated: false,
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
  if (!factors.validated || factors.sampleSize < 250) return prob;
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
  brierScore:       number;     // 3-class sum; lower is better, random = 0.667
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
    playedAt:    string;
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
      kickoffAt:   matchPredictions.kickoffAt,
      outcome:     matchOutcomes.outcome,
      recordedAt:  matchOutcomes.recordedAt,
    })
    .from(matchPredictions)
    .innerJoin(matchOutcomes, eq(matchPredictions.fixtureId, matchOutcomes.fixtureId))
    .where(eq(matchPredictions.isLive, false))
    .orderBy(desc(sql`COALESCE(${matchPredictions.kickoffAt}, ${matchOutcomes.recordedAt})`));

  const byOutcome = {
    home: { predicted: 0, actual: 0, correct: 0 },
    draw: { predicted: 0, actual: 0, correct: 0 },
    away: { predicted: 0, actual: 0, correct: 0 },
  };

  let totalBrier = 0;
  let correct = 0;

  const recentResults = rows.slice(0, 20).map((r) => {
    const probs = { home: r.homeWinProb, draw: r.drawProb, away: r.awayWinProb } as Record<string, number>;
    const predicted = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0] as "home" | "draw" | "away";
    const actual    = r.outcome as "home" | "draw" | "away";
    const isCorrect = predicted === actual;

    // Brier score for 3-class: Σ (p_i - o_i)^2
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
      correct: isCorrect,
      brierScore: Math.round(brier * 1000) / 1000,
      // Kickoff is the clearest date for users. recordedAt is a safe fallback
      // for legacy predictions created before kickoff persistence was added.
      playedAt: (r.kickoffAt ?? r.recordedAt).toISOString(),
    };
  });

  for (const r of rows) {
    const probs = { home: r.homeWinProb, draw: r.drawProb, away: r.awayWinProb } as Record<string, number>;
    const predicted = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0] as "home" | "draw" | "away";
    const actual    = r.outcome as "home" | "draw" | "away";

    if (byOutcome[actual]) byOutcome[actual].actual++;
    if (byOutcome[predicted]) byOutcome[predicted].predicted++;
    if (predicted === actual) {
      correct++;
      if (byOutcome[actual]) byOutcome[actual].correct++;
    }

    totalBrier +=
      Math.pow(toUnitProb(r.homeWinProb) - (actual === "home" ? 1 : 0), 2) +
      Math.pow(toUnitProb(r.drawProb)    - (actual === "draw" ? 1 : 0), 2) +
      Math.pow(toUnitProb(r.awayWinProb) - (actual === "away" ? 1 : 0), 2);
  }

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
  // Loaded lazily to avoid an initialisation cycle. Calibration must use the
  // immutable, verified pre-match ledger rather than mutable prediction rows.
  const { loadVerifiedTrainingRows } = await import("./adaptiveLearningEngine");
  const rows = await loadVerifiedTrainingRows(20_000);

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
        ? "Use league-level monitoring; only chronological-holdout improvements may be promoted. External ML training becomes more reliable after 2,000+ rows."
        : "Dataset is large enough to export for XGBoost/LightGBM training and compare against the built-in calibrated model.",
  };
}

export async function getTrainingDataset(limit = 5000) {
  const safeLimit = Math.max(1, Math.min(20000, Math.floor(limit || 5000)));
  const { loadVerifiedTrainingRows } = await import("./adaptiveLearningEngine");
  const rows = (await loadVerifiedTrainingRows(safeLimit)).reverse();

  return rows.map((r) => ({
    fixture_id: r.fixtureId,
    home_team: r.homeTeam,
    away_team: r.awayTeam,
    league_id: r.leagueId,
    home_win_prob: Math.round(toUnitProb(r.homeWinProb) * 10000) / 10000,
    draw_prob: Math.round(toUnitProb(r.drawProb) * 10000) / 10000,
    away_win_prob: Math.round(toUnitProb(r.awayWinProb) * 10000) / 10000,
    kickoff_at: r.createdAt,
    outcome: r.outcome,
    score_home: r.scoreHome,
    score_away: r.scoreAway,
    goal_difference: r.scoreHome - r.scoreAway,
  }));
}
