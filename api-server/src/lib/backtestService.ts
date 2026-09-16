import { logger } from "./logger";
import { pool } from "@workspace/db";
import { canonicalPrematchAuditCte } from "./canonicalPrematchAudit";
import { verifyPredictionAuditIntegrity } from "./predictionAccuracyAuditService";

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

// Top European leagues by API-Football ID
const DEFAULT_LEAGUES = [
  { id: 39, name: "Premier League", country: "England" },
  { id: 140, name: "La Liga", country: "Spain" },
  { id: 135, name: "Serie A", country: "Italy" },
  { id: 78, name: "Bundesliga", country: "Germany" },
  { id: 61, name: "Ligue 1", country: "France" },
  { id: 2, name: "Champions League", country: "Europe" },
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache — expensive call
let backtestCache: { data: BacktestResult; fetchedAt: number } | null = null;

export interface BacktestScenario {
  halftime_score: string;
  home_goals_ht: number;
  away_goals_ht: number;
  match_count: number;
  home_win_count: number;
  draw_count: number;
  away_win_count: number;
  home_win_pct: number;
  draw_pct: number;
  away_win_pct: number;
  lead_held: boolean | null;
}

export interface BacktestSummary {
  most_common_ht_score: string;
  comeback_rate: number;
  draw_ht_home_win_pct: number;
  draw_ht_draw_pct: number;
  draw_ht_away_win_pct: number;
  home_leading_ht_win_pct: number;
  away_leading_ht_win_pct: number;
}

export interface BacktestResult {
  total_matches: number;
  season: number;
  leagues: Array<{ id: number; name: string; country: string }>;
  scenarios: BacktestScenario[];
  summary: BacktestSummary;
  generated_at: string;
}

type Outcome = "home" | "draw" | "away";

export interface WalkForwardRow {
  fixtureId: number;
  leagueId: number | null;
  kickoffAt: string;
  home: number;
  draw: number;
  away: number;
  actual: Outcome;
  modelVersion: string;
}

export interface EvaluationMetrics {
  samples: number;
  accuracy: number | null;
  brierScore: number | null;
  logLoss: number | null;
}

export interface WalkForwardFold {
  fold: number;
  trainingSamples: number;
  holdoutSamples: number;
  holdoutStart: string;
  holdoutEnd: string;
  modelVersions: string[];
  model: EvaluationMetrics;
  expandingPriorBaseline: EvaluationMetrics;
}

export interface ModelBacktestResult {
  status: "complete" | "collecting";
  methodology: string;
  generatedAt: string;
  integrityVerifiedRows: number;
  minimumTrainingSamples: number;
  foldSize: number;
  evaluatedSamples: number;
  model: EvaluationMetrics;
  expandingPriorBaseline: EvaluationMetrics;
  brierImprovement: number | null;
  folds: WalkForwardFold[];
  safeguards: {
    onePredictionPerFixture: true;
    latestPreKickoffOnly: true;
    chronologicalSplits: true;
    futureOutcomesExcludedFromBaseline: true;
    bookmakerOddsUsedByCoreModel: false;
  };
}

type ApiFixture = {
  fixture: { id: number; status: { short: string } };
  goals: { home: number | null; away: number | null };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
  };
};

async function fetchFixtures(leagueId: number, season: number): Promise<ApiFixture[]> {
  if (!API_FOOTBALL_KEY) return [];
  const url = `${API_FOOTBALL_BASE}/fixtures?league=${leagueId}&season=${season}&status=FT`;
  try {
    const res = await fetch(url, {
      headers: { "x-apisports-key": API_FOOTBALL_KEY },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, leagueId, season }, "API-Football fixture fetch failed");
      return [];
    }
    const json = (await res.json()) as { response: ApiFixture[] };
    return Array.isArray(json.response) ? json.response : [];
  } catch (err) {
    logger.error({ err, leagueId, season }, "Error fetching fixtures");
    return [];
  }
}

