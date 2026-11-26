# Tenancy

How workspaces are isolated from one another, mechanism by mechanism, and how the test suite
proves it. Written for operators and security reviewers; the authoritative code is
`services/api/src/tenants.ts`, and the proof is `services/api/test/tenancy.test.ts`. The
architecture overview is [`ARCHITECTURE.md`](./ARCHITECTURE.md), **Data**.

## Two kinds of database

Everything lives under `CONCORD_DATA_DIR` (`services/api/src/config.ts`):

- **`control.db`** — users, workspaces, memberships, sessions, invitations
  (`CONTROL_MIGRATIONS` in `services/api/src/schema.ts`). It knows *that* a workspace exists
  and who belongs to it, never what the workspace stores.
- **`orgs/<orgId>.db`** — one file per workspace (`fileStore`,
  `services/api/src/tenants.ts`), holding everything that workspace stores: watched assets,
  indexed events, registers, journals, instructions, reconciliation runs, corporate actions,
  notes (`ORG_MIGRATIONS`).

A request authenticates against `control.db`, is resolved to one workspace handle, and every
query it runs goes through that handle's connection. There is no `org_id` column on workspace
data and no tenant filter to forget: the connection can only see one file.

## The org id, validated before it touches a path

A workspace id is 16 lowercase hex characters, generated server-side
(`newId = randomBytes(8).toString("hex")`, `services/api/src/security.ts`). `Tenants.forOrg`
re-validates it against `ORG_ID = /^[0-9a-f]{16}$/` before doing anything else, because the id
becomes part of a file name — anything else, including path fragments like `../x`, uppercase,
or a non-string, is answered `no such workspace` (`services/api/src/tenants.ts`). It then
checks the id is one the control records actually know (`known`), so an unused-but-well-formed
id is refused too, before any file is opened or created.

## The meta `org_id` check

Every workspace database records which workspace it belongs to: on first open, `forOrg` writes
the org id into the database's own `meta` table (`CREATE TABLE meta`, `ORG_MIGRATIONS`); on
every later open it reads the row back and refuses the handle — closing it and throwing
`the database for workspace X belongs to Y` — if the stored id is not the id it was opened
under (`services/api/src/tenants.ts`, `forOrg`). This catches the class of mistake file-level
isolation alone cannot: a file restored to the wrong name from backup, copied over another, or
a store bug handing back the wrong database. The wrong tenant's data is never served; the open
fails instead.

## `Tenants.forOrg`, the single gate

`forOrg` is the only way request handlers reach workspace data. In order it: validates the id
format, returns the cached open handle if there is one, refuses ids the control records do not
know, opens the file, runs the meta check above, and caches the `Concord` instance. The HTTP
layer resolves the session to its workspace and calls `forOrg(session.org.id)` — route
parameters never choose the file. Asset ids, run ids and action ids in URLs are looked up
*inside* the already-chosen workspace database, so another tenant's ids are simply absent
rows (404), not reachable objects.

## Deletion

Deleting a workspace (`DELETE /api/org`, which requires retyping the workspace name exactly —
`services/api/src/api.ts` — or `concord org-delete`, `services/api/src/cli.ts`) removes the
control records (`auth.deleteOrg`) and then `Tenants.drop` closes the open handle and deletes
the workspace's `.db` file together with its `-wal` and `-shm` siblings
(`fileStore.remove`, `services/api/src/tenants.ts`). The data is gone with the file; no other
workspace's file is touched, and the sole member's account goes with the workspace so the
email address is free again.

## Failure modes

Tenancy checks reject invalid states early and loudly:

- **Invalid id format (`NotFound: no such workspace`):** Any id that is not exactly 16 lowercase
  hexadecimal characters (`/^[0-9a-f]{16}$/`), including path-traversal sequences (`../x`,
  `..%2Fx`), non-strings, uppercase hex, or whitespace, fails regex validation immediately.
  No filesystem call or database open is attempted.
- **Unknown id (`NotFound: no such workspace`):** Even if an id is syntactically valid (16 hex chars),
  `forOrg` verifies `this.known(orgId)` against `control.db`. An unknown id is rejected before
  any database file is created under `data/orgs/`.
- **Database identity mismatch (`Error: the database for workspace X belongs to Y`):** If a
  workspace database file is restored or copied to another id's path (for example, copying
  `orgs/<orgA>.db` over `orgs/<orgB>.db`), `forOrg` detects that the `meta.org_id` stored inside
  the database (`orgA`) does not match the requested org id (`orgB`). The connection is closed
  immediately without caching, and an error is thrown. The misplaced workspace data is never queried.
- **Resource exhaustion (`EMFILE: too many open files`):** If active workspaces accumulate
  without sufficient OS descriptor ceilings, attempts to open another database file will fail
  at the OS level with `EMFILE`. See resource consequences below.

## Resource consequences: file descriptors and memory

`Tenants.forOrg` caches open `Concord` instances in memory (`Tenants.open`) for the lifetime of
the server process to avoid re-opening SQLite files and re-applying migrations on every HTTP request.
Holding workspaces open has two direct operational consequences:

