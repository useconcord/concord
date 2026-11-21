import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openRuntime } from "../src/main.js";
import { loadConfig, type Config } from "../src/config.js";
import { verifyBackupFile } from "../src/cli.js";

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("CLI backup and restore", { timeout: 30_000 }, () => {
  let liveDataDir: string;
  let backupDir: string;
  let orgId: string;
  let config: Config;

  function run(args: string[]): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, [tsx, cliPath, ...args], {
        env: {
          ...process.env,
          CONCORD_DATA_DIR: liveDataDir,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
    }
  }

  beforeAll(async () => {
    liveDataDir = mkdtempSync(join(tmpdir(), "concord-live-"));
    backupDir = mkdtempSync(join(tmpdir(), "concord-backup-"));

    config = loadConfig({ CONCORD_DATA_DIR: liveDataDir });
    const runtime = openRuntime(config);
    const { orgId: newOrgId } = await runtime.auth.signUp({
      email: "operator@example.test",
      name: "Operator",
      password: "Password123!",
      orgName: "Operator Workspace",
    });
    orgId = newOrgId;

    const concord = runtime.tenants.forOrg(orgId);
    concord.db.insert(
      `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "ASSET1",
      "testnet",
      "ASSET1",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "Asset One",
      7,
      "ledger",
      "ready",
      "2026-10-01T00:00:00Z",
    );
    runtime.close();

    const initialBackup = run(["backup", backupDir, "--verify"]);
    if (initialBackup.status !== 0) {
      throw new Error(`Initial backup failed: ${initialBackup.stderr}`);
    }
  }, 30_000);

  afterAll(() => {
    for (const d of [liveDataDir, backupDir]) {
      try {
        if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
      } catch {
        // Ignore file lock release delay on Windows
      }
    }
  });

  it("creates a verified backup with backup --verify", () => {
    const testBackupDir = mkdtempSync(join(tmpdir(), "concord-test-backup-"));
    try {
      const res = run(["backup", testBackupDir, "--verify"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`backed up control.db and 1 workspaces to ${testBackupDir}`);
      expect(existsSync(join(testBackupDir, "control.db"))).toBe(true);
      expect(existsSync(join(testBackupDir, "orgs", `${orgId}.db`))).toBe(true);
    } finally {
      try {
        rmSync(testBackupDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("reports a corrupted backup with the file name when integrity or version fails", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "concord-corrupt-test-"));
    try {
      const corruptFile = join(tempDir, "corrupt.db");
      writeFileSync(corruptFile, "not a valid sqlite database");
      expect(() => verifyBackupFile(corruptFile, 1)).toThrow(/corrupted backup: .*corrupt\.db/);

      const validControl = join(backupDir, "control.db");
      expect(() => verifyBackupFile(validControl, 9999)).toThrow(
        /corrupted backup: .*control\.db.*user_version mismatch/,
      );
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("refuses to restore into a non-empty directory without --force", () => {
    const nonEmptydir = mkdtempSync(join(tmpdir(), "concord-nonempty-"));
    try {
      writeFileSync(join(nonEmptydir, "dummy.txt"), "dummy content");
      const res = run(["restore", backupDir, "--into", nonEmptydir]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("destination directory");
      expect(res.stderr).toContain("is not empty; pass --force to overwrite");
    } finally {
      try {
        rmSync(nonEmptydir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("restores into an empty directory and yields a working server", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "concord-empty-"));
    try {
      const res = run(["restore", backupDir, "--into", emptyDir]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`restored backup from ${backupDir} into ${emptyDir}`);

      // Verify restored server works
      const restoredConfig = loadConfig({ CONCORD_DATA_DIR: emptyDir });
      const restoredRuntime = openRuntime(restoredConfig);
      try {
        expect(restoredRuntime.auth.orgIds()).toContain(orgId);
        const concord = restoredRuntime.tenants.forOrg(orgId);
        expect(concord.asset("ASSET1")).toMatchObject({
          code: "ASSET1",
          network: "testnet",
        });
      } finally {
        restoredRuntime.close();
      }
    } finally {
      try {
        rmSync(emptyDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("restores into a non-empty directory when --force is passed", () => {
    const overwriteDir = mkdtempSync(join(tmpdir(), "concord-overwrite-"));
    try {
      writeFileSync(join(overwriteDir, "file-to-overwrite.txt"), "to overwrite");
      const res = run(["restore", backupDir, "--into", overwriteDir, "--force"]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`restored backup from ${backupDir} into ${overwriteDir}`);

      // Verify restored server works
      const restoredConfig = loadConfig({ CONCORD_DATA_DIR: overwriteDir });
      const restoredRuntime = openRuntime(restoredConfig);
      try {
        expect(restoredRuntime.auth.orgIds()).toContain(orgId);
      } finally {
        restoredRuntime.close();
      }
    } finally {
      try {
        rmSync(overwriteDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
