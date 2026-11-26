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
import { execFileSync } from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Auth } from "../src/auth.js";
import { runCli } from "../src/cli.js";
import { CLI_OPTIONS, closestFlag, describeArgsError } from "../src/cli-usage.js";
import { NotFound } from "../src/concord.js";
import { loadConfig, type Config } from "../src/config.js";
import { openRuntime } from "../src/main.js";
import { FAST, at, key } from "./helpers.js";

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** What the CLI prints for a command line parseArgs refuses. */
function refusal(args: string[]): string | undefined {
  try {
    parseArgs({ args, allowPositionals: true, options: CLI_OPTIONS });
  } catch (err) {
    return describeArgsError(err, args);
  }
  throw new Error(`parseArgs accepted ${args.join(" ")}`);
}

describe("closestFlag", () => {
  it("suggests the flag a typo most likely meant", () => {
    expect(closestFlag("netwrk")).toBe("network");
    expect(closestFlag("asof")).toBe("as-of");
    expect(closestFlag("jsno")).toBe("json");
    expect(closestFlag("NETWORK")).toBe("network");
    expect(closestFlag("no-basline")).toBe("no-baseline");
  });

  it("suggests the only flag that starts with what was typed", () => {
    expect(closestFlag("dec")).toBe("decimals");
    expect(closestFlag("pay-")).toBe("pay-asset");
  });

  it("picks the nearest of several candidates", () => {
    expect(closestFlag("rato", ["rate", "ratio", "register"])).toBe("rate");
    expect(closestFlag("ratioo", ["rate", "ratio", "register"])).toBe("ratio");
  });

  it("suggests nothing when no flag is close", () => {
    expect(closestFlag("bogus")).toBeUndefined();
    expect(closestFlag("x")).toBeUndefined();
    expect(closestFlag("frobnicate")).toBeUndefined();
    // Shared by more than one flag, so no prefix suggestion either.
    expect(closestFlag("pa")).toBeUndefined();
  });
});

describe("describeArgsError", () => {
  const hint = "Run 'concord --help' for usage.";

  it("names an unknown flag, with a suggestion when one is close", () => {
    expect(refusal(["holdings", "X", "--bogus", "1"])).toBe(`unknown option '--bogus'. ${hint}`);
    expect(refusal(["holdings", "X", "--asof", "2026-10-01"])).toBe(
      `unknown option '--asof'. Did you mean '--as-of'? ${hint}`,
    );
    expect(refusal(["holdings", "X", "--netwrk=testnet"])).toBe(
      `unknown option '--netwrk'. Did you mean '--network'? ${hint}`,
    );
    expect(refusal(["assets", "-z"])).toBe(`unknown option '-z'. ${hint}`);
  });

  it("says when a flag is missing its value or has one it does not take", () => {
    expect(refusal(["holdings", "X", "--as-of"])).toBe(`option '--as-of' needs a value. ${hint}`);
    expect(refusal(["holdings", "X", "--org", "--json"])).toBe(
      `option '--org' needs a value, not '--json' (write --org=--json if that is the value). ${hint}`,
    );
    expect(refusal(["assets", "--json=yes"])).toBe(`option '--json' does not take a value. ${hint}`);
  });

  it("is one line and never Node's own wording", () => {
    for (const args of [
      ["x", "--bogus"],
      ["x", "--org"],
      ["x", "--org", "-y"],
      ["x", "--yes=1"],
    ]) {
      const message = refusal(args)!;
      expect(message).not.toContain("\n");
      expect(message).not.toMatch(/To specify|ambiguous|argument missing/);
      expect(message.endsWith(hint)).toBe(true);
    }
  });

  it("leaves errors that are not parseArgs refusals to the caller", () => {
    expect(describeArgsError(new Error("database is locked"), ["assets"])).toBeUndefined();
    expect(describeArgsError(Object.assign(new Error("x"), { code: "ENOENT" }), ["assets"])).toBeUndefined();
    expect(describeArgsError(undefined, ["assets"])).toBeUndefined();
  });
});