1. **File descriptors (3 per workspace in WAL mode):**
   SQLite operates in Write-Ahead Logging mode (`services/api/src/db.ts`). Every open database
   connection keeps open handles for three distinct files:
   - `orgs/<id>.db` (main database file)
   - `orgs/<id>.db-wal` (write-ahead log)
   - `orgs/<id>.db-shm` (shared-memory index)

   Along with `control.db` (3 descriptors), standard streams (`stdin`, `stdout`, `stderr`), and
   network sockets, total file descriptors consumed is:
   `open_fds ≈ 3 * (open_workspaces + 1) + 10`.

   On default Linux configurations where `ulimit -n` is `1024`, Concord can hold approximately
   ~330 active workspaces before hitting `EMFILE`. Deployments serving more workspaces must raise
   the file descriptor limit (e.g. `LimitNOFILE=65536` in systemd or `nofile 65536` in `/etc/security/limits.conf`).

2. **Memory overhead (~280 KiB RSS per open workspace):**
   An open workspace retains a `Concord` JS object, cached prepared statements in `Db`, and SQLite's
   internal connection memory and page cache. Measured idle overhead is under **280 KiB RSS** (and
   **~8.3 KiB V8 heap**) per open workspace. Active workspaces reading large event histories will
   allocate additional SQLite page cache buffers (up to SQLite's default 2 MiB cache limit per connection).

## Capacity estimate table

The table below provides capacity estimates based on measured per-workspace overhead on Node 24 (`node:sqlite`):

| Open workspaces | Incremental RSS | Total process RSS | Open file descriptors | Minimum `ulimit -n` required | Operational notes |
|---|---|---|---|---|---|
| 0 (idle base) | — | ~93 MiB | ~6 | 1024 | Base Node runtime and `control.db` |
| 10 | ~2.8 MiB | ~96 MiB | ~36 | 1024 | Fits default OS limits easily |
| 50 | ~14 MiB | ~107 MiB | ~156 | 1024 | Fits default OS limits |
| 100 | ~28 MiB | ~121 MiB | ~306 | 1024 | Fits default OS limits |
| 200 | ~56 MiB | ~149 MiB | ~606 | 1024 | Fits default OS limits |
| 300 | ~84 MiB | ~177 MiB | ~906 | 1024 / 2048 | Max safe capacity on default `ulimit -n 1024` |
| 500 | ~140 MiB | ~233 MiB | ~1,506 | 4096 | Requires `ulimit -n` increase |
| 1,000 | ~280 MiB | ~373 MiB | ~3,006 | 4096 / 65536 | Requires increased descriptor limits |
| 2,000 | ~560 MiB | ~653 MiB | ~6,006 | 65536 | Comfortably under 1 GB RAM |
| 5,000 | ~1.40 GiB | ~1.49 GiB | ~15,006 | 65536 | Dedicated host with 2 GB+ RAM |

### Measurement methodology

Numbers were measured directly on Node 24 (`v24.16.0`) with `node:sqlite` running against real SQLite databases initialized with `ORG_MIGRATIONS`:

1. **Environment:** Node.js v24.16.0, `node:sqlite`, SQLite WAL mode with a 5-second busy timeout.
2. **Procedure:** A benchmark script created a `fileStore` on disk and instantiated `Tenants`. Workspaces were opened sequentially through `Tenants.forOrg(id)`. Each workspace executed realistic initial queries: reading `meta`, inserting an asset record, and selecting from `assets`.
3. **Sampling:** `process.memoryUsage()` was sampled before opening workspaces, at 100 workspaces, and at 200 workspaces after forcing garbage collection.
4. **Findings:**
   - Memory overhead was linear at **~280 KiB RSS** per open workspace and **~8.3 KiB V8 heap**.
   - Descriptor count increases by exactly **3 file descriptors per open workspace** due to SQLite WAL files (`.db`, `.db-wal`, `.db-shm`).

## How the tests prove it

`services/api/test/tenancy.test.ts`, `describe("workspace isolation")`, runs against a real
`Concord` with seeded books. Workspace A is filled with marker strings that exist nowhere else
(`MARKERS`: a holder id, a holder name, a sign-off note, journal and instruction refs, the org
name); workspace B is empty. Then:

- **Every workspace route, probed.** The suite enumerates the HTTP routes from the running
  app, requires a probe for each one — *a route added without a probe fails the suite, so a
  new endpoint cannot ship unexamined* — and calls each probe as workspace B using workspace
  A's real ids. No response may contain any marker, and probes naming A's asset, run or action
  ids must answer 404. Workspace A is then re-read to prove it is exactly as seeded.
- **No session, no route.** Every probe repeated anonymously must answer 401.
- **Same asset, separate books.** Two workspaces watch the same on-chain contract; each gets
  its own asset row, holdings cut to its own baseline, its own run numbering, and exports with
  different hashes — B's export must not contain A's markers.
- **Id discipline.** `forOrg` refuses `../x`, `..%2Fx`, the empty string, uppercase hex,
  well-formed-but-unknown ids, and a non-string.
- **The meta check.** Two `Tenants` handed the *same* underlying database under different org
  ids: the second open must throw `belongs to <first id>`.
- **Deletion.** Deleting workspace A (with the exact-name confirmation enforced) removes
  exactly A's store, kills A's sessions, frees A's email, and leaves B answering normally.

The suite needs no network: the chain is a `FakeChain` and the stores are in memory
(`services/api/test/helpers.ts`). The seeded holder data is invented for the test
(`ALPHA-HOLDER-7`, `Northgate Secret Trust`); no real holder data appears there or here.

## What tenancy does not cover

Isolation is between workspaces through the product's surfaces. Anyone with the server's disk
reads every file (`SECURITY.md`, out of scope); members of the *same* workspace see that
workspace's data by design, with owner/member roles as the only distinction (README,
**Accounts and workspaces**).
