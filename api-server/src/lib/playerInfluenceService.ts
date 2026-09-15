import { db } from "@workspace/db";
import { playerProfiles } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";

export interface MatchParticipant {
  id: number;
  name: string;
  position: string;
}

export interface PlayerInfluenceRecord {
  player_id: number;
  name: string;
  position: string;
  sample_matches: number;
  reliability: number;
  rating: number;
  attack_score: number;
  defence_score: number;
  overall_score: number;
  form_trend: string;
  form_score: number;
  scoring_streak: number;
  goalless_streak: number;
  classification: "star" | "influential" | "positive_form" | "negative_form" | "tracked";
}

export interface TeamPlayerInfluence {
  attack_factor: number;
  defence_factor: number;
  coverage: number;
  involved_players: PlayerInfluenceRecord[];
  star_players: PlayerInfluenceRecord[];
  influential_players: PlayerInfluenceRecord[];
  positive_form_players: PlayerInfluenceRecord[];
  negative_form_players: PlayerInfluenceRecord[];
}

export interface MatchPlayerInfluence {
  confirmed_participants_only: true;
  home: TeamPlayerInfluence;
  away: TeamPlayerInfluence;
  home_xg_factor: number;
  away_xg_factor: number;
}

type Profile = typeof playerProfiles.$inferSelect;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
}

function role(position: string): "G" | "D" | "M" | "F" {
  const p = position.trim().toUpperCase();
  if (p.startsWith("G")) return "G";
  if (p.startsWith("D") || p.includes("BACK")) return "D";
  if (p.startsWith("F") || p.includes("STRIK") || p.includes("WING")) return "F";
  return "M";
}

/**
 * Converts a pre-match profile into bounded, position-aware attack/defence
 * scores. Reliability shrinkage prevents a short hot streak dominating a
 * forecast. No current-match result or post-match statistic is used here.
 */
export function scorePlayerProfile(profile: Profile, participant: MatchParticipant): PlayerInfluenceRecord {
  const matches = Math.max(0, profile.totalMatches ?? 0);
  const minutes = Math.max(0, profile.totalMinutesPlayed ?? 0);
  const exposure90 = minutes / 90;
  const reliability = clamp(Math.min(matches / 20, minutes / 1350), 0, 1);
  const per90 = (total: number | null | undefined) => (Number(total ?? 0) + 0.15) / Math.max(1.5, exposure90 + 1.5);
  const goals90 = per90(profile.totalGoals);
  const assists90 = per90(profile.totalAssists);
  const shots90 = per90(profile.totalShots);
  const shotsOnTarget90 = per90(profile.totalShotsOnTarget);
  const keyPasses90 = per90(profile.totalKeyPasses);
  const tackles90 = per90(profile.totalSuccessfulTackles);
  const rating = clamp(profile.last5MatchesRating ?? profile.avgRating ?? 6.7, 4, 9.5);
  const ratingSignal = clamp((rating - 6.7) / 1.3, -1, 1);
  const r = role(participant.position || profile.position || "M");
  const passSignal = profile.avgPassAccuracy == null ? 0 : clamp((profile.avgPassAccuracy - 76) / 14, -1, 1);
  const starterEvidence = Math.max(0, profile.matchesAsStarter ?? 0);
  const teamImpact = starterEvidence >= 10
    ? clamp(((profile.teamWinRateWhenStarts ?? 0.45) - 0.45) / 0.25, -1, 1)
    : 0;
  const concededImpact = starterEvidence >= 10 && profile.teamGoalsConcededWhenStarts != null
    ? clamp((1.35 - profile.teamGoalsConcededWhenStarts) / 0.8, -1, 1)
    : 0;

  const attackBaseline = r === "F"
    ? goals90 / 0.45 * 0.40 + assists90 / 0.20 * 0.18 + shots90 / 2.7 * 0.12 + shotsOnTarget90 / 1.15 * 0.18 + keyPasses90 / 1.2 * 0.12
    : r === "M"
      ? goals90 / 0.18 * 0.22 + assists90 / 0.22 * 0.27 + shotsOnTarget90 / 0.5 * 0.12 + keyPasses90 / 1.5 * 0.27 + (1 + passSignal) * 0.12
      : r === "D"
        ? goals90 / 0.06 * 0.12 + assists90 / 0.10 * 0.16 + keyPasses90 / 0.65 * 0.16 + tackles90 / 1.7 * 0.40 + (1 + passSignal) * 0.16
        : 1 + ratingSignal * 0.35;
  const defenceBaseline = r === "G"
    ? 1 + ratingSignal * 0.55 + concededImpact * 0.25 + teamImpact * 0.10
    : r === "D"
      ? tackles90 / 1.8 * 0.50 + (1 + ratingSignal) * 0.25 + (1 + passSignal) * 0.10 + (1 + concededImpact) * 0.15
      : r === "M"
        ? tackles90 / 1.25 * 0.48 + (1 + ratingSignal) * 0.32 + (1 + passSignal) * 0.10 + (1 + teamImpact) * 0.10
        : tackles90 / 0.55 * 0.35 + (1 + ratingSignal) * 0.65;

  const resultForm = clamp(profile.formScore ?? 0, -1, 1);
  const growth = clamp((profile.growthRate ?? 0) / 0.7, -1, 1);
  const confidence = clamp((profile.confidenceScore ?? 0.5) * 2 - 1, -1, 1);
  const scoringStreak = Math.max(0, profile.consecutiveMatchesScored ?? 0);
  const goallessStreak = Math.max(0, profile.consecutiveMatchesWithoutGoal ?? 0);
  const streakSignal = r === "F" || r === "M"
    ? clamp(scoringStreak * 0.18 - Math.max(0, goallessStreak - 2) * 0.08, -0.55, 0.65)
    : 0;
  const form = clamp(ratingSignal * 0.45 + resultForm * 0.20 + growth * 0.20 + confidence * 0.15 + streakSignal, -1, 1);
  const discipline = clamp(1 - ((profile.totalRedCards ?? 0) * 3 + (profile.totalYellowCards ?? 0)) / Math.max(5, matches) * 0.12, 0.75, 1);
  // Winsorise the raw role comparison before reliability shrinkage. Without
  // this ordering, one goal in a few substitute minutes can survive shrinkage
  // as a false elite signal.
  const attackScore = clamp((clamp(attackBaseline - 1, -2, 2) * 0.58 + form * 0.42) * reliability, -1, 1);
  const defenceScore = clamp((clamp(defenceBaseline * discipline - 1, -2, 2) * 0.62 + form * 0.38) * reliability, -1, 1);
  const roleAttackWeight = r === "F" ? 0.75 : r === "M" ? 0.58 : r === "D" ? 0.35 : 0.2;
  const overall = clamp(attackScore * roleAttackWeight + defenceScore * (1 - roleAttackWeight), -1, 1);
  const classification = reliability >= 0.55 && rating >= 7.2 && overall >= 0.22
    ? "star"
    : reliability >= 0.4 && Math.abs(overall) >= 0.16
      ? "influential"
      : form >= 0.25
        ? "positive_form"
        : form <= -0.25
          ? "negative_form"
          : "tracked";

  return {
    player_id: participant.id,
    name: participant.name || profile.playerName,
    position: participant.position || profile.position || "M",
    sample_matches: matches,
    reliability: Number(reliability.toFixed(3)),
    rating: Number(rating.toFixed(2)),
    attack_score: Number(attackScore.toFixed(3)),
    defence_score: Number(defenceScore.toFixed(3)),
    overall_score: Number(overall.toFixed(3)),
    form_trend: profile.formTrend ?? "unknown",
    form_score: Number(form.toFixed(3)),
    scoring_streak: scoringStreak,
    goalless_streak: goallessStreak,
    classification,
  };
}

