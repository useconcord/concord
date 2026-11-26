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

// Freeze the v3 schema for future upgrade-compatibility checks.
build(join(outDir, "org-v3.db"), ORG_MIGRATIONS.slice(0, 3), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v3')");
});

// Freeze the v4 schema for future upgrade-compatibility checks.
build(join(outDir, "org-v4.db"), ORG_MIGRATIONS.slice(0, 4), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v4')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, instruction_window_hours, movement_window_hours, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', 48, 12, '2024-01-01T00:00:00Z')`);
});

build(join(outDir, "org-v5.db"), ORG_MIGRATIONS.slice(0, 5), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v5')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, tolerance, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '5', '2024-01-01T00:00:00Z')`);
});

// v6 adds holdings checkpoints; one row proves the table survives later upgrades.
build(join(outDir, "org-v6.db"), ORG_MIGRATIONS.slice(0, 6), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v6')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO holdings_checkpoints (asset_id, ledger, closed_at, state, created_at)
    VALUES ('usd-mainnet', 100, '2024-01-02T00:00:00Z',
      '{"balances":{"GA":"5000"},"authorized":{"GA":true},"ledger":100,"eventCount":1,"skipped":[]}',
      '2024-01-02T00:00:00Z')`);
});

// v7: runs list columns (summary, status, chain_behind, open_breaks), backfilled from stored result bodies, so listing never parses them
build(join(outDir, "org-v7.db"), ORG_MIGRATIONS.slice(0, 7), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v7')");
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

// v8: an action entered in error is voided rather than deleted, so it keeps its place in the audit trail
build(join(outDir, "org-v8.db"), ORG_MIGRATIONS.slice(0, 8), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v8')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '2024-01-01T00:00:00Z')`);
  // One live action and one voided one, so the new columns survive an upgrade in both states.
  db.exec(`INSERT INTO actions (id, asset_id, type, label, record_time, params, created_by, created_at, voided_at, voided_by, void_reason)
    VALUES (1, 'usd-mainnet', 'dividend', 'Dividend 10 per unit', '2024-01-03T00:00:00Z', '{"ratePerUnit":"10","rounding":"floor","exclude":[]}', 'alice', '2024-01-03T00:00:00Z', NULL, NULL, NULL),
           (2, 'usd-mainnet', 'split', 'Split 2:1', '2024-01-04T00:00:00Z', '{"num":"2","den":"1","exclude":[]}', 'alice', '2024-01-04T00:00:00Z', '2024-01-05T00:00:00Z', 'bob', 'typo in the rate')`);
});

// v9: a break can be owned by one workspace member; the label is stored beside the id so a payload still names the person after they leave
build(join(outDir, "org-v9.db"), ORG_MIGRATIONS.slice(0, 9), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v9')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO break_notes (asset_id, scope, key, fingerprint, status, note, author, author_id, assignee_id, assignee_label, updated_at)
    VALUES ('usd-mainnet', 'recon', 'SUPPLY_MISMATCH', '10|12', 'acknowledged', 'looking', 'alice', 'u1', 'u2', 'Bob <bob@example.org>', '2024-01-04T00:00:00Z')`);
});

// v10: who imported a register, by user id, so the four-eyes rule can compare it with the person signing off
build(join(outDir, "org-v10.db"), ORG_MIGRATIONS.slice(0, 10), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v10')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', '2024-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO registers (id, asset_id, as_of, source, sha256, issues, imported_by, imported_by_id, imported_at)
    VALUES (1, 'usd-mainnet', '2024-01-03', 'upload', 'abc', '[]', 'Alice <alice@example.org>', 'u1', '2024-01-03T00:00:00Z')`);
});

// v11: a dividend's pay asset that nobody watches is watched automatically as a hidden, flow-only asset
build(join(outDir, "org-v11.db"), ORG_MIGRATIONS.slice(0, 11), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v11')");
  db.exec(`INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, flow_only, created_at)
    VALUES ('usd-mainnet', 'mainnet', 'USD', 'GISSUER1', 'US Dollar', 7, 'baseline', 'ready', 1, '2024-01-01T00:00:00Z')`);
});

// v12: keep a change log of corporate action edits before snapshot
build(join(outDir, "org-v12.db"), ORG_MIGRATIONS.slice(0, 12), (db) => {
  db.exec("INSERT INTO meta (key, value) VALUES ('fixture', 'org-v12')");
  db.exec("INSERT INTO assets (id, network, code, name, decimals, start_mode, state, created_at) VALUES ('a1', 'testnet', 'A', 'Asset A', 7, 'baseline', 'ready', '2026-01-01T00:00:00Z')");
  db.exec("INSERT INTO actions (id, asset_id, type, label, record_time, params, created_at) VALUES (1, 'a1', 'dividend', 'Div', '2026-02-01T00:00:00Z', '{}', '2026-01-01T00:00:00Z')");
  db.exec("INSERT INTO action_history (action_id, asset_id, label, record_time, params, at) VALUES (1, 'a1', 'Div', '2026-02-01T00:00:00Z', '{}', '2026-01-01T00:00:00Z')");
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
