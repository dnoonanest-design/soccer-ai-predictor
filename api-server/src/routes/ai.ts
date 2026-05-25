import { Router } from "express";
import { logger } from "../lib/logger";
import { getAiAwarenessReport, runAiAwarenessCycle } from "../lib/aiAwareLearningService";
import { generateBiweeklyAiUpdate, getAiMemoryUpdateReport } from "../lib/aiMemoryUpdateService";
import { runAdaptiveLearningCycle, getAdaptiveLearningReport, explainPrediction, explainRecentPredictions, getOfflineFallbackModel } from "../lib/adaptiveLearningEngine";
import { requireAdminKey, adminRateLimit, safeInt } from "../lib/security";

const router = Router();

router.get("/ai/status", async (_req, res) => {
  try { return res.json(await getAiAwarenessReport()); }
  catch (err) { logger.error({ err }, "AI awareness report failed"); return res.status(500).json({ error: "Failed to fetch AI awareness report" }); }
});

router.post("/ai/run-learning-cycle", requireAdminKey, adminRateLimit, async (_req, res) => {
  try { return res.status(202).json(await runAiAwarenessCycle()); }
  catch (err) { logger.error({ err }, "AI awareness cycle failed"); return res.status(500).json({ error: "Failed to run AI learning cycle" }); }
});


router.get("/ai/memory", async (_req, res) => {
  try { return res.json(await getAiMemoryUpdateReport()); }
  catch (err) { logger.error({ err }, "AI memory report failed"); return res.status(500).json({ error: "Failed to fetch AI memory report" }); }
});

router.post("/ai/generate-biweekly-update", requireAdminKey, adminRateLimit, async (req, res) => {
  try { return res.status(202).json(await generateBiweeklyAiUpdate({ force: req.query.force === "true" || req.body?.force === true })); }
  catch (err) { logger.error({ err }, "AI biweekly update failed"); return res.status(500).json({ error: "Failed to generate AI biweekly update" }); }
});

router.get("/ai/adaptive/report", async (_req, res) => {
  try { return res.json(await getAdaptiveLearningReport()); }
  catch (err) { logger.error({ err }, "adaptive learning report failed"); return res.status(500).json({ error: "Failed to fetch adaptive learning report" }); }
});

router.post("/ai/adaptive/run-cycle", requireAdminKey, adminRateLimit, async (_req, res) => {
  try { return res.status(202).json(await runAdaptiveLearningCycle()); }
  catch (err) { logger.error({ err }, "adaptive learning cycle failed"); return res.status(500).json({ error: "Failed to run adaptive learning cycle" }); }
});

router.get("/ai/adaptive/explain/:fixture_id", async (req, res) => {
  const fixtureId = safeInt(req.params.fixture_id, 1, 999_999_999);
  if (fixtureId === null) return res.status(400).json({ error: "Invalid fixture_id: must be a positive integer" });
  try {
    const explanation = await explainPrediction(fixtureId);
    if (!explanation) return res.status(404).json({ error: "No settled prediction found for this fixture" });
    return res.json(explanation);
  }
  catch (err) { logger.error({ err }, "prediction explanation failed"); return res.status(500).json({ error: "Failed to explain prediction" }); }
});

router.post("/ai/adaptive/explain-recent", requireAdminKey, adminRateLimit, async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
  try { return res.status(202).json(await explainRecentPredictions(limit)); }
  catch (err) { logger.error({ err }, "bulk explanation failed"); return res.status(500).json({ error: "Failed to explain recent predictions" }); }
});

router.get("/ai/adaptive/offline-model", async (_req, res) => {
  try { return res.json(await getOfflineFallbackModel()); }
  catch (err) { logger.error({ err }, "offline model fetch failed"); return res.status(500).json({ error: "Failed to fetch offline fallback model" }); }
});

export default router;
