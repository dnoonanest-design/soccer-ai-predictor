/**
 * Betting analysis for one match, before and during play: who our prediction
 * says will win, draw or lose, with the live percentage, how it has moved since
 * kick-off, and the bookmakers' price beside it.
 *
 * Reads stored numbers only (the sealed pre-match prediction, the per-minute
 * live snapshots the background job writes, stored odds). It never changes a
 * prediction, and it does not say "bet": the comparison with the bookmakers is
 * shown, not turned into a tip (see valueSignals.ts for why the formula's gaps
 * against the market are not treated as value).
 */
import { pool } from "@workspace/db";

export type Three = { home: number; draw: number; away: number };
export type Outcome = "home" | "draw" | "away";
export type TimelinePoint = { minute: number; home: number; draw: number; away: number };

export type BettingAnalysis = {
  fixture_id: number;
  phase: "pre-match" | "live" | "finished";
  minute: number | null;
  score: { home: number | null; away: number | null };
  teams: { home: string; away: string };
  current: Three | null;
  kickoff: Three | null;
  change: Three | null;
  pick: { outcome: Outcome; label: string; percent: number; strength: "strong" | "likely" | "slight" | "too close to call" } | null;
  timeline: TimelinePoint[];
  bookmakers: (Three & { source: string; updated_at: string | null }) | null;
  note: string;
};

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Pure: normalise to percentages summing to 100. */
export function toPercent(p: Three | null | undefined): Three | null {
  if (!p) return null;
  const t = Number(p.home) + Number(p.draw) + Number(p.away);
  if (!(t > 0)) return null;
  const home = round1((100 * p.home) / t), draw = round1((100 * p.draw) / t);
  return { home, draw, away: round1(100 - home - draw) };
}

/** Pure: the most likely outcome and how clear it is. */
export function pickFrom(p: Three, teams: { home: string; away: string }): BettingAnalysis["pick"] {
  const ranked = (["home", "draw", "away"] as const).map((o) => [o, p[o]] as const).sort((a, b) => b[1] - a[1]);
  const [outcome, percent] = ranked[0];
  const gap = percent - ranked[1][1];
  const strength = gap < 5 ? "too close to call" : percent >= 65 ? "strong" : percent >= 50 ? "likely" : "slight";
  const label = outcome === "home" ? `${teams.home} to win` : outcome === "away" ? `${teams.away} to win` : "Draw";
  return { outcome, label, percent: round1(percent), strength };
}

/** Pure: one point per minute (the latest reading in that minute), in minute order. */
export function compressTimeline(rows: Array<{ minute: number | null; home: number; draw: number; away: number }>): TimelinePoint[] {
  const byMinute = new Map<number, TimelinePoint>();
  for (const r of rows) {
    if (r.minute == null || !Number.isFinite(r.minute)) continue;
    const p = toPercent(r);
    if (p) byMinute.set(Number(r.minute), { minute: Number(r.minute), ...p });
  }
  return [...byMinute.values()].sort((a, b) => a.minute - b.minute);
}

const signed = (v: number) => `${v > 0 ? "up" : "down"} ${Math.abs(Math.round(v))} point${Math.abs(Math.round(v)) === 1 ? "" : "s"}`;

/** Pure: the plain-English note for the card and match page. */
export function analysisNote(a: Omit<BettingAnalysis, "note">): string {
  const { pick, current, kickoff, teams } = a;
  const score = a.score.home != null && a.score.away != null ? `${a.score.home}-${a.score.away}` : null;
  if (a.phase === "finished") {
    if (!kickoff) return `Full time${score ? ` ${score}` : ""}.`;
    const k = pickFrom(kickoff, teams)!;
    return `Full time${score ? ` ${score}` : ""}. Before kick-off we had ${k.label.toLowerCase() === "draw" ? "a draw" : k.label} at ${k.percent}%.`;
  }
  if (!pick || !current) return a.phase === "live" ? "Live prediction not available yet." : "Prediction not available yet.";
  const others = (["home", "draw", "away"] as const).filter((o) => o !== pick.outcome)
    .map((o) => `${o === "draw" ? "draw" : o === "home" ? teams.home : teams.away} ${current[o]}%`).join(", ");
  const headline = pick.strength === "too close to call"
    ? `Too close to call: ${pick.label.toLowerCase() === "draw" ? "draw" : pick.label} ${pick.percent}% (${others})`
    : `${pick.label}, ${pick.percent}% (${others})`;
  if (a.phase === "pre-match") {
    const word = pick.strength === "strong" ? " Strong favourite." : pick.strength === "likely" ? " Favourite." : pick.strength === "slight" ? " Slight edge only." : "";
    return `Before kick-off: ${headline}.${word}`;
  }
  const when = `${a.minute != null ? `${a.minute}'` : "Live"}${score ? ` · ${score}` : ""}`;
  const move = kickoff ? current[pick.outcome] - kickoff[pick.outcome] : 0;
  const moved = kickoff && Math.abs(move) >= 1 ? ` — ${signed(move)} since kick-off` : kickoff ? " — about where it was at kick-off" : "";
  return `${when}: ${headline}${moved}.`;
}