describe("CLI usage errors", { timeout: 30_000 }, () => {
  it("prints one line to stderr and exits 1 for an unknown flag", () => {
    const res = spawnSync(process.execPath, [tsx, cliPath, "holdings", "X", "--netwrk", "testnet"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    const lines = res.stderr
      .split(/\r?\n/)
      .filter((line) => line && !/ExperimentalWarning|--trace-warnings/.test(line));
    expect(lines).toEqual(["unknown option '--netwrk'. Did you mean '--network'? Run 'concord --help' for usage."]);
  });

  it("still prints the usage text for --help", () => {
    const res = spawnSync(process.execPath, [tsx, cliPath, "--help"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("concord — reconcile tokenized securities");
  });
});

describe("CLI registers and register-delete", { timeout: 30_000 }, () => {
  let dataDir: string;
  let orgId: string;
  let config: Config;
  const assetCode = "TEST";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "concord-cli-test-"));
    config = loadConfig({ CONCORD_DATA_DIR: dataDir });
    const runtime = openRuntime(config);
    const { orgId: newOrgId } = await runtime.auth.signUp({
      email: "user@example.test",
      name: "Test User",
      password: "Password123!",
      orgName: "Test Org",
    });
    orgId = newOrgId;

    const concord = runtime.tenants.forOrg(orgId);
    concord.db.insert(
      `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assetCode,
      "testnet",
      assetCode,
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "Test Asset",
      7,
      "ledger",
      "ready",
      "2026-10-01T00:00:00Z",
    );
    runtime.close();
  });

  beforeEach(async () => {
    const runtime = openRuntime(config);
    const concord = runtime.tenants.forOrg(orgId);
    concord.db.raw.exec("DELETE FROM runs; DELETE FROM registers; DELETE FROM register_positions;");

    const csv1 = "holder_id,account,units,status\nH1,GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,100,active\n";
    const reg1 = concord.importRegister(
      assetCode,
      { csv: csv1, asOf: "2026-10-01T00:00:00.000Z", source: "reg1.csv" },
      { id: "u1", label: "admin <admin@example.test>" },
    );
    await concord.reconcile(assetCode, reg1.registerId);

    const csv2 = "holder_id,account,units,status\nH1,GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,90,active\n";
    const reg2 = concord.importRegister(assetCode, { csv: csv2, asOf: "2026-10-02T00:00:00.000Z", source: "reg2.csv" });
    await concord.reconcile(assetCode, reg2.registerId);

    runtime.close();
  });

  afterAll(() => {
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Ignore file lock release delay on Windows
      }
    }
  });

  function run(args: string[], stdin?: string): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, [tsx, cliPath, ...args], {
        env: {
          ...process.env,
          CONCORD_DATA_DIR: dataDir,
          CONCORD_ORG: orgId,
        },
        input: stdin,
        encoding: "utf8",
      });
      return { stdout, status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number; message?: string };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  it("lists imported registers in table format and json format", () => {
    // 1. Table format
    const resTable = run(["registers", assetCode]);
    expect(resTable.status).toBe(0);
    expect(resTable.stdout).toContain("as-of");
    expect(resTable.stdout).toContain("rejected rows");
    expect(resTable.stdout).toContain("reg1.csv");
    expect(resTable.stdout).toContain("reg2.csv");
    expect(resTable.stdout).toContain("admin <admin@example.test>");

    // 2. JSON format
    const resJson = run(["registers", assetCode, "--json"]);
    expect(resJson.status).toBe(0);
    const parsed = JSON.parse(resJson.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      source: "reg2.csv",
      positions: 1,
    });
    expect(parsed[1]).toMatchObject({
      source: "reg1.csv",
      importedBy: "admin <admin@example.test>",
    });
  });

  it("supports aborting register deletion without --yes", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Run without --yes and input 'n'
    const resAbort = run(["register-delete", assetCode, String(regId)], "n\n");
    expect(resAbort.stdout).toContain("aborted");

    // Verify it was NOT deleted
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(2);
  });

  it("confirms and deletes when 'y' is answered to prompt", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Run without --yes and input 'y'
    const resConfirm = run(["register-delete", assetCode, String(regId)], "y\n");
    expect(resConfirm.status).toBe(0);
    expect(resConfirm.stdout).toContain(`deleted register ${regId}`);

    // Verify it is deleted
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].id).not.toBe(regId);
  });

  it("deletes a register with --yes and reports how many runs went with it", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Delete with --yes
    const resDel = run(["register-delete", assetCode, String(regId), "--yes"]);
    expect(resDel.status).toBe(0);
    expect(resDel.stdout).toContain(`deleted register ${regId} (1 reconciliation run removed)`);

    // Verify it is gone from the list
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].id).not.toBe(regId);
  });

  it("fails cleanly when deleting a nonexistent register", () => {
    const res = run(["register-delete", assetCode, "99999", "--yes"]);
    expect(res.status).not.toBe(0);
  });
});

describe("CLI runs and run commands", () => {
  it("lists reconciliation history with runs, respects --limit, shows run details, and exits 1 on unknown run id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-cli-555-"));
    try {
      const issuer = key();
      const holder = key();
      let orgId: string;
      let run1Id: number;
      let run2Id: number;

      const rt = openRuntime(loadConfig({ CONCORD_DATA_DIR: dir, CONCORD_SIGNUP: "open" }));
      try {
        const fastAuth = new Auth(rt.control, { signup: "open", cost: FAST });
        const signed = await fastAuth.signUp({
          email: "runs-cli@example.test",
          name: "CLI Operator",
          orgName: "Runs Org",
          password: "correct horse battery",
        });
        orgId = signed.orgId;
        const ws = rt.tenants.forOrg(orgId);
        ws.db.insert(
          `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, synced_at, synced_ledger, created_at)
           VALUES ('CASSETRUN', 'testnet', 'FUND', ?, 'Fund', 7, 'window', 'ready', ?, 20, ?)`,
          issuer,
          at(20),
          at(1),
        );
        const reg1 = ws.importRegister("FUND", {
          csv: `holder_id,account,units\nH1,${holder},0\n`,
          asOf: at(5),
        });
        const reg2 = ws.importRegister("FUND", {
          csv: `holder_id,account,units\nH1,${holder},0\n`,
          asOf: at(10),
        });
        const r1 = await ws.reconcile("FUND", reg1.registerId);
        const r2 = await ws.reconcile("FUND", reg2.registerId);
        run1Id = r1.id;
        run2Id = r2.id;
      } finally {
        rt.close();
      }

      const execCli = async (args: string[]) => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => lines.push(String(msg ?? "")));
        try {
          await runCli(args, { CONCORD_DATA_DIR: dir, CONCORD_ORG: orgId });
          return lines.join("\n");
        } finally {
          spy.mockRestore();
        }
      };

      const allRuns = JSON.parse(await execCli(["runs", "FUND", "--json"])) as Array<Record<string, unknown>>;
      expect(allRuns).toHaveLength(2);
      expect(allRuns[0]).toMatchObject({
        id: run2Id,
        asOf: at(10),
        status: "clean",
        openBreaks: 0,
      });
      expect(allRuns[0]).toHaveProperty("createdAt");
      expect(allRuns[0]).toHaveProperty("chainBehind");
      expect(allRuns[0]).toHaveProperty("summary");

      const limited = JSON.parse(await execCli(["runs", "FUND", "--limit", "1", "--json"])) as Array<Record<string, unknown>>;
      expect(limited).toHaveLength(1);
      expect(limited[0]!.id).toBe(run2Id);

      const shown = JSON.parse(await execCli(["run", String(run1Id), "--json"])) as Record<string, unknown>;
      expect(shown).toMatchObject({
        id: run1Id,
        asOf: at(5),
        status: "clean",
        openBreaks: 0,
      });
      expect(shown).toHaveProperty("breaks");
      expect(shown).toHaveProperty("lines");

      await expect(execCli(["run", "999999", "--json"])).rejects.toThrow(NotFound);
      await expect(execCli(["run", "999999", "--json"])).rejects.toThrow("reconciliation 999999 not found");

      const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
      const cliEntry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
      const proc = spawnSync(process.execPath, [tsxCli, cliEntry, "run", "999999"], {
        env: { ...process.env, CONCORD_DATA_DIR: dir, CONCORD_ORG: orgId },
        encoding: "utf8",
      });
      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain("reconciliation 999999 not found");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 15_000);
});
