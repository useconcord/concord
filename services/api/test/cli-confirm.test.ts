import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { DeletionCounts } from "../src/concord.js";
import { Db } from "../src/db.js";
import { CONTROL_MIGRATIONS, ORG_MIGRATIONS } from "../src/schema.js";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(API_DIR, "src", "cli.ts");
const ORG_ID = "0123456789abcdef";
const FUND = `C${"A".repeat(55)}`;
const OTHER = `C${"B".repeat(55)}`;
const AT = "2026-01-02T00:00:00.000Z";

/** The workspace the tests delete from: two assets, with books against one of them. */
const TOTAL: DeletionCounts = { assets: 2, events: 4, registers: 2, runs: 2, notes: 1 };
const FUND_ONLY: DeletionCounts = { assets: 1, events: 3, registers: 2, runs: 2, notes: 1 };

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tenantPath(dir: string): string {
  return join(dir, "orgs", `${ORG_ID}.db`);
}

/** An org in control.db and a workspace database with assets, events, registers, runs and a note. */
function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), "concord-cli-"));
  dirs.push(dir);
  const control = new Db(join(dir, "control.db"), CONTROL_MIGRATIONS);
  control.insert("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)", ORG_ID, "Alpha Capital", AT);
  control.close();

  const db = new Db(tenantPath(dir), ORG_MIGRATIONS);
  db.insert(
    "INSERT INTO assets (id, network, code, name, decimals, start_mode, created_at) VALUES (?, 'testnet', ?, ?, 7, 'window', ?)",
    FUND,
    "FUND",
    "Fund",
    AT,
  );
  db.insert(
    "INSERT INTO assets (id, network, code, name, decimals, start_mode, created_at) VALUES (?, 'testnet', ?, ?, 7, 'window', ?)",
    OTHER,
    "OTHER",
    "Other",
    AT,
  );
  const event = (assetId: string, id: string, ledger: number) =>
    db.insert(
      "INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, amount) VALUES (?, ?, 'mint', ?, ?, ?, '10000000')",
      id,
      assetId,
      ledger,
      AT,
      `tx-${id}`,
    );
  event(FUND, "fund-1", 1);
  event(FUND, "fund-2", 2);
  event(FUND, "fund-3", 3);
  event(OTHER, "other-1", 4);

  let registerId = 0;
  for (const [n, asOf] of [AT, "2026-01-03T00:00:00.000Z"].entries()) {
    registerId = db.insert(
      "INSERT INTO registers (asset_id, as_of, source, sha256, issues, imported_at) VALUES (?, ?, 'test', ?, '[]', ?)",
      FUND,
      asOf,
      `sha-${n}`,
      AT,
    );
  }
  for (const id of [registerId, registerId]) {
    db.insert(
      "INSERT INTO runs (asset_id, register_id, as_of, created_at, result) VALUES (?, ?, ?, ?, '{\"breaks\":[]}')",
      FUND,
      id,
      AT,
      AT,
    );
  }
  db.insert(
    "INSERT INTO break_notes (asset_id, scope, key, fingerprint, status, note, updated_at) VALUES (?, 'recon', 'k', 'f', 'acknowledged', 'checked', ?)",
    FUND,
    AT,
  );
  db.close();
  return dir;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The CLI with no terminal on stdin, as a cron job or a script would run it. */
function cli(dir: string, args: string[]): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: API_DIR,
    env: { ...process.env, CONCORD_DATA_DIR: dir, CONCORD_SYNC_INTERVAL: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function counts(dir: string): DeletionCounts {
  const db = new Db(tenantPath(dir), ORG_MIGRATIONS);
  const count = (table: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
  const out: DeletionCounts = {
    assets: count("assets"),
    events: count("events"),
    registers: count("registers"),
    runs: count("runs"),
    notes: count("break_notes"),
  };
  db.close();
  return out;
}

function parseCounts(run: Run): DeletionCounts {
  return JSON.parse(run.stdout) as DeletionCounts;
}

describe("unwatch needs confirmation", () => {
  it("refuses without --yes, deletes nothing and shows the counts", () => {
    const dir = seed();
    const run = cli(dir, ["unwatch", "FUND", "--org", ORG_ID, "--json"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--yes");
    expect(parseCounts(run)).toEqual(FUND_ONLY);
    expect(counts(dir)).toEqual(TOTAL);
  });

  it("--dry-run prints the counts and exits 0 without deleting", () => {
    const dir = seed();
    const run = cli(dir, ["unwatch", "FUND", "--org", ORG_ID, "--json", "--dry-run"]);
    expect(run.status).toBe(0);
    expect(parseCounts(run)).toEqual(FUND_ONLY);
    expect(counts(dir)).toEqual(TOTAL);
  });

  it("--yes deletes the asset and its books", () => {
    const dir = seed();
    const run = cli(dir, ["unwatch", "FUND", "--org", ORG_ID, "--yes"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("stopped watching");
    expect(counts(dir)).toEqual({ assets: 1, events: 1, registers: 0, runs: 0, notes: 0 });
  });
});

describe("org-delete needs confirmation", () => {
  it("refuses without --yes, deletes nothing and shows the counts", () => {
    const dir = seed();
    const run = cli(dir, ["org-delete", ORG_ID, "--json"]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--yes");
    expect(parseCounts(run)).toEqual(TOTAL);
    expect(existsSync(tenantPath(dir))).toBe(true);
    const control = new Db(join(dir, "control.db"), CONTROL_MIGRATIONS);
    expect(control.get("SELECT id FROM orgs WHERE id = ?", ORG_ID)).toBeDefined();
    control.close();
  });

  it("--dry-run prints the counts and exits 0 without deleting", () => {
    const dir = seed();
    const run = cli(dir, ["org-delete", ORG_ID, "--json", "--dry-run"]);
    expect(run.status).toBe(0);
    expect(parseCounts(run)).toEqual(TOTAL);
    expect(existsSync(tenantPath(dir))).toBe(true);
  });

  it("--yes deletes the workspace and its database", () => {
    const dir = seed();
    const run = cli(dir, ["org-delete", ORG_ID, "--yes"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`deleted Alpha Capital (${ORG_ID})`);
    expect(existsSync(tenantPath(dir))).toBe(false);
    const control = new Db(join(dir, "control.db"), CONTROL_MIGRATIONS);
    expect(control.get("SELECT id FROM orgs WHERE id = ?", ORG_ID)).toBeUndefined();
    control.close();
  });
});
