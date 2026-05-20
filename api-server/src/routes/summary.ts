import { Router, type IRouter } from "express";
import { getDashboardSummary } from "../lib/soccerService";

const router: IRouter = Router();

router.get("/summary", async (_req, res) => {
  try {
    const summary = await getDashboardSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

export default router;
