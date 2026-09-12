import { Router, type IRouter } from "express";
import { getAllMatches, getMatchById } from "../lib/soccerService";
import { saveOutcome } from "../lib/predictionStore";

const ALLOWED_LEAGUE_IDS = new Set([
  1,4,9,10,15,16,17,25,28,29,30,31,32,33,34,
  2,3,531,848,
  39,40,41,45,48,
  140,141,143,556,
  78,79,81,529,
  135,136,137,547,
  61,62,66,526,
  88,89,90,94,95,96,
  144,145,147,
  179,180,182,
  203,204,205,
  235,236,333,
  197,199,218,221,207,209,
  119,123,113,116,103,107,
  345,346,210,212,395,
  11,13,14,71,72,73,128,130,
  253,254,257,262,263,264,
  239,265,268,281,278,280,
  307,308,435,
  98,99,101,292,293,169,
  188,190,288,233,323,26,27,
]);

const router: IRouter = Router();

router.get("/matches", async (req, res) => {
  try {
    const leagueId = req.query.league_id ? parseInt(req.query.league_id as string, 10) : null;
    const status = (req.query.status as string) || null;
    const matches = await getAllMatches(leagueId, status);
    const filtered = matches.filter((m: any) => ALLOWED_LEAGUE_IDS.has(Number(m.league_id)));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch matches" });
  }
});

router.get("/fixtures/upcoming", async (req, res) => {
  try {
    const matches = await getAllMatches(null, "upcoming");
    const filtered = matches.filter((m: any) => ALLOWED_LEAGUE_IDS.has(Number(m.league_id)));
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch upcoming fixtures" });
  }
});

router.get("/matches/:match_id", async (req, res) => {
  try {
    const id = parseInt(req.params.match_id, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid match ID" }); return; }
    const match = await getMatchById(id);
    if (!match) { res.status(404).json({ error: "Match not found" }); return; }
    if (match.status === "finished" && match.score?.home != null && match.score?.away != null) {
      saveOutcome({ fixtureId: id, scoreHome: match.score.home, scoreAway: match.score.away }).catch(() => {});
    }
    res.json(match);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch match" });
  }
});

export default router;
