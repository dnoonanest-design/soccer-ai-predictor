import { Router } from "express";
import { logger } from "../lib/logger";
import { getAiAwarenessReport, runAiAwarenessCycle } from "../lib/aiAwareLearningService";
import { generateBiweeklyAiUpdate, getAiMemoryUpdateReport } from "../lib/aiMemoryUpdateService";

const router = Router();

router.get("/ai/status", async (_req, res) => {
  try { return res.json(await getAiAwarenessReport()); }
  catch (err) { logger.error({ err }, "AI awareness report failed"); return res.status(500).json({ error: "Failed to fetch AI awareness report" }); }
});

router.post("/ai/run-learning-cycle", async (_req, res) => {
  try { return res.status(202).json(await runAiAwarenessCycle()); }
  catch (err) { logger.error({ err }, "AI awareness cycle failed"); return res.status(500).json({ error: "Failed to run AI learning cycle" }); }
});


router.get("/ai/memory", async (_req, res) => {
  try { return res.json(await getAiMemoryUpdateReport()); }
  catch (err) { logger.error({ err }, "AI memory report failed"); return res.status(500).json({ error: "Failed to fetch AI memory report" }); }
});

router.post("/ai/generate-biweekly-update", async (req, res) => {
  try { return res.status(202).json(await generateBiweeklyAiUpdate({ force: req.query.force === "true" || req.body?.force === true })); }
  catch (err) { logger.error({ err }, "AI biweekly update failed"); return res.status(500).json({ error: "Failed to generate AI biweekly update" }); }
});

export default router;
