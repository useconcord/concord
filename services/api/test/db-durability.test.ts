import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { fileStore } from "../src/tenants.js";

describe("SQLite WAL durability configuration", () => {
  it("uses NORMAL by default and FULL when requested on file databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-wal-durability-"));
    try {
      const normal = new Db(join(dir, "normal.db"), []);
      expect(normal.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(1);
      expect(normal.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
      normal.close();
      const full = new Db(join(dir, "full.db"), [], "full");
      expect(full.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
      full.close();
      const store = fileStore(dir, "full");
      const workspace = store.open("deadbeefdeadbeef");
      expect(workspace.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
      workspace.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts only normal or full, defaulting to normal", () => {
    expect(loadConfig({}).sqliteSynchronous).toBe("normal");
    expect(loadConfig({ CONCORD_SQLITE_SYNCHRONOUS: "full" }).sqliteSynchronous).toBe("full");
    expect(() => loadConfig({ CONCORD_SQLITE_SYNCHRONOUS: "OFF" })).toThrow(/CONCORD_SQLITE_SYNCHRONOUS/);
    expect(() => loadConfig({ CONCORD_SQLITE_SYNCHRONOUS: "2" })).toThrow(/CONCORD_SQLITE_SYNCHRONOUS/);
  });
});
