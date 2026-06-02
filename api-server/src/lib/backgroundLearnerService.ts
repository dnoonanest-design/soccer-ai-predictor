import { db, backgroundJobRuns, betTracker, calibrationParameters, deepMatchStats } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { getAllMatches, type Match } from "./soccerService";
import { getMatchStats } from "./statsService";
import { getEnhancedPrediction, type LiveMatchStatsInput } from "./enhancedStatsService";
import { saveOutcome, savePrediction, getCalibrationReport, getCalibrationFactors } from "./predictionStore";
import { runTrainingPipeline, saveLiveAlert, savePredictionSnapshot, settleTrackedBet } from "./predictionPlatformService";
import { logger } from "./logger";
import { analyzeCircumstanceInfluence, applyCircumstanceCalibration, collectMatchCircumstances, getCircumstanceLearningReport } from "./circumstanceLearningService";
import { getAiAwarenessReport, runAiAwarenessCycle } from "./aiAwareLearningService";
import { generateBiweeklyAiUpdate, getAiMemoryUpdateReport } from "./aiMemoryUpdateService";
import { collectPlayerStatsForFixture } from "./playerService.js";
import { runBatchAIPlayerAnalysis } from "./playerAIAnalysisService.js";

type JobStatus = "idle" | "running" | "disabled";

const ENABLED = process.env.BACKGROUND_LEARNER_ENABLED !== "false";

// ── FIXED: Increased intervals to reduce API call volume ─────────────────────
const LIVE_INTERVAL_MS    = Math.max(60_000,           Number(process.env.BACKGROUND_LIVE_STATS_MS     ?? 60_000));
const SETTLE_INTERVAL_MS  = Math.max(10 * 60_000,      Number(process.env.BACKGROUND_SETTLE_MS         ?? 10 * 60_000));
const TRAIN_INTERVAL_MS   = Math.max(6 * 60 * 60_000,  Number(process.env.BACKGROUND_TRAIN_MS          ?? 6 * 60 * 60_000));
const BIWEEKLY_UPDATE_INTERVAL_MS = Math.max(14 * 24 * 60 * 60_000, Number(process.env.BACKGROUND_BIWEEKLY_UPDATE_MS ?? 14 * 24 * 60 * 60_000));
const MAX_LIVE_MATCHES    = Math.max(1,  Number(process.env.BACKGROUND_MAX_LIVE_MATCHES  ?? 12));
const MIN_AUTO_CALIBRATION_SAMPLE = Math.max(25, Number(process.env.MIN_AUTO_CALIBRATION_SAMPLE ?? 60));

// ── FIXED: Track which fixtures have already been processed ──────────────────
const processedFinishedFixtures = new Set<number>();

