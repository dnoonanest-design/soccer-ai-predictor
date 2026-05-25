/**
 * Premium API routes — probability history, team profile, value centre, multi-day fixtures.
 * All data is derived from existing tables and services; no new DB tables required.
 */
import { Router } from "express";
import { logger } from "../lib/logger";
import { db, predictionSnapshots, matchOutcomes, matchCircumstances, aiLearningMemory } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { statsRateLimit, safeInt, safeFloat, safeString, isSafeUrl } from "../lib/security";
import { getAllMatches, isLeagueFocused } from "../lib/soccerService";
import { getMatchStats } from "../lib/statsService";
import { getEnhancedPrediction } from "../lib/enhancedStatsService";
import { getCalibrationFactors, applyCalibration } from "../lib/predictionStore";

const router = Router();

// ─── 1. Probability history for a match (for the timeline chart) ──────────────
router.get("/matches/:match_id/probability-history", async (req, res) => {
  const fixtureId = Number(req.params.match_id);
  if (!Number.isFinite(fixtureId)) return res.status(400).json({ error: "Invalid match_id" });
  try {
    const rows = await db.select({
      id:          predictionSnapshots.id,
      minute:      predictionSnapshots.minute,
      status:      predictionSnapshots.status,
      homeWinProb: predictionSnapshots.homeWinProb,
      drawProb:    predictionSnapshots.drawProb,
      awayWinProb: predictionSnapshots.awayWinProb,
      homeXg:      predictionSnapshots.homeXg,
      awayXg:      predictionSnapshots.awayXg,
      over25Prob:  predictionSnapshots.over25Prob,
      bttsProb:    predictionSnapshots.bttsProb,
      confidence:  predictionSnapshots.confidence,
      createdAt:   predictionSnapshots.createdAt,
    })
    .from(predictionSnapshots)
    .where(eq(predictionSnapshots.fixtureId, fixtureId))
    .orderBy(predictionSnapshots.createdAt)
    .limit(200);

    // Also fetch match explanation if available
    const explanationRows = await db.select({ summary: aiLearningMemory.summary, evidenceJson: aiLearningMemory.evidenceJson })
      .from(aiLearningMemory)
      .where(and(
        eq(aiLearningMemory.source, `explanation:${fixtureId}`),
        eq(aiLearningMemory.learningType, "match_explanation"),
      ))
      .limit(1);

    return res.json({
      fixture_id: fixtureId,
      snapshots: rows,
      explanation: explanationRows[0] ?? null,
    });
  } catch (err) {
    logger.error({ err, fixtureId }, "probability history failed");
    return res.status(500).json({ error: "Failed to fetch probability history" });
  }
});

// ─── 2. Team profile ──────────────────────────────────────────────────────────
router.get("/teams/:team_id/profile", async (req, res) => {
  const teamId = safeInt(req.params.team_id, 1, 999_999_999);
  const leagueId = req.query.league_id ? safeInt(req.query.league_id, 1, 99_999) : null;
  if (teamId === null) return res.status(400).json({ error: "Invalid team_id: must be a positive integer" });
  try {
    // Get today's matches to find the team's league context
    const allMatches = await getAllMatches(leagueId, null);
    const teamMatches = allMatches.filter(
      (m) => m.home_team.id === teamId || m.away_team.id === teamId
    );

    // Find team name and league from any match featuring them
    const refMatch = teamMatches[0] ?? null;
    const teamName = refMatch
      ? (refMatch.home_team.id === teamId ? refMatch.home_team.name : refMatch.away_team.name)
      : `Team ${teamId}`;
    const resolvedLeagueId = leagueId ?? refMatch?.league_id ?? null;

    // Fetch team stats if we have a league context
    let stats = null;
    if (resolvedLeagueId && teamMatches.length > 0) {
      const m = teamMatches[0];
      const isHome = m.home_team.id === teamId;
      try {
        const result = await getMatchStats(
          m.id,
          m.home_team.id, m.home_team.name,
          m.away_team.id, m.away_team.name,
          m.league_id,
          m.status === "live" || m.status === "finished"
        );
        stats = isHome ? result.home : result.away;
      } catch { /* stats unavailable */ }
    }

    // Recent circumstances for this team's matches
    const circRows = await db.execute(sql`
      SELECT mc.fixture_id, mc.home_team, mc.away_team, mc.status,
             mc.home_form_score, mc.away_form_score,
             mc.home_missing_players, mc.away_missing_players,
             mc.home_red_cards, mc.away_red_cards,
             mc.circumstance_score_home, mc.circumstance_score_away,
             mc.collected_at,
             mo.outcome, mo.score_home, mo.score_away
      FROM match_circumstances mc
      LEFT JOIN match_outcomes mo ON mo.fixture_id = mc.fixture_id
      WHERE mc.home_team ILIKE ${'%' + teamName.substring(0, 8) + '%'}
         OR mc.away_team ILIKE ${'%' + teamName.substring(0, 8) + '%'}
      ORDER BY mc.collected_at DESC
      LIMIT 10
    `) as any;

    return res.json({
      team_id: teamId,
      team_name: teamName,
      league_id: resolvedLeagueId,
      upcoming_matches: teamMatches.slice(0, 5),
      stats,
      recent_circumstances: (circRows.rows ?? []).slice(0, 5),
    });
  } catch (err) {
    logger.error({ err, teamId }, "team profile failed");
    return res.status(500).json({ error: "Failed to fetch team profile" });
  }
});

