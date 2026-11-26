import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

describe("bounded SQLite prepared statement cache", () => {
  it("evicts least-recently-used statements while preserving hot entries", () => {
    const db = new Db(":memory:", []);
    try {
      const cache = (db as unknown as { statements: Map<string, unknown> }).statements;
      db.get("SELECT 0 AS value");
      const hot = cache.get("SELECT 0 AS value");
      for (let i = 1; i <= 199; i++) db.get(`SELECT ${i} AS value`);
      expect(cache.size).toBe(200);
      db.get("SELECT 0 AS value");
      db.get("SELECT 200 AS value");
      expect(cache.size).toBe(200);
      expect(cache.get("SELECT 0 AS value")).toBe(hot);
      expect(cache.has("SELECT 1 AS value")).toBe(false);
      expect(db.get<{ value: number }>("SELECT 1 AS value")?.value).toBe(1);
      for (let i = 201; i <= 400; i++) db.get(`SELECT ${i} AS value`);
      expect(cache.size).toBe(200);
    } finally {
      db.close();
    }
    expect((db as unknown as { statements: Map<string, unknown> }).statements.size).toBe(0);
  });
});
