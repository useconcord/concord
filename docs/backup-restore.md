# Backup and Restoration Operations Runbook

This runbook guides operators through scheduling online backups, transferring snapshots off-site, and safely restoring `control.db` and workspace databases that operate in SQLite Write-Ahead Logging (WAL) mode.

---

## 1. SQLite WAL Mode and Live Backup Safety

Concord stores its application state across SQLite databases within `CONCORD_DATA_DIR` (`services/api/src/config.ts`):
- `control.db`: global accounts, credentials, workspaces, memberships, sessions, and one-time tokens.
- `orgs/<id>.db`: per-workspace database holding watched assets, indexed ledger events, opening balances, imported registers, journals, instructions, reconciliation runs, and audit logs.

### Why plain `cp` of live files is unsafe

Every database is opened in Write-Ahead Logging mode (`PRAGMA journal_mode = WAL` in `services/api/src/db.ts`). While the database is open:
- Writes append to the write-ahead log (`<name>.db-wal`), while reads concurrently consult the shared-memory index (`<name>.db-shm`) and the main database file (`<name>.db`).
- Recent transactions often live exclusively inside `-wal` until a checkpoint occurs.
- Running a raw filesystem copy command (such as `cp`, `rsync`, or archiving a running data directory with `tar`) is not atomic: SQLite pages may be written mid-copy (resulting in torn pages), or `-wal` may become out of sync with `.db`, corrupting the copied database.

### How `concord backup` ensures consistency

Concord provides a built-in operator command:
```sh
pnpm concord backup <destination_dir>
```
This command invokes SQLite's native online backup API (`node:sqlite` `backup()` in `services/api/src/cli.ts`), which safely checkpoints and locks database pages consistently while the Concord server continues serving traffic. It generates standalone `.db` files (`control.db` and `orgs/<id>.db`) where all committed WAL transactions are fully integrated into the snapshot files. No `-wal` or `-shm` files are needed in the backup destination.

---

## 2. Scheduled Backups & Off-Site Storage

### Automated Backups with Cron

Operators should configure scheduled backups (e.g. daily or hourly) using a non-root service account (such as `node` in Docker or `concord` on systemd).

Example cron job (`/etc/cron.d/concord-backup`):
```cron
# Back up Concord databases daily at 02:00 UTC
0 2 * * * concord /usr/local/bin/concord-backup.sh >> /var/log/concord/backup.log 2>&1
```

Example backup script (`/usr/local/bin/concord-backup.sh`):
```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_ROOT="/var/backups/concord"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
ARCHIVE="${BACKUP_ROOT}/concord-${TIMESTAMP}.tar.gz"

mkdir -p "${TARGET_DIR}"

# Run online backup using concord CLI
pnpm --silent --filter @concord/api cli backup "${TARGET_DIR}"

# Create compressed archive
tar -czf "${ARCHIVE}" -C "${BACKUP_ROOT}" "${TIMESTAMP}"
rm -rf "${TARGET_DIR}"

# Example: Sync off-site to S3 / Cloud Storage
# aws s3 cp "${ARCHIVE}" "s3://my-concord-backups/$(basename "${ARCHIVE}")"

# Retention: keep local archives for 14 days
find "${BACKUP_ROOT}" -name "concord-*.tar.gz" -mtime +14 -delete
```

### Docker Compose Example

For containerized deployments, execute the backup inside the container as the `node` user and copy the resulting archive to the host:
```bash
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -u node concord pnpm concord backup "/data/backups/${TIMESTAMP}"
docker compose cp "concord:/data/backups/${TIMESTAMP}" "./backups/${TIMESTAMP}"
docker compose exec -u node concord rm -rf "/data/backups/${TIMESTAMP}"
```

---

## 3. Volume Snapshots

If your infrastructure relies on block-level cloud volume snapshots (e.g., AWS EBS, GCP Persistent Disks, or Render persistent disk snapshots):
- A snapshot taken while the database is actively writing is crash-consistent. When restored, SQLite will attempt WAL recovery using the `-wal` and `-shm` files present on disk at the moment of the snapshot.
- To guarantee clean recovery, prefer scheduling application-level backups with `pnpm concord backup` before taking volume snapshots, or ensure filesystem-level freeze/quiesce if supported by your volume manager.

---

## 4. Step-by-Step Restoration Procedure

When recovering from data loss, disaster, or rolling back a failed upgrade, follow this procedure strictly.

### Step 1: Stop the Concord server
Restoring database files over a running server will cause lock conflicts, corruption, or process crashes. Stop the service first:
```bash
# systemd
sudo systemctl stop concord

# Docker Compose
docker compose stop concord
```

### Step 2: Quarantine existing data
Move the existing data directory aside to preserve evidence or allow rollback if needed:
```bash
mv "$CONCORD_DATA_DIR" "${CONCORD_DATA_DIR}.pre-restore-$(date -u +%s)"
mkdir -p "$CONCORD_DATA_DIR/orgs"
```

### Step 3: Copy backup files into the data directory
Extract or copy `control.db` and all workspace databases (`orgs/*.db`) from the verified backup:
```bash
cp /var/backups/concord/20261120/control.db "$CONCORD_DATA_DIR/control.db"
cp /var/backups/concord/20261120/orgs/*.db "$CONCORD_DATA_DIR/orgs/"
```

> [!WARNING]
> Do NOT copy old `.db-wal` or `.db-shm` files into the restored data directory. Backups produced by `concord backup` are complete, integrated databases. Old `-wal` files from previous runs can corrupt the restored state.

### Step 4: Fix ownership and permissions
Ensure the directory and database files are readable and writable by the user running Concord:
```bash
# Example for a 'concord' or 'node' user
sudo chown -R concord:concord "$CONCORD_DATA_DIR"
chmod 0700 "$CONCORD_DATA_DIR"
chmod 0600 "$CONCORD_DATA_DIR"/control.db "$CONCORD_DATA_DIR"/orgs/*.db
```

### Step 5: Verify database integrity and schema versions
Before launching the service, verify that the databases are undamaged and meet schema version requirements:

1. **Check `control.db`**:
   ```bash
   sqlite3 "$CONCORD_DATA_DIR/control.db" "PRAGMA integrity_check;"
   # Expected output: ok

   sqlite3 "$CONCORD_DATA_DIR/control.db" "PRAGMA user_version;"
   # Must be >= 1 (matching CONTROL_MIGRATIONS in services/api/src/schema.ts)
   ```

2. **Check each workspace database in `orgs/`**:
   ```bash
   for db in "$CONCORD_DATA_DIR"/orgs/*.db; do
     echo "Checking $db:"
     sqlite3 "$db" "PRAGMA integrity_check;"
     sqlite3 "$db" "PRAGMA user_version;"
     sqlite3 "$db" "SELECT * FROM meta WHERE key = 'org_id';"
   done
   ```
   - `PRAGMA integrity_check` must return `ok`.
   - `PRAGMA user_version` must be `>= 1` (matching `ORG_MIGRATIONS`).
   - The `org_id` in the `meta` table must match the file's basename (`<org_id>.db`).

### Step 6: Start the Concord server
```bash
# systemd
sudo systemctl start concord

# Docker Compose
docker compose start concord
```

### Step 7: Verify application health
1. Inspect application logs (`journalctl -u concord -f` or `docker compose logs -f concord`):
   - Confirm successful database initialization with no migration errors.
   - Confirm the RPC indexer resumes syncing.
2. Verify workspaces and assets using the CLI:
   ```bash
   pnpm concord orgs
   pnpm concord assets --org <ORG_ID>
   ```
3. Test web dashboard sign-in and asset holdings to confirm operational continuity.
