import { db } from "@workspace/db";
import { playerProfiles, playerAiSignals, playerMatchStats } from "@workspace/db/schema";
import { eq, desc, and, gte } from "drizzle-orm";
import { logger } from "./logger.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// AI analyses a player and discovers its own predictive signals
export async function analysePlayerWithAI(playerId: number): Promise<void> {
  try {
    const profile = await db.query.playerProfiles.findFirst({
      where: eq(playerProfiles.playerId, playerId)
    });
    if (!profile) return;

    const recentMatches = await db.select().from(playerMatchStats)
      .where(eq(playerMatchStats.playerId, playerId))
      .orderBy(desc(playerMatchStats.matchDate))
      .limit(20);

    if (recentMatches.length < 5) return;

    const prompt = `You are a football analytics AI. Analyse this player profile and their recent match data to discover predictive signals that correlate with their performance and team results.

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
${recentMatches.map((m, i) => `Match ${i+1}: ${m.matchDate?.toISOString().split("T")[0]} | ${m.isInternational ? "INT" : "CLUB"} | ${m.minutesPlayed}mins | Rating: ${m.rating ?? "N/A"} | Goals: ${m.goals} | Assists: ${m.assists} | Shots: ${m.shots} | PassAcc: ${m.passAccuracy ?? "N/A"}% | Tackles: ${m.successfulTackles} | YC: ${m.yellowCards} | Result: ${m.teamResult}`).join("
")}

Your task:
1. Identify 3-5 unique predictive signals specific to THIS player
2. For each signal, estimate its predictive power (0-1) for goals/performance
3. Note any patterns like: "scores after international duty", "performs better at home", "loses form after yellow card", "scoring streaks last X matches on average", etc
4. Calculate a goal scoring probability for their next match
5. Write a 2-3 sentence insight summary

Respond in JSON only:
{
  "signals": [
    {
      "signalName": "string",
      "signalDescription": "string", 
      "signalValue": number,
      "predictivePower": number (0-1),
      "goalCorrelation": number (-1 to 1),
      "outcomeCorrelation": number (-1 to 1)
    }
  ],
  "goalsProbabilityNextMatch": number (0-1),
  "careerStage": "emerging|prime|declining|veteran",
  "insightSummary": "string"
}`;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json() as any;
    const text = data.content?.[0]?.text ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Save AI-discovered signals
    for (const signal of parsed.signals ?? []) {
      await db.insert(playerAiSignals).values({
        playerId,
        playerName: profile.playerName,
        signalName: signal.signalName,
        signalDescription: signal.signalDescription,
        signalValue: signal.signalValue,
        predictivePower: signal.predictivePower,
        goalCorrelation: signal.goalCorrelation,
        outcomeCorrelation: signal.outcomeCorrelation,
        sampleSize: recentMatches.length,
        lastValidatedAt: new Date(),
      }).onConflictDoNothing();
    }

    // Update profile with AI insights
    await db.update(playerProfiles).set({
      goalsProbabilityNextMatch: parsed.goalsProbabilityNextMatch,
      careerStage: parsed.careerStage,
      aiInsightSummary: parsed.insightSummary,
      aiDiscoveredPatterns: parsed.signals,
      aiConfidenceInProfile: recentMatches.length / 20,
      aiLastAnalysedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(playerProfiles.playerId, playerId));

    logger.info({ playerId, playerName: profile.playerName, signalsFound: parsed.signals?.length }, "AI player analysis complete");
  } catch (err) {
    logger.error({ err, playerId }, "AI player analysis failed");
  }
}

// Run AI analysis on players who have enough data and haven't been analysed recently
export async function runBatchAIPlayerAnalysis(limit = 20): Promise<void> {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const players = await db.select().from(playerProfiles)
    .where(and(
      gte(playerProfiles.totalMatches, 5),
    ))
    .orderBy(desc(playerProfiles.updatedAt))
    .limit(limit);

  logger.info({ count: players.length }, "starting batch AI player analysis");

  for (const player of players) {
    await analysePlayerWithAI(player.playerId);
    // Rate limit - wait 2s between AI calls
    await new Promise(r => setTimeout(r, 2000));
  }

  logger.info("batch AI player analysis complete");
}

// Get AI signals for a player ranked by predictive power
export async function getPlayerAISignals(playerId: number) {
  return db.select().from(playerAiSignals)
    .where(and(eq(playerAiSignals.playerId, playerId), eq(playerAiSignals.active, true)))
    .orderBy(desc(playerAiSignals.predictivePower));
}