function aggregateTeam(players: PlayerInfluenceRecord[], participantCount: number): TeamPlayerInfluence {
  const coverage = clamp(players.reduce((sum, p) => sum + p.reliability, 0) / Math.max(11, participantCount), 0, 1);
  const weightedMean = (field: "attack_score" | "defence_score") => {
    const weight = players.reduce((sum, p) => sum + p.reliability, 0);
    return weight > 0 ? players.reduce((sum, p) => sum + p[field] * p.reliability, 0) / weight : 0;
  };
  // Maximum team-level effect is deliberately narrow. Player data refines the
  // team model; it never replaces season strength, opponent quality or xG.
  const attackFactor = clamp(1 + weightedMean("attack_score") * 0.055 * coverage, 0.95, 1.05);
  const defenceFactor = clamp(1 - weightedMean("defence_score") * 0.045 * coverage, 0.96, 1.04);
  const byImportance = [...players].sort((a, b) => Math.abs(b.overall_score) - Math.abs(a.overall_score));
  return {
    attack_factor: Number(attackFactor.toFixed(4)),
    defence_factor: Number(defenceFactor.toFixed(4)),
    coverage: Number(coverage.toFixed(3)),
    involved_players: byImportance,
    star_players: byImportance.filter((p) => p.classification === "star"),
    influential_players: byImportance.filter((p) => p.classification === "star" || p.classification === "influential"),
    positive_form_players: byImportance.filter((p) => p.form_score >= 0.25),
    negative_form_players: byImportance.filter((p) => p.form_score <= -0.25),
  };
}

export async function getMatchPlayerInfluence(
  homeParticipants: MatchParticipant[],
  awayParticipants: MatchParticipant[],
): Promise<MatchPlayerInfluence | null> {
  if (homeParticipants.length === 0 || awayParticipants.length === 0) return null;
  const participants = [...homeParticipants, ...awayParticipants];
  const ids = [...new Set(participants.map((p) => p.id).filter((id) => id > 0))];
  if (ids.length === 0) return null;
  const profiles = await db.select().from(playerProfiles).where(inArray(playerProfiles.playerId, ids));
  const byId = new Map(profiles.map((p) => [p.playerId, p]));
  const score = (team: MatchParticipant[]) => team.flatMap((participant) => {
    const profile = byId.get(participant.id);
    return profile ? [scorePlayerProfile(profile, participant)] : [];
  });
  const home = aggregateTeam(score(homeParticipants), homeParticipants.length);
  const away = aggregateTeam(score(awayParticipants), awayParticipants.length);
  return {
    confirmed_participants_only: true,
    home,
    away,
    home_xg_factor: Number(clamp(home.attack_factor * away.defence_factor, 0.92, 1.08).toFixed(4)),
    away_xg_factor: Number(clamp(away.attack_factor * home.defence_factor, 0.92, 1.08).toFixed(4)),
  };
}
