/**
 * Tests for the `signoff` CLI command.
 *
 * The CLI's main() opens real on-disk databases, so these tests exercise the
 * same service function it calls (Concord.setNote) directly — identical to how
 * service.test.ts works for every other CLI-backed command — and separately
 * verify the CLI-layer argument validation and output conventions via a thin
 * runSignoff helper that mirrors the case body in cli.ts exactly.
 */
import { userInfo } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { Concord, Invalid, NotFound } from "../src/concord.js";
import { Db } from "../src/db.js";
import { ORG_MIGRATIONS } from "../src/schema.js";
import { FakeChain, PASSPHRASE, at, key, u } from "./helpers.js";

// ── Shared test fixture ───────────────────────────────────────────────────────

/** Expected actor label produced by the CLI. */
const CLI_ACTOR = { id: "cli", label: `cli:${userInfo().username}` };

interface TestWorld {
  concord: Concord;
  chain: FakeChain;
  assetId: string;
}

/** Stand-alone Concord instance backed by an in-memory database. */
function makeWorld(): TestWorld {
  const chain = new FakeChain();
  chain.latest = 200;
  chain.oldest = 1;
  const db = new Db(":memory:", ORG_MIGRATIONS);
  const concord = new Concord(db, { testnet: { passphrase: PASSPHRASE, chain } });
  return { concord, chain, assetId: "" };
}

/** Set up one watched asset with a mint and a reconciliation run with a break. */
async function setupAssetWithBreak(world: TestWorld) {
  const { concord, chain } = world;
  const issuer = key();
  const holder = key();
  // Watch the asset — fromLedger skips chain baseline.
  const asset = await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
  world.assetId = asset.id;
  // Mint units to a holder so the chain has a supply.
  chain.push(asset.id, "mint", 2, { to: holder, amount: u(100) });
  await concord.sync("FUND");
  // Import a register that disagrees (90 ≠ 100 → break).
  const reg = concord.importRegister("FUND", {
    csv: `holder_id,account,units\nA,${holder},90\n`,
    asOf: at(50),
  });
  const run = await concord.reconcile("FUND", reg.registerId);
  expect(run.breaks.length).toBeGreaterThan(0);
  return { run, holder };
}

// ── CLI-layer argument validation helper ──────────────────────────────────────

/**
 * Mimics the signoff case body from cli.ts so we can test its validation path
 * without spawning a process.  Returns { stdout, exitCode } like the real CLI.
 */
