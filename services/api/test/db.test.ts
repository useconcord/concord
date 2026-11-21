import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

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

    const holdMs = 500;
    const cp = await lockDbInChild(dbPath, holdMs);

    expect(() => {
      db!.write("INSERT INTO items VALUES ('b');");
    }).toThrow(/database is locked/);

    db.close();
    db = undefined;
    await killChild(cp);
  });
});
