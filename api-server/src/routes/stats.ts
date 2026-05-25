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
import { normalizeThreeWayPercent, valueEdge as computeValueEdge } from "../lib/mathUtils";
import { statsRateLimit, safeInt } from "../lib/security";

const router = Router();


// S6: valueEdge imported as computeValueEdge from ../lib/mathUtils

// S6: normalizeThreeWayPercent imported from ../lib/mathUtils


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

router.get("/matches/:match_id/stats", statsRateLimit, async (req, res) => {
  const matchId = safeInt(req.params.match_id, 1, 999_999_999);
  if (matchId === null) return res.status(400).json({ error: "Invalid match_id: must be a positive integer" });

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
        // Use shot-quality xG when available (more stable than season goals average).
        // Blend 60% shot-based / 40% goals-based when shots data exists;
        // fall back to pure goals-based when the API doesn't return shots.
        const homeAttack = result.home.xg_from_shots != null
          ? result.home.xg_from_shots * 0.60 + result.home.goals_per_game * 0.40
          : result.home.goals_per_game;
        const awayAttack = result.away.xg_from_shots != null
          ? result.away.xg_from_shots * 0.60 + result.away.goals_per_game * 0.40
          : result.away.goals_per_game;

        const [rawPred, calibFactors] = await Promise.all([
          getEnhancedPrediction(
            matchId,
            match.home_team.id,
            match.away_team.id,
            match.league_id,
            homeAttack,
            result.home.conceded_per_game,
            awayAttack,
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
              home: computeValueEdge(normHome, match.odds?.home_odds ?? null),
              draw: computeValueEdge(normDraw, match.odds?.draw_odds ?? null),
              away: computeValueEdge(normAway, match.odds?.away_odds ?? null),
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
