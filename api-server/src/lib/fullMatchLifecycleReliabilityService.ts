import { pool } from "@workspace/db";
import { logger } from "./logger";
import { getQuotaOptimizationStatus } from "./quotaOptimizationService";
import { getOddsOptimizationStatus } from "./oddsOptimizationService";
import { getFutureMarketSamplerStatus } from "./futureMarketSamplerService";
import { getPredictionAccuracyAuditStatus } from "./predictionAccuracyAuditService";
import { getTrackedCompetition } from "./leagueConfig";

const ENABLED = process.env.FULL_MATCH_LIFECYCLE_TEST_ENABLED !== "false";
const SCAN_INTERVAL_MS = Math.max(
  5 * 60_000,
  Number(process.env.FULL_MATCH_LIFECYCLE_TEST_SCAN_MS ?? 10 * 60_000),
);
const LOOKAHEAD_HOURS = clamp(
  Number(process.env.FULL_MATCH_LIFECYCLE_TEST_LOOKAHEAD_HOURS ?? 96),
  72,
  168,
);
const MAX_ACTIVE_FIXTURES = clamp(
  Number(process.env.FULL_MATCH_LIFECYCLE_TEST_MAX_FIXTURES ?? 12),
  3,
  40,
);
const POST_MATCH_GRACE_HOURS = clamp(
  Number(process.env.FULL_MATCH_LIFECYCLE_TEST_POST_MATCH_GRACE_HOURS ?? 6),
  3,
  24,
);

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

type StageState = "captured" | "future" | "due" | "missed" | "not_expected";
type Verdict = "collecting" | "pass" | "warning" | "failed";

type FixtureRow = {
  fixture_id: number;
  league_id: number | null;
  home_team: string;
  away_team: string;
  kickoff_at: Date | string;
  enrolled_at: Date | string;
  first_checkpoint: string | null;
};

type StageEntry = {
  state: StageState;
  capturedAt?: string | null;
  minute?: number | null;
  evidence?: Record<string, unknown>;
};

type Evaluation = {
  fixtureId: number;
  lifecycleStatus: string;
  verdict: Verdict;
  reliabilityScore: number;
  completionPct: number;
  missingRequired: string[];
};

let started = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let lastRunAt: Date | null = null;
let lastResult: Record<string, unknown> | null = null;
let lastError: string | null = null;

