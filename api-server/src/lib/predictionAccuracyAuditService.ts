import { pool } from "@workspace/db";
import { logger } from "./logger";
import { fetchFootball, getAllMatches, type Match } from "./soccerService";
import { getMatchStats } from "./statsService";
import { getEnhancedPrediction, type LiveMatchStatsInput } from "./enhancedStatsService";
import {
  applyCircumstanceCalibration,
  collectMatchCircumstances,
} from "./circumstanceLearningService";
import { getTrackedCompetition, isTrackedLeague } from "./leagueConfig";
import { CURRENT_PREDICTION_MODEL_VERSION } from "./predictionModelVersion";

const ENABLED = process.env.PREDICTION_ACCURACY_AUDIT_ENABLED !== "false";
const SCAN_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.PREDICTION_ACCURACY_AUDIT_SCAN_MS ?? 15 * 60_000),
);
const MAX_PREMATCH_CAPTURES_PER_RUN = clamp(
  Number(process.env.PREDICTION_ACCURACY_AUDIT_MAX_PREMATCH ?? 10),
  1,
  30,
);
const MAX_LIVE_CAPTURES_PER_RUN = clamp(
  Number(process.env.PREDICTION_ACCURACY_AUDIT_MAX_LIVE ?? 8),
  1,
  20,
);
const MODEL_VERSION = CURRENT_PREDICTION_MODEL_VERSION;
const ENGINE_REVISION =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ??
  process.env.GIT_COMMIT_SHA?.slice(0, 12) ??
  "unknown";

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

type FutureFixture = {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string; long?: string; elapsed?: number | null };
  };
  league?: { id?: number; name?: string; logo?: string | null; country?: string };
  teams?: {
    home?: { id?: number; name?: string; logo?: string | null };
    away?: { id?: number; name?: string; logo?: string | null };
  };
  goals?: { home?: number | null; away?: number | null };
  score?: {
    halftime?: { home?: number | null; away?: number | null } | null;
  };
};

type AuditPrediction = {
  home: number;
  draw: number;
  away: number;
  over25: number | null;
  btts: number | null;
  homeXg: number | null;
  awayXg: number | null;
  confidence: number | null;
  circumstanceScoreHome: number | null;
  circumstanceScoreAway: number | null;
  homeFormScore: number | null;
  awayFormScore: number | null;
  dataTier: string;
};

type AuditRunResult = {
  prematchCandidates: number;
  prematchCaptured: number;
  liveCandidates: number;
  liveCaptured: number;
  settled: number;
  errors: number;
};

let started = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastResult: AuditRunResult | null = null;
let lastError: string | null = null;

function clamp(value: number, min: number, max: number) {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, safe));
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed =
    typeof value === "string" ? Number(value.replace("%", "")) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toUnitProbability(value: number): number {
  const unit = value > 1 ? value / 100 : value;
  return Math.max(0.001, Math.min(0.999, unit));
}

function normaliseThreeWay(home: number, draw: number, away: number) {
  const raw = [home, draw, away].map((v) =>
    Number.isFinite(v) && v > 0 ? v : 0,
  );
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { home: 33.34, draw: 33.33, away: 33.33 };
  const h = Math.round((raw[0] / total) * 10_000) / 100;
  const d = Math.round((raw[1] / total) * 10_000) / 100;
  const a = Math.round(Math.max(0, 100 - h - d) * 100) / 100;
  return { home: h, draw: d, away: a };
}

export function getPredictedOutcome(home: number, draw: number, away: number) {
  if (home >= draw && home >= away) return "home" as const;
  if (away >= home && away >= draw) return "away" as const;
  return "draw" as const;
}

export function getConfidenceBand(pickConfidencePct: number) {
  if (pickConfidencePct >= 70) return "70%+";
  if (pickConfidencePct >= 60) return "60-69%";
  if (pickConfidencePct >= 50) return "50-59%";
  if (pickConfidencePct >= 40) return "40-49%";
  return "under-40%";
}