// ─── 3. Multi-day fixtures (next N days) ──────────────────────────────────────
router.get("/fixtures/upcoming", async (req, res) => {
  const days = safeInt(req.query.days ?? 3, 1, 7) ?? 3;
  const leagueId = req.query.league_id ? safeInt(req.query.league_id, 1, 99_999) : null;
  const SEASON = process.env.FOOTBALL_SEASON ?? "2025";
  const API_KEY = process.env.API_FOOTBALL_KEY ?? "";
  if (!API_KEY) return res.json({ fixtures: [], note: "API key required for multi-day fixtures" });

  // Fetch each date sequentially to avoid 5 concurrent API calls — each
  // /fixtures call is expensive. Sequential is fine since days max is 7
  // and each call returns in <1s normally.
  try {
    const results: Record<string, unknown[]> = {};
    const today = new Date();
    // Use API_TIMEOUT_MS same as the rest of the codebase (5s per request)
    const API_TIMEOUT_MS = 5000;

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i + 1);
      const dateStr = d.toISOString().split("T")[0];

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      let fixtures: any[] = [];
      try {
        const res2 = await fetch(
          `https://v3.football.api-sports.io/fixtures?date=${dateStr}&season=${SEASON}&timezone=UTC`,
          { headers: { "x-apisports-key": API_KEY }, signal: controller.signal }
        );
        if (res2.ok) {
          const j = await res2.json() as { response?: unknown };
          fixtures = Array.isArray(j.response) ? j.response : [];
        }
      } catch (fetchErr: unknown) {
        if ((fetchErr as any)?.name === "AbortError") {
          logger.warn({ dateStr }, "upcoming fixtures: request timed out");
        } else {
          logger.warn({ err: fetchErr, dateStr }, "upcoming fixtures: fetch error");
        }
      } finally {
        clearTimeout(timer);
      }

      // Apply focus-league filter — same set used by the live dashboard
      // and only override if a specific leagueId is requested
      let list = fixtures.filter((f: any) =>
        leagueId ? f.league?.id === leagueId : isLeagueFocused(Number(f.league?.id ?? 0))
      );

      results[dateStr] = list.map((f: any) => ({
        id:           f.fixture?.id,
        kickoff:      f.fixture?.date,
        status:       f.fixture?.status?.short,
        league_id:    f.league?.id,
        league_name:  f.league?.name,
        league_logo:  f.league?.logo,
        country:      f.league?.country,
        home_team: { id: f.teams?.home?.id, name: f.teams?.home?.name, logo: f.teams?.home?.logo },
        away_team: { id: f.teams?.away?.id, name: f.teams?.away?.name, logo: f.teams?.away?.logo },
      }));
    }
    return res.json({ days, fixtures_by_date: results });
  } catch (err) {
    logger.error({ err }, "upcoming fixtures failed");
    return res.status(500).json({ error: "Failed to fetch upcoming fixtures" });
  }
});

