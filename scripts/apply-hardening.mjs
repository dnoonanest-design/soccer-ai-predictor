import { readFile, writeFile, mkdir } from "node:fs/promises";

async function read(path) {
  return readFile(path, "utf8");
}

async function write(path, content) {
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

function replaceOrThrow(content, before, after, label) {
  if (!content.includes(before)) {
    throw new Error(`Hardening patch target not found: ${label}`);
  }
  return content.replace(before, after);
}

// 1) Restore cross-platform native dependency resolution and align Node typings.
{
  const path = "pnpm-workspace.yaml";
  let content = await read(path);
  content = replaceOrThrow(content, "  '@types/node': ^25.3.3", "  '@types/node': ^22.0.0", "workspace Node typings");
  content = content.replace(
    "  # replit uses linux-x64 only, we can exclude all other platforms\n",
    "  # Keep native optional dependencies cross-platform. Production remains Linux,\n  # while local macOS/Windows installs resolve their own supported binaries.\n",
  );
  const nativeStripPatterns = [
    /^\s*["']?esbuild>@esbuild\/.+?:\s*["']-["']\s*$/,
    /^\s*["']?lightningcss>lightningcss-.+?:\s*["']-["']\s*$/,
    /^\s*["']?@tailwindcss\/oxide>@tailwindcss\/oxide-.+?["']?:\s*["']-["']\s*$/,
    /^\s*["']?rollup>@rollup\/.+?:\s*["']-["']\s*$/,
    /^\s*["']?@expo\/ngrok-bin>@expo\/ngrok-bin-.+?["']?:\s*["']-["']\s*$/,
  ];
  content = content
    .split("\n")
    .filter((line) => !nativeStripPatterns.some((pattern) => pattern.test(line)))
    .join("\n");
  await write(path, content);
}

// 2) Pin the API to the production Node major and the validated esbuild version.
{
  const path = "api-server/package.json";
  const pkg = JSON.parse(await read(path));
  pkg.engines = { ...(pkg.engines ?? {}), node: "22.x" };
  pkg.dependencies.esbuild = "0.27.3";
  pkg.devDependencies["@types/node"] = "^22.0.0";
  await write(path, JSON.stringify(pkg, null, 2));
}

// 3) Pin Corepack instead of downloading an unbounded latest version on every build.
{
  const path = "Dockerfile";
  let content = await read(path);
  content = replaceOrThrow(
    content,
    "RUN npm i -g corepack@latest && corepack enable && corepack prepare pnpm@11.19.0 --activate",
    "RUN npm i -g corepack@0.36.0 && corepack enable && corepack prepare pnpm@11.19.0 --activate",
    "Docker Corepack pin",
  );
  await write(path, content);
}

// 4) Add checksum-backed, transactional, one-time database migration tracking.
{
  const path = "lib/db/scripts/migrate.mjs";
  const content = `import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set before running migrations");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, "..");
const migrationFiles = [
  "001_prediction_platform.sql",
  "002_market_intelligence.sql",
  "003_prediction_accuracy_audit.sql",
  "004_full_match_lifecycle_reliability.sql",
  "005_lifecycle_reliability_enrolment_guard.sql",
  "006_fast_daily_prediction_indexes.sql",
  "007_tamper_evident_prediction_audit.sql",
  "008_one_time_prediction_audit_seal.sql",
  "009_prediction_audit_v3_seal.sql",
  "010_archive_terminal_lifecycle_failures.sql",
];

function checksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query(\`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )\`);

  for (const file of migrationFiles) {
    const sql = await readFile(path.join(dbDir, file), "utf8");
    const digest = checksum(sql);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT checksum FROM schema_migrations WHERE filename = $1 FOR UPDATE",
        [file],
      );

      if ((existing.rowCount ?? 0) > 0) {
        const recorded = String(existing.rows[0].checksum);
        if (recorded !== digest) {
          throw new Error(\`Migration checksum mismatch for \${file}; historical migrations must not be edited\`);
        }
        await client.query("COMMIT");
        console.log(\`Verified \${file}\`);
        continue;
      }

      // Existing deployments previously re-ran these idempotent migrations on
      // every release. The first ledger-enabled release safely performs that
      // same pass once, records the checksum, then all future releases skip it.
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [file, digest],
      );
      await client.query("COMMIT");
      console.log(\`Applied \${file}\`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
`;
  await write(path, content);
}

// 5) Add a football-data-only reliability layer for sparse historical samples.
{
  const path = "api-server/src/lib/predictionDataQuality.ts";
  await mkdir("api-server/src/lib", { recursive: true });
  const content = `import type { TeamStats } from "./statsService";

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
`;
  await write(path, content);
}

// 6) Apply data-quality reliability to future stored predictions.
{
  const path = "api-server/src/lib/futurePredictionBaselineService.ts";
  let content = await read(path);
  content = replaceOrThrow(
    content,
    'import { getEnhancedPrediction } from "./enhancedStatsService";\n',
    'import { getEnhancedPrediction } from "./enhancedStatsService";\nimport { applyDataQualityReliability } from "./predictionDataQuality";\n',
    "future baseline data-quality import",
  );
  content = replaceOrThrow(
    content,
    "  confidence: number | null;\n};",
    "  confidence: number | null;\n  dataTier: string;\n};",
    "future baseline data tier type",
  );
  content = replaceOrThrow(
    content,
    `  const normalized = normaliseThreeWay(raw.home_win, raw.draw, raw.away_win);\n  return {\n    home: normalized.home,\n    draw: normalized.draw,\n    away: normalized.away,\n    over25: numberOrNull(raw.over_25),\n    btts: numberOrNull(raw.btts),\n    homeXg: numberOrNull(raw.home_xg),\n    awayXg: numberOrNull(raw.away_xg),\n    confidence: numberOrNull(raw.confidence_score),\n  };`,
    `  const normalized = normaliseThreeWay(raw.home_win, raw.draw, raw.away_win);\n  const quality = applyDataQualityReliability(\n    normalized,\n    stats.home,\n    stats.away,\n    numberOrNull(raw.confidence_score),\n  );\n  return {\n    home: quality.probabilities.home,\n    draw: quality.probabilities.draw,\n    away: quality.probabilities.away,\n    over25: numberOrNull(raw.over_25),\n    btts: numberOrNull(raw.btts),\n    homeXg: numberOrNull(raw.home_xg),\n    awayXg: numberOrNull(raw.away_xg),\n    confidence: quality.confidence,\n    dataTier: quality.dataTier,\n  };`,
    "future baseline probability reliability",
  );
  content = replaceOrThrow(
    content,
    `       $1,$2,$3,$4,$5,'prematch',$6,NULL,'stats-baseline',$7,$8,\n       $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19`,
    `       $1,$2,$3,$4,$5,'prematch',$6,NULL,$20,$7,$8,\n       $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19`,
    "future baseline data tier SQL",
  );
  content = replaceOrThrow(
    content,
    `      confidenceBand,\n      predictedOutcome,\n    ],`,
    `      confidenceBand,\n      predictedOutcome,\n      prediction.dataTier,\n    ],`,
    "future baseline data tier parameter",
  );
  await write(path, content);
}

// 7) Apply the same quality adjustment to audit predictions without touching bookmaker data.
{
  const path = "api-server/src/lib/predictionAccuracyAuditService.ts";
  let content = await read(path);
  content = replaceOrThrow(
    content,
    'import { getMatchStats } from "./statsService";\n',
    'import { getMatchStats } from "./statsService";\nimport { applyDataQualityReliability } from "./predictionDataQuality";\n',
    "audit data-quality import",
  );
  content = replaceOrThrow(
    content,
    `  const normalized = normaliseThreeWay(raw.home_win, raw.draw, raw.away_win);\n  let circumstances: any = null;\n  let adjusted = normalized;`,
    `  const normalized = normaliseThreeWay(raw.home_win, raw.draw, raw.away_win);\n  const quality = applyDataQualityReliability(\n    normalized,\n    stats.home,\n    stats.away,\n    numberOrNull(raw.confidence_score),\n  );\n  let circumstances: any = null;\n  let adjusted = quality.probabilities;`,
    "audit quality-adjusted probabilities",
  );
  content = replaceOrThrow(
    content,
    `    adjusted = await applyCircumstanceCalibration(match, normalized);`,
    `    adjusted = await applyCircumstanceCalibration(match, adjusted);`,
    "audit circumstance calibration order",
  );
  content = replaceOrThrow(
    content,
    `    confidence: numberOrNull(raw.confidence_score),\n    circumstanceScoreHome:`,
    `    confidence: quality.confidence,\n    circumstanceScoreHome:`,
    "audit adjusted confidence",
  );
  content = replaceOrThrow(
    content,
    `    dataTier: includeCircumstances ? "stats+circumstances" : "stats",`,
    `    dataTier: includeCircumstances\n      ? \`${"${quality.dataTier}"}+circumstances\`\n      : quality.dataTier,`,
    "audit quality data tier",
  );
  await write(path, content);
}

// 8) Reconcile stale live rows with a throttled exact-fixture refresh instead of
// repeatedly suppressing the same HT/2H cache entry every dashboard poll.
{
  const path = "api-server/src/lib/soccerService.ts";
  let content = await read(path);
  content = replaceOrThrow(
    content,
    `const cache = new Map<string, CacheEntry<unknown>>();\n`,
    `const cache = new Map<string, CacheEntry<unknown>>();\nconst STALE_LIVE_RECHECK_MS = 10 * 60_000;\nconst STALE_LIVE_OVERRIDE_TTL_MS = 6 * 60 * 60_000;\nconst staleLiveRefreshAt = new Map<number, number>();\nconst staleLiveOverride = new Map<number, CacheEntry<ApiFootballFixture>>();\nconst staleLiveSuppressionLogAt = new Map<number, number>();\n`,
    "stale live cache state",
  );
  content = replaceOrThrow(
    content,
    `async function getTodayFixtures(): Promise<ApiFootballFixture[]> {`,
    `function cachedStaleLiveOverride(fixtureId: number): ApiFootballFixture | null {\n  const cached = staleLiveOverride.get(fixtureId);\n  if (!cached) return null;\n  if (Date.now() - cached.fetchedAt > STALE_LIVE_OVERRIDE_TTL_MS) {\n    staleLiveOverride.delete(fixtureId);\n    return null;\n  }\n  return cached.data;\n}\n\nasync function reconcileStaleLiveFixture(\n  fixture: ApiFootballFixture,\n): Promise<ApiFootballFixture | null> {\n  const fixtureId = fixture.fixture.id;\n  const cached = cachedStaleLiveOverride(fixtureId);\n  if (cached && normaliseStatus(cached.fixture.status.short) !== "live") return cached;\n\n  const lastAttempt = staleLiveRefreshAt.get(fixtureId) ?? 0;\n  if (Date.now() - lastAttempt < STALE_LIVE_RECHECK_MS) return cached;\n  staleLiveRefreshAt.set(fixtureId, Date.now());\n\n  try {\n    const path = \`/fixtures?id=\${fixtureId}\`;\n    const rows = requireFixtureArray(await fetchFootball(path), path);\n    const refreshed = rows.find((row) => row.fixture.id === fixtureId) ?? null;\n    if (refreshed) {\n      staleLiveOverride.set(fixtureId, { data: refreshed, fetchedAt: Date.now() });\n      const status = normaliseStatus(refreshed.fixture.status.short);\n      if (status !== "live") {\n        logger.info(\n          { fixtureId, refreshedStatus: refreshed.fixture.status.short },\n          "stale live fixture reconciled with exact provider status",\n        );\n      }\n    }\n    return refreshed ?? cached;\n  } catch (err) {\n    logger.warn({ err, fixtureId }, "stale live fixture reconciliation failed");\n    return cached;\n  }\n}\n\nasync function getTodayFixtures(): Promise<ApiFootballFixture[]> {`,
    "stale live reconciliation helper",
  );
  content = replaceOrThrow(
    content,
    `    if (dailyStatus === "live" && !liveIds.has(fixtureId)) {\n      logger.warn(\n        {\n          fixtureId,\n          cachedStatus: fixture.fixture.status.short,\n          cachedMinute: fixture.fixture.status.elapsed,\n        },\n        "suppressing stale live fixture from daily cache",\n      );\n      continue;\n    }\n    combined.set(fixtureId, fixture);`,
    `    if (dailyStatus === "live" && !liveIds.has(fixtureId)) {\n      const refreshed = await reconcileStaleLiveFixture(fixture);\n      if (refreshed && normaliseStatus(refreshed.fixture.status.short) !== "live") {\n        combined.set(fixtureId, refreshed);\n        continue;\n      }\n\n      const lastLogged = staleLiveSuppressionLogAt.get(fixtureId) ?? 0;\n      if (Date.now() - lastLogged >= STALE_LIVE_RECHECK_MS) {\n        staleLiveSuppressionLogAt.set(fixtureId, Date.now());\n        logger.warn(\n          {\n            fixtureId,\n            cachedStatus: fixture.fixture.status.short,\n            cachedMinute: fixture.fixture.status.elapsed,\n          },\n          "suppressing stale live fixture while exact status is unresolved",\n        );\n      }\n      continue;\n    }\n    combined.set(fixtureId, cachedStaleLiveOverride(fixtureId) ?? fixture);`,
    "stale live combination logic",
  );
  await write(path, content);
}

// 9) Add focused tests for the data-quality guard.
{
  const path = "api-server/src/lib/__tests__/predictionDataQuality.test.ts";
  await mkdir("api-server/src/lib/__tests__", { recursive: true });
  const content = `import { describe, expect, it } from "vitest";
import { applyDataQualityReliability, teamEvidenceQuality } from "../predictionDataQuality";
import type { TeamStats } from "../statsService";

function stats(overrides: Partial<TeamStats> = {}): TeamStats {
  return {
    team_id: 1,
    team: "Test",
    form: "WWDWL",
    goals_per_game: 1.5,
    conceded_per_game: 1,
    clean_sheets: 2,
    matches_played: 10,
    wins: 5,
    draws: 3,
    losses: 2,
    possession: null,
    shots_total: null,
    shots_on_target: null,
    corners: null,
    fouls: null,
    offsides: null,
    yellow_cards: null,
    red_cards: null,
    goalkeeper_saves: null,
    shots_off_target: null,
    blocked_shots: null,
    shots_inside_box: null,
    shots_outside_box: null,
    total_passes: null,
    accurate_passes: null,
    pass_accuracy: null,
    expected_goals_live: null,
    dangerous_attacks: null,
    data_source: "competition",
    competition_matches_played: 8,
    recent_matches_used: 10,
    venue_matches_used: 5,
    strength_index: 1,
    strength_sample_size: 8,
    ...overrides,
  };
}

describe("prediction data quality", () => {
  it("keeps strong evidence high quality", () => {
    expect(teamEvidenceQuality(stats())).toBeGreaterThanOrEqual(0.9);
  });

  it("shrinks sparse fallback predictions toward neutral", () => {
    const sparse = stats({
      matches_played: 1,
      data_source: "recent_all_comp",
      competition_matches_played: 0,
      recent_matches_used: 1,
      venue_matches_used: 0,
      strength_sample_size: 1,
    });
    const adjusted = applyDataQualityReliability(
      { home: 70, draw: 20, away: 10 },
      sparse,
      sparse,
      80,
    );
    expect(adjusted.dataTier).toBe("stats-low");
    expect(adjusted.probabilities.home).toBeLessThan(70);
    expect(adjusted.probabilities.away).toBeGreaterThan(10);
    expect(adjusted.confidence).toBeLessThan(80);
  });

  it("penalises a fixture when only one side has strong evidence", () => {
    const weak = stats({
      matches_played: 2,
      data_source: "recent_all_comp",
      competition_matches_played: 0,
      recent_matches_used: 2,
      venue_matches_used: 0,
      strength_sample_size: 2,
    });
    const adjusted = applyDataQualityReliability(
      { home: 60, draw: 25, away: 15 },
      stats(),
      weak,
      75,
    );
    expect(adjusted.score).toBeLessThan(0.8);
    expect(adjusted.probabilities.home).toBeLessThan(60);
  });
});
`;
  await write(path, content);
}

// 10) Expand CI to prove macOS compatibility and gate production release commits.
{
  const path = ".github/workflows/market-intelligence-ci.yml";
  const content = `name: Application CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main, feature/market-intelligence-layer, fix/railway-runtime-validation]

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Enable pnpm
        run: |
          npm install --global corepack@0.36.0
          corepack enable
          corepack prepare pnpm@11.19.0 --activate

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test

      - name: Build Railway bundle
        run: pnpm railway:build

      - name: Smoke test production bundle
        env:
          DATABASE_URL: postgresql://ci:ci@127.0.0.1:5432/ci
          ADMIN_SECRET: ci-admin-secret
          BACKGROUND_LEARNER_ENABLED: "false"
          PREDICTION_ACCURACY_AUDIT_ENABLED: "false"
          FUTURE_PREDICTION_BASELINE_ENABLED: "false"
          FULL_MATCH_LIFECYCLE_TEST_ENABLED: "false"
          MARKET_FUTURE_SAMPLER_ENABLED: "false"
          NODE_ENV: production
          PORT: "3100"
        run: |
          set -euo pipefail
          pnpm railway:start > /tmp/soccer-api.log 2>&1 &
          app_pid=$!
          cleanup() {
            kill "$app_pid" 2>/dev/null || true
          }
          trap cleanup EXIT
          for attempt in $(seq 1 30); do
            if curl --fail --silent http://127.0.0.1:3100/api/healthz >/dev/null; then
              echo "Production bundle health check passed"
              exit 0
            fi
            if ! kill -0 "$app_pid" 2>/dev/null; then
              echo "Production bundle exited before becoming healthy"
              cat /tmp/soccer-api.log
              exit 1
            fi
            sleep 1
          done
          echo "Production bundle did not become healthy in time"
          cat /tmp/soccer-api.log
          exit 1

      - name: Build production Docker image
        run: docker build -t soccer-ai-predictor:ci .

  macos-compatibility:
    runs-on: macos-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node 22
        uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Enable pinned pnpm
        run: |
          npm install --global corepack@0.36.0
          corepack enable
          corepack prepare pnpm@11.19.0 --activate

      - name: Install dependencies on macOS
        run: pnpm install --frozen-lockfile

      - name: Typecheck on macOS
        run: pnpm typecheck

      - name: Test on macOS
        run: pnpm test

      - name: Build dashboard and API on macOS
        run: pnpm railway:build

  release-production:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.actor != 'github-actions[bot]'
    needs: [build, macos-compatibility]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout validated main
        uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0

      - name: Create Railway release marker
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          printf '%s\\n' "$GITHUB_SHA" > .railway-release
          git add .railway-release
          git diff --cached --check
          git commit -m "Release validated $GITHUB_SHA [skip ci]"
          git push origin HEAD:main
`;
  await write(path, content);
}

console.log("Hardening source transformations prepared successfully");
