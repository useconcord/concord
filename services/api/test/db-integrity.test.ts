import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { fileStore } from "../src/tenants.js";

describe("database integrity at startup", () => {
  it("reports a corrupt on-disk file with its exact path", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-broken-db-"));
    const path = join(dir, "truncated.db");
    try {
      writeFileSync(path, Buffer.alloc(4096, 0xff));
      expect(() => new Db(path, [])).toThrow(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports foreign-key violations and accepts healthy workspace files", () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-db-check-"));
    try {
      const path = join(dir, "control.db");
      const db = new Db(path, ["CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER, parent INTEGER REFERENCES parent(id));"]);
      expect(() => db.check()).not.toThrow();
      db.raw.exec("PRAGMA foreign_keys = OFF");
      db.raw.exec("INSERT INTO child VALUES (1, 999)");
      db.raw.exec("PRAGMA foreign_keys = ON");
      expect(() => db.check()).toThrow(path);
      db.close();

      const store = fileStore(dir, { checkOnOpen: true });
      const workspace = store.open("deadbeefdeadbeef");
      expect(() => workspace.check()).not.toThrow();
      workspace.close();
      expect(loadConfig({ CONCORD_CHECK_ON_OPEN: "yes" }).checkOnOpen).toBe(true);
      expect(loadConfig({}).checkOnOpen).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
