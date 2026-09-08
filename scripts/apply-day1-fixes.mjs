import fs from "node:fs";

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`Patch anchor not found: ${label}`);
  const first = text.indexOf(from);
  if (text.indexOf(from, first + from.length) !== -1) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return text.replace(from, to);
}

function patchFile(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  for (const [from, to, label] of replacements) {
    text = replaceOnce(text, from, to, `${path}: ${label}`);
  }
  fs.writeFileSync(path, text);
  console.log(`patched ${path}`);
}

patchFile("api-server/src/lib/statsService.ts", [
  [
    'import { waitForRateLimit } from "./rateLimiter";\n',
    'import { waitForRateLimit } from "./rateLimiter";\nimport { getDomesticLeagueStrength } from "./leagueConfig";\n',
    "league strength import",
  ],
  [
    '  venue_matches_used?: number;\n}',
    '  venue_matches_used?: number;\n  domestic_strength_index?: number | null;\n  data_quality_score?: number;\n}',
    "TeamStats quality fields",
  ],
  [
    '    venue_matches_used: 0,\n  };',
    '    venue_matches_used: 0,\n    domestic_strength_index: null,\n    data_quality_score: 40,\n  };',
    "empty stats quality defaults",
  ],
  [
    '  let weightedGoalsFor = 0, weightedGoalsAgainst = 0, totalWeight = 0;\n  const outcomes: string[] = [];',
    '  let weightedGoalsFor = 0, weightedGoalsAgainst = 0, totalWeight = 0;\n  let weightedDomesticStrength = 0, domesticStrengthWeight = 0;\n  const outcomes: string[] = [];',
    "domestic strength accumulators",
  ],
  [
    '    weightedGoalsFor += goalsFor * weight;\n    weightedGoalsAgainst += goalsAgainst * weight;\n    totalWeight += weight;',
    '    weightedGoalsFor += goalsFor * weight;\n    weightedGoalsAgainst += goalsAgainst * weight;\n    totalWeight += weight;\n\n    const leagueStrength = getDomesticLeagueStrength(Number(fixture.league?.id ?? 0));\n    if (leagueStrength != null) {\n      weightedDomesticStrength += leagueStrength * recencyWeight;\n      domesticStrengthWeight += recencyWeight;\n    }',
    "recent fixture strength accumulation",
  ],
  [
    '    data_source: "recent_all_comp",\n    competition_matches_played: 0,\n    recent_matches_used: fixtures.length,\n    venue_matches_used: venueMatches,\n  };',
    '    data_source: "recent_all_comp",\n    competition_matches_played: 0,\n    recent_matches_used: fixtures.length,\n    venue_matches_used: venueMatches,\n    domestic_strength_index: domesticStrengthWeight > 0\n      ? Math.round((weightedDomesticStrength / domesticStrengthWeight) * 1000) / 1000\n      : null,\n    data_quality_score: Math.min(78, Math.round((60 + Math.min(4, fixtures.length * 0.35) + Math.min(4, venueMatches * 0.8)) * 100) / 100),\n  };',
    "recent stats quality metadata",
  ],
  [
    '      competition_matches_played: competition.matches_played,\n      recent_matches_used: recent?.matches_played ?? 0,\n      venue_matches_used: recent?.venue_matches_used ?? 0,\n    };',
    '      competition_matches_played: competition.matches_played,\n      recent_matches_used: recent?.matches_played ?? 0,\n      venue_matches_used: recent?.venue_matches_used ?? 0,\n      domestic_strength_index: recent?.domestic_strength_index ?? null,\n      data_quality_score: Math.min(100, Math.round((88 + Math.min(6, competition.matches_played * 1.2) + Math.min(4, (recent?.venue_matches_used ?? 0) * 0.8)) * 100) / 100),\n    };',
    "competition stats quality metadata",
  ],
  [
    '    competition_matches_played: competition.matches_played,\n    recent_matches_used: recent.matches_played,\n    venue_matches_used: recent.venue_matches_used ?? 0,\n  };',
    '    competition_matches_played: competition.matches_played,\n    recent_matches_used: recent.matches_played,\n    venue_matches_used: recent.venue_matches_used ?? 0,\n    domestic_strength_index: recent.domestic_strength_index ?? null,\n    data_quality_score: Math.min(91, Math.round((75 + Math.min(6, competition.matches_played * 1.2) + Math.min(4, recent.matches_played * 0.35) + Math.min(4, (recent.venue_matches_used ?? 0) * 0.8)) * 100) / 100),\n  };',
    "blended stats quality metadata",
  ],
]);

