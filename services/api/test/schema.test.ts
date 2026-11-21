import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { ORG_MIGRATIONS } from "../src/schema.js";

function hasCascadePath(db: Db, table: string, root = "assets", visited = new Set<string>()): boolean {
  if (table === root) return true;
  if (visited.has(table)) return false;
  visited.add(table);
  const fks = db.all<{ table: string; on_delete: string }>(`PRAGMA foreign_key_list(${table})`);
  return fks.some(
    (fk) => fk.on_delete.toUpperCase() === "CASCADE" && hasCascadePath(db, fk.table, root, new Set(visited)),
  );
}

describe("schema cascade deletion", () => {
  it("ensures every child table in ORG_MIGRATIONS has a cascade path from assets", () => {
    const db = new Db(":memory:", ORG_MIGRATIONS);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name);
    const childTables = tables.filter((t) => t !== "meta" && t !== "assets");

    expect(childTables.length).toBeGreaterThan(0);
    for (const table of childTables) {
      expect(hasCascadePath(db, table), `table ${table} must cascade from assets`).toBe(true);
    }

    // A new table with no cascade path makes the check fail
    db.raw.exec("CREATE TABLE orphan (id INTEGER PRIMARY KEY, value TEXT)");
    expect(hasCascadePath(db, "orphan")).toBe(false);

    db.close();
  });

  it("deleting an asset cascades to all child tables and leaves another asset unchanged", () => {
    const db = new Db(":memory:", ORG_MIGRATIONS);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name);
    const childTables = tables.filter((t) => t !== "meta" && t !== "assets");

    // Insert assets A and B
    db.raw.exec(`
      INSERT INTO assets (id, network, code, name, decimals, start_mode, created_at)
      VALUES ('A', 'mainnet', 'TESTA', 'Asset A', 7, 'baseline', '2026-01-01'),
             ('B', 'mainnet', 'TESTB', 'Asset B', 7, 'baseline', '2026-01-01');

      INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, amount)
      VALUES ('e1', 'A', 'mint', 1, '2026-01-01', 'tx1', '100'),
             ('e2', 'B', 'mint', 1, '2026-01-01', 'tx2', '100');

      INSERT INTO openings (asset_id, address, amount, as_of_ledger)
      VALUES ('A', 'addrA', '100', 1),
             ('B', 'addrB', '100', 1);

      INSERT INTO registers (id, asset_id, as_of, source, sha256, issues, imported_at)
      VALUES (1, 'A', '2026-01-01', 'src', 'hash', '[]', '2026-01-01'),
             (2, 'B', '2026-01-01', 'src', 'hash', '[]', '2026-01-01');

      INSERT INTO register_positions (register_id, holder_id, units)
      VALUES (1, 'hA', '100'),
             (2, 'hB', '100');

      INSERT INTO journal (asset_id, ref, date, type, units)
      VALUES ('A', 'refA', '2026-01-01', 'type', '100'),
             ('B', 'refB', '2026-01-01', 'type', '100');

      INSERT INTO instructions (asset_id, ref, type, account, issued_at)
      VALUES ('A', 'refA', 'type', 'accA', '2026-01-01'),
             ('B', 'refB', 'type', 'accB', '2026-01-01');

      INSERT INTO runs (id, asset_id, register_id, as_of, created_at, result)
      VALUES (1, 'A', 1, '2026-01-01', '2026-01-01', '{}'),
             (2, 'B', 2, '2026-01-01', '2026-01-01', '{}');

      INSERT INTO actions (id, asset_id, type, label, record_time, params, created_at)
      VALUES (1, 'A', 'type', 'label', '2026-01-01', '{}', '2026-01-01'),
             (2, 'B', 'type', 'label', '2026-01-01', '{}', '2026-01-01');

      INSERT INTO break_notes (asset_id, scope, key, fingerprint, status, note, updated_at)
      VALUES ('A', 'scope', 'kA', 'fp', 'open', 'note', '2026-01-01'),
             ('B', 'scope', 'kB', 'fp', 'open', 'note', '2026-01-01');

      INSERT INTO break_note_history (asset_id, scope, key, fingerprint, status, note, at)
      VALUES ('A', 'scope', 'kA', 'fp', 'open', 'note', '2026-01-01'),
             ('B', 'scope', 'kB', 'fp', 'open', 'note', '2026-01-01');
    `);

    // Verify before deletion: each child table has 2 rows (one for A, one for B)
    for (const table of childTables) {
      const count = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
      expect(count, `expected table ${table} to have 2 rows before delete`).toBe(2);
    }

    // Delete asset A
    db.raw.exec("DELETE FROM assets WHERE id = 'A'");

    // Verify asset A is gone and asset B remains
    expect(db.all("SELECT id FROM assets WHERE id = 'A'")).toHaveLength(0);
    expect(db.all("SELECT id FROM assets WHERE id = 'B'")).toHaveLength(1);

    // Verify every child table now has exactly 1 row (belonging to B, none for A)
    for (const table of childTables) {
      const count = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
      expect(count, `expected table ${table} to have 1 row after deleting asset A`).toBe(1);

      // Verify specific records for A are gone
      if (table === "register_positions") {
        const rowsA = db.all("SELECT * FROM register_positions WHERE register_id = 1");
        const rowsB = db.all("SELECT * FROM register_positions WHERE register_id = 2");
        expect(rowsA).toHaveLength(0);
        expect(rowsB).toHaveLength(1);
      } else {
        const rowsA = db.all(`SELECT * FROM ${table} WHERE asset_id = 'A'`);
        const rowsB = db.all(`SELECT * FROM ${table} WHERE asset_id = 'B'`);
        expect(rowsA).toHaveLength(0);
        expect(rowsB).toHaveLength(1);
      }
    }

    db.close();
  });
});
