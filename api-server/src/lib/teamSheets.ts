/**
 * Pre-kickoff team sheets: who starts and who is missing, captured before
 * kickoff and never changed (table prematch_team_sheets, migration 023).
 *
 * The pattern audit (25 Oct 2026) found the app cannot tell a strong side with
 * five regulars out from the same side at full strength: the only stored
 * evidence was a count of injury-list entries, and the full lists were
 * overwritten once play started. This module keeps the names and ids, and
 * turns them into availability measures using each player's recent minutes
 * for that team, so the value of a missing player can be learned later from
 * settled matches.
 *
 * Collection reuses the lineup and injury responses already fetched for the
 * circumstance snapshot, so it costs no extra API-Football requests.
 */
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";

export type SheetPlayer = { id: number | null; name: string; pos?: string | null };
export type MissingPlayer = { id: number | null; name: string; type: string | null; reason: string | null };

export type ApiLineupLike = {
  team?: { id?: number; name?: string };
  formation?: string | null;
  startXI?: Array<{ player?: { id?: number; name?: string; pos?: string } }>;
  substitutes?: Array<{ player?: { id?: number; name?: string; pos?: string } }>;
};
export type ApiInjuryLike = {
  team?: { id?: number; name?: string };
  player?: { id?: number; name?: string; type?: string; reason?: string };
};

export type TeamSheet = {
  side: "home" | "away";
  teamId: number;
  formation: string | null;
  startingXi: SheetPlayer[] | null;
  bench: SheetPlayer[] | null;
  missing: MissingPlayer[];
  contentHash: string;
};

const toPlayer = (p?: { id?: number; name?: string; pos?: string }): SheetPlayer => ({
  id: Number.isFinite(Number(p?.id)) && Number(p?.id) > 0 ? Number(p?.id) : null,
  name: String(p?.name ?? "Unknown"),
  pos: p?.pos ?? null,
});

