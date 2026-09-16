import { describe, expect, it } from "vitest";
import { canonicalPrematchAuditCte } from "../canonicalPrematchAudit";

describe("canonical prematch audit selector", () => {
  it("selects one verified pre-kickoff row per fixture", () => {
    const sql = canonicalPrematchAuditCte("$3");
    expect(sql).toMatch(/id = ANY\(\$3::bigint\[\]\)/);
    expect(sql).toMatch(/phase = 'prematch'/);
    expect(sql).toMatch(/captured_at < kickoff_at/);
    expect(sql).toMatch(/DISTINCT ON \(fixture_id\)/);
    expect(sql).toMatch(/ORDER BY fixture_id, captured_at DESC, id DESC/);
  });

  it("rejects interpolated SQL instead of accepting an unsafe parameter", () => {
    expect(() => canonicalPrematchAuditCte("$1); DROP TABLE users; --"))
      .toThrow("positional SQL parameter");
  });
});
