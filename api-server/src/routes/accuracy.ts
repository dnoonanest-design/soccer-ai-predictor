import { Router } from "express";
import { getAccuracyStats, getCalibrationReport } from "../lib/predictionStore";
import { logger } from "../lib/logger";

const router = Router();

router.get("/accuracy", async (_req, res) => {
  try {
    // Fetch both in parallel — single endpoint so the track-record page
    // only needs one request to render both accuracy metrics and the
    // reliability diagram.
    const [stats, calibration] = await Promise.all([
      getAccuracyStats(),
      getCalibrationReport().catch(() => null),
    ]);
    return res.json({
      ...stats,
      calibrationBuckets: calibration?.buckets ?? [],
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch accuracy stats");
    return res.status(500).json({ error: "Failed to fetch accuracy stats" });
  }
});

export default router;
