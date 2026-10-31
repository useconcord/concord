import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { ORG_MIGRATIONS } from "../src/schema.js";

describe("due action migration index", () => {
  it("upgrades a version-1 workspace and uses a partial index for unreconciled actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-due-index-"));
    const path = join(dir, "org.db");
    try {
      const old = new Db(path, [ORG_MIGRATIONS[0]!]);
      old.close();
      const db = new Db(path, ORG_MIGRATIONS);
      try {
        expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(ORG_MIGRATIONS.length);
        const plans = db.raw.prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM actions WHERE snapshot IS NULL AND record_time <= ?",
        ).all("2026-10-28T00:00:00Z") as Array<{ detail: string }>;
        expect(plans.map((p) => p.detail).join("\n")).toContain("actions_due");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
