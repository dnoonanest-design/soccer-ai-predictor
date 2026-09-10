import type { TeamStrengthProfile } from "./crossLeagueStrength";
import { logger } from "./logger";

const READ_CACHE_TTL = 6 * 60 * 60 * 1000;
const ratingCache = new Map<number, { rating: number; evidenceThrough: number; fetchedAt: number }>();

export async function loadLatestTeamRatings(teamIds: number[], asOf: Date): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  const missing: number[] = [];
  for (const teamId of [...new Set(teamIds.filter((id) => Number.isInteger(id) && id > 0))]) {
    const cached = ratingCache.get(teamId);
    if (cached && cached.evidenceThrough < asOf.getTime() && Date.now() - cached.fetchedAt < READ_CACHE_TTL) result.set(teamId, cached.rating);
    else missing.push(teamId);
  }
  if (missing.length === 0 || !process.env.DATABASE_URL) return result;

  try {
    const { pool } = await import("@workspace/db");
    const rows = await pool.query<{ team_id: number; club_rating: number; evidence_through: Date }>(
      `SELECT DISTINCT ON (team_id) team_id, club_rating, evidence_through
       FROM team_strength_rating_history
       WHERE team_id = ANY($1::int[]) AND evidence_through < $2
       ORDER BY team_id, evidence_through DESC, created_at DESC`,
      [missing, asOf],
    );
    for (const row of rows.rows) {
      const rating = Number(row.club_rating);
      if (!Number.isFinite(rating)) continue;
      result.set(row.team_id, rating);
      ratingCache.set(row.team_id, { rating, evidenceThrough: new Date(row.evidence_through).getTime(), fetchedAt: Date.now() });
    }
  } catch (err) {
    // The prediction remains usable with the conservative league prior while
    // a deployment is waiting for migration 007.
    logger.warn({ err }, "teamStrengthStore: falling back to league priors");
  }
  return result;
}

export async function saveTeamStrengthProfile(
  teamId: number,
  profile: TeamStrengthProfile,
  evidenceThrough: Date,
): Promise<void> {
  if (!process.env.DATABASE_URL || !Number.isInteger(teamId) || teamId <= 0) return;
  try {
    const { pool } = await import("@workspace/db");
    await pool.query(
      `INSERT INTO team_strength_rating_history
        (team_id, domestic_league_id, league_rating, club_rating, schedule_rating,
         uncertainty, matches_used, source, model_version, evidence_through)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (team_id, model_version, evidence_through) DO NOTHING`,
      [teamId, profile.domesticLeagueId, profile.leagueRating, profile.clubRating,
        profile.scheduleRating, profile.uncertainty, profile.matchesUsed,
        profile.source, profile.version, evidenceThrough],
    );
    ratingCache.set(teamId, { rating: profile.clubRating, evidenceThrough: evidenceThrough.getTime(), fetchedAt: Date.now() });
  } catch (err) {
    logger.warn({ err, teamId }, "teamStrengthStore: failed to persist strength rating");
  }
}
