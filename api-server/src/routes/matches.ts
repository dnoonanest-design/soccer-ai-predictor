import { Router, type IRouter } from "express";
import { getAllMatches, getMatchById } from "../lib/soccerService";
import { saveOutcome } from "../lib/predictionStore";
import { isTrackedLeague } from "../lib/leagueConfig";
import {
  getApiFootballProviderHealth,
  isApiFootballProviderError,
} from "../lib/apiFootballReliability";

const BLOCKED_NAME_KEYWORDS = [
  "reserve", "reserva", " res ", "res.", "u20", "u19", "u18", "u17", "u16", "u15",
  "u23", "u21", "youth", "amateur", "intermedia", "regional", "segunda b",
  "tercera", "sub-20", "sub-19", "sub-18", "sub-17", "sub-23", "sub-21",
  "division b", "women", "club friendly", "4th", "fifth", "lower",
];

function isBlockedLeague(leagueName: string | null | undefined) {
  if (!leagueName) return false;
  const lower = leagueName.toLowerCase();
  return BLOCKED_NAME_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function inProductScope(match: { league_id: number; league_name?: string | null }) {
  return isTrackedLeague(Number(match.league_id)) && !isBlockedLeague(match.league_name);
}

function handleMatchRouteError(err: unknown, res: Parameters<Parameters<IRouter["get"]>[1]>[1]) {
  if (isApiFootballProviderError(err)) {
    const provider = getApiFootballProviderHealth();
    return res.status(503).json({
      error: "Live football data is temporarily unavailable",
      code: "LIVE_DATA_UNAVAILABLE",
      provider: "api-football",
      provider_status: provider.state,
      failure_kind: err.kind,
      last_checked_at: provider.lastCheckedAt,
    });
  }

  return res.status(500).json({ error: "Failed to fetch matches" });
}

const router: IRouter = Router();

router.get("/matches", async (req, res) => {
  try {
    const leagueId = req.query.league_id
      ? parseInt(req.query.league_id as string, 10)
      : null;
    const status = (req.query.status as string) || null;

    if (leagueId != null && (!Number.isInteger(leagueId) || !isTrackedLeague(leagueId))) {
      return res.json([]);
    }

    const matches = await getAllMatches(leagueId, status);
    return res.json(matches.filter(inProductScope));
  } catch (err) {
    return handleMatchRouteError(err, res);
  }
});

router.get("/fixtures/upcoming", async (_req, res) => {
  try {
    const matches = await getAllMatches(null, "upcoming");
    return res.json(matches.filter(inProductScope));
  } catch (err) {
    return handleMatchRouteError(err, res);
  }
});

router.get("/matches/:match_id", async (req, res) => {
  try {
    const id = parseInt(req.params.match_id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid match ID" });
    }

    const match = await getMatchById(id);
    if (!match || !inProductScope(match)) {
      return res.status(404).json({ error: "Match not found" });
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

    return res.json(match);
  } catch (err) {
    return handleMatchRouteError(err, res);
  }
});

export default router;
