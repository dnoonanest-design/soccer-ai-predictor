import { Router } from "express";
import { pool } from "@workspace/db";
import { getAccuracyStats } from "../lib/predictionStore";
import {
  getPredictionAccuracyAuditReport,
  getPredictionAccuracyAuditStatus,
  settlePredictionAuditRecords,
  verifyPredictionAuditIntegrity,
} from "../lib/predictionAccuracyAuditService";
import { getPerformanceIntelligenceReport } from "../lib/performanceIntelligenceService";
import { logger } from "../lib/logger";

const router = Router();

function disableCaching(res: any) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}

async function getBalancedRecentLedger(integrityStatus: string) {
  const result = await pool.query(`
    WITH settled_ranked AS (
      SELECT id, fixture_id, league_id, home_team, away_team, kickoff_at,
             phase, checkpoint, data_tier, model_version, engine_revision,
             home_win_prob, draw_prob, away_win_prob, predicted_outcome,
             pick_confidence, confidence_band, actual_outcome, score_home, score_away,
             correct, brier_score, log_loss, over25_correct, btts_correct,
             captured_at, settled_at, audit_signature, signature_version,
             settlement_signature,
             ROW_NUMBER() OVER (
               PARTITION BY fixture_id
               ORDER BY captured_at DESC, id DESC
             ) AS fixture_rank
        FROM prediction_audit_records
       WHERE settled_at IS NOT NULL
    ), pending_ranked AS (
      SELECT id, fixture_id, league_id, home_team, away_team, kickoff_at,
             phase, checkpoint, data_tier, model_version, engine_revision,
             home_win_prob, draw_prob, away_win_prob, predicted_outcome,
             pick_confidence, confidence_band, actual_outcome, score_home, score_away,
             correct, brier_score, log_loss, over25_correct, btts_correct,
             captured_at, settled_at, audit_signature, signature_version,
             settlement_signature,
             ROW_NUMBER() OVER (
               PARTITION BY fixture_id
               ORDER BY captured_at DESC, id DESC
             ) AS fixture_rank
        FROM prediction_audit_records
       WHERE settled_at IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM prediction_audit_records settled
            WHERE settled.fixture_id = prediction_audit_records.fixture_id
              AND settled.settled_at IS NOT NULL
         )
    ), recent_settled AS (
      SELECT * FROM settled_ranked
       WHERE fixture_rank = 1
       ORDER BY settled_at DESC, captured_at DESC
       LIMIT 20
    ), recent_pending AS (
      SELECT * FROM pending_ranked
       WHERE fixture_rank = 1
       ORDER BY kickoff_at ASC NULLS LAST, captured_at DESC
       LIMIT 20
    )
    SELECT * FROM (
      SELECT * FROM recent_settled
      UNION ALL
      SELECT * FROM recent_pending
    ) ledger
    ORDER BY (settled_at IS NULL), COALESCE(settled_at, captured_at) DESC
  `);

  return result.rows.map((row: any) => {
    const { fixture_rank: _fixtureRank, ...publicRow } = row;
    const v3Sealed =
      row.signature_version === "hmac-sha256-v3" &&
      Boolean(row.audit_signature) &&
      (row.settled_at == null || Boolean(row.settlement_signature));
    return {
      ...publicRow,
      id: Number(row.id),
      fixture_id: Number(row.fixture_id),
      league_id: row.league_id == null ? null : Number(row.league_id),
      pick_confidence: row.pick_confidence == null ? null : Number(row.pick_confidence),
      brier_score: row.brier_score == null ? null : Number(row.brier_score),
      log_loss: row.log_loss == null ? null : Number(row.log_loss),
      integrity_status:
        integrityStatus === "verified" && v3Sealed
          ? "verified"
          : row.audit_signature
            ? "legacy-signed"
            : "legacy-unsigned",
    };
  });
}

router.get("/accuracy", async (_req, res) => {
  try {
    disableCaching(res);
    const stats = await getAccuracyStats();
    return res.json(stats);
  } catch (err) {
    logger.error({ err }, "Failed to fetch accuracy stats");
    return res.status(500).json({ error: "Failed to fetch accuracy stats" });
  }
});

router.get("/accuracy/audit", async (_req, res) => {
  try {
    disableCaching(res);

    // This is database-only. If a final outcome is already stored, expose it
    // immediately instead of waiting for the next scheduled audit pass.
    await settlePredictionAuditRecords();
    const report = await getPredictionAccuracyAuditReport();

    // The public Performance ledger is fixture-level. The underlying audit keeps
    // every checkpoint for calibration, but users should see each match once.
    const recent = await getBalancedRecentLedger(report.integrity.status);
    return res.json({ ...report, recent });
  } catch (err) {
    logger.error({ err }, "Failed to fetch prediction accuracy audit");
    return res.status(500).json({ error: "Failed to fetch prediction accuracy audit" });
  }
});

router.get("/accuracy/performance", async (req, res) => {
  try {
    disableCaching(res);
    const days = Number(req.query.days ?? 14);
    const report = await getPerformanceIntelligenceReport(days);
    return res.json(report);
  } catch (err) {
    logger.error({ err }, "Failed to fetch performance intelligence report");
    return res.status(500).json({ error: "Failed to fetch performance intelligence report" });
  }
});

router.get("/accuracy/audit/status", (_req, res) => {
  disableCaching(res);
  return res.json(getPredictionAccuracyAuditStatus());
});

router.get("/accuracy/audit/integrity", async (_req, res) => {
  try {
    disableCaching(res);
    const result = await verifyPredictionAuditIntegrity();
    const { validIds: _validIds, ...publicResult } = result;
    return res.json(publicResult);
  } catch (err) {
    logger.error({ err }, "Failed to verify prediction audit integrity");
    return res.status(500).json({ error: "Failed to verify prediction audit integrity" });
  }
});

export default router;
