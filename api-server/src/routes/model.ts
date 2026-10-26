import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { getChallengerFixtures, getChallengerReport, rollbackToLegacy, runChallengerCycle } from "../lib/modelChallengerService";
import { backfillShotStatistics, ensureTeamRatings, getTeamRatingsStatus } from "../lib/teamRatingsProvider";
import { getInPlayReport, refitInPlayModel, rollbackInPlay, runInPlayCycle } from "../lib/inPlayModelService";
import { explainMatch } from "../lib/matchExplanationService";
import { getMatchById } from "../lib/soccerService";
import { isTrackedLeague } from "../lib/leagueConfig";
import { PredictionWarmupError } from "../lib/canonicalPredictionService";

const router: IRouter = Router();

/**
 * Step 9's odds-free probabilities for upcoming fixtures with bookmaker odds,
 * for the dashboard's value tab. Value is only judged against this model.
 */
router.get("/model/value-signals", async (_req, res) => {
  try {
    const { getAllMatches } = await import("../lib/soccerService");
    const { ensureStrengthModel } = await import("../lib/strengthModel");
    const { valueSignalsFor, VALUE_RULES } = await import("../lib/valueSignals");
    void ensureStrengthModel();
    const matches = (await getAllMatches(null, "upcoming")).filter((m) => m.status === "upcoming" && m.odds?.home_odds);
    const fixtures = matches.flatMap((m) => {
      const v = valueSignalsFor(m);
      return v ? [{ fixture_id: m.id, ...v }] : [];
    });
    res.set("Cache-Control", "public, max-age=60");
    return res.json({ rules: VALUE_RULES, fixtures });
  } catch (err) {
    logger.error({ err }, "value signals failed");
    return res.status(500).json({ error: "Value signals are temporarily unavailable" });
  }
});

/** Champion vs challengers on identical unseen fixtures, plus the promotion rules. */
router.get("/model/challengers", async (_req, res) => {
  try {
    return res.json(await getChallengerReport());
  } catch (err) {
    logger.error({ err }, "challenger report failed");
    return res.status(500).json({ error: "Failed to build challenger report" });
  }
});

/** Per-fixture forecasts for one challenger beside the live model (settled matches only). */
router.get("/model/challengers/:challenger/fixtures", async (req, res) => {
  try {
    const id = String(req.params.challenger);
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return res.status(400).json({ error: "Invalid challenger" });
    return res.json({ challenger: id, fixtures: await getChallengerFixtures(id, Number(req.query.limit ?? 60)) });
  } catch (err) {
    logger.error({ err }, "challenger fixtures failed");
    return res.status(500).json({ error: "Failed to list challenger fixtures" });
  }
});

router.get("/model/ratings", (_req, res) => res.json(getTeamRatingsStatus()));

/** In-play only: fitted in-play model vs the live model at the same checkpoints. */
router.get("/model/inplay", async (_req, res) => {
  try {
    return res.json(await getInPlayReport());
  } catch (err) {
    logger.error({ err }, "in-play report failed");
    return res.status(500).json({ error: "Failed to build in-play report" });
  }
});

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

// API-Football odds collection: coverage, and (admin) backfill of last week's final pre-match odds.
router.get("/model/odds/coverage", async (_req, res) => {
  try {
    const { getApifOddsCoverage } = await import("../lib/apiFootballOdds");
    return res.json(await getApifOddsCoverage());
  } catch (err) {
    logger.error({ err }, "odds coverage failed");
    return res.status(500).json({ error: "Odds coverage unavailable" });
  }
});

router.post("/model/odds/backfill", async (req, res) => {
  try {
    const { backfillApifOdds } = await import("../lib/apiFootballOdds");
    const days = Number(req.body?.days ?? 7) || 7, maxCalls = Number(req.body?.maxCalls ?? 300) || 300;
    return res.json(await backfillApifOdds(days, maxCalls));
  } catch (err) {
    logger.error({ err }, "odds backfill failed");
    return res.status(500).json({ error: "Odds backfill failed" });
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

// Admin: refit the in-play multipliers now, then settle and run the in-play gate.
router.post("/model/inplay/run", async (_req, res) => {
  try {
    const fit = await refitInPlayModel();
    return res.json({ fit, cycle: await runInPlayCycle() });
  } catch (err) {
    logger.error({ err }, "in-play cycle failed");
    return res.status(500).json({ error: "Failed to run in-play cycle" });
  }
});

router.post("/model/inplay/rollback", async (req, res) => {
  try {
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "manual rollback";
    return res.json({ rolledBack: await rollbackInPlay(reason) });
  } catch (err) {
    logger.error({ err }, "in-play rollback failed");
    return res.status(500).json({ error: "Failed to roll back" });
  }
});

// Admin: fetch one batch of past-fixture shot statistics now (uses API quota).
router.post("/model/ratings/backfill", async (req, res) => {
  try {
    const calls = Math.max(1, Math.min(200, Number(req.body?.calls ?? 50) || 50));
    return res.json(await backfillShotStatistics(calls));
  } catch (err) {
    logger.error({ err }, "shot statistics backfill failed");
    return res.status(500).json({ error: "Failed to backfill shot statistics" });
  }
});

export default router;
