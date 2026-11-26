import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USAGE } from "../src/cli-usage.js";
import { Concord } from "../src/concord.js";
import { Db } from "../src/db.js";
import { CONTROL_MIGRATIONS, ORG_MIGRATIONS } from "../src/schema.js";

const distCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const srcCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}) {
  const runner = existsSync(distCli) ? [distCli, ...args] : [tsx, srcCli, ...args];
  try {
    const stdout = execFileSync(process.execPath, runner, {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: e.status ?? 1,
      stdout: (e.stdout ?? "").toString(),
      stderr: (e.stderr ?? "").toString(),
    };
  }
}

describe("CLI --fail-on-breaks and exit codes", { timeout: 30_000 }, () => {
  let tempDir: string;
  let cleanCsv: string;
  let breaksCsv: string;
  const orgId = "0123456789abcdef";
  const orgName = "Test Workspace";
  const assetCode = "FUND";
  const assetId = "FUND:GISSUER1234567890123456789012345678901234567890123456";
  const holder = "GACCOUNT111111111111111111111111111111111111111111111111";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concord-cli-test-"));
    mkdirSync(join(tempDir, "orgs"), { recursive: true });

    // Initialize control DB with workspace
    const control = new Db(join(tempDir, "control.db"), CONTROL_MIGRATIONS);
    control.write(
      "INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)",
      orgId,
      orgName,
      "2026-10-01T00:00:00Z",
    );
    control.close();

    // Initialize org DB with asset and event history
    const orgDb = new Db(join(tempDir, "orgs", `${orgId}.db`), ORG_MIGRATIONS);
    orgDb.write(
      "INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, start_ledger, synced_ledger, synced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      assetId,
      "testnet",
      assetCode,
      "GISSUER1234567890123456789012345678901234567890123456",
      "Fund Asset",
      7,
      "ledger",
      "ready",
      1,
      100,
      "2026-10-01T01:00:00Z",
      "2026-10-01T00:00:00Z",
    );
    // Mint 100 units to holder (100 * 10^7 = 1_000_000_000n)
    orgDb.write(
      "INSERT INTO events (id, asset_id, kind, ledger, closed_at, to_addr, amount, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "0000000000000000001-0000000001",
      assetId,
      "mint",
      10,
      "2026-10-01T00:10:00Z",
      holder,
      "1000000000",
      "tx1",
    );
    orgDb.close();

    // Prepare CSV fixtures
    cleanCsv = join(tempDir, "clean.csv");
    writeFileSync(cleanCsv, `holder_id,account,units\nA,${holder},100\n`);

    breaksCsv = join(tempDir, "breaks.csv");
    writeFileSync(breaksCsv, `holder_id,account,units\nA,${holder},90\n`);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function setupRegister(file: string, asOf: string) {
    const orgDb = new Db(join(tempDir, "orgs", `${orgId}.db`), ORG_MIGRATIONS);
    const concord = new Concord(orgDb, {});
    concord.importRegister(assetCode, {
      csv: readFileSync(file, "utf8"),
      asOf,
      source: file,
    });
    orgDb.close();
  }

  it("documents exit codes 0, 1, 2 and --fail-on-breaks in --help", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--fail-on-breaks");
    expect(res.stdout).toMatch(/exit codes?:\s*0.*1.*2/i);

    // Also assert USAGE string directly
    expect(USAGE).toContain("--fail-on-breaks");
    expect(USAGE).toMatch(/exit codes?:\s*0.*1.*2/i);
  });

  it("exits 1 on command errors", () => {
    const resUnknown = runCli(["non-existent-command"], { CONCORD_DATA_DIR: tempDir });
    expect(resUnknown.status).toBe(1);

    const resMissingOrg = runCli(["reconcile", assetCode], {
      CONCORD_DATA_DIR: tempDir,
      CONCORD_ORG: "",
    });
    expect(resMissingOrg.status).toBe(1);
  });

  describe("register", () => {
    it("exits 0 on clean import without --fail-on-breaks", () => {
      const res = runCli(
        ["register", assetCode, cleanCsv, "--as-of", "2026-10-01T00:20:00Z"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("CLEAN");
    });

    it("exits 0 on clean import with --fail-on-breaks", () => {
      const res = runCli(
        ["register", assetCode, cleanCsv, "--as-of", "2026-10-01T00:20:00Z", "--fail-on-breaks"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("CLEAN");
    });

    it("exits 0 on breaks when --fail-on-breaks is not passed", () => {
      const res = runCli(
        ["register", assetCode, breaksCsv, "--as-of", "2026-10-01T00:20:00Z"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("BREAKS");
    });

    it("exits 2 on open breaks when --fail-on-breaks is passed", () => {
      const res = runCli(
        ["register", assetCode, breaksCsv, "--as-of", "2026-10-01T00:20:00Z", "--fail-on-breaks"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(res.status).toBe(2);
      expect(res.stdout).toContain("BREAKS");
    });

    it("exits 2 on duplicate register import when previous run had open breaks and --fail-on-breaks is passed", () => {
      // First import (creates run with breaks)
      const first = runCli(
        ["register", assetCode, breaksCsv, "--as-of", "2026-10-01T00:20:00Z"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(first.status).toBe(0);

      // Re-upload identical file and as-of time with --fail-on-breaks
      const duplicate = runCli(
        ["register", assetCode, breaksCsv, "--as-of", "2026-10-01T00:20:00Z", "--fail-on-breaks"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(duplicate.status).toBe(2);
      expect(duplicate.stdout).toContain("already imported");
      expect(duplicate.stdout).toContain("BREAKS");
    });
  });

  describe("reconcile", () => {
    it("exits 0 on clean reconciliation with --fail-on-breaks", () => {
      setupRegister(cleanCsv, "2026-10-01T00:20:00Z");

      const res = runCli(
        ["reconcile", assetCode, "--fail-on-breaks"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("CLEAN");
    });

    it("exits 0 on breaks without --fail-on-breaks", () => {
      setupRegister(breaksCsv, "2026-10-01T00:20:00Z");

      const res = runCli(
        ["reconcile", assetCode],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("BREAKS");
    });

    it("exits 2 on open breaks with --fail-on-breaks", () => {
      setupRegister(breaksCsv, "2026-10-01T00:20:00Z");

      const res = runCli(
        ["reconcile", assetCode, "--fail-on-breaks"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(res.status).toBe(2);
      expect(res.stdout).toContain("BREAKS");
    });

    it("exits 0 with --fail-on-breaks when breaks are signed off", async () => {
      setupRegister(breaksCsv, "2026-10-01T00:20:00Z");

      // Verify that before signing off, it exits 2
      const beforeSignoff = runCli(
        ["reconcile", assetCode, "--fail-on-breaks"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(beforeSignoff.status).toBe(2);

      // Sign off all breaks using Concord instance
      const orgDb = new Db(join(tempDir, "orgs", `${orgId}.db`), ORG_MIGRATIONS);
      const concord = new Concord(orgDb, {});
      const latestRun = concord.latestRun(assetId);
      expect(latestRun).not.toBeNull();
      expect(latestRun!.breaks.length).toBeGreaterThan(0);

      for (const targetBreak of latestRun!.breaks) {
        concord.setNote(
          assetCode,
          "recon",
          targetBreak.key,
          {
            status: "acknowledged",
            note: "Known discrepancy pending settlement",
            fingerprint: targetBreak.fingerprint,
          },
          { id: "cli", label: "cli:auditor" },
        );
      }
      orgDb.close();

      // Now with all breaks signed off, openBreaks is 0 -> exits 0
      const afterSignoff = runCli(
        ["reconcile", assetCode, "--fail-on-breaks"],
        { CONCORD_DATA_DIR: tempDir, CONCORD_ORG: orgName },
      );
      expect(afterSignoff.status).toBe(0);
      expect(afterSignoff.stdout).toContain("acknowledged");
    });
  });
});
