import { db, backgroundJobRuns, betTracker, deepMatchStats, pool, type PoolClient } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { getAllMatches, getMatchesByIds, type Match } from "./soccerService";
import { createCanonicalPrediction } from "./canonicalPredictionService";
import { getUnsettledPredictionFixtureIds, saveOutcome, savePrediction, getCalibrationReport } from "./predictionStore";
import { runTrainingPipeline, saveLiveAlert, savePredictionSnapshot, settleTrackedBet } from "./predictionPlatformService";
import { logger } from "./logger";
import { analyzeCircumstanceInfluence, getCircumstanceLearningReport } from "./circumstanceLearningService";
import { getAiAwarenessReport, runAiAwarenessCycle } from "./aiAwareLearningService";
import { generateBiweeklyAiUpdate, getAiMemoryUpdateReport } from "./aiMemoryUpdateService";
import { collectPlayerStatsForFixture } from "./playerService.js";
import { runBatchAIPlayerAnalysis } from "./playerAIAnalysisService.js";
import { isTrackedLeague } from "./leagueConfig";
import { MIN_SAMPLE_FOR_WEIGHT_UPDATE, runAdaptiveLearningCycle } from "./adaptiveLearningEngine";

type JobStatus = "idle" | "running" | "disabled";

const ENABLED = process.env.BACKGROUND_LEARNER_ENABLED !== "false";

const LIVE_INTERVAL_MS    = Math.max(60_000,           Number(process.env.BACKGROUND_LIVE_STATS_MS     ?? 60_000));
const SETTLE_INTERVAL_MS  = Math.max(10 * 60_000,      Number(process.env.BACKGROUND_SETTLE_MS         ?? 10 * 60_000));
const TRAIN_INTERVAL_MS   = Math.max(6 * 60 * 60_000,  Number(process.env.BACKGROUND_TRAIN_MS          ?? 6 * 60 * 60_000));
const BIWEEKLY_UPDATE_INTERVAL_MS = Math.max(14 * 24 * 60 * 60_000, Number(process.env.BACKGROUND_BIWEEKLY_UPDATE_MS ?? 14 * 24 * 60 * 60_000));
const MAX_LIVE_MATCHES    = Math.max(1,  Number(process.env.BACKGROUND_MAX_LIVE_MATCHES  ?? 12));
const MIN_AUTO_CALIBRATION_SAMPLE = Math.max(
  MIN_SAMPLE_FOR_WEIGHT_UPDATE,
  Number(process.env.MIN_AUTO_CALIBRATION_SAMPLE ?? MIN_SAMPLE_FOR_WEIGHT_UPDATE),
);
const TRAINING_ADVISORY_LOCK = 7_310_250_001;

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