patchFile("api-server/src/lib/enhancedStatsService.ts", [
  [
    'import { waitForRateLimit } from "./rateLimiter";\n',
    'import { waitForRateLimit } from "./rateLimiter";\nimport {\n  assessPredictionReliability,\n  capHomeAdvantage,\n  guardThreeWayProbabilities,\n  type PredictionReliabilityContext,\n} from "./predictionReliabilityService";\n',
    "reliability imports",
  ],
  [
    '  home_advantage: number;\n  live_score_home?: number;',
    '  home_advantage: number;\n  reliability_score: number;\n  reliability_label: "very-low" | "low" | "medium" | "high";\n  prediction_mode: "standard" | "cup" | "cross-league";\n  probability_shrink: number;\n  home_strength_factor: number;\n  away_strength_factor: number;\n  live_score_home?: number;',
    "EnhancedPrediction reliability fields",
  ],
  [
    '  homeForm = "", awayForm = "", liveStats?: LiveMatchStatsInput\n): Promise<EnhancedPrediction> {\n  const homeAdv = getHomeAdvantage(leagueId);\n  const homeFormFactor = formFactor(homeForm);\n  const awayFormFactor = formFactor(awayForm);\n  const baseHomeXG = ((homeGpg + awayCpg) / 2) * homeAdv;\n  const baseAwayXG = (awayGpg + homeCpg) / 2;\n  const base = poissonProbs(baseHomeXG, baseAwayXG);',
    '  homeForm = "", awayForm = "", liveStats?: LiveMatchStatsInput,\n  reliabilityContext?: Omit<PredictionReliabilityContext, "leagueId" | "lineupConfirmed" | "isLive">\n): Promise<EnhancedPrediction> {\n  const homeAdv = capHomeAdvantage(getHomeAdvantage(leagueId), leagueId);\n  const earlyReliability = assessPredictionReliability({\n    leagueId,\n    ...reliabilityContext,\n    lineupConfirmed: false,\n    isLive,\n  });\n  const homeFormFactor = formFactor(homeForm);\n  const awayFormFactor = formFactor(awayForm);\n  const baseHomeXG = ((homeGpg + awayCpg) / 2) * homeAdv * earlyReliability.homeStrengthFactor;\n  const baseAwayXG = ((awayGpg + homeCpg) / 2) * earlyReliability.awayStrengthFactor;\n  const base = poissonProbs(baseHomeXG, baseAwayXG);',
    "prediction context and cross-league adjustment",
  ],
  [
    '  if (h2hResult && h2hResult.matches > 0) {\n    const blended = blendH2H(finalHome, finalDraw, finalAway, h2hResult);\n    finalHome = blended.home; finalDraw = blended.draw; finalAway = blended.away;\n  }\n  const markets = extendedPoissonMarkets(adjHomeXG, adjAwayXG);\n  const confidence = confidenceFromModel(finalHome, finalDraw, finalAway, (lineupResult ? 3 : 0) + homeInjuries.length + awayInjuries.length + (h2hResult?.matches ?? 0));\n  const reasons = buildReasons({ homeFormFactor, awayFormFactor, homeInjuryFactor, awayInjuryFactor, homeLineupFactor, awayLineupFactor, homeXG: adjHomeXG, awayXG: adjAwayXG, h2h: h2hResult, homeName: homeTeamName, awayName: awayTeamName });',
    '  if (h2hResult && h2hResult.matches > 0) {\n    const blended = blendH2H(finalHome, finalDraw, finalAway, h2hResult);\n    finalHome = blended.home; finalDraw = blended.draw; finalAway = blended.away;\n  }\n  const reliability = assessPredictionReliability({\n    leagueId,\n    ...reliabilityContext,\n    lineupConfirmed: Boolean(lineupResult?.confirmed),\n    isLive,\n  });\n  const guarded = guardThreeWayProbabilities(finalHome, finalDraw, finalAway, reliability);\n  finalHome = guarded.home; finalDraw = guarded.draw; finalAway = guarded.away;\n  const markets = extendedPoissonMarkets(adjHomeXG, adjAwayXG);\n  const modelConfidence = confidenceFromModel(finalHome, finalDraw, finalAway, (lineupResult ? 3 : 0) + homeInjuries.length + awayInjuries.length + (h2hResult?.matches ?? 0));\n  const adjustedConfidenceScore = round2(modelConfidence.score * (0.55 + 0.45 * reliability.score / 100));\n  const confidence = {\n    label: (adjustedConfidenceScore >= 72 ? "High" : adjustedConfidenceScore >= 55 ? "Medium" : "Low") as "Low" | "Medium" | "High",\n    score: adjustedConfidenceScore,\n  };\n  const reasons = [\n    ...buildReasons({ homeFormFactor, awayFormFactor, homeInjuryFactor, awayInjuryFactor, homeLineupFactor, awayLineupFactor, homeXG: adjHomeXG, awayXG: adjAwayXG, h2h: h2hResult, homeName: homeTeamName, awayName: awayTeamName }),\n    ...reliability.reasons,\n  ].slice(0, 7);',
    "reliability probability guard",
  ],
  [
    '    home_form_factor: round2(homeFormFactor), away_form_factor: round2(awayFormFactor), home_advantage: round2(homeAdv),\n    live_score_home: liveScoreHome ?? undefined, live_score_away: liveScoreAway ?? undefined,',
    '    home_form_factor: round2(homeFormFactor), away_form_factor: round2(awayFormFactor), home_advantage: round2(homeAdv),\n    reliability_score: reliability.score, reliability_label: reliability.label, prediction_mode: reliability.mode,\n    probability_shrink: reliability.probabilityShrink, home_strength_factor: reliability.homeStrengthFactor, away_strength_factor: reliability.awayStrengthFactor,\n    live_score_home: liveScoreHome ?? undefined, live_score_away: liveScoreAway ?? undefined,',
    "reliability return fields",
  ],
]);

