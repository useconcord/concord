import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import type { Networks } from "../src/concord.js";
import { Db } from "../src/db.js";
import { CONTROL_MIGRATIONS } from "../src/schema.js";
import { Tenants, fileStore } from "../src/tenants.js";
import { FAST, FakeChain, PASSPHRASE } from "./helpers.js";

const API_DIR = join(import.meta.dirname, "..");
const CLI = join(API_DIR, "src", "cli.ts");

interface Seeded {
  dir: string;
  orgId: string;
  asset: string;
}

/** A real data directory on disk: control.db with one workspace watching one asset. */
async function seed(): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), "concord-cli-"));
  const control = new Db(join(dir, "control.db"), CONTROL_MIGRATIONS);
  const auth = new Auth(control, { signup: "open", cost: FAST });
  const networks: Networks = { testnet: { passphrase: PASSPHRASE, chain: new FakeChain() } };
  const tenants = new Tenants(
    fileStore(dir),
    networks,
    (id) => auth.orgExists(id),
    () => auth.orgIds(),
  );
  try {
    const { orgId } = await auth.signUp({
      email: "cli@concord.test",
      name: "CLI User",
      password: "correct horse battery",
      orgName: "CLI Workspace",
    });
    const asset = StrKey.encodeContract(Buffer.alloc(32, 7));
    await tenants.forOrg(orgId).watchAsset(
      { network: "testnet", asset, decimals: 7 },
      { actor: { id: "test", label: "test" } },
    );
    return { dir, orgId, asset };
  } finally {
    tenants.close();
    control.close();
  }
}

/** The CLI in a child process, so the process exit is the one the operator would see. */
function cli(seeded: Seeded, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Host settings this machine may carry must not leak into the CLI's configuration.
    if (name.startsWith("CONCORD_") || name === "PORT" || name === "RENDER_EXTERNAL_URL") continue;
    env[name] = value;
  }
  env.CONCORD_DATA_DIR = seeded.dir;
  env.CONCORD_ORG = seeded.orgId;
  // Bun runs TypeScript itself; Node needs tsx, which is a devDependency here.
  const argv = process.versions.bun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args];
  const result = spawnSync(process.execPath, argv, { cwd: API_DIR, env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** SQLite deletes -wal and -shm when the last connection closes; anything left means one did not. */
function sidecars(dir: string): string[] {
  const files = [join(dir, "control.db")];
  const orgs = join(dir, "orgs");
  if (existsSync(orgs)) for (const name of readdirSync(orgs)) files.push(join(orgs, name));
  return files.flatMap((file) => [`${file}-wal`, `${file}-shm`]).filter(existsSync).map((file) => file.slice(dir.length + 1));
}

async function withDataDir(check: (seeded: Seeded) => void | Promise<void>): Promise<void> {
  const seeded = await seed();
  try {
    // The seed closed its own handles; if it left sidecars the check below would prove nothing.
    expect(sidecars(seeded.dir)).toEqual([]);
    await check(seeded);
  } finally {
    removeDataDir(seeded.dir);
  }
}

function removeDataDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch (err) {
    // Windows can keep a just-written database busy a moment after the child exits. The
    // assertions above have already run, so a temp directory is all that is lost.
    if (process.platform !== "win32") throw err;
  }
}

describe("the CLI closes its runtime", () => {
  it(
    "after holdings prints JSON and returns early",
    () =>
      withDataDir((seeded) => {
        const { status, stdout, stderr } = cli(seeded, ["holdings", seeded.asset, "--json"]);
        // Some Node 24 releases still flag node:sqlite as experimental on stderr; nothing else may appear.
        expect(stderr.split("\n").filter((line) => line.trim() && !/ExperimentalWarning|--trace-warnings/.test(line))).toEqual([]);
        expect(status).toBe(0);
        const holdings = JSON.parse(stdout) as { supply: string; holderCount: number; holders: unknown[] };
        expect(holdings.supply).toBe("0");
        expect(holdings.holderCount).toBe(0);
        expect(holdings.holders).toEqual([]);
        expect(sidecars(seeded.dir)).toEqual([]);
      }),
    30_000,
  );

  it(
    "after a command fails",
    () =>
      withDataDir((seeded) => {
        const { status, stdout, stderr } = cli(seeded, ["holdings", "NOT-A-WATCHED-ASSET", "--json"]);
        expect(status).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("is not watched");
        expect(sidecars(seeded.dir)).toEqual([]);
      }),
    30_000,
  );
});