function clamp(value: number, min: number, max: number) {
  const safe = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.max(min, Math.min(max, safe));
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function firstCapture(rows: any[], checkpoint: string) {
  const row = rows.find((item) => String(item.checkpoint) === checkpoint);
  return row ? iso(row.captured_at) : null;
}

function prematchStage(
  checkpoint: string,
  upperHours: number,
  lowerHours: number,
  capturedAt: string | null,
  enrolledLeadHours: number,
  currentLeadHours: number,
): StageEntry {
  if (capturedAt) return { state: "captured", capturedAt };
  const expected = enrolledLeadHours > lowerHours;
  if (!expected) return { state: "not_expected" };
  if (currentLeadHours > upperHours) return { state: "future" };
  if (currentLeadHours > lowerHours) return { state: "due" };
  return { state: "missed", evidence: { checkpoint } };
}

function liveStage(
  checkpoint: string,
  checkpointMinute: number,
  capturedRow: any | undefined,
  enrolledAtMs: number,
  kickoffMs: number,
  nowMs: number,
  maxObservedMinute: number,
  finished: boolean,
): StageEntry {
  if (capturedRow) {
    return {
      state: "captured",
      capturedAt: iso(capturedRow.captured_at),
      minute: capturedRow.minute == null ? checkpointMinute : Number(capturedRow.minute),
    };
  }

  const expected = enrolledAtMs <= kickoffMs + checkpointMinute * MINUTE;
  if (!expected) return { state: "not_expected" };
  if (nowMs < kickoffMs) return { state: "future" };
  if (finished) return { state: "missed", minute: checkpointMinute };
  if (maxObservedMinute >= checkpointMinute + 15) {
    return { state: "missed", minute: checkpointMinute };
  }
  if (maxObservedMinute >= checkpointMinute) {
    return { state: "due", minute: checkpointMinute };
  }
  return { state: "future", minute: checkpointMinute };
}

function flattenRequiredStages(stages: Record<string, any>) {
  const rows: Array<{ key: string; state: StageState }> = [];
  for (const [groupName, group] of Object.entries(stages)) {
    if (groupName === "marketOdds" || !group || typeof group !== "object") continue;
    if ("state" in group) {
      rows.push({ key: groupName, state: group.state as StageState });
      continue;
    }
    for (const [name, value] of Object.entries(group)) {
      if (value && typeof value === "object" && "state" in value) {
        rows.push({ key: `${groupName}.${name}`, state: (value as any).state as StageState });
      }
    }
  }
  return rows;
}

async function enrollFixtures() {
  const result = await pool.query(
    `WITH candidates AS (
       SELECT DISTINCT ON (a.fixture_id)
              a.fixture_id, a.league_id, a.home_team, a.away_team,
              a.kickoff_at, a.checkpoint, a.captured_at
        FROM prediction_audit_records a
        WHERE a.kickoff_at IS NOT NULL
          AND (a.phase <> 'prematch' OR a.captured_at < a.kickoff_at)
          AND a.kickoff_at >= NOW() - ($1::int * INTERVAL '1 hour')
          AND a.kickoff_at <= NOW() + ($2::int * INTERVAL '1 hour')
        ORDER BY a.fixture_id, a.captured_at ASC
     )
     INSERT INTO lifecycle_reliability_fixtures (
       fixture_id, league_id, home_team, away_team, kickoff_at,
       enrolled_at, first_checkpoint
     )
     SELECT c.fixture_id, c.league_id, c.home_team, c.away_team, c.kickoff_at,
            NOW(), c.checkpoint
       FROM candidates c
      WHERE NOT EXISTS (
        SELECT 1 FROM lifecycle_reliability_fixtures x WHERE x.fixture_id = c.fixture_id
      )
      ORDER BY c.kickoff_at ASC
      LIMIT $3
     ON CONFLICT (fixture_id) DO NOTHING`,
    [POST_MATCH_GRACE_HOURS, LOOKAHEAD_HOURS, MAX_ACTIVE_FIXTURES * 2],
  );
  return result.rowCount ?? 0;
}

async function evaluateFixture(row: FixtureRow): Promise<Evaluation> {
  const fixtureId = Number(row.fixture_id);
  const kickoff = new Date(row.kickoff_at);
  const enrolledAt = new Date(row.enrolled_at);
  const now = new Date();
  const kickoffMs = kickoff.getTime();
  const enrolledAtMs = enrolledAt.getTime();
  const nowMs = now.getTime();
  const enrolledLeadHours = (kickoffMs - enrolledAtMs) / HOUR;
  const currentLeadHours = (kickoffMs - nowMs) / HOUR;

  const [auditResult, outcomeResult, deepResult, circumstanceResult, marketResult, snapshotResult, playerResult] = await Promise.all([
    pool.query(
      `SELECT checkpoint, phase, minute, data_tier, model_version, engine_revision,
              predicted_outcome, pick_confidence, captured_at, settled_at, correct
         FROM prediction_audit_records
        WHERE fixture_id = $1
          AND (phase <> 'prematch' OR captured_at < kickoff_at)
        ORDER BY captured_at ASC`,
      [fixtureId],
    ),
    pool.query(
      `SELECT outcome, score_home, score_away, recorded_at
         FROM match_outcomes WHERE fixture_id = $1 LIMIT 1`,
      [fixtureId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, MAX(minute)::int AS max_minute,
              MIN(collected_at) AS first_at, MAX(collected_at) AS last_at
         FROM deep_match_stats WHERE fixture_id = $1`,
      [fixtureId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, MIN(collected_at) AS first_at,
              MAX(updated_at) AS last_at
         FROM match_circumstances WHERE fixture_id = $1`,
      [fixtureId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, COUNT(DISTINCT bookmaker_key)::int AS bookmakers,
              MIN(observed_at) AS first_at, MAX(observed_at) AS last_at
         FROM market_odds_snapshots WHERE fixture_id = $1`,
      [fixtureId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM prediction_snapshots WHERE fixture_id = $1`,
      [fixtureId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count, MIN(collected_at) AS first_at, MAX(collected_at) AS last_at
         FROM player_match_factors WHERE fixture_id = $1`,
      [fixtureId],
    ),
  ]);

  const audits = auditResult.rows;
  const outcome = outcomeResult.rows[0] ?? null;
  const deep = deepResult.rows[0] ?? {};
  const circumstances = circumstanceResult.rows[0] ?? {};
  const market = marketResult.rows[0] ?? {};
  const snapshots = snapshotResult.rows[0] ?? {};
  const players = playerResult.rows[0] ?? {};
  const checkpointMap = new Map<string, any>();
  for (const audit of audits) {
    const key = String(audit.checkpoint);
    if (!checkpointMap.has(key)) checkpointMap.set(key, audit);
  }

  const maxAuditMinute = audits.reduce(
    (max, audit) => audit.minute == null ? max : Math.max(max, Number(audit.minute)),
    0,
  );
  const maxObservedMinute = Math.max(maxAuditMinute, Number(deep.max_minute ?? 0));
  const finished = Boolean(outcome);

  const prematch = {
    h72: prematchStage("prematch_72h", 72, 48, firstCapture(audits, "prematch_72h"), enrolledLeadHours, currentLeadHours),
    h48: prematchStage("prematch_48h", 48, 24, firstCapture(audits, "prematch_48h"), enrolledLeadHours, currentLeadHours),
    h24: prematchStage("prematch_24h", 24, 6, firstCapture(audits, "prematch_24h"), enrolledLeadHours, currentLeadHours),
    h6: prematchStage("prematch_6h", 6, 1.5, firstCapture(audits, "prematch_6h"), enrolledLeadHours, currentLeadHours),
    m90: prematchStage("prematch_90m", 1.5, 0.25, firstCapture(audits, "prematch_90m"), enrolledLeadHours, currentLeadHours),
    m15: prematchStage("prematch_15m", 0.25, 0, firstCapture(audits, "prematch_15m"), enrolledLeadHours, currentLeadHours),
  };

  const live: Record<string, StageEntry> = {};
  for (const minute of [15, 30, 45, 60, 75, 90]) {
    live[`m${minute}`] = liveStage(
      `live_${minute}`,
      minute,
      checkpointMap.get(`live_${minute}`),
      enrolledAtMs,
      kickoffMs,
      nowMs,
      maxObservedMinute,
      finished,
    );
  }

  const circumstanceCount = Number(circumstances.count ?? 0);
  const circumstanceExpected = circumstanceCount > 0 || enrolledLeadHours > 0.25;
  let circumstanceState: StageState = "not_expected";
  if (circumstanceCount > 0) circumstanceState = "captured";
  else if (circumstanceExpected && currentLeadHours > 1.5) circumstanceState = "future";
  else if (circumstanceExpected && nowMs <= kickoffMs + 15 * MINUTE) circumstanceState = "due";
  else if (circumstanceExpected) circumstanceState = "missed";

  const deepCount = Number(deep.count ?? 0);
  const deepExpected = deepCount > 0 || enrolledAtMs <= kickoffMs + 15 * MINUTE;
  let deepState: StageState = "not_expected";
  if (deepCount > 0) deepState = "captured";
  else if (deepExpected && nowMs < kickoffMs) deepState = "future";
  else if (deepExpected && !finished && maxObservedMinute < 30) deepState = "due";
  else if (deepExpected) deepState = "missed";

  let outcomeState: StageState = "future";
  if (outcome) outcomeState = "captured";
  else if (nowMs >= kickoffMs + POST_MATCH_GRACE_HOURS * HOUR) outcomeState = "missed";
  else if (nowMs >= kickoffMs + 3 * HOUR) outcomeState = "due";

  const auditSettledCount = audits.filter((audit) => audit.settled_at != null).length;
  let settlementState: StageState = "future";
  if (outcome && audits.length > 0 && auditSettledCount === audits.length) settlementState = "captured";
  else if (outcome) {
    const outcomeAgeMs = nowMs - new Date(outcome.recorded_at).getTime();
    settlementState = outcomeAgeMs > 45 * MINUTE ? "missed" : "due";
  }

  const snapshotCount = Number(snapshots.count ?? 0);
  const playerCount = Number(players.count ?? 0);
  const learningReady = Boolean(outcome) && settlementState === "captured" && (snapshotCount > 0 || playerCount > 0);
  let learningState: StageState = "future";
  if (learningReady) learningState = "captured";
  else if (outcome) {
    const outcomeAgeMs = nowMs - new Date(outcome.recorded_at).getTime();
    learningState = outcomeAgeMs > 2 * HOUR ? "missed" : "due";
  }

  const stages = {
    prematch,
    circumstances: {
      state: circumstanceState,
      capturedAt: iso(circumstances.first_at),
      evidence: { records: circumstanceCount, lastUpdatedAt: iso(circumstances.last_at) },
    },
    live,
    deepStats: {
      state: deepState,
      capturedAt: iso(deep.first_at),
      minute: maxObservedMinute || null,
      evidence: { records: deepCount, lastCapturedAt: iso(deep.last_at) },
    },
    outcome: {
      state: outcomeState,
      capturedAt: iso(outcome?.recorded_at),
      evidence: outcome ? {
        result: outcome.outcome,
        scoreHome: Number(outcome.score_home),
        scoreAway: Number(outcome.score_away),
      } : {},
    },
    auditSettlement: {
      state: settlementState,
      evidence: { auditRecords: audits.length, settledRecords: auditSettledCount },
    },
    learningReady: {
      state: learningState,
      evidence: {
        predictionSnapshots: snapshotCount,
        playerFactors: playerCount,
        snapshotLastAt: iso(snapshots.last_at),
        playerLastAt: iso(players.last_at),
      },
    },
    marketOdds: {
      state: Number(market.count ?? 0) > 0 ? "captured" : "not_expected",
      evidence: {
        snapshots: Number(market.count ?? 0),
        bookmakers: Number(market.bookmakers ?? 0),
        firstObservedAt: iso(market.first_at),
        lastObservedAt: iso(market.last_at),
      },
    },
  };

  const required = flattenRequiredStages(stages);
  const expected = required.filter((stage) => stage.state !== "not_expected");
  const dueOrPast = expected.filter((stage) => stage.state !== "future");
  const capturedExpected = expected.filter((stage) => stage.state === "captured").length;
  const capturedDue = dueOrPast.filter((stage) => stage.state === "captured").length;
  const missingRequired = expected
    .filter((stage) => stage.state === "missed")
    .map((stage) => stage.key);

  const completionPct = expected.length ? round((capturedExpected / expected.length) * 100) : 100;
  const reliabilityScore = dueOrPast.length ? round((capturedDue / dueOrPast.length) * 100) : 100;

  const fullySettled = outcomeState === "captured" && settlementState === "captured";
  const learningComplete = learningState === "captured";
  let lifecycleStatus = nowMs < kickoffMs ? "prematch" : "live_or_settling";
  if (outcome) lifecycleStatus = fullySettled && learningComplete ? "completed" : "settling";

  let verdict: Verdict = "collecting";
  if (lifecycleStatus === "completed") {
    if (missingRequired.length === 0) verdict = "pass";
    else if (reliabilityScore >= 85) verdict = "warning";
    else verdict = "failed";
  } else if (missingRequired.length > 0) {
    verdict = nowMs >= kickoffMs + POST_MATCH_GRACE_HOURS * HOUR && reliabilityScore < 80
      ? "failed"
      : "warning";
  }

  const marketSampler = getFutureMarketSamplerStatus();
  const marketSnapshots = Number(market.count ?? 0);
  const advisory = {
    marketOdds: {
      corePredictionDependency: false,
      samplerEnabled: marketSampler.enabled,
      snapshots: marketSnapshots,
      status: marketSnapshots > 0 ? "observed" : marketSampler.enabled ? "awaiting_or_unmatched" : "sampler_disabled",
    },
    playerLearning: {
      factorsCaptured: playerCount,
      status: playerCount > 0 ? "observed" : learningReady ? "learning_input_available_without_player_factors" : "awaiting",
    },
  };

  const completedAt = lifecycleStatus === "completed" ? new Date() : null;
  await pool.query(
    `UPDATE lifecycle_reliability_fixtures
        SET lifecycle_status = $2,
            reliability_score = $3,
            completion_pct = $4,
            verdict = $5,
            missing_required_json = $6::jsonb,
            advisory_json = $7::jsonb,
            stage_json = $8::jsonb,
            last_evaluated_at = NOW(),
            completed_at = COALESCE(completed_at, $9),
            updated_at = NOW()
      WHERE fixture_id = $1`,
    [
      fixtureId,
      lifecycleStatus,
      reliabilityScore,
      completionPct,
      verdict,
      json(missingRequired),
      json(advisory),
      json(stages),
      completedAt,
    ],
  );

  return {
    fixtureId,
    lifecycleStatus,
    verdict,
    reliabilityScore,
    completionPct,
    missingRequired,
  };
}

async function recordRun(
  startedAt: Date,
  status: "success" | "error",
  evaluations: Evaluation[],
  errorMessage?: string,
) {
  const footballQuota = getQuotaOptimizationStatus();
  const oddsQuota = getOddsOptimizationStatus();
  const auditWorker = getPredictionAccuracyAuditStatus();
  const marketSampler = getFutureMarketSamplerStatus();

  await pool.query(
    `INSERT INTO lifecycle_reliability_runs (
       started_at, finished_at, status, fixtures_evaluated,
       collecting_count, passed_count, warning_count, failed_count,
       football_quota_json, odds_quota_json, audit_worker_json,
       market_sampler_json, error_message
     ) VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12)`,
    [
      startedAt,
      status,
      evaluations.length,
      evaluations.filter((item) => item.verdict === "collecting").length,
      evaluations.filter((item) => item.verdict === "pass").length,
      evaluations.filter((item) => item.verdict === "warning").length,
      evaluations.filter((item) => item.verdict === "failed").length,
      json(footballQuota),
      json(oddsQuota),
      json(auditWorker),
      json(marketSampler),
      errorMessage ?? null,
    ],
  );
}

export async function runFullMatchLifecycleReliabilityTest() {
  if (!ENABLED) return { skipped: true, reason: "full match lifecycle reliability test disabled" };
  if (running) return { skipped: true, reason: "full match lifecycle reliability test already running" };

  running = true;
  lastError = null;
  const startedAt = new Date();
  const evaluations: Evaluation[] = [];

  try {
    const enrolled = await enrollFixtures();
    const active = await pool.query(
      `SELECT fixture_id, league_id, home_team, away_team, kickoff_at, enrolled_at, first_checkpoint
         FROM lifecycle_reliability_fixtures
        WHERE completed_at IS NULL
        ORDER BY kickoff_at ASC
        LIMIT $1`,
      [MAX_ACTIVE_FIXTURES],
    );

    for (const row of active.rows as FixtureRow[]) {
      try {
        evaluations.push(await evaluateFixture(row));
      } catch (err) {
        logger.warn({ err, fixtureId: row.fixture_id }, "lifecycle reliability fixture evaluation failed");
      }
    }

    await recordRun(startedAt, "success", evaluations);
    lastRunAt = new Date();
    lastResult = {
      enrolled,
      evaluated: evaluations.length,
      collecting: evaluations.filter((item) => item.verdict === "collecting").length,
      passed: evaluations.filter((item) => item.verdict === "pass").length,
      warnings: evaluations.filter((item) => item.verdict === "warning").length,
      failed: evaluations.filter((item) => item.verdict === "failed").length,
    };
    logger.info(lastResult, "full match lifecycle reliability test completed");
    return lastResult;
  } catch (err: any) {
    lastRunAt = new Date();
    lastError = String(err?.message ?? err);
    await recordRun(startedAt, "error", evaluations, lastError).catch(() => {});
    logger.warn({ err }, "full match lifecycle reliability test failed");
    throw err;
  } finally {
    running = false;
  }
}

export function startFullMatchLifecycleReliabilityTest() {
  if (started || !ENABLED) return;
  started = true;
  timer = setInterval(() => {
    runFullMatchLifecycleReliabilityTest().catch(() => {});
  }, SCAN_INTERVAL_MS);
  startupTimer = setTimeout(() => {
    runFullMatchLifecycleReliabilityTest().catch(() => {});
  }, 90_000);
  logger.info(
    {
      scanIntervalMs: SCAN_INTERVAL_MS,
      lookaheadHours: LOOKAHEAD_HOURS,
      maxActiveFixtures: MAX_ACTIVE_FIXTURES,
      postMatchGraceHours: POST_MATCH_GRACE_HOURS,
    },
    "full match lifecycle reliability test started",
  );
}

export function stopFullMatchLifecycleReliabilityTest() {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
  started = false;
}

export function getFullMatchLifecycleReliabilityStatus() {
  return {
    enabled: ENABLED,
    started,
    running,
    scanIntervalMs: SCAN_INTERVAL_MS,
    lookaheadHours: LOOKAHEAD_HOURS,
    maxActiveFixtures: MAX_ACTIVE_FIXTURES,
    postMatchGraceHours: POST_MATCH_GRACE_HOURS,
    lastRunAt,
    lastResult,
    lastError,
  };
}

export async function getFullMatchLifecycleReliabilityReport(limit = 30) {
  const safeLimit = clamp(limit, 1, 100);
  const [summary, fixtures, runs] = await Promise.all([
    pool.query(
      `SELECT verdict, COUNT(*)::int AS count
         FROM lifecycle_reliability_fixtures
        GROUP BY verdict`,
    ),
    pool.query(
      `SELECT fixture_id, league_id, home_team, away_team, kickoff_at, enrolled_at,
              first_checkpoint, lifecycle_status, reliability_score, completion_pct,
              verdict, missing_required_json, advisory_json, stage_json,
              last_evaluated_at, completed_at
         FROM lifecycle_reliability_fixtures
        ORDER BY CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END, kickoff_at ASC
        LIMIT $1`,
      [safeLimit],
    ),
    pool.query(
      `SELECT id, started_at, finished_at, status, fixtures_evaluated,
              collecting_count, passed_count, warning_count, failed_count,
              football_quota_json, odds_quota_json, audit_worker_json,
              market_sampler_json, error_message
         FROM lifecycle_reliability_runs
        ORDER BY started_at DESC
        LIMIT 10`,
    ),
  ]);

  const counts = Object.fromEntries(summary.rows.map((row) => [String(row.verdict), Number(row.count)]));
  const completedCount = Number(counts.pass ?? 0) + Number(counts.warning ?? 0) + Number(counts.failed ?? 0);
  const overallStatus = Number(counts.failed ?? 0) > 0
    ? "failed"
    : Number(counts.warning ?? 0) > 0
      ? "warning"
      : completedCount > 0
        ? "passing"
        : "collecting";

  return {
    generatedAt: new Date().toISOString(),
    overallStatus,
    worker: getFullMatchLifecycleReliabilityStatus(),
    scope: {
      realFixturesOnly: true,
      simulatedData: false,
      bookmakerOddsAffectCorePrediction: false,
      requiredPrematchCheckpoints: ["72h", "48h", "24h", "6h", "90m", "15m"],
      requiredLiveCheckpoints: [15, 30, 45, 60, 75, 90],
      verifies: [
        "early prediction",
        "prematch refinement",
        "lineups/circumstances",
        "live prediction checkpoints",
        "live deep stats",
        "final result settlement",
        "immutable audit settlement",
        "learning-input readiness",
      ],
      advisoryOnly: ["bookmaker market snapshot coverage", "player-factor coverage"],
    },
    counts: {
      collecting: Number(counts.collecting ?? 0),
      pass: Number(counts.pass ?? 0),
      warning: Number(counts.warning ?? 0),
      failed: Number(counts.failed ?? 0),
    },
    currentTelemetry: {
      apiFootball: getQuotaOptimizationStatus(),
      oddsApi: getOddsOptimizationStatus(),
      predictionAudit: getPredictionAccuracyAuditStatus(),
      marketSampler: getFutureMarketSamplerStatus(),
    },
    fixtures: fixtures.rows.map((row) => ({
      ...row,
      fixture_id: Number(row.fixture_id),
      league_id: row.league_id == null ? null : Number(row.league_id),
      league: row.league_id == null ? null : getTrackedCompetition(Number(row.league_id))?.name ?? `League ${row.league_id}`,
      reliability_score: row.reliability_score == null ? null : Number(row.reliability_score),
      completion_pct: row.completion_pct == null ? null : Number(row.completion_pct),
    })),
    recentRuns: runs.rows,
  };
}

export async function getFullMatchLifecycleFixtureReport(fixtureId: number) {
  const fixture = await pool.query(
    `SELECT * FROM lifecycle_reliability_fixtures WHERE fixture_id = $1 LIMIT 1`,
    [fixtureId],
  );
  if (!fixture.rows.length) return null;

  const [audits, outcome, deepStats, marketOdds, circumstances, players, snapshots] = await Promise.all([
    pool.query(
      `SELECT checkpoint, phase, minute, data_tier, model_version, engine_revision,
              home_win_prob, draw_prob, away_win_prob, predicted_outcome,
              pick_confidence, captured_at, settled_at, actual_outcome, correct,
              brier_score, log_loss
         FROM prediction_audit_records
        WHERE fixture_id = $1
          AND (phase <> 'prematch' OR captured_at < kickoff_at)
        ORDER BY captured_at ASC`,
      [fixtureId],
    ),
    pool.query(`SELECT * FROM match_outcomes WHERE fixture_id = $1`, [fixtureId]),
    pool.query(
      `SELECT id, status, minute, score_home, score_away, home_xg, away_xg,
              home_momentum, away_momentum, collected_at
         FROM deep_match_stats WHERE fixture_id = $1 ORDER BY collected_at ASC`,
      [fixtureId],
    ),
    pool.query(
      `SELECT bookmaker_key, bookmaker_name, home_odds, draw_odds, away_odds,
              capture_bucket, observed_at
         FROM market_odds_snapshots WHERE fixture_id = $1 ORDER BY observed_at ASC`,
      [fixtureId],
    ),
    pool.query(
      `SELECT status, minute, home_starting_xi_count, away_starting_xi_count,
              home_missing_players, away_missing_players,
              circumstance_score_home, circumstance_score_away,
              collected_at, updated_at
         FROM match_circumstances WHERE fixture_id = $1`,
      [fixtureId],
    ),
    pool.query(
      `SELECT team_side, player_name, role, starter, rating, minutes,
              goals, assists, influence_score, collected_at
         FROM player_match_factors WHERE fixture_id = $1 ORDER BY team_side, influence_score DESC NULLS LAST`,
      [fixtureId],
    ),
    pool.query(
      `SELECT minute, status, home_win_prob, draw_prob, away_win_prob,
              confidence, created_at
         FROM prediction_snapshots WHERE fixture_id = $1 ORDER BY created_at ASC`,
      [fixtureId],
    ),
  ]);

  return {
    fixture: fixture.rows[0],
    evidence: {
      predictionAudit: audits.rows,
      outcome: outcome.rows[0] ?? null,
      deepStats: deepStats.rows,
      marketOdds: marketOdds.rows,
      circumstances: circumstances.rows,
      playerFactors: players.rows,
      predictionSnapshots: snapshots.rows,
    },
  };
}
