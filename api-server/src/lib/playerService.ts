import { db } from "@workspace/db";
import { playerMatchStats, playerProfiles, playerAiSignals } from "@workspace/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { fetchFootball } from "./soccerService.js";
import { logger } from "./logger.js";

const INTERNATIONAL_LEAGUE_IDS = new Set([
  4, 5, 6, 7, 8, 9, 10,
  152, 153, 154, 155, 156, 157, 158, 159, 160,
]);

interface ApiPlayerStat {
  player: { id: number; name: string; photo?: string };
  statistics: Array<{
    games: { minutes: number | null; rating: string | null; captain: boolean; substitute: boolean; number: number };
    goals: { total: number | null; assists: number | null };
    shots: { total: number | null; on: number | null };
    passes: { total: number | null; key: number | null; accuracy: string | null };
    tackles: { total: number | null; blocks: number | null };
    duels: { total: number | null; won: number | null };
    dribbles: { attempts: number | null; success: number | null };
    fouls: { drawn: number | null; committed: number | null };
    cards: { yellow: number; red: number };
    penalty: { won: number | null; scored: number | null };
  }>;
}

// ── FIXED: now returns a Promise so callers can await it properly ─────────────
export async function collectPlayerStatsForFixture(
  fixtureId: number,
  leagueId: number,
  matchDate: Date,
  homeTeamId: number,
  awayTeamId: number,
  homeResult: "win" | "draw" | "loss",
  homeGoals: number,
  awayGoals: number
): Promise<void> {
  try {
    // Check if already collected for this fixture
    const existing = await db.select().from(playerMatchStats)
      .where(eq(playerMatchStats.fixtureId, fixtureId))
      .limit(1);
    if (existing.length > 0) {
      logger.info({ fixtureId }, "player stats already collected, skipping");
      return;
    }

    const isInternational = INTERNATIONAL_LEAGUE_IDS.has(leagueId);
    const data = await fetchFootball(`/fixtures/players?fixture=${fixtureId}`) as any;
    if (!data?.response?.length) return;

    for (const teamData of data.response) {
      const teamId = teamData.team?.id;
      const teamSide = teamId === homeTeamId ? "home" : "away";
      const teamResult = teamSide === "home" ? homeResult :
        homeResult === "win" ? "loss" : homeResult === "loss" ? "win" : "draw";
      const teamGoalsScored = teamSide === "home" ? homeGoals : awayGoals;
      const teamGoalsConceded = teamSide === "home" ? awayGoals : homeGoals;

      for (const playerData of (teamData.players || []) as ApiPlayerStat[]) {
        const p = playerData.player;
        const s = playerData.statistics?.[0];
        if (!p?.id || !s) continue;

        const minutesPlayed = s.games?.minutes ?? 0;
        const rating = s.games?.rating ? parseFloat(s.games.rating) : null;
        const goals = s.goals?.total ?? 0;
        const assists = s.goals?.assists ?? 0;
        const shots = s.shots?.total ?? 0;
        const shotsOnTarget = s.shots?.on ?? 0;
        const passAccuracy = s.passes?.accuracy ? parseFloat(s.passes.accuracy) : null;
        const keyPasses = s.passes?.key ?? 0;
        const successfulTackles = s.tackles?.total ?? 0;
        const yellowCards = s.cards?.yellow ?? 0;
        const redCards = s.cards?.red ?? 0;
        const foulsCommitted = s.fouls?.committed ?? 0;
        const foulsDrawn = s.fouls?.drawn ?? 0;
        const dribbles = s.dribbles?.success ?? 0;
        const dribblesAttempted = s.dribbles?.attempts ?? 0;
        const aerialDuelsWon = s.duels?.won ?? 0;

        await db.insert(playerMatchStats).values({
          playerId: p.id,
          playerName: p.name,
          fixtureId,
          teamId,
          teamSide,
          isInternational,
          matchDate,
          minutesPlayed,
          rating,
          goals,
          assists,
          shots,
          shotsOnTarget,
          passAccuracy,
          keyPasses,
          successfulTackles,
          totalTackles: s.tackles?.total ?? 0,
          yellowCards,
          redCards,
          foulsCommitted,
          foulsDrawn,
          dribbles,
          dribblesAttempted,
          aerialDuelsWon,
          teamResult,
          teamGoalsScored,
          teamGoalsConceded,
        }).onConflictDoNothing();

        await updatePlayerProfile(p.id, p.name, {
          isInternational, teamId, minutesPlayed, rating, goals, assists,
          shots, shotsOnTarget, passAccuracy, keyPasses, successfulTackles,
          yellowCards, redCards, teamResult,
          isStarter: !s.games?.substitute,
          teamGoalsScored, teamGoalsConceded,
          substitutedOff: minutesPlayed > 0 && minutesPlayed < 90 && !s.games?.substitute ? minutesPlayed : null,
        });
      }
    }
    logger.info({ fixtureId }, "player stats collected");
  } catch (err) {
    logger.error({ err, fixtureId }, "failed to collect player stats");
  }
}

