import { logger } from "./logger";

/**
 * Core predictor AI data policy.
 *
 * The statistical/learning predictor is intentionally isolated from bookmaker
 * opinions, public prediction sites, tipsters, web searches, and third-party
 * forecast outputs. External services may supply factual football telemetry to
 * the ingestion layer, but the AI learning layer itself must learn only from
 * data already collected by this app and stored in our own data pipeline.
 */
export const CORE_AI_DATA_POLICY = Object.freeze({
  version: "internal-data-only-v1",
  mode: "internal_data_only",
  factualIngestionAllowed: [
    "api-football fixtures/results/events/statistics/lineups/injuries/player data",
    "app-generated prediction snapshots",
    "settled match outcomes",
    "app-generated circumstances/deep stats",
    "app-generated accuracy audits/calibration evidence",
  ],
  prohibitedCoreAiInputs: [
    "bookmaker odds or implied probabilities",
    "bookmaker/market consensus",
    "odds movement",
    "public prediction websites",
    "tipsters or betting picks",
    "external AI/LLM match predictions",
    "web search results containing match predictions",
  ],
  bookmakerDataRole: "market-intelligence-only",
  corePredictorMayReadMarketIntelligence: false,
  coreAiMayPerformNetworkRequests: false,
  requireInternalProvenanceForLearningMemory: true,
});

type LearningPayload = {
  source: string;
  learningType?: string;
  subject?: string | null;
  summary?: string | null;
  evidence?: unknown;
  learnedWeights?: unknown;
};

const ALLOWED_INTERNAL_SOURCE_PREFIXES = [
  "audit:",
  "self_improvement_queue",
  "self_improvement_queue:",
  "explanation:",
  "adaptive:",
  "internal:",
] as const;

const FORBIDDEN_FEATURE_KEY_PARTS = [
  "market_prob",
  "market_probability",
  "market_odds",
  "bookmaker",
  "bookie",
  "odds",
  "tipster",
  "external_prediction",
  "online_prediction",
  "consensus_prediction",
  "third_party_prediction",
] as const;

const FORBIDDEN_TEXT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "bookmaker data", regex: /\bbookmaker(?:s)?\b/i },
  { label: "bookie data", regex: /\bbookie(?:s)?\b/i },
  { label: "betting odds", regex: /\bodds\b/i },
  { label: "odds movement", regex: /\bodds\s+movement\b/i },
  { label: "market consensus", regex: /\bmarket\s+consensus\b/i },
  { label: "external prediction", regex: /\bexternal\s+(?:ai\s+)?prediction(?:s)?\b/i },
  { label: "online prediction", regex: /\bonline\s+prediction(?:s)?\b/i },
  { label: "tipster", regex: /\btipster(?:s)?\b/i },
  { label: "Forebet", regex: /\bforebet\b/i },
  { label: "PredictZ", regex: /\bpredictz\b/i },
  { label: "BettingExpert", regex: /\bbettingexpert\b/i },
  { label: "Sports Mole prediction", regex: /\bsports\s*mole\b/i },
];

function isAllowedInternalSource(source: string): boolean {
  const normalized = String(source ?? "").trim().toLowerCase();
  return ALLOWED_INTERNAL_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function findForbiddenFeatureKey(value: unknown, path = "root", depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenFeatureKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    const blocked = FORBIDDEN_FEATURE_KEY_PARTS.find((part) => normalizedKey.includes(part));
    if (blocked) return `${path}.${key}`;
    const hit = findForbiddenFeatureKey(nested, `${path}.${key}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function findForbiddenText(value: unknown, path = "root", depth = 0): { path: string; label: string } | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    const hit = FORBIDDEN_TEXT_PATTERNS.find(({ regex }) => regex.test(value));
    return hit ? { path, label: hit.label } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenText(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const hit = findForbiddenText(nested, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function assertCoreAiFeatureVector(features: Record<string, unknown>, context = "feature_vector"): void {
  const forbiddenKey = findForbiddenFeatureKey(features, context);
  if (!forbiddenKey) return;
  const err = new Error(`Core AI data provenance violation: forbidden market/external feature at ${forbiddenKey}`);
  logger.error({ forbiddenKey, context, policyVersion: CORE_AI_DATA_POLICY.version }, "core AI provenance firewall blocked feature vector");
  throw err;
}

export function assertCoreAiLearningPayload(payload: LearningPayload): void {
  if (!isAllowedInternalSource(payload.source)) {
    const err = new Error(`Core AI data provenance violation: learning source '${payload.source}' is not an approved internal source`);
    logger.error({ source: payload.source, learningType: payload.learningType, policyVersion: CORE_AI_DATA_POLICY.version }, "core AI provenance firewall blocked learning source");
    throw err;
  }

  const forbiddenKey = findForbiddenFeatureKey({ evidence: payload.evidence, learnedWeights: payload.learnedWeights });
  if (forbiddenKey) {
    const err = new Error(`Core AI data provenance violation: forbidden market/external evidence at ${forbiddenKey}`);
    logger.error({ source: payload.source, forbiddenKey, policyVersion: CORE_AI_DATA_POLICY.version }, "core AI provenance firewall blocked learning evidence");
    throw err;
  }

  const forbiddenText = findForbiddenText({ subject: payload.subject, summary: payload.summary, evidence: payload.evidence });
  if (forbiddenText) {
    const err = new Error(`Core AI data provenance violation: ${forbiddenText.label} detected at ${forbiddenText.path}`);
    logger.error({ source: payload.source, ...forbiddenText, policyVersion: CORE_AI_DATA_POLICY.version }, "core AI provenance firewall blocked external prediction content");
    throw err;
  }
}

export function getCoreAiDataPolicyReport() {
  return {
    ...CORE_AI_DATA_POLICY,
    allowedLearningSourcePrefixes: [...ALLOWED_INTERNAL_SOURCE_PREFIXES],
    enforcement: {
      runtimeLearningMemoryFirewall: true,
      runtimeFeatureFirewall: true,
      buildTimeNetworkIsolationCheck: true,
    },
  };
}
