import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { spawn, type ChildProcess } from "node:child_process";

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
    }).toThrow(/^failed to initialize database .*: no such table: nope$/);

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
    }).toThrow(/^failed to initialize database .*: migration 1 leaves dangling references$/);
  });
});

describe("Db.tx", () => {
  it("commits on success: inserts row, returns callback value, row count is 1", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      const result = db.tx(() => {
        db.insert("INSERT INTO x (a) VALUES (1)");
        return "success-value";
      });
      expect(result).toBe("success-value");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rolls back on throw: rethrows the original error object and row count is 0", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      const originalError = new Error("custom rollback error");
      let caught: unknown;
      try {
        db.tx(() => {
          db.insert("INSERT INTO x (a) VALUES (1)");
          throw originalError;
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(originalError);
      expect((caught as Error).message).toBe("custom rollback error");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses nested transaction: inner throws and outer insert is rolled back", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      let innerError: unknown;
      let outerError: unknown;
      try {
        db.tx(() => {
          db.insert("INSERT INTO x (a) VALUES (1)");
          try {
            db.tx(() => {
              db.insert("INSERT INTO x (a) VALUES (2)");
            });
          } catch (err) {
            innerError = err;
            throw err;
          }
        });
      } catch (err) {
        outerError = err;
      }
      expect(innerError).toBeInstanceOf(Error);
      expect((innerError as Error).message).toMatch(/cannot start a transaction within a transaction/);
      expect(outerError).toBe(innerError);
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("recovers afterwards: new transaction works and commits after nested transaction failure", () => {
    const db = new Db(":memory:", ["CREATE TABLE x (a INTEGER);"]);
    try {
      expect(() => {
        db.tx(() => {
          db.insert("INSERT INTO x (a) VALUES (1)");
          db.tx(() => {
            db.insert("INSERT INTO x (a) VALUES (2)");
          });
        });
      }).toThrow(/cannot start a transaction within a transaction/);
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(0);

      const recoveredResult = db.tx(() => {
        db.insert("INSERT INTO x (a) VALUES (3)");
        return "recovered-ok";
      });
      expect(recoveredResult).toBe("recovered-ok");
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM x")?.n).toBe(1);
    } finally {
      db.close();
    }
  });
});

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

describe("Db busy_timeout", () => {
  let tempDir: string;
  let dbPath: string;
  let child: ChildProcess | undefined;
  let db: Db | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concord-db-test-"));
    dbPath = join(tempDir, "test.db");
  });

  async function killChild(cp: ChildProcess | undefined): Promise<void> {
    if (!cp || cp.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      cp.on("exit", () => resolve());
      cp.kill();
      setTimeout(resolve, 500);
    });
  }

  afterEach(async () => {
    if (db) {
      try {
        db.close();
      } catch {}
      db = undefined;
    }
    await killChild(child);
    child = undefined;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  function lockDbInChild(path: string, holdMs = 300): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const script = `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        db.exec("BEGIN IMMEDIATE");
        process.stdout.write("locked\\n");
        setTimeout(() => {
          try {
            db.exec("ROLLBACK");
            db.close();
          } catch {}
          process.exit(0);
        }, ${holdMs});
      `;
      const cp = spawn(process.execPath, ["--input-type=commonjs", "-e", script, path], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = cp;
      let output = "";
      cp.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("locked")) {
          resolve(cp);
        }
      });
      cp.on("error", reject);
      cp.on("exit", (code) => {
        if (!output.includes("locked")) {
          reject(new Error(`Child exited with code ${code} before acquiring lock: ${output}`));
        }
      });
    });
  }

  it("waits for the lock and then succeeds when writing to the same file", async () => {
    db = new Db(dbPath);
    db.raw.exec("CREATE TABLE items (id TEXT PRIMARY KEY);");

    const holdMs = 300;
    const cp = await lockDbInChild(dbPath, holdMs);

    const start = Date.now();
    db.write("INSERT INTO items VALUES ('a');");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(db.all("SELECT * FROM items")).toEqual([{ id: "a" }]);

    db.close();
    db = undefined;
    await killChild(cp);
  });

  it("throws database is locked when busy_timeout is shorter than the hold time", async () => {
    db = new Db(dbPath);
    db.raw.exec("CREATE TABLE items (id TEXT PRIMARY KEY);");

    // Lower the busy timeout so it gives up quickly
    db.raw.exec("PRAGMA busy_timeout = 100;");

    // Hold far longer than the timeout: the child's clock starts when it takes the lock, and on a
    // slow runner the parent can take hundreds of ms to see "locked" and try its write.
    const holdMs = 5000;
    const cp = await lockDbInChild(dbPath, holdMs);

    expect(() => {
      db!.write("INSERT INTO items VALUES ('b');");
    }).toThrow(/database is locked/);

    db.close();
    db = undefined;
    await killChild(cp);
  });
});
