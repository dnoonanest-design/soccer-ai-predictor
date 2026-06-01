import { Router, type IRouter } from "express";
import { runBacktest } from "../lib/backtestService";

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

export default router;