patchFile("api-server/src/lib/backgroundLearnerService.ts", [
  [
    'import { isTrackedLeague } from "./leagueConfig";\n',
    'import { isTrackedLeague } from "./leagueConfig";\nimport { guardThreeWayProbabilities } from "./predictionReliabilityService";\n',
    "background reliability import",
  ],
  [
    'const MIN_AUTO_CALIBRATION_SAMPLE = Math.max(25, Number(process.env.MIN_AUTO_CALIBRATION_SAMPLE ?? 60));',
    'const MIN_AUTO_CALIBRATION_SAMPLE = Math.max(100, Number(process.env.MIN_AUTO_CALIBRATION_SAMPLE ?? 250));',
    "minimum auto calibration sample",
  ],
  [
    '    stats.home.form,\n    stats.away.form,\n    liveStatsPayload(stats),\n  );',
    '    stats.home.form,\n    stats.away.form,\n    liveStatsPayload(stats),\n    { homeStats: stats.home, awayStats: stats.away },\n  );',
    "background prediction context",
  ],
  [
    '  const adjusted = await applyCircumstanceCalibration(match, normalized);\n  const valueEdges = buildValueEdges(match, adjusted.home, adjusted.draw, adjusted.away);',
    '  const circumstanceAdjusted = await applyCircumstanceCalibration(match, normalized);\n  const guardedAdjusted = guardThreeWayProbabilities(\n    circumstanceAdjusted.home, circumstanceAdjusted.draw, circumstanceAdjusted.away,\n    raw.probability_shrink ?? 0.99,\n  );\n  const adjusted = { ...circumstanceAdjusted, ...guardedAdjusted };\n  const valueEdges = buildValueEdges(match, adjusted.home, adjusted.draw, adjusted.away);',
    "post-circumstance reliability guard",
  ],
]);

patchFile("api-server/src/lib/predictionAccuracyAuditService.ts", [
  [
    'import { getTrackedCompetition, isTrackedLeague } from "./leagueConfig";\n',
    'import { getTrackedCompetition, isTrackedLeague } from "./leagueConfig";\nimport { guardThreeWayProbabilities } from "./predictionReliabilityService";\n',
    "audit reliability import",
  ],
  [
    '    stats.home.form,\n    stats.away.form,\n    liveStatsPayload(stats),\n  );',
    '    stats.home.form,\n    stats.away.form,\n    liveStatsPayload(stats),\n    { homeStats: stats.home, awayStats: stats.away },\n  );',
    "audit prediction context",
  ],
  [
    '    adjusted = await applyCircumstanceCalibration(match, normalized);\n  }\n\n  return {',
    '    adjusted = await applyCircumstanceCalibration(match, normalized);\n  }\n\n  const reliabilityGuard = guardThreeWayProbabilities(\n    adjusted.home, adjusted.draw, adjusted.away, raw.probability_shrink ?? 0.99,\n  );\n  adjusted = { ...adjusted, ...reliabilityGuard };\n\n  const averageDataQuality = Math.round((\n    (Number(stats.home.data_quality_score ?? 50) + Number(stats.away.data_quality_score ?? 50)) / 2\n  ) * 100) / 100;\n\n  return {',
    "audit final reliability guard",
  ],
  [
    '    dataTier: includeCircumstances ? "stats+circumstances" : "stats",',
    '    dataTier: [\n      includeCircumstances ? "stats+circumstances" : "stats",\n      `home_source=${stats.home.data_source ?? "unknown"}`,\n      `away_source=${stats.away.data_source ?? "unknown"}`,\n      `quality=${averageDataQuality}`,\n      `reliability=${raw.reliability_label ?? "unknown"}`,\n      `mode=${raw.prediction_mode ?? "standard"}`,\n    ].join(";"),',
    "audit data tier metadata",
  ],
]);