/** Build one side's sheet from the provider's lineup and injury responses. */
export function buildTeamSheet(side: "home" | "away", teamId: number, teamName: string, lineups: ApiLineupLike[], injuries: ApiInjuryLike[]): TeamSheet {
  const lineup = lineups.find((l) => l.team?.id === teamId)
    ?? lineups.find((l) => (l.team?.name ?? "").toLowerCase() === teamName.toLowerCase());
  const xi = (lineup?.startXI ?? []).map((x) => toPlayer(x.player));
  const bench = (lineup?.substitutes ?? []).map((x) => toPlayer(x.player));
  const seen = new Set<string>();
  const missing: MissingPlayer[] = [];
  for (const i of injuries) {
    if (i.team?.id !== teamId) continue;
    const p = toPlayer(i.player);
    const key = p.id != null ? `id:${p.id}` : `name:${p.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push({ id: p.id, name: p.name, type: i.player?.type ?? null, reason: i.player?.reason ?? null });
  }
  missing.sort((a, b) => (a.id ?? 0) - (b.id ?? 0) || a.name.localeCompare(b.name));
  const startingXi = xi.length >= 11 ? xi : null; // a partial XI is not a published team sheet
  const formation = startingXi ? (lineup?.formation ?? null) : null;
  const benchOut = startingXi ? bench : null;
  const contentHash = createHash("sha256")
    .update(JSON.stringify({ formation, xi: startingXi?.map((p) => p.id ?? p.name) ?? null, missing: missing.map((m) => [m.id ?? m.name, m.type]) }))
    .digest("hex")
    .slice(0, 32);
  return { side, teamId, formation, startingXi, bench: benchOut, missing, contentHash };
}

type MatchLike = {
  id: number;
  league_id?: number | null;
  kickoff: string;
  status: string;
  home_team: { id: number; name: string };
  away_team: { id: number; name: string };
};

/**
 * Append both sides' sheets if they changed since the last capture. Only runs
 * before kickoff; the database trigger enforces the same rule by wall clock.
 */
export async function recordPrematchTeamSheets(match: MatchLike, lineups: ApiLineupLike[], injuries: ApiInjuryLike[], now = Date.now()): Promise<number> {
  const kickoff = Date.parse(match.kickoff);
  if (match.status !== "upcoming" || !Number.isFinite(kickoff) || now >= kickoff) return 0;
  let stored = 0;
  for (const side of ["home", "away"] as const) {
    const team = side === "home" ? match.home_team : match.away_team;
    const sheet = buildTeamSheet(side, team.id, team.name, lineups, injuries);
    if (!sheet.startingXi && sheet.missing.length === 0) continue; // nothing published yet
    try {
      const res = await pool.query(
        `INSERT INTO prematch_team_sheets
           (fixture_id, league_id, team_id, side, kickoff_at, formation, starting_xi, bench, missing, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (fixture_id, side, content_hash) DO NOTHING`,
        [match.id, match.league_id ?? null, team.id, side, new Date(kickoff),
          sheet.formation, sheet.startingXi ? JSON.stringify(sheet.startingXi) : null,
          sheet.bench ? JSON.stringify(sheet.bench) : null, JSON.stringify(sheet.missing), sheet.contentHash],
      );
      stored += res.rowCount ?? 0;
    } catch (err) {
      logger.warn({ err, fixtureId: match.id, side }, "prematch team sheet not stored");
    }
  }
  return stored;
}

// ── Availability measures ────────────────────────────────────────────────────

/** One player's appearance for this team in one earlier match. */
export type PlayerAppearance = { fixtureId: number; playerId: number; minutes: number; started: boolean; rating: number | null };

export type Availability = {
  /** Earlier team matches with player data that the measures are based on. */
  historyMatches: number;
  /** Regulars: started at least half of those matches. */
  regulars: number;
  /** Regulars on the provider's injury/suspension list marked as missing the fixture. */
  missingRegulars: number;
  /** Share of the team's recent minutes played by listed-as-missing players (0-1). */
  missingMinutesShare: number;
  /** Average recent rating of missing regulars minus the team's average (null when none). */
  missingRatingGap: number | null;
  /** Share of the starting XI who are regulars (null until the XI is published). */
  xiRegularShare: number | null;
  /** Share of the team's recent minutes played by the named starting XI (null until published). */
  xiMinutesShare: number | null;
};

export const HISTORY_MATCHES = 10;
const MIN_HISTORY = 3;

/**
 * Availability for one side from its sheet and its last few matches. Uses only
 * matches before the one being described, which the caller guarantees.
 */
export function availability(sheet: Pick<TeamSheet, "startingXi" | "missing">, history: PlayerAppearance[]): Availability | null {
  const fixtures = [...new Set(history.map((h) => h.fixtureId))];
  if (fixtures.length < MIN_HISTORY) return null;
  const n = fixtures.length;
  const minutes = new Map<number, number>(), starts = new Map<number, number>(), ratings = new Map<number, number[]>();
  let totalMinutes = 0;
  const allRatings: number[] = [];
  for (const h of history) {
    const m = Math.max(0, h.minutes);
    minutes.set(h.playerId, (minutes.get(h.playerId) ?? 0) + m);
    totalMinutes += m;
    if (h.started) starts.set(h.playerId, (starts.get(h.playerId) ?? 0) + 1);
    if (h.rating != null && Number.isFinite(h.rating) && m > 0) {
      ratings.set(h.playerId, [...(ratings.get(h.playerId) ?? []), h.rating]);
      allRatings.push(h.rating);
    }
  }
  const regulars = new Set([...starts].filter(([, s]) => s >= n / 2).map(([id]) => id));
  const share = (ids: Array<number | null>) => totalMinutes > 0
    ? ids.reduce<number>((s, id) => s + (id != null ? minutes.get(id) ?? 0 : 0), 0) / totalMinutes
    : 0;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

  // "Questionable" players often play; only count those listed as missing the fixture.
  const out = sheet.missing.filter((m) => m.id != null && !/questionable|doubtful/i.test(m.type ?? ""));
  const outIds = [...new Set(out.map((m) => m.id))];
  const missingRegularIds = outIds.filter((id): id is number => id != null && regulars.has(id));
  const missingRegularRatings = missingRegularIds.flatMap((id) => ratings.get(id) ?? []);
  const missingRatingGap = missingRegularRatings.length && allRatings.length
    ? Math.round((mean(missingRegularRatings) - mean(allRatings)) * 1000) / 1000
    : null;

  const xiIds = sheet.startingXi?.map((p) => p.id) ?? null;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    historyMatches: n,
    regulars: regulars.size,
    missingRegulars: missingRegularIds.length,
    missingMinutesShare: round(share(outIds)),
    missingRatingGap,
    xiRegularShare: xiIds ? round(xiIds.filter((id) => id != null && regulars.has(id)).length / xiIds.length) : null,
    xiMinutesShare: xiIds ? round(share(xiIds)) : null,
  };
}

/** A team's player appearances in its last few matches before `before`. */
export async function loadTeamHistory(teamId: number, before: Date, matches = HISTORY_MATCHES): Promise<PlayerAppearance[]> {
  const res = await pool.query(
    `WITH recent AS (
       SELECT fixture_id, MAX(match_date) AS d
         FROM player_match_stats
        WHERE team_id = $1 AND match_date < $2
        GROUP BY fixture_id
        ORDER BY d DESC
        LIMIT $3
     )
     -- player_match_stats does not record the substitute flag, so 45+ minutes
     -- stands in for a start (late-subbed starters and early subs are rare).
     SELECT p.fixture_id, p.player_id, COALESCE(p.minutes_played, 0) AS minutes,
            (COALESCE(p.minutes_played, 0) >= 45) AS started,
            p.rating
       FROM player_match_stats p JOIN recent r USING (fixture_id)
      WHERE p.team_id = $1`,
    [teamId, before, matches],
  );
  return res.rows.map((r: any) => ({
    fixtureId: Number(r.fixture_id), playerId: Number(r.player_id), minutes: Number(r.minutes),
    started: Boolean(r.started), rating: r.rating == null ? null : Number(r.rating),
  }));
}

/** Coverage summary for reports: how many fixtures have a stored pre-kickoff sheet. */
export async function getTeamSheetCoverage() {
  const res = await pool.query(
    `SELECT COUNT(DISTINCT fixture_id)::int AS fixtures,
            COUNT(DISTINCT fixture_id) FILTER (WHERE starting_xi IS NOT NULL)::int AS fixtures_with_xi,
            COUNT(DISTINCT s.fixture_id) FILTER (WHERE EXISTS (SELECT 1 FROM match_outcomes o WHERE o.fixture_id = s.fixture_id))::int AS settled,
            MIN(captured_at) AS first_captured, MAX(captured_at) AS last_captured
       FROM prematch_team_sheets s`,
  );
  return res.rows[0] ?? null;
}
