import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { CONTROL_MIGRATIONS, ORG_MIGRATIONS } from "../src/schema.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "db");

/** Open a private copy of a committed fixture with the current migration list. */
function upgraded<T>(name: string, migrations: readonly string[], inspect: (db: Db) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "concord-upgrade-"));
  try {
    const path = join(dir, name);
    copyFileSync(join(fixtures, name), path);
    const db = new Db(path, migrations);
    try {
      expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(migrations.length);
      return inspect(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("databases written by earlier builds", () => {
  it("opens the v1 workspace database with the current migrations and keeps its rows", () => {
    upgraded("org-v1.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fixture'")?.value).toBe("org-v1");
      expect(db.get<{ amount: string }>("SELECT amount FROM events WHERE id = 'e1'")?.amount).toBe("1000");
      expect(db.get<{ units: string }>("SELECT units FROM register_positions WHERE holder_id = 'h1'")?.units).toBe("4000");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM openings")?.n).toBe(1);
    });
  });

  it("opens the v2 workspace database and keeps its sign-off history", () => {
    upgraded("org-v2.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fixture'")?.value).toBe("org-v2");
      expect(db.all("SELECT author FROM break_note_history ORDER BY id").map((r) => r.author)).toEqual(["alice", "bob"]);
    });
  });

  it("opens the v3 workspace database with the actions_due index", () => {
    upgraded("org-v3.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fixture'")?.value).toBe("org-v3");
    });
  });

  it("opens the v2 workspace database with default matching windows and keeps v4 custom windows", () => {
    upgraded("org-v2.db", ORG_MIGRATIONS, (db) => {
      const row = db.get<{ instruction_window_hours: number; movement_window_hours: number }>(
        "SELECT instruction_window_hours, movement_window_hours FROM assets WHERE id = 'usd-mainnet'",
      );
      expect(row).toEqual({ instruction_window_hours: 72, movement_window_hours: 24 });
    });
    upgraded("org-v4.db", ORG_MIGRATIONS, (db) => {
      const row = db.get<{ instruction_window_hours: number; movement_window_hours: number }>(
        "SELECT instruction_window_hours, movement_window_hours FROM assets WHERE id = 'usd-mainnet'",
      );
      expect(row).toEqual({ instruction_window_hours: 48, movement_window_hours: 12 });
    });
  });

  it("opens the v5 workspace database and reads the tolerance column", () => {
    upgraded("org-v5.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fixture'")?.value).toBe("org-v5");
      expect(db.get<{ tolerance: string }>("SELECT tolerance FROM assets WHERE id = 'usd-mainnet'")?.tolerance).toBe("5");
    });
  });

  it("backfills sign-off history from the v1 notes when upgrading", () => {
    upgraded("org-v1.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_note_history")?.n).toBe(0);
    });
  });

  it("adds an empty holdings checkpoint table and the event ledger index to a v5 workspace database", () => {
    upgraded("org-v5.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM holdings_checkpoints")?.n).toBe(0);
      expect(db.get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_asset_ledger'")).toBeDefined();
    });
  });

  it("opens the v6 workspace database and keeps its holdings checkpoints", () => {
    upgraded("org-v6.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fixture'")?.value).toBe("org-v6");
      expect(db.get<{ ledger: number }>("SELECT ledger FROM holdings_checkpoints WHERE asset_id = 'usd-mainnet'")?.ledger).toBe(100);
    });
  });

  it("opens the v7 workspace database and keeps its runs list columns", () => {
    upgraded("org-v7.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fixture'")?.value).toBe("org-v7");
      expect(db.get<{ status: string; open_breaks: number }>("SELECT status, open_breaks FROM runs")).toEqual({
        status: "breaks",
        open_breaks: 1,
      });
    });
  });

  it("opens the v8 workspace database and keeps a voided action's trail", () => {
    upgraded("org-v8.db", ORG_MIGRATIONS, (db) => {
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fixture'")?.value).toBe("org-v8");
      expect(db.get("SELECT voided_by, void_reason FROM actions WHERE id = 2")).toEqual({ voided_by: "bob", void_reason: "typo in the rate" });
      expect(db.get<{ voided_at: string | null }>("SELECT voided_at FROM actions WHERE id = 1")?.voided_at).toBeNull();
    });
  });

  it("opens the v1 control database with the current migrations and keeps its rows", () => {
    upgraded("control-v1.db", CONTROL_MIGRATIONS, (db) => {
      expect(db.get<{ name: string }>("SELECT name FROM users WHERE id = 'u1'")?.name).toBe("Alice");
      expect(db.get<{ role: string }>("SELECT role FROM memberships WHERE user_id = 'u1'")?.role).toBe("owner");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM credentials")?.n).toBe(1);
    });
  });

  it("has an upgrade fixture for every migration version", () => {
    // Appending a migration makes this fail until make-db-fixtures.ts has written, and the commit
    // includes, a database frozen at the new version.
    const missing: string[] = [];
    for (const [kind, migrations] of [["org", ORG_MIGRATIONS], ["control", CONTROL_MIGRATIONS]] as const) {
      for (let version = 1; version <= migrations.length; version++) {
        const name = `${kind}-v${version}.db`;
        if (!existsSync(join(fixtures, name))) missing.push(name);
      }
    }
    expect(missing, "run test/fixtures/make-db-fixtures.ts and commit the databases it writes").toEqual([]);
  });
});