function pct(n: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}

function unit(value: number) {
  return Math.max(0.001, Math.min(0.999, value > 1 ? value / 100 : value));
}

function probabilities(row: Pick<WalkForwardRow, "home" | "draw" | "away">) {
  const raw = { home: unit(row.home), draw: unit(row.draw), away: unit(row.away) };
  const total = raw.home + raw.draw + raw.away;
  return { home: raw.home / total, draw: raw.draw / total, away: raw.away / total };
}

function scoreRows(
  rows: WalkForwardRow[],
  predictor: (row: WalkForwardRow) => { home: number; draw: number; away: number },
): EvaluationMetrics {
  if (!rows.length) return { samples: 0, accuracy: null, brierScore: null, logLoss: null };
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  for (const row of rows) {
    const probs = probabilities(predictor(row));
    const pick = probs.home >= probs.draw && probs.home >= probs.away
      ? "home"
      : probs.away >= probs.home && probs.away >= probs.draw ? "away" : "draw";
    if (pick === row.actual) correct += 1;
    brier += (probs.home - (row.actual === "home" ? 1 : 0)) ** 2
      + (probs.draw - (row.actual === "draw" ? 1 : 0)) ** 2
      + (probs.away - (row.actual === "away" ? 1 : 0)) ** 2;
    logLoss += -Math.log(Math.max(0.001, probs[row.actual]));
  }
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return {
    samples: rows.length,
    accuracy: round(correct / rows.length),
    brierScore: round(brier / rows.length),
    logLoss: round(logLoss / rows.length),
  };
}

function outcomePrior(rows: WalkForwardRow[]) {
  const counts = { home: 1, draw: 1, away: 1 };
  for (const row of rows) counts[row.actual] += 1;
  const total = counts.home + counts.draw + counts.away;
  return { home: counts.home / total, draw: counts.draw / total, away: counts.away / total };
}

export function evaluateWalkForwardRows(
  input: WalkForwardRow[],
  minimumTrainingSamples = 250,
  foldSize = 50,
): Omit<ModelBacktestResult, "generatedAt" | "integrityVerifiedRows"> {
  const rows = [...input].sort((a, b) =>
    a.kickoffAt.localeCompare(b.kickoffAt) || a.fixtureId - b.fixtureId,
  );
  const safeMinimum = Number.isFinite(minimumTrainingSamples)
    ? Math.max(10, Math.floor(minimumTrainingSamples)) : 250;
  const safeFoldSize = Number.isFinite(foldSize)
    ? Math.max(10, Math.floor(foldSize)) : 50;
  const folds: WalkForwardFold[] = [];
  const evaluated: WalkForwardRow[] = [];
  let weightedBaselineBrier = 0;
  let weightedBaselineLogLoss = 0;
  let weightedBaselineAccuracy = 0;

  for (let start = safeMinimum; start < rows.length; start += safeFoldSize) {
    const training = rows.slice(0, start);
    const holdout = rows.slice(start, start + safeFoldSize);
    const prior = outcomePrior(training);
    const model = scoreRows(holdout, probabilities);
    const baseline = scoreRows(holdout, () => prior);
    evaluated.push(...holdout);
    weightedBaselineBrier += (baseline.brierScore ?? 0) * holdout.length;
    weightedBaselineLogLoss += (baseline.logLoss ?? 0) * holdout.length;
    weightedBaselineAccuracy += (baseline.accuracy ?? 0) * holdout.length;
    folds.push({
      fold: folds.length + 1,
      trainingSamples: training.length,
      holdoutSamples: holdout.length,
      holdoutStart: holdout[0].kickoffAt,
      holdoutEnd: holdout[holdout.length - 1].kickoffAt,
      modelVersions: [...new Set(holdout.map((row) => row.modelVersion))],
      model,
      expandingPriorBaseline: baseline,
    });
  }

  const model = scoreRows(evaluated, probabilities);
  const baseline: EvaluationMetrics = evaluated.length ? {
    samples: evaluated.length,
    accuracy: Math.round((weightedBaselineAccuracy / evaluated.length) * 10_000) / 10_000,
    brierScore: Math.round((weightedBaselineBrier / evaluated.length) * 10_000) / 10_000,
    logLoss: Math.round((weightedBaselineLogLoss / evaluated.length) * 10_000) / 10_000,
  } : { samples: 0, accuracy: null, brierScore: null, logLoss: null };

  return {
    status: folds.length ? "complete" : "collecting",
    methodology: "Walk-forward evaluation of frozen serving predictions. Each fold uses only earlier outcomes to fit the expanding-prior baseline, then scores the next chronological holdout.",
    minimumTrainingSamples: safeMinimum,
    foldSize: safeFoldSize,
    evaluatedSamples: evaluated.length,
    model,
    expandingPriorBaseline: baseline,
    brierImprovement: model.brierScore == null || baseline.brierScore == null
      ? null
      : Math.round((baseline.brierScore - model.brierScore) * 10_000) / 10_000,
    folds,
    safeguards: {
      onePredictionPerFixture: true,
      latestPreKickoffOnly: true,
      chronologicalSplits: true,
      futureOutcomesExcludedFromBaseline: true,
      bookmakerOddsUsedByCoreModel: false,
    },
  };
}

