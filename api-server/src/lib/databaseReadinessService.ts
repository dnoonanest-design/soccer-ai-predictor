import { pool } from "@workspace/db";

export const REQUIRED_PLAYER_INTELLIGENCE_MIGRATION = "012_player_intelligence.sql";

export interface DatabaseReadiness {
  ready: boolean;
  connected: boolean;
  requiredMigration: string;
  migrationApplied: boolean;
  playerTablesPresent: boolean;
}

type QueryResult = {
  rows: Array<{
    migration_applied: boolean;
    player_profiles_present: boolean;
    player_match_stats_present: boolean;
    player_ai_signals_present: boolean;
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
): Promise<DatabaseReadiness> {
  const base = {
    requiredMigration: REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
    migrationApplied: false,
    playerTablesPresent: false,
  };

  try {
    const result = await query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM schema_migrations
          WHERE filename = $1
        ) AS migration_applied,
        to_regclass('public.player_profiles') IS NOT NULL AS player_profiles_present,
        to_regclass('public.player_match_stats') IS NOT NULL AS player_match_stats_present,
        to_regclass('public.player_ai_signals') IS NOT NULL AS player_ai_signals_present
    `, [REQUIRED_PLAYER_INTELLIGENCE_MIGRATION]);
    const row = result.rows[0];
    const playerTablesPresent = Boolean(
      row?.player_profiles_present &&
      row?.player_match_stats_present &&
      row?.player_ai_signals_present,
    );
    const migrationApplied = Boolean(row?.migration_applied);
    return {
      ready: migrationApplied && playerTablesPresent,
      connected: true,
      ...base,
      migrationApplied,
      playerTablesPresent,
    };
  } catch {
    return { ready: false, connected: false, ...base };
  }
}
