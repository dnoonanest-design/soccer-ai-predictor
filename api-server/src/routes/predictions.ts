import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { getFuturePredictionBaselineStatus } from "../lib/futurePredictionBaselineService";

const router = Router();
const DAY_MS = 24 * 60 * 60_000;

function validDateKey(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dayRange(key: string) {
  const start = new Date(`${key}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function predictedOutcome(home: number, draw: number, away: number) {
  if (home >= draw && home >= away) return "home";
  if (away >= home && away >= draw) return "away";
  return "draw";
}

async function readPredictions(start: Date, end: Date) {
  const result = await pool.query(
    `WITH latest_audit AS (
       SELECT DISTINCT ON (fixture_id)
         fixture_id, league_id, home_team, away_team, kickoff_at,
         checkpoint, data_tier, model_version, engine_revision,
         home_win_prob, draw_prob, away_win_prob,
         over25_prob, btts_prob, home_xg, away_xg,
         confidence, pick_confidence, confidence_band,
         predicted_outcome, captured_at
       FROM prediction_audit_records
       WHERE phase = 'prematch'
         AND kickoff_at >= $1
         AND kickoff_at < $2
       ORDER BY fixture_id, captured_at DESC
     ),
     latest_stored AS (
       SELECT DISTINCT ON (fixture_id)
         fixture_id, league_id, home_team, away_team, kickoff_at,
         home_win_prob, draw_prob, away_win_prob,
         model_version, updated_at
       FROM match_predictions
       WHERE is_live = FALSE
         AND kickoff_at >= $1
         AND kickoff_at < $2
       ORDER BY fixture_id, updated_at DESC
     )
     SELECT
       COALESCE(a.fixture_id, s.fixture_id) AS fixture_id,
       COALESCE(a.league_id, s.league_id) AS league_id,
       COALESCE(a.home_team, s.home_team) AS home_team,
       COALESCE(a.away_team, s.away_team) AS away_team,
       COALESCE(a.kickoff_at, s.kickoff_at) AS kickoff_at,
       CASE WHEN s.updated_at IS NOT NULL AND (a.captured_at IS NULL OR s.updated_at > a.captured_at)
            THEN s.home_win_prob ELSE a.home_win_prob END AS home_win_prob,
       CASE WHEN s.updated_at IS NOT NULL AND (a.captured_at IS NULL OR s.updated_at > a.captured_at)
            THEN s.draw_prob ELSE a.draw_prob END AS draw_prob,
       CASE WHEN s.updated_at IS NOT NULL AND (a.captured_at IS NULL OR s.updated_at > a.captured_at)
            THEN s.away_win_prob ELSE a.away_win_prob END AS away_win_prob,
       a.over25_prob,
       a.btts_prob,
       a.home_xg,
       a.away_xg,
       a.confidence,
       a.pick_confidence,
       a.confidence_band,
       a.checkpoint,
       a.data_tier,
       COALESCE(a.model_version, s.model_version) AS model_version,
       a.engine_revision,
       CASE WHEN s.updated_at IS NOT NULL AND (a.captured_at IS NULL OR s.updated_at > a.captured_at)
            THEN 'current_prediction' ELSE 'audit_checkpoint' END AS source,
       GREATEST(COALESCE(a.captured_at, '-infinity'::timestamp), COALESCE(s.updated_at, '-infinity'::timestamp)) AS generated_at
     FROM latest_audit a
     FULL OUTER JOIN latest_stored s USING (fixture_id)
     ORDER BY COALESCE(a.kickoff_at, s.kickoff_at), COALESCE(a.fixture_id, s.fixture_id)`,
    [start, end],
  );

  return result.rows.map((row) => {
    const home = Number(row.home_win_prob ?? 0);
    const draw = Number(row.draw_prob ?? 0);
    const away = Number(row.away_win_prob ?? 0);
    const kickoff = row.kickoff_at ? new Date(row.kickoff_at) : null;
    return {
      fixture_id: Number(row.fixture_id),
      league_id: row.league_id == null ? null : Number(row.league_id),
      home_team: String(row.home_team),
      away_team: String(row.away_team),
      kickoff: kickoff?.toISOString() ?? null,
      date: kickoff ? dateKey(kickoff) : null,
      prediction: {
        home_win: home,
        draw,
        away_win: away,
        predicted_outcome: predictedOutcome(home, draw, away),
        over_25: row.over25_prob == null ? null : Number(row.over25_prob),
        btts: row.btts_prob == null ? null : Number(row.btts_prob),
        home_xg: row.home_xg == null ? null : Number(row.home_xg),
        away_xg: row.away_xg == null ? null : Number(row.away_xg),
        confidence: row.confidence == null ? null : Number(row.confidence),
        pick_confidence: row.pick_confidence == null ? Math.max(home, draw, away) : Number(row.pick_confidence),
        confidence_band: row.confidence_band ?? null,
      },
      checkpoint: row.checkpoint ?? null,
      data_tier: row.data_tier ?? null,
      model_version: row.model_version ?? null,
      engine_revision: row.engine_revision ?? null,
      source: row.source,
      generated_at: row.generated_at ? new Date(row.generated_at).toISOString() : null,
    };
  });
}

function grouped(fixtures: any[]) {
  return fixtures.reduce<Record<string, any[]>>((acc, fixture) => {
    const key = fixture.date ?? "unknown";
    (acc[key] ??= []).push(fixture);
    return acc;
  }, {});
}

async function sendRange(res: any, start: Date, end: Date, label: string) {
  try {
    const fixtures = await readPredictions(start, end);
    return res.json({
      label,
      start: start.toISOString(),
      end: end.toISOString(),
      count: fixtures.length,
      fixtures,
      fixtures_by_date: grouped(fixtures),
      baseline_worker: getFuturePredictionBaselineStatus(),
      note: "Read-only model output. No bookmaker or external prediction data is used to generate these probabilities.",
    });
  } catch (err) {
    logger.error({ err, start, end }, "prediction read API failed");
    return res.status(500).json({ error: "Failed to fetch stored predictions" });
  }
}

router.get("/predictions/today", async (_req, res) => {
  const key = dateKey(new Date());
  const { start, end } = dayRange(key);
  return sendRange(res, start, end, key);
});

router.get("/predictions/tomorrow", async (_req, res) => {
  const key = dateKey(new Date(Date.now() + DAY_MS));
  const { start, end } = dayRange(key);
  return sendRange(res, start, end, key);
});

router.get("/predictions/date/:date", async (req, res) => {
  const key = String(req.params.date ?? "");
  if (!validDateKey(key)) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD" });
  }
  const { start, end } = dayRange(key);
  return sendRange(res, start, end, key);
});

router.get("/predictions/upcoming", async (req, res) => {
  const rawDays = Number(req.query.days ?? 3);
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(7, Math.floor(rawDays))) : 3;
  const start = new Date();
  const end = new Date(start.getTime() + days * DAY_MS);
  return sendRange(res, start, end, `next-${days}-days`);
});

router.get("/predictions/baseline/status", (_req, res) => {
  return res.json(getFuturePredictionBaselineStatus());
});

export default router;