patchFile("api-server/src/lib/futurePredictionBaselineService.ts", [
  [
    '    stats.home.form,\n    stats.away.form,\n    { home: stats.home, away: stats.away },\n  );',
    '    stats.home.form,\n    stats.away.form,\n    { home: stats.home, away: stats.away },\n    { homeStats: stats.home, awayStats: stats.away },\n  );',
    "future baseline reliability context",
  ],
]);

patchFile("api-server/src/lib/soccerService.ts", [
  [
    'function normaliseStatus(short: string): string {\n  if (["1H", "2H", "ET", "BT", "P", "LIVE", "HT"].includes(short)) {\n    return "live";\n  }\n  if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) {\n    return "finished";\n  }\n  return "upcoming";\n}',
    'function normaliseStatus(short: string): string {\n  if (["1H", "2H", "ET", "BT", "P", "LIVE", "HT"].includes(short)) return "live";\n  if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) return "finished";\n  if (short === "PST") return "postponed";\n  if (short === "CANC") return "cancelled";\n  if (short === "ABD") return "abandoned";\n  if (["SUSP", "INT"].includes(short)) return "suspended";\n  return "upcoming";\n}',
    "explicit non-played statuses",
  ],
  [
    'function normalizeName(value: string) {\n  return value.toLowerCase().replace(/[^a-z0-9]/g, "").trim();\n}',
    'const TEAM_NAME_ALIASES = new Map<string, string>([\n  ["intermilano", "intermilan"], ["internazionalemilano", "intermilan"],\n  ["realbetisseville", "realbetis"], ["realbetisbalompie", "realbetis"],\n  ["lasklinz", "lask"], ["clubbruggekv", "clubbrugge"],\n  ["sportinglisbon", "sportingcp"],\n]);\n\nfunction normalizeName(value: string) {\n  const compact = value\n    .normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")\n    .toLowerCase()\n    .replace(/\\b(football club|futbol club|club de futbol|fc|afc|cf|sc|ac|ssc|fk|sk|sv|osc|kv)\\b/g, " ")\n    .replace(/[^a-z0-9]/g, "")\n    .trim();\n  return TEAM_NAME_ALIASES.get(compact) ?? compact;\n}',
    "canonical team names",
  ],
  [
    '            normaliseStatus(fixture.fixture.status.short) !== "finished",',
    '            ["upcoming", "live"].includes(normaliseStatus(fixture.fixture.status.short)),',
    "odds only for active statuses",
  ],
  [
    '  const hasActiveMatches = combinedFixtures.some(\n    (fixture) => normaliseStatus(fixture.fixture.status.short) !== "finished",\n  );',
    '  const hasActiveMatches = combinedFixtures.some(\n    (fixture) => ["upcoming", "live"].includes(normaliseStatus(fixture.fixture.status.short)),\n  );',
    "active match detection",
  ],
]);