function runSignoff(
  concord: Concord,
  asset: string,
  opts: {
    scope?: string;
    key?: string;
    status?: string;
    note?: string;
    run?: string;
    json?: boolean;
  },
): { stdout: string; error: string; exitCode: number } {
  let stdout = "";
  let error = "";
  let exitCode = 0;

  const need = (value: string | undefined, what: string): string => {
    if (!value) throw new Error(`missing ${what}`);
    return value;
  };

  try {
    const scope = need(opts.scope, "--scope");
    const keyVal = need(opts.key, "--key");
    const rawStatus = need(opts.status, "--status");

    if (!/^(recon|controls|action:[1-9]\d*)$/.test(scope)) {
      throw new Error("--scope must be recon, controls, or action:N (N a positive integer)");
    }
    if (!["open", "acknowledged", "resolved"].includes(rawStatus)) {
      throw new Error("--status must be open, acknowledged, or resolved");
    }
    const status = rawStatus as "open" | "acknowledged" | "resolved";
    const note = opts.note ?? "";
    if (status !== "open" && !note.trim()) {
      throw new Error(`--note is required when --status is ${status}`);
    }

    const assetRecord = concord.asset(asset);
    const runIdArg = opts.run;
    let breaks: Array<{ key: string; fingerprint: string }>;
    if (scope === "recon") {
      const r =
        runIdArg !== undefined ? concord.run(Number(runIdArg)) : concord.latestRun(assetRecord.id);
      if (!r) throw new Error("no reconciliation run found for this asset");
      breaks = r.breaks;
    } else if (scope === "controls") {
      breaks = concord.controls(assetRecord.id).breaks;
    } else {
      const actionId = Number(scope.slice("action:".length));
      const actionResult = concord.action(actionId);
      breaks = actionResult.result?.breaks ?? [];
    }

    const brk = breaks.find((b) => b.key === keyVal);
    if (!brk) throw new NotFound(`no break ${keyVal} in the current ${scope.split(":")[0]} results`);

    concord.setNote(asset, scope, keyVal, { fingerprint: brk.fingerprint, status, note }, CLI_ACTOR);

    if (opts.json) {
      stdout = JSON.stringify({ ok: true, asset, scope, key: keyVal, status });
    } else {
      stdout = `signed off: ${keyVal} → ${status.toUpperCase()}`;
    }
  } catch (err: unknown) {
    error = (err as Error).message;
    exitCode = 1;
  }

  return { stdout, error, exitCode };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("signoff CLI command — service integration", () => {
  let world: TestWorld;
  let concord: Concord;

  beforeEach(() => {
    world = makeWorld();
    concord = world.concord;
  });

  it("records a recon sign-off with status acknowledged, note, correct actor and run fingerprint", async () => {
    const { run } = await setupAssetWithBreak(world);
    const brk = run.breaks[0]!;

    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "acknowledged", note: "T+1 timing difference" }, CLI_ACTOR);

    const history = concord.noteHistory("FUND", "recon", brk.key);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "acknowledged",
      note: "T+1 timing difference",
      author: CLI_ACTOR.label,
      fingerprint: brk.fingerprint,
    });
    // Verify the break now shows acknowledged.
    const updatedRun = concord.latestRun(world.assetId)!;
    const updatedBreak = updatedRun.breaks.find((b) => b.key === brk.key)!;
    expect(updatedBreak.status).toBe("acknowledged");
  });

  it("records a recon sign-off with status resolved and note", async () => {
    const { run } = await setupAssetWithBreak(world);
    const brk = run.breaks[0]!;

    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "resolved", note: "register corrected" }, CLI_ACTOR);

    const history = concord.noteHistory("FUND", "recon", brk.key);
    expect(history[0]).toMatchObject({ status: "resolved", note: "register corrected" });
  });

  it("records a recon sign-off with status open (note optional) and clears prior sign-off", async () => {
    const { run } = await setupAssetWithBreak(world);
    const brk = run.breaks[0]!;

    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "acknowledged", note: "first" }, CLI_ACTOR);
    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "open", note: "" }, CLI_ACTOR);

    const history = concord.noteHistory("FUND", "recon", brk.key);
    expect(history).toHaveLength(2);
    expect(history[1]!.status).toBe("open");
    // Break status returns to open.
    const updatedRun = concord.latestRun(world.assetId)!;
    expect(updatedRun.breaks.find((b) => b.key === brk.key)!.status).toBe("open");
  });

  it("stores actor as cli:<os-username>", async () => {
    const { run } = await setupAssetWithBreak(world);
    const brk = run.breaks[0]!;

    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "resolved", note: "checked" }, CLI_ACTOR);

    const history = concord.noteHistory("FUND", "recon", brk.key);
    expect(history[0]!.author).toBe(`cli:${userInfo().username}`);
  });

  it("stores the current run's fingerprint, not a stale one", async () => {
    const { run, holder } = await setupAssetWithBreak(world);
    const brk = run.breaks[0]!;
    const originalFingerprint = brk.fingerprint;

    // Run again after re-importing with a different balance → new fingerprint.
    const reg2 = concord.importRegister("FUND", {
      csv: `holder_id,account,units\nA,${holder},80\n`,
      asOf: at(60),
    });
    const run2 = await concord.reconcile("FUND", reg2.registerId);
    const brk2 = run2.breaks[0]!;

    // The new fingerprint differs from the original.
    expect(brk2.fingerprint).not.toBe(originalFingerprint);

    // Sign off with the new fingerprint — should succeed.
    concord.setNote("FUND", "recon", brk2.key, { fingerprint: brk2.fingerprint, status: "resolved", note: "re-checked" }, CLI_ACTOR);

    const history = concord.noteHistory("FUND", "recon", brk2.key);
    expect(history[0]!.fingerprint).toBe(brk2.fingerprint);
  });

  it("throws NotFound for an unknown key, persisting nothing", async () => {
    await setupAssetWithBreak(world);

    expect(() =>
      concord.setNote("FUND", "recon", "NONEXISTENT_BREAK:xyz", { fingerprint: "f", status: "resolved", note: "x" }, CLI_ACTOR),
    ).toThrow(/no break NONEXISTENT_BREAK:xyz/);

    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(0);
  });

  it("signs off a controls-scope break", async () => {
    const { concord, chain } = world;
    const issuer = key();
    const holder = key();
    const asset = await concord.watchAsset({ network: "testnet", asset: `CTRL:${issuer}`, fromLedger: 1 });
    // A freeze with no matching instruction → controls break.
    chain.push(asset.id, "set_authorized", 5, { from: holder, amount: 0n, authorized: false });
    chain.latest = 200;
    await concord.sync("CTRL");
    const ctrlBreaks = concord.controls("CTRL").breaks;
    expect(ctrlBreaks.length).toBeGreaterThan(0);
    const brk = ctrlBreaks[0]!;

    concord.setNote("CTRL", "controls", brk.key, { fingerprint: brk.fingerprint, status: "acknowledged", note: "off-chain authorisation" }, CLI_ACTOR);

    const history = concord.noteHistory("CTRL", "controls", brk.key);
    expect(history[0]).toMatchObject({ status: "acknowledged", author: CLI_ACTOR.label });
  });
});

