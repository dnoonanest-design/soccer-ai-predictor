import { Router } from "express";
import { getAccuracyStats } from "../lib/predictionStore";
import {
  getPredictionAccuracyAuditReport,
  getPredictionAccuracyAuditStatus,
} from "../lib/predictionAccuracyAuditService";
import { getDailyPredictionScorecard } from "../lib/dailyPredictionScorecardService";
import { logger } from "../lib/logger";

const router = Router();

router.get("/accuracy", async (_req, res) => {
  try {
    const stats = await getAccuracyStats();
    return res.json(stats);
  } catch (err) {
    logger.error({ err }, "Failed to fetch accuracy stats");
    return res.status(500).json({ error: "Failed to fetch accuracy stats" });
  }
});

router.get("/accuracy/audit", async (_req, res) => {
  try {
    const report = await getPredictionAccuracyAuditReport();
    return res.json(report);
  } catch (err) {
    logger.error({ err }, "Failed to fetch prediction accuracy audit");
    return res.status(500).json({ error: "Failed to fetch prediction accuracy audit" });
  }
});

router.get("/accuracy/daily", async (req, res) => {
  try {
    const date = req.query.date == null ? undefined : String(req.query.date);
    const report = await getDailyPredictionScorecard(date);
    return res.json(report);
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch daily prediction scorecard");
    const message = String(err?.message ?? err);
    return res.status(message.includes("YYYY-MM-DD") ? 400 : 500).json({
      error: message.includes("YYYY-MM-DD") ? message : "Failed to fetch daily prediction scorecard",
    });
  }
});

router.get("/accuracy/audit/status", (_req, res) => {
  return res.json(getPredictionAccuracyAuditStatus());
});

export default router;
