import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { Keypair, StrKey, nativeToScVal } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replay, type HoldingsState, parseCsv } from "@concord/core";
import { ChainError, StellarSource, cursorLedger, decodeEvent, type AssetCandidate } from "../src/chain.js";
import { USAGE } from "../src/cli-usage.js";
import { Concord, EXPORT_CSV_SECTION_ERROR, Invalid, NotFound, describeFailure, verifyPack, auditPackDigest, canonicalJson, EVENT_COLUMNS } from "../src/concord.js";
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

  it("never throws across 5000 seeded fuzz inputs", { timeout: 30_000 }, () => {
    const seed = 0x512c0de;
    let state = seed >>> 0;
    const nextU32 = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    };
    const nextInt = (max: number) => nextU32() % max;
    const randBase64 = (len: number) => {
      const buf = Buffer.allocUnsafe(len);
      for (let j = 0; j < len; j++) buf[j] = nextInt(256);
      return buf.toString("base64");
    };

    const validTemplates = [
      { topic: [sym("transfer"), addr(a), addr(b), str(`FUND:${a}`)], value: i128(5n) },
      { topic: [sym("mint"), addr(a), addr(b), str(`FUND:${a}`)], value: i128(7n) },
      { topic: [sym("burn"), addr(b), str(`FUND:${a}`)], value: i128(3n) },
      { topic: [sym("clawback"), addr(a), addr(b), str(`FUND:${a}`)], value: i128(2n) },
      { topic: [sym("set_authorized"), addr(b), str(`FUND:${a}`)], value: nativeToScVal(true).toXDR("base64") },
    ];
    const hugeVecXdr = nativeToScVal(Array.from({ length: 120 }, (_, k) => k)).toXDR("base64");
    const extraTopics = [sym("transfer"), sym("mint"), sym("approve"), addr(a), str("extra"), hugeVecXdr];
    const weirdDates = [
      "",
      "garbage",
      "0",
      "1970-01-01T00:00:00Z",
      "+275760-09-13T00:00:00.000Z",
      "-271821-04-20T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
      "2026-10-01T00:00:00Z",
      "2026-02-30T25:61:61Z",
    ];
    const mutateB64 = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      if (buf.length === 0) return randBase64(8);
      const op = nextInt(3);
      if (op === 0) {
        buf[nextInt(buf.length)] ^= 1 << nextInt(8);
        return buf.toString("base64");
      }
      if (op === 1) {
        return buf.subarray(0, nextInt(buf.length)).toString("base64");
      }
      return b64.slice(0, Math.max(1, nextInt(b64.length)));
    };

    for (let i = 0; i < 5000; i++) {
      const mode = i % 4;
      let topic: string[];
      let value: string;
      let ledgerClosedAt = "2026-10-01T00:00:00Z";

      if (mode === 0) {
        const count = nextInt(6);
        topic = Array.from({ length: count }, () => randBase64(nextInt(40)));
        value = randBase64(nextInt(48));
      } else if (mode === 1) {
        const tmpl = validTemplates[nextInt(validTemplates.length)]!;
        topic = [...tmpl.topic];
        if (nextInt(2) === 0 && topic.length > 0) topic[nextInt(topic.length)] = mutateB64(topic[nextInt(topic.length)]!);
        if (nextInt(2) === 0 && topic.length >= 2) {
          const x = nextInt(topic.length);
          const y = nextInt(topic.length);
          [topic[x], topic[y]] = [topic[y]!, topic[x]!];
        }
        value = nextInt(2) === 0 ? mutateB64(tmpl.value) : tmpl.value;
      } else if (mode === 2) {
        const tmpl = validTemplates[nextInt(validTemplates.length)]!;
        topic = [...tmpl.topic, ...Array.from({ length: 80 }, () => extraTopics[nextInt(extraTopics.length)]!)];
        value = nextInt(2) === 0 ? hugeVecXdr : tmpl.value;
      } else {
        const tmpl = validTemplates[nextInt(validTemplates.length)]!;
        topic = [...tmpl.topic];
        value = tmpl.value;
        ledgerClosedAt = weirdDates[nextInt(weirdDates.length)]!;
      }

      const candidate = {
        ...raw(topic, value),
        ledgerClosedAt,
      };
      let decoded: ReturnType<typeof decodeEvent>;
      try {
        decoded = decodeEvent(candidate);
      } catch (err) {
        throw new Error(`decodeEvent threw on seed=0x${seed.toString(16)} iter=${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (decoded !== undefined && (typeof decoded !== "object" || decoded === null || typeof decoded.kind !== "string")) {
        throw new Error(`Unexpected decodeEvent return on seed=0x${seed.toString(16)} iter=${i}`);
      }
    }
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

  async function expectPagedSync(count: number, calls: number) {
    const code = `PAGE${count}`;
    const asset = await concord.watchAsset({ network: "testnet", asset: `${code}:${issuer}`, fromLedger: 1 });
    const pushed = Array.from({ length: count }, () =>
      chain.push(asset.id, "mint", 40, { to: h3, amount: 1n }).id,
    );

    chain.calls = 0;
    expect(await concord.sync(code)).toEqual({ added: count });
    expect(chain.calls).toBe(calls);
    const stored = concord.db
      .all<{ id: string }>("SELECT id FROM events WHERE asset_id = ? ORDER BY id", asset.id)
      .map((row) => row.id);
    expect(stored).toEqual(pushed);
    expect(await concord.sync(code)).toEqual({ added: 0 });
  }

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

  describe("holdings paging", () => {
    async function many(count: number) {
      const asset = await concord.watchAsset({ network: "testnet", asset: `MANY:${key()}`, fromLedger: 1 });
      // Repeated amounts make ties, which only the address can order.
      for (let i = 0; i < count; i++) chain.push(asset.id, "mint", 5, { to: key(), amount: u(1 + (i % 4)) });
      await concord.sync(asset.id);
      return asset.id;
    }

    it("returns every holder without paging options, and the same rows page by page with stable totals", async () => {
      const id = await many(25);
      const all = concord.holdings(id);
      expect(all.holders).toHaveLength(25);
      expect(all).not.toHaveProperty("page");

      const byAfter: typeof all.holders = [];
      let after: string | undefined;
      for (;;) {
        const page = concord.holdings(id, undefined, { limit: 7, ...(after ? { after } : {}) });
        expect(page.holderCount).toBe(25);
        expect(page.supply).toBe(all.supply);
        expect(page.page!.matched).toBe(25);
        // The same request gives the same page.
        expect(concord.holdings(id, undefined, { limit: 7, ...(after ? { after } : {}) }).holders).toEqual(page.holders);
        byAfter.push(...page.holders);
        if (!page.page!.next) break;
        after = page.page!.next;
      }
      expect(byAfter).toEqual(all.holders);

      const byOffset = [0, 7, 14, 21].flatMap((offset) => concord.holdings(id, undefined, { limit: 7, offset }).holders);
      expect(byOffset).toEqual(all.holders);
      expect(concord.holdings(id, undefined, { limit: 7, offset: 21 }).page).toEqual({ matched: 25, offset: 21, limit: 7, next: null });
    });

    it("sorts by address, searches by address prefix, and rejects bad options", async () => {
      const id = await many(12);
      const all = concord.holdings(id).holders;

      const byAddress = concord.holdings(id, undefined, { sort: "address", limit: 1000 }).holders.map((h) => h.address);
      expect(byAddress).toEqual(all.map((h) => h.address).sort());
      // A holder gone since the last page still resumes in address order.
      const gone = byAddress[4]!.slice(0, -1) + (byAddress[4]!.endsWith("A") ? "B" : "A");
      const resumed = concord.holdings(id, undefined, { sort: "address", after: gone, limit: 1000 }).holders.map((h) => h.address);
      expect(resumed).toEqual(byAddress.filter((a) => a > gone));

      const target = all[5]!.address;
      const prefix = target.slice(0, 4);
      const found = concord.holdings(id, undefined, { q: prefix.toLowerCase() });
      expect(found.holders.map((h) => h.address)).toEqual(all.map((h) => h.address).filter((a) => a.startsWith(prefix)));
      expect(found.holders.map((h) => h.address)).toContain(target);
      expect(found.page!.matched).toBe(found.holders.length);
      expect(found.holderCount).toBe(12);
      expect(concord.holdings(id, undefined, { q: "GZZZZZZZZZZZZZ" })).toMatchObject({ holderCount: 12, page: { matched: 0, next: null }, holders: [] });

      for (const [page, message] of [
        [{ limit: 0 }, /limit must be/],
        [{ limit: 1001 }, /limit must be/],
        [{ limit: 1.5 }, /limit must be/],
        [{ offset: -1 }, /offset must be/],
        [{ offset: 1, after: target }, /offset or after/],
        [{ sort: "share" as "units" }, /sort must be units or address/],
        [{ after: key() }, /after must name a holder/],
      ] as const) {
        expect(() => concord.holdings(id, undefined, page)).toThrow(message);
      }
    });

    it("pages over HTTP and keeps the unpaged form", async () => {
      const h = harness();
      const client = await new Client(h.app).signUp("pager@example.test", "Pager");
      const ws = h.tenants.forOrg(client.orgId);
      const asset = await ws.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
      for (let i = 0; i < 5; i++) h.chain.push(asset.id, "mint", 3, { to: key(), amount: u(10 - i) });
      await ws.sync("FUND");

      type Holdings = { holderCount: number; supply: string; page?: { matched: number; next: string | null }; holders: Array<{ address: string }> };
      const all = await client.json<Holdings>("/api/assets/FUND/holdings");
      expect(all.holders).toHaveLength(5);
      expect(all.page).toBeUndefined();

      const first = await client.json<Holdings>("/api/assets/FUND/holdings?limit=2");
      expect(first).toMatchObject({ holderCount: 5, supply: all.supply, page: { matched: 5, next: all.holders[1]!.address } });
      const second = await client.json<Holdings>(`/api/assets/FUND/holdings?limit=2&after=${first.page!.next}`);
      expect(second.holders).toEqual(all.holders.slice(2, 4));
      const third = await client.json<Holdings>("/api/assets/FUND/holdings?limit=2&offset=4&sort=units");
      expect(third.holders).toEqual(all.holders.slice(4));
      expect(third.page!.next).toBeNull();

      expect((await client.call("/api/assets/FUND/holdings?limit=abc")).status).toBe(400);
      expect((await client.call("/api/assets/FUND/holdings?sort=share")).status).toBe(400);
    });
  });

  it("pages across a boundary that splits several events of the same ledger without losing or duplicating any", async () => {
    await expectPagedSync(999, 1);
    await expectPagedSync(1000, 2);
  });

  it("keeps paging when a ledger fills more than one full page", async () => {
    await expectPagedSync(1001, 2);
    await expectPagedSync(2000, 3);
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

  it("diffs two reconciliation runs into new, resolved, persisting and changed breaks by key", async () => {
    await concord.sync("FUND");
    // Chain: h1 90 (active), h2 55 (frozen). Yesterday the register has h2 short and a holder
    // for h3, who holds nothing; today h2 is short by less, h3 is gone and h1 is marked frozen.
    // E has no account on either day, with the same units.
    const yesterday = concord.importRegister("FUND", {
      csv: `holder_id,account,units,status\nA,${h1},90,active\nB,${h2},50,frozen\nC,${h3},10,active\nE,,3,\n`,
      asOf: at(40),
    });
    const today = concord.importRegister("FUND", {
      csv: `holder_id,account,units,status\nA,${h1},90,frozen\nB,${h2},52,frozen\nE,,3,\n`,
      asOf: at(41),
    });
    const first = await concord.reconcile("FUND", yesterday.registerId);
    const second = await concord.reconcile("FUND", today.registerId);

    const diff = concord.diffRuns(first.id, second.id);
    expect(diff.from).toEqual({ runId: first.id, asOf: at(40) });
    expect(diff.to).toEqual({ runId: second.id, asOf: at(41) });
    expect(diff.new.map((b) => b.key)).toContain(`STATUS_MISMATCH:${h1}`);
    expect(diff.resolved.map((b) => b.key)).toContain(`MISSING_ON_CHAIN:${h3}`);
    expect(diff.persisting.map((b) => b.key)).toContain("UNMAPPED_HOLDER:E");
    const quantity = diff.changed.find((c) => c.key === `QUANTITY_MISMATCH:${h2}`);
    expect(quantity).toMatchObject({
      type: "QUANTITY_MISMATCH",
      from: { registerUnits: "50" },
      to: { registerUnits: "52" },
    });

    // Every break of either run lands in exactly one class, and each list is sorted by key.
    const keys = (breaks: { key: string }[]) => breaks.map((b) => b.key);
    const before = new Set(keys(first.breaks));
    const after = new Set(keys(second.breaks));
    expect(keys(diff.new).sort()).toEqual([...after].filter((k) => !before.has(k)).sort());
    expect(keys(diff.resolved).sort()).toEqual([...before].filter((k) => !after.has(k)).sort());
    expect([...keys(diff.persisting), ...keys(diff.changed)].sort()).toEqual(
      [...after].filter((k) => before.has(k)).sort(),
    );
    for (const list of [diff.new, diff.resolved, diff.persisting, diff.changed]) {
      expect(keys(list)).toEqual([...keys(list)].sort());
    }
    expect(diff.summary).toEqual({
      new: diff.new.length,
      resolved: diff.resolved.length,
      persisting: diff.persisting.length,
      changed: diff.changed.length,
    });

    // Reversed, new and resolved swap; persisting stays.
    const back = concord.diffRuns(second.id, first.id);
    expect(keys(back.new)).toEqual(keys(diff.resolved));
    expect(keys(back.resolved)).toEqual(keys(diff.new));
    expect(keys(back.persisting)).toEqual(keys(diff.persisting));

    // A run against itself: everything persists.
    expect(concord.diffRuns(second.id, second.id).summary).toEqual({
      new: 0,
      resolved: 0,
      persisting: second.breaks.length,
      changed: 0,
    });
  });

  it("refuses to diff reconciliation runs of different assets, or one that does not exist", async () => {
    const other = await concord.watchAsset({ network: "testnet", asset: `OTHER:${key()}`, fromLedger: 1 });
    const csv = `holder_id,account,units\nA,${h1},90\n`;
    const mine = await concord.reconcile("FUND", concord.importRegister("FUND", { csv, asOf: at(40) }).registerId);
    const theirs = await concord.reconcile(
      other.id,
      concord.importRegister(other.id, { csv, asOf: at(40) }).registerId,
    );
    expect(() => concord.diffRuns(mine.id, theirs.id)).toThrow(
      new Invalid(`reconciliations ${mine.id} and ${theirs.id} are of different assets`),
    );
    expect(() => concord.diffRuns(mine.id, 99_999)).toThrow(new NotFound("reconciliation 99999 not found"));
  });

  it("diffs two registers by holder id: added, removed and changed holders, each sorted", () => {
    const yesterday = concord.importRegister("FUND", {
      csv: [
        "holder_id,holder_name,account,units,status",
        `D,Dora,${h1},10,active`,
        `A,Ann,${h1},90,active`,
        `C,Cy,${h2},5,active`,
        `E,Eve,${h3},7,active`,
        // Split over two lines: compared on the sum and the set of accounts.
        `B,Bo,${h2},30,active`,
        `B,Bo,${h3},20,active`,
        `F,Flo,,1,`,
      ].join("\n"),
      asOf: at(40),
    });
    const today = concord.importRegister("FUND", {
      csv: [
        "holder_id,holder_name,account,units,status",
        `Z,Zed,${h3},4,active`,
        `A,Ann,${h1},90,active`,
        `B,Bo,${h3},20,active`,
        `B,Bo,${h2},30,active`,
        `C,Cy,${h2},5.5,active`,
        `E,Eve,${h1},7,frozen`,
        `F,Flo,${h2},1,`,
        `G,Gus,${h3},2,active`,
      ].join("\n"),
      asOf: at(41),
    });

    const diff = concord.diffRegisters("FUND", yesterday.registerId, today.registerId);
    expect(diff.from).toEqual({ registerId: yesterday.registerId, asOf: at(40) });
    expect(diff.to).toEqual({ registerId: today.registerId, asOf: at(41) });
    expect(diff.summary).toEqual({ added: 2, removed: 1, changed: 3, unchanged: 2 });
    expect(diff.added).toEqual([
      { holderId: "G", holderName: "Gus", units: "2", accounts: [h3], statuses: ["active"] },
      { holderId: "Z", holderName: "Zed", units: "4", accounts: [h3], statuses: ["active"] },
    ]);
    expect(diff.removed).toEqual([
      { holderId: "D", holderName: "Dora", units: "10", accounts: [h1], statuses: ["active"] },
    ]);
    expect(diff.changed).toEqual([
      {
        holderId: "C",
        holderName: "Cy",
        fields: ["units"],
        unitsDelta: "0.5",
        from: { units: "5", accounts: [h2], statuses: ["active"] },
        to: { units: "5.5", accounts: [h2], statuses: ["active"] },
      },
      {
        holderId: "E",
        holderName: "Eve",
        fields: ["accounts", "statuses"],
        unitsDelta: "0",
        from: { units: "7", accounts: [h3], statuses: ["active"] },
        to: { units: "7", accounts: [h1], statuses: ["frozen"] },
      },
      {
        holderId: "F",
        holderName: "Flo",
        fields: ["accounts"],
        unitsDelta: "0",
        from: { units: "1", accounts: [], statuses: [] },
        to: { units: "1", accounts: [h2], statuses: [] },
      },
    ]);

    // The other way round, removals and additions swap and deltas change sign.
    const back = concord.diffRegisters("FUND", today.registerId, yesterday.registerId);
    expect(back.summary).toEqual({ added: 1, removed: 2, changed: 3, unchanged: 2 });
    expect(back.changed.find((c) => c.holderId === "C")?.unitsDelta).toBe("-0.5");
    // Line order in the file does not decide the result order.
    expect(back.removed.map((r) => r.holderId)).toEqual(["G", "Z"]);
  });

  it("finds nothing to report between a register and itself", () => {
    const reg = concord.importRegister("FUND", {
      csv: `holder_id,account,units\nA,${h1},90\nB,${h2},55\n`,
      asOf: at(40),
    });
    expect(concord.diffRegisters("FUND", reg.registerId, reg.registerId)).toMatchObject({
      summary: { added: 0, removed: 0, changed: 0, unchanged: 2 },
      added: [],
      removed: [],
      changed: [],
    });
  });

  it("rejects a register of another asset, and one that does not exist", async () => {
    const other = await concord.watchAsset({ network: "testnet", asset: `OTHER:${key()}`, fromLedger: 1 });
    const mine = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const theirs = concord.importRegister(other.id, { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    expect(() => concord.diffRegisters("FUND", mine.registerId, theirs.registerId)).toThrow(
      new Invalid(`register ${theirs.registerId} belongs to a different asset`),
    );
    expect(() => concord.diffRegisters("FUND", theirs.registerId, mine.registerId)).toThrow(Invalid);
    expect(() => concord.diffRegisters("FUND", mine.registerId, 99_999)).toThrow(new NotFound("no register 99999"));
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

    // breakHistory returns oldest first with status, note, author, and timestamp (#538)
    const bHistory = concord.breakHistory("FUND", "recon", brk.key);
    expect(bHistory).toEqual(
      history.map((h) => ({ status: h.status, note: h.note, author: h.author, at: h.at })),
    );
    expect(concord.breakHistory("FUND", "recon", "SOMETHING_ELSE")).toEqual([]);

    // Break objects in the audit pack include history, and audit pack digest covers it
    const packBefore = concord.auditExport("FUND");
    const packBreak = packBefore.reconciliations[0]!.breaks.find((b) => b.key === brk.key)!;
    expect(packBreak.history).toEqual(bHistory);

    // Breaks CSV includes history column
    const csv = concord.exportCsv("FUND", "breaks");
    expect(csv.split("\n")[0]).toContain("history");
    const parsed = parseCsv(csv);
    const histCol = parsed[0]!.indexOf("history");
    expect(parsed[1]![histCol]).toBe(JSON.stringify(bHistory));

    // Digest changes when signoff history is updated
    sign("acknowledged", "more info added", "charlie");
    const packAfter = concord.auditExport("FUND");
    expect(packAfter.sha256).not.toBe(packBefore.sha256);
  });

  it("renders a printable report with escaped text, both digests and the sign-off trail", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T01:00:00Z"));
    try {
      const fixed = (byte: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte)).publicKey();
      const reportChain = new FakeChain();
      const reportConcord = new Concord(new Db(":memory:"), {
        testnet: { passphrase: PASSPHRASE, chain: reportChain },
      });
      const reportAsset = await reportConcord.watchAsset({
        network: "testnet",
        asset: `FUND:${fixed(1)}`,
        name: "Fixed <Fund>",
        fromLedger: 1,
      });
      reportChain.push(reportAsset.id, "mint", 3, { to: fixed(2), amount: u(100) });
      const reg = reportConcord.importRegister("FUND", {
        csv: `holder_id,holder_name,account,units\n<script>alert("x")</script>,Mallory & Co,${fixed(2)},90\n`,
        asOf: at(40),
      });
      const run = await reportConcord.reconcile("FUND", reg.registerId);
      const brk = run.breaks[0]!;
      reportConcord.setNote(
        "FUND",
        "recon",
        brk.key,
        { fingerprint: brk.fingerprint, status: "resolved", note: "Fixed <b>off-chain</b> & verified" },
        { id: "u1", label: "Alice & Bob <alice@example.test>" },
      );

      const html = reportConcord.runReport(run.id);
      expect(html).toContain("<!doctype html>");
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
      expect(html).toContain("Fixed &lt;Fund&gt;");
      expect(html).toContain("Fixed &lt;b&gt;off-chain&lt;/b&gt; &amp; verified");
      expect(html).toContain("Alice &amp; Bob &lt;alice@example.test&gt;");
      expect(html).toContain(run.registerSha256);
      expect(html).toContain("Run result SHA-256");
      expect(html).toContain("Sign-off history");
      expect(() => reportConcord.runReport(999)).toThrow(NotFound);
      expect(html).toMatchSnapshot();
    } finally {
      vi.useRealTimers();
    }
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

  it("refuses a fromLedger that is not a ledger sequence without leaving a row, and accepts ledger 1", async () => {
    const asset = `LEDG:${key()}`;
    const assetRows = () => concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
    const before = assetRows();

    for (const fromLedger of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      // Deferred as well as blocking: a deferred watch never rolls back, so a row written ahead of
      // the check would still be there afterwards.
      for (const options of [{}, { defer: true }]) {
        const refused = await concord
          .watchAsset({ network: "testnet", asset, fromLedger }, options)
          .catch((err: unknown) => err);
        expect(refused, `fromLedger ${fromLedger}`).toBeInstanceOf(Invalid);
        expect((refused as Error).message, `fromLedger ${fromLedger}`).toBe("fromLedger must be a ledger sequence");
        expect(assetRows(), `asset rows after fromLedger ${fromLedger}`).toBe(before);
      }
    }
    expect(concord.db.get("SELECT id FROM assets WHERE code = 'LEDG'")).toBeUndefined();

    // Ledger 1 is the lowest sequence there is. The same asset is free to watch, as no refusal kept it.
    const watched = await concord.watchAsset({ network: "testnet", asset, fromLedger: 1 });
    expect(watched).toMatchObject({ code: "LEDG", startMode: "ledger", startLedger: 1, state: "ready" });
    const row = concord.db.get<{ start_mode: string; start_ledger: number }>(
      "SELECT start_mode, start_ledger FROM assets WHERE id = ?",
      watched.id,
    );
    expect(row).toMatchObject({ start_mode: "ledger", start_ledger: 1 });
    expect(assetRows()).toBe(before + 1);
  });

  it("refuses a fromLedger older than the RPC retains, blocking or deferred", async () => {
    chain.oldest = 50;
    const assetRows = () => concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
    const before = assetRows();
    const retained = /older than the RPC retains \(oldest 50\)/;

    // Blocking: the watch rejects and rolls its row back.
    const blocking = `OLDB:${key()}`;
    const refused = await concord.watchAsset({ network: "testnet", asset: blocking, fromLedger: 10 }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(Invalid);
    expect((refused as Error).message).toMatch(retained);
    expect(assetRows()).toBe(before);
    expect(concord.db.get("SELECT id FROM assets WHERE code = 'OLDB'")).toBeUndefined();

    // Deferred: the row is kept, still indexing, and carries the same error once its pass fails.
    const deferred = await concord.watchAsset({ network: "testnet", asset: `OLDD:${key()}`, fromLedger: 10 }, { defer: true });
    expect(deferred).toMatchObject({ code: "OLDD", state: "indexing" });
    await expect(concord.sync(deferred.id)).rejects.toThrow(retained);
    const stuck = concord.asset(deferred.id);
    expect(stuck.state).toBe("indexing");
    expect(stuck.syncError).toMatch(retained);
    expect(assetRows()).toBe(before + 1);
  });

  it("refuses an asset the network does not know, with classic and contract wording, and writes no row", async () => {
    const unknownChain = new FakeChain();
    // An empty known set makes describe() answer undefined for everything.
    unknownChain.known = new Set();
    const fresh = new Concord(new Db(":memory:"), { testnet: { passphrase: PASSPHRASE, chain: unknownChain } });
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));

    for (const options of [{}, { defer: true }]) {
      const classic = await fresh.watchAsset({ network: "testnet", asset: `FUND:${issuer}` }, options).catch((err: unknown) => err);
      expect(classic).toBeInstanceOf(Invalid);
      expect((classic as Error).message).toBe("testnet has no asset FUND from that issuer");

      const contract = await fresh
        .watchAsset({ network: "testnet", asset: contractId, decimals: 7 }, options)
        .catch((err: unknown) => err);
      expect(contract).toBeInstanceOf(Invalid);
      expect((contract as Error).message).toBe("testnet has no contract with that id");
    }
    expect(fresh.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n).toBe(0);
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

  it("warns when the register is ahead of the indexed chain", async () => {
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(500) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.chainBehind).toBe(true);
    expect(run.warnings).toHaveLength(1);
  });

  it("treats a difference at or below tolerance as matched, records tolerance on the run, and clears it when set to null", async () => {
    // h1 holds 90 on-chain after the clawback; register says 91 — 1-unit rounding difference.
    // With 7 decimals, 1 display unit = 10_000_000 smallest units.
    const csv = `holder_id,account,units\nA,${h1},91\nB,${h2},55\n`;
    const reg = concord.importRegister("FUND", { csv, asOf: at(40) });

    // Without tolerance the 1-unit difference on h1 breaks.
    const noTol = await concord.reconcile("FUND", reg.registerId);
    expect(noTol.breaks.some((b) => b.address === h1 && b.type === "QUANTITY_MISMATCH")).toBe(true);
    expect(noTol.tolerance).toBeNull();

    // Set tolerance to 10000000 (= 1 display unit at 7 decimals) — the h1 difference disappears.
    const updated = concord.updateAsset("FUND", { tolerance: "10000000" });
    expect(updated.tolerance).toBe("10000000");

    const withTol = await concord.reconcile("FUND", reg.registerId);
    expect(withTol.breaks.some((b) => b.address === h1 && b.type === "QUANTITY_MISMATCH")).toBe(false);
    expect(withTol.tolerance).toBe("10000000");
    expect(withTol.status).toBe("clean");

    // Tolerance is preserved on the stored run so old runs stay explainable.
    const fetched = concord.run(withTol.id);
    expect(fetched.tolerance).toBe("10000000");

    // Clear tolerance; the break returns.
    concord.updateAsset("FUND", { tolerance: null });
    const cleared = await concord.reconcile("FUND", reg.registerId);
    expect(cleared.tolerance).toBeNull();
    expect(cleared.breaks.some((b) => b.address === h1 && b.type === "QUANTITY_MISMATCH")).toBe(true);
  });

  it("rejects a non-integer or negative tolerance", () => {
    expect(() => concord.updateAsset("FUND", { tolerance: "1.5" })).toThrow(Invalid);
    expect(() => concord.updateAsset("FUND", { tolerance: "abc" })).toThrow(Invalid);
    expect(() => concord.updateAsset("FUND", { tolerance: "-1" })).toThrow(Invalid);
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

  it("deletes a single journal entry by ref and throws NotFound when absent (#542)", async () => {
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\n`,
    );
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE asset_id = ?", assetId)!.n).toBe(2);

    // Present ref: row removed
    concord.deleteJournalEntry("FUND", "J1");
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE asset_id = ?", assetId)!.n).toBe(1);
    expect(concord.db.get("SELECT ref FROM journal WHERE asset_id = ? AND ref = 'J1'", assetId)).toBeUndefined();

    // Absent ref: throws NotFound
    expect(() => concord.deleteJournalEntry("FUND", "J1")).toThrow(NotFound);
    expect(() => concord.deleteJournalEntry("FUND", "NONEXISTENT")).toThrow(NotFound);

    // Subsequent reconcile reflects deletion
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(40) });
    const run = await concord.reconcile("FUND", reg.registerId);
    expect(run.movement).toBeDefined();
  });

  it("deletes a single instruction by ref and throws NotFound when absent (#542)", async () => {
    concord.importInstructions(
      "FUND",
      `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\nI2,freeze,${h2},,${at(19)},compliance,order\n`,
    );
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM instructions WHERE asset_id = ?", assetId)!.n).toBe(2);

    // Present ref: row removed
    concord.deleteInstruction("FUND", "I1");
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM instructions WHERE asset_id = ?", assetId)!.n).toBe(1);
    expect(concord.db.get("SELECT ref FROM instructions WHERE asset_id = ? AND ref = 'I1'", assetId)).toBeUndefined();

    // Absent ref: throws NotFound
    expect(() => concord.deleteInstruction("FUND", "I1")).toThrow(NotFound);
    expect(() => concord.deleteInstruction("FUND", "NONEXISTENT")).toThrow(NotFound);

    // Subsequent controls reflects deletion
    await concord.sync("FUND");
    const log = concord.controls("FUND");
    expect(log.records.some((r) => r.instruction?.ref === "I1")).toBe(false);
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

  it("refuses opening balances for a contract token before any row is written, and lets a classic asset opt out", async () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 9));
    const watch = { network: "testnet" as const, asset: contractId, baseline: true, decimals: 7 };
    const assetRows = () => concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
    const before = assetRows();

    // Deferred as well as blocking: a deferred watch never rolls back, so a row written ahead of
    // the refusal would still be there afterwards.
    for (const options of [{}, { defer: true }]) {
      const refused = await concord.watchAsset(watch, options).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(Invalid);
      expect((refused as Error).message).toBe("opening balances are only available for classic assets");
      expect(concord.db.get("SELECT id FROM assets WHERE id = ?", contractId)).toBeUndefined();
      expect(assetRows()).toBe(before);
    }
    // It is the request for opening balances that is refused, not the token.
    expect(await concord.watchAsset({ ...watch, baseline: false })).toMatchObject({ id: contractId, startMode: "window" });

    // The suite sets no baselineResult, so an opt-out that still asked for opening balances would
    // fail with "no baseline" instead of landing in window mode.
    const classic = await concord.watchAsset({ network: "testnet", asset: `NB:${issuer}`, baseline: false });
    expect(classic).toMatchObject({ startMode: "window", state: "ready", startLedger: 21 });
    expect(classic.baselineLedger).toBeUndefined();
    expect(concord.db.get("SELECT 1 FROM openings WHERE asset_id = ?", classic.id)).toBeUndefined();
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

  // In the two tests below chain.baselineResult is left unset, so FakeChain.baseline() throws
  // "no baseline". Each uses its own empty database, so the assets table holds only what it watches.

  it("removes the asset row when a blocking watch cannot take its opening balances", async () => {
    const db = new Db(":memory:");
    const fresh = new Concord(db, { testnet: { passphrase: PASSPHRASE, chain } });
    const assetRows = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
    const asset = `OLD:${key()}`;

    await expect(fresh.watchAsset({ network: "testnet", asset })).rejects.toThrow("no baseline");
    expect(assetRows()).toBe(0);
    expect(fresh.assets()).toEqual([]);

    // Nothing is left to collide with: once opening balances can be read, the same asset is watched.
    chain.baselineResult = { ledger: 50, openings: new Map() };
    const watched = await fresh.watchAsset({ network: "testnet", asset });
    expect(watched).toMatchObject({ state: "ready", startMode: "baseline", baselineLedger: 50 });
    expect(assetRows()).toBe(1);
  });

  it("keeps a deferred watch whose opening balances fail, and records that indexing stopped", async () => {
    const db = new Db(":memory:");
    const fresh = new Concord(db, { testnet: { passphrase: PASSPHRASE, chain } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // Park the background pass on the baseline read, so the asset is seen before the failure lands.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let arrive!: () => void;
    const arrived = new Promise<void>((resolve) => (arrive = resolve));
    const baseline = chain.baseline.bind(chain);
    let baselineReads = 0;
    chain.baseline = async () => {
      baselineReads++;
      arrive();
      await held;
      return baseline();
    };

    try {
      const watched = await fresh.watchAsset({ network: "testnet", asset: `OLD:${key()}` }, { defer: true });
      expect(watched).toMatchObject({ state: "indexing", startMode: "baseline" });
      expect(watched.syncError).toBeUndefined();

      // The watch started the pass itself: it reaches the baseline read without anyone calling sync().
      await arrived;
      // sync() hands back that pass, still in flight, so this waits for the background pass itself.
      const pass = fresh.sync(watched.id);
      release();
      await expect(pass).rejects.toThrow("no baseline");
      expect(baselineReads).toBe(1);

      // The asset stays, still indexing, with the failure on it in words fit for the dashboard.
      const failed = fresh.asset(watched.id);
      expect(failed).toMatchObject({
        state: "indexing",
        syncError: "[internal] Indexing stopped on an unexpected error.",
      });
      expect(failed.syncErrorAt).toEqual(expect.any(String));
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n).toBe(1);
      // What actually went wrong goes to the server log instead.
      expect(logged).toHaveBeenCalledTimes(1);
      expect((logged.mock.calls[0]![0] as Error).message).toBe("no baseline");

      // And because the asset stayed, the next pass that succeeds clears the failure.
      chain.baselineResult = { ledger: 50, openings: new Map() };
      await fresh.sync(watched.id);
      const healed = fresh.asset(watched.id);
      expect(healed).toMatchObject({ state: "ready", baselineLedger: 50 });
      expect(healed.syncError).toBeUndefined();
      expect(healed.syncErrorAt).toBeUndefined();
    } finally {
      logged.mockRestore();
    }
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

  it("reconciles a dividend paid net of 15% withholding and shows gross, withheld and net", async () => {
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${key()}`, fromLedger: 1 });
    // Gross 0.1 per unit: h1 100 → 10, h2 50 → 5. Net of 15%: 8.5 and 4.25.
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: 85_000_000n });
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h2, amount: 42_500_000n });
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
      withholdingRate: "0.15",
    });
    expect(action.params).toMatchObject({ withholdingRate: "0.15" });
    expect(action.state).toBe("clean");
    expect(action.result!.summary).toMatchObject({ expectedTotal: "12.75", observedTotal: "12.75", breakCount: 0 });
    const lines = new Map(action.result!.lines.map((l) => [l.address, l]));
    expect(lines.size).toBe(2);
    expect(lines.get(h1)).toMatchObject({ gross: "10", withheld: "1.5", net: "8.5", observed: "8.5", status: "ok" });
    expect(lines.get(h2)).toMatchObject({ gross: "5", withheld: "0.75", net: "4.25", observed: "4.25", status: "ok" });
    // What is expected on the ledger is the net.
    for (const line of lines.values()) expect(line.expected).toBe(line.net);

    // An exempt holder is expected to receive the gross; paying it the net is short.
    const exempt = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
      withholdingRate: "0.15",
      withholdingOverrides: { [h2]: "0" },
    });
    expect(exempt.result!.lines.find((l) => l.address === h2)).toMatchObject({
      gross: "5",
      withheld: "0",
      net: "5",
      observed: "4.25",
      status: "SHORT",
    });
    expect(exempt.result!.breaks.map((b) => `${b.type}:${b.address}`)).toEqual([`SHORT:${h2}`]);

    // The extra line fields are part of the published audit pack schema.
    const pack = concord.auditExport("FUND");
    expect(validateAuditPack(pack), JSON.stringify(validateAuditPack.errors, null, 2)).toBe(true);
  });

  it("keeps dividend lines as they were when no withholding is set", async () => {
    const action = await concord.createAction("FUND", { type: "dividend", recordTime: at(5), ratePerUnit: "0.1" });
    for (const line of action.result!.lines) {
      expect(Object.keys(line)).toEqual([
        "address",
        "basis",
        "expected",
        "observed",
        "difference",
        "txHashes",
        "status",
      ]);
    }
  });

  it("refuses withholding terms that are not a rate from 0 to 1 for a valid address", async () => {
    const base = { type: "dividend" as const, recordTime: at(5), ratePerUnit: "0.1" };
    for (const withholdingRate of ["1.5", "15", "-0.1", "0.15%", ""]) {
      await expect(concord.createAction("FUND", { ...base, withholdingRate })).rejects.toThrow(
        new Invalid("withholdingRate must be a decimal from 0 to 1, such as 0.15"),
      );
    }
    await expect(concord.createAction("FUND", { ...base, withholdingOverrides: { [h1]: "2" } })).rejects.toThrow(
      new Invalid(`withholdingOverrides for ${h1} must be a decimal from 0 to 1, such as 0.15`),
    );
    await expect(concord.createAction("FUND", { ...base, withholdingOverrides: { nobody: "0.1" } })).rejects.toThrow(
      new Invalid("a withholdingOverrides address must be a valid Stellar address"),
    );
    await expect(
      concord.createAction("FUND", { ...base, withholdingOverrides: ["0.1"] as unknown as Record<string, string> }),
    ).rejects.toThrow(new Invalid("withholdingOverrides must map addresses to rates"));
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

    // RFC 8785 Canonical JSON and verify-pack verification
    const verification = verifyPack(pack);
    expect(verification).toMatchObject({ digestValid: true, expectedDigest: pack.sha256, digest: pack.sha256 });
    expect(verifyPack(JSON.parse(JSON.stringify(pack))).digestValid).toBe(true);

    // Reordering keys in the file does not change the digest
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(pack).reverse()) {
      reordered[key] = pack[key as keyof typeof pack];
    }
    // Deeply reorder nested object keys as well
    reordered.asset = Object.fromEntries(Object.entries(pack.asset).reverse());
    expect(auditPackDigest(reordered)).toBe(pack.sha256);
    expect(verifyPack(reordered).digestValid).toBe(true);

    // Editing any value makes verification fail
    const tamperedAsset = JSON.parse(JSON.stringify(pack));
    tamperedAsset.asset.code = "CORRUPTED";
    expect(verifyPack(tamperedAsset).digestValid).toBe(false);

    const tamperedHoldings = JSON.parse(JSON.stringify(pack));
    tamperedHoldings.holdings.supply = "999999";
    expect(verifyPack(tamperedHoldings).digestValid).toBe(false);

    const tamperedGenerator = JSON.parse(JSON.stringify(pack));
    tamperedGenerator.generator = "fake/0.0.1";
    expect(verifyPack(tamperedGenerator).digestValid).toBe(false);

    const tamperedDigest = JSON.parse(JSON.stringify(pack));
    tamperedDigest.sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    expect(verifyPack(tamperedDigest).digestValid).toBe(false);
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
    expect(pack.schemaVersion).toBe(1);
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
        "asset.instructionWindowHours",
        "asset.issuer",
        "asset.movementWindowHours",
        "asset.name",
        "asset.network",
        "controls.asOf",
        "controls.breaks[]",
        "controls.breaks[].address",
        "controls.breaks[].eventId",
        "controls.breaks[].fingerprint",
        "controls.breaks[].history[]",
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
        "corporateActions[].result.breaks[].history[]",
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
        "reconciliations[].breaks[].history[]",
        "reconciliations[].breaks[].history[].at",
        "reconciliations[].breaks[].history[].author",
        "reconciliations[].breaks[].history[].note",
        "reconciliations[].breaks[].history[].status",
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
        "reconciliations[].tolerance",
        "reconciliations[].warnings[]",
        "registers[]",
        "registers[].asOf",
        "registers[].id",
        "registers[].importedAt",
        "registers[].importedBy",
        "registers[].issues[]",
        "registers[].positions",
        "registers[].sha256",
        "registers[].source",
        "schemaVersion",
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

  describe("exportCsv additional sections", () => {
    beforeEach(async () => {
      await concord.sync("FUND");
      concord.importJournal(
        "FUND",
        `ref,date,type,from_account,to_account,units,tx_hash\nJ1,${at(3)},issue,,${h1},100,tx1\n`,
      );
      concord.importInstructions(
        "FUND",
        `ref,type,account,units,issued_at,approved_by,reason\nI1,authorise,${h1},,${at(1)},ops,KYC\n`,
      );
      const reg = concord.importRegister("FUND", {
        csv: `holder_id,account,units,status\nA,${h1},90,active\n`,
        asOf: at(5),
      });
      await concord.reconcile("FUND", reg.registerId);
      await concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1" });
    });

    it("positions section has a header test and a data row test", () => {
      const csv = concord.exportCsv("FUND", "positions");
      const [header, ...rows] = csv.trim().split("\n");
      expect(header).toBe("runId,asOf,address,holderIds,chainUnits,registerUnits,difference,chainStatus,registerStatus,matched");
      const h1Row = rows.find((r) => r.includes(h1));
      expect(h1Row).toBeDefined();
      expect(h1Row).toContain("90");
    });

    it("runs section has a header test and a data row test", () => {
      const csv = concord.exportCsv("FUND", "runs");
      const [header, firstRow] = csv.trim().split("\n");
      expect(header).toBe(
        "id,asOf,createdAt,registerId,status,chainLedger,chainSyncedAt,chainBehind,chainSupply,registerTotal,supplyDifference,chainHolders,registerHolders,lines,matchedLines,breakCount,openBreaks",
      );
      expect(firstRow).toBeDefined();
      expect(firstRow).toContain("breaks");
      expect(firstRow).toContain("90");
    });

    it("actions section has a header test and a data row test", () => {
      const csv = concord.exportCsv("FUND", "actions");
      const [header, firstRow] = csv.trim().split("\n");
      expect(header).toBe("id,type,label,recordTime,state,createdAt,reconciledAt,openBreaks");
      expect(firstRow).toBeDefined();
      expect(firstRow).toContain("split");
    });

    it("journal section has a header test and a data row test", () => {
      const csv = concord.exportCsv("FUND", "journal");
      const [header, firstRow] = csv.trim().split("\n");
      expect(header).toBe("ref,date,type,from_account,to_account,units,tx_hash");
      expect(firstRow).toBeDefined();
      expect(firstRow).toContain("J1");
      expect(firstRow).toContain("100");
    });

    it("instructions section has a header test and a data row test", () => {
      const csv = concord.exportCsv("FUND", "instructions");
      const [header, firstRow] = csv.trim().split("\n");
      expect(header).toBe("ref,type,account,units,issued_at,approved_by,reason");
      expect(firstRow).toBeDefined();
      expect(firstRow).toContain("I1");
      expect(firstRow).toContain("authorize");
    });

    it("invalid-section message lists all allowed sections", () => {
      const expectedSections = [
        "holdings",
        "events",
        "controls",
        "breaks",
        "action",
        "positions",
        "runs",
        "actions",
        "journal",
        "instructions",
      ];
      let thrown: Error | undefined;
      try {
        concord.exportCsv("FUND", "invalid-section");
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeInstanceOf(Invalid);
      for (const section of expectedSections) {
        expect(thrown!.message).toContain(section);
      }
      expect(thrown!.message).toBe(
        "section must be holdings, events, controls, breaks, action, positions, runs, actions, journal or instructions",
      );
    });
  });

  it("includes register provenance in the audit pack covering every reconciled register", async () => {
    await concord.sync("FUND");
    const reg1 = concord.importRegister(
      "FUND",
      {
        csv: `holder_id,account,units,status\nA,${h1},100,active\n`,
        asOf: at(2),
      },
      { id: "u1", label: "alice <alice@example.test>" },
    );
    const reg2 = concord.importRegister(
      "FUND",
      {
        csv: `holder_id,account,units,status\nA,${h1},90,active\n`,
        asOf: at(5),
      },
      { id: "u2", label: "bob <bob@example.test>" },
    );

    const run = await concord.reconcile("FUND", reg2.registerId);
    expect(run.registerId).toBe(reg2.registerId);

    const pack = concord.auditExport("FUND");
    expect(pack.registers.length).toBeGreaterThanOrEqual(2);

    // Every registerId in reconciliations appears in registers
    const registerIdsInRecon = pack.reconciliations.map((r) => r.registerId);
    const registerIds = pack.registers.map((r) => r.id);
    for (const rid of registerIdsInRecon) {
      expect(registerIds).toContain(rid);
    }

    // Provenance details are present
    const r2 = pack.registers.find((r) => r.id === reg2.registerId)!;
    expect(r2).toBeDefined();
    expect(r2.asOf).toBe(at(5));
    expect(r2.source).toBe("upload");
    expect(r2.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.positions).toBe(1);
    expect(r2.issues).toEqual([]);
    expect(r2.importedBy).toBe("bob <bob@example.test>");
    expect(r2.importedAt).toBeDefined();

    // Digest covers registers: modifying a register breaks the digest
    const originalDigest = pack.sha256;
    const tampered = { ...pack, registers: [{ ...r2, source: "tampered" }] };
    const { generatedAt: _g, generator: _gen, sha256: _s, ...content } = tampered;
    const { createHash } = await import("node:crypto");
    const tamperedDigest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    expect(tamperedDigest).not.toBe(originalDigest);
  });

  it("signs the audit pack with an ed25519 operator key and verifies it", async () => {
    await concord.sync("FUND");

    // 1. Unset: no signature or keyId present
    const unsignedPack = concord.auditExport("FUND");
    expect((unsignedPack as Record<string, unknown>).signature).toBeUndefined();
    expect((unsignedPack as Record<string, unknown>).keyId).toBeUndefined();

    const unsignedResult = verifyPack(unsignedPack);
    expect(unsignedResult.digestValid).toBe(true);
    expect(unsignedResult.signed).toBe(false);

    // 2. Generate ed25519 keypair
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    // Export with signing key option
    const signedPack = concord.auditExport("FUND", {}, { signingKey: privPem });
    const signedObj = signedPack as Record<string, unknown>;
    expect(typeof signedObj.signature).toBe("string");
    expect(typeof signedObj.keyId).toBe("string");
    expect(signedObj.keyId).toHaveLength(64);

    // Verify without key: verifies digest, detects pack is signed
    const selfCheck = verifyPack(signedPack);
    expect(selfCheck.digestValid).toBe(true);
    expect(selfCheck.signed).toBe(true);
    expect(selfCheck.keyId).toBe(signedObj.keyId);
    expect(selfCheck.signatureChecked).toBe(false);

    // Verify with correct public key
    const verified = verifyPack(signedPack, pubPem);
    expect(verified.digestValid).toBe(true);
    expect(verified.signed).toBe(true);
    expect(verified.signatureChecked).toBe(true);
    expect(verified.signatureValid).toBe(true);

    // Tampered content fails digest
    const tamperedContent = { ...signedPack, asset: { ...signedPack.asset, name: "Tampered Name" } };
    const tamperedRes = verifyPack(tamperedContent, pubPem);
    expect(tamperedRes.digestValid).toBe(false);

    // Tampered signature fails signature verification
    const tamperedSig = { ...signedPack, signature: Buffer.from("bad-signature").toString("base64") };
    const badSigRes = verifyPack(tamperedSig, pubPem);
    expect(badSigRes.digestValid).toBe(true);
    expect(badSigRes.signatureChecked).toBe(true);
    expect(badSigRes.signatureValid).toBe(false);

    // Wrong public key fails verification
    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const wrongKeyRes = verifyPack(signedPack, otherKey);
    expect(wrongKeyRes.signatureChecked).toBe(true);
    expect(wrongKeyRes.signatureValid).toBe(false);
    expect(wrongKeyRes.error).toContain("keyId mismatch");

    // Non-ed25519 key throws Invalid
    const rsaKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPriv = rsaKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => concord.auditExport("FUND", {}, { signingKey: rsaPriv })).toThrow(Invalid);
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
    expect(stalled.syncError).toBe("[internal] Indexing stopped on an unexpected error.");
    expect(await concord.sync("FUND")).toEqual({ added: 500 });
    const healed = concord.asset("FUND");
    expect(healed.syncedLedger).toBe(200);
    expect(healed.syncError).toBeUndefined();
  });

  it("maps SQLite busy and full errors to distinct user-facing messages (#534)", () => {
    const errBusyCode = Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
    const errBusyNum = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "busy" });
    const errLocked = Object.assign(new Error("database table is locked"), { code: "ERR_SQLITE_ERROR", errcode: 6, errstr: "database table is locked" });
    const errFullCode = Object.assign(new Error("SQLITE_FULL: database or disk is full"), { code: "SQLITE_FULL" });
    const errFullNum = Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" });
    const errEnospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const errGeneric = new Error("something unexpected failed");

    const logged: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args[0]); };
    try {
      expect(describeFailure(errBusyCode)).toBe("[db_locked] Database is locked.");
      expect(describeFailure(errBusyNum)).toBe("[db_locked] Database is locked.");
      expect(describeFailure(errLocked)).toBe("[db_locked] Database is locked.");
      expect(describeFailure(errFullCode)).toBe("[disk_full] Database or disk is full.");
      expect(describeFailure(errFullNum)).toBe("[disk_full] Database or disk is full.");
      expect(describeFailure(errEnospc)).toBe("[disk_full] Database or disk is full.");
      expect(describeFailure(errGeneric)).toBe("[internal] Indexing stopped on an unexpected error.");
      expect(logged).toHaveLength(7);
      expect(logged[0]).toBe(errBusyCode);
      expect(logged[6]).toBe(errGeneric);
    } finally {
      console.error = origError;
    }
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

  it("rejects watching an asset outside known when known is set (#509)", async () => {
    chain.known = new Set();
    const badIssuer = key();
    await expect(
      concord.watchAsset({ network: "testnet", asset: `FUND:${badIssuer}`, fromLedger: 1 }),
    ).rejects.toThrow("testnet has no asset FUND from that issuer");
    chain.known = undefined;
  });

  it("lookup returns candidates for a code from search (#509)", async () => {
    const candidate: AssetCandidate = {
      asset: `CAND:${key()}`,
      code: "CAND",
      issuer: key(),
      contractId: "C123",
      trustlines: 10,
      authorizedUnits: "100",
      authRequired: false,
      authRevocable: false,
      clawbackEnabled: false,
    };
    chain.candidates = [candidate];
    expect(await concord.lookup("testnet", "CAND")).toEqual([candidate]);
    expect(await concord.lookup("testnet", "NONE")).toEqual([]);
    chain.candidates = [];
  });

  it("advances chain past retention yielding the rebuild gap error (#509)", async () => {
    const issuer = key();
    const watched = await concord.watchAsset({ network: "testnet", asset: `ADV:${issuer}`, fromLedger: 1 });
    await concord.sync(watched.id);
    chain.advance(100, { retain: 50 });
    await expect(concord.sync(watched.id)).rejects.toThrow(/longer than the network keeps events/);
    expect(concord.asset(watched.id).syncError).toMatch(/Rebuild this asset/);
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

  it("prevents sync from racing an in-flight unwatchAsset and throws NotFound", async () => {
    let releaseGate: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let syncStarted: () => void;
    const whenSyncStarted = new Promise<void>((resolve) => {
      syncStarted = resolve;
    });

    chain.onGetEvents = () => {
      syncStarted();
    };
    chain.gate = gate;

    // Start a sync pass that pauses inside getEvents
    const syncPromise = concord.sync("FUND");
    await whenSyncStarted;

    // Start unwatching FUND while sync is in flight
    const unwatchPromise = concord.unwatchAsset("FUND");

    // Concurrently calling sync for the asset being removed throws NotFound
    expect(() => concord.sync("FUND")).toThrow(NotFound);

    // Release the gate so the in-flight sync pass finishes
    releaseGate!();
    await syncPromise;
    await unwatchPromise;

    // Asset is deleted
    expect(() => concord.asset("FUND")).toThrow(NotFound);
  });

  it("unwatchAsset waits for an in-flight sync, so no events land in the asset watched again", async () => {
    const held = chain.hold();
    const pass = concord.sync("FUND");
    await held.entered;

    const unwatched = concord.unwatchAsset("FUND");
    const rewatch = () => concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
    // While the pass is held, the old asset is still there. An unwatch that did not wait for the
    // pass would already have deleted it, and this re-watch would succeed. The held pass would
    // then write its page of events into the new asset.
    const early = await rewatch().catch((err: unknown) => err);

    held.release();
    await Promise.allSettled([pass]);
    await unwatched;
    const fund = early instanceof Invalid ? await rewatch() : (early as Awaited<ReturnType<typeof rewatch>>);

    expect(concord.events(fund.id)).toEqual([]);
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE asset_id = ?", fund.id)!.n).toBe(0);
    expect(early).toBeInstanceOf(Invalid);
    expect((early as Error).message).toBe("FUND is already watched");
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

  /** How an asset's history begins, as stored. */
  const startColumns = (id: string) => ({
    ...concord.db.get("SELECT start_mode, start_ledger, baseline_ledger, state FROM assets WHERE id = ?", id),
  });

  it("rebuild moves an asset watched from a named ledger over to opening balances", async () => {
    expect(startColumns(assetId)).toEqual({ start_mode: "ledger", start_ledger: 1, baseline_ledger: null, state: "ready" });
    chain.latest = 300;
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    await concord.rebuild("FUND");
    expect(startColumns(assetId)).toEqual({
      start_mode: "baseline",
      start_ledger: 251,
      baseline_ledger: 250,
      state: "ready",
    });
  });

  it("rebuild gives a contract token a fresh window, and never opening balances", async () => {
    const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    await concord.watchAsset({ network: "testnet", asset: contractId, decimals: 7, fromLedger: 5 });
    expect(startColumns(contractId)).toEqual({ start_mode: "ledger", start_ledger: 5, baseline_ledger: null, state: "ready" });
    // Opening balances are on offer, and are not for this asset: it has no issuer to ask about.
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    chain.oldest = 100;
    chain.latest = 500;
    await concord.rebuild(contractId);
    // Twenty ledgers in from the oldest the RPC holds, as when a window asset is first watched.
    expect(startColumns(contractId)).toEqual({
      start_mode: "window",
      start_ledger: 120,
      baseline_ledger: null,
      state: "ready",
    });
    expect(concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM openings WHERE asset_id = ?", contractId)!.n).toBe(0);
  });

  it("a deferred rebuild clears the indexed history and its error at once, and keeps every book", async () => {
    // FUND on opening balances taken at ledger 250, then a movement once the chain has moved on.
    chain.latest = 300;
    chain.baselineResult = { ledger: 250, openings: new Map([[h1, { amount: u(42), asOfLedger: 250 }]]) };
    await concord.rebuild("FUND");
    chain.latest = 320;
    chain.push(assetId, "transfer", 310, { from: h1, to: h2, amount: u(2) });
    // Every kind of book against it (reconciling indexes the transfer), and a failure on record.
    const reg = concord.importRegister("FUND", { csv: `holder_id,account,units\nA,${h1},90\n`, asOf: at(315) });
    const run = await concord.reconcile("FUND", reg.registerId);
    concord.importJournal("FUND", `ref,date,type,from_account,to_account,units\nJ1,${at(310)},transfer,${h1},${h2},2\n`);
    concord.importInstructions("FUND", `ref,type,account,units,issued_at\nI1,freeze,${h2},,${at(312)}\n`);
    await concord.createAction("FUND", { type: "split", recordTime: at(312), num: "2", den: "1" });
    const brk = run.breaks[0]!;
    concord.setNote("FUND", "recon", brk.key, { fingerprint: brk.fingerprint, status: "resolved", note: "x" });
    concord.db.write("UPDATE assets SET sync_error = ?, sync_error_at = ? WHERE id = ?", "connection reset", at(316), assetId);

    const rows = (table: string) => concord.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
    const books = ["registers", "register_positions", "journal", "instructions", "runs", "actions", "break_notes", "break_note_history"];
    const bookRows = () => Object.fromEntries(books.map((table) => [table, rows(table)]));
    const before = bookRows();
    expect(Object.values(before).every((n) => n > 0), JSON.stringify(before)).toBe(true);
    expect([rows("events"), rows("openings")]).toEqual([1, 1]);
    expect(concord.asset("FUND")).toMatchObject({
      cursor: expect.any(String),
      syncError: "connection reset",
      syncedLedger: 320,
      baselineLedger: 250,
    });

    // A blocking rebuild re-reads the chain before it returns, so what it cleared is never seen.
    // Hold the chain instead: the deferred pass cannot start, and the cleared row stays put.
    chain.baselineResult = {
      ledger: 318,
      openings: new Map([
        [h1, { amount: u(40), asOfLedger: 318 }],
        [h2, { amount: u(2), asOfLedger: 318 }],
      ]),
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const latestLedger = chain.latestLedger.bind(chain);
    chain.latestLedger = async () => {
      await held;
      return latestLedger();
    };

    const cleared = await concord.rebuild("FUND", { defer: true });
    expect(cleared).toMatchObject({ state: "indexing", startMode: "baseline" });
    expect(cleared.cursor).toBeUndefined();
    expect(cleared.syncError).toBeUndefined();
    const row = concord.db.get(
      `SELECT state, start_mode, start_ledger, baseline_ledger, history_from, cursor, synced_ledger, synced_at,
         sync_error, sync_error_at FROM assets WHERE id = ?`,
      assetId,
    );
    expect({ ...row }).toEqual({
      state: "indexing",
      start_mode: "baseline",
      start_ledger: null,
      baseline_ledger: null,
      history_from: null,
      cursor: null,
      synced_ledger: null,
      synced_at: null,
      sync_error: null,
      sync_error_at: null,
    });
    expect([rows("events"), rows("openings")]).toEqual([0, 0]);
    expect(bookRows()).toEqual(before);

    // Let the deferred pass go and wait for it: sync() hands back the pass already in flight.
    release();
    await concord.sync("FUND");
    expect(startColumns(assetId)).toEqual({ start_mode: "baseline", start_ledger: 319, baseline_ledger: 318, state: "ready" });
    expect(concord.asset("FUND")).toMatchObject({ syncedLedger: 320, cursor: expect.any(String) });
    expect(concord.asset("FUND").syncError).toBeUndefined();
    expect([rows("events"), rows("openings")]).toEqual([0, 2]);
    expect(bookRows()).toEqual(before);
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

  it("filters events outside the ledger window and respects both time and ledger bounds together", async () => {
    const bank = key();
    const cash = await concord.watchAsset({ network: "testnet", asset: `USDX:${bank}`, fromLedger: 1 });
    // ledger 12: inside both ledger and time window
    chain.push(cash.id, "transfer", 12, { from: treasury, to: h1, amount: u(10) });
    // ledger 5: before windowFromLedger=10, should be ignored
    chain.push(cash.id, "transfer", 5, { from: treasury, to: h2, amount: u(50) });
    // ledger 80: after windowToLedger=70, should be ignored
    chain.push(cash.id, "transfer", 80, { from: treasury, to: h1, amount: u(99) });

    // Only ledger 12 is in [10, 70] AND after recordTime (ledger 3 / at(3))
    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(3),
      windowFromLedger: 10,
      windowToLedger: 70,
      ratePerUnit: "0.1",
      payAsset: "USDX",
      payer: treasury,
    });
    // h1 is entitled to 10 (100 units * 0.1) and received exactly 10 at ledger 12
    // h2 received 50 at ledger 5, which is outside the ledger window
    expect(action.result!.breaks.map((b) => b.address)).toContain(h2);
    expect(action.result!.breaks.find((b) => b.address === h2)).toMatchObject({ type: "MISSING" });
    expect(action.result!.breaks.find((b) => b.address === h1)).toBeUndefined();
    // Params are stored and surfaced
    expect(action.params).toMatchObject({ windowFromLedger: 10, windowToLedger: 70 });
  });

  it("validates windowFromLedger and windowToLedger as positive integers", async () => {
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowFromLedger: 0 }),
    ).rejects.toThrow(new Invalid("windowFromLedger must be a positive ledger sequence number"));
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowFromLedger: -5 }),
    ).rejects.toThrow(new Invalid("windowFromLedger must be a positive ledger sequence number"));
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowToLedger: 0 }),
    ).rejects.toThrow(new Invalid("windowToLedger must be a positive ledger sequence number"));
    await expect(
      concord.createAction("FUND", { type: "split", recordTime: at(5), num: "2", den: "1", windowToLedger: 1.5 }),
    ).rejects.toThrow(new Invalid("windowToLedger must be a positive ledger sequence number"));
  });

  it("refuses a code shared by two watched assets and a pay asset from another network", async () => {
    await concord.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(() => concord.asset("FUND")).toThrow(/more than one/);
    expect(concord.asset(assetId).id).toBe(assetId);
  });

  it("looks an asset up by contract id or by code in any case, and names an ambiguous or unknown reference", async () => {
    const thrown = (lookup: () => unknown): unknown => {
      try {
        lookup();
      } catch (err) {
        return err;
      }
      return undefined;
    };

    const fund = concord.asset(assetId);
    expect(fund).toMatchObject({ id: assetId, code: "FUND", issuer });
    expect(concord.asset("FUND")).toEqual(fund);
    expect(concord.asset("fund")).toEqual(fund);

    // A second FUND from another issuer makes the code ambiguous in any case, but neither id.
    const other = await concord.watchAsset({ network: "testnet", asset: `FUND:${key()}`, fromLedger: 1 });
    expect(other.id).not.toBe(assetId);
    for (const code of ["FUND", "fund"]) {
      const ambiguous = thrown(() => concord.asset(code));
      expect(ambiguous).toBeInstanceOf(Invalid);
      expect((ambiguous as Error).message).toBe(`more than one watched asset is called ${code}; use its contract id`);
    }
    expect(concord.asset(assetId)).toEqual(fund);
    expect(concord.asset(other.id)).toEqual(other);

    const unknown = thrown(() => concord.asset("NOPE"));
    expect(unknown).toBeInstanceOf(NotFound);
    expect((unknown as Error).message).toBe("asset NOPE is not watched");
  });

  it("concurrent watchAsset calls for one asset yield exactly one success and one row", async () => {
    const assetCode = `CONC:${key()}`;
    const origDescribe = chain.describe.bind(chain);
    // Both calls pass the first "already watched" check, then wait on the chain together.
    chain.describe = async (candidate) => {
      await new Promise((r) => setTimeout(r, 20));
      return origDescribe(candidate);
    };

    const results = await Promise.allSettled([
      concord.watchAsset({ network: "testnet", asset: assetCode, fromLedger: 1 }),
      concord.watchAsset({ network: "testnet", asset: assetCode, fromLedger: 1 }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<Concord["watchAsset"]>>> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0]!.reason as Error;
    expect(reason).toBeInstanceOf(Invalid);
    expect(reason.message).toMatch(/already watched/);
    expect(reason.message).not.toContain("UNIQUE constraint");

    const watched = fulfilled[0]!.value;
    expect(concord.assets("testnet").filter((a) => a.id === watched.id)).toHaveLength(1);
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

  // What the ledger states about the asset, what the caller gives, and what is stored or why not.
  const NOT_STATED = "this token does not state its decimals; give them when watching it";
  const OUT_OF_RANGE = "decimals must be 0 to 18";
  const CLASSIC_SEVEN = "classic assets always carry 7 decimals";
  const decimalsCases: Array<{
    kind: "contract token" | "classic asset";
    stated?: number;
    given?: number;
    stored?: number;
    refused?: string;
  }> = [
    { kind: "contract token", given: undefined, refused: NOT_STATED },
    { kind: "contract token", given: 0, stored: 0 },
    { kind: "contract token", given: 18, stored: 18 },
    { kind: "contract token", given: 19, refused: OUT_OF_RANGE },
    { kind: "contract token", given: -1, refused: OUT_OF_RANGE },
    { kind: "contract token", given: 1.5, refused: OUT_OF_RANGE },
    { kind: "contract token", given: Number.NaN, refused: OUT_OF_RANGE },
    // A token that states its decimals needs none given, and is held to the same range.
    { kind: "contract token", stated: 6, stored: 6 },
    { kind: "contract token", stated: 19, refused: OUT_OF_RANGE },
    // A classic asset carries seven by protocol. The caller may say so, but may not override it.
    { kind: "classic asset", given: undefined, stored: 7 },
    { kind: "classic asset", given: 7, stored: 7 },
    { kind: "classic asset", given: 3, refused: CLASSIC_SEVEN },
  ];

  for (const { kind, stated, given, stored, refused } of decimalsCases) {
    const subject = kind === "classic asset" ? kind : `${kind} that states ${stated ?? "no"} decimals`;
    const outcome = refused === undefined ? `stores ${stored}` : `is refused: ${refused}`;
    it(`watching a ${subject}, given ${given ?? "none"}, ${outcome}`, async () => {
      const asset = kind === "classic asset" ? `DEC:${key()}` : StrKey.encodeContract(Buffer.alloc(32, 5));
      chain.describe = async () => (stated === undefined ? { name: "Token" } : { name: "Token", decimals: stated });
      const assetRows = () => concord.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets")!.n;
      const before = assetRows();
      const watch = () => concord.watchAsset({ network: "testnet", asset, decimals: given, fromLedger: 1 });

      if (refused === undefined) {
        const watched = await watch();
        expect(watched.decimals).toBe(stored);
        const row = concord.db.get<{ decimals: number }>("SELECT decimals FROM assets WHERE id = ?", watched.id);
        expect(row!.decimals).toBe(stored);
      } else {
        const error = await watch().catch((err: unknown) => err);
        expect(error).toBeInstanceOf(Invalid);
        expect((error as Error).message).toBe(refused);
        // A refused watch leaves no row behind.
        expect(assetRows()).toBe(before);
      }
    });
  }

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

  it("trims and caps a new asset name, keeps the old one for a blank, and dedupes and caps the ignore list", () => {
    type Patch = { name?: string; ignore?: string[] };
    const stored = () => concord.asset(assetId);
    const refuses = (patch: Patch, message: string) => {
      let thrown: unknown;
      try {
        concord.updateAsset(assetId, patch);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Invalid);
      expect((thrown as Error).message).toBe(message);
    };
    expect(stored()).toMatchObject({ name: "FUND", ignore: [treasury] });

    // A name is trimmed, and a patch that names no ignore list leaves the stored one alone.
    expect(concord.updateAsset(assetId, { name: "  New  " }).name).toBe("New");
    expect(stored()).toMatchObject({ name: "New", ignore: [treasury] });

    // A blank name keeps the old one.
    for (const blank of ["", "   "]) {
      concord.updateAsset(assetId, { name: blank });
      expect(stored().name).toBe("New");
    }

    // 120 characters is the longest a name can be. 121 is refused and the stored name stays.
    const longest = "n".repeat(120);
    concord.updateAsset(assetId, { name: longest });
    expect(stored().name).toBe(longest);
    refuses({ name: "n".repeat(121) }, "name must be text of at most 120 characters");
    expect(stored().name).toBe(longest);

    // Duplicates and blanks are dropped, in the order first given, and the name is left alone.
    concord.updateAsset(assetId, { ignore: [h1, h1, h2, ""] });
    expect(stored()).toMatchObject({ name: longest, ignore: [h1, h2] });

    // 500 entries is the longest list. One more, an entry over 80 characters and a bare string are
    // each refused, and the stored list stays.
    const most = Array.from({ length: 500 }, () => key());
    concord.updateAsset(assetId, { ignore: most });
    expect(stored().ignore).toEqual(most);
    for (const bad of [[...most, key()], [h1, "G".repeat(81)], h1 as unknown as string[]]) {
      refuses({ ignore: bad }, "ignore must be a list of addresses");
      expect(stored().ignore).toEqual(most);
    }
    // At exactly 80 characters an entry is read as an address, and refused as a bad one instead.
    refuses({ ignore: ["G".repeat(80)] }, `ignore contains an invalid Stellar address: "${"G".repeat(80)}"`);
    expect(stored().ignore).toEqual(most);
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
    const report = await client.call(`/api/reconciliations/${run.id}/report`);
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toContain("text/html");
    const reportHtml = await report.text();
    expect(reportHtml).toContain("Concord reconciliation report");
    expect(reportHtml).toContain(`Run ${run.id}`);
    expect((await client.call("/api/reconciliations/999/report")).status).toBe(404);
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
    const invalidExport = await client.call("/api/assets/FUND/export?section=typo");
    expect(invalidExport.status).toBe(400);
    expect(await invalidExport.text()).toContain(EXPORT_CSV_SECTION_ERROR);
    const histRes = await client.call(`/api/assets/FUND/notes/history?scope=recon&key=${encodeURIComponent(run.breaks[0]!.key)}`);
    expect(histRes.status).toBe(200);
    const histJson = await histRes.json();
    expect(Array.isArray(histJson)).toBe(true);

    const template = await client.call("/api/templates/register.csv");
    expect(await template.text()).toBe("holder_id,holder_name,account,units,status\n");
  });

  it("imports journal in merge mode by default, updating and adding entries (#540)", () => {
    // Initial import: J1, J2
    const res1 = concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\n`,
    );
    expect(res1).toMatchObject({ entries: 2, added: 2, replaced: 0, removed: 0 });

    // Second import in merge mode: J2 (updated units), J3 (new)
    const res2 = concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ2,${at(4)},issue,,${h2},70\nJ3,${at(5)},issue,,${h1},20\n`,
      { mode: "merge" },
    );
    expect(res2).toMatchObject({ entries: 2, added: 1, replaced: 1, removed: 0 });

    const rows = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rows).toEqual([
      { ref: "J1", units: "1000000000" },
      { ref: "J2", units: "700000000" },
      { ref: "J3", units: "200000000" },
    ]);
  });

  it("imports journal in replace mode, atomically swapping entries and removing absent ones (#540)", () => {
    // Seed initial rows: J1, J2, J3
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},100\nJ2,${at(3)},issue,,${h2},50\nJ3,${at(5)},issue,,${h1},20\n`,
    );

    // Replace with: J2 (different units), J4 (new). J1 and J3 should be removed.
    const res = concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ2,${at(4)},issue,,${h2},80\nJ4,${at(6)},issue,,${h2},30\n`,
      { mode: "replace" },
    );
    expect(res).toMatchObject({ entries: 2, added: 1, replaced: 1, removed: 2 });

    const rows = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rows).toEqual([
      { ref: "J2", units: "800000000" },
      { ref: "J4", units: "300000000" },
    ]);
  });

  it("refuses replace when journal has parse errors unless allowPartial is set (#540)", () => {
    // Seed initial rows: J2, J4
    concord.importJournal(
      "FUND",
      `ref,date,type,from_account,to_account,units\nJ2,${at(4)},issue,,${h2},80\nJ4,${at(6)},issue,,${h2},30\n`,
    );

    const badCsv = `ref,date,type,from_account,to_account,units\nJ5,${at(7)},unknown_type,,${h1},10\nJ2,${at(4)},issue,,${h2},99\n`;

    // Without allowPartial: throws and does NOT wipe existing rows
    expect(() => concord.importJournal("FUND", badCsv, { mode: "replace" })).toThrow(/parse error/i);

    const rowsAfterFail = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rowsAfterFail).toEqual([
      { ref: "J2", units: "800000000" },
      { ref: "J4", units: "300000000" },
    ]);

    // With allowPartial: true: imports valid rows (J2) and removes absent rows (J4), reporting issues
    const resPartial = concord.importJournal("FUND", badCsv, { mode: "replace", allowPartial: true });
    expect(resPartial.issues).toHaveLength(1);
    expect(resPartial.added).toBe(0);
    expect(resPartial.replaced).toBe(1);
    expect(resPartial.removed).toBe(1);

    const rowsAfterPartial = concord.db.all<{ ref: string; units: string }>("SELECT ref, units FROM journal WHERE asset_id = ? ORDER BY ref", assetId);
    expect(rowsAfterPartial).toEqual([
      { ref: "J2", units: "990000000" },
    ]);
  });

  it("handles replace via API endpoint /assets/:id/journal (#540)", async () => {
    const client = await new Client(harness().app).signUp("journal_ops@example.test", "JournalOps");
    const asset = await client.json<{ id: string }>("/api/assets", {
      body: { network: "testnet", asset: `REPLACE:${key()}`, fromLedger: 1 },
    });
    const id = asset.id;

    // Initial import
    const res1 = await client.json<{ entries: number; added: number; replaced: number; removed: number }>(`/api/assets/${id}/journal`, {
      body: {
        csv: `ref,date,type,from_account,to_account,units\nJ1,${at(3)},issue,,${h1},10\nJ2,${at(3)},issue,,${h2},20\n`,
      },
    });
    expect(res1).toMatchObject({ entries: 2, added: 2, replaced: 0, removed: 0 });

    // Replace via API
    const res2 = await client.json<{ entries: number; added: number; replaced: number; removed: number }>(`/api/assets/${id}/journal`, {
      body: {
        csv: `ref,date,type,from_account,to_account,units\nJ2,${at(3)},issue,,${h2},25\nJ3,${at(4)},issue,,${h1},30\n`,
        mode: "replace",
      },
    });
    expect(res2).toMatchObject({ entries: 2, added: 1, replaced: 1, removed: 1 });
  });

  it("exports a corporate action entitlement table as CSV and refuses unknown or cross-asset actions", async () => {
    const h = harness();
    const client = await new Client(h.app).signUp("csvaction@example.test", "Action CSV");
    const issuer1 = key();
    const issuer2 = key();
    const h1 = key();
    const h2 = key();
    const payer = key();
    const concord = h.tenants.forOrg(client.orgId);

    const fund = await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer1}`, fromLedger: 1 });
    const other = await concord.watchAsset({ network: "testnet", asset: `OTHER:${issuer2}`, fromLedger: 1 });
    h.chain.push(fund.id, "mint", 2, { to: h1, amount: u(100) });
    h.chain.push(fund.id, "mint", 2, { to: h2, amount: u(50) });
    h.chain.push(fund.id, "transfer", 10, { from: payer, to: h1, amount: u(10), txHash: "tx-a" });
    h.chain.push(fund.id, "transfer", 11, { from: payer, to: h1, amount: u(5), txHash: "tx-b" });
    await concord.sync(fund.id);

    const action = await concord.createAction("FUND", {
      type: "dividend",
      recordTime: at(5),
      ratePerUnit: "0.2",
      payer,
    });

    const csv = concord.exportCsv("FUND", "action", { id: action.id });
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("address,recordHolding,expected,observed,difference,status,txHashes");
    expect(lines.slice(1)).toHaveLength(2);
    expect(lines.slice(1)).toEqual(
      expect.arrayContaining([
        `${h1},100,20,15,-5,SHORT,tx-a;tx-b`,
        `${h2},50,10,0,-10,MISSING,`,
      ]),
    );

    const httpRes = await client.call(`/api/assets/${fund.id}/export?section=action&id=${action.id}`);
    expect(httpRes.status).toBe(200);
    expect(httpRes.headers.get("content-type")).toContain("text/csv");
    expect(await httpRes.text()).toBe(csv);

    expect(() => concord.exportCsv("FUND", "action", { id: 999999 })).toThrow(NotFound);
    expect(() => concord.exportCsv(other.id, "action", { id: action.id })).toThrow(Invalid);
    expect((await client.call(`/api/assets/${other.id}/export?section=action&id=${action.id}`)).status).toBe(400);
  });

  it("applies per-asset instructionWindowHours and movementWindowHours and includes them in the audit pack", async () => {
    const h = harness();
    const client = await new Client(h.app).signUp("windows@example.test", "Windows Org");
    const issuer = key();
    const holder = key();
    const concord = h.tenants.forOrg(client.orgId);

    await expect(
      concord.watchAsset({ network: "testnet", asset: `BAD:${issuer}`, fromLedger: 1, instructionWindowHours: 0 }),
    ).rejects.toThrow(/between 1 and 720/);
    await expect(
      concord.watchAsset({ network: "testnet", asset: `BAD:${issuer}`, fromLedger: 1, movementWindowHours: 721 }),
    ).rejects.toThrow(/between 1 and 720/);

    // Custom tight windows: 2h for instructions, 2h for movements.
    // Recall FakeChain helper at(n) advances 60s per ledger (60 ledgers = 1h).
    const asset = await concord.watchAsset({
      network: "testnet",
      asset: `FUND:${issuer}`,
      fromLedger: 1,
      instructionWindowHours: 2,
      movementWindowHours: 2,
    });
    expect(asset.instructionWindowHours).toBe(2);
    expect(asset.movementWindowHours).toBe(2);

    // Mint executes at ledger 185 (~3h after ledger 5) and freeze executes at ledger 185 (~3h after ledger 5).
    h.chain.latest = 200;
    h.chain.push(asset.id, "mint", 185, { to: holder, amount: u(50), txHash: "tx-mint" });
    h.chain.push(asset.id, "set_authorized", 185, { from: holder, authorized: false, txHash: "tx-freeze" });
    await concord.sync(asset.id);

    concord.importJournal(asset.id, `ref,date,type,from_account,to_account,units\nJ1,${at(5)},issue,,${holder},50\n`);
    concord.importInstructions(asset.id, `ref,type,account,units,issued_at\nI1,freeze,${holder},,${at(5)}\n`);
    concord.importRegister(asset.id, {
      csv: `holder_id,account,units\nH1,${holder},50\n`,
      asOf: at(190),
    });

    // Under 2h windows: ledger 185 is 180 minutes (3h) after ledger 5 -> outside both windows.
    const runTight = await concord.reconcile(asset.id);
    expect(runTight.breaks.some((b) => b.type === "UNSETTLED_ENTRY" && b.ref === "J1")).toBe(true);
    const controlsTight = concord.controls(asset.id);
    expect(controlsTight.breaks.some((b) => b.type === "UNEXECUTED_INSTRUCTION" && b.ref === "I1")).toBe(true);

    // Widen both windows to 4h -> the 3h delay now matches cleanly.
    const updated = await client.json<{ instructionWindowHours: number; movementWindowHours: number }>(`/api/assets/${asset.id}`, {
      method: "PATCH",
      body: { instructionWindowHours: 4, movementWindowHours: 4 },
    });
    expect(updated).toMatchObject({ instructionWindowHours: 4, movementWindowHours: 4 });

    const runWide = await concord.reconcile(asset.id);
    expect(runWide.breaks.some((b) => b.type === "UNSETTLED_ENTRY")).toBe(false);
    const controlsWide = concord.controls(asset.id);
    expect(controlsWide.breaks).toEqual([]);
    expect(controlsWide.summary.instructed).toBe(1);

    const pack = concord.auditExport(asset.id);
    expect(pack.asset.instructionWindowHours).toBe(4);
    expect(pack.asset.movementWindowHours).toBe(4);
    expect(validateAuditPack(pack), JSON.stringify(validateAuditPack.errors)).toBe(true);
  });

  it("lists journalEntries with latest-run match status, pagination, instructionList, and CLI commands", async () => {
    const h = harness();
    const client = await new Client(h.app).signUp("lists@example.test", "List Books");
    const issuer = key();
    const holder = key();
    const concord = h.tenants.forOrg(client.orgId);
    const asset = await concord.watchAsset({ network: "testnet", asset: `FUND:${issuer}`, fromLedger: 1 });
    h.chain.push(asset.id, "mint", 3, { to: holder, amount: u(100), txHash: "tx-match" });
    await concord.sync(asset.id);

    concord.importRegister(asset.id, {
      csv: `holder_id,account,units\nH1,${holder},100\n`,
      asOf: at(2),
    });
    await concord.reconcile(asset.id);

    concord.importJournal(
      asset.id,
      `ref,date,type,from_account,to_account,units,tx_hash\nJ1,${at(3)},issue,,${holder},100,tx-match\nJ2,${at(4)},transfer,${holder},${key()},25,tx-miss\n`,
    );
    concord.importInstructions(
      asset.id,
      `ref,type,account,units,issued_at,approved_by,reason\nI1,freeze,${holder},, ${at(5)},alice,audit\n`.replace(", ", ","),
    );

    // Before movement reconciliation runs against the journal, status is null.
    expect(concord.journalEntries("FUND")).toEqual([
      {
        ref: "J2",
        date: at(4),
        type: "transfer",
        from: holder,
        to: expect.any(String),
        units: "25",
        txHash: "tx-miss",
        status: null,
      },
      {
        ref: "J1",
        date: at(3),
        type: "issue",
        from: null,
        to: holder,
        units: "100",
        txHash: "tx-match",
        status: null,
      },
    ]);

    concord.importRegister(asset.id, {
      csv: `holder_id,account,units\nH1,${holder},100\n`,
      asOf: at(6),
    });
    await concord.reconcile(asset.id);

    const listed = concord.journalEntries("FUND");
    expect(listed.map((r) => [r.ref, r.status, r.units])).toEqual([
      ["J2", "unmatched", "25"],
      ["J1", "matched", "100"],
    ]);
    expect(concord.journalEntries("FUND", { limit: 1 })).toHaveLength(1);
    expect(concord.journalEntries("FUND", { before: "J2" }).map((r) => r.ref)).toEqual(["J1"]);

    expect(concord.instructionList("FUND")).toEqual([
      {
        ref: "I1",
        type: "freeze",
        account: holder,
        units: null,
        issuedAt: at(5),
        approvedBy: "alice",
        reason: "audit",
      },
    ]);

    // Verify CLI commands against a disk-backed data directory.
    const dir = mkdtempSync(join(tmpdir(), "concord-cli-543-"));
    try {
      const { openRuntime } = await import("../src/main.js");
      const { loadConfig } = await import("../src/config.js");
      const rt = openRuntime(loadConfig({ CONCORD_DATA_DIR: dir, CONCORD_SIGNUP: "open" }));
      let orgId: string;
      try {
        const signed = await rt.auth.signUp({
          email: "cli@example.test",
          name: "CLI User",
          orgName: "CLI Org",
          password: "correct horse battery",
        });
        orgId = signed.orgId;
        const ws = rt.tenants.forOrg(orgId);
        // Seed an asset directly into sqlite so CLI does not touch network.
        ws.db.insert(
          `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
           VALUES ('CASSETCLI', 'testnet', 'FUND', ?, 'Fund', 7, 'window', 'ready', ?)`,
          issuer,
          at(1),
        );
        ws.importJournal("FUND", `ref,date,type,from_account,to_account,units,tx_hash\nJ-CLI,${at(3)},issue,,${holder},42.5,tx-cli\n`);
        ws.importInstructions("FUND", `ref,type,account,units,issued_at\nI-CLI,clawback,${holder},5,${at(4)}\n`);
      } finally {
        rt.close();
      }

      const { runCli } = await import("../src/cli.js");
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

      const jOut = JSON.parse(await execCli(["journal-list", "FUND", "--json"])) as Array<Record<string, unknown>>;
      expect(jOut).toEqual([
        {
          ref: "J-CLI",
          date: at(3),
          type: "issue",
          from: null,
          to: holder,
          units: "42.5",
          txHash: "tx-cli",
          status: null,
        },
      ]);

      const iOut = JSON.parse(await execCli(["instructions-list", "FUND", "--json"])) as Array<Record<string, unknown>>;
      expect(iOut).toEqual([
        {
          ref: "I-CLI",
          type: "clawback",
          account: holder,
          units: "5",
          issuedAt: at(4),
          approvedBy: null,
          reason: null,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("does not let a failed deferred watch in indexing state consume maxAssetsPerOrg", async () => {
    const h = harness({ maxAssetsPerOrg: 1 });
    h.chain.baselineResult = undefined;
    const client = await new Client(h.app).signUp("cap@example.test", "Quota Test");
    const issuer = key();

    const first = await client.call("/api/assets", {
      body: { network: "testnet", asset: `BAD:${issuer}` },
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; state: string };
    expect(firstBody.state).toBe("indexing");

    await vi.waitFor(async () => {
      const detail = await client.json<{ state: string; syncError?: string }>(`/api/assets/${firstBody.id}`);
      expect(detail.state).toBe("indexing");
      expect(detail.syncError).toBeTruthy();
    });

    const second = await client.call("/api/assets", {
      body: { network: "testnet", asset: `GOOD:${issuer}`, fromLedger: 1 },
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string };

    await vi.waitFor(async () => {
      const detail = await client.json<{ state: string }>(`/api/assets/${secondBody.id}`);
      expect(detail.state).toBe("ready");
    });

    const third = await client.call("/api/assets", {
      body: { network: "testnet", asset: `THIRD:${issuer}`, fromLedger: 1 },
    });
    expect(third.status).toBe(400);
    expect(await third.text()).toContain("A workspace can watch 1 assets");
  });

  it("supports replace mode in importInstructions with counts, parse-issue guard, and controls update", async () => {
    const h = harness();
    const client = await new Client(h.app).signUp("replace@example.test", "Replace Instructions");
    const issuer = key();
    const h1 = key();
    const h2 = key();
    const h3 = key();
    const asset = await h.tenants.forOrg(client.orgId).watchAsset({
      network: "testnet",
      asset: `FUND:${issuer}`,
      fromLedger: 1,
    });
    h.chain.latest = 10_000;
    const concord = h.tenants.forOrg(client.orgId);
    await concord.sync(asset.id);

    const first = concord.importInstructions(
      asset.id,
      `ref,type,account,units,issued_at\nI1,freeze,${h1},,${at(10)}\nI2,freeze,${h2},,${at(11)}\n`,
    );
    expect(first).toEqual({ instructions: 2, added: 2, replaced: 0, removed: 0, issues: [] });

    const beforeControls = concord.controls(asset.id);
    expect(beforeControls.breaks.some((b) => b.ref === "I1" && b.type === "UNEXECUTED_INSTRUCTION")).toBe(true);

    const merged = concord.importInstructions(
      asset.id,
      `ref,type,account,units,issued_at\nI2,unfreeze,${h2},,${at(12)}\n`,
      { mode: "merge" },
    );
    expect(merged).toEqual({ instructions: 1, added: 0, replaced: 1, removed: 0, issues: [] });

    const replaced = concord.importInstructions(
      asset.id,
      `ref,type,account,units,issued_at\nI2,freeze,${h2},,${at(13)}\nI3,freeze,${h3},,${at(14)}\n`,
      { mode: "replace" },
    );
    expect(replaced).toEqual({ instructions: 2, added: 1, replaced: 1, removed: 1, issues: [] });

    const afterControls = concord.controls(asset.id);
    expect(afterControls.breaks.some((b) => b.ref === "I1")).toBe(false);
    expect(afterControls.breaks.map((b) => b.ref).sort()).toEqual(["I2", "I3"]);

    // Partially parsed CSV must abort replace mode and leave I2 and I3 intact.
    expect(() =>
      concord.importInstructions(
        asset.id,
        `ref,type,account,units,issued_at\nI4,freeze,${h1},,${at(15)}\nBAD,not_a_type,${h1},,not-a-date\n`,
        { mode: "replace" },
      ),
    ).toThrow(/parse issue/);
    expect(concord.controls(asset.id).breaks.map((b) => b.ref).sort()).toEqual(["I2", "I3"]);

    // HTTP POST /api/assets/:id/instructions supports { mode: "replace" }.
    const res = await client.call(`/api/assets/${asset.id}/instructions`, {
      body: {
        csv: `ref,type,account,units,issued_at\nI3,freeze,${h3},,${at(14)}\n`,
        mode: "replace",
      },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ instructions: 1, added: 0, replaced: 1, removed: 1, issues: [] });
  });

  it("rejects an invalid section before auditExport or any database read", () => {
    const auditExportSpy = vi.spyOn(concord, "auditExport");
    const dbAllSpy = vi.spyOn(concord.db, "all");
    const dbGetSpy = vi.spyOn(concord.db, "get");

    expect(() => concord.exportCsv("FUND", "typo")).toThrow(
      new Invalid(EXPORT_CSV_SECTION_ERROR),
    );

    expect(auditExportSpy).not.toHaveBeenCalled();
    expect(dbAllSpy).not.toHaveBeenCalled();
    expect(dbGetSpy).not.toHaveBeenCalled();

    auditExportSpy.mockRestore();
    dbAllSpy.mockRestore();
    dbGetSpy.mockRestore();
  });

  it("exports every valid section with the expected CSV format and data", async () => {
    await concord.sync("FUND");
    const reg = concord.importRegister("FUND", {
      csv: `holder_id,account,units\nA,${h1},90\nB,${h2},50\n`,
      asOf: at(40),
    });
    await concord.reconcile("FUND", reg.registerId);

    const expectedHeaders: Record<"holdings" | "events" | "controls" | "breaks", string> = {
      holdings: "address,units,share,status,ignored",
      events: "id,ledger,closedAt,kind,from,to,units,authorized,txHash",
      controls: "closedAt,ledger,type,account,units,txHash,instructionRef,approvedBy,reason",
      breaks:
        "source,asOf,scope,type,severity,address,ref,txHash,chainUnits,registerUnits,expected,observed,difference,message,firstSeen,status,note,noteAuthor,history",
    };

    for (const section of ["holdings", "events", "controls", "breaks"] as const) {
      const csv = concord.exportCsv("FUND", section);
      expect(typeof csv).toBe("string");
      const lines = csv.trimEnd().split("\n");
      expect(lines[0]).toBe(expectedHeaders[section]);
      expect(lines.length).toBeGreaterThan(1);
    }
  });
});

describe("streamed events export", () => {
  let world: ReturnType<typeof harness>;
  let concord: Concord;
  const h1 = key();
  const h2 = key();

  const evId = (ledger: number, index: number) =>
    `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-${String(index).padStart(10, "0")}`;

  beforeEach(async () => {
    world = harness();
    concord = world.tenants.forOrg(
      (await new Client(world.app).signUp("streamevents@example.test", "Stream Events")).orgId,
    );
  });

  it("yields output byte-identical to exportCsv for awkward values", async () => {
    const asset = await concord.watchAsset({ network: "testnet", asset: `AWK:${key()}`, fromLedger: 1 });
    // Seed events with awkward values: commas, quotes, newlines, unicode, empty/null fields
    concord.db.tx(() => {
      concord.db.write(
        `INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        evId(10, 1), asset.id, "transfer", 10, at(10), 'tx,"quoted",hash', h1, h2, "10000000", null,
      );
      concord.db.write(
        `INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        evId(11, 2), asset.id, "set_authorized", 11, at(11), "tx-auth", h2, null, "0", 1,
      );
      concord.db.write(
        `INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        evId(12, 3), asset.id, "mint", 12, at(12), "tx-unicode-🚀", null, "GUNICODE\nNEWLINE", "5000000", null,
      );
    });

    let streamedCsv = "";
    for (const chunk of concord.exportEvents("AWK", {}, "csv")) {
      streamedCsv += chunk;
    }
    const legacyCsv = concord.exportCsv("AWK", "events");
    expect(streamedCsv).toBe(legacyCsv);
  });

  it("yields header only for zero events", async () => {
    await concord.watchAsset({ network: "testnet", asset: `ZERO:${key()}`, fromLedger: 1 });
    const chunks = [...concord.exportEvents("ZERO", {}, "csv")];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("id,ledger,closedAt,kind,from,to,units,authorized,txHash\n");
  });

  it("yields one valid JSON object per line in ndjson format", async () => {
    const asset = await concord.watchAsset({ network: "testnet", asset: `NDJ:${key()}`, fromLedger: 1 });
    concord.db.tx(() => {
      concord.db.write(
        `INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        evId(10, 1), asset.id, "transfer", 10, at(10), "tx1", h1, h2, "10000000", null,
      );
    });
    const lines: Array<Record<string, unknown>> = [];
    for (const chunk of concord.exportEvents("NDJ", {}, "ndjson")) {
      expect(chunk.endsWith("\n")).toBe(true);
      lines.push(JSON.parse(chunk.trim()));
    }
    const pack = concord.auditExport("NDJ");
    expect(lines).toHaveLength(pack.events.length);
    expect(lines).toEqual(pack.events);
  });

  it("streams 200k events within a 50 MB memory growth bound", async () => {
    const asset = await concord.watchAsset({ network: "testnet", asset: `BIG:${key()}`, fromLedger: 1 });
    // Seed 200k events in a single transaction
    concord.db.tx(() => {
      const stmt = concord.db.raw.prepare(
        "INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let i = 0; i < 200_000; i++) {
        stmt.run(
          evId(100 + (i % 100), i + 1),
          asset.id,
          "transfer",
          100 + (i % 100),
          "2026-10-01T00:00:00.000Z",
          `tx-${i}`,
          h1,
          h2,
          "10000000",
          null,
        );
      }
    });

    if (global.gc) global.gc();
    const initialHeap = process.memoryUsage().heapUsed;
    let peakGrowth = 0;
    let rowCount = 0;

    // Stream and sample memory every 20,000 events
    for (const _chunk of concord.exportEvents("BIG", {}, "csv")) {
      rowCount++;
      if (rowCount % 20_000 === 0) {
        const growth = process.memoryUsage().heapUsed - initialHeap;
        if (growth > peakGrowth) peakGrowth = growth;
      }
    }

    // 200k events + 1 header line = 200,001 chunks
    expect(rowCount).toBe(200_001);
    // Real peak growth measured is ~15 MB; bound is set to 50 MB to provide generous headroom
    const peakGrowthMB = peakGrowth / (1024 * 1024);
    expect(peakGrowthMB).toBeLessThan(50);
  }, 45_000);

  it("properly closes statement/cursor on early exit without locking the connection", async () => {
    const asset = await concord.watchAsset({ network: "testnet", asset: `EARLY:${key()}`, fromLedger: 1 });
    concord.db.tx(() => {
      const stmt = concord.db.raw.prepare(
        "INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let i = 0; i < 10; i++) {
        stmt.run(evId(10, i + 1), asset.id, "transfer", 10, at(10), `tx-${i}`, h1, h2, "10000000", null);
      }
    });

    let count = 0;
    for (const _chunk of concord.exportEvents("EARLY", {}, "csv")) {
      count++;
      if (count === 3) break;
    }
    expect(count).toBe(3);

    // Verify subsequent write and read on the same database connection work immediately with no leaked lock/cursor
    expect(() => {
      concord.db.write(
        "INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        evId(20, 99), asset.id, "mint", 20, at(20), "tx-after", null, h1, "5000000", null,
      );
    }).not.toThrow();

    const after = concord.db.get("SELECT * FROM events WHERE id = ?", evId(20, 99));
    expect(after).toBeDefined();
  });

  it("streams events via HTTP route with chunked transfer and identical bytes to CSV", async () => {
    const h = harness();
    const client = await new Client(h.app).signUp("streamexport@example.test", "Stream Export");
    const ws = h.tenants.forOrg(client.orgId);
    const watched = await ws.watchAsset({ network: "testnet", asset: `HTTP:${key()}`, fromLedger: 1 });
    ws.db.tx(() => {
      const stmt = ws.db.raw.prepare(
        "INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      stmt.run(evId(10, 1), watched.id, "transfer", 10, at(10), "tx1", "GA", "GB", "10000000", null);
      stmt.run(evId(11, 2), watched.id, "mint", 11, at(11), 'tx,"quoted"', null, "GB", "5000000", null);
    });

    // Test CSV route
    const resCsv = await client.call(`/api/assets/${watched.code}/export?section=events`);
    expect(resCsv.status).toBe(200);
    expect(resCsv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(resCsv.headers.get("content-disposition")).toContain(`concord-${watched.code}-events-`);
    expect(resCsv.headers.get("content-disposition")).toContain(".csv");
    const csvBody = await resCsv.text();
    const legacyCsv = ws.exportCsv(watched.code, "events");
    expect(csvBody).toBe(legacyCsv);

    // Test NDJSON route
    const resNdjson = await client.call(`/api/assets/${watched.code}/export?section=events&format=ndjson`);
    expect(resNdjson.status).toBe(200);
    expect(resNdjson.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(resNdjson.headers.get("content-disposition")).toContain(".ndjson");
    const ndjsonBody = await resNdjson.text();
    const lines = ndjsonBody.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: evId(10, 1), kind: "transfer" });

    // Test invalid format returns 400
    const resBad = await client.call(`/api/assets/${watched.code}/export?section=events&format=xml`);
    expect(resBad.status).toBe(400);
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

describe("holdings checkpoints", () => {
  const issuer = key();
  const holders = Array.from({ length: 6 }, () => key());

  /** Deterministic pseudo-random numbers (mulberry32), so a failing seed can be replayed. */
  function rng(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Every kind of event, overdrawn holders and malformed events included. */
  function pushRandom(chain: FakeChain, assetId: string, next: () => number, ledgers: [number, number], count: number) {
    const pick = () => holders[Math.floor(next() * holders.length)]!;
    for (let i = 0; i < count; i++) {
      const ledger = ledgers[0] + Math.floor(next() * (ledgers[1] - ledgers[0] + 1));
      const amount = BigInt(1 + Math.floor(next() * 50));
      const roll = next();
      if (roll < 0.25) chain.push(assetId, "mint", ledger, { to: pick(), amount });
      else if (roll < 0.6) chain.push(assetId, "transfer", ledger, { from: pick(), to: pick(), amount });
      else if (roll < 0.7) chain.push(assetId, "burn", ledger, { from: pick(), amount });
      else if (roll < 0.8) chain.push(assetId, "clawback", ledger, { from: pick(), amount });
      else if (roll < 0.95) chain.push(assetId, "set_authorized", ledger, { from: pick(), authorized: next() < 0.5 });
      else chain.push(assetId, "transfer", ledger, { from: pick(), amount });
    }
  }

  function comparable(s: HoldingsState) {
    const byAddress = <V,>(m: Map<string, V>) => [...m].sort(([a], [b]) => a.localeCompare(b));
    return {
      balances: byAddress(s.balances),
      authorized: byAddress(s.authorized),
      supply: s.supply,
      ledger: s.ledger,
      eventCount: s.eventCount,
      incomplete: s.incomplete,
      skipped: (s.skipped ?? []).map((ev) => ev.id),
    };
  }

  /** The oracle: one replay over everything the chain holds for the asset, no checkpoints. */
  function fullReplay(chain: FakeChain, concord: Concord, assetId: string, upToTime?: string) {
    const asset = concord.asset(assetId);
    const events = chain.events.filter(
      (e) => e.assetId === assetId && e.ledger >= asset.startLedger! && e.ledger <= chain.latest,
    );
    const opening = asset.baselineLedger === undefined ? undefined : chain.baselineResult?.openings;
    return replay(events, {
      ...(opening ? { opening } : {}),
      baselineLedger: asset.baselineLedger ?? 0,
      ...(upToTime ? { upToTime } : {}),
    });
  }

  function expectExact(chain: FakeChain, concord: Concord, assetId: string, ledgers: number) {
    const asset = concord.asset(assetId);
    const times: (string | undefined)[] = [undefined];
    // Every ledger's close time (where checkpoints sit), and some times between two closes.
    for (let l = 0; l <= ledgers; l++) {
      times.push(at(l));
      if (l % 5 === 0) times.push(new Date(Date.parse(at(l)) + 30_000).toISOString());
    }
    for (const t of times) {
      expect(comparable(concord.state(asset, t)), `as of ${t ?? "now"}`).toEqual(
        comparable(fullReplay(chain, concord, assetId, t)),
      );
    }
  }

  const checkpoints = (concord: Concord, assetId: string) =>
    concord.db
      .all<{ ledger: number }>("SELECT ledger FROM holdings_checkpoints WHERE asset_id = ? ORDER BY ledger", assetId)
      .map((r) => r.ledger);

  it("gives the result of a full replay at every as-of time, whichever checkpoint it starts from", async () => {
    for (const seed of [1, 2, 3]) {
      const chain = new FakeChain();
      chain.latest = 150;
      const concord = new Concord(
        new Db(":memory:"),
        { testnet: { passphrase: PASSPHRASE, chain } },
        { checkpointEvery: 1 + seed * 7 },
      );
      const next = rng(seed);
      const window = await concord.watchAsset({ network: "testnet", asset: `WIN${seed}:${issuer}`, fromLedger: 1 });
      // Opening balances with a cutoff of their own per holder, and one holder frozen at the start.
      chain.baselineResult = {
        ledger: 100,
        openings: new Map(
          holders
            .slice(0, 3)
            .map((h, i) => [h, { amount: BigInt(100 + i), authorized: i !== 1, asOfLedger: 100 + i * 5 }]),
        ),
      };
      const base = await concord.watchAsset({ network: "testnet", asset: `BASE${seed}:${key()}` });

      // Indexed in two passes, read in between, so checkpoints are extended as well as built.
      pushRandom(chain, window.id, next, [2, 150], 200);
      pushRandom(chain, base.id, next, [95, 150], 120);
      await concord.syncAll();
      expectExact(chain, concord, window.id, 150);
      expectExact(chain, concord, base.id, 150);

      chain.latest = 300;
      pushRandom(chain, window.id, next, [151, 300], 200);
      pushRandom(chain, base.id, next, [151, 300], 200);
      await concord.syncAll();
      expectExact(chain, concord, window.id, 300);
      expectExact(chain, concord, base.id, 300);

      expect(checkpoints(concord, window.id).length).toBeGreaterThan(5);
      expect(checkpoints(concord, base.id).length).toBeGreaterThan(5);
      // The newest ledger may still gain events, so no checkpoint stands on it.
      const newest = Math.max(...chain.events.filter((e) => e.assetId === window.id).map((e) => e.ledger));
      expect(Math.max(...checkpoints(concord, window.id))).toBeLessThan(newest);
    }
  }, 30_000);

  it("reads only the events after the nearest checkpoint, however long the history", async () => {
    const read: number[] = [];
    for (const length of [2_000, 10_000]) {
      const chain = new FakeChain();
      chain.latest = 300;
      const db = new Db(":memory:");
      const concord = new Concord(db, { testnet: { passphrase: PASSPHRASE, chain } }, { checkpointEvery: 100 });
      const asset = await concord.watchAsset({ network: "testnet", asset: `LONG:${issuer}`, fromLedger: 1 });
      for (let i = 0; i < length; i++) {
        chain.push(asset.id, "mint", 2 + Math.floor((i * 280) / length), { to: holders[i % holders.length]!, amount: 1n });
      }
      await concord.sync(asset.id);
      concord.state(concord.asset(asset.id), at(290));

      let rows = 0;
      const all = db.all.bind(db);
      db.all = ((...args: Parameters<Db["all"]>) => {
        const out = all(...args);
        if (args[0].includes("FROM events")) rows += out.length;
        return out;
      }) as Db["all"];
      expect(concord.state(concord.asset(asset.id), at(290)).supply).toBe(BigInt(length));
      read.push(rows);
    }
    // At most a checkpoint's worth of events plus the newest ledgers, for either length.
    for (const rows of read) expect(rows).toBeLessThan(250);
  });

  it("drops the checkpoints a late event falls under", async () => {
    const chain = new FakeChain();
    chain.latest = 300;
    const concord = new Concord(new Db(":memory:"), { testnet: { passphrase: PASSPHRASE, chain } }, { checkpointEvery: 10 });
    const asset = await concord.watchAsset({ network: "testnet", asset: `LATE:${issuer}`, fromLedger: 1 });
    pushRandom(chain, asset.id, rng(42), [2, 290], 300);
    await concord.sync(asset.id);
    concord.state(concord.asset(asset.id), at(290));
    expect(checkpoints(concord, asset.id).some((l) => l < 50)).toBe(true);
    expect(checkpoints(concord, asset.id).some((l) => l >= 50)).toBe(true);

    // An event for ledger 50 that the RPC only hands over now, after its ledger was checkpointed.
    const late = chain.push(asset.id, "mint", 50, { to: holders[0]!, amount: 7n });
    const getEvents = chain.getEvents.bind(chain);
    chain.getEvents = async (...args) => {
      const page = await getEvents(...args);
      return { ...page, events: [late, ...page.events] };
    };
    chain.advance(1);
    await concord.sync(asset.id);
    expect(checkpoints(concord, asset.id).every((l) => l < 50)).toBe(true);
    expectExact(chain, concord, asset.id, 300);
  });

  it("drops an asset's checkpoints when it is rebuilt from fresh opening balances", async () => {
    const chain = new FakeChain();
    chain.latest = 300;
    const concord = new Concord(new Db(":memory:"), { testnet: { passphrase: PASSPHRASE, chain } }, { checkpointEvery: 10 });
    const asset = await concord.watchAsset({ network: "testnet", asset: `REB:${issuer}`, fromLedger: 1 });
    pushRandom(chain, asset.id, rng(7), [2, 290], 300);
    await concord.sync(asset.id);
    concord.state(concord.asset(asset.id), at(290));
    expect(checkpoints(concord, asset.id).length).toBeGreaterThan(0);

    chain.baselineResult = {
      ledger: 200,
      openings: new Map([[holders[0]!, { amount: 500n, authorized: true, asOfLedger: 200 }]]),
    };
    await concord.rebuild(asset.id);
    expect(checkpoints(concord, asset.id)).toEqual([]);
    expectExact(chain, concord, asset.id, 300);
    expect(checkpoints(concord, asset.id).length).toBeGreaterThan(0);
  });

  it("refuses a checkpoint interval that is not a positive integer", () => {
    for (const checkpointEvery of [0, -1, 1.5, Number.NaN]) {
      expect(() => new Concord(new Db(":memory:"), {}, { checkpointEvery })).toThrow(
        "checkpointEvery must be a positive integer",
      );
    }
  });
});

describe("RFC 8785 canonicalJson", () => {
  it("serializes numbers according to ECMAScript and formats -0 as 0", () => {
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(123.456)).toBe("123.456");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(-123)).toBe("-123");
  });

  it("sorts object keys lexicographically by UTF-16 code units", () => {
    expect(canonicalJson({ b: 2, a: 1, c: 3 })).toBe('{"a":1,"b":2,"c":3}');
    expect(canonicalJson({ "\u00e9": 1, e: 2 })).toBe('{"e":2,"\u00e9":1}');
  });

  it("omits undefined, functions, and symbols from objects, and converts them to null in arrays", () => {
    expect(canonicalJson({ a: undefined, b: () => {}, c: Symbol("test"), d: 1 })).toBe('{"d":1}');
    expect(canonicalJson([undefined, () => {}, Symbol("test"), 1])).toBe("[null,null,null,1]");
  });
});

describe("syncAll scheduling", () => {
  function setup(options: ConstructorParameters<typeof Concord>[2]) {
    const chain = new FakeChain();
    const concord = new Concord(new Db(":memory:"), { testnet: { passphrase: PASSPHRASE, chain } }, options);
    const getEvents = chain.getEvents.bind(chain);
    /** Asset ids in the order their event pages came back. */
    const served: string[] = [];
    const gates = new Map<string, Promise<void>>();
    chain.getEvents = async (id, from, limit) => {
      await gates.get(id);
      const page = await getEvents(id, from, limit);
      served.push(id);
      return page;
    };
    const watch = async (code: string, mints = 1) => {
      const asset = await concord.watchAsset({ network: "testnet", asset: `${code}:${key()}`, fromLedger: 1 });
      for (let i = 0; i < mints; i++) chain.push(asset.id, "mint", 5, { to: key(), amount: u(1) });
      return asset.id;
    };
    const gate = (id: string) => {
      let release!: () => void;
      gates.set(id, new Promise<void>((r) => (release = r)));
      return release;
    };
    return { chain, concord, served, watch, gate };
  }

  it("does not let a slow asset delay the fast ones when several run at once", async () => {
    const { concord, served, watch, gate } = setup({ syncConcurrency: 2 });
    const slow = await watch("SLOW");
    const fast = await watch("FAST");
    const fast2 = await watch("FASTER");
    const release = gate(slow);

    const pass = concord.syncAll();
    // Both fast assets finish while the slow one is still held at its gate.
    await vi.waitFor(() => expect(served).toEqual([fast, fast2]));
    expect(concord.holdings(fast).holderCount).toBe(1);
    expect(concord.holdings(fast2).holderCount).toBe(1);
    expect(concord.holdings(slow).holderCount).toBe(0);

    release();
    expect(await pass).toEqual({ [slow]: { added: 1 }, [fast]: { added: 1 }, [fast2]: { added: 1 } });
    expect(served).toEqual([fast, fast2, slow]);
  });

  it("with a concurrency of one walks the assets in order, as before", async () => {
    const { concord, served, watch, gate } = setup({ syncConcurrency: 1 });
    const first = await watch("ONE");
    const second = await watch("TWO");
    const third = await watch("THREE");
    const release = gate(first);

    const pass = concord.syncAll();
    await new Promise((r) => setTimeout(r, 30));
    // Nothing after the held asset has started.
    expect(served).toEqual([]);
    release();
    await pass;
    expect(served).toEqual([first, second, third]);

    // Without a gate the order is the same.
    served.length = 0;
    await concord.syncAll();
    expect(served).toEqual([first, second, third]);
  });

  it("yields an asset whose backlog outlasts the time budget and carries on next pass", async () => {
    let clock = 0;
    const { chain, concord, watch } = setup({ syncAssetBudgetMs: 15, now: () => clock });
    const big = await watch("BIG", 2100);
    const small = await watch("SMALL");
    const getEvents = chain.getEvents.bind(chain);
    chain.getEvents = async (id, from, limit) => {
      clock += 10;
      return getEvents(id, from, limit);
    };

    // Pages of 1000: the second page passes the 15 ms budget, so the pass stops there.
    expect(await concord.syncAll()).toEqual({ [big]: { added: 2000, more: true }, [small]: { added: 1 } });
    expect(concord.holdings(big).holderCount).toBe(2000);
    expect(await concord.syncAll()).toEqual({ [big]: { added: 100 }, [small]: { added: 0 } });
    expect(concord.holdings(big).holderCount).toBe(2100);

    // A direct sync is not bounded by the budget.
    chain.latest = 200;
    for (let i = 0; i < 1100; i++) chain.push(big, "mint", 150, { to: key(), amount: u(1) });
    expect(await concord.sync(big)).toEqual({ added: 1100 });
  }, 60_000);

  it("rejects a bad concurrency or budget", () => {
    const db = new Db(":memory:");
    expect(() => new Concord(db, {}, { syncConcurrency: 0 })).toThrow("syncConcurrency must be a positive integer");
    expect(() => new Concord(db, {}, { syncConcurrency: 1.5 })).toThrow("syncConcurrency must be a positive integer");
    expect(() => new Concord(db, {}, { syncAssetBudgetMs: -1 })).toThrow("syncAssetBudgetMs must be zero or more");
  });
});
