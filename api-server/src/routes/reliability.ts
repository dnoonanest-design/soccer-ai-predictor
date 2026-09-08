import { Router } from "express";
import { logger } from "../lib/logger";
import {
  getFullMatchLifecycleFixtureReport,
  getFullMatchLifecycleReliabilityReport,
  getFullMatchLifecycleReliabilityStatus,
  runFullMatchLifecycleReliabilityTest,
} from "../lib/fullMatchLifecycleReliabilityService";

const router = Router();

router.get("/reliability/full-match/status", (_req, res) => {
  return res.json(getFullMatchLifecycleReliabilityStatus());
});

router.get("/reliability/full-match", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 30);
    return res.json(await getFullMatchLifecycleReliabilityReport(limit));
  } catch (err) {
    logger.error({ err }, "full match lifecycle reliability report failed");
    return res.status(500).json({ error: "Failed to fetch full match lifecycle reliability report" });
  }
});

router.get("/reliability/full-match/:fixture_id", async (req, res) => {
  try {
    const fixtureId = Number(req.params.fixture_id);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return res.status(400).json({ error: "Invalid fixture ID" });
    }
    const report = await getFullMatchLifecycleFixtureReport(fixtureId);
    if (!report) return res.status(404).json({ error: "Fixture is not enrolled in the lifecycle reliability test" });
    return res.json(report);
  } catch (err) {
    logger.error({ err }, "full match lifecycle fixture report failed");
    return res.status(500).json({ error: "Failed to fetch fixture lifecycle reliability report" });
  }
});

router.post("/reliability/full-match/run", async (_req, res) => {
  try {
    return res.status(202).json(await runFullMatchLifecycleReliabilityTest());
  } catch (err) {
    logger.error({ err }, "manual full match lifecycle reliability run failed");
    return res.status(500).json({ error: "Failed to run full match lifecycle reliability test" });
  }
});

export default router;
