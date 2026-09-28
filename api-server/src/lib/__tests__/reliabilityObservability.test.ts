import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("lifecycle reliability observability", () => {
  it("shows active fixtures first and orders completed fixtures by latest evaluation", async () => {
    const code = await source("../fullMatchLifecycleReliabilityService.ts");
    expect(code).toContain("last_evaluated_at DESC NULLS LAST");
    expect(code).not.toContain("ORDER BY CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END, kickoff_at ASC");
  });

  it("re-evaluates completed fixtures when a later recovered outcome is recorded", async () => {
    const code = await source("../fullMatchLifecycleReliabilityService.ts");
    expect(code).toContain("o.recorded_at > COALESCE(f.last_evaluated_at, f.enrolled_at)");
    expect(code).toContain("WHEN $2 = 'completed' THEN COALESCE(completed_at, $9)");
    expect(code).toContain("ELSE NULL");
  });

  it("keeps match detail GET requests read-only", async () => {
    const code = await source("../../routes/matches.ts");
    expect(code).not.toContain("saveOutcome");
    expect(code).toContain('router.get("/matches/:match_id"');
  });
});