async function updatePlayerProfile(
  playerId: number,
  playerName: string,
  match: {
    isInternational: boolean; teamId: number | undefined; minutesPlayed: number;
    rating: number | null; goals: number; assists: number; shots: number;
    shotsOnTarget: number; passAccuracy: number | null; keyPasses: number;
    successfulTackles: number; yellowCards: number; redCards: number;
    teamResult: string; isStarter: boolean; teamGoalsScored: number;
    teamGoalsConceded: number; substitutedOff: number | null;
  }
): Promise<void> {
  const existing = await db.query.playerProfiles.findFirst({
    where: eq(playerProfiles.playerId, playerId)
  });

  const recentMatches = await db.select().from(playerMatchStats)
    .where(eq(playerMatchStats.playerId, playerId))
    .orderBy(desc(playerMatchStats.matchDate))
    .limit(10);

  const last5 = recentMatches.slice(0, 5);
  const last5Goals = last5.reduce((s, m) => s + m.goals, 0);
  const last5Assists = last5.reduce((s, m) => s + (m.assists ?? 0), 0);
  const last5Ratings = last5.filter(m => m.rating).map(m => m.rating as number);
  const last5AvgRating = last5Ratings.length
    ? last5Ratings.reduce((a, b) => a + b, 0) / last5Ratings.length
    : null;
  const last10Goals = recentMatches.reduce((s, m) => s + m.goals, 0);

  let momentumScore = 0;
  for (let i = 0; i < last5.length; i++) {
    const weight = (5 - i) / 5;
    momentumScore += last5[i].goals * weight;
    if (last5[i].assists) momentumScore += (last5[i].assists ?? 0) * 0.3 * weight;
  }

  let consecutiveScored = 0;
  let consecutiveWithout = 0;
  let onStreak = true;
  for (const m of recentMatches) {
    if (onStreak) {
      if (m.goals > 0) consecutiveScored++;
      else { onStreak = false; consecutiveWithout = 0; }
    } else {
      if (m.goals === 0) consecutiveWithout++;
      else break;
    }
  }

  const goalsProbability = Math.min(0.95, Math.max(0.02,
    (momentumScore * 0.4) + (last10Goals / 10 * 0.6)
  ));

  const resultScores = last5.map(m =>
    m.teamResult === "win" ? 1 : m.teamResult === "draw" ? 0 : -1
  );
  const formScore = resultScores.length
    ? resultScores.reduce((a, b) => a + b, 0) / resultScores.length
    : 0;

  const firstHalf = recentMatches.slice(5).map(m => m.rating ?? 6).reduce((a, b) => a + b, 0) / 5;
  const secondHalf = last5.map(m => m.rating ?? 6).reduce((a, b) => a + b, 0) / 5;
  const growthRate = secondHalf - firstHalf;
  const formTrend = growthRate > 0.3 ? "improving"
    : growthRate < -0.3 ? "declining"
    : Math.abs(growthRate) < 0.1 ? "stable"
    : "erratic";

  const avgMins = recentMatches.reduce((s, m) => s + (m.minutesPlayed ?? 0), 0)
    / Math.max(recentMatches.length, 1);
  const confidenceScore = Math.min(1, Math.max(0,
    (avgMins / 90 * 0.4) + ((formScore + 1) / 2 * 0.4) + (momentumScore / 5 * 0.2)
  ));

  const totalCards = (existing?.totalYellowCards ?? 0) + match.yellowCards +
    ((existing?.totalRedCards ?? 0) + match.redCards) * 3;
  const attitudeScore = Math.min(1, Math.max(0,
    1 - (totalCards * 0.02) - ((existing?.substitutedEarlyCount ?? 0) * 0.01)
  ));

  const starterMatches = await db.select().from(playerMatchStats)
    .where(and(eq(playerMatchStats.playerId, playerId)))
    .limit(50);
  const starterWins = starterMatches.filter(m => m.teamResult === "win").length;
  const teamWinRate = starterMatches.length ? starterWins / starterMatches.length : null;

  const base = existing ?? {
    totalMatches: 0, totalStarts: 0, totalGoals: 0, totalAssists: 0,
    totalShots: 0, totalShotsOnTarget: 0, totalKeyPasses: 0,
    totalSuccessfulTackles: 0, totalYellowCards: 0, totalRedCards: 0,
    totalMinutesPlayed: 0, matchesAsStarter: 0, winsAsStarter: 0,
    clubMatches: 0, clubGoals: 0, internationalMatches: 0, internationalGoals: 0,
    substitutedEarlyCount: 0, substitutedLateCount: 0,
  };

  const newTotalMatches = (base.totalMatches ?? 0) + 1;
  const newTotalGoals = (base.totalGoals ?? 0) + match.goals;
  const newTotalMinutes = (base.totalMinutesPlayed ?? 0) + match.minutesPlayed;

  const values = {
    playerId, playerName,
    teamId: match.teamId,
    totalMatches: newTotalMatches,
    totalStarts: (base.totalStarts ?? 0) + (match.isStarter ? 1 : 0),
    totalGoals: newTotalGoals,
    totalAssists: (base.totalAssists ?? 0) + match.assists,
    totalShots: (base.totalShots ?? 0) + match.shots,
    totalShotsOnTarget: (base.totalShotsOnTarget ?? 0) + match.shotsOnTarget,
    totalKeyPasses: (base.totalKeyPasses ?? 0) + match.keyPasses,
    totalSuccessfulTackles: (base.totalSuccessfulTackles ?? 0) + match.successfulTackles,
    totalYellowCards: (base.totalYellowCards ?? 0) + match.yellowCards,
    totalRedCards: (base.totalRedCards ?? 0) + match.redCards,
    totalMinutesPlayed: newTotalMinutes,
    avgRating: last5AvgRating,
    avgPassAccuracy: match.passAccuracy,
    avgShotsPerMatch: newTotalGoals / newTotalMatches,
    avgKeyPassesPerMatch: ((base.totalKeyPasses ?? 0) + match.keyPasses) / newTotalMatches,
    avgTacklesPerMatch: ((base.totalSuccessfulTackles ?? 0) + match.successfulTackles) / newTotalMatches,
    avgMinutesPerMatch: newTotalMinutes / newTotalMatches,
    scoringMomentumScore: momentumScore,
    consecutiveMatchesScored: consecutiveScored,
    consecutiveMatchesWithoutGoal: consecutiveWithout,
    goalsProbabilityNextMatch: goalsProbability,
    last5MatchesGoals: last5Goals,
    last5MatchesAssists: last5Assists,
    last5MatchesRating: last5AvgRating,
    last10MatchesGoals: last10Goals,
    formTrend, formScore, growthRate,
    confidenceScore, attitudeScore,
    substitutedEarlyCount: (base.substitutedEarlyCount ?? 0) +
      (match.substitutedOff && match.substitutedOff < 60 ? 1 : 0),
    substitutedLateCount: (base.substitutedLateCount ?? 0) +
      (match.substitutedOff && match.substitutedOff >= 60 ? 1 : 0),
    teamWinRateWhenStarts: teamWinRate,
    teamGoalsScoredWhenStarts: match.teamGoalsScored,
    teamGoalsConcededWhenStarts: match.teamGoalsConceded,
    matchesAsStarter: (base.matchesAsStarter ?? 0) + (match.isStarter ? 1 : 0),
    winsAsStarter: (base.winsAsStarter ?? 0) + (match.isStarter && match.teamResult === "win" ? 1 : 0),
    clubMatches: (base.clubMatches ?? 0) + (match.isInternational ? 0 : 1),
    clubGoals: (base.clubGoals ?? 0) + (match.isInternational ? 0 : match.goals),
    internationalMatches: (base.internationalMatches ?? 0) + (match.isInternational ? 1 : 0),
    internationalGoals: (base.internationalGoals ?? 0) + (match.isInternational ? match.goals : 0),
    currentClubId: match.isInternational ? undefined : match.teamId,
    nationalTeamId: match.isInternational ? match.teamId : undefined,
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(playerProfiles).set(values).where(eq(playerProfiles.playerId, playerId));
  } else {
    await db.insert(playerProfiles).values({ ...values, createdAt: new Date() });
  }
}

export async function getPlayerProfile(playerId: number) {
  return db.query.playerProfiles.findFirst({
    where: eq(playerProfiles.playerId, playerId)
  });
}

export async function getTopScoringMomentumPlayers(limit = 10) {
  return db.select().from(playerProfiles)
    .orderBy(desc(playerProfiles.scoringMomentumScore))
    .limit(limit);
}
