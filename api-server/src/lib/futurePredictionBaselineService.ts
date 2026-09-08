import { pool } from "@workspace/db";
import { logger } from "./logger";
import { fetchFootball, type Match } from "./soccerService";
import { getMatchStats } from "./statsService";
import { getEnhancedPrediction } from "./enhancedStatsService";
import { savePrediction } from "./predictionStore";
import { getConfidenceBand, getPredictedOutcome } from "./predictionAccuracyAuditService";
import { getTrackedCompetition, isTrackedLeague } from "./leagueConfig";

const ENABLED = process.env.FUTURE_PREDICTION_BASELINE_ENABLED !== "false";
const WINDOW_HOURS = clamp(Number(process.env.FUTURE_PREDICTION_BASELINE_WINDOW_HOURS ?? 72), 48, 120);
const SCAN_INTERVAL_MS = Math.max(
  10 * 60_000,
  Number(process.env.FUTURE_PREDICTION_BASELINE_SCAN_MS ?? 15 * 60_000),
);
const MAX_CAPTURES_PER_RUN = clamp(
  Number(process.env.FUTURE_PREDICTION_BASELINE_MAX_PER_RUN ?? 12),
  1,
  30,
);
const MODEL_VERSION = process.env.PREDICTION_MODEL_VERSION ?? "calibrated-statistical-v4";
const ENGINE_REVISION =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ??
  process.env.GIT_COMMIT_SHA?.slice(0, 12) ??
  "unknown";

const HOUR = 60 * 60_000;

const BLOCKED_NAME_KEYWORDS = [
  "reserve", "reserva", " res ", "res.", "u20", "u19", "u18", "u17", "u16", "u15",
  "u23", "u21", "youth", "amateur", "intermedia", "regional", "segunda b",
  "tercera", "sub-20", "sub-19", "sub-18", "sub-17", "sub-23", "sub-21",
  "division b", "women", "club friendly", "4th", "fifth", "lower",
];

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
};

type BaselinePrediction = {
  home: number;
  draw: number;
  away: number;
  over25: number | null;
  btts: number | null;
  homeXg: number | null;
  awayXg: number | null;
  confidence: number | null;
};

type BaselineRunResult = {
  fixturesInWindow: number;
  due: number;
  captured: number;
  errors: number;
};

let started = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastResult: BaselineRunResult | null = null;
let lastError: string | null = null;

function clamp(value: number, min: number, max: number) {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, safe));
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "string" ? Number(value.replace("%", "")) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normaliseThreeWay(home: number, draw: number, away: number) {
  const raw = [home, draw, away].map((v) => Number.isFinite(v) && v > 0 ? v : 0);
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { home: 33.34, draw: 33.33, away: 33.33 };
  const h = Math.round((raw[0] / total) * 10_000) / 100;
  const d = Math.round((raw[1] / total) * 10_000) / 100;
  const a = Math.round(Math.max(0, 100 - h - d) * 100) / 100;
  return { home: h, draw: d, away: a };
}

function isBlockedLeagueName(name: string | null | undefined) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return BLOCKED_NAME_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function checkpointFor(msToKickoff: number): "prematch_72h" | "prematch_48h" | null {
  if (msToKickoff <= 24 * HOUR || msToKickoff > WINDOW_HOURS * HOUR) return null;
  if (msToKickoff <= 48 * HOUR) return "prematch_48h";
  return "prematch_72h";
}

