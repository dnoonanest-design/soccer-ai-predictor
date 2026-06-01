import { Router } from "express";
import { getAccuracyStats } from "../lib/predictionStore";
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

export default router;
