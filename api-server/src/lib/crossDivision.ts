/**
 * Cup ties between clubs from different divisions.
 *
 * The formula rates each side from its own league record. In a cup tie
 * between divisions that is misleading: a fifth-tier club scoring twice a game
 * against amateur sides looks stronger than a second-division club. On 2024-26
 * domestic cup ties in the tracked countries the formula picked the wrong
 * favourite: lower-division hosts of top-flight sides were given ~50% to win
 * and won 12%.
 *
 * This layer uses the division gap itself. Each tier of a country's pyramid has
 * a fitted level; the gap between the two clubs' levels (plus the cup's home
 * advantage) gives home/draw/away chances. For cup ties between divisions the
 * served numbers are mostly this, with a small share of the formula kept for
 * within-division detail. Same-division ties are unchanged.
 *
 * Test (26 Oct 2026; 3,931 FA Cup, EFL Cup, Copa del Rey, Coppa Italia,
 * DFB-Pokal, Coupe de France, Taca de Portugal and KNVB Beker ties, 2024-26):
 * fitted on 2024-25, tested on 2026-27 cross-division ties the formula had
 * predicted (220): formula Brier 0.662, right result 48%; division gap with
 * 10% formula Brier 0.545, right result 61%. Levels below are refitted on all
 * ties. Clubs' divisions come from tracked-league membership that season or
 * the leagues they played in recently.
 * Nothing here reads bookmaker odds.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { getTrackedCompetition, TRACKED_COMPETITIONS } from "./leagueConfig";
import { configuredFootballSeason } from "./season";
import { divisionTierFromCompetitions, isCupOrContinental } from "./divisionTier";

/** Level of each tier (index 0 = tier 1). Higher = weaker. */
export const DIVISION_LEVELS = [0, 0.559, 0.761, 1.167, 1.867, 2.044, 2.333, 2.748, 3.12];
/** Cup home advantage terms for home win and away win (draw is the reference). */
export const CUP_HOME_TERMS = { home: 0.648, away: 0.381 };
/** Share of the formula kept in cross-division cup ties. */
export const CROSS_DIVISION_FORMULA_WEIGHT = 0.1;

/** Lowest tier API-Football covers in each country, plus one: clubs with no league listed play below it. */
const UNLISTED_TIER: Record<string, number> = { england: 9, spain: 6, italy: 5, germany: 6, france: 6, portugal: 5, netherlands: 5 };

type Unit = { home: number; draw: number; away: number };

/** Pure: home/draw/away chances (0-1) from the two clubs' tiers. */
export function crossDivisionProbs(homeTier: number, awayTier: number): Unit {
  const level = (t: number) => DIVISION_LEVELS[Math.max(1, Math.min(DIVISION_LEVELS.length, Math.round(t))) - 1];
  const d = level(awayTier) - level(homeTier);
  const lh = d + CUP_HOME_TERMS.home, la = -d + CUP_HOME_TERMS.away;
  const z = 1 + Math.exp(lh) + Math.exp(la);
  return { home: Math.exp(lh) / z, draw: 1 / z, away: Math.exp(la) / z };
}

/** Pure: served percentages for a cup tie, or null when the clubs are in the same division (or unknown). */
export function blendCrossDivision(
  formula: { home_win: number; draw: number; away_win: number },
  homeTier: number | null, awayTier: number | null,
  formulaWeight = CROSS_DIVISION_FORMULA_WEIGHT,
): { home_win: number; draw: number; away_win: number } | null {
  if (homeTier == null || awayTier == null || homeTier === awayTier) return null;
  const t = formula.home_win + formula.draw + formula.away_win;
  if (!(t > 0)) return null;
  const g = crossDivisionProbs(homeTier, awayTier);
  const w = Math.max(0, Math.min(1, formulaWeight));
  const h = w * formula.home_win / t + (1 - w) * g.home;
  const d = w * formula.draw / t + (1 - w) * g.draw;
  const home = Math.round(h * 10_000) / 100, draw = Math.round(d * 10_000) / 100;
  return { home_win: home, draw, away_win: Math.round((100 - home - draw) * 100) / 100 };
}

/** Pure: a club's tier from tracked-league membership or its recent competitions. */
export function tierFromEvidence(trackedTier: number | null, competitions: string[] | null, country: string): number | null {
  if (trackedTier != null) return trackedTier;
  // No recent matches at all: the lookup failed or the club is new; do not guess.
  if (!competitions || !competitions.length) return null;
  const leagues = competitions.filter((c) => c && c.trim() && !isCupOrContinental(c));
  // No league listed at all: the club plays below the divisions API-Football covers.
  if (!leagues.length) return UNLISTED_TIER[country] ?? null;
  const t = divisionTierFromCompetitions(leagues);
  return t == null ? null : Math.max(3, t); // not in a tracked top-two league this season
}

// ── Tracked top-two membership this season ───────────────────────────────────
const TRACKED_LEAGUE_TIER = new Map<number, number>(
  TRACKED_COMPETITIONS.filter((c) => c.kind === "league" && c.tier).map((c) => [c.id, Number(c.tier)]),
);
let trackedTiers = new Map<number, number>();
let trackedAt = 0;
let trackedLoading: Promise<void> | null = null;

async function loadTrackedTiers() {
  const ids = [...TRACKED_LEAGUE_TIER.keys()];
  const res = await pool.query(
    `SELECT league_id, team FROM (
       SELECT league_id, home_team_id team FROM fixture_team_stats WHERE season = $1 AND league_id = ANY($2::int[])
       UNION SELECT league_id, away_team_id FROM fixture_team_stats WHERE season = $1 AND league_id = ANY($2::int[])) x`,
    [configuredFootballSeason(), ids],
  );
  const next = new Map<number, number>();
  for (const r of res.rows as any[]) {
    const tier = TRACKED_LEAGUE_TIER.get(Number(r.league_id))!;
    const team = Number(r.team);
    next.set(team, Math.min(next.get(team) ?? 9, tier));
  }
  trackedTiers = next;
  trackedAt = Date.now();
}

async function trackedTier(teamId: number): Promise<number | null> {
  if (Date.now() - trackedAt > 6 * 3600_000) {
    trackedLoading ??= loadTrackedTiers().catch((err) => { trackedAt = Date.now() - 5 * 3600_000; logger.warn({ err }, "tracked division lookup failed"); }).finally(() => { trackedLoading = null; });
    await trackedLoading;
  }
  return trackedTiers.get(teamId) ?? null;
}

/** A club's division for a domestic cup tie, or null if it cannot be told. */
export async function teamDivision(teamId: number, cupLeagueId: number): Promise<number | null> {
  const cup = getTrackedCompetition(cupLeagueId);
  if (!cup || cup.kind !== "cup") return null;
  const tracked = await trackedTier(teamId);
  if (tracked != null) return tracked;
  try {
    const { getTeamRecentResults } = await import("./h2hService");
    const recent = await getTeamRecentResults(teamId);
    return tierFromEvidence(null, recent.matches.map((m) => m.competition ?? ""), cup.country.toLowerCase());
  } catch (err) {
    logger.warn({ err, teamId }, "club division lookup failed");
    return null;
  }
}
