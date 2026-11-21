import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChainError, StellarSource, cursorLedger, decodeEvent } from "../src/chain.js";
import { USAGE } from "../src/cli-usage.js";
import { Concord, Invalid, NotFound } from "../src/concord.js";
import { Db } from "../src/db.js";
import { Client, FakeChain, PASSPHRASE, at, harness, key, u } from "./helpers.js";

const validateAuditPack = new Ajv({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/audit-pack.schema.json", import.meta.url)), "utf8")),
);

/** Every key path in a value, with `[]` for arrays, so a renamed or dropped field changes the list. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    const here = `${prefix}[]`;
    return [here, ...value.flatMap((item) => keyPaths(item, here))];
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return prefix ? [prefix] : [];
}

describe("decodeEvent", () => {
  const a = key();
  const b = key();
  const sym = (s: string) => nativeToScVal(s, { type: "symbol" }).toXDR("base64");
  const addr = (s: string) => nativeToScVal(s, { type: "address" }).toXDR("base64");
  const str = (s: string) => nativeToScVal(s).toXDR("base64");
  const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" }).toXDR("base64");
  const raw = (topic: string[], value: string) => ({
    id: "0000000429496729600-0000000001",
    ledger: 100,
    ledgerClosedAt: "2026-10-01T00:00:00Z",
    contractId: "CASSET",
    txHash: "ab",
    topic,
    value,
  });

  it("decodes the CAP-67 layouts", () => {
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n)))).toMatchObject({
      kind: "transfer",
      from: a,
      to: b,
      amount: 5n,
    });
    expect(decodeEvent(raw([sym("mint"), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ to: b, amount: 7n });
    expect(decodeEvent(raw([sym("clawback"), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ from: b });
    const authFalse = decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], nativeToScVal(false).toXDR("base64")));
    expect(authFalse).toMatchObject({ kind: "set_authorized", from: b, authorized: false, amount: 0n });
    const authTrue = decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], nativeToScVal(true).toXDR("base64")));
    expect(authTrue).toMatchObject({ kind: "set_authorized", from: b, authorized: true, amount: 0n });
    expect(decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], str("false")))).toBeUndefined();
    expect(decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], i128(1n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("set_authorized"), addr(b), str(`FUND:${a}`)], nativeToScVal(undefined, { type: "void" }).toXDR("base64")))).toBeUndefined();
  });

  it("takes the subject from the last address when an admin leads, and reads muxed values", () => {
    expect(decodeEvent(raw([sym("mint"), addr(a), addr(b), str(`FUND:${a}`)], i128(7n)))).toMatchObject({ to: b });
    const muxed = nativeToScVal({ amount: 9n, to_muxed_id: 42n }, { type: { amount: ["symbol", "i128"], to_muxed_id: ["symbol", "u64"] } });
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b)], muxed.toXDR("base64")))).toMatchObject({ amount: 9n });
  });

  it("ignores events outside the asset set", () => {
    expect(decodeEvent(raw([sym("approve"), addr(a), addr(b)], i128(1n)))).toBeUndefined();
  });

  it("returns undefined without throwing when ledgerClosedAt is unparseable", () => {
    const invalidDateRaw = {
      ...raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n)),
      ledgerClosedAt: "garbage",
    };
    expect(() => decodeEvent(invalidDateRaw)).not.toThrow();
    expect(decodeEvent(invalidDateRaw)).toBeUndefined();
  });

  it("rejects negative amounts and accepts zero amounts for transfer, mint, burn, and clawback", () => {
    // transfer
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "transfer",
      amount: 0n,
    });

    // mint
    expect(decodeEvent(raw([sym("mint"), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("mint"), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "mint",
      amount: 0n,
    });

    // burn
    expect(decodeEvent(raw([sym("burn"), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("burn"), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "burn",
      amount: 0n,
    });

    // clawback
    expect(decodeEvent(raw([sym("clawback"), addr(b), str(`FUND:${a}`)], i128(-5n)))).toBeUndefined();
    expect(decodeEvent(raw([sym("clawback"), addr(b), str(`FUND:${a}`)], i128(0n)))).toMatchObject({
      kind: "clawback",
      amount: 0n,
    });
  });

  it("returns undefined without throwing when topic or value contains malformed XDR", () => {
    // Malformed topic (not valid base64 / ScVal)
    const badTopicRaw = {
      ...raw(["!!!notxdr", addr(a), addr(b), str(`FUND:${a}`)], i128(5n)),
    };
    expect(() => decodeEvent(badTopicRaw)).not.toThrow();
    expect(decodeEvent(badTopicRaw)).toBeUndefined();

    // Truncated / malformed value XDR
    const truncatedValueRaw = {
      ...raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], "AAAA"),
    };
    expect(() => decodeEvent(truncatedValueRaw)).not.toThrow();
    expect(decodeEvent(truncatedValueRaw)).toBeUndefined();
  });

  it("skips malformed events and returns the remaining good events in getEvents", async () => {
    const goodRaw = raw([sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], i128(5n));
    // A kind Concord does not track is ignored, not malformed.
    const ignoredRaw = raw([sym("approve"), addr(a), addr(b), str(`FUND:${a}`)], i128(1n));
    const badRaw = {
      ...raw(["!!!notxdr", addr(a), addr(b), str(`FUND:${a}`)], i128(5n)),
      id: "0000000429496729600-0000000002",
    };
    const network = {
      name: "testnet" as const,
      passphrase: "test",
      rpc: [{ url: "https://rpc.example" }],
      horizon: [{ url: "https://horizon.example" }],
    };
    const deps = {
      fetch: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              events: [badRaw, ignoredRaw, goodRaw],
              latestLedger: 100,
              cursor: "cursor-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      now: () => 0,
      sleep: async () => {},
    };
    const source = new StellarSource(network, deps);
    const page = await source.getEvents("CASSET", { startLedger: 1 }, 10);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.kind).toBe("transfer");
    expect(page.events[0]!.amount).toBe(5n);
    expect(page.skipped).toBe(1);
    expect(page.latestLedger).toBe(100);
    expect(page.cursor).toBe("cursor-1");
  });
});

describe("cursorLedger", () => {
  it("decodes valid TOID cursors with or without index", () => {
    // 100 << 32 = 429496729600n
    expect(cursorLedger("429496729600-0000000001")).toBe(100);
    expect(cursorLedger("429496729600-1")).toBe(100);
    expect(cursorLedger("429496729600")).toBe(100);
  });

  const invalidCases = [
    { label: "empty string", input: "" },
    { label: "negative number", input: "-5" },
    { label: "non-numeric string", input: "abc-1" },
    { label: "invalid characters", input: "123a-45" },
    { label: "multiple hyphens", input: "123-45-67" },
    { label: "trailing hyphen", input: "123-" },
  ];

  for (const { label, input } of invalidCases) {
    it(`throws ChainError on ${label} (${JSON.stringify(input)})`, () => {
      expect(() => cursorLedger(input)).toThrow(ChainError);
      expect(() => cursorLedger(input)).toThrow(/invalid cursor/);
    });
  }
});

describe("Concord", () => {
  let chain: FakeChain;
  let concord: Concord;
  let assetId: string;
  const issuer = key();
  const [h1, h2, h3, treasury] = [key(), key(), key(), key()];

  beforeEach(async () => {
    chain = new FakeChain();
    concord = new Concord(new Db(":memory:"), { testnet: { passphrase: PASSPHRASE, chain } });
    const asset = await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1, ignore: [treasury] });
    assetId = asset.id;
    chain.push(assetId, "set_authorized", 2, { from: h1, authorized: true });
    chain.push(assetId, "mint", 3, { to: h1, amount: u(100) });
    chain.push(assetId, "mint", 3, { to: h2, amount: u(50) });
    chain.push(assetId, "mint", 3, { to: treasury, amount: u(999) });
    chain.push(assetId, "transfer", 10, { from: h1, to: h2, amount: u(10) });
    chain.push(assetId, "set_authorized", 20, { from: h2, authorized: false });
    chain.push(assetId, "clawback", 30, { from: h2, amount: u(5) });
  });

  it("indexes in pages and is idempotent", async () => {
    for (let i = 0; i < 2500; i++) chain.push(assetId, "mint", 40, { to: h3, amount: 1n });
    expect(await concord.sync("FUND")).toEqual({ added: 2507 });
    expect(chain.calls).toBe(3);
    expect(await concord.sync("FUND")).toEqual({ added: 0 });
    const h = concord.holdings("FUND");
    expect(h.supply).toBe("1144.00025");
    expect(h.holders.find((x) => x.address === h2)).toMatchObject({ units: "55", status: "frozen" });
    expect(concord.asset("FUND").syncedLedger).toBe(100);
  });

  it("rejects reconciliation when no register has been imported", async () => {
    await expect(concord.reconcile("FUND")).rejects.toThrow(new NotFound("no register imported for this asset"));
  });

  it("defaults to the latest register by as-of time rather than import order", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\nB,${h2},55\n`;
    const latest = concord.importRegister("FUND", { csv, asOf: at(40) });
    const older = concord.importRegister("FUND", { csv, asOf: at(10) });

    expect(latest.registerId).toBe(1);
    expect(older.registerId).toBeGreaterThan(latest.registerId);
    expect(await concord.reconcile("FUND")).toMatchObject({ registerId: latest.registerId, asOf: at(40) });
  });

  it("accepts current register times but rejects times beyond the clock skew", () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const current = new Date().toISOString();
    const withinSkew = new Date(Date.now() + 4 * 60_000).toISOString();
    const tooFarAhead = new Date(Date.now() + 6 * 60_000).toISOString();

    expect(() => concord.importRegister("FUND", { csv, asOf: current })).not.toThrow();
    expect(() => concord.importRegister("FUND", { csv, asOf: withinSkew })).not.toThrow();
    expect(() => concord.importRegister("FUND", { csv, asOf: tooFarAhead })).toThrow(
      new Invalid("asOf cannot be more than 5 minutes in the future"),
    );
    expect(() => concord.importRegister("FUND", { csv, asOf: "2099-01-01" })).toThrow(Invalid);
    expect(concord.registers("FUND")).toHaveLength(2);
  });

  it("treats the same file at the same as-of time as one register, and a different as-of time as a new one", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const first = concord.importRegister("FUND", { csv, asOf: at(40) });
    expect(first.duplicate).toBe(false);
    await concord.reconcile("FUND", first.registerId);
    const again = concord.importRegister("FUND", { csv, asOf: at(40) });
    expect(again).toMatchObject({ registerId: first.registerId, duplicate: true });
    expect(concord.registers("FUND")).toHaveLength(1);
    expect(concord.latestRunForRegister(first.registerId)).not.toBeNull();
    const later = concord.importRegister("FUND", { csv, asOf: at(41) });
    expect(later).toMatchObject({ duplicate: false });
    expect(later.registerId).not.toBe(first.registerId);
    expect(concord.registers("FUND")).toHaveLength(2);
  });

  it("rounds holder shares half up to four decimals so two thirds and one third add to 100", async () => {
    const asset = await concord.watchAsset({ network: "testnet", asset: `THIRDS:${key()}`, fromLedger: 1 });
    chain.push(asset.id, "mint", 3, { to: h1, amount: u(2) });
    chain.push(asset.id, "mint", 3, { to: h2, amount: u(1) });
    await concord.sync("THIRDS");
    const shares = concord.holdings("THIRDS").holders.map((h) => h.share);
    expect(shares).toEqual([66.6667, 33.3333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 4);
    expect(concord.auditExport("THIRDS").holdings.holders.map((h) => h.share)).toEqual(shares);
  });

  it("refuses a sign-off for a break that is not in the current results", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    const note = { fingerprint: "f", status: "resolved" as const, note: "x" };
    expect(() => concord.setNote("FUND", "recon", "NOT_A_BREAK:xyz", note)).toThrow(/no break NOT_A_BREAK:xyz/);
    expect(() => concord.setNote("FUND", "controls", run.breaks[0]!.key, note)).toThrow(/no break/);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(0);
    concord.setNote("FUND", "recon", run.breaks[0]!.key, { ...note, fingerprint: run.breaks[0]!.fingerprint });
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(1);
  });

  it("reopens a control sign-off when the instruction behind it is replaced by a changed row", async () => {
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI7,freeze,${h3},,${at(19)}\n`);
    chain.latest = 6000; // past the 72h execution window
    await concord.sync("FUND");
    const brk = concord.controls("FUND").breaks.find((b) => b.key === "UNEXECUTED_INSTRUCTION:I7")!;
    expect(brk.status).toBe("open");
    concord.setNote("FUND", "controls", brk.key, { fingerprint: brk.fingerprint, status: "resolved", note: "cancelled off-chain" });
    expect(concord.controls("FUND").breaks.find((b) => b.key === brk.key)).toMatchObject({ status: "resolved", noteStale: false });
    // The same ref is re-imported for a different account: a different instruction, so open again.
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI7,freeze,${h1},,${at(19)}\n`);
    expect(concord.controls("FUND").breaks.find((b) => b.key === brk.key)).toMatchObject({ status: "open", noteStale: true });
  });

  it("keeps every sign-off change, with who and when, and puts it in the audit pack", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    const brk = run.breaks[0]!;
    const sign = (status: "open" | "acknowledged" | "resolved", note: string, label: string) =>
      concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status, note }, { id: label, label });
    sign("acknowledged", "T+1 timing", "alice");
    sign("resolved", "register corrected", "bob");
    sign("open", "reopened: file was wrong", "alice");

    // The current state is the last change; the trail keeps all three.
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM break_notes")!.n).toBe(1);
    const history = concord.noteHistory("FUND", "recon", brk.key);
    expect(history.map((h) => [h.author, h.status, h.note])).toEqual([
      ["alice", "acknowledged", "T+1 timing"],
      ["bob", "resolved", "register corrected"],
      ["alice", "open", "reopened: file was wrong"],
    ]);
    expect(history.every((h) => h.at && h.fingerprint === brk.fingerprint)).toBe(true);
    expect(concord.noteHistory("FUND", "recon", "SOMETHING_ELSE")).toEqual([]);
    expect(concord.auditExport("FUND").signoffHistory).toEqual(history);
    // Sign-offs are wall-clock events, so the period (chain time) does not narrow the trail.
    expect(concord.auditExport("FUND", { from: "2020-01-01", to: "2020-01-02" }).signoffHistory).toEqual(history);
  });

  it("narrows the whole controls section of an audit pack to the period, not just its records", async () => {
    await concord.sync("FUND");
    const all = concord.auditExport("FUND").controls;
    expect(all.records.map((r) => r.type).sort()).toEqual(["authorize", "clawback", "freeze"]);

    // Ledgers 15-25 hold only the freeze of h2; the pack must not still count the clawback.
    const freezeOnly = concord.auditExport("FUND", { from: at(15), to: at(25) }).controls;
    expect(freezeOnly.records.map((r) => r.type)).toEqual(["freeze"]);
    expect(freezeOnly.asOf).toBe(at(25));
    expect(freezeOnly.summary).toMatchObject({ controls: 1, uninstructed: 1 });
    expect(freezeOnly.breaks.map((b) => b.type)).toEqual(["UNINSTRUCTED_CONTROL"]);

    // A period with no control in it says so everywhere.
    const none = concord.auditExport("FUND", { from: at(50), to: at(60) }).controls;
    expect(none.records).toEqual([]);
    expect(none.summary).toMatchObject({ controls: 0, instructed: 0, uninstructed: 0, unexecuted: 0, pending: 0 });
    expect(none.breaks).toEqual([]);
    expect(none.openBreaks).toBe(0);
  });

  it("lets the watch route replay from a named ledger, and still rejects a bad one", async () => {
    const h = harness();
    h.chain.baselineResult = { ledger: 50, openings: new Map() };
    const client = await new Client(h.app).signUp("replay@example.test", "Replay");
    const named = await client.call("/api/assets", {
      body: { network: "testnet", asset: `NAMED:${issuer}`, fromLedger: 5 },
    });
    expect(named.status).toBe(201);
    const ws = h.tenants.forOrg(client.orgId);
    await ws.sync("NAMED");
    expect(ws.asset("NAMED")).toMatchObject({ startMode: "ledger", startLedger: 5, state: "ready" });
    const bad = await client.call("/api/assets", {
      body: { network: "testnet", asset: `BAD:${issuer}`, fromLedger: 0 },
    });
    expect(bad.status).toBe(400);
  });

  it("rejects a register from another asset and an unknown register id", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    await concord.watchAsset({ network: "testnet", asset: `OTHER:${issuer}`, fromLedger: 1 });

    await expect(concord.reconcile("OTHER", reg.registerId)).rejects.toThrow(new NotFound("no register imported for this asset"));
    await expect(concord.reconcile("FUND", 999)).rejects.toThrow(new NotFound("no register imported for this asset"));
  });

  it("reconciles a register at its as-of time and ages breaks", async () => {
    const csv = `holder_id,account,units,status\nA,${h1},100,active\nB,${h2},50,active\n`;
    const day1 = concord.importRegister("FUND", { csv, asOf: at(5) });
    const clean = await concord.reconcile("FUND", day1.registerId);
    expect(clean.status).toBe("clean");
    expect(clean.summary).toMatchObject({ chainSupply: "150", registerTotal: "150", matchedLines: 2 });

    const day2 = concord.importRegister("FUND", { csv, asOf: at(25) });
    const run2 = await concord.reconcile("FUND", day2.registerId);
    expect(run2.breaks.map((b) => b.type).sort()).toEqual(["QUANTITY_MISMATCH", "QUANTITY_MISMATCH", "STATUS_MISMATCH"]);
    const b1 = run2.breaks.find((b) => b.address === h1)!;
    expect(b1).toMatchObject({ chainUnits: "90", registerUnits: "100", difference: "-10", firstSeen: at(25), status: "open" });

    // Signed off, the break stays signed off while the numbers hold…
    concord.setNote("FUND", "recon", b1.key, { fingerprint: b1.fingerprint, status: "acknowledged", note: "T+1 timing" }, { id: "u1", label: "ops" });
    const day3 = concord.importRegister("FUND", { csv, asOf: at(26) });
    const run3 = await concord.reconcile("FUND", day3.registerId);
    expect(run3.breaks.find((b) => b.address === h1)).toMatchObject({ status: "acknowledged", firstSeen: at(25), note: "T+1 timing", noteAuthor: "ops" });
    expect(run3.openBreaks).toBe(2);

    // …and reopens when they move.
    const day4 = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run4 = await concord.reconcile("FUND", day4.registerId);
    expect(run4.breaks.find((b) => b.address === h2 && b.type === "QUANTITY_MISMATCH")).toMatchObject({ chainUnits: "55", firstSeen: at(25) });
    chain.latest = 200;
    chain.push(assetId, "transfer", 150, { from: h1, to: h2, amount: u(1) });
    const day5 = concord.importRegister("FUND", { csv, asOf: at(160) });
    const run5 = await concord.reconcile("FUND", day5.registerId);
    expect(run5.breaks.find((b) => b.address === h1)).toMatchObject({ status: "open", noteStale: true });
  });

  it("lists reconciliations from stored columns without parsing their result bodies", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);

    const parse = vi.spyOn(JSON, "parse");
    const listed = concord.runs("FUND");
    const bodies = parse.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('"registerSha256"'));
    parse.mockRestore();

    // The list's shape is exactly what run() reports, but no run body went through JSON.parse.
    expect(bodies).toEqual([]);
    expect(listed).toEqual([
      {
        id: run.id,
        asOf: run.asOf,
        createdAt: run.createdAt,
        status: run.status,
        chainBehind: run.chainBehind,
        summary: run.summary,
        openBreaks: run.openBreaks,
      },
    ]);

    // The open count is a stored column, so a sign-off has to move it rather than leave it stale.
    const brk = run.breaks[0]!;
    expect(run.openBreaks).toBeGreaterThan(0);
    concord.setNote(
      "FUND",
      "recon",
      brk.key,
      { fingerprint: brk.fingerprint, status: "acknowledged", note: "T+1 timing" },
      { id: "u1", label: "ops" },
    );
    expect(concord.runs("FUND")[0]!.openBreaks).toBe(run.openBreaks - 1);
    // Reopening puts it back.
    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "open", note: "wrong" });
    expect(concord.runs("FUND")[0]!.openBreaks).toBe(run.openBreaks);
  });

  it("lists 200 runs of a thousand-holder register without reading the bodies", () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const summary = { chainSupply: "150", registerTotal: "150", breakCount: 0, lines: 1000 };
    const body = JSON.stringify({
      registerId: reg.registerId,
      registerSha256: "sha",
      asOf: at(40),
      chainLedger: 100,
      chainSyncedAt: at(100),
      chainBehind: false,
      warnings: [],
      status: "clean",
      summary,
      lines: Array.from({ length: 1000 }, (_, i) => ({
        address: `G${String(i).padStart(55, "0")}`,
        holderIds: [`h${i}`],
        chainUnits: "100",
        registerUnits: "100",
        difference: "0",
        chainStatus: "active",
        registerStatus: "active",
        matched: true,
      })),
      movement: null,
      breaks: [],
    });
    concord.db.tx(() => {
      for (let i = 0; i < 200; i++) {
        concord.db.insert(
          `INSERT INTO runs (asset_id, register_id, as_of, created_at, summary, status, chain_behind, open_breaks, result)
           VALUES (?, ?, ?, ?, ?, 'clean', 0, 0, ?)`,
          assetId,
          reg.registerId,
          at(40),
          at(40 + i),
          JSON.stringify(summary),
          body,
        );
      }
    });

    const started = performance.now();
    const listed = concord.runs("FUND");
    const listedMs = performance.now() - started;

    // What the list used to do: parse and annotate every body.
    const legacyStarted = performance.now();
    const expected = concord.db
      .all<{ id: number }>("SELECT id FROM runs WHERE asset_id = ? ORDER BY id DESC LIMIT 200", assetId)
      .map(({ id }) => concord.run(id))
      .map((r) => ({
        id: r.id,
        asOf: r.asOf,
        createdAt: r.createdAt,
        status: r.status,
        chainBehind: r.chainBehind,
        summary: r.summary,
        openBreaks: r.openBreaks,
      }));
    const legacyMs = performance.now() - legacyStarted;

    expect(listed).toEqual(expected);
    expect(listed).toHaveLength(200);
    // Each body is ~250 KB, so the old path parsed tens of MB per request; the columns parse none.
    expect(listedMs).toBeLessThan(legacyMs / 5);
  });

  it("warns when the register is ahead of the indexed chain", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(500) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.chainBehind).toBe(true);
    expect(run.warnings).toHaveLength(1);
  });

  it("reconciles movements only once a journal exists, skipping ignored-only flows", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\nB,${h2},55\n`;
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\nJ3,${at(10)},transfer,${h1},${h2},10\n`,
    );
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.movement).toMatchObject({ events: 4, matched: 3 });
    expect(run.breaks.map((b) => b.type)).toEqual(["UNRECORDED_MOVEMENT"]);
    expect(run.breaks[0]).toMatchObject({ scope: "movement", address: h2, chainUnits: "5" });
  });

  it("leaves journal entries wholly among ignored addresses out of movement matching", async () => {
    chain.push(assetId, "transfer", 15, { from: h2, to: treasury, amount: u(1) });
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\nJ3,${at(3)},issue,,${treasury},999\nJ4,${at(10)},transfer,${h1},${h2},10\nJ5,${at(15)},transfer,${h2},${treasury},1\n`,
    );
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    const unsettled = run.breaks.filter((b) => b.type === "UNSETTLED_ENTRY");
    // J3 is wholly ignored and raises nothing; J5 touches one non-ignored party and still matches.
    expect(unsettled).toEqual([]);
    expect(run.movement).toMatchObject({ matched: 4 });
  });

  it("starts from a baseline and only applies later events", async () => {
    const other = key();
    chain.latest = 200;
    chain.baselineResult = {
      ledger: 150,
      openings: new Map([
        [h1, { amount: u(70), authorized: true, asOfLedger: 150 }],
        [h2, { amount: u(30), asOfLedger: 152 }],
      ]),
    };
    const asset = await concord.watchAsset({ network: "testnet", asset: `OLD:${other}` });
    expect(asset).toMatchObject({ startMode: "baseline", state: "ready", baselineLedger: 150 });
    expect(asset.startLedger).toBe(151);
    chain.push(asset.id, "transfer", 151, { from: h1, to: h2, amount: u(5) });
    chain.push(asset.id, "transfer", 160, { from: h2, to: h1, amount: u(1) });
    await concord.sync("OLD");
    const h = concord.holdings("OLD");
    expect(h.holders.map((x) => [x.address, x.units])).toEqual([
      [h1, "66"],
      [h2, "29"],
    ]);
  });

  it("does not flag an instruction from before a baseline asset's indexed history as never executed", async () => {
    const other = key();
    chain.latest = 200;
    chain.baselineResult = { ledger: 150, openings: new Map([[h1, { amount: u(70), authorized: true, asOfLedger: 150 }]]) };
    await concord.watchAsset({ network: "testnet", asset: `OLD:${other}` });
    // Issued long before the watch started: its window ended before Concord could have seen it.
    concord.importInstructions("OLD", `ref,type,account,issued_at\nI-OLD,freeze,${h1},2025-01-01T00:00:00Z\n`);
    const controls = concord.controls("OLD");
    expect(controls.breaks).toEqual([]);
    expect(controls.unverifiable.map((i) => i.ref)).toEqual(["I-OLD"]);
    // The same instruction against an asset watched from a ledger the caller named is still checked.
    chain.baselineResult = undefined;
    await concord.watchAsset({ network: "testnet", asset: `NAMED:${key()}`, fromLedger: 1 });
    concord.importInstructions("NAMED", `ref,type,account,issued_at\nI-OLD,freeze,${h1},2025-01-01T00:00:00Z\n`);
    expect(concord.controls("NAMED").breaks.map((b) => b.key)).toEqual(["UNEXECUTED_INSTRUCTION:I-OLD"]);
  });

  it("snapshots at the record time and reconciles a dividend paid in another asset", async () => {
    const bank = key();
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${bank}`, fromLedger: 1 });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: u(9) });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h2, amount: u(5) });
    chain.push(cash.id, "transfer", 90, { from: treasury, to: h2, amount: u(1) });
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      windowTo: at(60),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    expect(action.snapshot).toMatchObject({ ledger: 3, holderCount: 3 });
    expect(action.result!.summary).toMatchObject({ expectedTotal: "15", observedTotal: "14", breakCount: 1 });
    expect(action.result!.breaks[0]).toMatchObject({ type: "SHORT", address: h1, expected: "10", observed: "9" });

    const split = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    expect(split.result!.breaks.map((b) => b.type)).toEqual(["MISSING", "MISSING"]);
    chain.latest = 200;
    chain.push(assetId, "mint", 170, { to: h1, amount: u(90) });
    chain.push(assetId, "mint", 170, { to: h2, amount: u(55) });
    expect((await concord.reconcileAction(split.id)).state).toBe("clean");
  });

  it("reports a pay asset's read-through time from its sync in the same pass", async () => {
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${key()}`, fromLedger: 1 });
    expect(cash.syncedAt ?? null).toBeNull();
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    expect(action.result!.reconciledThrough).not.toBeNull();
    expect(action.result!.reconciledThrough).toBe(concord.asset("USDX").syncedAt);
  });

  it("reconciles reverse splits executed as burns rather than clawbacks", async () => {
    chain.push(assetId, "burn", 7, { from: h1, amount: u(50) });
    chain.push(assetId, "burn", 7, { from: h2, amount: u(25) });
    const split = await concord.createAction("FUND", {
      type: "split",
      recordTime: at(5),
      windowTo: at(9),
      num: "1",
      den: "2",
    });
    expect(split.state).toBe("clean");
    expect(split.result?.summary).toMatchObject({
      expectedTotal: "-75",
      observedTotal: "-75",
      breakCount: 0,
    });
  });

  it("rejects non-address payer and warns on a silent payer", async () => {
    await expect(
      concord.createAction("FUND", {
        type: "dividend",
        recordTime: at(5),
        ratePerUnit: "0.1",
        payer: "bogus payer",
      }),
    ).rejects.toThrow("payer must be a valid Stellar address");

    const silentPayer = key();
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "0.1",
      payer: silentPayer,
    });
    expect(action.result!.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining(`Payer ${silentPayer} has no recorded flows in the action window`)]),
    );
  });

  it("holds an action as scheduled until the chain passes its record time", async () => {
    const action = await concord.createAction("FUND", { type: "redemption", recordTime: at(150), num: "1", den: "1" });
    expect(action.state).toBe("scheduled");
    chain.latest = 200;
    chain.push(assetId, "clawback", 160, { from: h1, amount: u(90) });
    const later = await concord.reconcileAction(action.id);
    expect(later.snapshot!.holderCount).toBe(3);
    expect(later.result!.breaks.map((b) => [b.type, b.address])).toEqual([["MISSING", h2]]);
  });

  it("refuses to snapshot when record time is earlier than history start on a baseline asset", async () => {
    const other = key();
    chain.latest = 200;
    chain.baselineResult = {
      ledger: 150,
      openings: new Map([
        [h1, { amount: u(70), authorized: true, asOfLedger: 150 }],
        [h2, { amount: u(30), asOfLedger: 150 }],
      ]),
    };
    const asset = await concord.watchAsset({ network: "testnet", asset: `OLD:${other}` });
    chain.push(asset.id, "transfer", 151, { from: h1, to: h2, amount: u(5) });
    await concord.sync("OLD");

    const action = await concord.createAction("OLD", {
      type: "dividend",
      recordTime: at(100),
      ratePerUnit: "1",
    });
    expect(action.snapshot).toBeNull();
    expect(action.state).toBe("scheduled");
    expect(action.result).not.toBeNull();
    expect(action.result!.warnings).toEqual([
      expect.stringContaining("earlier than history start"),
    ]);

    // reconcile() on OLD with asOf earlier than history start (e.g. at(5)) carries warning
    const regEarly = concord.importRegister("OLD", {
      csv: `holder_id,account,units\nA,${h1},70\n`,
      asOf: at(5),
    });
    const runEarly = await concord.reconcile("OLD", regEarly.registerId);
    expect(runEarly.warnings).toEqual([
      expect.stringContaining("earlier than history start"),
    ]);

    // holdings() on OLD with asOf earlier than history start carries beforeHistory flag and warning
    const holdingsEarly = concord.holdings("OLD", at(5));
    expect(holdingsEarly.beforeHistory).toBe(true);
    expect(holdingsEarly.warnings).toEqual([
      expect.stringContaining("earlier than history start"),
    ]);

    // holdings() with asOf after history start has beforeHistory: false and empty warnings
    const holdingsNormal = concord.holdings("OLD", at(160));
    expect(holdingsNormal.beforeHistory).toBe(false);
    expect(holdingsNormal.warnings).toEqual([]);
  });

  it("builds the controls log and the audit pack", async () => {
    await concord.sync("FUND");
    concord.importInstructions(
      "FUND",
      `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\nI2,freeze,${h2},,${at(19)},compliance,order\n`,
    );
    const log = concord.controls("FUND");
    expect(log.summary).toMatchObject({ controls: 3, instructed: 2, uninstructed: 1 });
    expect(log.breaks[0]).toMatchObject({ type: "UNINSTRUCTED_CONTROL", address: h2, status: "open" });
    expect(log.records[0]).toMatchObject({ type: "clawback", units: "5", instruction: null });

    const pack = concord.auditExport("FUND");
    expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.events).toHaveLength(7);
    expect(concord.auditExport("FUND").sha256).toBe(pack.sha256);
    expect(concord.exportCsv("FUND", "controls").split("\n")[0]).toContain("instructionRef");
    expect(concord.exportCsv("FUND", "breaks")).toContain("UNINSTRUCTED_CONTROL");
  });

  it("reports coverage on every reconciliation and action result", async () => {
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\n`,
    );
    const reg = concord.importRegister("FUND", {
      csv: `holder_id,account,units,status\nA,${h1},90,active\nB,${h2},50,active\n`,
      asOf: at(5),
    });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.coverage).toMatchObject({
      from: concord.asset("FUND").historyFrom ?? concord.asset("FUND").syncedAt,
      to: concord.asset("FUND").syncedAt,
      mode: "ledger",
      complete: true,
    });

    // A register ahead of the chain: complete is false.
    const aheadReg = concord.importRegister("FUND", {
      csv: `holder_id,account,units\nA,${h1},90\n`,
      asOf: at(500),
    });
    const aheadRun = await concord.reconcile("FUND", aheadReg.registerId);
    expect(aheadRun.coverage.complete).toBe(false);
    expect(aheadRun.warnings).toContainEqual(expect.stringContaining("Chain is indexed to"));

    // An action: coverage present and complete when the chain is current.
    const split = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    expect(split.result!.coverage).toMatchObject({
      from: concord.asset("FUND").historyFrom ?? concord.asset("FUND").syncedAt,
      to: concord.asset("FUND").syncedAt,
      mode: "ledger",
      complete: true,
    });

    // An action with recordTime ahead of the chain: complete is false.
    chain.latest = 500;
    chain.push(assetId, "mint", 500, { to: h1, amount: u(1) });
    await concord.sync("FUND");
    const futureAction = await concord.createAction("FUND", { type: "split", recordTime: at(600), num: "2", den: "1" });
    expect(futureAction.result!.coverage.complete).toBe(false);
    expect(futureAction.result!.warnings).toContainEqual(
      expect.stringContaining("Chain is indexed to"),
    );
  });

  it("keeps the audit pack inside the published schema", async () => {
    await concord.sync("FUND");
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\n`,
    );
    // I1 and I2 cover the authorisation and freeze; I3 is issued a minute before the controls log's
    // as-of time (the asset's synced time), so it is still pending, and the clawback has no
    // instruction, so every controls branch appears in the pack.
    const pendingIssuedAt = new Date(Date.parse(concord.asset("FUND").syncedAt!) - 60_000).toISOString();
    concord.importInstructions(
      "FUND",
      `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\nI2,freeze,${h2},,${at(19)},compliance,order\nI3,freeze,${h3},,${pendingIssuedAt},ops,review\n`,
    );
    const reg = concord.importRegister("FUND", {
      csv: `holder_id,account,units,status\nA,${h1},90,active\nB,${h2},50,active\n`,
      asOf: at(5),
    });
    const run = await concord.reconcile("FUND", reg.registerId);
    const first = run.breaks[0]!;
    concord.setNote(
      "FUND",
      "recon",
      first.key,
      { fingerprint: first.fingerprint, status: "resolved", note: "register corrected" },
      { id: "u1", label: "ops <ops@example.test>" },
    );
    await concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1" });

    const pack = concord.auditExport("FUND");
    expect(validateAuditPack(pack), JSON.stringify(validateAuditPack.errors, null, 2)).toBe(true);

    // The schema rejects added fields and misses required ones. This list catches a field that
    // disappears from the fixture, including the optional per-break figures the schema cannot
    // require for every scope.
    expect([...new Set(keyPaths(pack))].sort()).toMatchInlineSnapshot(`
      [
        "asset.baselineLedger",
        "asset.code",
        "asset.decimals",
        "asset.historyFrom",
        "asset.id",
        "asset.ignoredAddresses[]",
        "asset.indexedFromLedger",
        "asset.indexedTo",
        "asset.indexedToLedger",
        "asset.issuer",
        "asset.name",
        "asset.network",
        "controls.asOf",
        "controls.breaks[]",
        "controls.breaks[].address",
        "controls.breaks[].eventId",
        "controls.breaks[].fingerprint",
        "controls.breaks[].key",
        "controls.breaks[].message",
        "controls.breaks[].note",
        "controls.breaks[].noteAt",
        "controls.breaks[].noteAuthor",
        "controls.breaks[].noteScope",
        "controls.breaks[].noteStale",
        "controls.breaks[].ref",
        "controls.breaks[].scope",
        "controls.breaks[].severity",
        "controls.breaks[].status",
        "controls.breaks[].txHash",
        "controls.breaks[].type",
        "controls.openBreaks",
        "controls.pending[]",
        "controls.pending[].account",
        "controls.pending[].approvedBy",
        "controls.pending[].issuedAt",
        "controls.pending[].reason",
        "controls.pending[].ref",
        "controls.pending[].type",
        "controls.pending[].units",
        "controls.records[]",
        "controls.records[].account",
        "controls.records[].closedAt",
        "controls.records[].eventId",
        "controls.records[].instruction",
        "controls.records[].instruction.account",
        "controls.records[].instruction.approvedBy",
        "controls.records[].instruction.issuedAt",
        "controls.records[].instruction.reason",
        "controls.records[].instruction.ref",
        "controls.records[].instruction.type",
        "controls.records[].instruction.units",
        "controls.records[].ledger",
        "controls.records[].txHash",
        "controls.records[].type",
        "controls.records[].units",
        "controls.summary.controls",
        "controls.summary.instructed",
        "controls.summary.pending",
        "controls.summary.unexecuted",
        "controls.summary.uninstructed",
        "controls.unverifiable[]",
        "corporateActions[]",
        "corporateActions[].assetId",
        "corporateActions[].createdAt",
        "corporateActions[].id",
        "corporateActions[].label",
        "corporateActions[].openBreaks",
        "corporateActions[].params.den",
        "corporateActions[].params.exclude[]",
        "corporateActions[].params.num",
        "corporateActions[].reconciledAt",
        "corporateActions[].recordTime",
        "corporateActions[].result.breaks[]",
        "corporateActions[].result.breaks[].address",
        "corporateActions[].result.breaks[].difference",
        "corporateActions[].result.breaks[].expected",
        "corporateActions[].result.breaks[].fingerprint",
        "corporateActions[].result.breaks[].key",
        "corporateActions[].result.breaks[].message",
        "corporateActions[].result.breaks[].note",
        "corporateActions[].result.breaks[].noteAt",
        "corporateActions[].result.breaks[].noteAuthor",
        "corporateActions[].result.breaks[].noteScope",
        "corporateActions[].result.breaks[].noteStale",
        "corporateActions[].result.breaks[].observed",
        "corporateActions[].result.breaks[].scope",
        "corporateActions[].result.breaks[].severity",
        "corporateActions[].result.breaks[].status",
        "corporateActions[].result.breaks[].type",
        "corporateActions[].result.flowAsset.code",
        "corporateActions[].result.flowAsset.id",
        "corporateActions[].result.lines[]",
        "corporateActions[].result.lines[].address",
        "corporateActions[].result.lines[].basis",
        "corporateActions[].result.lines[].difference",
        "corporateActions[].result.lines[].expected",
        "corporateActions[].result.lines[].observed",
        "corporateActions[].result.lines[].status",
        "corporateActions[].result.lines[].txHashes[]",
        "corporateActions[].result.reconciledThrough",
        "corporateActions[].result.status",
        "corporateActions[].result.summary.breakCount",
        "corporateActions[].result.summary.difference",
        "corporateActions[].result.summary.expectedTotal",
        "corporateActions[].result.summary.holders",
        "corporateActions[].result.summary.observedTotal",
        "corporateActions[].result.warnings[]",
        "corporateActions[].result.coverage.from",
        "corporateActions[].result.coverage.to",
        "corporateActions[].result.coverage.mode",
        "corporateActions[].result.coverage.complete",
        "corporateActions[].snapshot.holderCount",
        "corporateActions[].snapshot.holders[]",
        "corporateActions[].snapshot.holders[].address",
        "corporateActions[].snapshot.holders[].units",
        "corporateActions[].snapshot.ledger",
        "corporateActions[].snapshot.takenAt",
        "corporateActions[].state",
        "corporateActions[].type",
        "events[]",
        "events[].authorized",
        "events[].closedAt",
        "events[].from",
        "events[].id",
        "events[].kind",
        "events[].ledger",
        "events[].to",
        "events[].txHash",
        "events[].units",
        "generatedAt",
        "generator",
        "holdings.asOf",
        "holdings.holderCount",
        "holdings.holders[]",
        "holdings.holders[].address",
        "holdings.holders[].ignored",
        "holdings.holders[].share",
        "holdings.holders[].status",
        "holdings.holders[].units",
        "holdings.incomplete[]",
        "holdings.ledger",
        "holdings.supply",
        "period.from",
        "period.to",
        "reconciliations[]",
        "reconciliations[].asOf",
        "reconciliations[].assetId",
        "reconciliations[].breaks[]",
        "reconciliations[].breaks[].address",
        "reconciliations[].breaks[].chainUnits",
        "reconciliations[].breaks[].difference",
        "reconciliations[].breaks[].fingerprint",
        "reconciliations[].breaks[].firstSeen",
        "reconciliations[].breaks[].holderIds[]",
        "reconciliations[].breaks[].key",
        "reconciliations[].breaks[].message",
        "reconciliations[].breaks[].note",
        "reconciliations[].breaks[].noteAt",
        "reconciliations[].breaks[].noteAuthor",
        "reconciliations[].breaks[].noteScope",
        "reconciliations[].breaks[].noteStale",
        "reconciliations[].breaks[].registerUnits",
        "reconciliations[].breaks[].scope",
        "reconciliations[].breaks[].severity",
        "reconciliations[].breaks[].status",
        "reconciliations[].breaks[].type",
        "reconciliations[].chainBehind",
        "reconciliations[].chainLedger",
        "reconciliations[].chainSyncedAt",
        "reconciliations[].createdAt",
        "reconciliations[].id",
        "reconciliations[].lines[]",
        "reconciliations[].lines[].address",
        "reconciliations[].lines[].chainStatus",
        "reconciliations[].lines[].chainUnits",
        "reconciliations[].lines[].difference",
        "reconciliations[].lines[].holderIds[]",
        "reconciliations[].lines[].matched",
        "reconciliations[].lines[].registerStatus",
        "reconciliations[].lines[].registerUnits",
        "reconciliations[].movement.breakCount",
        "reconciliations[].movement.entries",
        "reconciliations[].movement.events",
        "reconciliations[].movement.from",
        "reconciliations[].movement.matched",
        "reconciliations[].movement.matches[]",
        "reconciliations[].movement.matches[].by",
        "reconciliations[].movement.matches[].eventId",
        "reconciliations[].movement.matches[].ref",
        "reconciliations[].movement.matches[].txHash",
        "reconciliations[].movement.to",
        "reconciliations[].openBreaks",
        "reconciliations[].registerId",
        "reconciliations[].registerSha256",
        "reconciliations[].status",
        "reconciliations[].summary.breakCount",
        "reconciliations[].summary.chainHolders",
        "reconciliations[].summary.chainSupply",
        "reconciliations[].summary.grossDifference",
        "reconciliations[].summary.lines",
        "reconciliations[].summary.matchedLines",
        "reconciliations[].summary.registerHolders",
        "reconciliations[].summary.registerTotal",
        "reconciliations[].summary.supplyDifference",
        "reconciliations[].summary.unmappedUnits",
        "reconciliations[].warnings[]",
        "reconciliations[].coverage.from",
        "reconciliations[].coverage.to",
        "reconciliations[].coverage.mode",
        "reconciliations[].coverage.complete",
        "sha256",
        "signoffHistory[]",
        "signoffHistory[].at",
        "signoffHistory[].author",
        "signoffHistory[].fingerprint",
        "signoffHistory[].key",
        "signoffHistory[].note",
        "signoffHistory[].scope",
        "signoffHistory[].status",
      ]
    `);
  });

  it("holds the indexed-to mark still when a pass dies part-way", async () => {
    await concord.sync("FUND");
    const before = concord.asset("FUND");
    expect(before.syncedLedger).toBe(100);
    for (let i = 0; i < 1500; i++) chain.push(assetId, "mint", 150, { to: h3, amount: 1n });
    chain.latest = 200;
    chain.failOnCall = chain.calls + 2;
    await expect(concord.sync("FUND")).rejects.toThrow("connection reset");
    const stalled = concord.asset("FUND");
    // The first page is kept, but the asset does not claim to be indexed to ledger 200.
    expect(stalled).toMatchObject({ syncedLedger: 100, syncedAt: before.syncedAt });
    expect(stalled.syncError).toBe("Indexing stopped on an unexpected error.");
    expect(await concord.sync("FUND")).toEqual({ added: 500 });
    const healed = concord.asset("FUND");
    expect(healed.syncedLedger).toBe(200);
    expect(healed.syncError).toBeUndefined();
  });

  it("reports an unreadable saved cursor instead of a parse error or a skipped gap check", async () => {
    const db = new Db(":memory:");
    const damaged = new Concord(db, { testnet: { passphrase: PASSPHRASE, chain } });
    const watched = await damaged.watchAsset({ network: "testnet", asset: `DMG:${issuer}`, fromLedger: 1 });
    await damaged.sync(watched.id);
    // An empty cursor reads as "no cursor", so only non-empty junk counts as damage.
    for (const cursor of ["-5", "abc-1", "123-"]) {
      db.write("UPDATE assets SET cursor = ? WHERE id = ?", cursor, watched.id);
      await expect(damaged.sync(watched.id)).rejects.toThrow(/saved indexing position is unreadable/);
      expect(damaged.asset(watched.id).syncError).toMatch(/Rebuild this asset/);
    }
  });

  it("reports a gap instead of indexing across it", async () => {
    await concord.sync("FUND");
    chain.latest = 500_000;
    chain.oldest = 400_000;
    await expect(concord.sync("FUND")).rejects.toThrow(/longer than the network keeps events/);
    expect(concord.asset("FUND").syncError).toMatch(/Rebuild this asset/);
  });

  it("stops watching and takes every dependent row with it", async () => {
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    concord.importJournal("FUND", `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\n`);
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI1,freeze,${h2},,${at(19)}\n`);
    const action = await concord.createAction("FUND", { type: "split", recordTime: at(35), num: "2", den: "1" });
    concord.setNote("FUND", "recon", run.breaks[0]!.key, { fingerprint: run.breaks[0]!.fingerprint, status: "resolved", note: "x" });
    const actionBreak = action.result!.breaks[0]!;
    concord.setNote("FUND", `action:${action.id}`, actionBreak.key, { fingerprint: actionBreak.fingerprint, status: "resolved", note: "x" });
    expect(() => concord.setNote("FUND", "action:999", "k", { fingerprint: "f", status: "resolved", note: "x" })).toThrow(/scope/);

    concord.deleteRegister("FUND", reg.registerId);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM register_positions")!.n).toBe(0);
    expect(concord.runs("FUND")).toHaveLength(0);

    await concord.unwatchAsset("FUND");
    const tables = concord.db
      .all<{ name: string }>("SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'asset_id' WHERE m.type = 'table'")
      .map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["events", "openings", "registers", "journal", "instructions", "runs", "actions", "break_notes"]));
    for (const table of tables) {
      expect(concord.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE asset_id = ?`, assetId)!.n, table).toBe(0);
    }
    expect(() => concord.asset("FUND")).toThrow(/not watched/);
    // The same asset can be watched again from scratch.
    await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
    expect(concord.holdings("FUND").holderCount).toBe(0);
  });

  it("rebuilds from fresh opening balances and keeps the books", async () => {
    await concord.sync("FUND");
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    chain.latest = 300;
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    const rebuilt = await concord.rebuild("FUND");
    expect(rebuilt).toMatchObject({ startMode: "baseline", baselineLedger: 250, startLedger: 251, state: "ready" });
    expect(concord.holdings("FUND").holders).toEqual([expect.objectContaining({ address: h1, units: "42" })]);
    expect(concord.registers("FUND").map((r) => r.id)).toEqual([reg.registerId]);
  });

  it("advances a scheduled action once the chain passes its record time", async () => {
    const action = await concord.createAction("FUND", { type: "redemption", recordTime: at(150), num: "1", den: "1" });
    expect(action.state).toBe("scheduled");
    expect(await concord.reconcileDue()).toBe(0);
    chain.latest = 200;
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    expect(concord.action(action.id).state).not.toBe("scheduled");
  });

  it("re-runs a reconciled action while its window is open, and stops once the window is read through", async () => {
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${key()}`, fromLedger: 1 });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: u(9) });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h2, amount: u(5) });
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      windowTo: at(150),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    expect(action.result!.breaks).toMatchObject([{ type: "SHORT", address: h1, expected: "10", observed: "9" }]);
    expect(await concord.reconcileDue()).toBe(0);

    // The missing unit is paid late, inside the window.
    chain.latest = 120;
    chain.push(cash.id, "transfer", 110, { from: treasury, to: h1, amount: u(1) });
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    expect(concord.action(action.id).result).toMatchObject({ status: "clean", breaks: [] });

    // One more pass once the chain is read past the end of the window, then it is left alone.
    chain.latest = 200;
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(1);
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(0);
  });

  it("voids a wrongly entered action and keeps it in the audit trail", async () => {
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "10",
    });
    // A typo in the rate shows as real breaks until the action is voided.
    expect(action.state).toBe("breaks");
    expect(action.openBreaks).toBeGreaterThan(0);
    expect(action.voidedAt).toBeNull();
    expect(concord.assetSummary(concord.asset("FUND")).openBreaks.actions).toBe(action.openBreaks);

    // The reason is mandatory, an unknown id is a 404, and a void cannot be re-entered.
    await expect(concord.voidAction(action.id, "   ")).rejects.toThrow(/reason is required/);
    await expect(concord.voidAction(999, "typo in the rate")).rejects.toThrow(/not found/);
    expect(concord.db.get("SELECT voided_at FROM actions WHERE id = ?", action.id)!.voided_at).toBeNull();

    const voided = await concord.voidAction(action.id, "  typo in the rate ", { id: "u1", label: "ops" });
    expect(voided).toMatchObject({ state: "voided", openBreaks: 0, voidedBy: "ops", voidReason: "typo in the rate" });
    expect(voided.voidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(concord.db.get("SELECT voided_by, void_reason FROM actions WHERE id = ?", action.id)).toMatchObject({
      voided_by: "ops",
      void_reason: "typo in the rate",
    });
    // Its breaks stay on the record, but the action no longer counts as open anywhere.
    expect(voided.result!.breaks.length).toBeGreaterThan(0);
    expect(concord.assetSummary(concord.asset("FUND")).openBreaks.actions).toBe(0);
    await expect(concord.voidAction(action.id, "again")).rejects.toThrow(/already voided/);

    // Never reconciled again, whether asked directly or by the scheduler after a sync.
    const before = concord.action(action.id);
    const rerun = await concord.reconcileAction(action.id);
    expect(rerun).toMatchObject({ state: "voided", reconciledAt: before.reconciledAt, openBreaks: 0 });
    chain.latest = 400;
    chain.push(assetId, "transfer", 300, { from: h1, to: h2, amount: u(1) });
    await concord.syncAll();
    expect(await concord.reconcileDue()).toBe(0);
    expect(concord.action(action.id).reconciledAt).toBe(before.reconciledAt);

    // It still appears in the audit pack, with who voided it and why.
    const pack = concord.auditExport("FUND");
    expect(pack.corporateActions.find((a) => a.id === action.id)).toMatchObject({
      id: action.id,
      openBreaks: 0,
      params: { voided: { by: "ops", reason: "typo in the rate" } },
    });
    expect(validateAuditPack(pack), JSON.stringify(validateAuditPack.errors, null, 2)).toBe(true);

    // A voided action still reaches the breaks export, but contributes no rows.
    const breaksCsv = concord.exportCsv("FUND", "breaks");
    expect(breaksCsv).toContain("UNINSTRUCTED_CONTROL");
    for (const line of breaksCsv.split("\n")) {
      if (line.includes(`dividend ${action.id}`)) expect(line).toBe("source,asOf,scope,type,severity,address,ref,txHash,chainUnits,registerUnits,expected,observed,difference,message,firstSeen,status,note,noteAuthor");
    }

    // The same void can also be requested over HTTP, by the workspace owner.
    const h = harness();
    const client = await new h.Client(h.app).signUp("ops@example.test", "Ops");
    const created = await client.call("/api/assets/FUND/actions", {
      body: { type: "split", recordTime: at(10), num: "2", den: "1" },
    });
    const actionId = (await created.json()).id;
    expect((await created.json()).state).toBe("scheduled");
    await expect(
      client.call(`/api/actions/${actionId}/void`, { method: "POST", body: { reason: "entered in error" } }),
    ).resolves.toMatchObject({ state: "voided", openBreaks: 0, voidedBy: "Test User <ops@example.test>", voidReason: "entered in error" });
    expect(await client.call(`/api/actions/${actionId}/void`, { method: "POST", body: { reason: "again" } })).rejects.toMatchObject({ status: 400 });
    expect(await client.call(`/api/actions/${actionId}/void`, { method: "POST", body: { reason: "  " } })).rejects.toMatchObject({ status: 400 });
    await expect(client.call(`/api/actions/99999/void`, { method: "POST", body: { reason: "x" } })).rejects.toMatchObject({ status: 404 });
    expect((await client.json<{ state: string; openBreaks: number }>(`/api/actions/${actionId}`)).state).toBe("voided");
    expect((await client.json<{ openBreaks: { actions: number } }>("/api/overview")).assets[0]!.openBreaks.actions).toBe(0);

    // The same action over CSV: still in the trail, but no open rows.
    const csv = await client.call(`/api/assets/FUND/export?section=breaks&to=${encodeURIComponent(at(50))}`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text).toContain("UNINSTRUCTED_CONTROL");
    const matches = text.split("\n").filter((line: string) => line.includes(`split ${actionId}`));
    expect(matches).toEqual(["source,asOf,scope,type,severity,address,ref,txHash,chainUnits,registerUnits,expected,observed,difference,message,firstSeen,status,note,noteAuthor"]);
  });

  it("refuses a code shared by two watched assets and a pay asset from another network", async () => {
    await concord.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(() => concord.asset("FUND")).toThrow(/more than one/);
    expect(concord.asset(assetId).id).toBe(assetId);
  });

  it("handles concurrent watchAsset calls gracefully without UNIQUE constraint failure", async () => {
    const assetCode = `CONC:${key()}`;
    const origDescribe = chain.describe?.bind(chain);
    chain.describe = async (candidate) => {
      await new Promise((r) => setTimeout(r, 25));
      return origDescribe ? origDescribe(candidate) : { decimals: 7, name: "Concurrent Test" };
    };

    const [r1, r2] = await Promise.allSettled([
      concord.watchAsset({ network: "testnet", asset: assetCode, fromLedger: 1 }),
      concord.watchAsset({ network: "testnet", asset: assetCode, fromLedger: 1 }),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejections = [r1, r2].filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect((rejections[0] as PromiseRejectedResult).reason).toBeInstanceOf(Invalid);
    expect((rejections[0] as PromiseRejectedResult).reason.message).toContain("is already watched");
  });

  it("validates decimals for classic and contract assets", async () => {
    const classicIssuer = key();
    // Classic asset rejects decimals !== 7
    await expect(
      concord.watchAsset({ network: "testnet", asset: `FAIL:${classicIssuer}`, decimals: 3, fromLedger: 1 }),
    ).rejects.toThrow(new Invalid("classic assets always carry 7 decimals"));

    // Classic asset accepts decimals === 7 and undefined
    const c1 = await concord.watchAsset({ network: "testnet", asset: `OK1:${classicIssuer}`, decimals: 7, fromLedger: 1 });
    expect(c1.decimals).toBe(7);
    const c2 = await concord.watchAsset({ network: "testnet", asset: `OK2:${classicIssuer}`, fromLedger: 1 });
    expect(c2.decimals).toBe(7);

    // Contract token keeps existing 0 to 18 range check
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    await expect(
      concord.watchAsset({ network: "testnet", asset: contractId, decimals: -1, fromLedger: 1 }),
    ).rejects.toThrow(new Invalid("decimals must be 0 to 18"));
    await expect(
      concord.watchAsset({ network: "testnet", asset: contractId, decimals: 19, fromLedger: 1 }),
    ).rejects.toThrow(new Invalid("decimals must be 0 to 18"));
  });

  it("validates Stellar addresses in ignore and exclude lists", async () => {
    const validG = key();
    const validC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const validM = "MAAAAAAAAAAAJRU2"; // valid med25519 or test med25519
    const invalidAddr = "not-an-address";

    // watchAsset rejects invalid address and names it
    await expect(
      concord.watchAsset({ network: "testnet", asset: `BAD1:${key()}`, fromLedger: 1, ignore: [invalidAddr] }),
    ).rejects.toThrow(`ignore contains an invalid Stellar address: "${invalidAddr}"`);

    // watchAsset accepts valid G and C addresses
    const watched = await concord.watchAsset({ network: "testnet", asset: `GOOD:${key()}`, fromLedger: 1, ignore: [validG, validC] });
    expect(watched.ignore).toEqual([validG, validC]);

    // updateAsset rejects invalid address and names it
    expect(() => concord.updateAsset(watched.id, { ignore: [invalidAddr] })).toThrow(
      `ignore contains an invalid Stellar address: "${invalidAddr}"`,
    );

    // createAction rejects invalid address in exclude and names it
    await expect(
      concord.createAction(watched.id, {
        type: "split",
        recordTime: at(10),
        num: "2",
        den: "1",
        exclude: [invalidAddr],
      }),
    ).rejects.toThrow(`exclude contains an invalid Stellar address: "${invalidAddr}"`);
  });
  it("serves the same operations over HTTP, to a signed-in user", async () => {
    const h = harness();
    h.chain.baselineResult = { ledger: 50, openings: new Map() };
    const client = await new Client(h.app).signUp("ops@example.test", "Ops");
    expect((await h.app.request("/api/overview")).status).toBe(401);

    const watched = await client.call("/api/assets", {
      body: { network: "testnet", asset: `FUND:${issuer}`, ignore: [treasury], baseline: false },
    });
    expect(watched.status).toBe(201);
    const ws = h.tenants.forOrg(client.orgId);
    // The route ignores baseline: a classic asset takes opening balances unless a start ledger is given.
    expect(ws.asset("FUND").startMode).toBe("baseline");
    await ws.sync("FUND");
    expect(ws.asset("FUND")).toMatchObject({ state: "ready", baselineLedger: 50 });
    await ws.unwatchAsset("FUND");
    const asset = await ws.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1, ignore: [treasury] });
    h.chain.push(asset.id, "mint", 3, { to: h1, amount: u(100) });
    h.chain.push(asset.id, "mint", 3, { to: h2, amount: u(50) });

    const created = await client.call("/api/assets/FUND/registers", {
      body: { csv: `holder_id,account,units\nA,${h1},90\nB,${h2},50\nC,${h3},oops\n`, asOf: at(40) },
    });
    expect(created.status).toBe(201);
    const { run, issues } = (await created.json()) as {
      run: { id: number; breaks: Array<{ key: string; fingerprint: string }> };
      issues: Array<{ line: number; message: string }>;
    };
    // Holder A is ten short on the register, and so the totals disagree too.
    expect(run.breaks).toHaveLength(2);
    expect(issues).toEqual([expect.objectContaining({ line: 4 })]);

    const noted = await client.call("/api/assets/FUND/notes", {
      method: "PUT",
      body: { scope: "recon", key: run.breaks[0]!.key, fingerprint: run.breaks[0]!.fingerprint, status: "resolved", note: "register corrected", author: "CEO" },
    });
    expect(noted.status).toBe(200);
    const trail = await client.json<Array<{ key: string; status: string; note: string }>>(
      `/api/assets/FUND/notes/history?scope=recon&key=${encodeURIComponent(run.breaks[0]!.key)}`,
    );
    expect(trail).toMatchObject([{ key: run.breaks[0]!.key, status: "resolved", note: "register corrected" }]);
    const again = await client.json<{ breaks: Array<{ noteAuthor: string }> }>(`/api/reconciliations/${run.id}`);
    expect(again.breaks[0]!.noteAuthor).toBe("Test User <ops@example.test>");
    const overview = await client.json<{ networks: string[]; assets: Array<{ code: string; openBreaks: { reconciliation: number } }> }>("/api/overview");
    expect(overview.networks).toEqual(["testnet"]);
    expect(overview.assets[0]).toMatchObject({ code: "FUND", openBreaks: { reconciliation: 1 } });

    expect((await client.call("/api/assets/NOPE/holdings")).status).toBe(404);
    expect((await client.call("/api/assets/FUND/registers", { body: { csv: "x", asOf: "y" } })).status).toBe(400);
    const future = new Date(Date.now() + 6 * 60_000).toISOString();
    const futureRegister = await client.call("/api/assets/FUND/registers", {
      body: { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: future, reconcile: false },
    });
    expect(futureRegister.status).toBe(400);
    expect(await futureRegister.text()).toContain("asOf cannot be more than 5 minutes in the future");
    const csv = await client.call("/api/assets/FUND/export?section=holdings");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain(h1);
    const template = await client.call("/api/templates/register.csv");
    expect(await template.text()).toBe("holder_id,holder_name,account,units,status\n");
  });
});

describe("documented input files", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");

  it("serves optional example rows and rejects unknown templates", async () => {
    const client = await new Client(harness().app).signUp("templates@example.test", "Templates");
    for (const kind of ["register", "journal", "instructions"]) {
      const blank = await (await client.call(`/api/templates/${kind}.csv`)).text();
      for (const example of ["1", "true"]) {
        const res = await client.call(`/api/templates/${kind}?example=${example}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/csv");
        expect(res.headers.get("content-disposition")).toContain(`concord-${kind}-template.csv`);
        const csv = await res.text();
        expect(csv.startsWith(blank)).toBe(true);
        expect(csv.trimEnd().split("\n")).toHaveLength(2);
      }
      const disabled = await client.call(`/api/templates/${kind}.csv?example=false`);
      expect(await disabled.text()).toBe(blank);
    }
    for (const kind of ["unknown", "toString", "__proto__"]) {
      expect((await client.call(`/api/templates/${kind}?example=1`)).status).toBe(404);
    }
  });

  /** The column names in one README Input-files row. Parenthesised value enumerations go. */
  function documentedColumns(row: string): string[] {
    const columnWords = row.replace(/\([^)]*\)/g, "");
    return [...new Set([...columnWords.matchAll(/`([A-Za-z_]+)`/g)].map((m) => m[1]!))].sort();
  }

  it("lists the same columns as the CSV templates the API serves", async () => {
    const client = await new Client(harness().app).signUp("docs@example.test", "Docs");
    const rows = readme.split("\n").filter((line) => line.startsWith("| "));
    const files = [
      ["register", "Register"],
      ["journal", "Journal"],
      ["instructions", "Instructions"],
    ] as const;
    for (const [kind, file] of files) {
      const res = await client.call(`/api/templates/${kind}.csv`);
      expect(res.status, `${kind} template`).toBe(200);
      const headers = (await res.text())
        .trim()
        .split(/\r?\n/)[0]!
        .split(",")
        .map((h) => h.trim())
        .sort();
      const row = rows.find((line) => line.startsWith(`| ${file} |`));
      expect(row, `the README has no ${file} row in its Input files table`).toBeTruthy();
      expect(documentedColumns(row!), `${kind} template vs the README ${file} row`).toEqual(headers);
    }
  });
});

describe("README CLI examples", () => {
  // Guards the README against drift: a command renamed or removed from the usage text,
  // or a flag named in a README example but not in it, fails here.
  const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
  const examples = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((b) => b[1].split("\n"))
    .filter((line) => line.startsWith("pnpm concord"))
    .map((line) => line.replace(/\s+$/, ""));

  const usageCommands = new Set(
    USAGE.split("\n")
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.slice(2).split(/\s+/)[0]!),
  );
  const usageFlags = new Set(USAGE.match(/--[\w-]+/g));

  it("mentions every command the README examples run", () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const line of examples) {
      const command = line.split(/\s+/)[2];
      if (command && !command.startsWith("--")) {
        expect(usageCommands.has(command), `README runs "${command}", but it is not in the CLI usage text`).toBe(true);
      }
    }
  });

  it("names every flag the README examples pass", () => {
    for (const line of examples) {
      for (const flag of line.match(/--[\w-]+/g) ?? []) {
        expect(usageFlags.has(flag), `README example passes "${flag}", but the CLI usage text does not name it`).toBe(true);
      }
    }
  });
});
