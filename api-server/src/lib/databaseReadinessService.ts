import { pool } from "@workspace/db";

export const REQUIRED_PLAYER_INTELLIGENCE_MIGRATION = "012_player_intelligence.sql";
export const REQUIRED_AUDIT_BOUNDARY_MIGRATION = "013_reject_late_prematch_audits.sql";
export const REQUIRED_PREMATCH_FREEZE_MIGRATION = "014_freeze_prematch_predictions.sql";
export const REQUIRED_WALL_CLOCK_FREEZE_MIGRATION = "015_use_wall_clock_for_prematch_freeze.sql";

export interface DatabaseReadiness {
  ready: boolean;
  connected: boolean;
  requiredMigration: string;
  migrationApplied: boolean;
  requiredMigrations: string[];
  migrationsApplied: boolean;
  playerTablesPresent: boolean;
  auditBoundaryTriggerPresent: boolean;
  prematchFreezeTriggersPresent: boolean;
  auditSigningRequired: boolean;
  auditSigningConfigured: boolean;
}

type QueryResult = {
  rows: Array<{
    player_migration_applied: boolean;
    audit_boundary_migration_applied: boolean;
    prematch_freeze_migration_applied: boolean;
    wall_clock_freeze_migration_applied: boolean;
    player_profiles_present: boolean;
    player_match_stats_present: boolean;
    player_ai_signals_present: boolean;
    audit_boundary_trigger_present: boolean;
    prematch_update_trigger_present: boolean;
    prematch_insert_trigger_present: boolean;
  }>;
};

type Query = (sql: string, values: unknown[]) => Promise<QueryResult>;

/**
 * Verify the database contract required by participant-gated player
 * intelligence. Keep this separate from liveness: Railway should not restart a
 * healthy web process merely because PostgreSQL is briefly unavailable.
 */
export async function getDatabaseReadiness(
  query: Query = (sql, values) => pool.query(sql, values) as Promise<QueryResult>,
  options: {
    production?: boolean;
    auditSigningKey?: string | null;
  } = {},
): Promise<DatabaseReadiness> {
  const requiredMigrations = [
    REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
    REQUIRED_AUDIT_BOUNDARY_MIGRATION,
    REQUIRED_PREMATCH_FREEZE_MIGRATION,
    REQUIRED_WALL_CLOCK_FREEZE_MIGRATION,
  ];
  const auditSigningRequired = options.production ?? process.env.NODE_ENV === "production";
  const configuredSigningKey = Object.prototype.hasOwnProperty.call(options, "auditSigningKey")
    ? options.auditSigningKey
    : process.env.PREDICTION_AUDIT_SIGNING_KEY;
  const auditSigningConfigured = Boolean(configuredSigningKey?.trim());
  const base = {
    requiredMigration: REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
    migrationApplied: false,
    requiredMigrations,
    migrationsApplied: false,
    playerTablesPresent: false,
    auditBoundaryTriggerPresent: false,
    prematchFreezeTriggersPresent: false,
    auditSigningRequired,
    auditSigningConfigured,
  };

  try {
    const result = await query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM schema_migrations
          WHERE filename = $1
        ) AS player_migration_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations WHERE filename = $2
        ) AS audit_boundary_migration_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations WHERE filename = $3
        ) AS prematch_freeze_migration_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations WHERE filename = $4
        ) AS wall_clock_freeze_migration_applied,
        to_regclass('public.player_profiles') IS NOT NULL AS player_profiles_present,
        to_regclass('public.player_match_stats') IS NOT NULL AS player_match_stats_present,
        to_regclass('public.player_ai_signals') IS NOT NULL AS player_ai_signals_present,
        EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_reject_late_prematch_audit' AND NOT tgisinternal
        ) AS audit_boundary_trigger_present,
        EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_freeze_started_prematch_prediction' AND NOT tgisinternal
        ) AS prematch_update_trigger_present,
        EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgname = 'trg_reject_started_prematch_prediction_insert' AND NOT tgisinternal
        ) AS prematch_insert_trigger_present
    `, requiredMigrations);
    const row = result.rows[0];
    const playerTablesPresent = Boolean(
      row?.player_profiles_present &&
      row?.player_match_stats_present &&
      row?.player_ai_signals_present,
    );
    const migrationApplied = Boolean(row?.player_migration_applied);
    const migrationsApplied = Boolean(
      migrationApplied &&
      row?.audit_boundary_migration_applied &&
      row?.prematch_freeze_migration_applied &&
      row?.wall_clock_freeze_migration_applied,
    );
    const auditBoundaryTriggerPresent = Boolean(row?.audit_boundary_trigger_present);
    const prematchFreezeTriggersPresent = Boolean(
      row?.prematch_update_trigger_present && row?.prematch_insert_trigger_present,
    );
    const signingReady = !auditSigningRequired || auditSigningConfigured;
    return {
      ready:
        migrationsApplied && playerTablesPresent && auditBoundaryTriggerPresent &&
        prematchFreezeTriggersPresent && signingReady,
      connected: true,
      ...base,
      migrationApplied,
      migrationsApplied,
      playerTablesPresent,
      auditBoundaryTriggerPresent,
      prematchFreezeTriggersPresent,
    };
  } catch {
    return { ready: false, connected: false, ...base };
  }
}
