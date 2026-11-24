import { db } from "@workspace/db";
import { playerProfiles, playerAiSignals, playerMatchStats } from "@workspace/db/schema";
import { eq, desc, and, gte, isNull, lt, or } from "drizzle-orm";
import { logger } from "./logger.js";

import { anthropicKey, callClaude } from "./anthropicClient";

/**
 * Write-ups are display-only, so they are kept cheap: one batch a day of
 * PLAYER_AI_BATCH players (default 10). At 20 players every 6 hours they cost
 * about $0.14 a day and used up a $5 credit in about five weeks (Nov 2026).
 */
const PLAYER_AI_INTERVAL_MS = Number(process.env.PLAYER_AI_INTERVAL_MS ?? 24 * 60 * 60_000);
const PLAYER_AI_BATCH = Math.max(0, Number(process.env.PLAYER_AI_BATCH ?? 10));
let lastBatchAt = 0;

// Generative AI describes already-computed player evidence; it cannot create
// or promote prediction weights.
/** Returns false when Claude is unavailable (billing, key, rate limit), so a batch can stop. */
export async function analysePlayerWithAI(playerId: number): Promise<boolean> {
  try {
    if (!anthropicKey()) {
      logger.warn({ playerId }, "Skipping AI player analysis: ANTHROPIC_API_KEY is not configured");
      return false;
    }
    const profile = await db.query.playerProfiles.findFirst({
      where: eq(playerProfiles.playerId, playerId)
    });
    if (!profile) return true;

    const recentMatches = await db.select().from(playerMatchStats)
      .where(eq(playerMatchStats.playerId, playerId))
      .orderBy(desc(playerMatchStats.matchDate))
      .limit(20);

    if (recentMatches.length < 5) return true;

    const prompt = `You are a football analytics explanation assistant. Describe cautious, testable patterns in this player's recent data. Do not calculate or invent probabilities, correlations, predictive power, causal effects or numerical signal strength. The application calculates all trusted statistics separately.

PLAYER PROFILE:
Name: ${profile.playerName}
Position: ${profile.position ?? "Unknown"}
Total Matches: ${profile.totalMatches}
Goals: ${profile.totalGoals}, Assists: ${profile.totalAssists}
Avg Rating: ${profile.avgRating?.toFixed(2) ?? "N/A"}
Scoring Momentum Score: ${profile.scoringMomentumScore?.toFixed(3)}
Consecutive Matches Scored: ${profile.consecutiveMatchesScored}
Consecutive Without Goal: ${profile.consecutiveMatchesWithoutGoal}
Goal Probability Next Match: ${profile.goalsProbabilityNextMatch?.toFixed(3)}
Form Trend: ${profile.formTrend}
Form Score: ${profile.formScore?.toFixed(3)}
Confidence Score: ${profile.confidenceScore?.toFixed(3)}
Attitude Score: ${profile.attitudeScore?.toFixed(3)}
Team Win Rate When Starts: ${profile.teamWinRateWhenStarts?.toFixed(3) ?? "N/A"}
Last 5 Goals: ${profile.last5MatchesGoals}, Last 10 Goals: ${profile.last10MatchesGoals}
Club vs International: ${profile.clubGoals} club goals / ${profile.internationalGoals} international goals
Career Stage: ${profile.careerStage ?? "Unknown"}
Growth Rate: ${profile.growthRate?.toFixed(3) ?? "N/A"}

LAST 20 MATCHES (most recent first):
${recentMatches.map((m, i) => `Match ${i+1}: ${m.matchDate?.toISOString().split("T")[0]} | ${m.isInternational ? "INT" : "CLUB"} | ${m.minutesPlayed}mins | Rating: ${m.rating ?? "N/A"} | Goals: ${m.goals} | Assists: ${m.assists} | Shots: ${m.shots} | PassAcc: ${m.passAccuracy ?? "N/A"}% | Tackles: ${m.successfulTackles} | YC: ${m.yellowCards} | Result: ${m.teamResult}`).join("\n")}

Your task:
1. Identify up to 3 candidate patterns specific to this player, one sentence each.
2. Describe the observations behind each pattern without claiming causation.
3. State clearly that small samples are uncertain.
4. Write a 2 sentence insight summary.

Respond in JSON only:
{
  "signals": [
    {
      "signalName": "string",
      "signalDescription": "string"
    }
  ],
  "insightSummary": "string"
}`;

    const reply = await callClaude(prompt, 3000, "player write-up");
    if (!reply.text) {
      // Paused (billing, key, rate limit): mark nothing, stop the batch.
      if (reply.paused) return false;
      throw new Error(reply.error ?? "no reply");
    }
    const text = reply.text;
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as Record<string, unknown>;
    // Generative AI is an explanation layer only. It is forbidden from
    // originating trusted probabilities, correlations or predictive power.
    const descriptions = Array.isArray(parsed.signals)
      ? parsed.signals.slice(0, 5).map((signal: any) => ({
          signalName: String(signal?.signalName ?? "Observed pattern").slice(0, 80),
          signalDescription: String(signal?.signalDescription ?? "").slice(0, 500),
        }))
      : [];
    const totalMinutes = recentMatches.reduce((sum, match) => sum + Math.max(0, Number(match.minutesPlayed ?? 0)), 0);
    const totalGoals = recentMatches.reduce((sum, match) => sum + Math.max(0, Number(match.goals ?? 0)), 0);
    // Empirical-Bayes scoring rate: player evidence plus a conservative
    // 0.25 goals/90 prior over the equivalent of five full matches.
    const ratePer90 = (totalGoals + 1.25) / Math.max(5, totalMinutes / 90 + 5);
    const computedGoalProbability = Math.max(0.01, Math.min(0.85, 1 - Math.exp(-ratePer90)));

    // Update profile with AI insights
    await db.update(playerProfiles).set({
      goalsProbabilityNextMatch: computedGoalProbability,
      aiInsightSummary: String(parsed.insightSummary ?? "").slice(0, 1000),
      aiDiscoveredPatterns: descriptions,
      aiConfidenceInProfile: Math.min(1, recentMatches.length / 20),
      aiLastAnalysedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(playerProfiles.playerId, playerId));

    logger.info({ playerId, playerName: profile.playerName, signalsFound: descriptions.length }, "AI player explanation complete");
  } catch (err) {
    logger.error({ playerId }, `AI player analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    // Try this player again in two days rather than at the front of every batch.
    await db.update(playerProfiles).set({ aiLastAnalysedAt: new Date() }).where(eq(playerProfiles.playerId, playerId)).catch(() => {});
  }
  return true;
}

// Run AI analysis on players who have enough data and haven't been analysed recently
export async function runBatchAIPlayerAnalysis(limit = PLAYER_AI_BATCH): Promise<void> {
  if (!anthropicKey()) {
    logger.info("AI player explanations disabled: ANTHROPIC_API_KEY is not configured");
    return;
  }
  if (limit <= 0 || Date.now() - lastBatchAt < PLAYER_AI_INTERVAL_MS) return;
  lastBatchAt = Date.now();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const players = await db.select().from(playerProfiles)
    .where(and(
      gte(playerProfiles.totalMatches, 5),
      or(isNull(playerProfiles.aiLastAnalysedAt), lt(playerProfiles.aiLastAnalysedAt, twoDaysAgo)),
    ))
    .orderBy(desc(playerProfiles.updatedAt))
    .limit(limit);

  logger.info({ count: players.length }, "starting batch AI player analysis");

  for (const player of players) {
    if (!(await analysePlayerWithAI(player.playerId))) {
      logger.warn("batch AI player analysis stopped: Claude is unavailable");
      break;
    }
    // Rate limit - wait 2s between AI calls
    await new Promise(r => setTimeout(r, 2000));
  }

  logger.info("batch AI player analysis complete");
}

// Legacy display-only signals. The canonical predictor never reads this table.
export async function getPlayerAISignals(playerId: number) {
  return db.select().from(playerAiSignals)
    .where(and(eq(playerAiSignals.playerId, playerId), eq(playerAiSignals.active, true)))
    .orderBy(desc(playerAiSignals.predictivePower));
}