export async function runModelBacktest(options: {
  minimumTrainingSamples?: number;
  foldSize?: number;
} = {}): Promise<ModelBacktestResult> {
  const integrity = await verifyPredictionAuditIntegrity({ fresh: true });
  const canonicalCte = canonicalPrematchAuditCte("$1");
  const result = await pool.query(`
    WITH ${canonicalCte}
    SELECT fixture_id, league_id, kickoff_at, home_win_prob, draw_prob,
           away_win_prob, actual_outcome, model_version
      FROM canonical_prematch
     WHERE settled_at IS NOT NULL
       AND actual_outcome IN ('home', 'draw', 'away')
     ORDER BY kickoff_at ASC, fixture_id ASC
  `, [integrity.validIds]);
  const rows: WalkForwardRow[] = result.rows.map((row) => ({
    fixtureId: Number(row.fixture_id),
    leagueId: row.league_id == null ? null : Number(row.league_id),
    kickoffAt: new Date(row.kickoff_at).toISOString(),
    home: Number(row.home_win_prob),
    draw: Number(row.draw_prob),
    away: Number(row.away_win_prob),
    actual: row.actual_outcome as Outcome,
    modelVersion: String(row.model_version),
  }));
  return {
    ...evaluateWalkForwardRows(rows, options.minimumTrainingSamples, options.foldSize),
    generatedAt: new Date().toISOString(),
    integrityVerifiedRows: rows.length,
  };
}

function determineResult(
  ftHome: number,
  ftAway: number
): "home_win" | "draw" | "away_win" {
  if (ftHome > ftAway) return "home_win";
  if (ftAway > ftHome) return "away_win";
  return "draw";
}

