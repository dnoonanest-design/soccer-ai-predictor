import { db, predictionSnapshots, betTracker, modelTrainingRuns, liveAlerts, matchPredictions, matchOutcomes } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getCalibrationReport } from "./predictionStore";

export interface PredictionSnapshotInput {
  fixtureId: number;
  leagueId?: number | null;
  minute?: number | null;
  status: string;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  over25Prob?: number | null;
  bttsProb?: number | null;
  homeXg?: number | null;
  awayXg?: number | null;
  pressureHome?: number | null;
  pressureAway?: number | null;
  nextGoalHome?: number | null;
  nextGoalAway?: number | null;
  confidence?: number | null;
  reasons?: unknown;
  valueEdges?: unknown;
}

export async function savePredictionSnapshot(input: PredictionSnapshotInput): Promise<void> {
  try {
    await db.insert(predictionSnapshots).values({
      fixtureId: input.fixtureId,
      leagueId: input.leagueId ?? null,
      minute: input.minute ?? null,
      status: input.status,
      homeWinProb: input.homeWinProb,
      drawProb: input.drawProb,
      awayWinProb: input.awayWinProb,
      over25Prob: input.over25Prob ?? null,
      bttsProb: input.bttsProb ?? null,
      homeXg: input.homeXg ?? null,
      awayXg: input.awayXg ?? null,
      pressureHome: input.pressureHome ?? null,
      pressureAway: input.pressureAway ?? null,
      nextGoalHome: input.nextGoalHome ?? null,
      nextGoalAway: input.nextGoalAway ?? null,
      confidence: input.confidence ?? null,
      reasonsJson: input.reasons == null ? null : JSON.stringify(input.reasons),
      valueEdgesJson: input.valueEdges == null ? null : JSON.stringify(input.valueEdges),
    });
  } catch (err) {
    logger.warn({ err, fixtureId: input.fixtureId }, "failed to save prediction snapshot");
  }
}

export async function getPredictionHistory(fixtureId: number) {
  const rows = await db
    .select()
    .from(predictionSnapshots)
    .where(eq(predictionSnapshots.fixtureId, fixtureId))
    .orderBy(desc(predictionSnapshots.createdAt))
    .limit(100);
  return rows.map((r) => ({
    ...r,
    reasons: r.reasonsJson ? safeJson(r.reasonsJson) : null,
    valueEdges: r.valueEdgesJson ? safeJson(r.valueEdgesJson) : null,
  }));
}

function safeJson(value: string) {
  try { return JSON.parse(value); } catch { return null; }
}

export async function createTrackedBet(input: {
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  market: string;
  selection: string;
  decimalOdds: number;
  stake?: number;
  modelProb?: number | null;
  edgePct?: number | null;
  notes?: string | null;
}) {
  const [created] = await db.insert(betTracker).values({
    fixtureId: input.fixtureId,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    market: input.market,
    selection: input.selection,
    decimalOdds: input.decimalOdds,
    stake: String(input.stake ?? 1),
    modelProb: input.modelProb ?? null,
    edgePct: input.edgePct ?? null,
    notes: input.notes ?? null,
  }).returning();
  return created;
}

export async function settleTrackedBet(id: number, status: "won" | "lost" | "void") {
  const rows = await db.select().from(betTracker).where(eq(betTracker.id, id)).limit(1);
  const bet = rows[0];
  if (!bet) return null;
  const stake = Number(bet.stake ?? 0);
  const profit = status === "won" ? stake * (Number(bet.decimalOdds) - 1) : status === "lost" ? -stake : 0;
  const [updated] = await db.update(betTracker).set({
    status,
    profit: String(Math.round(profit * 100) / 100),
    settledAt: new Date(),
  }).where(eq(betTracker.id, id)).returning();
  return updated;
}

