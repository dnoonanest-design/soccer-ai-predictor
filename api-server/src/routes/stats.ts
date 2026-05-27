import { Router } from "express";
import { getMatchStats, getAllXGPredictions } from "../lib/statsService";
import { getEnhancedPrediction } from "../lib/enhancedStatsService";
import { getAllMatches } from "../lib/soccerService";
import { logger } from "../lib/logger";
import {
  savePrediction,
  getCalibrationFactors,
  applyCalibration,
} from "../lib/predictionStore";
import { saveLiveAlert, savePredictionSnapshot } from "../lib/predictionPlatformService";

const router = Router();


function valueEdge(modelPct: number, decimalOdds: number | null) {
  if (!Number.isFinite(modelPct) || !decimalOdds || !Number.isFinite(decimalOdds) || modelPct <= 0) return null;
  const fairOdds = Math.round((100 / modelPct) * 100) / 100;
  const edgePct = Math.round(((decimalOdds * (modelPct / 100)) - 1) * 10000) / 100;
  return { bookmaker_odds: decimalOdds, fair_odds: fairOdds, edge_pct: edgePct, is_value: edgePct >= 5 };
}

function normalizeThreeWayPercent(home: number, draw: number, away: number) {
  const safeHome = Number.isFinite(home) && home > 0 ? home : 0;
  const safeDraw = Number.isFinite(draw) && draw > 0 ? draw : 0;
  const safeAway = Number.isFinite(away) && away > 0 ? away : 0;
  const total = safeHome + safeDraw + safeAway;
  if (total <= 0) {
    return { home: 33.34, draw: 33.33, away: 33.33 };
  }
  const normHome = Math.round((safeHome / total) * 10000) / 100;
  const normDraw = Math.round((safeDraw / total) * 10000) / 100;
  const normAway = Math.round(Math.max(0, 100 - normHome - normDraw) * 100) / 100;
  // If rounding pushes the sum away from 100, put the adjustment on the largest leg.
  const sum = Math.round((normHome + normDraw + normAway) * 100) / 100;
  if (sum === 100) return { home: normHome, draw: normDraw, away: normAway };
  const diff = Math.round((100 - sum) * 100) / 100;
  if (normHome >= normDraw && normHome >= normAway) return { home: Math.round((normHome + diff) * 100) / 100, draw: normDraw, away: normAway };
  if (normDraw >= normAway) return { home: normHome, draw: Math.round((normDraw + diff) * 100) / 100, away: normAway };
  return { home: normHome, draw: normDraw, away: Math.round((normAway + diff) * 100) / 100 };
}


router.get("/xg", async (_req, res) => {
  try {
    const matches = await getAllMatches(null, null);
    const predictions = await getAllXGPredictions(matches);
    return res.json({ predictions });
  } catch (err) {
    logger.error({ err }, "Failed to compute bulk xG predictions");
    return res.status(500).json({ error: "Failed to compute xG predictions" });
  }
});

