import { Router, type IRouter } from "express";
import { getAllMatches, getMatchById } from "../lib/soccerService";
import { saveOutcome } from "../lib/predictionStore";
import { isTrackedLeague } from "../lib/leagueConfig";

const BLOCKED_NAME_KEYWORDS = [
  "reserve",
  "reserva",
  " res ",
  "res.",
  "u20",
  "u19",
  "u18",
  "u17",
  "u16",
  "u15",
  "u23",
  "u21",
  "youth",
  "amateur",
  "intermedia",
  "regional",
  "segunda b",
  "tercera",
  "sub-20",
  "sub-19",
  "sub-18",
  "sub-17",
  "sub-23",
  "sub-21",
  "division b",
  "women",
  "club friendly",
  "4th",
  "fifth",
  "lower",
];

function isBlockedLeague(leagueName: string | null | undefined) {
  if (!leagueName) return false;
  const lower = leagueName.toLowerCase();
  return BLOCKED_NAME_KEYWORDS.some((kw) => lower.includes(kw));
}

const router: IRouter = Router();

router.get("/matches", async (req, res) => {
  try {
    const leagueId = req.query.league_id
      ? parseInt(req.query.league_id as string, 10)
      : null;
    const status = (req.query.status as string) || null;
    const matches = await getAllMatches(leagueId, status);
    const filtered = matches
      .filter((m) => isTrackedLeague(m.league_id))
      .filter((m) => !isBlockedLeague(m.league_name));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch matches" });
  }
});

router.get("/fixtures/upcoming", async (req, res) => {
  try {
    const matches = await getAllMatches(null, "upcoming");
    const filtered = matches
      .filter((m) => isTrackedLeague(m.league_id))
      .filter((m) => !isBlockedLeague(m.league_name));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch upcoming fixtures" });
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
