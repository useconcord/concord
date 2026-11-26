import { nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { ChainSource } from "../src/chain.js";
import { FakeChain, createScriptedStellarSource, key } from "./helpers.js";

/**
 * Shared ChainSource contract test suite.
 *
 * This contract establishes the baseline invariants and behaviors that any
 * ChainSource implementation (FakeChain, StellarSource, or future sources) must satisfy:
 * - `latestLedger` shape and monotonic boundaries.
 * - Paging with `limit` returns an opaque continuation cursor.
 * - Progressing with a cursor returns subsequent events without duplication.
 * - An empty page at the network tip returns a cursor not behind the previous cursor.
 *
 * Add any new behaviors that all chain sources must honor to this suite.
 */
export function chainSourceContract(
  name: string,
  makeSource: () => Promise<{ source: ChainSource; contractId: string }> | { source: ChainSource; contractId: string },
) {
  describe(`ChainSource contract: ${name}`, () => {
    it("reports latestLedger conforming to ChainHead shape", async () => {
      const { source } = await makeSource();
      const head = await source.latestLedger();

      expect(typeof head.latest).toBe("number");
      expect(typeof head.oldest).toBe("number");
      expect(Number.isInteger(head.latest)).toBe(true);
      expect(Number.isInteger(head.oldest)).toBe(true);
      expect(head.latest).toBeGreaterThanOrEqual(head.oldest);
      if (head.oldestClosedAt !== undefined) {
        expect(new Date(head.oldestClosedAt).toISOString()).toBe(head.oldestClosedAt);
      }
    });

    it("paging with limit returns a cursor", async () => {
      const { source, contractId } = await makeSource();
      const page = await source.getEvents(contractId, { startLedger: 1 }, 2);

      expect(page.cursor).toBeDefined();
      expect(typeof page.cursor).toBe("string");
      expect(page.events.length).toBeLessThanOrEqual(2);
      expect(typeof page.latestLedger).toBe("number");
    });

    it("a cursor continues to the next page without duplicating events", async () => {
      const { source, contractId } = await makeSource();
      const page1 = await source.getEvents(contractId, { startLedger: 1 }, 2);
      expect(page1.cursor).toBeDefined();
      expect(page1.events.length).toBe(2);

      const page2 = await source.getEvents(contractId, { cursor: page1.cursor! }, 2);
      expect(page2.events.length).toBeGreaterThan(0);

      const page1Ids = new Set(page1.events.map((e) => e.id));
      for (const ev of page2.events) {
        expect(page1Ids.has(ev.id)).toBe(false);
      }
    });

    it("an empty page at the tip returns a cursor not behind the previous cursor", async () => {
      const { source, contractId } = await makeSource();
      const page1 = await source.getEvents(contractId, { startLedger: 1 }, 2);
      const page2 = await source.getEvents(contractId, { cursor: page1.cursor! }, 2);
      const tipPage = await source.getEvents(contractId, { cursor: page2.cursor! }, 2);

      expect(tipPage.events).toHaveLength(0);
      expect(tipPage.cursor).toBeDefined();
      expect(tipPage.cursor! >= page2.cursor!).toBe(true);
    });
  });
}

// ── Run against FakeChain ───────────────────────────────────────────────────

chainSourceContract("FakeChain", () => {
  const contractId = "C_FAKE_CONTRACT";
  const fake = new FakeChain();
  const a = key();
  const b = key();

  fake.push(contractId, "transfer", 10, { from: a, to: b, amount: 100n });
  fake.push(contractId, "transfer", 11, { from: a, to: b, amount: 200n });
  fake.push(contractId, "transfer", 12, { from: a, to: b, amount: 300n });
  fake.latest = 20;

  return { source: fake, contractId };
});

// ── Run against StellarSource with scripted fetch ───────────────────────────

chainSourceContract("StellarSource (scripted fetch)", () => {
  const contractId = "C_STELLAR_CONTRACT";
  const a = key();
  const b = key();

  const sym = (s: string) => nativeToScVal(s, { type: "symbol" }).toXDR("base64");
  const addr = (s: string) => nativeToScVal(s, { type: "address" }).toXDR("base64");
  const str = (s: string) => nativeToScVal(s).toXDR("base64");
  const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" }).toXDR("base64");

  const makeRaw = (ledger: number, seq: number, amount: bigint) => {
    const toid = (BigInt(ledger) << 32n).toString().padStart(19, "0");
    return {
      id: `${toid}-${String(seq).padStart(10, "0")}`,
      ledger,
      ledgerClosedAt: new Date(Date.now() + ledger * 60_000).toISOString(),
      contractId,
      txHash: `tx_${ledger}_${seq}`,
      topic: [sym("transfer"), addr(a), addr(b), str(`ASSET:${a}`)],
      value: i128(amount),
    };
  };

  const rawEvents = [
    makeRaw(10, 1, 100n),
    makeRaw(11, 1, 200n),
    makeRaw(12, 1, 300n),
  ];

  return createScriptedStellarSource({
    contractId,
    rawEvents,
    latestLedger: 20,
    oldestLedger: 1,
  });
});
