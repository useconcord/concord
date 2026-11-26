# Capacity and Scaling Notes

This document describes how event count, holder count, and synchronization intervals translate into memory, disk, and RPC load in Concord, based on empirical benchmarks.

---

## Benchmark Environment & Machine Specs

Measurements were performed using the benchmark script committed at [`scripts/capacity.mts`](../scripts/capacity.mts):

- **Processor:** Intel(R) Core(TM) i7-8850H CPU @ 2.60GHz (12 vCPUs)
- **Memory:** 16 GB (17 GB total physical RAM)
- **Operating System:** Windows 10 / 11 x64 (`win32 10.0.26200`)
- **Runtime:** Node.js v24.19.0 (V8 engine)
- **Storage:** NVMe SSD (SQLite WAL mode)

---

## Measured Performance & Scaling

### 1. In-Memory Replay and Memory Footprint

`replay()` (`packages/core/src/holdings.ts`) is a pure in-memory calculation that processes sorted events to compute balances, supply, and authorization states:

| Event Count | Replay Time | Process RSS | Heap Used | Throughput |
|---|---|---|---|---|
| **10,000** | ~20 ms | ~89 MB | ~15 MB | ~500,000 events/sec |
| **100,000** | ~118 ms | ~181 MB | ~63 MB | ~845,000 events/sec |
| **1,000,000** | ~1,200 ms | ~640 MB | ~475 MB | ~830,000 events/sec |

#### Memory Scaling Takeaways:
- **Heap efficiency:** Processing a full million-event ledger history requires less than 500 MB of heap memory.
- **Process RSS:** A Concord instance replaying 1M events comfortably fits within ~650 MB of resident memory (RSS).
- **Holdings memoization:** `Concord` caches computed `HoldingsState` in memory (`services/api/src/concord.ts#L270`), invalidating only when the database changes. Memoized holdings (a map of addresses to 64-bit/128-bit balances) take only ~200–400 KB per 5,000 holders.

---

### 2. SQLite Database Footprint on Disk

Events and opening balances are stored in per-workspace SQLite databases under `data/orgs/<orgId>.db`:

| Metric | Measured Value | Notes |
|---|---|---|
| **Database File Size (1,000,000 events)** | **~322 MB** | Includes table data and composite `(asset_id, id)` index |
| **Storage Density** | **~320 bytes / event** | Reflects event metadata, addresses, ledger sequence, amounts, and hashes |
| **Insert Throughput** | **~78,000 events / sec** | Evaluated with batch transactions (50k events per commit in WAL mode) |

#### Disk Scaling Takeaways:
- A high-activity asset generating 1,000 events per day adds only ~320 KB of disk storage per day (~115 MB per year).
- Standard SQLite WAL mode (`PRAGMA journal_mode = WAL`) keeps transactions snappy and non-blocking for dashboard readers while indexing writes proceed in the background.

---

### 3. RPC Call Volume and Sync Interval

Concord queries Soroban RPC using `getEvents` and `getHealth`:

- **Network Head Lookup (`getHealth`):**
  - **1 RPC call per network per sync pass**, cached for 2 seconds across all assets on that network (`services/api/src/chain.ts#L428`).
- **Event Pagination (`getEvents`):**
  - Events are paged in batches of up to 1,000 (`limit = 1000`, `services/api/src/concord.ts#L608`).
  - Total RPC calls for indexing $N$ new events: $\lceil N / 1000 \rceil$.
- **Steady-State Synchronization:**
  - For normal assets with low-to-medium throughput (e.g. 1 to 500 new events within one `CONCORD_SYNC_INTERVAL`), indexing takes **exactly 1 RPC call** per asset per interval.
- **Backfill Synchronization:**
  - Indexing a backlog of 100,000 events requires 100 sequential RPC calls. At standard RPC latencies (~50–150ms per round-trip), an asset catches up 100k events in ~10–15 seconds.

---

## Reproducing the Benchmark

To re-run the benchmark on any target server or developer machine:

```sh
node scripts/capacity.mts
```

The script benchmarks synthetic event sets using deterministic seeded data (`mulberry32`), creates an isolated SQLite test database in a temporary directory, prints system metrics, and cleans up after itself.