export async function runBacktest(
  season?: number | null,
  leagueIds?: string | null
): Promise<BacktestResult> {
  if (backtestCache && Date.now() - backtestCache.fetchedAt < CACHE_TTL_MS) {
    return backtestCache.data;
  }

  // Default to last full season
  const analyzeSeason = season ?? new Date().getFullYear() - 1;

  const leagues = leagueIds
    ? leagueIds.split(",").map((id) => {
        const lid = parseInt(id.trim(), 10);
        return DEFAULT_LEAGUES.find((l) => l.id === lid) ?? { id: lid, name: `League ${lid}`, country: "" };
      })
    : DEFAULT_LEAGUES;

  // Fetch all leagues in parallel
  const allFixtureSets = await Promise.all(
    leagues.map((l) => fetchFixtures(l.id, analyzeSeason))
  );

  const allFixtures = allFixtureSets.flat().filter((f) => {
    const ht = f.score?.halftime;
    const ft = f.score?.fulltime;
    return (
      ht?.home != null &&
      ht?.away != null &&
      ft?.home != null &&
      ft?.away != null
    );
  });

  // Group by halftime score
  type Group = {
    htHome: number;
    htAway: number;
    home_win: number;
    draw: number;
    away_win: number;
    total: number;
  };

  const groups = new Map<string, Group>();

  for (const f of allFixtures) {
    const htHome = f.score.halftime.home!;
    const htAway = f.score.halftime.away!;
    const ftHome = f.score.fulltime.home!;
    const ftAway = f.score.fulltime.away!;
    const key = `${htHome}-${htAway}`;
    const result = determineResult(ftHome, ftAway);

    if (!groups.has(key)) {
      groups.set(key, { htHome, htAway, home_win: 0, draw: 0, away_win: 0, total: 0 });
    }
    const g = groups.get(key)!;
    g.total++;
    g[result]++;
  }

  // Sort: 0-0 first, then by frequency
  const scenarios: BacktestScenario[] = Array.from(groups.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, g]) => {
      const htScore = `${g.htHome}-${g.htAway}`;
      let lead_held: boolean | null = null;
      if (g.htHome > g.htAway) {
        lead_held = pct(g.home_win, g.total) >= 50;
      } else if (g.htAway > g.htHome) {
        lead_held = pct(g.away_win, g.total) >= 50;
      }
      return {
        halftime_score: htScore,
        home_goals_ht: g.htHome,
        away_goals_ht: g.htAway,
        match_count: g.total,
        home_win_count: g.home_win,
        draw_count: g.draw,
        away_win_count: g.away_win,
        home_win_pct: pct(g.home_win, g.total),
        draw_pct: pct(g.draw, g.total),
        away_win_pct: pct(g.away_win, g.total),
        lead_held,
      };
    });

  // Summary stats
  const mostCommon = scenarios[0]?.halftime_score ?? "0-0";

  // Comeback rate: matches where leading team at HT did NOT win
  let ledAtHt = 0;
  let ledAndWon = 0;
  for (const s of scenarios) {
    if (s.home_goals_ht !== s.away_goals_ht) {
      ledAtHt += s.match_count;
      ledAndWon += s.home_goals_ht > s.away_goals_ht
        ? s.home_win_count
        : s.away_win_count;
    }
  }
  const comebackRate = pct(ledAtHt - ledAndWon, ledAtHt);

  const nilNil = groups.get("0-0");
  const homeLeading = scenarios.filter((s) => s.home_goals_ht > s.away_goals_ht);
  const awayLeading = scenarios.filter((s) => s.away_goals_ht > s.home_goals_ht);

  const sumPct = (items: BacktestScenario[], key: keyof BacktestScenario): number => {
    const totalMatches = items.reduce((s, x) => s + x.match_count, 0);
    const totalWins = items.reduce((s, x) => s + (x[key] as number), 0);
    return pct(totalWins, totalMatches);
  };

  const summary: BacktestSummary = {
    most_common_ht_score: mostCommon,
    comeback_rate: comebackRate,
    draw_ht_home_win_pct: nilNil ? pct(nilNil.home_win, nilNil.total) : 0,
    draw_ht_draw_pct: nilNil ? pct(nilNil.draw, nilNil.total) : 0,
    draw_ht_away_win_pct: nilNil ? pct(nilNil.away_win, nilNil.total) : 0,
    home_leading_ht_win_pct: sumPct(homeLeading, "home_win_count"),
    away_leading_ht_win_pct: sumPct(awayLeading, "away_win_count"),
  };

  const result: BacktestResult = {
    total_matches: allFixtures.length,
    season: analyzeSeason,
    leagues,
    scenarios,
    summary,
    generated_at: new Date().toISOString(),
  };

  backtestCache = { data: result, fetchedAt: Date.now() };
  return result;
}
