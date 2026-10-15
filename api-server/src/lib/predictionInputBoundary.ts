import type { Match } from "./soccerService";

/**
 * Data that prediction code is allowed to inspect. Odds stay available on the
 * API Match shape for display and post-prediction market comparisons, but are
 * removed before a fixture crosses into a model or prediction helper.
 */
export type PredictionMatch = Omit<Match, "odds">;

export function toPredictionMatch(match: Match): PredictionMatch {
  const { odds: _displayOnlyOdds, ...predictionInput } = match;
  return predictionInput;
}
