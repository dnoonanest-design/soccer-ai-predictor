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
    WITH recent_settled AS (
      SELECT id, fixture_id, league_id, home_team, away_team, kickoff_at,
             phase, checkpoint, data_tier, model_version, engine_revision,
             home_win_prob, draw_prob, away_win_prob, predicted_outcome,
             pick_confidence, confidence_band, actual_outcome, score_home, score_away,
             correct, brier_score, log_loss, over25_correct, btts_correct,
             captured_at, settled_at, audit_signature, signature_version,
             settlement_signature
        FROM prediction_audit_records
       WHERE settled_at IS NOT NULL
       ORDER BY settled_at DESC, captured_at DESC
       LIMIT 20
    ), recent_pending AS (
      SELECT id, fixture_id, league_id, home_team, away_team, kickoff_at,
             phase, checkpoint, data_tier, model_version, engine_revision,
             home_win_prob, draw_prob, away_win_prob, predicted_outcome,
             pick_confidence, confidence_band, actual_outcome, score_home, score_away,
             correct, brier_score, log_loss, over25_correct, btts_correct,
             captured_at, settled_at, audit_signature, signature_version,
             settlement_signature
        FROM prediction_audit_records
       WHERE settled_at IS NULL
       ORDER BY captured_at DESC
       LIMIT 20
    )
    SELECT * FROM recent_settled
    UNION ALL
    SELECT * FROM recent_pending
    ORDER BY settled_at DESC NULLS LAST, captured_at DESC
  `);

  return result.rows.map((row: any) => {
    const v3Sealed =
      row.signature_version === "hmac-sha256-v3" &&
      Boolean(row.audit_signature) &&
      (row.settled_at == null || Boolean(row.settlement_signature));
    return {
      ...row,
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

    // A results ledger must not be crowded out by newly captured future rows.
    // Always return a useful mix of the latest 20 settled results and 20 pending
    // checkpoints, with completed results first.
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