export function getBackgroundRuntimeStatus() {
  return {
    enabled: ENABLED,
    started,
    playerAiExplanationsConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    jobs: {
      liveDeepStats: { status: liveStatus, lastRun: lastLiveRun },
      settlement: { status: settleStatus, lastRun: lastSettleRun },
      recalibration: { status: trainStatus, lastRun: lastTrainRun },
      biweeklyAiUpdate: { status: biweeklyStatus, lastRun: lastBiweeklyUpdateRun },
    },
  };
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const n = Number(v.replace("%", ""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
    const completedAt = new Date();
    await db.insert(backgroundJobRuns).values({
      jobName, status, checkedCount, changedCount,
      errorMessage: errorMessage ?? null,
      startedAt: completedAt,
      finishedAt: completedAt,
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
  // Never create or overwrite a forecast after the result is known. Finished
  // fixtures are handled by saveOutcome and the settlement/learning pipeline.
  if (match.status === "finished") return false;

  const { prediction: raw, circumstances, stats } = await createCanonicalPrediction(match, {
    collectCircumstances: true,
  });
  const valueEdges = buildValueEdges(match, raw.home_win, raw.draw, raw.away_win);
  const liveMomentum = raw.live_momentum;

  await savePredictionSnapshot({
    fixtureId: match.id,
    leagueId: match.league_id ?? null,
    minute: match.minute ?? null,
    status: match.status,
    homeWinProb: raw.home_win,
    drawProb: raw.draw,
    awayWinProb: raw.away_win,
    over25Prob: raw.over_25 ?? null,
    bttsProb: raw.btts ?? null,
    homeXg: raw.home_xg ?? null,
    awayXg: raw.away_xg ?? null,
    pressureHome: liveMomentum?.home_pressure ?? null,
    pressureAway: liveMomentum?.away_pressure ?? null,
    nextGoalHome: liveMomentum?.next_goal_home ?? null,
    nextGoalAway: liveMomentum?.next_goal_away ?? null,
    confidence: raw.confidence_score ?? null,
    reasons: raw.reasons ?? [],
    valueEdges,
  });

  await savePrediction({
    fixtureId: match.id,
    homeTeam: match.home_team.name,
    awayTeam: match.away_team.name,
    leagueId: match.league_id ?? null,
    homeWinProb: raw.home_win,
    drawProb: raw.draw,
    awayWinProb: raw.away_win,
    isLive: match.status === "live",
    kickoffAt: match.kickoff ? new Date(match.kickoff) : null,
  });

  if (match.status === "live") {
    if (stats) await saveDeepStats(match, stats, raw);
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
    // ── FIXED: Only process tracked leagues ──────────────────────────────────
    const liveMatches = (await getAllMatches(null, "live"))
      .filter(m => isTrackedLeague(m.league_id))
      .slice(0, MAX_LIVE_MATCHES);

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    for (const match of liveMatches) {
      checked++;
      try {
        if (await computeAndStoreMatch(match)) stored++;
        await sleep(600);
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
  if (!ENABLED) return { disabled: true, checked: 0, settled: 0, voided: 0 };
  if (settleStatus === "running") return { skipped: true, reason: "settlement job already running" };
  settleStatus = "running";
  let checked = 0;
  let settled = 0;
  let voided = 0;
  try {
    // The normal match window starts today. Resolve outstanding prediction IDs
    // directly so a late result missed before midnight is caught automatically.
    const pendingFixtureIds = await getUnsettledPredictionFixtureIds(30);
    // A result may already be settled while its player feed was temporarily
    // incomplete. Persistently recover those fixtures instead of relying on an
    // in-memory retry set which disappears on restart.
    const incompletePlayerRows = await pool.query<{ fixture_id: number }>(`
      SELECT mo.fixture_id
      FROM match_outcomes mo
      LEFT JOIN player_match_stats pms ON pms.fixture_id = mo.fixture_id
      WHERE mo.recorded_at >= NOW() - INTERVAL '14 days'
      GROUP BY mo.fixture_id
      HAVING COUNT(pms.id) < 14 OR COUNT(DISTINCT pms.team_id) < 2
      ORDER BY MAX(mo.recorded_at) DESC
      LIMIT 50
    `);
    const fixtureIds = [...new Set([...pendingFixtureIds, ...incompletePlayerRows.rows.map((row) => row.fixture_id)])];
    const matches = await getMatchesByIds(fixtureIds);

    for (const match of matches) {
      if (match.status === "cancelled") {
        checked++;
        const result = await pool.query(
          `UPDATE prediction_audit_records
              SET voided_at = COALESCE(voided_at, NOW()),
                  void_reason = COALESCE(void_reason, $2)
            WHERE fixture_id = $1
              AND settled_at IS NULL
              AND voided_at IS NULL`,
          [match.id, `provider:${match.status_detail}`],
        );
        voided += result.rowCount ?? 0;
        processedFinishedFixtures.add(match.id);
        continue;
      }
      if (match.status !== "finished") continue;
      if (processedFinishedFixtures.has(match.id)) continue;

      // ── FIXED: Only process tracked leagues ────────────────────────────────
      if (!isTrackedLeague(match.league_id)) continue;

      checked++;
      const home = match.score?.home;
      const away = match.score?.away;
      if (home == null || away == null) continue;

      const outcomeSaved = await saveOutcome({ fixtureId: match.id, scoreHome: home, scoreAway: away });
      if (!outcomeSaved) continue;

      const homeResult: "win" | "draw" | "loss" = home > away ? "win" : home < away ? "loss" : "draw";
      let playerStatsComplete = false;
      try {
        playerStatsComplete = await collectPlayerStatsForFixture(
          match.id,
          match.league_id ?? 0,
          new Date(match.kickoff ?? Date.now()),
          match.home_team?.id ?? 0,
          match.away_team?.id ?? 0,
          homeResult,
          home,
          away
        );
        // Throttle between fixtures to avoid rate limit bursts
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        logger.warn({ err, fixtureId: match.id }, "player stats collection failed");
      }

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

      // Incomplete player feeds remain eligible for the persistent recovery
      // query on the next pass. Inserts/profile updates are idempotent.
      if (playerStatsComplete) processedFinishedFixtures.add(match.id);
      settled++;
    }

    lastSettleRun = new Date();
    await recordJob("settle_finished", "success", checked, settled + voided);
    return { checked, settled, voided, finishedAt: new Date() };
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
  let lockClient: PoolClient | null = null;
  try {
    lockClient = await pool.connect();
    const lock = await lockClient.query("SELECT pg_try_advisory_lock($1) AS acquired", [TRAINING_ADVISORY_LOCK]);
    if (!lock.rows[0]?.acquired) return { skipped: true, reason: "training job already running on another instance" };
    const training = await runTrainingPipeline();
    const adaptive = await runAdaptiveLearningCycle();
    const influence = await analyzeCircumstanceInfluence();
    const aiAwareness = await runAiAwarenessCycle();
    const playerAnalysis = await runBatchAIPlayerAnalysis(20).then(() => ({ completed: true })).catch((err) => ({ completed: false, error: String(err?.message ?? err) }));
    const report = await getCalibrationReport();
    const sampleSize = Number(adaptive.featureWeights.sampleSize ?? 0);
    lastTrainRun = new Date();

    if (sampleSize < MIN_AUTO_CALIBRATION_SAMPLE) {
      await recordJob("auto_recalibration", "success",
        Number(training.trainingRows ?? 0), Number(influence.stored ?? 0));
      return {
        skipped: true,
        reason: `Only ${sampleSize} settled samples; ${MIN_AUTO_CALIBRATION_SAMPLE} required.`,
        training, adaptive, influence, aiAwareness, playerAnalysis,
        calibration: { sampleSize, report },
        finishedAt: new Date(),
      };
    }

    await recordJob("auto_recalibration", "success",
      Number(training.trainingRows ?? 0), Number(adaptive.featureWeights.improved) + Number(influence.stored ?? 0));
    return { training, adaptive, influence, aiAwareness, playerAnalysis, calibration: { sampleSize, report }, finishedAt: new Date() };
  } catch (err: any) {
    await recordJob("auto_recalibration", "error", 0, 0, String(err?.message ?? err));
    throw err;
  } finally {
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [TRAINING_ADVISORY_LOCK]).catch(() => {});
      lockClient.release();
    }
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

  // Settle first, then rebuild the verified fallback model before live
  // collection begins so startup cannot repeatedly report an obsolete warm-up.
  setTimeout(() => runFinishedSettlement().catch(() => {}),        30_000);
  setTimeout(() => runAutomaticRecalibration().catch(() => {}),    60_000);
  setTimeout(() => runLiveDeepStatCollection().catch(() => {}),  2 * 60_000);
  setTimeout(() => runBiweeklyAiUpdate(false).catch(() => {}),  10 * 60_000);

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
    ...getBackgroundRuntimeStatus(),
    intervals: {
      liveMs: LIVE_INTERVAL_MS,
      settleMs: SETTLE_INTERVAL_MS,
      trainMs: TRAIN_INTERVAL_MS,
      biweeklyUpdateMs: BIWEEKLY_UPDATE_INTERVAL_MS,
    },
    recentRuns,
    circumstanceLearning,
    aiAwareness,
    aiMemoryUpdates,
  };
}