let started = false;
let liveStatus:     JobStatus = ENABLED ? "idle" : "disabled";
let settleStatus:   JobStatus = ENABLED ? "idle" : "disabled";
let trainStatus:    JobStatus = ENABLED ? "idle" : "disabled";
let biweeklyStatus: JobStatus = ENABLED ? "idle" : "disabled";
let liveTimer:     NodeJS.Timeout | null = null;
let settleTimer:   NodeJS.Timeout | null = null;
let trainTimer:    NodeJS.Timeout | null = null;
let biweeklyTimer: NodeJS.Timeout | null = null;
let lastLiveRun:          Date | null = null;
let lastSettleRun:        Date | null = null;
let lastTrainRun:         Date | null = null;
let lastBiweeklyUpdateRun: Date | null = null;

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const n = Number(v.replace("%", ""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function liveStatsPayload(stats: any): LiveMatchStatsInput {
  return { home: stats?.home ?? {}, away: stats?.away ?? {} };
}

function normalizeThreeWayPercent(home: number, draw: number, away: number) {
  const safe = [home, draw, away].map((p) => Number.isFinite(p) && p > 0 ? p : 0);
  const total = safe.reduce((a, b) => a + b, 0);
  if (total <= 0) return { home: 33.34, draw: 33.33, away: 33.33 };
  const h = Math.round((safe[0] / total) * 10000) / 100;
  const d = Math.round((safe[1] / total) * 10000) / 100;
  const a = Math.round(Math.max(0, 100 - h - d) * 100) / 100;
  return { home: h, draw: d, away: a };
}

function buildValueEdges(match: Match, home: number, draw: number, away: number) {
  const edge = (modelPct: number, decimalOdds: number | null) => {
    if (!decimalOdds || !Number.isFinite(decimalOdds) || modelPct <= 0) return null;
    const fairOdds = Math.round((100 / modelPct) * 100) / 100;
    const edgePct = Math.round(((decimalOdds * (modelPct / 100)) - 1) * 10000) / 100;
    return { bookmaker_odds: decimalOdds, fair_odds: fairOdds, edge_pct: edgePct, is_value: edgePct >= 5 };
  };
  return {
    home: edge(home, match.odds?.home_odds ?? null),
    draw: edge(draw, match.odds?.draw_odds ?? null),
    away: edge(away, match.odds?.away_odds ?? null),
  };
}

async function recordJob(
  jobName: string,
  status: "success" | "error",
  checkedCount: number,
  changedCount: number,
  errorMessage?: string
) {
  try {
    await db.insert(backgroundJobRuns).values({
      jobName, status, checkedCount, changedCount,
      errorMessage: errorMessage ?? null,
      finishedAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err, jobName }, "background learner: failed to record job run");
  }
}

async function saveDeepStats(match: Match, stats: any, enhanced: any) {
  const lm = enhanced?.live_momentum;
  await db.insert(deepMatchStats).values({
    fixtureId: match.id,
    leagueId: match.league_id ?? null,
    status: match.status,
    minute: match.minute ?? null,
    homeTeam: match.home_team.name,
    awayTeam: match.away_team.name,
    scoreHome: match.score?.home ?? null,
    scoreAway: match.score?.away ?? null,
    homeXg: num(enhanced?.home_xg),
    awayXg: num(enhanced?.away_xg),
    homeMomentum: num(lm?.home_momentum_pct ?? lm?.home_pressure),
    awayMomentum: num(lm?.away_momentum_pct ?? lm?.away_pressure),
    nextGoalHome: num(lm?.next_goal_home),
    nextGoalAway: num(lm?.next_goal_away),
    homeShots: num(stats?.home?.shots_total),
    awayShots: num(stats?.away?.shots_total),
    homeShotsOnTarget: num(stats?.home?.shots_on_target),
    awayShotsOnTarget: num(stats?.away?.shots_on_target),
    homeCorners: num(stats?.home?.corners),
    awayCorners: num(stats?.away?.corners),
    homeRedCards: num(stats?.home?.red_cards),
    awayRedCards: num(stats?.away?.red_cards),
    rawStatsJson: { home: stats?.home ?? {}, away: stats?.away ?? {}, enhanced: enhanced ?? {} },
  }).onConflictDoNothing();
}

async function computeAndStoreMatch(match: Match) {
  const stats = await getMatchStats(
    match.id,
    match.home_team.id,
    match.home_team.name,
    match.away_team.id,
    match.away_team.name,
    match.league_id,
    match.status === "live" || match.status === "finished",
  );

  if (!stats?.home || !stats?.away || stats.home.matches_played <= 0 || stats.away.matches_played <= 0) {
    return false;
  }

  const raw = await getEnhancedPrediction(
    match.id,
    match.home_team.id,
    match.away_team.id,
    match.league_id,
    stats.home.goals_per_game,
    stats.home.conceded_per_game,
    stats.away.goals_per_game,
    stats.away.conceded_per_game,
    match.home_team.name,
    match.away_team.name,
    match.minute ?? null,
    match.status === "live",
    match.score?.home ?? null,
    match.score?.away ?? null,
    stats.home.form,
    stats.away.form,
    liveStatsPayload(stats),
  );

  const factors = await getCalibrationFactors();
  const normalized = normalizeThreeWayPercent(raw.home_win, raw.draw, raw.away_win);
  const circumstances = await collectMatchCircumstances(
    match, stats.home.form, stats.away.form
  ).catch((err) => {
    logger.warn({ err, fixtureId: match.id }, "circumstance collection failed");
    return null;
  });
  const adjusted = await applyCircumstanceCalibration(match, normalized);
  const valueEdges = buildValueEdges(match, adjusted.home, adjusted.draw, adjusted.away);
  const liveMomentum = raw.live_momentum;

  await savePredictionSnapshot({
    fixtureId: match.id,
    leagueId: match.league_id ?? null,
    minute: match.minute ?? null,
    status: match.status,
    homeWinProb: adjusted.home,
    drawProb: adjusted.draw,
    awayWinProb: adjusted.away,
    over25Prob: raw.over_25 ?? null,
    bttsProb: raw.btts ?? null,
    homeXg: raw.home_xg ?? null,
    awayXg: raw.away_xg ?? null,
    pressureHome: liveMomentum?.home_pressure ?? null,
    pressureAway: liveMomentum?.away_pressure ?? null,
    nextGoalHome: liveMomentum?.next_goal_home ?? null,
    nextGoalAway: liveMomentum?.next_goal_away ?? null,
    confidence: raw.confidence_score ?? null,
    reasons: [
      ...(raw.reasons ?? []),
      ...(adjusted.adjustment
        ? [`Circumstance learning adjusted home probability by ${adjusted.adjustment.homeBoost.toFixed(1)} pts`]
        : []),
    ],
    valueEdges,
  });

  await savePrediction({
    fixtureId: match.id,
    homeTeam: match.home_team.name,
    awayTeam: match.away_team.name,
    leagueId: match.league_id ?? null,
    homeWinProb: adjusted.home,
    drawProb: adjusted.draw,
    awayWinProb: adjusted.away,
    isLive: match.status === "live",
    kickoffAt: match.kickoff ? new Date(match.kickoff) : null,
  });

  if (match.status === "live") {
    await saveDeepStats(match, stats, raw);
    if (liveMomentum?.pressure_alert) {
      await saveLiveAlert({
        fixtureId: match.id,
        alertType: "background_pressure",
        teamSide: liveMomentum.dominant_team ?? null,
        minute: match.minute ?? null,
        pressureScore: Math.max(liveMomentum.home_pressure ?? 0, liveMomentum.away_pressure ?? 0),
        message: liveMomentum.pressure_alert,
      });
    }
  }

  void factors;
  void circumstances;
  return true;
}

export async function runLiveDeepStatCollection() {
  if (!ENABLED) return { disabled: true, checked: 0, stored: 0 };
  if (liveStatus === "running") return { skipped: true, reason: "live job already running" };
  liveStatus = "running";
  const startedAt = new Date();
  let checked = 0;
  let stored = 0;
  try {
    const liveMatches = (await getAllMatches(null, "live")).slice(0, MAX_LIVE_MATCHES);

    for (const match of liveMatches) {
      checked++;
      try {
        if (await computeAndStoreMatch(match)) stored++;
      } catch (err) {
        logger.warn({ err, fixtureId: match.id }, "background learner: live match failed");
      }
    }

    lastLiveRun = new Date();
    await recordJob("live_deep_stats", "success", checked, stored);
    return { checked, stored, startedAt, finishedAt: new Date() };
  } catch (err: any) {
    await recordJob("live_deep_stats", "error", checked, stored, String(err?.message ?? err));
    throw err;
  } finally {
    liveStatus = "idle";
  }
}

export async function runFinishedSettlement() {
  if (!ENABLED) return { disabled: true, checked: 0, settled: 0 };
  if (settleStatus === "running") return { skipped: true, reason: "settlement job already running" };
  settleStatus = "running";
  let checked = 0;
  let settled = 0;
  try {
    const matches = await getAllMatches(null, null);

    for (const match of matches) {
      if (match.status !== "finished") continue;

      // ── FIXED: Skip fixtures already processed this session ───────────────
      if (processedFinishedFixtures.has(match.id)) continue;

      checked++;
      const home = match.score?.home;
      const away = match.score?.away;
      if (home == null || away == null) continue;

      await saveOutcome({ fixtureId: match.id, scoreHome: home, scoreAway: away });

      try { await computeAndStoreMatch(match); } catch {}

      // ── FIXED: Collect player stats sequentially, not fire-and-forget ─────
      try {
        const homeResult = home > away ? "win" : home < away ? "loss" : "draw";
        await collectPlayerStatsForFixture(
          match.id,
          match.league_id ?? 0,
          new Date(match.kickoff ?? Date.now()),
          match.home_team?.id ?? 0,
          match.away_team?.id ?? 0,
          homeResult as "win" | "draw" | "loss",
          home,
          away
        );
      } catch (err) {
        logger.warn({ err, fixtureId: match.id }, "player stats collection failed");
      }

      // Settle open bets
      const openBets = await db.select().from(betTracker)
        .where(sql`${betTracker.fixtureId} = ${match.id} AND ${betTracker.status} = 'open'`);
      for (const bet of openBets) {
        const outcome = home > away ? "home" : away > home ? "away" : "draw";
        const selection = String(bet.selection).toLowerCase();
        let won = false;
        if (bet.market === "match_winner" || bet.market === "h2h") {
          won = selection.includes(outcome);
        } else if (bet.market === "over_25") {
          won = home + away > 2.5;
        } else if (bet.market === "btts") {
          won = home > 0 && away > 0;
        }
        await settleTrackedBet(bet.id, won ? "won" : "lost");
      }

      // ── FIXED: Mark as processed so we never re-fetch this fixture ────────
      processedFinishedFixtures.add(match.id);
      settled++;
    }

    lastSettleRun = new Date();
    await recordJob("settle_finished", "success", checked, settled);
    return { checked, settled, finishedAt: new Date() };
  } catch (err: any) {
    await recordJob("settle_finished", "error", checked, settled, String(err?.message ?? err));
    throw err;
  } finally {
    settleStatus = "idle";
  }
}

export async function runAutomaticRecalibration() {
  if (!ENABLED) return { disabled: true };
  if (trainStatus === "running") return { skipped: true, reason: "training job already running" };
  trainStatus = "running";
  try {
    const training = await runTrainingPipeline();
    const influence = await analyzeCircumstanceInfluence();
    const aiAwareness = await runAiAwarenessCycle();
    const factors = await getCalibrationFactors();
    const report = await getCalibrationReport();
    const sampleSize = Number(factors.sampleSize ?? 0);
    lastTrainRun = new Date();

    if (sampleSize < MIN_AUTO_CALIBRATION_SAMPLE) {
      await recordJob("auto_recalibration", "success",
        Number(training.trainingRows ?? 0), Number(influence.stored ?? 0));
      return {
        skipped: true,
        reason: `Only ${sampleSize} settled samples; ${MIN_AUTO_CALIBRATION_SAMPLE} required.`,
        training, influence, aiAwareness,
        calibration: { sampleSize, report },
        finishedAt: new Date(),
      };
    }

    await db.update(calibrationParameters)
      .set({ active: false })
      .where(eq(calibrationParameters.active, true));
    await db.insert(calibrationParameters).values({
      modelVersion: "auto-calibrated-background-v1",
      sampleSize,
      factorsJson: factors as any,
      metricsJson: report as any,
      active: true,
    });

    await recordJob("auto_recalibration", "success",
      Number(training.trainingRows ?? 0), 1 + Number(influence.stored ?? 0));
    return { training, influence, aiAwareness, calibration: { sampleSize, report }, finishedAt: new Date() };
  } catch (err: any) {
    await recordJob("auto_recalibration", "error", 0, 0, String(err?.message ?? err));
    throw err;
  } finally {
    trainStatus = "idle";
  }
}

export async function runBiweeklyAiUpdate(force = false) {
  if (!ENABLED) return { disabled: true };
  if (biweeklyStatus === "running") return { skipped: true, reason: "biweekly AI update already running" };
  biweeklyStatus = "running";
  try {
    const result = await generateBiweeklyAiUpdate({ force });
    lastBiweeklyUpdateRun = new Date();
    await recordJob("biweekly_ai_update", "success",
      Number((result as any)?.payload?.aiCycle?.recalibration?.sampleSize ?? 0),
      (result as any)?.skipped ? 0 : 1);
    return { ...result, finishedAt: new Date() };
  } catch (err: any) {
    await recordJob("biweekly_ai_update", "error", 0, 0, String(err?.message ?? err));
    throw err;
  } finally {
    biweeklyStatus = "idle";
  }
}

export function startBackgroundLearner() {
  if (started || !ENABLED) return;
  started = true;

  liveTimer     = setInterval(() => runLiveDeepStatCollection().catch(err => logger.warn({ err }, "live background learner failed")), LIVE_INTERVAL_MS);
  settleTimer   = setInterval(() => runFinishedSettlement().catch(err => logger.warn({ err }, "settlement background learner failed")), SETTLE_INTERVAL_MS);
  trainTimer    = setInterval(() => runAutomaticRecalibration().catch(err => logger.warn({ err }, "recalibration background learner failed")), TRAIN_INTERVAL_MS);
  biweeklyTimer = setInterval(() => runBiweeklyAiUpdate(false).catch(err => logger.warn({ err }, "biweekly AI update failed")), BIWEEKLY_UPDATE_INTERVAL_MS);

  // ── FIXED: Staggered startup delays — no more 4 jobs firing at once ───────
  setTimeout(() => runFinishedSettlement().catch(() => {}),      60_000);   // 1 min
  setTimeout(() => runLiveDeepStatCollection().catch(() => {}),  90_000);   // 1.5 min
  setTimeout(() => runAutomaticRecalibration().catch(() => {}),  5 * 60_000); // 5 min
  setTimeout(() => runBiweeklyAiUpdate(false).catch(() => {}),  10 * 60_000); // 10 min

  logger.info(
    { LIVE_INTERVAL_MS, SETTLE_INTERVAL_MS, TRAIN_INTERVAL_MS, BIWEEKLY_UPDATE_INTERVAL_MS },
    "background prediction learner started"
  );
}

export function stopBackgroundLearner() {
  if (liveTimer)     clearInterval(liveTimer);
  if (settleTimer)   clearInterval(settleTimer);
  if (trainTimer)    clearInterval(trainTimer);
  if (biweeklyTimer) clearInterval(biweeklyTimer);
  started = false;
}

export async function getBackgroundLearnerStatus() {
  const recentRuns = await db.select().from(backgroundJobRuns)
    .orderBy(desc(backgroundJobRuns.startedAt)).limit(20);
  const circumstanceLearning = await getCircumstanceLearningReport()
    .catch(() => ({ recentInsights: [], recentCircumstances: [] }));
  const aiAwareness = await getAiAwarenessReport()
    .catch(() => ({ activeModel: null, recentAudits: [], openImprovements: [] }));
  const aiMemoryUpdates = await getAiMemoryUpdateReport()
    .catch(() => ({ recentBiweeklyUpdates: [], recentLearningMemory: [] }));
  return {
    enabled: ENABLED,
    started,
    intervals: {
      liveMs: LIVE_INTERVAL_MS,
      settleMs: SETTLE_INTERVAL_MS,
      trainMs: TRAIN_INTERVAL_MS,
      biweeklyUpdateMs: BIWEEKLY_UPDATE_INTERVAL_MS,
    },
    jobs: {
      liveDeepStats:   { status: liveStatus,     lastRun: lastLiveRun },
      settlement:      { status: settleStatus,   lastRun: lastSettleRun },
      recalibration:   { status: trainStatus,    lastRun: lastTrainRun },
      biweeklyAiUpdate:{ status: biweeklyStatus, lastRun: lastBiweeklyUpdateRun },
    },
    recentRuns,
    circumstanceLearning,
    aiAwareness,
    aiMemoryUpdates,
  };
}