// ─── 4. Value centre — all pre-match value edges ──────────────────────────────
router.get("/value-centre", statsRateLimit, async (req, res) => {
  const minEdge = safeFloat(req.query.min_edge ?? 3, 0.5, 30) ?? 3;
  const leagueId = req.query.league_id ? Number(req.query.league_id) : null;
  try {
    const matches = await getAllMatches(leagueId, "upcoming");
    const calibFactors = await getCalibrationFactors().catch(() => null);

    // Process in batches of 6 to avoid hammering the external API with 30 concurrent calls.
    // Each getEnhancedPrediction can fire up to 10 external requests, so 30 concurrent
    // predictions = up to 300 simultaneous API calls, which would exhaust the quota.
    const BATCH_SIZE = 6;
    // Only compute value edges for focus leagues — these have the best model accuracy
    const candidateMatches = matches
      .filter(m => !!m.odds?.home_odds && isLeagueFocused(m.league_id))
      .slice(0, 25);

    async function scoreMatch(match: typeof candidateMatches[0]) {
      try {
        const result = await getMatchStats(
          match.id,
          match.home_team.id, match.home_team.name,
          match.away_team.id, match.away_team.name,
          match.league_id, false
        );
        if (!result.home.matches_played || !result.away.matches_played) return null;
        const raw = await getEnhancedPrediction(
          match.id,
          match.home_team.id, match.away_team.id, match.league_id,
          result.home.goals_per_game, result.home.conceded_per_game,
          result.away.goals_per_game, result.away.conceded_per_game,
          match.home_team.name, match.away_team.name,
          null, false, null, null,
          result.home.form, result.away.form
        );
        let homeP = raw.home_win, drawP = raw.draw, awayP = raw.away_win;
        if (calibFactors && calibFactors.sampleSize >= 10) {
          homeP = applyCalibration(homeP, "home", calibFactors);
          drawP = applyCalibration(drawP, "draw", calibFactors);
          awayP = applyCalibration(awayP, "away", calibFactors);
          const t = homeP + drawP + awayP;
          if (t > 0) { homeP = homeP/t*100; drawP = drawP/t*100; awayP = awayP/t*100; }
        }
        const computeEdge = (modelPct: number, decOdds: number | null) => {
          if (!decOdds || modelPct <= 0) return null;
          const fairOdds = 100 / modelPct;
          const edgePct = Math.round(((decOdds * modelPct / 100) - 1) * 10000) / 100;
          return { model_prob: Math.round(modelPct * 10) / 10, fair_odds: Math.round(fairOdds * 100) / 100, bookmaker_odds: decOdds, edge_pct: edgePct, is_value: edgePct >= minEdge };
        };
        const homeEdge = computeEdge(homeP, match.odds!.home_odds ?? null);
        const drawEdge = computeEdge(drawP, match.odds!.draw_odds ?? null);
        const awayEdge = computeEdge(awayP, match.odds!.away_odds ?? null);
        const best = [
          homeEdge?.is_value ? { outcome: "home" as const, ...homeEdge } : null,
          drawEdge?.is_value ? { outcome: "draw" as const, ...drawEdge } : null,
          awayEdge?.is_value ? { outcome: "away" as const, ...awayEdge } : null,
        ].filter(Boolean).sort((a, b) => (b?.edge_pct ?? 0) - (a?.edge_pct ?? 0));
        if (best.length > 0) {
          return {
            match: { id: match.id, kickoff: match.kickoff, home_team: match.home_team, away_team: match.away_team, league_id: match.league_id, league_name: match.league_name, league_logo: match.league_logo },
            confidence: raw.confidence,
            confidence_score: raw.confidence_score,
            edges: { home: homeEdge, draw: drawEdge, away: awayEdge },
            best_edge: best[0],
            reasons: raw.reasons,
          };
        }
        return null;
      } catch { return null; }
    }

    // Run in batches sequentially
    const allResults: unknown[] = [];
    for (let i = 0; i < candidateMatches.length; i += BATCH_SIZE) {
      const batch = candidateMatches.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(scoreMatch));
      allResults.push(...batchResults);
    }
    const results = allResults;
    const valueMatches = results
      .filter(Boolean)
      .sort((a: any, b: any) => (b.best_edge?.edge_pct ?? 0) - (a.best_edge?.edge_pct ?? 0));

    return res.json({ min_edge: minEdge, count: valueMatches.length, value_matches: valueMatches });
  } catch (err) {
    logger.error({ err }, "value centre failed");
    return res.status(500).json({ error: "Failed to compute value centre" });
  }
});

