import { Router, type IRouter } from "express";
import { runBacktest, runModelBacktest } from "../lib/backtestService";

const router: IRouter = Router();

router.get("/backtest", async (req, res) => {
  try {
    const season = req.query.season ? parseInt(req.query.season as string, 10) : null;
    const leagueIds = (req.query.league_ids as string) || null;
    const result = await runBacktest(season, leagueIds);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to run backtest" });
  }
});

router.get("/backtest/model", async (req, res) => {
  try {
    const minimumTrainingSamples = req.query.minimum_training_samples
      ? Number(req.query.minimum_training_samples) : undefined;
    const foldSize = req.query.fold_size ? Number(req.query.fold_size) : undefined;
    const result = await runModelBacktest({ minimumTrainingSamples, foldSize });
    res.set("Cache-Control", "no-store");
    res.json(result);
  } catch {
    res.status(500).json({ error: "Failed to run chronological model backtest" });
  }
});

export default router;
