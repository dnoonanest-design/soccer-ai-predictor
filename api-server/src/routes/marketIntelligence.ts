import { Router } from "express";
import { logger } from "../lib/logger";
import {
  getFixtureMarketIntelligence,
  getMarketIntelligenceReport,
  MARKET_INTELLIGENCE_POLICY,
} from "../lib/marketIntelligenceService";
import { getFutureMarketSamplerStatus } from "../lib/futureMarketSamplerService";

const router = Router();

router.get("/market-intelligence/policy", (_req, res) => {
  return res.json(MARKET_INTELLIGENCE_POLICY);
});

router.get("/market-intelligence/sampler-status", (_req, res) => {
  return res.json(getFutureMarketSamplerStatus());
});

router.get("/market-intelligence/report", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 10_000);
    return res.json(await getMarketIntelligenceReport(limit));
  } catch (err) {
    logger.error({ err }, "market intelligence report failed");
    return res.status(500).json({ error: "Failed to build market intelligence report" });
  }
});

router.get("/market-intelligence/fixture/:fixtureId", async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
    return res.status(400).json({ error: "Invalid fixture id" });
  }

  try {
    return res.json(await getFixtureMarketIntelligence(fixtureId));
  } catch (err) {
    logger.error({ err, fixtureId }, "fixture market intelligence failed");
    return res.status(500).json({ error: "Failed to fetch fixture market intelligence" });
  }
});

export default router;
