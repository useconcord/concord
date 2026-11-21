import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { ORG_MIGRATIONS } from "../src/schema.js";

/**
 * EXPLAIN QUERY PLAN assertions to catch query performance regressions (CON-0420).
 * Queries are copied verbatim from services/api/src/concord.ts.
 */

function explain(db: Db, sql: string): string[] {
  return db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail);
}

const CON_0363_INDEXES = `
CREATE INDEX events_address_from ON events (asset_id, from_addr);
CREATE INDEX events_address_to ON events (asset_id, to_addr);
CREATE INDEX runs_asset_as_of ON runs (asset_id, as_of DESC, id DESC);
CREATE INDEX actions_due ON actions (snapshot, asset_id, record_time);
`;

describe("query plans", () => {
  describe("already-indexed lookups (regression guards)", () => {
    const db = new Db(":memory:", ORG_MIGRATIONS);

    it("runs by id (concord.ts:1106)", () => {
      const plan = explain(db, "SELECT * FROM runs WHERE id = ?");
      expect(plan.some((s) => s.includes("USING INTEGER PRIMARY KEY"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN") && !s.includes("TEMP B-TREE"))).toBe(true);
    });

    it("runs by register_id (concord.ts:1140)", () => {
      const plan = explain(db, "SELECT id FROM runs WHERE register_id = ? ORDER BY id DESC LIMIT 1");
      expect(plan.some((s) => s.includes("USING COVERING INDEX runs_register"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN") && !s.includes("TEMP B-TREE"))).toBe(true);
    });

    it("runs by asset_id limit 200 (concord.ts:1123)", () => {
      const plan = explain(db, "SELECT id FROM runs WHERE asset_id = ? ORDER BY id DESC LIMIT 200");
      expect(plan.some((s) => s.includes("USING COVERING INDEX runs_asset"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN") && !s.includes("TEMP B-TREE"))).toBe(true);
    });

    it("actions by id (concord.ts:1350)", () => {
      const plan = explain(db, "SELECT * FROM actions WHERE id = ?");
      expect(plan.some((s) => s.includes("USING INTEGER PRIMARY KEY"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN") && !s.includes("TEMP B-TREE"))).toBe(true);
    });

    it("actions by asset_id (concord.ts:1504)", () => {
      const plan = explain(db, "SELECT id FROM actions WHERE asset_id = ? ORDER BY record_time DESC, id DESC");
      expect(plan.some((s) => s.includes("USING COVERING INDEX actions_asset"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN") && !s.includes("TEMP B-TREE"))).toBe(true);
    });
  });

  describe("unindexed hot queries on base schema (reproduces main before CON-0363)", () => {
    const db = new Db(":memory:", ORG_MIGRATIONS);

    it("events() address filter uses only asset_id on current schema (concord.ts:770)", () => {
      const plan = explain(
        db,
        "SELECT * FROM events WHERE asset_id = ? AND (from_addr = ? OR to_addr = ?) ORDER BY id DESC LIMIT ?",
      );
      // Current schema only has primary key index (asset_id, id); address filter is evaluated post-index lookup
      expect(plan.some((s) => s.includes("sqlite_autoindex_events_1 (asset_id=?)"))).toBe(true);
      expect(plan.some((s) => s.includes("events_address_"))).toBe(false);
    });

    it("latestRun requires temporary b-tree on current schema (concord.ts:1146)", () => {
      const plan = explain(db, "SELECT id FROM runs WHERE asset_id = ? ORDER BY as_of DESC, id DESC LIMIT 1");
      expect(plan.some((s) => s.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true);
    });

    it("prior-run in reconcile requires temporary b-tree on current schema (concord.ts:1046)", () => {
      const plan = explain(
        db,
        "SELECT result FROM runs WHERE asset_id = ? AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1",
      );
      expect(plan.some((s) => s.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true);
    });

    it("reconcileDue performs table scan on actions on current schema (concord.ts:1517)", () => {
      const plan = explain(
        db,
        `SELECT a.id FROM actions a JOIN assets s ON s.id = a.asset_id
         WHERE a.snapshot IS NULL AND s.synced_at IS NOT NULL AND s.synced_at >= a.record_time`,
      );
      expect(plan.some((s) => s.includes("SCAN a"))).toBe(true);
    });
  });

  describe("hot queries with CON-0363 matching indexes applied", () => {
    const db = new Db(":memory:", [...ORG_MIGRATIONS, CON_0363_INDEXES]);

    it("events() address filter searches using index with no full table scan (concord.ts:770)", () => {
      const plan = explain(
        db,
        "SELECT * FROM events WHERE asset_id = ? AND (from_addr = ? OR to_addr = ?) ORDER BY id DESC LIMIT ?",
      );
      expect(plan.some((s) => s.includes("SEARCH events USING INDEX"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN events"))).toBe(true);
    });

    it("latestRun resolves via index with no SCAN or TEMP B-TREE (concord.ts:1146)", () => {
      const plan = explain(db, "SELECT id FROM runs WHERE asset_id = ? ORDER BY as_of DESC, id DESC LIMIT 1");
      expect(plan.some((s) => s.includes("SEARCH runs USING COVERING INDEX runs_asset_as_of"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN") && !s.includes("TEMP B-TREE"))).toBe(true);
    });

    it("prior-run in reconcile resolves via index with no SCAN or TEMP B-TREE (concord.ts:1046)", () => {
      const plan = explain(
        db,
        "SELECT result FROM runs WHERE asset_id = ? AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1",
      );
      expect(plan.some((s) => s.includes("SEARCH runs USING INDEX runs_asset_as_of"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN") && !s.includes("TEMP B-TREE"))).toBe(true);
    });

    it("reconcileDue resolves actions join via index with no SCAN or TEMP B-TREE (concord.ts:1517)", () => {
      const plan = explain(
        db,
        `SELECT a.id FROM actions a JOIN assets s ON s.id = a.asset_id
         WHERE a.snapshot IS NULL AND s.synced_at IS NOT NULL AND s.synced_at >= a.record_time`,
      );
      expect(plan.some((s) => s.includes("SEARCH a USING COVERING INDEX actions_due"))).toBe(true);
      expect(plan.every((s) => !s.includes("SCAN a") && !s.includes("TEMP B-TREE"))).toBe(true);
    });
  });
});
