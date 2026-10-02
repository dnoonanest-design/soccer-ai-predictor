import { pool } from "@workspace/db";
import { getAdaptiveLearningReport } from "./adaptiveLearningEngine";
import { getFutureMarketSamplerStatus } from "./futureMarketSamplerService";
import { getTrackedCompetition } from "./leagueConfig";
import { getOddsOptimizationStatus } from "./oddsOptimizationService";
import { getQuotaOptimizationStatus } from "./quotaOptimizationService";
import { getStatsCoverageStatus } from "./statsService";

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
}

export async function getProductionAcceptanceReport() {
  const [lifecycle, stageGaps, leagueReliability, marketCoverage, activeModels, adaptive] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS fixtures,
        COUNT(*) FILTER (WHERE lifecycle_status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE verdict = 'pass')::int AS passed,
        COUNT(*) FILTER (WHERE verdict = 'warning')::int AS warnings,
        COUNT(*) FILTER (WHERE verdict = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE lifecycle_status = 'settling')::int AS still_settling,
        AVG(reliability_score) FILTER (WHERE reliability_score IS NOT NULL) AS average_reliability_score,
        MAX(last_evaluated_at) AS last_evaluated_at
      FROM lifecycle_reliability_fixtures
      WHERE kickoff_at >= NOW() - INTERVAL '7 days'
        AND kickoff_at <= NOW()
    `),
    pool.query(`
      SELECT gap.stage, COUNT(*)::int AS fixtures
      FROM lifecycle_reliability_fixtures f
      CROSS JOIN LATERAL jsonb_array_elements_text(f.missing_required_json) AS gap(stage)
      WHERE f.kickoff_at >= NOW() - INTERVAL '30 days'
        AND f.kickoff_at <= NOW()
      GROUP BY gap.stage
      ORDER BY fixtures DESC, gap.stage ASC
      LIMIT 20
    `),
    pool.query(`
      SELECT league_id,
             COUNT(*)::int AS fixtures,
             COUNT(*) FILTER (WHERE verdict = 'pass')::int AS passed,
             COUNT(*) FILTER (WHERE verdict = 'warning')::int AS warnings,
             COUNT(*) FILTER (WHERE verdict = 'failed')::int AS failed,
             AVG(reliability_score) FILTER (WHERE reliability_score IS NOT NULL) AS average_reliability_score
      FROM lifecycle_reliability_fixtures
      WHERE kickoff_at >= NOW() - INTERVAL '30 days'
        AND kickoff_at <= NOW()
      GROUP BY league_id
      ORDER BY failed DESC, warnings DESC, fixtures DESC
    `),
    pool.query(`
      WITH audited AS (
        SELECT DISTINCT ON (fixture_id)
               fixture_id, league_id, home_team, away_team, kickoff_at
        FROM prediction_audit_records
        WHERE phase = 'prematch'
          AND kickoff_at >= NOW() - INTERVAL '24 hours'
          AND kickoff_at <= NOW() + INTERVAL '72 hours'
          AND captured_at < kickoff_at
          AND voided_at IS NULL
        ORDER BY fixture_id, captured_at DESC
      ), odds AS (
        SELECT fixture_id, COUNT(*)::int AS observations, MAX(observed_at) AS last_observed_at
        FROM market_odds_snapshots
        GROUP BY fixture_id
      )
      SELECT a.fixture_id, a.league_id, a.home_team, a.away_team, a.kickoff_at,
             COALESCE(o.observations, 0)::int AS observations,
             o.last_observed_at
      FROM audited a
      LEFT JOIN odds o ON o.fixture_id = a.fixture_id
      ORDER BY a.kickoff_at ASC
    `),
    pool.query(`
      SELECT model_version, model_type, training_rows, weights_json, metrics_json, created_at
      FROM ai_model_registry
      WHERE active = TRUE
      ORDER BY created_at DESC
    `),
    getAdaptiveLearningReport(),
  ]);

  const lifecycleRow = lifecycle.rows[0] ?? {};
  const fixtures = number(lifecycleRow.fixtures);
  const completed = number(lifecycleRow.completed);
  const marketRows = marketCoverage.rows.map((row) => ({
    fixtureId: number(row.fixture_id),
    leagueId: row.league_id == null ? null : number(row.league_id),
    competition: row.league_id == null
      ? null
      : getTrackedCompetition(number(row.league_id))?.name ?? `League ${row.league_id}`,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    kickoffAt: row.kickoff_at,
    observations: number(row.observations),
    lastObservedAt: row.last_observed_at,
  }));
  const withOdds = marketRows.filter((row) => row.observations > 0);
  const withoutOdds = marketRows.filter((row) => row.observations === 0);
  const invalidActiveModels = activeModels.rows.filter((row) => {
    const sampleSize = Math.max(number(row.training_rows), number(row.weights_json?.sampleSize));
    const holdoutRows = number(row.metrics_json?.holdoutRows);
    return row.model_type !== "adaptive-chronological-calibrator" ||
      sampleSize < 500 || holdoutRows < 100 || row.metrics_json?.chronologicalHoldout !== true;
  });

  return {
    generatedAt: new Date().toISOString(),
    verdict: {
      ready: number(lifecycleRow.failed) === 0 && invalidActiveModels.length === 0,
      lifecycleFailuresPresent: number(lifecycleRow.failed) > 0,
      invalidActiveModelPresent: invalidActiveModels.length > 0,
    },
    realMatchLifecycle: {
      periodDays: 7,
      fixtures,
      completed,
      completionRatePercent: percent(completed, fixtures),
      passed: number(lifecycleRow.passed),
      warnings: number(lifecycleRow.warnings),
      failed: number(lifecycleRow.failed),
      stillSettling: number(lifecycleRow.still_settling),
      averageReliabilityScore: lifecycleRow.average_reliability_score == null
        ? null
        : Math.round(number(lifecycleRow.average_reliability_score) * 100) / 100,
      lastEvaluatedAt: lifecycleRow.last_evaluated_at,
      leadingStageGaps: stageGaps.rows.map((row) => ({
        stage: row.stage,
        fixtures: number(row.fixtures),
      })),
      leagueReliability: leagueReliability.rows.map((row) => ({
        leagueId: row.league_id == null ? null : number(row.league_id),
        competition: row.league_id == null
          ? null
          : getTrackedCompetition(number(row.league_id))?.name ?? `League ${row.league_id}`,
        fixtures: number(row.fixtures),
        passed: number(row.passed),
        warnings: number(row.warnings),
        failed: number(row.failed),
        averageReliabilityScore: row.average_reliability_score == null
          ? null
          : Math.round(number(row.average_reliability_score) * 100) / 100,
      })),
    },
    statisticalCoverage: getStatsCoverageStatus(),
    marketCoverage: {
      window: { pastHours: 24, futureHours: 72 },
      auditedFixtures: marketRows.length,
      fixturesWithOdds: withOdds.length,
      fixturesWithoutOdds: withoutOdds.length,
      coverageRatePercent: percent(withOdds.length, marketRows.length),
      missingMarketRatePercent: percent(withoutOdds.length, marketRows.length),
      missingFixtures: withoutOdds.slice(0, 50),
      optimisation: getOddsOptimizationStatus(),
      sampler: getFutureMarketSamplerStatus(),
    },
    apiFootball: getQuotaOptimizationStatus(),
    adaptiveLearning: {
      servingRole: adaptive.servingRole,
      activePromotion: adaptive.activePromotion,
      promotionPolicy: adaptive.promotionPolicy,
      invalidActiveModels: invalidActiveModels.map((row) => ({
        modelVersion: row.model_version,
        modelType: row.model_type,
        trainingRows: number(row.training_rows),
        sampleSize: number(row.weights_json?.sampleSize),
        holdoutRows: number(row.metrics_json?.holdoutRows),
        createdAt: row.created_at,
      })),
      guardSatisfied: invalidActiveModels.length === 0,
    },
    releaseControls: {
      productionBranch: "main",
      deploymentTrigger: ".railway-release",
      releaseMarkerCreatedOnlyAfterCi: true,
      requiredValidation: [
        "clean-database migrations applied twice",
        "prediction boundary verification",
        "typecheck",
        "automated tests",
        "Railway bundle build",
        "production smoke test",
        "Docker build",
        "macOS compatibility validation",
      ],
    },
  };
}
