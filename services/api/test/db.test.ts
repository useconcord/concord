import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

const SCHEMA = ["CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL);"];

describe("dataVersion", () => {
  let handles: Db[] = [];
  let dir: string | undefined;

  afterEach(() => {
    for (const db of handles) db.close();
    handles = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("changes only when another connection commits to the file", () => {
    dir = mkdtempSync(join(tmpdir(), "concord-data-version-"));
    const file = join(dir, "org.db");
    const a = new Db(file, SCHEMA);
    const b = new Db(file, SCHEMA);
    handles = [a, b];

    // SQLite leaves data_version alone for the connection that made the commit.
    const beforeOwn = a.dataVersion();
    a.write("INSERT INTO t (k, v) VALUES ('a', '1')");
    expect(a.dataVersion()).toBe(beforeOwn);

    // Another connection's commit is what A polls for.
    const beforeB = a.dataVersion();
    b.write("INSERT INTO t (k, v) VALUES ('b', '2')");
    expect(a.dataVersion()).not.toBe(beforeB);

    // An uncommitted write on B is not visible to A and must not move its version.
    const beforeUncommitted = a.dataVersion();
    b.raw.exec("BEGIN");
    b.write("INSERT INTO t (k, v) VALUES ('c', '3')");
    expect(a.dataVersion()).toBe(beforeUncommitted);

    // The commit moves it, even though A made no change of its own.
    const beforeCommit = a.dataVersion();
    b.raw.exec("COMMIT");
    expect(a.dataVersion()).not.toBe(beforeCommit);
  });
});

describe("migration rollback", () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "concord-migration-"));
    path = join(directory, "test.sqlite");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("rolls back every statement and can retry with a corrected migration", () => {
    expect(() => {
      const db = new Db(path, ["CREATE TABLE a (x); CREATE TABLE b (y); INSERT INTO nope VALUES (1);"]);
      db.raw.close();
    }).toThrow(/^no such table: nope$/);

    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    } finally {
      inspection.close();
    }

    const retried = new Db(path, ["CREATE TABLE ok (x);"]);
    try {
      expect(retried.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "ok" },
      ]);
      expect(retried.raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      retried.raw.close();
    }
  });

  it("rejects a migration that leaves dangling foreign keys", () => {
    expect(() => {
      const db = new Db(path, [
        "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (1);",
      ]);
      db.raw.close();
    }).toThrow(/^migration 1 leaves dangling references$/);
  });
});
