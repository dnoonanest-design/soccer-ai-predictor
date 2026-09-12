import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { getFuturePredictionBaselineStatus } from "../lib/futurePredictionBaselineService";
import { getTrackedCompetition, isTrackedLeague } from "../lib/leagueConfig";

const router = Router();
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_PREDICTION_TIME_ZONE = "Europe/Dublin";

function resolvePredictionTimeZone() {
  const configured = String(process.env.PREDICTION_TIME_ZONE ?? DEFAULT_PREDICTION_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: configured }).format(new Date());
    return configured;
  } catch {
    logger.warn({ configured }, "invalid PREDICTION_TIME_ZONE; falling back to Europe/Dublin");
    return DEFAULT_PREDICTION_TIME_ZONE;
  }
}

const PREDICTION_TIME_ZONE = resolvePredictionTimeZone();
const zonedDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: PREDICTION_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const zonedDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: PREDICTION_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function validDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formatterParts(formatter: Intl.DateTimeFormat, date: Date) {
  return formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
}

function dateKey(date: Date) {
  const parts = formatterParts(zonedDateFormatter, date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(key: string, days: number) {
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function timeZoneOffsetMs(date: Date) {
  const parts = formatterParts(zonedDateTimeFormatter, date);
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return representedAsUtc - date.getTime();
}

function zonedMidnightUtc(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  let candidateMs = localMidnightAsUtc - timeZoneOffsetMs(new Date(localMidnightAsUtc));
  const correctedOffset = timeZoneOffsetMs(new Date(candidateMs));
  candidateMs = localMidnightAsUtc - correctedOffset;

  return new Date(candidateMs);
}

function dayRange(key: string) {
  return {
    start: zonedMidnightUtc(key),
    end: zonedMidnightUtc(addDaysToDateKey(key, 1)),
  };
}

/**
 * Prediction delivery must retain today's fixtures after kickoff. Using the
 * current instant as the lower bound caused a pre-match prediction to vanish
 * from `/predictions/upcoming` as soon as the match became live. This is
 * especially visible for UEFA fixtures, where the deliberately-disabled
 * domestic xG fallback cannot replace the opponent-adjusted baseline.
 */
export function upcomingPredictionRange(now: Date, days: number) {
  const startKey = dateKey(now);
  return {
    start: dayRange(startKey).start,
    end: zonedMidnightUtc(addDaysToDateKey(startKey, days)),
  };
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

  return result.rows
    .map((row) => {
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
    })
    .filter((fixture) => fixture.league_id != null && isTrackedLeague(fixture.league_id));
}

function grouped(fixtures: any[]) {
  return fixtures.reduce<Record<string, any[]>>((acc, fixture) => {
    const key = fixture.date ?? "unknown";
    (acc[key] ??= []).push(fixture);
    return acc;
  }, {});
}

function setStoredPredictionHeaders(res: any, queryMs?: number) {
  res.set("Cache-Control", "public, max-age=15, s-maxage=30, stale-while-revalidate=60");
  res.set("X-Prediction-Source", "stored-model-output");
  res.set("X-External-Provider-Requests", "0");
  res.set("X-Prediction-Time-Zone", PREDICTION_TIME_ZONE);
  if (queryMs != null) res.set("X-Prediction-Query-Ms", String(queryMs));
}

function compactPrediction(fixture: any) {
  const leagueId = Number(fixture.league_id);
  const competition = getTrackedCompetition(leagueId);
  const generatedAt = fixture.generated_at ? new Date(fixture.generated_at) : null;
  const ageSeconds = generatedAt && Number.isFinite(generatedAt.getTime())
    ? Math.max(0, Math.round((Date.now() - generatedAt.getTime()) / 1000))
    : null;

  return {
    fixture_id: fixture.fixture_id,
    kickoff: fixture.kickoff,
    league: {
      id: leagueId,
      name: competition?.name ?? `League ${leagueId}`,
      country: competition?.country ?? null,
    },
    home_team: fixture.home_team,
    away_team: fixture.away_team,
    prediction: {
      predicted_outcome: fixture.prediction.predicted_outcome,
      home_win: fixture.prediction.home_win,
      draw: fixture.prediction.draw,
      away_win: fixture.prediction.away_win,
      pick_confidence: fixture.prediction.pick_confidence,
      confidence_band: fixture.prediction.confidence_band,
    },
    freshness: {
      checkpoint: fixture.checkpoint,
      source: fixture.source,
      generated_at: fixture.generated_at,
      age_seconds: ageSeconds,
    },
  };
}

async function sendRange(res: any, start: Date, end: Date, label: string) {
  const queryStartedAt = Date.now();
  try {
    const fixtures = await readPredictions(start, end);
    const queryMs = Date.now() - queryStartedAt;
    setStoredPredictionHeaders(res, queryMs);
    return res.json({
      label,
      start: start.toISOString(),
      end: end.toISOString(),
      count: fixtures.length,
      fixtures,
      fixtures_by_date: grouped(fixtures),
      delivery: {
        source: "stored_model_output",
        external_provider_requests: 0,
        time_zone: PREDICTION_TIME_ZONE,
        query_ms: queryMs,
        cache_policy: "15s client / 30s shared / 60s stale-while-revalidate",
      },
      baseline_worker: getFuturePredictionBaselineStatus(),
      note: "Fast read-only stored model output. This request does not call API-Football, an odds provider, or an external prediction service.",
    });
  } catch (err) {
    logger.error({ err, start, end }, "prediction read API failed");
    return res.status(500).json({ error: "Failed to fetch stored predictions" });
  }
}

router.get("/predictions/today/quick", async (_req, res) => {
  const key = dateKey(new Date());
  const { start, end } = dayRange(key);
  const queryStartedAt = Date.now();

  try {
    const fixtures = await readPredictions(start, end);
    const predictions = fixtures.map(compactPrediction);
    const strongest = [...predictions]
      .sort((a, b) => Number(b.prediction.pick_confidence ?? 0) - Number(a.prediction.pick_confidence ?? 0))
      .slice(0, 5);
    const queryMs = Date.now() - queryStartedAt;

    setStoredPredictionHeaders(res, queryMs);
    return res.json({
      date: key,
      time_zone: PREDICTION_TIME_ZONE,
      count: predictions.length,
      predictions,
      strongest,
      delivery: {
        source: "stored_model_output",
        external_provider_requests: 0,
        query_ms: queryMs,
      },
    });
  } catch (err) {
    logger.error({ err, start, end }, "quick today prediction read failed");
    return res.status(500).json({ error: "Failed to fetch today's stored predictions" });
  }
});

router.get("/predictions/today", async (_req, res) => {
  const key = dateKey(new Date());
  const { start, end } = dayRange(key);
  return sendRange(res, start, end, key);
});

router.get("/predictions/tomorrow", async (_req, res) => {
  const key = addDaysToDateKey(dateKey(new Date()), 1);
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
  const rawDays = Number(req.query.days ?? 8);
  const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(14, Math.floor(rawDays))) : 8;
  const { start, end } = upcomingPredictionRange(new Date(), days);
  return sendRange(res, start, end, `next-${days}-days`);
});

router.get("/predictions/baseline/status", (_req, res) => {
  return res.json(getFuturePredictionBaselineStatus());
});

export default router;
