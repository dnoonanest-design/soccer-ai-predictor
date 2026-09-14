import type { TeamStats } from "./statsService";

type ThreeWay = { home: number; draw: number; away: number };

export type PredictionDataQuality = {
  score: number;
  dataTier: "stats-high" | "stats-medium" | "stats-low";
  probabilities: ThreeWay;
  confidence: number | null;
  homeEvidence: number;
  awayEvidence: number;
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function sample(value: number | undefined, target: number) {
  return clamp01(Number(value ?? 0) / target);
}

export function teamEvidenceQuality(stats: TeamStats): number {
  const competition = sample(stats.competition_matches_played ?? stats.matches_played, 5);
  const recent = sample(stats.recent_matches_used, 8);
  const venue = sample(stats.venue_matches_used, 4);
  const total = sample(stats.matches_played, 8);
  const strength = sample(stats.strength_sample_size, 6);

  if (stats.data_source === "competition") {
    return clamp01(0.45 + 0.35 * competition + 0.15 * total + 0.05 * strength);
  }
  if (stats.data_source === "recent_all_comp") {
    return clamp01(0.18 + 0.46 * recent + 0.24 * venue + 0.12 * strength);
  }
  return clamp01(0.24 + 0.28 * competition + 0.27 * recent + 0.15 * venue + 0.06 * strength);
}

function normalise(probs: ThreeWay): ThreeWay {
  const home = Math.max(0, Number(probs.home) || 0);
  const draw = Math.max(0, Number(probs.draw) || 0);
  const away = Math.max(0, Number(probs.away) || 0);
  const total = home + draw + away;
  if (total <= 0) return { home: 33.34, draw: 33.33, away: 33.33 };
  const h = Math.round((home / total) * 10_000) / 100;
  const d = Math.round((draw / total) * 10_000) / 100;
  return { home: h, draw: d, away: Math.round(Math.max(0, 100 - h - d) * 100) / 100 };
}

function adjustConfidence(confidence: number | null, quality: number): number | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  const unitScale = confidence <= 1;
  const pct = unitScale ? confidence * 100 : confidence;
  const multiplier = 0.68 + 0.32 * quality;
  const qualityCap = 50 + 45 * quality;
  const adjusted = Math.max(0, Math.min(pct * multiplier, qualityCap));
  const rounded = Math.round(adjusted * 100) / 100;
  return unitScale ? rounded / 100 : rounded;
}

export function applyDataQualityReliability(
  probabilities: ThreeWay,
  home: TeamStats,
  away: TeamStats,
  confidence: number | null = null,
): PredictionDataQuality {
  const homeEvidence = teamEvidenceQuality(home);
  const awayEvidence = teamEvidenceQuality(away);
  // The weaker side matters most: a fixture is only as trustworthy as the
  // evidence available for both teams. Keep some credit for the stronger side.
  const quality = clamp01(Math.min(homeEvidence, awayEvidence) * 0.65 + ((homeEvidence + awayEvidence) / 2) * 0.35);
  const reliability = 0.52 + 0.48 * quality;
  const base = normalise(probabilities);
  const neutral = 100 / 3;
  const adjusted = normalise({
    home: neutral + (base.home - neutral) * reliability,
    draw: neutral + (base.draw - neutral) * reliability,
    away: neutral + (base.away - neutral) * reliability,
  });
  const dataTier = quality >= 0.8 ? "stats-high" : quality >= 0.55 ? "stats-medium" : "stats-low";

  return {
    score: Math.round(quality * 1000) / 1000,
    dataTier,
    probabilities: adjusted,
    confidence: adjustConfidence(confidence, quality),
    homeEvidence: Math.round(homeEvidence * 1000) / 1000,
    awayEvidence: Math.round(awayEvidence * 1000) / 1000,
  };
}