// ─── 5. Watchlist endpoints ───────────────────────────────────────────────────
router.get("/watchlist", async (_req, res) => {
  try {
    const rows = await db.execute(sql`SELECT id, fixture_id, alert_rules, created_at FROM user_watchlist ORDER BY created_at DESC LIMIT 100`) as any;
    return res.json({ items: rows.rows ?? [] });
  } catch (err) {
    logger.error({ err }, "watchlist fetch failed");
    return res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

router.post("/watchlist", async (req, res) => {
  // user_id from request body (future: replace with JWT claim).
  // Validated to be a positive integer; defaults to 1 for single-user deployments.
  const rawUserId = req.body?.user_id ?? req.headers["x-user-id"] ?? 1;
  const user_id = safeInt(rawUserId, 1, 999_999_999) ?? 1;
  const { fixture_id, alert_rules } = req.body ?? {};
  if (!fixture_id) return res.status(400).json({ error: "fixture_id required" });
  try {
    const safeAlertRules = alert_rules
      ? safeString(JSON.stringify(alert_rules), 512)
      : null;
    await db.execute(sql`
      INSERT INTO user_watchlist (user_id, fixture_id, alert_rules, created_at)
      VALUES (${user_id}, ${Number(fixture_id)}, ${safeAlertRules}, NOW())
      ON CONFLICT (user_id, fixture_id) DO NOTHING
    `);
    return res.status(201).json({ ok: true, fixture_id: Number(fixture_id) });
  } catch (err) {
    logger.error({ err }, "watchlist add failed");
    return res.status(500).json({ error: "Failed to add to watchlist" });
  }
});

router.delete("/watchlist/:fixture_id", async (req, res) => {
  const fixtureId = Number(req.params.fixture_id);
  try {
    await db.execute(sql`DELETE FROM user_watchlist WHERE fixture_id = ${fixtureId}`);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "watchlist delete failed");
    return res.status(500).json({ error: "Failed to remove from watchlist" });
  }
});

// ─── 6. Model track record (user-facing performance summary) ──────────────────
router.get("/track-record", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN
          (mp.home_win_prob >= mp.draw_prob AND mp.home_win_prob >= mp.away_win_prob AND mo.outcome = 'home') OR
          (mp.draw_prob > mp.home_win_prob AND mp.draw_prob >= mp.away_win_prob AND mo.outcome = 'draw') OR
          (mp.away_win_prob > mp.home_win_prob AND mp.away_win_prob > mp.draw_prob AND mo.outcome = 'away')
          THEN 1 ELSE 0 END)::int AS correct,
        AVG(
          POWER(CASE WHEN mp.home_win_prob > 1 THEN mp.home_win_prob/100 ELSE mp.home_win_prob END
                - CASE WHEN mo.outcome='home' THEN 1 ELSE 0 END, 2) +
          POWER(CASE WHEN mp.draw_prob > 1 THEN mp.draw_prob/100 ELSE mp.draw_prob END
                - CASE WHEN mo.outcome='draw' THEN 1 ELSE 0 END, 2) +
          POWER(CASE WHEN mp.away_win_prob > 1 THEN mp.away_win_prob/100 ELSE mp.away_win_prob END
                - CASE WHEN mo.outcome='away' THEN 1 ELSE 0 END, 2)
        )::float AS brier_score,
        SUM(CASE WHEN mo.outcome='home' THEN 1 ELSE 0 END)::int AS home_wins,
        SUM(CASE WHEN mo.outcome='draw' THEN 1 ELSE 0 END)::int AS draws,
        SUM(CASE WHEN mo.outcome='away' THEN 1 ELSE 0 END)::int AS away_wins
      FROM match_predictions mp
      JOIN match_outcomes mo ON mo.fixture_id = mp.fixture_id
      WHERE mp.is_live = false
    `) as any;

    const r = (rows.rows ?? rows)[0] ?? {};
    const total = Number(r.total ?? 0);
    const correct = Number(r.correct ?? 0);
    const brier = Number(r.brier_score ?? 0);
    const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
    const randomBaseline = 33.3;
    const improvement = accuracy != null ? Math.round((accuracy - randomBaseline) * 10) / 10 : null;

    return res.json({
      total_predictions: total,
      correct_picks: correct,
      pick_accuracy_pct: accuracy,
      brier_score: Math.round(brier * 1000) / 1000,
      improvement_over_random_pct: improvement,
      outcome_distribution: {
        home_wins: Number(r.home_wins ?? 0),
        draws: Number(r.draws ?? 0),
        away_wins: Number(r.away_wins ?? 0),
      },
      confidence_description: accuracy == null ? "Not enough data yet"
        : accuracy >= 55 ? "Strong performance — meaningfully above the 33% random baseline"
        : accuracy >= 48 ? "Good performance — above random baseline with room to improve"
        : accuracy >= 40 ? "Developing — accumulating data to improve calibration"
        : "Early stage — calibration improves as more results are settled",
    });
  } catch (err) {
    logger.error({ err }, "track record failed");
    return res.status(500).json({ error: "Failed to fetch track record" });
  }
});

export default router;
