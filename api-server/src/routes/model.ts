import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { getChallengerReport, rollbackToLegacy, runChallengerCycle } from "../lib/modelChallengerService";
import { ensureTeamRatings, getTeamRatingsStatus } from "../lib/teamRatingsProvider";
import { explainMatch } from "../lib/matchExplanationService";
import { getMatchById } from "../lib/soccerService";
import { isTrackedLeague } from "../lib/leagueConfig";
import { PredictionWarmupError } from "../lib/canonicalPredictionService";

const router: IRouter = Router();

/** Champion vs challengers on identical unseen fixtures, plus the promotion rules. */
router.get("/model/challengers", async (_req, res) => {
  try {
    return res.json(await getChallengerReport());
  } catch (err) {
    logger.error({ err }, "challenger report failed");
    return res.status(500).json({ error: "Failed to build challenger report" });
  }
});

router.get("/model/ratings", (_req, res) => res.json(getTeamRatingsStatus()));

/** Plan step 8: plain-English explanation and data checks; never changes numbers. */
router.get("/matches/:match_id/explanation", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.match_id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid match ID" });
    const match = await getMatchById(id);
    if (!match || !isTrackedLeague(match.league_id)) return res.status(404).json({ error: "Match not found" });
    if (match.status !== "upcoming" && match.status !== "live") return res.status(409).json({ error: "Explanations are available before and during matches only" });
    return res.json(await explainMatch(match));
  } catch (err) {
    if (err instanceof PredictionWarmupError) return res.status(503).json({ error: "Prediction history is still warming up" });
    logger.error({ err }, "match explanation failed");
    return res.status(500).json({ error: "Failed to explain match" });
  }
});

// Admin (X-Admin-Key, enforced in app.ts): settle, refit and run the gate now.
router.post("/model/challengers/run", async (_req, res) => {
  try {
    await ensureTeamRatings();
    return res.json(await runChallengerCycle());
  } catch (err) {
    logger.error({ err }, "challenger cycle failed");
    return res.status(500).json({ error: "Failed to run challenger cycle" });
  }
});

// Admin: put the original formula back in charge, with a logged reason.
router.post("/model/challengers/rollback", async (req, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "manual rollback";
    return res.json({ rolledBack: await rollbackToLegacy(reason) });
  } catch (err) {
    logger.error({ err }, "challenger rollback failed");
    return res.status(500).json({ error: "Failed to roll back" });
  }
});

export default router;
