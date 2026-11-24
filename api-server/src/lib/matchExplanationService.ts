/**
 * Prediction explanations and data checks (analysis plan step 8).
 *
 * Deterministic data flags are always computed. When ANTHROPIC_API_KEY is set,
 * Claude turns the already-computed facts into a short plain-English
 * explanation. Claude never sees the result, never produces a number that is
 * shown as a probability, and its text cannot change any forecast; a
 * template is used whenever the key is missing or the call fails.
 */
import type { Match } from "./soccerService";
import { createCanonicalPrediction, type CanonicalPrediction } from "./canonicalPredictionService";
import { anthropicKey, callClaude } from "./anthropicClient";

const CACHE_MS = 30 * 60_000;
const cache = new Map<number, { value: MatchExplanation; at: number }>();

export type DataFlag = { code: string; severity: "info" | "warning"; message: string };
export type MatchExplanation = {
  fixtureId: number;
  servingModel: string;
  probabilities: { home: number; draw: number; away: number };
  expectedGoals: { home: number | null; away: number | null };
  flags: DataFlag[];
  explanation: string;
  explanationSource: "claude" | "template";
  /** Why Claude was not used, when the key is set but the call failed (never contains the key). */
  explanationError?: string;
  generatedAt: string;
};

function impliedFromOdds(match: Match): { home: number; draw: number; away: number } | null {
  const o = match.odds;
  if (!o?.home_odds || !o?.draw_odds || !o?.away_odds) return null;
  const h = 1 / o.home_odds, d = 1 / o.draw_odds, a = 1 / o.away_odds, t = h + d + a;
  return { home: (h / t) * 100, draw: (d / t) * 100, away: (a / t) * 100 };
}

/** Rule-based checks; no AI involved. */
export function dataFlags(match: Match, p: CanonicalPrediction): DataFlag[] {
  const flags: DataFlag[] = [];
  const minutesToKickoff = (new Date(match.kickoff).getTime() - Date.now()) / 60_000;
  if (p.prediction_source === "offline-fallback") {
    flags.push({ code: "fallback-model", severity: "warning", message: "No current team statistics; this uses league averages only." });
  } else if (p.data_tier === "stats-low") {
    flags.push({ code: "thin-data", severity: "warning", message: "Few matches of evidence for at least one team, so this forecast is uncertain." });
  }
  if (match.status === "upcoming" && minutesToKickoff <= 60 && minutesToKickoff > 0 && !p.lineup?.confirmed) {
    flags.push({ code: "lineup-missing", severity: "warning", message: "Kickoff is within an hour and confirmed lineups are not in yet." });
  }
  const market = impliedFromOdds(match);
  if (market) {
    const gap = Math.max(Math.abs(p.home_win - market.home), Math.abs(p.draw - market.draw), Math.abs(p.away_win - market.away));
    if (gap >= 15) {
      flags.push({ code: "far-from-market", severity: "warning", message: `The model differs from bookmaker odds by up to ${Math.round(gap)} points. Bookmakers have been more accurate on average, so treat this as a disagreement to check, not as value.` });
    }
  }
  if (match.score?.home != null && match.status === "upcoming") {
    flags.push({ code: "score-on-upcoming", severity: "warning", message: "A score is present on a match marked as not started; provider data may be stale." });
  }
  return flags;
}

function templateExplanation(match: Match, p: CanonicalPrediction): string {
  const fav = p.home_win >= p.away_win ? match.home_team.name : match.away_team.name;
  const favPct = Math.max(p.home_win, p.away_win);
  const xg = p.home_xg != null && p.away_xg != null ? ` Expected goals are ${p.home_xg.toFixed(2)} to ${p.away_xg.toFixed(2)}.` : "";
  return `${fav} are favoured at ${favPct.toFixed(0)}%, with a draw at ${p.draw.toFixed(0)}%.${xg} ${(p.reasons ?? []).slice(0, 2).join(" ")}`.trim();
}

/** Trim to whole sentences, so a long or cut-off reply never ends mid-sentence. */
export function wholeSentences(text: string, max: number): string {
  const t = text.length > max ? text.slice(0, max) : text;
  if (/[.!?]["')]?$/.test(t.trim())) return t.trim();
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "), t.lastIndexOf("."));
  return end > 40 ? t.slice(0, end + 1).trim() : t.trim();
}

async function claudeExplanation(match: Match, p: CanonicalPrediction, flags: DataFlag[]): Promise<{ text: string | null; error?: string }> {
  if (!anthropicKey()) return { text: null };
  const facts = {
    match: `${match.home_team.name} vs ${match.away_team.name}`,
    competition: match.league_name,
    probabilitiesPercent: { home: p.home_win, draw: p.draw, away: p.away_win },
    expectedGoals: { home: p.home_xg, away: p.away_xg },
    model: p.serving_model ?? "legacy",
    reasons: (p.reasons ?? []).slice(0, 6),
    dataFlags: flags.map((f) => f.message),
  };
  const prompt = `Explain this football match forecast to a fan in at most three short sentences.
Use ONLY the facts below. Do not add any number, statistic, injury, or claim that is not in the facts.
Do not change or round the probabilities into new values, and do not give betting advice.
Facts (JSON): ${JSON.stringify(facts)}`;
  // Room for any reasoning the model does before writing; the reply itself is three sentences.
  const r = await callClaude(prompt, 2000, "match explanation");
  return r.text ? { text: wholeSentences(r.text.replace(/\s*\n+\s*/g, " "), 900) } : { text: null, ...(r.error ? { error: r.error } : {}) };
}

export async function explainMatch(match: Match): Promise<MatchExplanation> {
  const cached = cache.get(match.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const { prediction: p } = await createCanonicalPrediction(match);
  const flags = dataFlags(match, p);
  const ai = await claudeExplanation(match, p, flags);
  const value: MatchExplanation = {
    fixtureId: match.id,
    servingModel: p.serving_model ?? "legacy",
    probabilities: { home: p.home_win, draw: p.draw, away: p.away_win },
    expectedGoals: { home: p.home_xg ?? null, away: p.away_xg ?? null },
    flags,
    explanation: ai.text ?? templateExplanation(match, p),
    explanationSource: ai.text ? "claude" : "template",
    ...(ai.error ? { explanationError: ai.error } : {}),
    generatedAt: new Date().toISOString(),
  };
  // A failed Claude call is retried after 2 minutes instead of 30.
  cache.set(match.id, { value, at: ai.error ? Date.now() - CACHE_MS + 2 * 60_000 : Date.now() });
  if (cache.size > 2000) cache.delete(cache.keys().next().value as number);
  return value;
}
