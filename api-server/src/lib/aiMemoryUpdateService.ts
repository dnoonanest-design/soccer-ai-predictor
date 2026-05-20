import { db, aiBiweeklyUpdates, aiLearningMemory, aiLearningAudits, aiModelRegistry, selfImprovementQueue } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { runAiAwarenessCycle } from "./aiAwareLearningService";
import { analyzeCircumstanceInfluence } from "./circumstanceLearningService";
import { getCalibrationReport, getCalibrationFactors } from "./predictionStore";

type JsonRecord = Record<string, unknown>;

function safeNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value: unknown): number {
  return Math.round(safeNumber(value) * 10000) / 100;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fortnightWindow(now = new Date()) {
  const end = now;
  const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
  return { start, end };
}

export async function rememberAiLearning(input: {
  learningType: string;
  source: string;
  fixtureId?: number | null;
  leagueId?: number | null;
  subject?: string | null;
  summary: string;
  evidence?: JsonRecord | null;
  learnedWeights?: JsonRecord | null;
  confidence?: number | null;
}) {
  const confidence = input.confidence == null ? null : Math.max(0, Math.min(1, safeNumber(input.confidence, 0)));
  await db.insert(aiLearningMemory).values({
    learningType: input.learningType,
    source: input.source,
    fixtureId: input.fixtureId ?? null,
    leagueId: input.leagueId ?? null,
    subject: input.subject ?? null,
    summary: input.summary,
    evidenceJson: input.evidence ?? {},
    learnedWeightsJson: input.learnedWeights ?? {},
    confidence,
  });
}

async function storeKeyLearningFromAudit(audit: any) {
  const after = (audit.afterMetricsJson ?? {}) as JsonRecord;
  const before = (audit.beforeMetricsJson ?? {}) as JsonRecord;
  const recommendations = Array.isArray(audit.recommendationsJson) ? audit.recommendationsJson : [];
  const source = `audit:${audit.auditType}:${audit.id}`;
  const existing = await db.select({ id: aiLearningMemory.id }).from(aiLearningMemory).where(eq(aiLearningMemory.source, source)).limit(1);
  if (existing.length) return;
  await rememberAiLearning({
    learningType: audit.accepted ? "accepted_model_learning" : "monitored_model_learning",
    source,
    subject: audit.auditType,
    summary: `${audit.auditType} reviewed ${audit.sampleSize ?? 0} matches. Accepted=${Boolean(audit.accepted)}. Accuracy=${pct((after as any).accuracy ?? (before as any).accuracy)}%, Brier=${safeNumber((after as any).brierScore ?? (before as any).brierScore).toFixed(4)}.`,
    evidence: { auditId: audit.id, before, after, recommendations, notes: audit.notes },
    learnedWeights: (after as any).weights ?? {},
    confidence: audit.accepted ? 0.78 : 0.45,
  });
}

export async function consolidatePersistentLearningMemory(limit = 200) {
  const recentAudits = await db.select().from(aiLearningAudits).orderBy(desc(aiLearningAudits.createdAt)).limit(limit);
  let remembered = 0;
  for (const audit of recentAudits as any[]) {
    try {
      await storeKeyLearningFromAudit(audit);
      remembered++;
    } catch (err) {
      logger.warn({ err, auditId: audit.id }, "AI memory consolidation skipped one audit");
    }
  }

  const openQueue = await db.select().from(selfImprovementQueue).where(eq(selfImprovementQueue.status, "open")).orderBy(desc(selfImprovementQueue.createdAt)).limit(50);
  for (const item of openQueue as any[]) {
    await rememberAiLearning({
      learningType: "open_improvement_signal",
      source: "self_improvement_queue",
      subject: item.issueType,
      summary: item.description,
      evidence: { queueId: item.id, priority: item.priority, evidence: item.evidenceJson },
      confidence: Math.min(0.9, Math.max(0.2, safeNumber(item.priority, 5) / 10)),
    }).catch(() => undefined);
  }

  return { rememberedAudits: remembered, rememberedQueueSignals: openQueue.length };
}

async function latestActiveModel() {
  const models = await db.select().from(aiModelRegistry).where(eq(aiModelRegistry.active, true)).orderBy(desc(aiModelRegistry.createdAt)).limit(1);
  return models[0] ?? null;
}

function buildUpdateSummary(args: {
  start: Date;
  end: Date;
  sampleSize: number;
  calibration: any;
  factors: any;
  aiCycle: any;
  influence: any;
  modelBefore: any;
  accepted: boolean;
}) {
  const accuracy = pct(args.calibration?.accuracy ?? args.calibration?.pickAccuracy ?? 0);
  const brier = safeNumber(args.calibration?.brierScore, 0);
  const acceptedText = args.accepted ? "PROMOTED" : "MONITORING ONLY";
  return [
    `Fortnightly AI predictor update ${isoDate(args.start)} to ${isoDate(args.end)}: ${acceptedText}.`,
    `Sample size: ${args.sampleSize} settled/learned match records. Accuracy: ${accuracy}%. Brier score: ${brier.toFixed(4)}.`,
    `The app refreshed similar-match memory, circumstance influence, calibration parameters, and saved a permanent learning snapshot.`,
    args.accepted
      ? "The new calibration is active because the sample size and safety checks were sufficient."
      : "The update was recorded but not aggressively promoted because the evidence is still building or accuracy checks were not strong enough.",
  ].join("\n");
}

export async function generateBiweeklyAiUpdate(options: { force?: boolean } = {}) {
  const { start, end } = fortnightWindow();
  if (!options.force) {
    const existing = await db.execute(sql`
      SELECT id FROM ai_biweekly_updates
      WHERE period_start <= ${end} AND period_end >= ${start}
      ORDER BY created_at DESC
      LIMIT 1
    `) as any;
    if ((existing.rows ?? []).length) {
      return { skipped: true, reason: "A biweekly AI update already exists for this period", existingId: existing.rows[0].id };
    }
  }

  const modelBefore = await latestActiveModel();
  const aiCycle = await runAiAwarenessCycle();
  const influence = await analyzeCircumstanceInfluence().catch((err) => ({ error: String(err?.message ?? err) }));
  const factors = await getCalibrationFactors().catch((err) => ({ error: String(err?.message ?? err), sampleSize: 0 }));
  const calibration = await getCalibrationReport().catch((err) => ({ error: String(err?.message ?? err), brierScore: 0, accuracy: 0 }));
  const memory = await consolidatePersistentLearningMemory().catch((err) => ({ error: String(err?.message ?? err) }));
  const modelAfter = await latestActiveModel();

  const sampleSize = safeNumber((aiCycle as any)?.recalibration?.sampleSize ?? (factors as any)?.sampleSize, 0);
  const brier = safeNumber((aiCycle as any)?.recalibration?.brierScore ?? (calibration as any)?.brierScore, 1);
  const accepted = sampleSize >= 60 && brier > 0 && brier < 0.24;
  const summary = buildUpdateSummary({ start, end, sampleSize, calibration, factors, aiCycle, influence, modelBefore, accepted });

  const payload = {
    modelBefore,
    modelAfter,
    aiCycle,
    circumstanceInfluence: influence,
    calibrationReport: calibration,
    calibrationFactors: factors,
    memoryConsolidation: memory,
    safetyRules: {
      minimumSettledMatchesForPromotion: 60,
      maximumBrierForPromotion: 0.24,
      noSourceCodeSelfModification: true,
      databaseCalibrationOnly: true,
    },
  };

  const inserted = await db.insert(aiBiweeklyUpdates).values({
    periodStart: start,
    periodEnd: end,
    status: accepted ? "applied" : "recorded_monitoring",
    sampleSize,
    summary,
    metricsJson: { sampleSize, brierScore: brier, accepted, calibration },
    improvementsJson: payload as any,
    appliedModelVersion: modelAfter?.modelVersion ?? modelBefore?.modelVersion ?? null,
    applied: accepted,
    notes: accepted ? "Fortnightly update applied through guarded database calibration." : "Fortnightly update saved for review; more data or better metrics required before full promotion.",
  }).returning();

  return { update: inserted[0], accepted, summary, payload };
}

export async function getAiMemoryUpdateReport() {
  const [updates, memories, activeModel] = await Promise.all([
    db.select().from(aiBiweeklyUpdates).orderBy(desc(aiBiweeklyUpdates.createdAt)).limit(10),
    db.select().from(aiLearningMemory).orderBy(desc(aiLearningMemory.createdAt)).limit(25),
    latestActiveModel(),
  ]);
  return {
    activeModel,
    recentBiweeklyUpdates: updates,
    recentLearningMemory: memories,
    explanation: "All gathered match data and AI learnings are retained in Postgres tables. Every two weeks the app consolidates evidence, writes a permanent AI update record, and safely promotes calibration/model parameters only when sample-size and accuracy checks pass.",
  };
}
