import { Router } from "express";
import { getMatchEvents } from "../lib/eventsService";
import { getAllMatches } from "../lib/soccerService";
import { logger } from "../lib/logger";

const router = Router();

router.get("/matches/:match_id/events", async (req, res) => {
  const matchId = parseInt(req.params.match_id, 10);
  if (isNaN(matchId)) {
    return res.status(400).json({ error: "Invalid match_id" });
  }

  try {
    // We need the home team ID to determine team_side — fetch from match list
    const matches = await getAllMatches(null, null);
    const match = matches.find((m) => m.id === matchId);
    if (!match) {
      return res.status(404).json({ error: "Match not found" });
    }

    const events = await getMatchEvents(matchId, match.home_team.id);
    return res.json({ match_id: matchId, events });
  } catch (err) {
    logger.error({ err, matchId }, "Failed to fetch match events");
    return res.status(500).json({ error: "Failed to fetch match events" });
  }
});

export default router;
