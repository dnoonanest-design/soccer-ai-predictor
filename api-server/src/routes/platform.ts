import { Router } from "express";
import { logger } from "../lib/logger";
import { getAllMatches } from "../lib/soccerService";
import { createTrackedBet, getBetTrackerSummary, getLiveAlerts, getPredictionHistory, getTrainingRuns, runTrainingPipeline, saveLiveAlert, settleTrackedBet } from "../lib/predictionPlatformService";
import { getCalibrationReport, getTrainingDataset, saveOutcome } from "../lib/predictionStore";
import { requireAdminKey, adminRateLimit, sseConnectionLimit, safeInt, safeString } from "../lib/security";

const router = Router();

router.get("/matches/:match_id/prediction-history", async (req, res) => {
  const fixtureId = Number(req.params.match_id);
  if (!Number.isFinite(fixtureId)) return res.status(400).json({ error: "Invalid match_id" });
  try {
    return res.json({ fixture_id: fixtureId, snapshots: await getPredictionHistory(fixtureId) });
  } catch (err) {
    logger.error({ err, fixtureId }, "prediction history failed");
    return res.status(500).json({ error: "Failed to fetch prediction history" });
  }
});

router.get("/tracker", async (_req, res) => {
  try { return res.json(await getBetTrackerSummary()); }
  catch (err) { logger.error({ err }, "tracker summary failed"); return res.status(500).json({ error: "Failed to fetch tracker" }); }
});

router.post("/tracker", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.fixtureId || !body.market || !body.selection || !body.decimalOdds) {
      return res.status(400).json({ error: "fixtureId, market, selection and decimalOdds are required" });
    }
    let homeTeam = body.homeTeam;
    let awayTeam = body.awayTeam;
    if (!homeTeam || !awayTeam) {
      const match = (await getAllMatches(null, null)).find((m) => m.id === Number(body.fixtureId));
      homeTeam = homeTeam || match?.home_team.name || "Home";
      awayTeam = awayTeam || match?.away_team.name || "Away";
    }
    const created = await createTrackedBet({
      fixtureId: Number(body.fixtureId),
      homeTeam,
      awayTeam,
      market: String(body.market),
      selection: String(body.selection),
      decimalOdds: Number(body.decimalOdds),
      stake: Number(body.stake ?? 1),
      modelProb: body.modelProb == null ? null : Number(body.modelProb),
      edgePct: body.edgePct == null ? null : Number(body.edgePct),
      notes: body.notes ?? null,
    });
    return res.status(201).json(created);
  } catch (err) {
    logger.error({ err }, "create tracked bet failed");
    return res.status(500).json({ error: "Failed to create tracked bet" });
  }
});

router.post("/tracker/:id/settle", async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!Number.isFinite(id) || !["won", "lost", "void"].includes(status)) {
    return res.status(400).json({ error: "Valid id and status won|lost|void are required" });
  }
  try {
    const updated = await settleTrackedBet(id, status);
    if (!updated) return res.status(404).json({ error: "Bet not found" });
    return res.json(updated);
  } catch (err) {
    logger.error({ err, id }, "settle bet failed");
    return res.status(500).json({ error: "Failed to settle bet" });
  }
});


router.get("/calibration", async (_req, res) => {
  try { return res.json(await getCalibrationReport()); }
  catch (err) { logger.error({ err }, "calibration report failed"); return res.status(500).json({ error: "Failed to fetch calibration report" }); }
});

router.get("/training/dataset", async (req, res) => {
  try {
    // Cap at 2000 rows regardless of what the caller requests — prevents a
    // single request from dumping the entire training history into memory.
    const requestedLimit = req.query.limit ? Number(req.query.limit) : 1000;
    const limit = Math.min(2000, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 1000));
    const rows = await getTrainingDataset(limit);
    return res.json({ rows, count: rows.length });
  } catch (err) {
    logger.error({ err }, "training dataset export failed");
    return res.status(500).json({ error: "Failed to export training dataset" });
  }
});

router.post("/outcomes/settle-finished", requireAdminKey, adminRateLimit, async (_req, res) => {
  try {
    const matches = await getAllMatches(null, null);
    let settled = 0;
    for (const match of matches) {
      if (match.status !== "finished") continue;
      const home = match.score?.home;
      const away = match.score?.away;
      if (home == null || away == null) continue;
      await saveOutcome({ fixtureId: match.id, scoreHome: home, scoreAway: away });
      settled++;
    }
    return res.json({ settled, checked: matches.length, message: `Recorded ${settled} finished match outcomes.` });
  } catch (err) {
    logger.error({ err }, "settle finished outcomes failed");
    return res.status(500).json({ error: "Failed to settle finished outcomes" });
  }
});

router.get("/training", async (_req, res) => {
  try { return res.json({ runs: await getTrainingRuns() }); }
  catch (err) { logger.error({ err }, "training runs failed"); return res.status(500).json({ error: "Failed to fetch training runs" }); }
});

router.post("/training/run", requireAdminKey, adminRateLimit, async (_req, res) => {
  try { return res.status(201).json(await runTrainingPipeline()); }
  catch (err) { logger.error({ err }, "training failed"); return res.status(500).json({ error: "Failed to run training pipeline" }); }
});

router.get("/live/alerts", async (req, res) => {
  const fixtureId = req.query.fixture_id ? Number(req.query.fixture_id) : undefined;
  try { return res.json({ alerts: await getLiveAlerts(fixtureId) }); }
  catch (err) { logger.error({ err }, "alerts failed"); return res.status(500).json({ error: "Failed to fetch live alerts" }); }
});

router.get("/live/stream", sseConnectionLimit, async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = async () => {
    try {
      const alerts = await getLiveAlerts(req.query.fixture_id ? Number(req.query.fixture_id) : undefined);
      res.write(`event: alerts\n`);
      res.write(`data: ${JSON.stringify({ alerts: alerts.slice(0, 10), server_time: new Date().toISOString() })}\n\n`);
    } catch (err) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ error: "stream update failed" })}\n\n`);
    }
  };
  await send();
  const timer = setInterval(send, 15000);
  req.on("close", () => clearInterval(timer));
});

router.post("/live/alerts", async (req, res) => {
  try {
    const body = req.body ?? {};
    const fixtureId = safeInt(body.fixtureId, 1, 999_999_999);
    if (fixtureId === null) {
      return res.status(400).json({ error: "Valid fixtureId is required (positive integer)" });
    }
    const minute = body.minute == null ? null : safeInt(body.minute, 0, 180);
    const pressureScore = body.pressureScore == null ? null : safeFloat(body.pressureScore ?? null, 0, 100);
    const alertType = safeString(body.alertType || "manual", 32).replace(/[^a-z_]/g, "");
    const teamSide = body.teamSide ? safeString(body.teamSide, 8) : null;
    const message = safeString(body.message || "Live alert", 256);
    const created = await saveLiveAlert({
      fixtureId,
      alertType: alertType || "manual",
      teamSide,
      minute,
      pressureScore,
      message,
    });
    return res.status(201).json(created);
  } catch (err) {
    logger.error({ err }, "save live alert failed");
    return res.status(500).json({ error: "Failed to save live alert" });
  }
});

export default router;