function dateKeysBetween(start: Date, end: Date) {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
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
  const leagueName = fixture.league?.name ?? getTrackedCompetition(leagueId)?.name ?? "Unknown";

  if (
    !Number.isInteger(id) || id <= 0 ||
    !Number.isInteger(leagueId) || !isTrackedLeague(leagueId) ||
    isBlockedLeagueName(leagueName) ||
    !Number.isInteger(homeId) || !Number.isInteger(awayId) ||
    !fixture.teams?.home?.name || !fixture.teams?.away?.name || !kickoff
  ) return null;

  return {
    id,
    league_id: leagueId,
    league_name: leagueName,
    league_logo: fixture.league?.logo ?? null,
    country: fixture.league?.country ?? getTrackedCompetition(leagueId)?.country ?? "",
    home_team: { id: homeId, name: fixture.teams.home.name, logo: fixture.teams.home.logo ?? null },
    away_team: { id: awayId, name: fixture.teams.away.name, logo: fixture.teams.away.logo ?? null },
    status: "upcoming",
    status_detail: fixture.fixture?.status?.long ?? fixture.fixture?.status?.short ?? "Not Started",
    minute: fixture.fixture?.status?.elapsed ?? null,
    score: { home: fixture.goals?.home ?? null, away: fixture.goals?.away ?? null },
    score_ht: null,
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

async function getFutureMatches(now: Date) {
  const end = new Date(now.getTime() + WINDOW_HOURS * HOUR);
  const fixtures = new Map<number, Match>();

  for (const date of dateKeysBetween(now, end)) {
    try {
      // Quota optimizer intercepts these date lookups and normally serves the
      // existing weekly schedule cache rather than consuming discovery calls.
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
      logger.warn({ err, date }, "future baseline fixture lookup failed");
    }
  }

  return Array.from(fixtures.values()).sort(
    (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime(),
  );
}

async function existingKeys(fixtureIds: number[]) {
  if (!fixtureIds.length) return new Set<string>();
  const result = await pool.query(
    `SELECT fixture_id, checkpoint
       FROM prediction_audit_records
      WHERE fixture_id = ANY($1::int[])
        AND model_version = $2
        AND engine_revision = $3
        AND checkpoint IN ('prematch_72h','prematch_48h')`,
    [fixtureIds, MODEL_VERSION, ENGINE_REVISION],
  );
  return new Set(result.rows.map((row) => `${Number(row.fixture_id)}:${String(row.checkpoint)}`));
}

async function computeBaseline(match: Match): Promise<BaselinePrediction | null> {
  const stats = await getMatchStats(
    match.id,
    match.home_team.id,
    match.home_team.name,
    match.away_team.id,
    match.away_team.name,
    match.league_id,
    false,
  );

  if (!stats?.home || !stats?.away || stats.home.matches_played <= 0 || stats.away.matches_played <= 0) {
    return null;
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
    null,
    false,
    null,
    null,
    stats.home.form,
    stats.away.form,
    { home: stats.home, away: stats.away },
  );

  const normalized = normaliseThreeWay(raw.home_win, raw.draw, raw.away_win);
  return {
    home: normalized.home,
    draw: normalized.draw,
    away: normalized.away,
    over25: numberOrNull(raw.over_25),
    btts: numberOrNull(raw.btts),
    homeXg: numberOrNull(raw.home_xg ?? raw.expected_goals?.home),
    awayXg: numberOrNull(raw.away_xg ?? raw.expected_goals?.away),
    confidence: numberOrNull(raw.confidence_score),
  };
}

async function insertBaselineAudit(match: Match, checkpoint: string, prediction: BaselinePrediction) {
  const predictedOutcome = getPredictedOutcome(prediction.home, prediction.draw, prediction.away);
  const pickConfidence = Math.max(prediction.home, prediction.draw, prediction.away);
  const confidenceBand = getConfidenceBand(pickConfidence);

  const result = await pool.query(
    `INSERT INTO prediction_audit_records (
       fixture_id, league_id, home_team, away_team, kickoff_at,
       phase, checkpoint, minute, data_tier, model_version, engine_revision,
       home_win_prob, draw_prob, away_win_prob, over25_prob, btts_prob,
       home_xg, away_xg, confidence, pick_confidence, confidence_band,
       predicted_outcome
     ) VALUES (
       $1,$2,$3,$4,$5,'prematch',$6,NULL,'stats-baseline',$7,$8,
       $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
     )
     ON CONFLICT (fixture_id, checkpoint, model_version, engine_revision) DO NOTHING`,
    [
      match.id,
      match.league_id ?? null,
      match.home_team.name,
      match.away_team.name,
      new Date(match.kickoff),
      checkpoint,
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
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function runFuturePredictionBaseline(): Promise<BaselineRunResult | { skipped: true; reason: string }> {
  if (!ENABLED) return { skipped: true, reason: "future prediction baseline disabled" };
  if (running) return { skipped: true, reason: "future prediction baseline already running" };
  running = true;
  lastError = null;

  try {
    const now = new Date();
    const matches = await getFutureMatches(now);
    const existing = await existingKeys(matches.map((match) => match.id));
    const due = matches
      .map((match) => ({
        match,
        checkpoint: checkpointFor(new Date(match.kickoff).getTime() - now.getTime()),
      }))
      .filter(
        (item): item is { match: Match; checkpoint: "prematch_72h" | "prematch_48h" } =>
          Boolean(item.checkpoint) && !existing.has(`${item.match.id}:${item.checkpoint}`),
      )
      .slice(0, MAX_CAPTURES_PER_RUN);

    let captured = 0;
    let errors = 0;
    for (const { match, checkpoint } of due) {
      try {
        const prediction = await computeBaseline(match);
        if (!prediction) continue;
        const inserted = await insertBaselineAudit(match, checkpoint, prediction);
        if (!inserted) continue;

        await savePrediction({
          fixtureId: match.id,
          homeTeam: match.home_team.name,
          awayTeam: match.away_team.name,
          leagueId: match.league_id ?? null,
          homeWinProb: prediction.home,
          drawProb: prediction.draw,
          awayWinProb: prediction.away,
          isLive: false,
          kickoffAt: new Date(match.kickoff),
        });
        captured++;
      } catch (err) {
        errors++;
        logger.warn({ err, fixtureId: match.id, checkpoint }, "future prediction baseline capture failed");
      }
    }

    const result: BaselineRunResult = {
      fixturesInWindow: matches.length,
      due: due.length,
      captured,
      errors,
    };
    lastRunAt = new Date();
    lastResult = result;
    logger.info(result, "future prediction baseline completed");
    return result;
  } catch (err: any) {
    lastRunAt = new Date();
    lastError = String(err?.message ?? err);
    logger.warn({ err }, "future prediction baseline failed");
    throw err;
  } finally {
    running = false;
  }
}

export function getFuturePredictionBaselineStatus() {
  return {
    enabled: ENABLED,
    started,
    running,
    windowHours: WINDOW_HOURS,
    scanIntervalMs: SCAN_INTERVAL_MS,
    maxCapturesPerRun: MAX_CAPTURES_PER_RUN,
    checkpoints: ["72h", "48h"],
    modelVersion: MODEL_VERSION,
    engineRevision: ENGINE_REVISION,
    lastRunAt,
    lastResult,
    lastError,
  };
}

export function startFuturePredictionBaseline() {
  if (started || !ENABLED) return;
  started = true;
  timer = setInterval(() => {
    runFuturePredictionBaseline().catch(() => {});
  }, SCAN_INTERVAL_MS);
  startupTimer = setTimeout(() => {
    runFuturePredictionBaseline().catch(() => {});
  }, 45_000);

  logger.info(
    {
      windowHours: WINDOW_HOURS,
      scanIntervalMs: SCAN_INTERVAL_MS,
      maxCapturesPerRun: MAX_CAPTURES_PER_RUN,
      checkpoints: ["72h", "48h"],
      modelVersion: MODEL_VERSION,
      engineRevision: ENGINE_REVISION,
    },
    "future prediction baseline started",
  );
}

export function stopFuturePredictionBaseline() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
  started = false;
  running = false;
}
