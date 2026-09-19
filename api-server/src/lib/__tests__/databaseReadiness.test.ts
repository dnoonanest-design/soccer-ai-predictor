import { describe, expect, it } from "vitest";
import {
  getDatabaseReadiness,
  getDatabaseConnectionTarget,
  REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
  REQUIRED_AUDIT_BOUNDARY_MIGRATION,
  REQUIRED_PREMATCH_FREEZE_MIGRATION,
  REQUIRED_WALL_CLOCK_FREEZE_MIGRATION,
  REQUIRED_SAFE_MODEL_REGISTRY_MIGRATION,
} from "../databaseReadinessService";

describe("database readiness", () => {
  it("exposes only a safe Railway service hint for duplicate-database diagnosis", () => {
    expect(getDatabaseConnectionTarget(
      "postgresql://user:secret@postgres-fvyf.railway.internal:5432/railway",
    )).toBe("postgres-fvyf");
    expect(getDatabaseConnectionTarget(
      "postgresql://user:secret@db.example.com:5432/app",
    )).toBe("external-database");
    expect(getDatabaseConnectionTarget("not-a-database-url")).toBeNull();
  });

  it("requires the recorded player migration and all player tables", async () => {
    const result = await getDatabaseReadiness(async (_sql, values) => {
      expect(values).toEqual([
        REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
        REQUIRED_AUDIT_BOUNDARY_MIGRATION,
        REQUIRED_PREMATCH_FREEZE_MIGRATION,
        REQUIRED_WALL_CLOCK_FREEZE_MIGRATION,
        REQUIRED_SAFE_MODEL_REGISTRY_MIGRATION,
      ]);
      return {
        rows: [{
          player_migration_applied: true,
          audit_boundary_migration_applied: true,
          prematch_freeze_migration_applied: true,
          wall_clock_freeze_migration_applied: true,
          safe_model_registry_migration_applied: true,
          player_profiles_present: true,
          player_match_stats_present: true,
          player_ai_signals_present: true,
          audit_boundary_trigger_present: true,
          prematch_update_trigger_present: true,
          prematch_insert_trigger_present: true,
        }],
      };
    }, { production: true, auditSigningKey: "test-signing-key" });

    expect(result).toMatchObject({
      ready: true,
      connected: true,
      migrationApplied: true,
      migrationsApplied: true,
      playerTablesPresent: true,
      auditBoundaryTriggerPresent: true,
      prematchFreezeTriggersPresent: true,
      auditSigningConfigured: true,
    });
  });

  it("is degraded when the migration record or a required table is missing", async () => {
    const result = await getDatabaseReadiness(async () => ({
      rows: [{
        player_migration_applied: false,
        audit_boundary_migration_applied: true,
        prematch_freeze_migration_applied: false,
        wall_clock_freeze_migration_applied: false,
        safe_model_registry_migration_applied: false,
        player_profiles_present: true,
        player_match_stats_present: false,
        player_ai_signals_present: true,
        audit_boundary_trigger_present: true,
        prematch_update_trigger_present: false,
        prematch_insert_trigger_present: false,
      }],
    }));

    expect(result.ready).toBe(false);
    expect(result.connected).toBe(true);
    expect(result.migrationApplied).toBe(false);
    expect(result.playerTablesPresent).toBe(false);
  });

  it("fails closed without exposing database error details", async () => {
    const result = await getDatabaseReadiness(async () => {
      throw new Error("postgresql://secret@host/database");
    }, { databaseUrl: null });

    expect(result).toEqual({
      ready: false,
      connected: false,
      connectionTarget: null,
      requiredMigration: REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
      requiredMigrations: [
        REQUIRED_PLAYER_INTELLIGENCE_MIGRATION,
        REQUIRED_AUDIT_BOUNDARY_MIGRATION,
        REQUIRED_PREMATCH_FREEZE_MIGRATION,
        REQUIRED_WALL_CLOCK_FREEZE_MIGRATION,
        REQUIRED_SAFE_MODEL_REGISTRY_MIGRATION,
      ],
      migrationApplied: false,
      migrationsApplied: false,
      playerTablesPresent: false,
      auditBoundaryTriggerPresent: false,
      prematchFreezeTriggersPresent: false,
      auditSigningRequired: false,
      auditSigningConfigured: false,
    });
  });

  it("fails production readiness when the audit signing key is absent", async () => {
    const result = await getDatabaseReadiness(async () => ({
      rows: [{
        player_migration_applied: true,
        audit_boundary_migration_applied: true,
        prematch_freeze_migration_applied: true,
        wall_clock_freeze_migration_applied: true,
        safe_model_registry_migration_applied: true,
        player_profiles_present: true,
        player_match_stats_present: true,
        player_ai_signals_present: true,
        audit_boundary_trigger_present: true,
        prematch_update_trigger_present: true,
        prematch_insert_trigger_present: true,
      }],
    }), { production: true, auditSigningKey: null });

    expect(result.ready).toBe(false);
    expect(result.auditSigningRequired).toBe(true);
    expect(result.auditSigningConfigured).toBe(false);
  });
});