export function scoreThreeWayPrediction(
  home: number,
  draw: number,
  away: number,
  actual: "home" | "draw" | "away",
) {
  const probs = {
    home: toUnitProbability(home),
    draw: toUnitProbability(draw),
    away: toUnitProbability(away),
  };
  const total = probs.home + probs.draw + probs.away;
  probs.home /= total;
  probs.draw /= total;
  probs.away /= total;

  const brier =
    Math.pow(probs.home - (actual === "home" ? 1 : 0), 2) +
    Math.pow(probs.draw - (actual === "draw" ? 1 : 0), 2) +
    Math.pow(probs.away - (actual === "away" ? 1 : 0), 2);
  const logLoss = -Math.log(Math.max(0.001, probs[actual]));
  return {
    brierScore: Math.round(brier * 10_000) / 10_000,
    logLoss: Math.round(logLoss * 10_000) / 10_000,
  };
}

function prematchCheckpoint(msToKickoff: number): string | null {
  if (msToKickoff <= 0 || msToKickoff > 24 * HOUR) return null;
  if (msToKickoff <= 15 * MINUTE) return "prematch_15m";
  if (msToKickoff <= 90 * MINUTE) return "prematch_90m";
  if (msToKickoff <= 6 * HOUR) return "prematch_6h";
  return "prematch_24h";
}

function liveCheckpoint(minute: number | null): string | null {
  if (minute == null || minute < 15) return null;
  if (minute >= 90) return "live_90";
  if (minute >= 75) return "live_75";
  if (minute >= 60) return "live_60";
  if (minute >= 45) return "live_45";
  if (minute >= 30) return "live_30";
  return "live_15";
}

function dateKeysBetween(start: Date, end: Date) {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate(),
  ));
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor.getTime() <= endDay) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function toMatch(fixture: FutureFixture): Match | null {
  const id = Number(fixture.fixture?.id);
  const leagueId = Number(fixture.league?.id);
  const homeId = Number(fixture.teams?.home?.id);
  const awayId = Number(fixture.teams?.away?.id);
  const kickoff = fixture.fixture?.date;
  if (
    !Number.isInteger(id) || id <= 0 ||
    !Number.isInteger(leagueId) || !isTrackedLeague(leagueId) ||
    !Number.isInteger(homeId) || !Number.isInteger(awayId) ||
    !fixture.teams?.home?.name || !fixture.teams?.away?.name || !kickoff
  ) return null;

  return {
    id,
    league_id: leagueId,
    league_name: fixture.league?.name ?? getTrackedCompetition(leagueId)?.name ?? "Unknown",
    league_logo: fixture.league?.logo ?? null,
    country: fixture.league?.country ?? getTrackedCompetition(leagueId)?.country ?? "",
    home_team: {
      id: homeId,
      name: fixture.teams.home.name,
      logo: fixture.teams.home.logo ?? null,
    },
    away_team: {
      id: awayId,
      name: fixture.teams.away.name,
      logo: fixture.teams.away.logo ?? null,
    },
    status: "upcoming",
    status_detail: fixture.fixture?.status?.long ?? fixture.fixture?.status?.short ?? "Not Started",
    minute: fixture.fixture?.status?.elapsed ?? null,
    score: {
      home: fixture.goals?.home ?? null,
      away: fixture.goals?.away ?? null,
    },
    score_ht: fixture.score?.halftime
      ? {
          home: fixture.score.halftime.home ?? null,
          away: fixture.score.halftime.away ?? null,
        }
      : null,
    kickoff,
    odds: {
      home_win: null,
      draw: null,
      away_win: null,
      home_odds: null,
      draw_odds: null,
      away_odds: null,
    },
  };
}

