import { Router } from "express";
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

    // Settlement is database-only: if the normal outcome collector has already
    // written a final result, make it visible immediately instead of waiting for
    // the next 15-minute audit-worker pass.
    await settlePredictionAuditRecords();
    const report = await getPredictionAccuracyAuditReport();

    // The ledger is a results view. Newly captured future predictions can be far
    // more numerous than recently settled rows, so a pure captured-at sort can
    // make every visible row look Pending even when results are already settled.
    // Keep settled rows first, newest settlement/capture first, then pending rows.
    const recent = [...report.recent].sort((a: any, b: any) => {
      const aSettled = a.settled_at != null;
      const bSettled = b.settled_at != null;
      if (aSettled !== bSettled) return aSettled ? -1 : 1;
      const aTime = new Date(a.settled_at ?? a.captured_at).getTime();
      const bTime = new Date(b.settled_at ?? b.captured_at).getTime();
      return bTime - aTime;
    });

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