patchFile("api-server/src/lib/marketIntelligenceService.ts", [
  [
    '  const candidates: Array<typeof marketOddsSnapshots.$inferInsert> = [];\n  const capturedFixtures = new Set<number>();',
    '  const candidates: Array<typeof marketOddsSnapshots.$inferInsert> = [];\n  const capturedFixtures = new Set<number>();\n  const unmatchedFixtures: Array<{ fixtureId: number; home: string; away: string }> = [];',
    "market unmatched diagnostics",
  ],
  [
    '    const event = findOddsEvent(match.home_team.name, match.away_team.name, oddsEvents);\n    if (!event) continue;',
    '    const event = findOddsEvent(match.home_team.name, match.away_team.name, oddsEvents);\n    if (!event) {\n      unmatchedFixtures.push({ fixtureId: match.id, home: match.home_team.name, away: match.away_team.name });\n      continue;\n    }',
    "record unmatched market fixtures",
  ],
  [
    '  if (!candidates.length) {\n    return { enabled: true, observations: 0, fixtures: 0 };\n  }',
    '  const attemptedFixtures = matches.filter((match) => match.status === "upcoming").length;\n  const mappingRatePct = attemptedFixtures\n    ? Math.round((capturedFixtures.size / attemptedFixtures) * 10_000) / 100\n    : 100;\n  if (attemptedFixtures >= 3 && mappingRatePct < 60) {\n    logger.warn(\n      { attemptedFixtures, matchedFixtures: capturedFixtures.size, mappingRatePct, unmatchedSample: unmatchedFixtures.slice(0, 8) },\n      "market intelligence odds fixture mapping coverage low",\n    );\n  }\n\n  if (!candidates.length) {\n    return { enabled: true, observations: 0, fixtures: 0, attemptedFixtures, mappingRatePct, unmatchedFixtures: unmatchedFixtures.length };\n  }',
    "market mapping rate diagnostics",
  ],
  [
    '      captureBucket,\n    };',
    '      captureBucket,\n      attemptedFixtures,\n      mappingRatePct,\n      unmatchedFixtures: unmatchedFixtures.length,\n    };',
    "successful market diagnostics",
  ],
  [
    'function normalizeName(value: string) {\n  return value.toLowerCase().replace(/[^a-z0-9]/g, "").trim();\n}',
    'const TEAM_NAME_ALIASES = new Map<string, string>([\n  ["intermilano", "intermilan"], ["internazionalemilano", "intermilan"],\n  ["realbetisseville", "realbetis"], ["realbetisbalompie", "realbetis"],\n  ["lasklinz", "lask"], ["clubbruggekv", "clubbrugge"],\n  ["sportinglisbon", "sportingcp"],\n]);\n\nfunction normalizeName(value: string) {\n  const compact = value\n    .normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")\n    .toLowerCase()\n    .replace(/\\b(football club|futbol club|club de futbol|fc|afc|cf|sc|ac|ssc|fk|sk|sv|osc|kv)\\b/g, " ")\n    .replace(/[^a-z0-9]/g, "")\n    .trim();\n  return TEAM_NAME_ALIASES.get(compact) ?? compact;\n}',
    "market canonical team names",
  ],
]);

patchFile("api-server/src/lib/futureMarketSamplerService.ts", [
  [
    '    "WO",\n  ].includes(status ?? "");',
    '    "WO",\n    "PST",\n    "CANC",\n    "ABD",\n    "SUSP",\n    "INT",\n  ].includes(status ?? "");',
    "future status exclusions",
  ],
]);

const testPath = "api-server/src/lib/__tests__/predictionReliabilityService.test.ts";
fs.writeFileSync(testPath, `import { describe, expect, it } from "vitest";\nimport {\n  assessPredictionReliability,\n  capHomeAdvantage,\n  guardThreeWayProbabilities,\n} from "../predictionReliabilityService";\n\ndescribe("prediction reliability guard", () => {\n  it("reduces confidence when competition history is fallback data", () => {\n    const result = assessPredictionReliability({\n      leagueId: 48,\n      homeStats: { data_source: "recent_all_comp", recent_matches_used: 12, venue_matches_used: 5, data_quality_score: 68 },\n      awayStats: { data_source: "blended", competition_matches_played: 2, recent_matches_used: 12, venue_matches_used: 6, data_quality_score: 80 },\n      lineupConfirmed: false,\n      isLive: false,\n    });\n    expect(result.mode).toBe("cup");\n    expect(result.score).toBeLessThan(70);\n    expect(result.probabilityShrink).toBeLessThan(0.9);\n  });\n\n  it("normalises cross-league strength without overpowering the model", () => {\n    const result = assessPredictionReliability({\n      leagueId: 2,\n      homeStats: { data_source: "blended", domestic_strength_index: 1.12, data_quality_score: 82 },\n      awayStats: { data_source: "blended", domestic_strength_index: 1.0, data_quality_score: 82 },\n      lineupConfirmed: true,\n    });\n    expect(result.mode).toBe("cross-league");\n    expect(result.homeStrengthFactor).toBeGreaterThan(1);\n    expect(result.homeStrengthFactor).toBeLessThanOrEqual(1.1);\n  });\n\n  it("shrinks weak evidence toward a neutral three-way distribution", () => {\n    const guarded = guardThreeWayProbabilities(60, 22, 18, 0.7);\n    expect(guarded.home).toBeLessThan(60);\n    expect(guarded.draw).toBeGreaterThan(22);\n    expect(guarded.home + guarded.draw + guarded.away).toBeCloseTo(100, 1);\n  });\n\n  it("caps cup and UEFA home advantage", () => {\n    expect(capHomeAdvantage(1.08, 48)).toBe(1.04);\n    expect(capHomeAdvantage(1.08, 2)).toBe(1.035);\n    expect(capHomeAdvantage(1.08, 39)).toBe(1.08);\n  });\n});\n`);
console.log(`wrote ${testPath}`);
