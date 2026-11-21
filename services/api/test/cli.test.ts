import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Auth } from "../src/auth.js";
import { runCli } from "../src/cli.js";
import { NotFound } from "../src/concord.js";
import { loadConfig } from "../src/config.js";
import { openRuntime } from "../src/main.js";
import { FAST, at, key } from "./helpers.js";

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
