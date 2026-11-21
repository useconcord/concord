import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openRuntime } from "../src/main.js";

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("CLI register source basename (#535)", { timeout: 30_000 }, () => {
  let dataDir: string;
  let orgId: string;
  const assetCode = "TEST";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "concord-cli-test-"));
    const config = loadConfig({ CONCORD_DATA_DIR: dataDir });
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

  afterAll(() => {
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Ignore file lock release delay on Windows
      }
    }
  });

  function run(args: string[]): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, [tsx, cliPath, ...args], {
        env: {
          ...process.env,
          CONCORD_DATA_DIR: dataDir,
          CONCORD_ORG: orgId,
        },
        encoding: "utf8",
      });
      return { stdout, status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number; message?: string };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  it("stores only the file name as source when importing via register command", () => {
    const subDir = join(dataDir, "deep", "nested", "path");
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, "my_custom_register.csv");
    const csvContent =
      "holder_id,account,units,status\nH1,GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,100,active\n";
    writeFileSync(filePath, csvContent, "utf8");

    const res = run(["register", assetCode, filePath, "--as-of", "2026-10-01T00:00:00Z"]);
    expect(res.status).toBe(0);

    const config = loadConfig({ CONCORD_DATA_DIR: dataDir });
    const runtime = openRuntime(config);
    const concord = runtime.tenants.forOrg(orgId);
    const registers = concord.db.all<{ source: string }>(
      "SELECT source FROM registers WHERE asset_id = ? ORDER BY id DESC",
      assetCode,
    );
    runtime.close();

    expect(registers.length).toBeGreaterThan(0);
    expect(registers[0].source).toBe("my_custom_register.csv");
  });
});
