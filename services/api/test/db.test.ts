import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

describe("migrate", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "concord-db-migrate-"));
    file = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes from a partial user_version and applies only later migrations", () => {
    const m1 = "CREATE TABLE t1 (id INTEGER PRIMARY KEY);";
    const m2 = "CREATE TABLE t2 (id INTEGER PRIMARY KEY);";

    const db1 = new Db(file, [m1]);
    expect(db1.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
    db1.close();

    const db2 = new Db(file, [m1, m2]);
    expect(db2.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(2);
    const tables = db2
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toEqual(["t1", "t2"]);
    db2.close();
  });

  it("refuses a database at a newer schema version than the build knows", () => {
    const m1 = "CREATE TABLE t1 (id INTEGER PRIMARY KEY);";
    const m2 = "CREATE TABLE t2 (id INTEGER PRIMARY KEY);";

    const db = new Db(file, [m1, m2]);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(2);
    db.close();

    expect(() => new Db(file, [m1])).toThrow(`${file} is at schema 2; this build only knows 1`);
  });

  it("applies each migration atomically and rolls back on failure", () => {
    const m1 = "CREATE TABLE t1 (id INTEGER PRIMARY KEY);";
    const m2Broken = "CREATE TABLE t2 (id INTEGER PRIMARY KEY); INSERT INTO nope VALUES (1);";

    const db1 = new Db(file, [m1]);
    expect(db1.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
    db1.close();

    expect(() => new Db(file, [m1, m2Broken])).toThrow(/no such table: nope/);

    const dbReopened = new Db(file, [m1]);
    expect(dbReopened.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(1);
    const tables = dbReopened
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toEqual(["t1"]);
    dbReopened.close();
  });
});
