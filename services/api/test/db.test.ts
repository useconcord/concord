import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
