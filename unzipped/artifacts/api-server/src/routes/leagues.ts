import { Router, type IRouter } from "express";
import { getLeagues } from "../lib/soccerService";

const router: IRouter = Router();

router.get("/leagues", async (_req, res) => {
  try {
    const leagues = await getLeagues();
    res.json(leagues);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch leagues" });
  }
});

export default router;
