import { Router } from "express";
import { getH2H, getTeamRecentResults } from "../lib/h2hService";
import { getAllMatches } from "../lib/soccerService";
import { logger } from "../lib/logger";

const router = Router();

router.get("/teams/:team_id/results", async (req, res) => {
  const teamId = Number.parseInt(req.params.team_id, 10);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    return res.status(400).json({ error: "Invalid team id" });
  }

  try {
    return res.json(await getTeamRecentResults(teamId, String(req.query.name ?? "Team")));
  } catch (err) {
    logger.error({ err, teamId }, "Failed to fetch recent team results");
    return res.status(502).json({ error: "Recent team results are temporarily unavailable" });
  }
});

router.get("/matches/:match_id/h2h", async (req, res) => {
  const matchId = parseInt(req.params.match_id, 10);
  if (isNaN(matchId)) {
    return res.status(400).json({ error: "Invalid match_id" });
  }

  try {
    const matches = await getAllMatches(null, null);
    const match = matches.find((m) => m.id === matchId);
    if (!match) {
      return res.status(404).json({ error: "Match not found" });
    }

    const result = await getH2H(
      match.home_team.id,
      match.home_team.name,
      match.away_team.id,
      match.away_team.name
    );
    return res.json(result);
  } catch (err) {
    logger.error({ err, matchId }, "Failed to fetch H2H data");
    return res.status(500).json({ error: "Failed to fetch H2H data" });
  }
});

export default router;