router.get("/matches/:match_id/stats", async (req, res) => {
  const matchId = parseInt(req.params.match_id, 10);
  if (isNaN(matchId)) return res.status(400).json({ error: "Invalid match_id" });

  try {
    const matches = await getAllMatches(null, null);
    const match = matches.find((m) => m.id === matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    const isLiveOrFinished = match.status === "live" || match.status === "finished";

    const result = await getMatchStats(
      matchId,
      match.home_team.id,
      match.home_team.name,
      match.away_team.id,
      match.away_team.name,
      match.league_id,
      isLiveOrFinished
    );

    let enhancedPred = null;
    if (result.home.matches_played > 0 && result.away.matches_played > 0) {
      try {
        const [rawPred, calibFactors] = await Promise.all([
          getEnhancedPrediction(
            matchId,
            match.home_team.id,
            match.away_team.id,
            match.league_id,
            result.home.goals_per_game,
            result.home.conceded_per_game,
            result.away.goals_per_game,
            result.away.conceded_per_game,
            match.home_team.name,
            match.away_team.name,
            match.minute ?? null,
            match.status === "live",
            match.score?.home ?? null,
            match.score?.away ?? null,
            result.home.form,
            result.away.form,
            { home: result.home, away: result.away }
          ),
          getCalibrationFactors(),
        ]);

        if (rawPred) {
          // Apply calibration to the base pre-match probabilities
          const calHome = applyCalibration(rawPred.home_win, "home", calibFactors);
          const calDraw = applyCalibration(rawPred.draw,     "draw", calibFactors);
          const calAway = applyCalibration(rawPred.away_win, "away", calibFactors);

          // Re-normalise after calibration.
          // Enhanced predictions are displayed by the clients as 0-100 percentages,
          // not 0-1 fractions. Keep that contract here.
          const normalized = normalizeThreeWayPercent(calHome, calDraw, calAway);
          const normHome = normalized.home;
          const normDraw = normalized.draw;
          const normAway = normalized.away;

          enhancedPred = {
            ...rawPred,
            home_win: normHome,
            draw:     normDraw,
            away_win: normAway,
            calibration_sample_size: calibFactors.sampleSize,
            value_edges: {
              home: valueEdge(normHome, match.odds?.home_odds ?? null),
              draw: valueEdge(normDraw, match.odds?.draw_odds ?? null),
              away: valueEdge(normAway, match.odds?.away_odds ?? null),
            },
          };

          const confidenceScore = Number((enhancedPred as any).confidence_score ?? 0);
          const liveMomentum = (enhancedPred as any).live_momentum;

          savePredictionSnapshot({
            fixtureId: matchId,
            leagueId: match.league_id ?? null,
            minute: match.minute ?? null,
            status: match.status,
            homeWinProb: normHome,
            drawProb: normDraw,
            awayWinProb: normAway,
            over25Prob: (enhancedPred as any).over_25 ?? null,
            bttsProb: (enhancedPred as any).btts ?? null,
            homeXg: (enhancedPred as any).home_xg ?? (enhancedPred as any).expected_goals?.home ?? null,
            awayXg: (enhancedPred as any).away_xg ?? (enhancedPred as any).expected_goals?.away ?? null,
            pressureHome: liveMomentum?.home_pressure ?? null,
            pressureAway: liveMomentum?.away_pressure ?? null,
            nextGoalHome: liveMomentum?.next_goal_home ?? null,
            nextGoalAway: liveMomentum?.next_goal_away ?? null,
            confidence: confidenceScore || null,
            reasons: (enhancedPred as any).reasons ?? null,
            valueEdges: (enhancedPred as any).value_edges ?? null,
          }).catch(() => {});

          if (liveMomentum?.pressure_alert) {
            saveLiveAlert({
              fixtureId: matchId,
              alertType: "pressure",
              teamSide: liveMomentum.dominant_team ?? null,
              minute: match.minute ?? null,
              pressureScore: Math.max(liveMomentum.home_pressure ?? 0, liveMomentum.away_pressure ?? 0),
              message: liveMomentum.pressure_alert,
            }).catch(() => {});
          }

          // Persist pre-match prediction for calibration learning (not live)
          if (match.status !== "live" && match.status !== "finished") {
            savePrediction({
              fixtureId:   matchId,
              homeTeam:    match.home_team.name,
              awayTeam:    match.away_team.name,
              leagueId:    match.league_id ?? null,
              homeWinProb: normHome,
              drawProb:    normDraw,
              awayWinProb: normAway,
              isLive:      false,
              kickoffAt:   match.kickoff ? new Date(match.kickoff) : null,
            }).catch(() => {});
          } else if (match.status === "live") {
            savePrediction({
              fixtureId:   matchId,
              homeTeam:    match.home_team.name,
              awayTeam:    match.away_team.name,
              leagueId:    match.league_id ?? null,
              homeWinProb: normHome,
              drawProb:    normDraw,
              awayWinProb: normAway,
              isLive:      true,
              kickoffAt:   match.kickoff ? new Date(match.kickoff) : null,
            }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn({ err, matchId }, "Enhanced prediction failed, falling back to base");
      }
    }

    return res.json({ ...result, enhanced: enhancedPred });
  } catch (err) {
    logger.error({ err, matchId }, "Failed to fetch match stats");
    return res.status(500).json({ error: "Failed to fetch match stats" });
  }
});

export default router;
