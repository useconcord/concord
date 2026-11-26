import { mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, platform, release, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { replay, type AssetEvent } from "../packages/core/dist/index.js";

/** Deterministic pseudo-random number generator (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const u = (n: number) => BigInt(n) * 10_000_000n;

interface BenchResult {
  count: number;
  timeMs: number;
  rssMB: number;
  heapUsedMB: number;
}

function runReplayBenchmark(counts: number[]): BenchResult[] {
  const rand = mulberry32(0x936936);
  const holders = Array.from({ length: 5000 }, (_, i) => `G${String(i).padStart(55, "0")}`);
  const results: BenchResult[] = [];

  for (const count of counts) {
    if (global.gc) global.gc();
    const events: AssetEvent[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const fromIdx = Math.floor(rand() * holders.length);
      const toIdx = (fromIdx + 1 + Math.floor(rand() * (holders.length - 1))) % holders.length;
      events[i] = {
        id: `${String(i + 1).padStart(12, "0")}-0000000001`,
        kind: "transfer",
        ledger: 1000 + Math.floor(i / 10),
        closedAt: new Date(1700000000000 + i * 500).toISOString(),
        from: holders[fromIdx],
        to: holders[toIdx],
        amount: u(Math.floor(rand() * 100) + 1),
        txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      };
    }

    const t0 = performance.now();
    replay(events);
    const timeMs = performance.now() - t0;
    const mem = process.memoryUsage();
    results.push({
      count,
      timeMs,
      rssMB: Math.round(mem.rss / (1024 * 1024)),
      heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    });
  }

  return results;
}

function measureDatabaseSize(eventCount = 1_000_000): { sizeMB: number; durationMs: number } {
  const tmp = mkdtempSync(join(tmpdir(), "concord-db-bench-"));
  const dbPath = join(tmp, "bench.db");
  const rand = mulberry32(0x936936);
  const holders = Array.from({ length: 5000 }, (_, i) => `G${String(i).padStart(55, "0")}`);

  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE assets (id TEXT PRIMARY KEY);
      INSERT INTO assets (id) VALUES ('BENCH_ASSET');
      CREATE TABLE events (
        id TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ledger INTEGER NOT NULL,
        closed_at TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        from_addr TEXT,
        to_addr TEXT,
        amount TEXT NOT NULL,
        authorized INTEGER,
        PRIMARY KEY (asset_id, id)
      );
    `);

    const insert = db.prepare(`
      INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
      VALUES (?, 'BENCH_ASSET', 'transfer', ?, ?, ?, ?, ?, ?, NULL)
    `);

    const t0 = performance.now();
    const batch = 50_000;
    for (let b = 0; b < eventCount; b += batch) {
      db.exec("BEGIN TRANSACTION");
      for (let i = b; i < b + batch; i++) {
        const fromIdx = Math.floor(rand() * holders.length);
        const toIdx = (fromIdx + 1 + Math.floor(rand() * (holders.length - 1))) % holders.length;
        const id = `${String(i + 1).padStart(12, "0")}-0000000001`;
        const ledger = 1000 + Math.floor(i / 10);
        const closedAt = "2026-10-01T00:00:00.000Z";
        const txHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const amount = String(Math.floor(rand() * 1000000000));
        insert.run(id, ledger, closedAt, txHash, holders[fromIdx], holders[toIdx], amount);
      }
      db.exec("COMMIT");
    }
    const durationMs = performance.now() - t0;
    db.close();

    const sizeBytes = statSync(dbPath).size;
    return { sizeMB: Number((sizeBytes / (1024 * 1024)).toFixed(2)), durationMs };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  console.log("=== Concord Capacity & Scaling Benchmark ===");
  const cpuInfo = cpus();
  const cpuModel = cpuInfo[0]?.model ?? "Unknown CPU";
  const cpuCores = cpuInfo.length;
  const totalRamGB = Math.round(totalmem() / 1e9);
  console.log(`System: ${cpuModel} (${cpuCores} cores), ${totalRamGB} GB RAM, ${platform()} ${release()}`);
  console.log(`Runtime: Node.js ${process.version} (${process.arch})\n`);

  console.log("Running in-memory replay benchmarks (10k, 100k, 1,000,000 events)...");
  const replayResults = runReplayBenchmark([10_000, 100_000, 1_000_000]);

  console.log("\n| Events | Replay Time | Process RSS | Heap Used |");
  console.log("|---|---|---|---|");
  for (const r of replayResults) {
    console.log(`| ${r.count.toLocaleString()} | ${r.timeMs.toFixed(1)} ms | ${r.rssMB} MB | ${r.heapUsedMB} MB |`);
  }

  console.log("\nMeasuring SQLite database footprint for 1,000,000 events...");
  const dbResult = measureDatabaseSize(1_000_000);
  console.log(`1,000,000 events SQLite size: ${dbResult.sizeMB} MB (written in ${(dbResult.durationMs / 1000).toFixed(2)}s)`);

  console.log("\nRPC Calls per Sync Pass per Asset:");
  console.log("  - Chain head lookup: 1 RPC call (getHealth, shared across assets on network)");
  console.log("  - Event pagination: ceil(N / 1000) getEvents RPC calls (page limit = 1000 events)");
  console.log("  - Incremental steady-state (e.g. 50 new events/interval): 1 getEvents RPC call");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