async function getUpcomingAuditMatches(now: Date): Promise<Match[]> {
  const end = new Date(now.getTime() + 24 * HOUR);
  const fixtures = new Map<number, Match>();

  for (const date of dateKeysBetween(now, end)) {
    try {
      // These date requests are intercepted by the API-Football quota layer.
      // In normal production operation they reuse the existing weekly schedule
      // cache rather than performing new fixture-discovery calls.
      const response = await fetchFootball(`/fixtures?date=${date}&timezone=UTC`);
      if (!Array.isArray(response)) continue;
      for (const raw of response as FutureFixture[]) {
        const match = toMatch(raw);
        if (!match) continue;
        const kickoffMs = new Date(match.kickoff).getTime();
        if (kickoffMs <= now.getTime() || kickoffMs > end.getTime()) continue;
        fixtures.set(match.id, match);
      }
    } catch (err) {
      logger.warn({ err, date }, "prediction audit fixture lookup failed");
    }
  }

  return Array.from(fixtures.values()).sort(
    (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime(),
  );
}

function liveStatsPayload(stats: any): LiveMatchStatsInput {
  return { home: stats?.home ?? {}, away: stats?.away ?? {} };
}

async function computeAuditPrediction(
  match: Match,
  includeCircumstances: boolean,
): Promise<AuditPrediction | null> {
  const live = match.status === "live";
  const stats = await getMatchStats(
    match.id,
    match.home_team.id,
    match.home_team.name,
    match.away_team.id,
    match.away_team.name,
    match.league_id,
    live,
  );

  if (
    !stats?.home || !stats?.away ||
    stats.home.matches_played <= 0 || stats.away.matches_played <= 0
  ) return null;

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
    live,
    match.score?.home ?? null,
    match.score?.away ?? null,
    stats.home.form,
    stats.away.form,
    liveStatsPayload(stats),
  );

  const normalized = normaliseThreeWay(raw.home_win, raw.draw, raw.away_win);
  let circumstances: any = null;
  let adjusted = normalized;

  if (includeCircumstances) {
    circumstances = await collectMatchCircumstances(
      match,
      stats.home.form,
      stats.away.form,
    ).catch((err) => {
      logger.warn({ err, fixtureId: match.id }, "prediction audit circumstance collection failed");
      return null;
    });
    adjusted = await applyCircumstanceCalibration(match, normalized);
  }

  return {
    home: adjusted.home,
    draw: adjusted.draw,
    away: adjusted.away,
    over25: numberOrNull(raw.over_25),
    btts: numberOrNull(raw.btts),
    homeXg: numberOrNull(raw.home_xg),
    awayXg: numberOrNull(raw.away_xg),
    confidence: numberOrNull(raw.confidence_score),
    circumstanceScoreHome: numberOrNull(circumstances?.circumstanceScoreHome),
    circumstanceScoreAway: numberOrNull(circumstances?.circumstanceScoreAway),
    homeFormScore: numberOrNull(circumstances?.homeFormScore),
    awayFormScore: numberOrNull(circumstances?.awayFormScore),
    dataTier: includeCircumstances ? "stats+circumstances" : "stats",
  };
}

async function existingCheckpointKeys(fixtureIds: number[]) {
  if (!fixtureIds.length) return new Set<string>();
  const result = await pool.query(
    `SELECT fixture_id, checkpoint
       FROM prediction_audit_records
      WHERE fixture_id = ANY($1::int[])
        AND model_version = $2
        AND engine_revision = $3`,
    [fixtureIds, MODEL_VERSION, ENGINE_REVISION],
  );
  return new Set(
    result.rows.map((row) => `${Number(row.fixture_id)}:${String(row.checkpoint)}`),
  );
}

