/**
 * Regenerates the committed database fixtures used by migrations.test.ts.
 * Run with: pnpm --filter @concord/api exec tsx test/fixtures/make-db-fixtures.ts
 *
 * Each fixture freezes the schema exactly as shipped at one migration count (org-v1.db is
 * ORG_MIGRATIONS.slice(0, 1), and so on) and holds a few rows. When you append a migration, add
 * the matching build() calls below for the new version and commit the files it writes. Do not
 * regenerate an older fixture: a changed fixture hides the regression the test exists to catch.
 */
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ORG_MIGRATIONS, CONTROL_MIGRATIONS } from "../../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "db");
mkdirSync(outDir, { recursive: true });

function build(path: string, migrations: readonly string[], seed: (db: DatabaseSync) => void): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = OFF;");
  for (let i = 0; i < migrations.length; i++) {
    db.exec("BEGIN");
    db.exec(migrations[i]!);
    db.exec(`PRAGMA user_version = ${i + 1}`);
    db.exec("COMMIT");
  }
  db.exec("PRAGMA foreign_keys = ON");
  seed(db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  db.close();
}

build(join(outDir, "org-v1.db"), ORG_MIGRATIONS.slice(0, 1), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v1')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
    VALUES ('e1', 'usd-mainnet', 'transfer', 100, '2024-01-02T00:00:00Z', 'tx1', 'GA', 'GB', '1000', 1)`);
  db.exec(`INSERT INTO openings (asset_id, address, amount, authorized, as_of_ledger)
    VALUES ('usd-mainnet', 'GA', '5000', 1, 90)`);
  db.exec(`INSERT INTO registers (asset_id, as_of, source, sha256, issues, imported_by, imported_at)
    VALUES ('usd-mainnet', '2024-01-03', 'upload', 'abc', '[]', 'u1', '2024-01-03T00:00:00Z')`);
  db.exec(`INSERT INTO register_positions (register_id, holder_id, holder_name, account, units, status)
    VALUES (1, 'h1', 'Holder One', 'GA', '4000', 'ok')`);
});

build(join(outDir, "org-v2.db"), ORG_MIGRATIONS.slice(0, 2), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v2')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO break_notes (asset_id, scope, key, fingerprint, status, note, author, author_id, updated_at)
    VALUES ('usd-mainnet', 'recon', 'SUPPLY_MISMATCH', '10|12', 'resolved', 'corrected', 'bob', 'u2', '2024-01-05T00:00:00Z')`);
  db.exec(`INSERT INTO break_note_history (asset_id, scope, key, fingerprint, status, note, author, author_id, at)
    VALUES ('usd-mainnet', 'recon', 'SUPPLY_MISMATCH', '10|12', 'acknowledged', 'looking', 'alice', 'u1', '2024-01-04T00:00:00Z'),
           ('usd-mainnet', 'recon', 'SUPPLY_MISMATCH', '10|12', 'resolved', 'corrected', 'bob', 'u2', '2024-01-05T00:00:00Z')`);
});

build(join(outDir, "org-v3.db"), ORG_MIGRATIONS.slice(0, 3), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v3')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO registers (id, asset_id, as_of, source, sha256, issues, imported_by, imported_at)
    VALUES (1, 'usd-mainnet', '2024-01-03', 'upload', 'abc', '[]', 'u1', '2024-01-03T00:00:00Z')`);
  db.exec(`INSERT INTO break_notes (asset_id, scope, key, fingerprint, status, note, author, author_id, updated_at)
    VALUES ('usd-mainnet', 'recon', 'K1', '10|12', 'resolved', 'corrected', 'bob', 'u2', '2024-01-05T00:00:00Z')`);
  // One signed-off break and one open one, so the backfilled counters are not trivially equal.
  db.prepare(
    `INSERT INTO runs (asset_id, register_id, as_of, created_by, created_at, summary, status, chain_behind, open_breaks, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "usd-mainnet",
    1,
    "2024-01-03",
    "u1",
    "2024-01-03T00:00:00Z",
    JSON.stringify({ chainSupply: "10", registerTotal: "12", breakCount: 2 }),
    "breaks",
    0,
    1,
    JSON.stringify({
      registerId: 1,
      registerSha256: "abc",
      asOf: "2024-01-03",
      chainLedger: 100,
      chainSyncedAt: "2024-01-03T00:00:00Z",
      chainBehind: false,
      warnings: [],
      status: "breaks",
      summary: { chainSupply: "10", registerTotal: "12", breakCount: 2 },
      lines: [],
      movement: null,
      breaks: [
        { key: "K1", fingerprint: "10|12" },
        { key: "K2", fingerprint: "9|12" },
      ],
    }),
  );
});

build(join(outDir, "control-v1.db"), CONTROL_MIGRATIONS.slice(0, 1), (db) => {
  db.exec(`INSERT INTO users (id, email, name, email_verified, created_at)
    VALUES ('u1', 'alice@example.org', 'Alice', 1, '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO orgs (id, name, created_at) VALUES ('o1', 'Org One', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO memberships (org_id, user_id, role, created_at)
    VALUES ('o1', 'u1', 'owner', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO credentials (user_id, kind, subject, secret, updated_at)
    VALUES ('u1', 'password', NULL, 'scrypt$1$1$1$salt$hash', '2024-01-01T00:00:00Z')`);
});

console.log("Wrote fixtures to", outDir);
