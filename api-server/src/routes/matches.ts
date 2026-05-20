import { Router, type IRouter } from "express";
import { getAllMatches, getMatchById } from "../lib/soccerService";
import { saveOutcome } from "../lib/predictionStore";

const router: IRouter = Router();

router.get("/matches", async (req, res) => {
  try {
    const leagueId = req.query.league_id
      ? parseInt(req.query.league_id as string, 10)
      : null;
    const status = (req.query.status as string) || null;
    const matches = await getAllMatches(leagueId, status);
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch matches" });
  }
});

router.get("/matches/:match_id", async (req, res) => {
  try {
    const id = parseInt(req.params.match_id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid match ID" });
      return;
    }
    const match = await getMatchById(id);
    if (!match) {
      res.status(404).json({ error: "Match not found" });
      return;
    }

    // Record outcome whenever a finished match is fetched and has a valid score
    if (
      match.status === "finished" &&
      match.score?.home != null &&
      match.score?.away != null
    ) {
      saveOutcome({
        fixtureId: id,
        scoreHome: match.score.home,
        scoreAway: match.score.away,
      }).catch(() => {});
    }

    res.json(match);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch match" });
  }
});

export default router;
