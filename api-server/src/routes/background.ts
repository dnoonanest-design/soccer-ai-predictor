import { Router } from "express";
import { logger } from "../lib/logger";
import { getBackgroundLearnerStatus, runAutomaticRecalibration, runBiweeklyAiUpdate, runFinishedSettlement, runLiveDeepStatCollection } from "../lib/backgroundLearnerService";
import { analyzeCircumstanceInfluence, getCircumstanceLearningReport } from "../lib/circumstanceLearningService";
import { requireAdminKey, adminRateLimit } from "../lib/security";

const router = Router();

router.get("/background/status", async (_req, res) => {
  try { return res.json(await getBackgroundLearnerStatus()); }
  catch (err) { logger.error({ err }, "background status failed"); return res.status(500).json({ error: "Failed to fetch background learner status" }); }
});

router.post("/background/run/live", requireAdminKey, adminRateLimit, async (_req, res) => {
  try { return res.status(202).json(await runLiveDeepStatCollection()); }
  catch (err) { logger.error({ err }, "manual live learner failed"); return res.status(500).json({ error: "Failed to run live deep-stat collection" }); }
});

router.post("/background/run/settle", requireAdminKey, adminRateLimit, async (_req, res) => {
  try { return res.status(202).json(await runFinishedSettlement()); }
  catch (err) { logger.error({ err }, "manual settlement failed"); return res.status(500).json({ error: "Failed to settle finished matches" }); }
});

router.post("/background/run/recalibrate", requireAdminKey, adminRateLimit, async (_req, res) => {
  try { return res.status(202).json(await runAutomaticRecalibration()); }
  catch (err) { logger.error({ err }, "manual recalibration failed"); return res.status(500).json({ error: "Failed to recalibrate model" }); }
});



router.post("/background/run/biweekly-ai-update", requireAdminKey, adminRateLimit, async (req, res) => {
  try { return res.status(202).json(await runBiweeklyAiUpdate(req.query.force === "true" || req.body?.force === true)); }
  catch (err) { logger.error({ err }, "manual biweekly AI update failed"); return res.status(500).json({ error: "Failed to generate biweekly AI update" }); }
});

router.get("/background/circumstance-learning", async (_req, res) => {
  try { return res.json(await getCircumstanceLearningReport()); }
  catch (err) { logger.error({ err }, "circumstance learning report failed"); return res.status(500).json({ error: "Failed to fetch circumstance learning report" }); }
});

router.post("/background/run/circumstance-analysis", requireAdminKey, adminRateLimit, async (_req, res) => {
  try { return res.status(202).json(await analyzeCircumstanceInfluence()); }
  catch (err) { logger.error({ err }, "manual circumstance analysis failed"); return res.status(500).json({ error: "Failed to analyse circumstance influence" }); }
});

export default router;
