/**
 * One frozen, integrity-verified prediction per fixture for public serving and
 * headline performance metrics. Checkpoint-level rows remain available for
 * calibration diagnostics, but they must never inflate fixture-level results.
 */
export function canonicalPrematchAuditCte(validIdsParameter: string) {
  if (!/^\$\d+$/.test(validIdsParameter)) {
    throw new Error("validIdsParameter must be a positional SQL parameter");
  }

  return `certified_prematch AS (
    SELECT *
      FROM prediction_audit_records
     WHERE id = ANY(${validIdsParameter}::bigint[])
       AND phase = 'prematch'
       AND voided_at IS NULL
       AND kickoff_at IS NOT NULL
       AND captured_at < kickoff_at
  ), canonical_prematch AS (
    SELECT DISTINCT ON (fixture_id) *
      FROM certified_prematch
     ORDER BY fixture_id, captured_at DESC, id DESC
  )`;
}
