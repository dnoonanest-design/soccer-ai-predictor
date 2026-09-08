import { Router } from "express";
import { pool } from "@workspace/db";
import { getTrackedCompetition, isTrackedLeague } from "../lib/leagueConfig";
import { logger } from "../lib/logger";

const router = Router();
const MAX_DAYS = 7;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function clampDays(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(MAX_DAYS, Math.floor(parsed)));
}

function asNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayKey(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * Fast read path for fixture-list screens and conversational requests.
 *
 * The accuracy worker has already paid the cost of gathering team/player data and
 * computing the model. This endpoint therefore performs one Postgres query and
 * returns the newest internally-generated prediction per fixture instead of
 * recalculating every match (and repeating API-Football calls) on each request.
 *
 * No bookmaker odds, market probabilities or external prediction sources are
 * read here. The response is entirely from prediction_audit_records generated
 * by our own statistical predictor.
 */
router.get("/predictions/daily", async (req, res) => {
  const requestedDate = req.query.date ?? new Date().toISOString().slice(0, 10);
  if (!validDate(requestedDate)) {
    return res.status(400).json({ error: "date must use YYYY-MM-DD" });
  }

  const days = clampDays(req.query.days);
  const start = new Date(`${requestedDate}T00:00:00.000Z`);
  const end = new Date(start.getTime() + days * 24 * 60 * 60_000);

  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (fixture_id)
          fixture_id, league_id, home_team, away_team, kickoff_at,
          phase, checkpoint, minute, data_tier, model_version, engine_revision,
          home_win_prob, draw_prob, away_win_prob, over25_prob, btts_prob,
          home_xg, away_xg, confidence, pick_confidence, confidence_band,
          predicted_outcome, captured_at
         FROM prediction_audit_records
        WHERE kickoff_at >= $1
          AND kickoff_at < $2
          AND phase = 'prematch'
        ORDER BY fixture_id, captured_at DESC`,
      [start, end],
    );

    const grouped: Record<string, unknown[]> = {};
    for (let i = 0; i < days; i++) {
      const key = new Date(start.getTime() + i * 24 * 60 * 60_000).toISOString().slice(0, 10);
      grouped[key] = [];
    }

    for (const row of result.rows) {
      const leagueId = Number(row.league_id);
      if (!Number.isInteger(leagueId) || !isTrackedLeague(leagueId)) continue;
      const date = dayKey(row.kickoff_at);
      if (!date || !grouped[date]) continue;
      const competition = getTrackedCompetition(leagueId);
      const home = asNumber(row.home_win_prob) ?? 0;
      const draw = asNumber(row.draw_prob) ?? 0;
      const away = asNumber(row.away_win_prob) ?? 0;
      const capturedAt = row.captured_at instanceof Date
        ? row.captured_at.toISOString()
        : new Date(row.captured_at).toISOString();

      grouped[date].push({
        fixture_id: Number(row.fixture_id),
        kickoff: row.kickoff_at instanceof Date
          ? row.kickoff_at.toISOString()
          : new Date(row.kickoff_at).toISOString(),
        league: {
          id: leagueId,
          name: competition?.name ?? `League ${leagueId}`,
          country: competition?.country ?? null,
        },
        home_team: String(row.home_team),
        away_team: String(row.away_team),
        prediction: {
          home_win: home,
          draw,
          away_win: away,
          predicted_outcome: String(row.predicted_outcome ?? ""),
          pick_confidence: asNumber(row.pick_confidence),
          confidence: asNumber(row.confidence),
          confidence_band: row.confidence_band ?? null,
          over_25: asNumber(row.over25_prob),
          btts: asNumber(row.btts_prob),
          home_xg: asNumber(row.home_xg),
          away_xg: asNumber(row.away_xg),
        },
        freshness: {
          checkpoint: String(row.checkpoint),
          data_tier: String(row.data_tier),
          model_version: String(row.model_version),
          engine_revision: String(row.engine_revision),
          captured_at: capturedAt,
          age_seconds: Math.max(0, Math.round((Date.now() - new Date(capturedAt).getTime()) / 1000)),
        },
      });
    }

    for (const list of Object.values(grouped)) {
      list.sort((a: any, b: any) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime());
    }

    const count = Object.values(grouped).reduce((sum, list) => sum + list.length, 0);
    res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=60");
    return res.json({
      date: requestedDate,
      days,
      count,
      predictions_by_date: grouped,
      source: "internal-statistical-predictor",
      bookmaker_data_used: false,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, requestedDate, days }, "fast daily predictions query failed");
    return res.status(500).json({ error: "Failed to fetch daily predictions" });
  }
});

export default router;
