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
import { logger } from "./logger";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
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

async function claudeExplanation(match: Match, p: CanonicalPrediction, flags: DataFlag[]): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
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
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic request failed with status ${response.status}`);
    const data = (await response.json()) as { content?: Array<{ text?: string }> };
    const text = String(data.content?.[0]?.text ?? "").trim();
    return text ? text.slice(0, 800) : null;
  } catch (err) {
    logger.warn({ err, fixtureId: match.id }, "Claude explanation unavailable; using template");
    return null;
  }
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
    explanation: ai ?? templateExplanation(match, p),
    explanationSource: ai ? "claude" : "template",
    generatedAt: new Date().toISOString(),
  };
  cache.set(match.id, { value, at: Date.now() });
  if (cache.size > 2000) cache.delete(cache.keys().next().value as number);
  return value;
}
