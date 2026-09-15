import { Router } from "express";
import { getMatchStats } from "../lib/statsService";
import { getLiveMomentumSnapshot } from "../lib/enhancedStatsService";
import { getMatchById } from "../lib/soccerService";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { savePrediction } from "../lib/predictionStore";
import { saveLiveAlert, savePredictionSnapshot } from "../lib/predictionPlatformService";
import { createCanonicalPrediction } from "../lib/canonicalPredictionService";

const router = Router();


function valueEdge(modelPct: number, decimalOdds: number | null) {
  if (!Number.isFinite(modelPct) || !decimalOdds || !Number.isFinite(decimalOdds) || modelPct <= 0) return null;
  const fairOdds = Math.round((100 / modelPct) * 100) / 100;
  const edgePct = Math.round(((decimalOdds * (modelPct / 100)) - 1) * 10000) / 100;
  return { bookmaker_odds: decimalOdds, fair_odds: fairOdds, edge_pct: edgePct, is_value: edgePct >= 5 };
}

router.get("/xg", async (_req, res) => {
  try {
    // Read the latest canonical snapshots. This endpoint must not run a second,
    // simplified probability model or trigger a quota-heavy fixture-wide scan.
    const result = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (fixture_id)
          fixture_id AS match_id,
          home_xg, away_xg,
          home_win_prob AS home_win,
          draw_prob AS draw,
          away_win_prob AS away_win,
          created_at
        FROM prediction_snapshots
        ORDER BY fixture_id, created_at DESC
      ) latest
      ORDER BY created_at DESC
      LIMIT 250
    `);
    return res.json({ predictions: result.rows, source: "canonical_prediction_snapshots" });
  } catch (err) {
    logger.error({ err }, "Failed to compute bulk xG predictions");
    return res.status(500).json({ error: "Failed to compute xG predictions" });
  }
});

router.get("/matches/:match_id/stats", async (req, res) => {
  const matchId = parseInt(req.params.match_id, 10);
  if (isNaN(matchId)) return res.status(400).json({ error: "Invalid match_id" });

  try {
    const match = await getMatchById(matchId);
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
    // A finished fixture is settlement evidence, never a forecasting input.
    // Do not generate a fresh "prediction" from its final score or final-match
    // telemetry; historical predictions are evaluated by the settlement jobs.
    if (match.status !== "finished") {
      try {
        const { prediction } = await createCanonicalPrediction(match, { stats: result });
        if (prediction) {
          const normHome = prediction.home_win;
          const normDraw = prediction.draw;
          const normAway = prediction.away_win;
          enhancedPred = {
            ...prediction,
            value_edges: {
              home: valueEdge(normHome, match.odds?.home_odds ?? null),
              draw: valueEdge(normDraw, match.odds?.draw_odds ?? null),
              away: valueEdge(normAway, match.odds?.away_odds ?? null),
            },
          };

          const confidenceScore = Number(prediction.confidence_score ?? 0);
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

    // Momentum must remain available from current match telemetry even when a
    // sparse/new competition cannot yet produce a safe pre-match baseline.
    if (match.status === "live" && !(enhancedPred as any)?.live_momentum) {
      const liveMomentum = await getLiveMomentumSnapshot(
        matchId,
        match.home_team.id,
        match.away_team.id,
        match.minute ?? null,
        result.has_live_stats ? { home: result.home, away: result.away } : undefined,
      );
      if (liveMomentum) enhancedPred = { ...(enhancedPred ?? {}), live_momentum: liveMomentum } as any;
    }

    return res.json({ ...result, enhanced: enhancedPred });
  } catch (err) {
    logger.error({ err, matchId }, "Failed to fetch match stats");
    return res.status(500).json({ error: "Failed to fetch match stats" });
  }
});

export default router;
