import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

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