async function insertAuditRecord(
  match: Match,
  phase: "prematch" | "live",
  checkpoint: string,
  prediction: AuditPrediction,
) {
  const capturedAt = new Date();
  const kickoffAt = match.kickoff ? new Date(match.kickoff) : null;
  if (phase === "prematch" && (!kickoffAt || capturedAt.getTime() >= kickoffAt.getTime())) {
    logger.warn({ fixtureId: match.id, kickoffAt }, "prediction audit rejected late prematch capture");
    return false;
  }
  const predictedOutcome = getPredictedOutcome(
    prediction.home,
    prediction.draw,
    prediction.away,
  );
  const pickConfidence = Math.max(
    prediction.home,
    prediction.draw,
    prediction.away,
  );
  const confidenceBand = getConfidenceBand(pickConfidence);

  const result = await pool.query(
    `INSERT INTO prediction_audit_records (
       fixture_id, league_id, home_team, away_team, kickoff_at,
       phase, checkpoint, minute, data_tier, model_version, engine_revision,
       home_win_prob, draw_prob, away_win_prob, over25_prob, btts_prob,
       home_xg, away_xg, confidence, pick_confidence, confidence_band,
       predicted_outcome, circumstance_score_home, circumstance_score_away,
       home_form_score, away_form_score, captured_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
     )
     ON CONFLICT (fixture_id, checkpoint, model_version, engine_revision) DO NOTHING`,
    [
      match.id,
      match.league_id ?? null,
      match.home_team.name,
      match.away_team.name,
      kickoffAt,
      phase,
      checkpoint,
      match.minute ?? null,
      prediction.dataTier,
      MODEL_VERSION,
      ENGINE_REVISION,
      prediction.home,
      prediction.draw,
      prediction.away,
      prediction.over25,
      prediction.btts,
      prediction.homeXg,
      prediction.awayXg,
      prediction.confidence,
      pickConfidence,
      confidenceBand,
      predictedOutcome,
      prediction.circumstanceScoreHome,
      prediction.circumstanceScoreAway,
      prediction.homeFormScore,
      prediction.awayFormScore,
      capturedAt,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function capturePrematchCheckpoints(now: Date) {
  const matches = await getUpcomingAuditMatches(now);
  const existing = await existingCheckpointKeys(matches.map((match) => match.id));
  const due = matches
    .map((match) => ({
      match,
      checkpoint: prematchCheckpoint(new Date(match.kickoff).getTime() - now.getTime()),
    }))
    .filter(
      (item): item is { match: Match; checkpoint: string } =>
        Boolean(item.checkpoint) &&
        !existing.has(`${item.match.id}:${item.checkpoint}`),
    )
    .slice(0, MAX_PREMATCH_CAPTURES_PER_RUN);

  let captured = 0;
  let errors = 0;
  for (const { match, checkpoint } of due) {
    try {
      // Lineups and last-minute availability add most value from 90 minutes out.
      // Earlier checkpoints stay deliberately lean to preserve API quota and
      // provide a clean baseline for measuring how much circumstances help.
      const includeCircumstances =
        checkpoint === "prematch_90m" || checkpoint === "prematch_15m";
      const prediction = await computeAuditPrediction(match, includeCircumstances);
      if (prediction && await insertAuditRecord(match, "prematch", checkpoint, prediction)) {
        captured++;
      }
    } catch (err) {
      errors++;
      logger.warn({ err, fixtureId: match.id, checkpoint }, "prediction audit prematch capture failed");
    }
  }

  return { candidates: due.length, captured, errors };
}

async function captureLiveCheckpoints() {
  let liveMatches: Match[] = [];
  try {
    liveMatches = (await getAllMatches(null, "live"))
      .filter((match) => isTrackedLeague(match.league_id));
  } catch (err) {
    logger.warn({ err }, "prediction audit live fixture lookup failed");
    return { candidates: 0, captured: 0, errors: 1 };
  }

  const existing = await existingCheckpointKeys(liveMatches.map((match) => match.id));
  const due = liveMatches
    .map((match) => ({ match, checkpoint: liveCheckpoint(match.minute) }))
    .filter(
      (item): item is { match: Match; checkpoint: string } =>
        Boolean(item.checkpoint) &&
        !existing.has(`${item.match.id}:${item.checkpoint}`),
    )
    .slice(0, MAX_LIVE_CAPTURES_PER_RUN);

  let captured = 0;
  let errors = 0;
  for (const { match, checkpoint } of due) {
    try {
      const prediction = await computeAuditPrediction(match, true);
      if (prediction && await insertAuditRecord(match, "live", checkpoint, prediction)) {
        captured++;
      }
    } catch (err) {
      errors++;
      logger.warn({ err, fixtureId: match.id, checkpoint }, "prediction audit live capture failed");
    }
  }
  return { candidates: due.length, captured, errors };
}

export async function settlePredictionAuditRecords() {
  const pending = await pool.query(
    `SELECT a.id, a.home_win_prob, a.draw_prob, a.away_win_prob,
            a.over25_prob, a.btts_prob, a.predicted_outcome,
            o.outcome, o.score_home, o.score_away
       FROM prediction_audit_records a
       JOIN match_outcomes o ON o.fixture_id = a.fixture_id
      WHERE a.settled_at IS NULL
        AND (a.phase <> 'prematch' OR a.captured_at < a.kickoff_at)
      ORDER BY a.captured_at ASC
      LIMIT 1000`,
  );

  let settled = 0;
  for (const row of pending.rows) {
    const actual = String(row.outcome) as "home" | "draw" | "away";
    const scores = scoreThreeWayPrediction(
      Number(row.home_win_prob),
      Number(row.draw_prob),
      Number(row.away_win_prob),
      actual,
    );
    const scoreHome = Number(row.score_home);
    const scoreAway = Number(row.score_away);
    const over25Actual = scoreHome + scoreAway > 2.5;
    const bttsActual = scoreHome > 0 && scoreAway > 0;
    const over25Prob = numberOrNull(row.over25_prob);
    const bttsProb = numberOrNull(row.btts_prob);
    const over25Predicted = over25Prob == null ? null : toUnitProbability(over25Prob) >= 0.5;
    const bttsPredicted = bttsProb == null ? null : toUnitProbability(bttsProb) >= 0.5;

    await pool.query(
      `UPDATE prediction_audit_records
          SET actual_outcome = $2,
              score_home = $3,
              score_away = $4,
              correct = $5,
              brier_score = $6,
              log_loss = $7,
              over25_actual = $8,
              btts_actual = $9,
              over25_correct = $10,
              btts_correct = $11,
              settled_at = NOW()
        WHERE id = $1 AND settled_at IS NULL`,
      [
        Number(row.id),
        actual,
        scoreHome,
        scoreAway,
        String(row.predicted_outcome) === actual,
        scores.brierScore,
        scores.logLoss,
        over25Actual,
        bttsActual,
        over25Predicted == null ? null : over25Predicted === over25Actual,
        bttsPredicted == null ? null : bttsPredicted === bttsActual,
      ],
    );
    settled++;
  }
  return settled;
}

export async function runPredictionAccuracyAudit(): Promise<AuditRunResult | { skipped: true; reason: string }> {
  if (!ENABLED) return { skipped: true, reason: "prediction accuracy audit disabled" };
  if (running) return { skipped: true, reason: "prediction accuracy audit already running" };
  running = true;
  lastError = null;

  try {
    const now = new Date();
    const prematch = await capturePrematchCheckpoints(now);
    const live = await captureLiveCheckpoints();
    const settled = await settlePredictionAuditRecords();
    const result: AuditRunResult = {
      prematchCandidates: prematch.candidates,
      prematchCaptured: prematch.captured,
      liveCandidates: live.candidates,
      liveCaptured: live.captured,
      settled,
      errors: prematch.errors + live.errors,
    };
    lastRunAt = new Date();
    lastResult = result;
    logger.info(result, "prediction accuracy audit completed");
    return result;
  } catch (err: any) {
    lastRunAt = new Date();
    lastError = String(err?.message ?? err);
    logger.warn({ err }, "prediction accuracy audit failed");
    throw err;
  } finally {
    running = false;
  }
}

export function startPredictionAccuracyAudit() {
  if (started || !ENABLED) return;
  started = true;
  timer = setInterval(() => {
    runPredictionAccuracyAudit().catch(() => {});
  }, SCAN_INTERVAL_MS);
  startupTimer = setTimeout(() => {
    runPredictionAccuracyAudit().catch(() => {});
  }, 2 * 60_000);
  logger.info(
    {
      scanIntervalMs: SCAN_INTERVAL_MS,
      maxPrematchCapturesPerRun: MAX_PREMATCH_CAPTURES_PER_RUN,
      maxLiveCapturesPerRun: MAX_LIVE_CAPTURES_PER_RUN,
      modelVersion: MODEL_VERSION,
      engineRevision: ENGINE_REVISION,
      prematchCheckpoints: ["24h", "6h", "90m", "15m"],
      liveCheckpoints: [15, 30, 45, 60, 75, 90],
    },
    "prediction accuracy audit started",
  );
}

export function stopPredictionAccuracyAudit() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
  started = false;
}

function toMetricNumber(value: unknown) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

function mapMetricRows(rows: any[]) {
  return rows.map((row) => ({
    ...row,
    samples: Number(row.samples ?? 0),
    accuracy: toMetricNumber(row.accuracy),
    brierScore: toMetricNumber(row.brier_score),
    logLoss: toMetricNumber(row.log_loss),
    averageConfidence: toMetricNumber(row.average_confidence),
  }));
}

export async function getPredictionAccuracyAuditReport() {
  const [overall, byLeague, byCheckpoint, byConfidence, byModel, byPredictedOutcome, circumstanceEdge, recent] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS captured,
        COUNT(DISTINCT fixture_id)::int AS fixtures,
        COUNT(*) FILTER (WHERE settled_at IS NOT NULL)::int AS settled,
        COUNT(*) FILTER (WHERE settled_at IS NULL)::int AS pending,
        AVG(correct::int) FILTER (WHERE settled_at IS NOT NULL) AS accuracy,
        AVG(brier_score) FILTER (WHERE settled_at IS NOT NULL) AS brier_score,
        AVG(log_loss) FILTER (WHERE settled_at IS NOT NULL) AS log_loss,
        AVG(over25_correct::int) FILTER (WHERE over25_correct IS NOT NULL) AS over25_accuracy,
        AVG(btts_correct::int) FILTER (WHERE btts_correct IS NOT NULL) AS btts_accuracy
      FROM prediction_audit_records
      WHERE phase <> 'prematch' OR captured_at < kickoff_at
    `),
    pool.query(`
      SELECT league_id, COUNT(*)::int AS samples,
             AVG(correct::int) AS accuracy,
             AVG(brier_score) AS brier_score,
             AVG(log_loss) AS log_loss,
             AVG(pick_confidence) AS average_confidence
        FROM prediction_audit_records
       WHERE settled_at IS NOT NULL AND (phase <> 'prematch' OR captured_at < kickoff_at)
       GROUP BY league_id
       ORDER BY samples DESC
    `),
    pool.query(`
      SELECT phase, checkpoint, data_tier, COUNT(*)::int AS samples,
             AVG(correct::int) AS accuracy,
             AVG(brier_score) AS brier_score,
             AVG(log_loss) AS log_loss,
             AVG(pick_confidence) AS average_confidence
        FROM prediction_audit_records
       WHERE settled_at IS NOT NULL AND (phase <> 'prematch' OR captured_at < kickoff_at)
       GROUP BY phase, checkpoint, data_tier
       ORDER BY phase, checkpoint
    `),
    pool.query(`
      SELECT confidence_band, COUNT(*)::int AS samples,
             AVG(correct::int) AS accuracy,
             AVG(brier_score) AS brier_score,
             AVG(log_loss) AS log_loss,
             AVG(pick_confidence) AS average_confidence
        FROM prediction_audit_records
       WHERE settled_at IS NOT NULL AND (phase <> 'prematch' OR captured_at < kickoff_at)
       GROUP BY confidence_band
       ORDER BY average_confidence DESC
    `),
    pool.query(`
      SELECT model_version, engine_revision, COUNT(*)::int AS samples,
             AVG(correct::int) AS accuracy,
             AVG(brier_score) AS brier_score,
             AVG(log_loss) AS log_loss,
             AVG(pick_confidence) AS average_confidence
        FROM prediction_audit_records
       WHERE settled_at IS NOT NULL AND (phase <> 'prematch' OR captured_at < kickoff_at)
       GROUP BY model_version, engine_revision
       ORDER BY samples DESC
    `),
    pool.query(`
      SELECT predicted_outcome, COUNT(*)::int AS samples,
             AVG(correct::int) AS accuracy,
             AVG(brier_score) AS brier_score,
             AVG(log_loss) AS log_loss,
             AVG(pick_confidence) AS average_confidence
        FROM prediction_audit_records
       WHERE settled_at IS NOT NULL AND (phase <> 'prematch' OR captured_at < kickoff_at)
       GROUP BY predicted_outcome
       ORDER BY predicted_outcome
    `),
    pool.query(`
      SELECT
        CASE
          WHEN circumstance_score_home IS NULL OR circumstance_score_away IS NULL THEN 'unknown'
          WHEN circumstance_score_home - circumstance_score_away >= 5 THEN 'home_edge'
          WHEN circumstance_score_away - circumstance_score_home >= 5 THEN 'away_edge'
          ELSE 'balanced'
        END AS circumstance_edge,
        COUNT(*)::int AS samples,
        AVG(correct::int) AS accuracy,
        AVG(brier_score) AS brier_score,
        AVG(log_loss) AS log_loss,
        AVG(pick_confidence) AS average_confidence
      FROM prediction_audit_records
      WHERE settled_at IS NOT NULL AND (phase <> 'prematch' OR captured_at < kickoff_at)
      GROUP BY circumstance_edge
      ORDER BY samples DESC
    `),
    pool.query(`
      SELECT fixture_id, league_id, home_team, away_team, kickoff_at,
             phase, checkpoint, data_tier, model_version, engine_revision,
             home_win_prob, draw_prob, away_win_prob, predicted_outcome,
             pick_confidence, confidence_band, actual_outcome, score_home, score_away,
             correct, brier_score, log_loss, over25_correct, btts_correct,
             captured_at, settled_at
        FROM prediction_audit_records
       WHERE phase <> 'prematch' OR captured_at < kickoff_at
       ORDER BY captured_at DESC
       LIMIT 40
    `),
  ]);

  const rawOverall = overall.rows[0] ?? {};
  const settled = Number(rawOverall.settled ?? 0);
  const dataMaturity =
    settled >= 1000 ? "mature" : settled >= 250 ? "developing" : "collecting";

  return {
    generatedAt: new Date().toISOString(),
    worker: getPredictionAccuracyAuditStatus(),
    methodology: {
      bookmakerOddsFeedCorePrediction: false,
      scoreScale: {
        pickAccuracy: "higher is better",
        brierScore: "lower is better; 3-way random baseline is approximately 0.667",
        logLoss: "lower is better",
      },
      prematchCheckpoints: ["24h", "6h", "90m", "15m"],
      liveCheckpoints: [15, 30, 45, 60, 75, 90],
      circumstanceDataFrom: "90 minutes before kickoff and in-play",
    },
    dataMaturity,
    overall: {
      captured: Number(rawOverall.captured ?? 0),
      fixtures: Number(rawOverall.fixtures ?? 0),
      settled,
      pending: Number(rawOverall.pending ?? 0),
      accuracy: toMetricNumber(rawOverall.accuracy),
      brierScore: toMetricNumber(rawOverall.brier_score),
      logLoss: toMetricNumber(rawOverall.log_loss),
      over25Accuracy: toMetricNumber(rawOverall.over25_accuracy),
      bttsAccuracy: toMetricNumber(rawOverall.btts_accuracy),
    },
    byLeague: mapMetricRows(byLeague.rows).map((row) => ({
      ...row,
      leagueId: row.league_id == null ? null : Number(row.league_id),
      league: row.league_id == null ? "Unknown" : getTrackedCompetition(Number(row.league_id))?.name ?? `League ${row.league_id}`,
      country: row.league_id == null ? null : getTrackedCompetition(Number(row.league_id))?.country ?? null,
    })),
    byCheckpoint: mapMetricRows(byCheckpoint.rows),
    byConfidence: mapMetricRows(byConfidence.rows),
    byModel: mapMetricRows(byModel.rows),
    byPredictedOutcome: mapMetricRows(byPredictedOutcome.rows),
    circumstanceEdge: mapMetricRows(circumstanceEdge.rows),
    recent: recent.rows.map((row) => ({
      ...row,
      fixture_id: Number(row.fixture_id),
      league_id: row.league_id == null ? null : Number(row.league_id),
      pick_confidence: toMetricNumber(row.pick_confidence),
      brier_score: toMetricNumber(row.brier_score),
      log_loss: toMetricNumber(row.log_loss),
    })),
  };
}

export function getPredictionAccuracyAuditStatus() {
  return {
    enabled: ENABLED,
    started,
    running,
    scanIntervalMs: SCAN_INTERVAL_MS,
    modelVersion: MODEL_VERSION,
    engineRevision: ENGINE_REVISION,
    lastRunAt,
    lastResult,
    lastError,
  };
}