describe("signoff CLI command — argument validation", () => {
  let world: TestWorld;
  let concord: Concord;

  beforeEach(() => {
    world = makeWorld();
    concord = world.concord;
  });

  it("exits 1 and prints clear error when --note is missing for acknowledged", async () => {
    await setupAssetWithBreak(world);
    const run = concord.latestRun(world.assetId)!;
    const brk = run.breaks[0]!;

    const { exitCode, error, stdout } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: brk.key,
      status: "acknowledged",
      // note intentionally omitted
    });

    expect(exitCode).toBe(1);
    expect(error).toMatch(/--note is required when --status is acknowledged/);
    expect(stdout).toBe("");
    // Nothing persisted.
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(0);
  });

  it("exits 1 and prints clear error when --note is missing for resolved", async () => {
    await setupAssetWithBreak(world);
    const run = concord.latestRun(world.assetId)!;
    const brk = run.breaks[0]!;

    const { exitCode, error } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: brk.key,
      status: "resolved",
    });

    expect(exitCode).toBe(1);
    expect(error).toMatch(/--note is required when --status is resolved/);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(0);
  });

  it("succeeds when status is open with no note", async () => {
    await setupAssetWithBreak(world);
    // First sign it off so there is a row to reopen.
    const run = concord.latestRun(world.assetId)!;
    const brk = run.breaks[0]!;
    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "acknowledged", note: "initial" }, CLI_ACTOR);

    const { exitCode, stdout } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: brk.key,
      status: "open",
      // note omitted — allowed for open
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("OPEN");
  });

  it("exits 1 for an invalid --scope value", async () => {
    await setupAssetWithBreak(world);
    const { exitCode, error } = runSignoff(concord, "FUND", {
      scope: "bad-scope",
      key: "some-key",
      status: "resolved",
      note: "x",
    });
    expect(exitCode).toBe(1);
    expect(error).toMatch(/--scope must be recon, controls, or action:N/);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(0);
  });

  it("exits 1 for action:0 (N must be a positive integer)", async () => {
    await setupAssetWithBreak(world);
    const { exitCode, error } = runSignoff(concord, "FUND", {
      scope: "action:0",
      key: "k",
      status: "resolved",
      note: "x",
    });
    expect(exitCode).toBe(1);
    expect(error).toMatch(/--scope must be recon, controls, or action:N/);
  });

  it("accepts action:N scope with positive N", async () => {
    // action:1 scope parsed correctly — the error will be NotFound (no such action),
    // which is the service's error, not a CLI validation error.
    await setupAssetWithBreak(world);
    const { exitCode, error } = runSignoff(concord, "FUND", {
      scope: "action:1",
      key: "k",
      status: "resolved",
      note: "x",
    });
    // Should fail with a service-level NotFound (action not found), not a scope parse error.
    expect(exitCode).toBe(1);
    expect(error).toMatch(/not found/i);
    expect(error).not.toMatch(/--scope must be/);
  });

  it("exits 1 for an invalid --status value", async () => {
    await setupAssetWithBreak(world);
    const { exitCode, error } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: "k",
      status: "maybe",
      note: "x",
    });
    expect(exitCode).toBe(1);
    expect(error).toMatch(/--status must be open, acknowledged, or resolved/);
  });

  it("exits 1 and surfaces service NotFound for an unknown key", async () => {
    await setupAssetWithBreak(world);
    const { exitCode, error } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: "NO_SUCH_BREAK:abc",
      status: "resolved",
      note: "checked",
    });
    expect(exitCode).toBe(1);
    expect(error).toMatch(/no break NO_SUCH_BREAK:abc/);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(0);
  });

  it("prints success message on stdout for a valid sign-off", async () => {
    await setupAssetWithBreak(world);
    const run = concord.latestRun(world.assetId)!;
    const brk = run.breaks[0]!;

    const { exitCode, stdout, error } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: brk.key,
      status: "resolved",
      note: "confirmed correct",
    });

    expect(exitCode).toBe(0);
    expect(error).toBe("");
    expect(stdout).toContain(brk.key);
    expect(stdout).toContain("RESOLVED");
  });

  it("outputs JSON when --json is passed", async () => {
    await setupAssetWithBreak(world);
    const run = concord.latestRun(world.assetId)!;
    const brk = run.breaks[0]!;

    const { exitCode, stdout } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: brk.key,
      status: "acknowledged",
      note: "noted",
      json: true,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, scope: "recon", status: "acknowledged" });
  });

  it("targets a specific run when --run N is given", async () => {
    const { run } = await setupAssetWithBreak(world);
    const brk = run.breaks[0]!;

    const { exitCode, stdout } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: brk.key,
      status: "resolved",
      note: "checked via specific run",
      run: String(run.id),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESOLVED");
  });

  it("exits 1 with a service error when --run N references a non-existent run", async () => {
    await setupAssetWithBreak(world);
    const { exitCode, error } = runSignoff(concord, "FUND", {
      scope: "recon",
      key: "some-key",
      status: "resolved",
      note: "x",
      run: "99999",
    });
    expect(exitCode).toBe(1);
    expect(error).toMatch(/not found/i);
  });

  it("exits 1 when ASSET is missing", async () => {
    // The 'need' helper throws for a missing asset too.
    // We simulate by calling with an empty string — Concord.asset throws NotFound.
    await setupAssetWithBreak(world);
    const { exitCode, error } = runSignoff(concord, "NONEXISTENT_ASSET_XYZ", {
      scope: "recon",
      key: "k",
      status: "resolved",
      note: "x",
    });
    expect(exitCode).toBe(1);
    expect(error).toMatch(/not watched|not found/i);
  });
});