/** Pure: assemble the analysis from stored readings. */
export function buildBettingAnalysis(input: {
  fixtureId: number;
  status: string;
  minute: number | null;
  score: { home: number | null; away: number | null };
  teams: { home: string; away: string };
  prematch: Three | null;
  liveRows: Array<{ minute: number | null; home: number; draw: number; away: number }>;
  bookmakers: (Three & { source: string; updated_at: string | null }) | null;
}): BettingAnalysis {
  const phase: BettingAnalysis["phase"] = input.status === "live" ? "live" : input.status === "finished" ? "finished" : "pre-match";
  const kickoff = toPercent(input.prematch);
  const timeline = compressTimeline(input.liveRows);
  const latest = timeline.at(-1) ?? null;
  const current = phase === "live" ? (latest ? { home: latest.home, draw: latest.draw, away: latest.away } : null)
    : phase === "pre-match" ? kickoff
    : null;
  const change = phase === "live" && current && kickoff
    ? { home: round1(current.home - kickoff.home), draw: round1(current.draw - kickoff.draw), away: round1(current.away - kickoff.away) }
    : null;
  const pick = current ? pickFrom(current, input.teams) : null;
  const bookmakers = input.bookmakers ? { ...toPercent(input.bookmakers)!, source: input.bookmakers.source, updated_at: input.bookmakers.updated_at } : null;
  const base = {
    fixture_id: input.fixtureId, phase, minute: phase === "live" ? input.minute : null, score: input.score, teams: input.teams,
    current, kickoff, change, pick,
    timeline: kickoff && timeline.length ? [{ minute: 0, ...kickoff }, ...timeline.filter((t) => t.minute > 0)] : timeline,
    bookmakers: bookmakers && toPercent(bookmakers) ? bookmakers : null,
  };
  return { ...base, note: analysisNote(base) };
}

// ── Stored readings ──────────────────────────────────────────────────────────

/** Per-minute live readings written by the background job. */
export async function loadLiveReadings(fixtureId: number) {
  const res = await pool.query(
    `SELECT minute, home_win_prob, draw_prob, away_win_prob
       FROM prediction_snapshots
      WHERE fixture_id = $1 AND status = 'live' AND minute IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 400`,
    [fixtureId],
  );
  return (res.rows as any[]).map((r) => ({ minute: Number(r.minute), home: Number(r.home_win_prob), draw: Number(r.draw_prob), away: Number(r.away_win_prob) }));
}

/** In-play bookmaker consensus (API-Football), from prices updated in the last 3 minutes. */
export async function loadLiveBookmakers(fixtureId: number) {
  const res = await pool.query(
    `SELECT DISTINCT ON (bookmaker_id) home_odds, draw_odds, away_odds, provider_updated_at
       FROM apif_odds_snapshots
      WHERE fixture_id = $1 AND phase = 'live' AND home_odds > 1 AND draw_odds > 1 AND away_odds > 1
        AND provider_updated_at > NOW() - INTERVAL '3 minutes'
      ORDER BY bookmaker_id, provider_updated_at DESC`,
    [fixtureId],
  );
  const rows = res.rows as any[];
  if (!rows.length) return null;
  const sum = { home: 0, draw: 0, away: 0 };
  let latest = 0;
  for (const r of rows) {
    const q = [1 / Number(r.home_odds), 1 / Number(r.draw_odds), 1 / Number(r.away_odds)];
    const t = q[0] + q[1] + q[2];
    sum.home += q[0] / t; sum.draw += q[1] / t; sum.away += q[2] / t;
    latest = Math.max(latest, new Date(r.provider_updated_at).getTime());
  }
  return { home: sum.home / rows.length, draw: sum.draw / rows.length, away: sum.away / rows.length, source: `${rows.length} bookmaker${rows.length === 1 ? "" : "s"} (live)`, updated_at: new Date(latest).toISOString() };
}