export async function getBetTrackerSummary() {
  const rows = await db.select().from(betTracker).orderBy(desc(betTracker.placedAt)).limit(200);
  const settled = rows.filter((r) => r.status !== "open");
  const totalStake = settled.reduce((s, r) => s + Number(r.stake ?? 0), 0);
  const profit = settled.reduce((s, r) => s + Number(r.profit ?? 0), 0);
  const wins = settled.filter((r) => r.status === "won").length;
  return {
    openBets: rows.filter((r) => r.status === "open").length,
    settledBets: settled.length,
    winRate: settled.length ? Math.round((wins / settled.length) * 1000) / 10 : 0,
    totalStake: Math.round(totalStake * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roiPct: totalStake ? Math.round((profit / totalStake) * 10000) / 100 : 0,
    recent: rows.slice(0, 50),
  };
}

export async function runTrainingPipeline() {
  const rows = await db
    .select({
      homeWinProb: matchPredictions.homeWinProb,
      drawProb: matchPredictions.drawProb,
      awayWinProb: matchPredictions.awayWinProb,
      outcome: matchOutcomes.outcome,
    })
    .from(matchPredictions)
    .innerJoin(matchOutcomes, eq(matchPredictions.fixtureId, matchOutcomes.fixtureId))
    .where(eq(matchPredictions.isLive, false));

  const n = rows.length;
  const holdoutRows = Math.max(0, Math.floor(n * 0.2));
  const trainingRows = n - holdoutRows;
  let brier = 0;
  let correct = 0;
  const outcomeCounts = { home: 0, draw: 0, away: 0 } as Record<string, number>;

  for (const r of rows) {
    outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
    const probs = normaliseThreeWay({
      home: normaliseProb(r.homeWinProb),
      draw: normaliseProb(r.drawProb),
      away: normaliseProb(r.awayWinProb),
    });
    const pick = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    if (pick === r.outcome) correct++;
    brier += Math.pow(probs.home - (r.outcome === "home" ? 1 : 0), 2)
      + Math.pow(probs.draw - (r.outcome === "draw" ? 1 : 0), 2)
      + Math.pow(probs.away - (r.outcome === "away" ? 1 : 0), 2);
  }

  const calibrationReport = await getCalibrationReport();

  const weights = {
    model: "calibrated-statistical-v4",
    note: "Lightweight training pipeline: learns outcome priors and records holdout-style metrics. Replace with XGBoost/LightGBM when historic feature rows exceed 2,000.",
    priors: {
      home: n ? outcomeCounts.home / n : 0.45,
      draw: n ? outcomeCounts.draw / n : 0.27,
      away: n ? outcomeCounts.away / n : 0.28,
    },
    calibration: {
      expectedCalibrationError: calibrationReport.expectedCalibrationError,
      logLoss: calibrationReport.logLoss,
      buckets: calibrationReport.buckets,
    },
    recommendedFeatureWeights: {
      marketOdds: 0.22,
      xg: 0.27,
      elo: 0.16,
      form: 0.12,
      injuriesLineups: 0.11,
      liveMomentum: 0.12,
    },
  };

  const pickAccuracy = n ? Math.round((correct / n) * 1000) / 1000 : 0;
  const brierScore = n ? Math.round((brier / n) * 1000) / 1000 : 0;
  const [created] = await db.insert(modelTrainingRuns).values({
    modelVersion: "calibrated-statistical-v4",
    trainingRows,
    holdoutRows,
    pickAccuracy,
    brierScore,
    roiPct: null,
    weightsJson: JSON.stringify(weights),
    notes: n < 2000 ? "Small sample; use for calibration only until more historical rows are collected." : "Ready for external ML training export.",
  }).returning();
  return { ...created, weights };
}

export async function getTrainingRuns() {
  const rows = await db.select().from(modelTrainingRuns).orderBy(desc(modelTrainingRuns.createdAt)).limit(20);
  return rows.map((r) => ({ ...r, weights: safeJson(r.weightsJson) }));
}

export async function saveLiveAlert(input: { fixtureId: number; alertType: string; teamSide?: string | null; minute?: number | null; pressureScore?: number | null; message: string }) {
  const [created] = await db.insert(liveAlerts).values({
    fixtureId: input.fixtureId,
    alertType: input.alertType,
    teamSide: input.teamSide ?? null,
    minute: input.minute ?? null,
    pressureScore: input.pressureScore ?? null,
    message: input.message,
  }).returning();
  return created;
}

export async function getLiveAlerts(fixtureId?: number) {
  if (fixtureId != null) {
    return db.select().from(liveAlerts).where(eq(liveAlerts.fixtureId, fixtureId)).orderBy(desc(liveAlerts.createdAt)).limit(50);
  }
  return db.select().from(liveAlerts).orderBy(desc(liveAlerts.createdAt)).limit(100);
}

function normaliseProb(p: number) {
  if (!Number.isFinite(p)) return 0;
  return p > 1 ? p / 100 : p;
}

function normaliseThreeWay(probs: { home: number; draw: number; away: number }) {
  const home = Math.max(0, probs.home);
  const draw = Math.max(0, probs.draw);
  const away = Math.max(0, probs.away);
  const total = home + draw + away;
  if (total <= 0) return { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  return { home: home / total, draw: draw / total, away: away / total };
}
