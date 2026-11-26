# Changelog

All notable changes to Concord are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions, once
they exist, will follow [Semantic Versioning](https://semver.org/). There are no tagged
releases yet, so everything sits under **Unreleased** until the first tag.

## How entries are made

Commit messages already follow Conventional Commits with the package as scope
(`CONTRIBUTING.md`, "Making a change"). Types map to sections like this:

| Commit type | Changelog section |
|---|---|
| `feat` | Added |
| `fix` | Fixed |
| change in behaviour of an existing feature | Changed |
| removal, or notice of one | Removed / Deprecated |
| security-relevant fix | Security |
| `docs`, `build`, `test`, `chore` | Usually omitted |

Two kinds of change are **always** listed, whatever the commit type:

- **User-visible changes** — anything a person at the dashboard, the CLI or the HTTP API can
  notice, including changed wording of errors and reports.
- **Schema changes** — any new entry in `CONTROL_MIGRATIONS` or `ORG_MIGRATIONS`
  (`services/api/src/schema.ts`). Migrations are append-only and run on open, so a schema
  entry tells an operator a deploy will touch their databases; the entry names the tables.

A `docs`-only or internal refactoring commit does not need an entry. When in doubt, write one.

## [Unreleased]

Everything to date; Concord's history begins 2026-10 with the commits below.

### Changed

- `unwatch` and `org-delete` now require `--yes` (or a TTY prompt) before deleting anything
  and support `--dry-run` to print the counts of events, registers, runs and notes that would
  be removed; without `--yes` nothing is deleted and the command exits with code 1 (#558).

### Fixed

- The CLI answers an unknown flag, or a flag missing its value, with one line that names the
  flag, suggests the closest known one and points to `concord --help`, instead of Node's raw
  parser message (#581).
- Register imports reject as-of times more than five minutes in the future (#100).

### Added

- `concord reconcile-all` reconciles every asset that has a register in one command, continuing
  past an asset that fails and summarising each result; `--fail-on-breaks` exits 2 when any
  asset has open breaks (#560).
- A printable HTML report of a reconciliation run, with its summary, coverage, register and run
  digests, and break sign-off history (`GET /api/reconciliations/:id/report`) (#552).
- `Concord.diffRegisters(asset, fromId, toId)` compares two registers of one asset by
  `holder_id`: holders added and removed, and holders whose units, accounts or statuses changed,
  each list sorted by holder id (#566).
- `Concord.diffRuns(fromId, toId)` compares two reconciliation runs of one asset: each break key
  is new, resolved, persisting, or changed when its fingerprint differs, every list sorted by
  key (#567).
- Dividend withholding (#570): `withholdingRate` and per-address `withholdingOverrides` on a
  dividend. The expected payment is the net of withholding, applied after the gross is rounded,
  and the action's result lines show `gross`, `withheld` and `net` (also in the audit pack).
- A per-asset reconciliation `tolerance` (smallest units): a holder whose chain and register
  balances differ by no more than it is treated as matched. Schema: `ORG_MIGRATIONS` v5 adds
  `assets.tolerance` (#564).
- Void a corporate action entered in error (`POST /api/actions/:id/void`, reason required) (#544).
  It keeps its place in the audit trail with no open breaks. Schema: `ORG_MIGRATIONS` entry 8 adds
  `actions.voided_at`, `voided_by` and `void_reason`.
- The runs list reads summary columns instead of parsing every stored result body (#531).
  Schema: `ORG_MIGRATIONS` entry 7 adds `runs.summary`, `status`, `chain_behind` and `open_breaks`,
  backfilled from existing results.
- Holdings checkpoints (#576): historical holdings (`asOf`), corporate-action snapshots and the
  current holdings replay from the nearest stored checkpoint, so their cost near the tip no longer
  grows with the length of the history. Results are unchanged. Schema: `ORG_MIGRATIONS` entry 6
  adds the `holdings_checkpoints` table and the `events_asset_ledger` index on `events`.
- CSV templates can include one illustrative example row with `?example=1` or `?example=true` (#200).
- The accounting core (`feat(core)`, `c402eae`): holdings replay from CAP-67 events, position
  and movement reconciliation with typed breaks, corporate-action entitlements (dividend,
  split, redemption), controls matching, amount parsing with exact decimal-string arithmetic.
- The API service (`feat(api)`, `5e965a5`): the RPC indexer with Horizon opening balances,
  accounts and per-workspace SQLite databases, sessions and invitations, rate limiting, the
  HTTP API and the `concord` CLI. First schemas: `CONTROL_MIGRATIONS` (users, orgs,
  memberships, sessions, invites) and `ORG_MIGRATIONS` (assets, events, registers, journals,
  instructions, runs, actions, notes).
- The dashboard (`feat(web)`, `ab20a37`): sign-in, breaks and sign-off, holdings, corporate
  actions, controls log, audit export, team management.
- Deployment (`build`, `ffce294`): Dockerfile and Render blueprint — listed because it is how
  operators run Concord.
- Workspace scaffolding, the product brief and README (`1ec94a5`, `601d473`), and the
  documentation set: workspaces/deploy/limits, license, contributing guide, security policy,
  architecture and CI (`e4f5b92`, `325ae12`).
