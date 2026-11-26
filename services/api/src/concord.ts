import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  buildControlsLog,
  dividendBreakdown,
  dividendEntitlements,
  formatUnits,
  observeFlows,
  parseInstructionsCsv,
  parseJournalCsv,
  parseRegisterCsv,
  reconcileDistribution,
  reconcileMovements,
  reconcilePositions,
  redemptionDeltas,
  replay,
  sortEvents,
  splitCashInLieu,
  splitDeltas,
  toCsv,
  type AssetEvent,
  type DividendAmounts,
  type DividendTerms,
  type EventKind,
  type ExpectedFlows,
  type HoldingsState,
  type Instruction,
  type JournalEntry,
  type Opening,
  type RegisterPosition,
  type Rounding,
} from "@concord/core";
import { StrKey } from "@stellar/stellar-sdk";
import {
  ChainError,
  cursorLedger,
  resolveAsset,
  type AssetCandidate,
  type ChainHead,
  type ChainSource,
  type ResolvedAsset,
} from "./chain.js";
import { NETWORK_NAMES, isNetworkName, type NetworkName } from "./config.js";
import type { Db, Row } from "./db.js";
import { WebhookSender, newWebhookSecret, webhookUrlProblem, type WebhookEventType } from "./webhook.js";

export class NotFound extends Error {}
export class Invalid extends Error {}

/** Who did something: a signed-in user, or the operator at the command line. */
export interface Actor {
  id: string;
  label: string;
}

export interface NetworkHandle {
  passphrase: string;
  chain?: ChainSource;
}

/** The networks a workspace can read. One process serves both. */
export type Networks = Partial<Record<NetworkName, NetworkHandle>>;

export interface AssetRecord {
  id: string;
  network: NetworkName;
  code: string;
  issuer?: string;
  name: string;
  decimals: number;
  /** "indexing" until where history starts has been established. */
  state: "indexing" | "ready";
  /** Opening balances from Horizon, a ledger the caller named, or the oldest the RPC holds. */
  startMode: "baseline" | "ledger" | "window";
  startLedger?: number;
  baselineLedger?: number;
  /** With startMode "window": roughly when the indexed history begins. */
  historyFrom?: string;
  cursor?: string;
  syncedLedger?: number;
  syncedAt?: string;
  /** Why the last indexing pass failed. Cleared by the next one that succeeds. */
  syncError?: string;
  syncErrorAt?: string;
  ignore: string[];
  /** Absolute per-address difference (in smallest units) still treated as a match. */
  tolerance?: string;
  instructionWindowHours: number;
  movementWindowHours: number;
  createdAt: string;
}

export interface WatchInput {
  network: NetworkName;
  /** CODE:ISSUER or a contract id. */
  asset: string;
  name?: string;
  /** Contract tokens only, and only when the contract does not state them. */
  decimals?: number;
  /** Replay from this ledger instead of taking opening balances. */
  fromLedger?: number;
  /** Classic assets take opening balances from Horizon unless this is false. */
  baseline?: boolean;
  /** Addresses outside the register, e.g. the issuer's distribution account. */
  ignore?: string[];
  instructionWindowHours?: number;
  movementWindowHours?: number;
}

export type ActionType = "dividend" | "split" | "redemption";

export interface ActionInput {
  type: ActionType;
  label?: string;
  /** ISO-8601. Holdings at this instant are the entitlement basis. */
  recordTime: string;
  /** End of the execution window. Open-ended when absent. */
  windowTo?: string;
  /** First ledger of the execution window (inclusive). Events before this ledger are ignored. */
  windowFromLedger?: number;
  /** Last ledger of the execution window (inclusive). Events after this ledger are ignored. */
  windowToLedger?: number;
  exclude?: string[];
  /** Dividend: pay-asset units per whole unit held. */
  ratePerUnit?: string;
  /** Dividend: watched asset the dividend is paid in. Defaults to the asset itself (in kind). */
  payAsset?: string;
  /** Dividend: paying agent. Without one, mints of the pay asset are counted. */
  payer?: string;
  rounding?: Rounding;
  /** Dividend: share of the gross the payer withholds, a decimal from 0 to 1 such as "0.15". */
  withholdingRate?: string;
  /** Dividend: per-address withholding rates that replace `withholdingRate`. */
  withholdingOverrides?: Record<string, string>;
  /** Split ratio or redemption fraction. */
  num?: string;
  den?: string;
  /** Split: optional cash in lieu of fractional units. */
  cashInLieu?: {
    asset: string;
    pricePerUnit: string;
    payer?: string;
  };
}

export interface NoteInput {
  fingerprint: string;
  status: "open" | "acknowledged" | "resolved";
  note: string;
}

interface StoredBreak {
  scope: string;
  type: string;
  severity: string;
  key: string;
  fingerprint: string;
  message: string;
  firstSeen?: string;
  address?: string | null;
  holderIds?: string[];
  ref?: string | null;
  txHash?: string | null;
  eventId?: string | null;
  chainUnits?: string | null;
  registerUnits?: string | null;
  expected?: string;
  observed?: string;
  difference?: string | null;
}

interface Coverage {
  from: string | null;
  to: string | null;
  mode: "baseline" | "ledger" | "window";
  complete: boolean;
}

interface RunResult {
  registerId: number;
  registerSha256: string;
  asOf: string;
  chainLedger: number;
  chainSyncedAt: string | null;
  chainBehind: boolean;
  warnings: string[];
  status: "clean" | "breaks";
  tolerance: string | null;
  summary: Record<string, string | number | null>;
  lines: Array<Record<string, unknown>>;
  movement: Record<string, unknown> | null;
  breaks: StoredBreak[];
  coverage: Coverage;
}

interface ActionFlowResult {
  reconciledThrough: string | null;
  status: "clean" | "breaks";
  flowAsset: { id: string; code: string };
  summary: Record<string, string | number>;
  lines: Array<Record<string, unknown>>;
  breaks: StoredBreak[];
}

interface ActionResult {
  reconciledThrough: string | null;
  warnings: string[];
  status: "clean" | "breaks";
  flowAsset: { id: string; code: string };
  summary: Record<string, string | number>;
  lines: Array<Record<string, unknown>>;
  breaks: StoredBreak[];
  cashInLieu?: ActionFlowResult;
  coverage: Coverage;
}

const now = () => new Date().toISOString();
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Version of the audit pack's shape (docs/audit-pack.schema.json); bump it on a breaking change. */
export const AUDIT_PACK_SCHEMA_VERSION = 1;

/**
 * Serializes a value into RFC 8785 canonical JSON.
 * - Object keys sorted lexicographically by UTF-16 code units
 * - Primitives formatted according to ECMAScript standard JSON rules (-0 formatted as "0")
 * - Whitespace stripped
 * - undefined, functions, and symbols in objects omitted; in arrays rendered as null
 */
export function canonicalJson(value: unknown): string {
  if (value && typeof (value as { toJSON?: unknown }).toJSON === "function") {
    value = (value as { toJSON: () => unknown }).toJSON();
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "null";
      if (Object.is(value, -0)) return "0";
      return JSON.stringify(value);
    }
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
      return undefined as unknown as string;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => {
      const s = canonicalJson(v);
      return s === undefined ? "null" : s;
    });
    return `[${items.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries: string[] = [];
  for (const k of keys) {
    const val = obj[k];
    if (val === undefined || typeof val === "function" || typeof val === "symbol") continue;
    const json = canonicalJson(val);
    if (json !== undefined) {
      entries.push(`${JSON.stringify(k)}:${json}`);
    }
  }
  return `{${entries.join(",")}}`;
}

/**
 * Computes the SHA-256 digest of an audit pack over RFC 8785 canonical JSON,
 * excluding volatile/digest fields sha256 and generatedAt.
 */
export function auditPackDigest(pack: Record<string, unknown>): string {
  // The signature fields are added after the digest is taken, so they are never part of it.
  const { sha256: _sha256, generatedAt: _generatedAt, keyId: _keyId, signature: _signature, ...content } = pack;
  return sha256(canonicalJson(content));
}
const MAX_REGISTER_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_INSTRUCTION_WINDOW_HOURS = 72;
const DEFAULT_MOVEMENT_WINDOW_HOURS = 24;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 720;

function windowHours(value: number | undefined, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < MIN_WINDOW_HOURS || value > MAX_WINDOW_HOURS) {
    throw new Invalid(`${field} must be an integer between ${MIN_WINDOW_HOURS} and ${MAX_WINDOW_HOURS}`);
  }
  return value;
}

/** Options for one page of `holdings()`. `after` is the last address of the previous page. */
export interface HoldingsPage {
  limit?: number;
  offset?: number;
  after?: string;
  /** Address prefix; case does not matter. */
  q?: string;
  sort?: "units" | "address";
}

const DEFAULT_HOLDINGS_LIMIT = 100;
const MAX_HOLDINGS_LIMIT = 1000;

function holdingsPage(page: HoldingsPage): Required<Pick<HoldingsPage, "limit" | "offset" | "sort">> & Pick<HoldingsPage, "after" | "q"> {
  const limit = page.limit ?? DEFAULT_HOLDINGS_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HOLDINGS_LIMIT) {
    throw new Invalid(`limit must be an integer between 1 and ${MAX_HOLDINGS_LIMIT}`);
  }
  const offset = page.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Invalid("offset must be a whole number");
  if (page.after !== undefined && page.offset !== undefined) throw new Invalid("give offset or after, not both");
  if (page.after !== undefined && !page.after) throw new Invalid("after must be an address");
  const sort = page.sort ?? "units";
  if (sort !== "units" && sort !== "address") throw new Invalid("sort must be units or address");
  const q = page.q?.trim().toUpperCase();
  return { limit, offset, sort, ...(page.after !== undefined ? { after: page.after } : {}), ...(q ? { q } : {}) };
}

/** What a destructive delete takes with it, so the CLI can show it before asking. */
export interface DeletionCounts {
  assets: number;
  events: number;
  registers: number;
  runs: number;
  notes: number;
}

export interface ConcordOptions {
  checkpointEvery?: number;
  /** ed25519 private key (PEM, or a path to one) that signs audit packs. */
  signingKey?: string;
  /** Assets of one network that `syncAll` indexes at once. 1 walks them in order. */
  syncConcurrency?: number;
  /**
   * How long one asset may page through events in a `syncAll` pass before it yields; the rest of
   * its backlog waits for the next pass. 0 means no limit.
   */
  syncAssetBudgetMs?: number;
  /** Milliseconds clock, for tests. */
  now?: () => number;
}

export type SyncResult = { added: number; more?: true };

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
const SUMMARY_LABELS: Record<string, string> = {
  chainSupply: "Chain supply",
  registerTotal: "Register total",
  supplyDifference: "Supply difference",
  unmappedUnits: "Unmapped units",
  grossDifference: "Gross difference",
  chainHolders: "Chain holders",
  registerHolders: "Register holders",
  lines: "Lines",
  matchedLines: "Matched lines",
  breakCount: "Breaks",
};

export const EXPORT_CSV_SECTIONS = [
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
] as const;
export const EXPORT_CSV_SECTION_ERROR =
  "section must be holdings, events, controls, breaks, action, positions, runs, actions, journal or instructions";
export type ExportCsvSection = (typeof EXPORT_CSV_SECTIONS)[number];

function isoTime(input: string, field: string): string {
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new Invalid(`${field} is not a valid date: "${input}"`);
  return new Date(t).toISOString();
}

function addresses(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || value.some((v) => typeof v !== "string" || v.length > 80)) {
    throw new Invalid(`${field} must be a list of addresses`);
  }
  const result: string[] = [];
  for (const item of value as string[]) {
    const s = item.trim();
    if (!s) continue;
    if (!StrKey.isValidEd25519PublicKey(s) && !StrKey.isValidContract(s) && !StrKey.isValidMed25519PublicKey(s)) {
      throw new Invalid(`${field} contains an invalid Stellar address: "${item}"`);
    }
    result.push(s);
  }
  return [...new Set(result)];
}

function address(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 80) {
    throw new Invalid(`${field} must be a valid Stellar address`);
  }
  const s = value.trim();
  if (!s || (!StrKey.isValidEd25519PublicKey(s) && !StrKey.isValidContract(s) && !StrKey.isValidMed25519PublicKey(s))) {
    throw new Invalid(`${field} must be a valid Stellar address`);
  }
  return s;
}

function label(value: unknown, field: string, max = 120): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new Invalid(`${field} must be text of at most ${max} characters`);
  return value.trim() || undefined;
}

function isDbLockedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (typeof e.errcode === "number") {
    const primary = e.errcode & 0xff;
    if (primary === 5 || primary === 6) return true;
  }
  if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_LOCKED") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  const errstr = typeof e.errstr === "string" ? e.errstr : "";
  return (
    /sqlite_busy|sqlite_locked/i.test(msg) ||
    /database is locked|database table is locked/i.test(msg) ||
    /database is locked|busy/i.test(errstr)
  );
}

function isDiskFullError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (typeof e.errcode === "number") {
    const primary = e.errcode & 0xff;
    if (primary === 13) return true;
  }
  if (e.code === "SQLITE_FULL" || e.code === "ENOSPC") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  const errstr = typeof e.errstr === "string" ? e.errstr : "";
  return (
    /sqlite_full|enospc/i.test(msg) ||
    /database or disk is full|disk full|no space left/i.test(msg) ||
    /database or disk is full/i.test(errstr)
  );
}

/** What to tell the dashboard about a failed pass. Internals stay in the server log. */
export function describeFailure(err: unknown): string {
  if (err instanceof ChainError || err instanceof Invalid || err instanceof NotFound) return err.message;
  console.error(err);
  if (isDbLockedError(err)) return "[db_locked] Database is locked.";
  if (isDiskFullError(err)) return "[disk_full] Database or disk is full.";
  return "[internal] Indexing stopped on an unexpected error.";
}

function toAsset(row: Row): AssetRecord {
  const asset: AssetRecord = {
    id: String(row.id),
    network: String(row.network) as NetworkName,
    code: String(row.code),
    name: String(row.name),
    decimals: Number(row.decimals),
    state: String(row.state) as AssetRecord["state"],
    startMode: String(row.start_mode) as AssetRecord["startMode"],
    ignore: JSON.parse(String(row.ignore_addresses)) as string[],
    instructionWindowHours: Number(row.instruction_window_hours ?? DEFAULT_INSTRUCTION_WINDOW_HOURS),
    movementWindowHours: Number(row.movement_window_hours ?? DEFAULT_MOVEMENT_WINDOW_HOURS),
    createdAt: String(row.created_at),
  };
  if (row.issuer) asset.issuer = String(row.issuer);
  if (row.start_ledger !== null) asset.startLedger = Number(row.start_ledger);
  if (row.baseline_ledger !== null) asset.baselineLedger = Number(row.baseline_ledger);
  if (row.history_from) asset.historyFrom = String(row.history_from);
  if (row.cursor) asset.cursor = String(row.cursor);
  if (row.synced_ledger !== null) asset.syncedLedger = Number(row.synced_ledger);
  if (row.synced_at) asset.syncedAt = String(row.synced_at);
  if (row.sync_error) asset.syncError = String(row.sync_error);
  if (row.sync_error_at) asset.syncErrorAt = String(row.sync_error_at);
  if (row.tolerance) asset.tolerance = String(row.tolerance);
  return asset;
}

function toEvent(row: Row): AssetEvent {
  const ev: AssetEvent = {
    id: String(row.id),
    assetId: String(row.asset_id),
    kind: String(row.kind) as EventKind,
    ledger: Number(row.ledger),
    closedAt: String(row.closed_at),
    txHash: String(row.tx_hash),
    amount: BigInt(String(row.amount)),
  };
  if (row.from_addr) ev.from = String(row.from_addr);
  if (row.to_addr) ev.to = String(row.to_addr);
  if (row.authorized !== null) ev.authorized = Number(row.authorized) === 1;
  return ev;
}

/** Events folded in between two holdings checkpoints. */
export const CHECKPOINT_EVERY = 1000;

function encodeCheckpoint(state: HoldingsState): string {
  return JSON.stringify({
    balances: Object.fromEntries([...state.balances].map(([address, units]) => [address, units.toString()])),
    authorized: Object.fromEntries(state.authorized),
    ledger: state.ledger,
    eventCount: state.eventCount,
    skipped: (state.skipped ?? []).map((ev) => ({ ...ev, amount: ev.amount.toString() })),
  });
}

function decodeCheckpoint(text: string): HoldingsState {
  const stored = JSON.parse(text) as {
    balances: Record<string, string>;
    authorized: Record<string, boolean>;
    ledger: number;
    eventCount: number;
    skipped: (Omit<AssetEvent, "amount"> & { amount: string })[];
  };
  const balances = new Map(Object.entries(stored.balances).map(([address, units]) => [address, BigInt(units)]));
  let supply = 0n;
  for (const units of balances.values()) supply += units;
  const state: HoldingsState = {
    balances,
    authorized: new Map(Object.entries(stored.authorized)),
    supply,
    ledger: stored.ledger,
    eventCount: stored.eventCount,
    incomplete: [...balances]
      .filter(([, units]) => units < 0n)
      .map(([address]) => address)
      .sort(),
  };
  if (stored.skipped.length > 0) state.skipped = stored.skipped.map((ev) => ({ ...ev, amount: BigInt(ev.amount) }));
  return state;
}

/**
 * Continue a replay from a checkpoint: `from` is the state after every event up to some ledger,
 * `events` are the ones after it. Each holder keeps the cutoff its opening balance gave it, so the
 * result is the one a replay of the whole history would give.
 */
function resume(
  from: HoldingsState,
  events: AssetEvent[],
  opening: Map<string, Opening>,
  baselineLedger: number,
  upToTime?: string,
): HoldingsState {
  const seeded = new Map<string, Opening>();
  for (const address of new Set([...opening.keys(), ...from.balances.keys(), ...from.authorized.keys()])) {
    const seed: Opening = {
      amount: from.balances.get(address) ?? 0n,
      asOfLedger: opening.get(address)?.asOfLedger ?? baselineLedger,
    };
    const authorized = from.authorized.get(address);
    if (authorized !== undefined) seed.authorized = authorized;
    seeded.set(address, seed);
  }
  const next = replay(events, { opening: seeded, baselineLedger, ...(upToTime ? { upToTime } : {}) });
  const state: HoldingsState = {
    balances: next.balances,
    authorized: next.authorized,
    supply: next.supply,
    ledger: Math.max(from.ledger, next.ledger),
    eventCount: from.eventCount + next.eventCount,
    // A holder carried negative from the checkpoint is still short of history even if no later
    // event touches it.
    incomplete: [...next.balances]
      .filter(([, units]) => units < 0n)
      .map(([address]) => address)
      .sort(),
  };
  const skipped = [...(from.skipped ?? []), ...(next.skipped ?? [])];
  if (skipped.length > 0) state.skipped = skipped;
  return state;
}

/**
 * One workspace: every operation the API and the CLI expose over a single database.
 * Reads the chain, never writes it.
 */
export const EVENT_COLUMNS = [
  "id",
  "ledger",
  "closedAt",
  "kind",
  "from",
  "to",
  "units",
  "authorized",
  "txHash",
] as const;

export class Concord {
  private readonly syncing = new Map<string, Promise<{ added: number }>>();
  private readonly removing = new Set<string>();
  /** Current holdings per asset; replaying every event on each dashboard poll is too slow. */
  private readonly stateMemo = new Map<string, HoldingsState>();
  private seenVersion: number;
  private readonly checkpointEvery: number;
  private readonly syncConcurrency: number;
  private readonly syncAssetBudgetMs: number;
  private readonly clock: () => number;
  /** Outbound alerts. Replaced in tests so no delivery leaves the machine. */
  webhooks = new WebhookSender();

  constructor(
    readonly db: Db,
    readonly networks: Networks,
    readonly options: ConcordOptions = {},
  ) {
    this.seenVersion = db.dataVersion();
    const every = options.checkpointEvery ?? CHECKPOINT_EVERY;
    if (!Number.isSafeInteger(every) || every < 1) throw new Error("checkpointEvery must be a positive integer");
    this.checkpointEvery = every;
    const concurrency = options.syncConcurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("syncConcurrency must be a positive integer");
    this.syncConcurrency = concurrency;
    const budget = options.syncAssetBudgetMs ?? 0;
    if (!Number.isFinite(budget) || budget < 0) throw new Error("syncAssetBudgetMs must be zero or more");
    this.syncAssetBudgetMs = budget;
    this.clock = options.now ?? Date.now;
  }

  /** Forget cached holdings for an asset this instance just changed. */
  private touch(assetId: string): void {
    this.stateMemo.delete(assetId);
  }

  // ── webhook settings ──────────────────────────────────────────────────────

  private setting(key: string): string | undefined {
    const row = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
    return row ? String(row.value) : undefined;
  }

  private putSetting(key: string, value: string | null): void {
    if (value === null) this.db.write("DELETE FROM meta WHERE key = ?", key);
    else this.db.write("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  /**
   * The workspace's outbound webhook, including the secret a receiver checks signatures with.
   * Only a workspace owner is shown this by the API.
   */
  webhookSettings(): { url: string | null; secret: string | null } {
    return { url: this.setting("webhook_url") ?? null, secret: this.setting("webhook_secret") ?? null };
  }

  /**
   * Point alerts at an https endpoint, or clear them with an empty value. The signing secret is
   * made once and kept across edits, so a receiver does not have to re-key on every change.
   * `base` is the dashboard origin the payload's link is built from.
   */
  setWebhook(rawUrl: unknown, base?: string): { url: string | null; secret: string | null } {
    const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!text) {
      this.putSetting("webhook_url", null);
      this.putSetting("webhook_base", null);
      return this.webhookSettings();
    }
    const problem = webhookUrlProblem(text);
    if (problem) throw new Invalid(problem);
    let secret = this.setting("webhook_secret");
    if (!secret) {
      secret = newWebhookSecret();
      this.putSetting("webhook_secret", secret);
    }
    if (base) this.putSetting("webhook_base", base);
    this.putSetting("webhook_url", text);
    return this.webhookSettings();
  }

  /**
   * Queue one alert. Deliberately not awaited and never throwing: a slow or broken endpoint must
   * not hold up indexing or a reconciliation. The sender logs its own failures.
   */
  private alert(type: WebhookEventType, asset: AssetRecord, count: number, path: string): void {
    const url = this.setting("webhook_url");
    const secret = this.setting("webhook_secret");
    if (!url || !secret) return;
    const base = this.setting("webhook_base") ?? "";
    void this.webhooks.notify(url, secret, {
      type,
      asset: { id: asset.id, code: asset.code },
      count,
      url: `${base}${path}`,
    });
  }

  /** Forget everything cached when another process (the CLI, say) has written to the file. */
  private fresh(): void {
    const version = this.db.dataVersion();
    if (version !== this.seenVersion) {
      this.seenVersion = version;
      this.stateMemo.clear();
    }
  }

  // ── assets ────────────────────────────────────────────────────────────────

  /** By contract id, or by code when exactly one watched asset carries it. */
  asset(ref: string): AssetRecord {
    const byId = this.db.get("SELECT * FROM assets WHERE id = ?", ref);
    if (byId) return toAsset(byId);
    const byCode = this.db.all("SELECT * FROM assets WHERE code = ? COLLATE NOCASE LIMIT 2", ref);
    if (byCode.length > 1) throw new Invalid(`more than one watched asset is called ${ref}; use its contract id`);
    if (!byCode[0]) throw new NotFound(`asset ${ref} is not watched`);
    return toAsset(byCode[0]);
  }

  assets(network?: NetworkName): AssetRecord[] {
    const rows = network
      ? this.db.all("SELECT * FROM assets WHERE network = ? ORDER BY created_at", network)
      : this.db.all("SELECT * FROM assets ORDER BY created_at");
    return rows.map(toAsset);
  }

  /**
   * Count assets consuming the workspace watch limit (`maxAssetsPerOrg`).
   * Assets still in initial `'indexing'` with a recorded `syncError` have never reached `'ready'`
   * and are excluded so a failing deferred watch cannot lock up the workspace limit.
   */
  quotaAssetCount(): number {
    return this.assets().filter((a) => a.state === "ready" || !a.syncError).length;
  }

  networkNames(): NetworkName[] {
    return NETWORK_NAMES.filter((name) => this.networks[name]);
  }

  private handle(network: NetworkName): NetworkHandle {
    const handle = isNetworkName(network) ? this.networks[network] : undefined;
    if (!handle) throw new Invalid("network must be mainnet or testnet");
    return handle;
  }

  private requireChain(network: NetworkName): ChainSource {
    const chain = this.handle(network).chain;
    if (!chain) throw new Invalid(`no chain source configured for ${network}`);
    return chain;
  }

  /** Classic assets on a network that carry this code, most widely held first. */
  async lookup(network: NetworkName, code: string): Promise<AssetCandidate[]> {
    const chain = this.requireChain(network);
    if (typeof code !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
      throw new Invalid("an asset code is 1 to 12 letters or digits");
    }
    if (!chain.search) throw new Invalid("asset search is not available");
    return chain.search(code);
  }

  /**
   * Start watching an asset. With `defer`, the call returns once the asset is recorded and the
   * opening balances and first pass happen in the background; otherwise it waits for them.
   */
  async watchAsset(input: WatchInput, options: { defer?: boolean; actor?: Actor } = {}): Promise<AssetRecord> {
    const { passphrase } = this.handle(input.network);
    const chain = this.requireChain(input.network);
    let resolved: ResolvedAsset;
    try {
      resolved = resolveAsset(String(input.asset ?? ""), passphrase);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    if (this.removing.has(resolved.id) || this.db.get("SELECT id FROM assets WHERE id = ?", resolved.id)) {
      throw new Invalid(`${resolved.code} is already watched`);
    }
    const ignore = addresses(input.ignore, "ignore");
    const instructionWindowHours = windowHours(input.instructionWindowHours, "instructionWindowHours", DEFAULT_INSTRUCTION_WINDOW_HOURS);
    const movementWindowHours = windowHours(input.movementWindowHours, "movementWindowHours", DEFAULT_MOVEMENT_WINDOW_HOURS);
    let name = label(input.name, "name");
    let decimals = input.decimals;
    if (input.fromLedger !== undefined && (!Number.isInteger(input.fromLedger) || input.fromLedger < 1)) {
      throw new Invalid("fromLedger must be a ledger sequence");
    }

    if (chain.describe) {
      const found = await chain.describe(resolved);
      if (!found) {
        const what = resolved.issuer ? `asset ${resolved.code} from that issuer` : "contract with that id";
        throw new Invalid(`${input.network} has no ${what}`);
      }
      // A contract id that turns out to wrap a classic asset is watched as that asset.
      resolved = {
        ...resolved,
        ...(found.code ? { code: found.code } : {}),
        ...(found.issuer ? { issuer: found.issuer } : {}),
      };
      decimals ??= found.decimals;
      name ??= found.name;
    }
    // Classic assets carry seven decimals by protocol. A contract token must say, or be told.
    if (resolved.issuer) {
      if (input.decimals !== undefined && input.decimals !== 7) {
        throw new Invalid("classic assets always carry 7 decimals");
      }
      decimals = 7;
    }
    if (decimals === undefined) {
      throw new Invalid("this token does not state its decimals; give them when watching it");
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Invalid("decimals must be 0 to 18");
    if (input.baseline && !resolved.issuer) throw new Invalid("opening balances are only available for classic assets");
    const startMode: AssetRecord["startMode"] =
      input.fromLedger !== undefined ? "ledger" : resolved.issuer && input.baseline !== false ? "baseline" : "window";

    // The check above ran before the awaits on the chain; another request may have watched the
    // same asset since. Nothing awaits between this check and the insert.
    if (this.removing.has(resolved.id) || this.db.get("SELECT id FROM assets WHERE id = ?", resolved.id)) {
      throw new Invalid(`${resolved.code} is already watched`);
    }
    try {
      this.db.insert(
        `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, start_ledger, ignore_addresses, instruction_window_hours, movement_window_hours, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, ?, ?, ?)`,
        resolved.id,
        input.network,
        resolved.code,
        resolved.issuer ?? null,
        name ?? resolved.code,
        decimals,
        startMode,
        input.fromLedger ?? null,
        JSON.stringify(ignore),
        instructionWindowHours,
        movementWindowHours,
        options.actor?.label ?? null,
        now(),
      );
    } catch (err) {
      if ((err as Error)?.message?.includes("UNIQUE constraint failed")) {
        throw new Invalid(`${resolved.code} is already watched`);
      }
      throw err;
    }
    this.touch(resolved.id);
    if (options.defer) {
      // sync() records its own failure on the asset, where the dashboard shows it.
      void this.sync(resolved.id).catch(() => {});
      return this.asset(resolved.id);
    }
    try {
      return await this.prepare(this.asset(resolved.id));
    } catch (err) {
      this.db.write("DELETE FROM assets WHERE id = ?", resolved.id);
      throw err;
    }
  }

  /** Establish where history starts, then mark the asset ready to index. */
  private async prepare(asset: AssetRecord, head?: ChainHead): Promise<AssetRecord> {
    const chain = this.requireChain(asset.network);
    if (asset.startMode === "baseline") {
      if (!asset.issuer) throw new Invalid("opening balances are only available for classic assets");
      const baseline = await chain.baseline(asset.code, asset.issuer, asset.decimals);
      this.db.tx(() => {
        this.db.write("DELETE FROM openings WHERE asset_id = ?", asset.id);
        for (const [address, o] of baseline.openings) {
          this.db.insert(
            "INSERT INTO openings (asset_id, address, amount, authorized, as_of_ledger) VALUES (?, ?, ?, ?, ?)",
            asset.id,
            address,
            o.amount.toString(),
            o.authorized === undefined ? null : o.authorized ? 1 : 0,
            o.asOfLedger,
          );
        }
        this.db.write(
          "UPDATE assets SET state = 'ready', baseline_ledger = ?, start_ledger = ?, history_from = NULL WHERE id = ?",
          baseline.ledger,
          baseline.ledger + 1,
          asset.id,
        );
      });
    } else {
      const { latest, oldest, oldestClosedAt } = head ?? (await chain.latestLedger());
      if (asset.startMode === "ledger") {
        if (asset.startLedger === undefined || asset.startLedger < oldest) {
          throw new Invalid(
            `ledger ${asset.startLedger} is older than the RPC retains (oldest ${oldest}); use a baseline`,
          );
        }
        this.db.write("UPDATE assets SET state = 'ready' WHERE id = ?", asset.id);
      } else {
        // The retention window slides while we work, so do not start on its very edge.
        this.db.write(
          "UPDATE assets SET state = 'ready', start_ledger = ?, history_from = ? WHERE id = ?",
          Math.min(oldest + 20, latest),
          oldestClosedAt ?? null,
          asset.id,
        );
      }
    }
    // Checkpoints fold in the opening balances and the baseline ledger, both just (re)set.
    this.db.write("DELETE FROM holdings_checkpoints WHERE asset_id = ?", asset.id);
    this.touch(asset.id);
    return this.asset(asset.id);
  }

  updateAsset(
    ref: string,
    patch: { name?: string; ignore?: string[]; tolerance?: string | null; instructionWindowHours?: number; movementWindowHours?: number },
  ): AssetRecord {
    const asset = this.asset(ref);
    const name = label(patch.name, "name");
    let tolerance: string | null = asset.tolerance ?? null;
    if (patch.tolerance !== undefined) {
      if (patch.tolerance === null || patch.tolerance === "") {
        tolerance = null;
      } else {
        if (!/^\d+$/.test(patch.tolerance) || BigInt(patch.tolerance) < 0n) {
          throw new Invalid("tolerance must be a non-negative integer (smallest units)");
        }
        tolerance = patch.tolerance;
      }
    }
    const instructionWindowHours = windowHours(
      patch.instructionWindowHours,
      "instructionWindowHours",
      asset.instructionWindowHours,
    );
    const movementWindowHours = windowHours(patch.movementWindowHours, "movementWindowHours", asset.movementWindowHours);
    this.db.write(
      "UPDATE assets SET name = ?, ignore_addresses = ?, tolerance = ?, instruction_window_hours = ?, movement_window_hours = ? WHERE id = ?",
      name ?? asset.name,
      JSON.stringify(patch.ignore === undefined ? asset.ignore : addresses(patch.ignore, "ignore")),
      tolerance,
      instructionWindowHours,
      movementWindowHours,
      asset.id,
    );
    return this.asset(asset.id);
  }

  /** Stop watching: the asset, its events and every book uploaded against it are deleted. */
  async unwatchAsset(ref: string): Promise<void> {
    const asset = this.asset(ref);
    this.removing.add(asset.id);
    try {
      // A pass still running would write its events into an asset watched again under the same id.
      await this.syncing.get(asset.id)?.catch(() => {});
      this.db.write("DELETE FROM assets WHERE id = ?", asset.id);
      this.touch(asset.id);
    } finally {
      this.removing.delete(asset.id);
    }
  }

  /**
   * Throw away the indexed history and start again from fresh opening balances. This is the way
   * out of a gap left by the indexer being down for longer than the RPC keeps events. Uploaded
   * books, past runs and sign-offs stay.
   */
  async rebuild(ref: string, options: { defer?: boolean } = {}): Promise<AssetRecord> {
    const asset = this.asset(ref);
    if (this.removing.has(asset.id)) throw new NotFound(`asset ${ref} is not watched`);
    await this.syncing.get(asset.id)?.catch(() => {});
    if (this.removing.has(asset.id)) throw new NotFound(`asset ${ref} is not watched`);
    this.db.tx(() => {
      this.db.write("DELETE FROM events WHERE asset_id = ?", asset.id);
      this.db.write("DELETE FROM openings WHERE asset_id = ?", asset.id);
      this.db.write("DELETE FROM holdings_checkpoints WHERE asset_id = ?", asset.id);
      this.db.write(
        `UPDATE assets SET state = 'indexing', start_mode = ?, start_ledger = NULL, baseline_ledger = NULL,
           history_from = NULL, cursor = NULL, synced_ledger = NULL, synced_at = NULL, sync_error = NULL, sync_error_at = NULL
         WHERE id = ?`,
        asset.issuer ? "baseline" : "window",
        asset.id,
      );
    });
    this.touch(asset.id);
    if (options.defer) void this.sync(asset.id).catch(() => {});
    else await this.sync(asset.id);
    return this.asset(asset.id);
  }

  // ── indexer ───────────────────────────────────────────────────────────────

  /**
   * Pull new events for one asset. Concurrent calls share one pass. With `budgetMs` the pass
   * stops paging once that long has gone by, saves its position and reports `more`.
   */
  sync(ref: string, head?: ChainHead, options: { budgetMs?: number } = {}): Promise<SyncResult> {
    const asset = this.asset(ref);
    if (this.removing.has(asset.id)) throw new NotFound(`asset ${ref} is not watched`);
    const running = this.syncing.get(asset.id);
    if (running) return running;
    const deadline = options.budgetMs ? this.clock() + options.budgetMs : undefined;
    const pass = this.runSync(asset, head, deadline).finally(() => this.syncing.delete(asset.id));
    this.syncing.set(asset.id, pass);
    return pass;
  }

  /**
   * One pass over every asset. Networks run side by side, so an outage on one cannot stall the
   * other. Within a network up to `syncConcurrency` assets index at once, taken in order, and
   * each may page for at most `syncAssetBudgetMs` before yielding to the next pass; one asset
   * with a long backlog therefore cannot hold the rest. Keyed by asset id.
   */
  async syncAll(): Promise<Record<string, SyncResult | { error: string }>> {
    const out: Record<string, SyncResult | { error: string }> = {};
    const budget = this.syncAssetBudgetMs > 0 ? { budgetMs: this.syncAssetBudgetMs } : {};
    await Promise.all(
      this.networkNames().map(async (network) => {
        const assets = this.assets(network);
        if (assets.length === 0) return;
        // One look at the chain's range serves every asset on the network.
        const head = await this.networks[network]?.chain?.latestLedger().catch(() => undefined);
        let next = 0;
        const worker = async () => {
          while (next < assets.length) {
            const asset = assets[next++]!;
            try {
              out[asset.id] = await this.sync(asset.id, head, budget);
            } catch (err) {
              out[asset.id] = { error: describeFailure(err) };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(this.syncConcurrency, assets.length) }, worker));
      }),
    );
    return out;
  }

  private async runSync(asset: AssetRecord, head?: ChainHead, deadline?: number): Promise<SyncResult> {
    try {
      const chain = this.requireChain(asset.network);
      head ??= await chain.latestLedger();
      const ready = asset.state === "indexing" ? await this.prepare(asset, head) : asset;
      if (ready.cursor) {
        let at: number;
        try {
          at = cursorLedger(ready.cursor);
        } catch {
          // The stored position can only be damaged by hand or by a bug; indexing from it would
          // either fail with a bare parse error or read it as ledger 0 and skip the gap check.
          throw new Invalid(
            "This asset's saved indexing position is unreadable. Rebuild this asset to start again from fresh opening balances.",
          );
        }
        if (at + 1 < head.oldest) {
          throw new Invalid(
            "Indexing was paused for longer than the network keeps events, so movements in between are missing. Rebuild this asset to start again from fresh opening balances.",
          );
        }
        if (at > head.latest + 1000) {
          throw new Invalid(
            `The ${ready.network} ledger is now behind this asset's history: the network was reset. Stop watching it.`,
          );
        }
      }
      const out = await this.syncPass(ready, chain, deadline);
      if (this.removing.has(asset.id)) return { added: 0 };
      if (asset.syncError) {
        this.db.write("UPDATE assets SET sync_error = NULL, sync_error_at = NULL WHERE id = ?", asset.id);
      }
      return out;
    } catch (err) {
      if (this.removing.has(asset.id)) throw err;
      const failure = describeFailure(err);
      this.db.write(
        "UPDATE assets SET sync_error = ?, sync_error_at = ? WHERE id = ?",
        failure,
        now(),
        asset.id,
      );
      // A pass that fails every 30 seconds must not alert every 30 seconds; only a new or changed
      // failure is news.
      if (asset.syncError !== failure) {
        this.alert("sync.failed", asset, 1, `/#/a/${asset.id}`);
      }
      throw err;
    }
  }

  private async syncPass(asset: AssetRecord, chain: ChainSource, deadline?: number): Promise<SyncResult> {
    if (asset.startLedger === undefined) throw new Invalid("this asset has no starting ledger yet");
    const limit = 1000;
    let from: { startLedger: number } | { cursor: string } = asset.cursor
      ? { cursor: asset.cursor }
      : { startLedger: asset.startLedger };
    let added = 0;
    for (let i = 0; i < 10_000; i++) {
      if (this.removing.has(asset.id)) break;
      const page = await chain.getEvents(asset.id, from, limit);
      if (this.removing.has(asset.id)) break;
      const cursor = page.cursor ?? page.events.at(-1)?.id;
      const previous = "cursor" in from ? from.cursor : undefined;
      // Caught up when the cursor stops moving, or a short page ends at the chain's tip.
      const atTip =
        !cursor || cursor === previous || (page.events.length < limit && cursorLedger(cursor) >= page.latestLedger);
      let wrote = 0;
      this.db.tx(() => {
        let lowest: number | undefined;
        for (const ev of page.events) {
          if (!this.insertEvent(asset.id, ev)) continue;
          wrote++;
          if (lowest === undefined || ev.ledger < lowest) lowest = ev.ledger;
        }
        // A checkpoint at or after a ledger that just gained an event no longer covers it.
        if (lowest !== undefined) {
          this.db.write("DELETE FROM holdings_checkpoints WHERE asset_id = ? AND ledger >= ?", asset.id, lowest);
        }
        if (atTip) {
          this.db.write(
            `UPDATE assets SET cursor = COALESCE(?, cursor), synced_ledger = MAX(COALESCE(synced_ledger, 0), ?),
               synced_at = COALESCE(?, synced_at) WHERE id = ?`,
            cursor ?? null,
            page.latestLedger,
            page.latestLedgerClosedAt ?? null,
            asset.id,
          );
        } else {
          // Only a pass that reaches the tip may say how far the asset is indexed. Moving the
          // watermark on every page would have a pass that dies half-way claim the whole chain.
          this.db.write("UPDATE assets SET cursor = ? WHERE id = ?", cursor, asset.id);
        }
      });
      if (wrote > 0) {
        added += wrote;
        this.touch(asset.id);
      }
      if (atTip || !cursor) break;
      // Out of time: the cursor is saved, so the next pass carries on from here.
      if (deadline !== undefined && this.clock() >= deadline) return { added, more: true };
      from = { cursor };
    }
    return { added };
  }

  private insertEvent(assetId: string, ev: AssetEvent): boolean {
    const written = this.db.write(
      `INSERT OR IGNORE INTO events (id, asset_id, kind, ledger, closed_at, tx_hash, from_addr, to_addr, amount, authorized)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ev.id,
      assetId,
      ev.kind,
      ev.ledger,
      ev.closedAt,
      ev.txHash,
      ev.from ?? null,
      ev.to ?? null,
      ev.amount.toString(),
      ev.authorized === undefined ? null : ev.authorized ? 1 : 0,
    );
    return written > 0;
  }

  /** Sync if a chain source is present; a failure becomes a warning, not an abort. */
  private async trySync(asset: AssetRecord, warnings: string[]): Promise<void> {
    if (!this.networks[asset.network]?.chain) return;
    try {
      await this.sync(asset.id);
    } catch (err) {
      warnings.push(`Could not refresh from the chain: ${describeFailure(err)}`);
    }
  }

  // ── chain state ───────────────────────────────────────────────────────────

  private loadEvents(assetId: string): AssetEvent[] {
    return this.db.all("SELECT * FROM events WHERE asset_id = ? ORDER BY id", assetId).map(toEvent);
  }

  /** Freezes, authorisations and clawbacks: all the controls log reads. */
  private loadControlEvents(assetId: string): AssetEvent[] {
    return this.db
      .all("SELECT * FROM events WHERE asset_id = ? AND kind IN ('set_authorized', 'clawback') ORDER BY id", assetId)
      .map(toEvent);
  }

  private openings(assetId: string): Map<string, Opening> {
    const out = new Map<string, Opening>();
    for (const row of this.db.all("SELECT * FROM openings WHERE asset_id = ?", assetId)) {
      const opening: Opening = { amount: BigInt(String(row.amount)), asOfLedger: Number(row.as_of_ledger) };
      if (row.authorized !== null) opening.authorized = Number(row.authorized) === 1;
      out.set(String(row.address), opening);
    }
    return out;
  }

  /**
   * Holdings from replaying events over the opening balances. Treat the result as read-only.
   *
   * Without `events`, the replay starts from the nearest stored checkpoint at or before
   * `upToTime` and reads only the events after it, so the cost near the tip does not grow with
   * the length of the history. Given `events`, it replays exactly those.
   */
  state(asset: AssetRecord, upToTime?: string, events?: AssetEvent[]): HoldingsState {
    const current = upToTime === undefined && events === undefined;
    if (current) {
      this.fresh();
      const hit = this.stateMemo.get(asset.id);
      if (hit) return hit;
    }
    const opening = this.openings(asset.id);
    const baselineLedger = asset.baselineLedger ?? 0;
    let state: HoldingsState;
    if (events) {
      state = replay(events, { opening, baselineLedger, ...(upToTime ? { upToTime } : {}) });
    } else {
      this.extendCheckpoints(asset.id, opening, baselineLedger);
      const checkpoint = upToTime
        ? this.db.get(
            "SELECT * FROM holdings_checkpoints WHERE asset_id = ? AND closed_at <= ? ORDER BY ledger DESC LIMIT 1",
            asset.id,
            upToTime,
          )
        : this.db.get("SELECT * FROM holdings_checkpoints WHERE asset_id = ? ORDER BY ledger DESC LIMIT 1", asset.id);
      if (checkpoint) {
        const tail = this.db
          .all(
            `SELECT * FROM events WHERE asset_id = ? AND ledger > ?${upToTime ? " AND closed_at <= ?" : ""} ORDER BY id`,
            asset.id,
            Number(checkpoint.ledger),
            ...(upToTime ? [upToTime] : []),
          )
          .map(toEvent);
        state = resume(decodeCheckpoint(String(checkpoint.state)), tail, opening, baselineLedger, upToTime);
      } else {
        state = replay(this.loadEvents(asset.id), { opening, baselineLedger, ...(upToTime ? { upToTime } : {}) });
      }
    }
    if (current) this.stateMemo.set(asset.id, state);
    return state;
  }

  /**
   * Store a checkpoint after every `checkpointEvery` events not yet covered by one. A checkpoint
   * sits on a ledger boundary (every event after it is in a later ledger) and records the latest
   * close time it covers, so a replay up to any later time can start from it. The newest ledger
   * is never checkpointed: more of its events may still arrive.
   */
  private extendCheckpoints(assetId: string, opening: Map<string, Opening>, baselineLedger: number): void {
    const last = this.db.get(
      "SELECT ledger, closed_at, state FROM holdings_checkpoints WHERE asset_id = ? ORDER BY ledger DESC LIMIT 1",
      assetId,
    );
    const after = last ? Number(last.ledger) : -1;
    const pending =
      this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE asset_id = ? AND ledger > ?", assetId, after)
        ?.n ?? 0;
    if (pending <= this.checkpointEvery) return;
    const events = sortEvents(
      this.db.all("SELECT * FROM events WHERE asset_id = ? AND ledger > ?", assetId, after).map(toEvent),
    );
    // Lowest ledger at or after each position: a boundary needs every later event in a later ledger.
    const lowestFrom = new Array<number>(events.length + 1).fill(Number.POSITIVE_INFINITY);
    for (let i = events.length - 1; i >= 0; i--) lowestFrom[i] = Math.min(events[i]!.ledger, lowestFrom[i + 1]!);
    let state = last ? decodeCheckpoint(String(last.state)) : undefined;
    let closedAt = last ? String(last.closed_at) : "";
    let start = 0;
    this.db.tx(() => {
      for (let i = 0; i < events.length - 1; i++) {
        const ev = events[i]!;
        if (ev.closedAt > closedAt) closedAt = ev.closedAt;
        if (i + 1 - start < this.checkpointEvery || lowestFrom[i + 1]! <= ev.ledger) continue;
        const chunk = events.slice(start, i + 1);
        state = state ? resume(state, chunk, opening, baselineLedger) : replay(chunk, { opening, baselineLedger });
        this.db.write(
          "INSERT OR REPLACE INTO holdings_checkpoints (asset_id, ledger, closed_at, state, created_at) VALUES (?, ?, ?, ?, ?)",
          assetId,
          ev.ledger,
          closedAt,
          encodeCheckpoint(state),
          now(),
        );
        start = i + 1;
      }
    });
  }

  /**
   * Holders of an asset at a moment. Without `page` every holder is returned (exports rely on
   * this). With `page` the list is filtered, sorted and cut to one page; `supply` and
   * `holderCount` always describe the whole asset, and `matched` counts holders matching `q`.
   * Every sort ends on the address, so the order is total and pages are stable across calls.
   */
  /**
   * The rows that deleting one asset, or the whole workspace, would remove. Counted from the same
   * tables the deletes cascade through, so an operator sees the size of the loss first.
   */
  deletionCounts(ref?: string): DeletionCounts {
    const asset = ref ? this.asset(ref) : undefined;
    const args: string[] = asset ? [asset.id] : [];
    // The assets table keys on `id`; everything else that belongs to an asset keys on `asset_id`.
    const count = (table: string, column = "asset_id"): number =>
      Number(
        this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}${asset ? ` WHERE ${column} = ?` : ""}`, ...args)
          ?.n ?? 0,
      );
    return {
      assets: asset ? 1 : count("assets", "id"),
      events: count("events"),
      registers: count("registers"),
      runs: count("runs"),
      notes: count("break_notes"),
    };
  }

  holdings(ref: string, asOf?: string, page?: HoldingsPage) {
    const asset = this.asset(ref);
    const upTo = asOf ? isoTime(asOf, "asOf") : undefined;
    const paging = page ? holdingsPage(page) : undefined;
    const state = this.state(asset, upTo);
    const ignored = new Set(asset.ignore);
    let rows = [...state.balances].sort(
      paging?.sort === "address"
        ? (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
        : (a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) : a[1] > b[1] ? -1 : 1),
    );
    const holderCount = rows.length;
    let pageInfo: { matched: number; offset: number; limit: number; next: string | null } | undefined;
    if (paging) {
      if (paging.q) rows = rows.filter(([address]) => address.startsWith(paging.q!));
      const matched = rows.length;
      let offset = paging.offset;
      if (paging.after !== undefined) {
        const after = paging.after;
        const at = rows.findIndex(([address]) => address === after);
        if (at >= 0) offset = at + 1;
        else if (paging.sort === "address") {
          // The holder may have left since the last page; resume at the next address instead.
          const next = rows.findIndex(([address]) => address > after);
          offset = next < 0 ? rows.length : next;
        } else throw new Invalid("after must name a holder on this list; it may have sold out, so start again");
      }
      rows = rows.slice(offset, offset + paging.limit);
      const end = offset + rows.length;
      pageInfo = { matched, offset, limit: paging.limit, next: end < matched && rows.length > 0 ? rows[rows.length - 1]![0] : null };
    }
    const holders = rows
      .map(([address, units]) => ({
        address,
        units: formatUnits(units, asset.decimals),
        // Percent to four decimals, rounded half up (truncating let a column of shares sum to 99.9999).
        share: state.supply > 0n ? Number((units * 2_000_000n + state.supply) / (state.supply * 2n)) / 10_000 : 0,
        status: state.authorized.has(address) ? (state.authorized.get(address) ? "active" : "frozen") : null,
        ignored: ignored.has(address),
      }));
    const start = this.historyStart(asset);
    const beforeHistory = Boolean(upTo && start && upTo < start);
    const warnings: string[] = [];
    if (beforeHistory) {
      warnings.push(
        `as-of time (${upTo}) is earlier than history start (${start}); activity before history start is not reflected`,
      );
    }
    return {
      asOf: upTo ?? asset.syncedAt ?? null,
      ledger: state.ledger,
      supply: formatUnits(state.supply, asset.decimals),
      holderCount,
      incomplete: state.incomplete,
      beforeHistory,
      warnings,
      ...(pageInfo ? { page: pageInfo } : {}),
      holders,
    };
  }

  events(ref: string, filter: { kind?: string; address?: string; limit?: number; before?: string } = {}) {
    const asset = this.asset(ref);
    const where = ["asset_id = ?"];
    const params: Array<string | number> = [asset.id];
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.address) {
      where.push("(from_addr = ? OR to_addr = ?)");
      params.push(filter.address, filter.address);
    }
    if (filter.before) {
      where.push("id < ?");
      params.push(filter.before);
    }
    const limit = Number.isFinite(filter.limit) ? Math.trunc(filter.limit!) : 100;
    params.push(Math.min(Math.max(limit, 1), 1000));
    return this.db
      .all(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...params)
      .map((row) => this.eventJson(toEvent(row), asset.decimals));
  }

  private eventJson(ev: AssetEvent, decimals: number) {
    return {
      id: ev.id,
      kind: ev.kind,
      ledger: ev.ledger,
      closedAt: ev.closedAt,
      txHash: ev.txHash,
      from: ev.from ?? null,
      to: ev.to ?? null,
      units: ev.kind === "set_authorized" ? null : formatUnits(ev.amount, decimals),
      authorized: ev.authorized ?? null,
    };
  }

  // ── register side ─────────────────────────────────────────────────────────

  importRegister(ref: string, input: { csv: string; asOf: string; source?: string }, actor?: Actor) {
    const asset = this.asset(ref);
    const asOf = isoTime(input.asOf, "asOf");
    if (Date.parse(asOf) > Date.now() + MAX_REGISTER_CLOCK_SKEW_MS) {
      throw new Invalid("asOf cannot be more than 5 minutes in the future");
    }
    let parsed;
    try {
      parsed = parseRegisterCsv(input.csv, asset.decimals);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    if (parsed.positions.length === 0) throw new Invalid("register has no usable rows");
    // The same bytes for the same instant is the same register, not a second one.
    const existing = this.db.get<{ id: number }>(
      "SELECT id FROM registers WHERE asset_id = ? AND as_of = ? AND sha256 = ? ORDER BY id LIMIT 1",
      asset.id,
      asOf,
      sha256(input.csv),
    );
    if (existing) {
      return { registerId: existing.id, asOf, positions: parsed.positions.length, issues: parsed.issues, duplicate: true };
    }
    const registerId = this.db.tx(() => {
      const id = this.db.insert(
        "INSERT INTO registers (asset_id, as_of, source, sha256, issues, imported_by, imported_by_id, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        asset.id,
        asOf,
        label(input.source, "source", 200) ?? "upload",
        sha256(input.csv),
        JSON.stringify(parsed.issues),
        actor?.label ?? null,
        actor?.id ?? null,
        now(),
      );
      for (const p of parsed.positions) {
        this.db.insert(
          "INSERT INTO register_positions (register_id, holder_id, holder_name, account, units, status) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          p.holderId,
          p.holderName ?? null,
          p.account ?? null,
          p.units.toString(),
          p.status ?? null,
        );
      }
      return id;
    });
    return { registerId, asOf, positions: parsed.positions.length, issues: parsed.issues, duplicate: false };
  }

  registers(ref: string) {
    const asset = this.asset(ref);
    return this.db
      .all(
        `SELECT r.*, (SELECT COUNT(*) FROM register_positions p WHERE p.register_id = r.id) AS positions
         FROM registers r WHERE asset_id = ? ORDER BY as_of DESC, id DESC`,
        asset.id,
      )
      .map((r) => ({
        id: Number(r.id),
        asOf: String(r.as_of),
        source: String(r.source),
        sha256: String(r.sha256),
        positions: Number(r.positions),
        issues: JSON.parse(String(r.issues)) as Array<{ line: number; message: string }>,
        importedBy: r.imported_by ? String(r.imported_by) : null,
        importedAt: String(r.imported_at),
      }));
  }

  /** Remove a register, its holder lines and every reconciliation run against it. */
  deleteRegister(ref: string, registerId: number): { runs: number } {
    const asset = this.asset(ref);
    const runs =
      this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM runs WHERE register_id = ? AND asset_id = ?",
        registerId,
        asset.id,
      )?.count ?? 0;
    const removed = this.db.write("DELETE FROM registers WHERE id = ? AND asset_id = ?", registerId, asset.id);
    if (removed === 0) throw new NotFound("no such register for this asset");
    return { runs };
  }

  /**
   * What the transfer agent changed between two registers of one asset, independently of the
   * chain: holders added and removed, and holders whose units, accounts or statuses differ.
   * Keyed by `holder_id`; a holder listed on several lines is compared on the sum of its units
   * and the set of its accounts and statuses. Every list is sorted by holder id.
   */
  diffRegisters(ref: string, fromId: number, toId: number) {
    const asset = this.asset(ref);
    const load = (registerId: number) => {
      const reg = this.db.get("SELECT id, asset_id, as_of FROM registers WHERE id = ?", registerId);
      if (!reg) throw new NotFound(`no register ${registerId}`);
      if (String(reg.asset_id) !== asset.id) throw new Invalid(`register ${registerId} belongs to a different asset`);
      const holders = new Map<string, { name?: string; units: bigint; accounts: Set<string>; statuses: Set<string> }>();
      for (const p of this.registerPositions(registerId)) {
        const h = holders.get(p.holderId) ?? { units: 0n, accounts: new Set<string>(), statuses: new Set<string>() };
        h.units += p.units;
        if (p.holderName && h.name === undefined) h.name = p.holderName;
        if (p.account) h.accounts.add(p.account);
        if (p.status) h.statuses.add(p.status);
        holders.set(p.holderId, h);
      }
      return { ref: { registerId, asOf: String(reg.as_of) }, holders };
    };
    const from = load(fromId);
    const to = load(toId);
    const sorted = (s: Set<string>) => [...s].sort();
    const view = (h: { units: bigint; accounts: Set<string>; statuses: Set<string> }) => ({
      units: formatUnits(h.units, asset.decimals),
      accounts: sorted(h.accounts),
      statuses: sorted(h.statuses),
    });
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
    const byId = (a: { holderId: string }, b: { holderId: string }) =>
      a.holderId < b.holderId ? -1 : a.holderId > b.holderId ? 1 : 0;

    const added = [];
    const removed = [];
    const changed = [];
    let unchanged = 0;
    for (const [holderId, h] of to.holders) {
      if (!from.holders.has(holderId)) added.push({ holderId, holderName: h.name ?? null, ...view(h) });
    }
    for (const [holderId, before] of from.holders) {
      const after = to.holders.get(holderId);
      if (!after) {
        removed.push({ holderId, holderName: before.name ?? null, ...view(before) });
        continue;
      }
      const fields: Array<"units" | "accounts" | "statuses"> = [];
      if (before.units !== after.units) fields.push("units");
      if (!same(before.accounts, after.accounts)) fields.push("accounts");
      if (!same(before.statuses, after.statuses)) fields.push("statuses");
      if (fields.length === 0) {
        unchanged++;
        continue;
      }
      changed.push({
        holderId,
        holderName: after.name ?? before.name ?? null,
        fields,
        unitsDelta: formatUnits(after.units - before.units, asset.decimals),
        from: view(before),
        to: view(after),
      });
    }
    added.sort(byId);
    removed.sort(byId);
    changed.sort(byId);
    return {
      asset: { id: asset.id, code: asset.code },
      from: from.ref,
      to: to.ref,
      summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
      added,
      removed,
      changed,
    };
  }

  private registerPositions(registerId: number): RegisterPosition[] {
    return this.db.all("SELECT * FROM register_positions WHERE register_id = ?", registerId).map((r) => {
      const p: RegisterPosition = { holderId: String(r.holder_id), units: BigInt(String(r.units)) };
      if (r.holder_name) p.holderName = String(r.holder_name);
      if (r.account) p.account = String(r.account);
      if (r.status) p.status = String(r.status) as "active" | "frozen";
      return p;
    });
  }

  importJournal(
    ref: string,
    csv: string,
    options?: { mode?: "merge" | "replace"; allowPartial?: boolean },
  ) {
    const mode = options?.mode ?? "merge";
    const allowPartial = options?.allowPartial ?? false;
    if (mode !== "merge" && mode !== "replace") {
      throw new Invalid("mode must be 'merge' or 'replace'");
    }
    const asset = this.asset(ref);
    let parsed;
    try {
      parsed = parseJournalCsv(csv, asset.decimals);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    if (mode === "replace" && parsed.issues.length > 0 && !allowPartial) {
      throw new Invalid(`cannot replace journal: CSV contains ${parsed.issues.length} parse errors and allowPartial is false`);
    }

    const existing = this.db.all<{ ref: string }>("SELECT ref FROM journal WHERE asset_id = ?", asset.id);
    const existingRefs = new Set(existing.map((r) => r.ref));

    let added = 0;
    let replaced = 0;
    let removed = 0;

    this.db.tx(() => {
      if (mode === "replace") {
        const fileRefs = new Set(parsed.entries.map((e) => e.ref));
        for (const r of existingRefs) {
          if (!fileRefs.has(r)) {
            removed++;
          }
        }
        this.db.write("DELETE FROM journal WHERE asset_id = ?", asset.id);
        const seenInFile = new Set<string>();
        for (const e of parsed.entries) {
          if (!seenInFile.has(e.ref)) {
            seenInFile.add(e.ref);
            if (existingRefs.has(e.ref)) {
              replaced++;
            } else {
              added++;
            }
          }
          this.db.insert(
            `INSERT OR REPLACE INTO journal (asset_id, ref, date, type, from_addr, to_addr, units, tx_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            asset.id,
            e.ref,
            e.date,
            e.type,
            e.from ?? null,
            e.to ?? null,
            e.units.toString(),
            e.txHash ?? null,
          );
        }
      } else {
        const seenInFile = new Set<string>();
        for (const e of parsed.entries) {
          if (!seenInFile.has(e.ref)) {
            seenInFile.add(e.ref);
            if (existingRefs.has(e.ref)) {
              replaced++;
            } else {
              added++;
            }
          }
          this.db.insert(
            `INSERT OR REPLACE INTO journal (asset_id, ref, date, type, from_addr, to_addr, units, tx_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            asset.id,
            e.ref,
            e.date,
            e.type,
            e.from ?? null,
            e.to ?? null,
            e.units.toString(),
            e.txHash ?? null,
          );
        }
      }
    });
    return {
      entries: parsed.entries.length,
      issues: parsed.issues,
      added,
      replaced,
      removed,
    };
  }

  private journal(assetId: string): JournalEntry[] {
    return this.db.all("SELECT * FROM journal WHERE asset_id = ?", assetId).map((r) => {
      const e: JournalEntry = {
        ref: String(r.ref),
        date: String(r.date),
        type: String(r.type) as JournalEntry["type"],
        units: BigInt(String(r.units)),
      };
      if (r.from_addr) e.from = String(r.from_addr);
      if (r.to_addr) e.to = String(r.to_addr);
      if (r.tx_hash) e.txHash = String(r.tx_hash);
      return e;
    });
  }

  /** Imported journal entries with formatted units and latest-run movement match status. */
  journalEntries(ref: string, options: { limit?: number; before?: string } = {}) {
    const asset = this.asset(ref);
    const where = ["asset_id = ?"];
    const params: Array<string | number> = [asset.id];
    if (options.before) {
      const anchor = this.db.get<{ date: string }>(
        "SELECT date FROM journal WHERE asset_id = ? AND ref = ?",
        asset.id,
        options.before,
      );
      if (anchor) {
        where.push("(date < ? OR (date = ? AND ref < ?))");
        params.push(anchor.date, anchor.date, options.before);
      } else {
        where.push("date < ?");
        params.push(options.before);
      }
    }
    const rawLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 100;
    params.push(Math.min(Math.max(rawLimit, 1), 1000));
    const latest = this.latestRun(asset.id);
    const movementMatches = (latest?.movement?.matches as Array<{ ref: string }> | undefined) ?? null;
    const matchedRefs = movementMatches ? new Set(movementMatches.map((m) => m.ref)) : null;

    return this.db
      .all(`SELECT * FROM journal WHERE ${where.join(" AND ")} ORDER BY date DESC, ref DESC LIMIT ?`, ...params)
      .map((r) => {
        const entryRef = String(r.ref);
        return {
          ref: entryRef,
          date: String(r.date),
          type: String(r.type) as JournalEntry["type"],
          from: r.from_addr ? String(r.from_addr) : null,
          to: r.to_addr ? String(r.to_addr) : null,
          units: formatUnits(BigInt(String(r.units)), asset.decimals),
          txHash: r.tx_hash ? String(r.tx_hash) : null,
          status: matchedRefs === null ? null : matchedRefs.has(entryRef) ? ("matched" as const) : ("unmatched" as const),
        };
      });
  }

  /** Remove a single journal entry by its ref. */
  deleteJournalEntry(ref: string, entryRef: string): void {
    const asset = this.asset(ref);
    const removed = this.db.write("DELETE FROM journal WHERE asset_id = ? AND ref = ?", asset.id, entryRef);
    if (removed === 0) throw new NotFound(`no such journal entry ${entryRef} for this asset`);
  }

  importInstructions(ref: string, csv: string, options: { mode?: "merge" | "replace" } = {}) {
    const mode = options.mode ?? "merge";
    if (mode !== "merge" && mode !== "replace") {
      throw new Invalid('mode must be "merge" or "replace"');
    }
    const asset = this.asset(ref);
    let parsed;
    try {
      parsed = parseInstructionsCsv(csv, asset.decimals);
    } catch (err) {
      throw new Invalid((err as Error).message);
    }
    if (mode === "replace" && parsed.issues.length > 0) {
      throw new Invalid(
        `replace mode refused because the CSV had ${parsed.issues.length} parse issue(s) (line ${parsed.issues[0]!.line}: ${parsed.issues[0]!.message})`,
      );
    }
    let added = 0;
    let replaced = 0;
    let removed = 0;
    this.db.tx(() => {
      const existingRefs = new Set(
        this.db.all<{ ref: string }>("SELECT ref FROM instructions WHERE asset_id = ?", asset.id).map((r) => r.ref),
      );
      const incomingRefs = new Set<string>();
      for (const i of parsed.instructions) {
        if (existingRefs.has(i.ref)) replaced++;
        else added++;
        existingRefs.add(i.ref);
        incomingRefs.add(i.ref);
        this.db.insert(
          `INSERT OR REPLACE INTO instructions (asset_id, ref, type, account, units, issued_at, approved_by, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          asset.id,
          i.ref,
          i.type,
          i.account,
          i.units?.toString() ?? null,
          i.issuedAt,
          i.approvedBy ?? null,
          i.reason ?? null,
        );
      }
      if (mode === "replace") {
        for (const existingRef of existingRefs) {
          if (!incomingRefs.has(existingRef)) {
            removed += this.db.write("DELETE FROM instructions WHERE asset_id = ? AND ref = ?", asset.id, existingRef);
          }
        }
      }
    });
    return { instructions: parsed.instructions.length, added, replaced, removed, issues: parsed.issues };
  }

  private instructions(assetId: string): Instruction[] {
    return this.db.all("SELECT * FROM instructions WHERE asset_id = ?", assetId).map((r) => {
      const i: Instruction = {
        ref: String(r.ref),
        type: String(r.type) as Instruction["type"],
        account: String(r.account),
        issuedAt: String(r.issued_at),
      };
      if (r.units) i.units = BigInt(String(r.units));
      if (r.approved_by) i.approvedBy = String(r.approved_by);
      if (r.reason) i.reason = String(r.reason);
      return i;
    });
  }

  /** Imported control instructions with formatted units. */
  instructionList(ref: string) {
    const asset = this.asset(ref);
    return this.db
      .all("SELECT * FROM instructions WHERE asset_id = ? ORDER BY issued_at DESC, ref DESC", asset.id)
      .map((r) => ({
        ref: String(r.ref),
        type: String(r.type) as Instruction["type"],
        account: String(r.account),
        units: r.units ? formatUnits(BigInt(String(r.units)), asset.decimals) : null,
        issuedAt: String(r.issued_at),
        approvedBy: r.approved_by ? String(r.approved_by) : null,
        reason: r.reason ? String(r.reason) : null,
      }));
  }

  /** Remove a single instruction by its ref. */
  deleteInstruction(ref: string, instructionRef: string): void {
    const asset = this.asset(ref);
    const removed = this.db.write("DELETE FROM instructions WHERE asset_id = ? AND ref = ?", asset.id, instructionRef);
    if (removed === 0) throw new NotFound(`no such instruction ${instructionRef} for this asset`);
  }

  // ── reconciliation ────────────────────────────────────────────────────────

  /** Reconcile one register (the latest by default) against chain state at its as-of time. */
  async reconcile(ref: string, registerId?: number, actor?: Actor) {
    const warnings: string[] = [];
    await this.trySync(this.asset(ref), warnings);
    const asset = this.asset(ref);
    const reg = registerId
      ? this.db.get("SELECT * FROM registers WHERE id = ? AND asset_id = ?", registerId, asset.id)
      : this.db.get("SELECT * FROM registers WHERE asset_id = ? ORDER BY as_of DESC, id DESC LIMIT 1", asset.id);
    if (!reg) throw new NotFound("no register imported for this asset");
    const asOf = String(reg.as_of);
    const fmt = (v: bigint | undefined) => (v === undefined ? null : formatUnits(v, asset.decimals));

    const chainBehind = !asset.syncedAt || asset.syncedAt < asOf;
    if (chainBehind) {
      warnings.push(
        `Chain is indexed to ${asset.syncedAt ?? "nothing"}, before the register's as-of time; later activity is not reflected`,
      );
    }
    const start = this.historyStart(asset);
    if (start && asOf < start) {
      warnings.push(
        `Register as-of time (${asOf}) is earlier than history start (${start}); activity before history start is not reflected`,
      );
    }
    const events = this.loadEvents(asset.id);
    const state = this.state(asset, asOf, events);
    const positions = reconcilePositions(state, this.registerPositions(Number(reg.id)), {
      ignore: asset.ignore,
      ...(asset.tolerance ? { tolerance: BigInt(asset.tolerance) } : {}),
    });

    const breaks: StoredBreak[] = positions.breaks.map((b) => ({
      scope: "position",
      type: b.type,
      severity: b.severity,
      key: b.key,
      fingerprint: `${b.chainUnits ?? ""}|${b.registerUnits ?? ""}`,
      message: b.message,
      address: b.address ?? null,
      holderIds: b.holderIds,
      chainUnits: fmt(b.chainUnits),
      registerUnits: fmt(b.registerUnits),
      difference: fmt(b.difference),
    }));

    let movement: Record<string, unknown> | null = null;
    const journal = this.journal(asset.id);
    if (journal.length > 0) {
      const previous = this.db.get<{ as_of: string }>(
        "SELECT as_of FROM registers WHERE asset_id = ? AND as_of < ? ORDER BY as_of DESC LIMIT 1",
        asset.id,
        asOf,
      );
      const ignored = new Set(asset.ignore);
      // Movements wholly among ignored addresses are outside the register's scope.
      const scoped = events.filter((e) => ![e.from, e.to].every((a) => a === undefined || ignored.has(a)));
      // Likewise a journal entry wholly among ignored addresses has no event left to match.
      const scopedJournal = journal.filter((j) => {
        const parties = [j.from, j.to].filter((a) => a !== undefined);
        return parties.length === 0 || !parties.every((a) => ignored.has(a));
      });
      const result = reconcileMovements(scoped, scopedJournal, {
        to: asOf,
        windowMs: asset.movementWindowHours * 3600_000,
        ...(previous ? { from: new Date(Date.parse(previous.as_of) + 1).toISOString() } : {}),
      });
      movement = { from: previous?.as_of ?? null, to: asOf, ...result.summary, matches: result.matches };
      for (const b of result.breaks) {
        breaks.push({
          scope: "movement",
          type: b.type,
          severity: b.severity,
          key: b.key,
          fingerprint: `${b.chainUnits ?? ""}|${b.registerUnits ?? ""}`,
          message: b.message,
          address: b.address ?? null,
          ref: b.ref ?? null,
          txHash: b.txHash ?? null,
          eventId: b.eventId ?? null,
          chainUnits: fmt(b.chainUnits),
          registerUnits: fmt(b.registerUnits),
          difference: fmt(b.difference),
        });
      }
    }

    const prior = this.db.get<{ result: string }>(
      "SELECT result FROM runs WHERE asset_id = ? AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1",
      asset.id,
      asOf,
    );
    const priorSeen = new Map<string, string>();
    if (prior) {
      for (const b of (JSON.parse(prior.result) as { breaks: StoredBreak[] }).breaks) {
        if (b.firstSeen) priorSeen.set(b.key, b.firstSeen);
      }
    }
    for (const b of breaks) b.firstSeen = priorSeen.get(b.key) ?? asOf;

    const s = positions.summary;
    const coverage = this.coverage(asset, asOf);
    const result: RunResult = {
      registerId: Number(reg.id),
      registerSha256: String(reg.sha256),
      asOf,
      chainLedger: state.ledger,
      chainSyncedAt: asset.syncedAt ?? null,
      chainBehind,
      warnings,
      status: breaks.length === 0 ? "clean" : "breaks",
      tolerance: asset.tolerance ?? null,
      summary: {
        chainSupply: fmt(s.chainSupply),
        registerTotal: fmt(s.registerTotal),
        supplyDifference: fmt(s.chainSupply - s.registerTotal),
        unmappedUnits: fmt(s.unmappedUnits),
        grossDifference: fmt(s.grossDifference),
        chainHolders: s.chainHolders,
        registerHolders: s.registerHolders,
        lines: positions.lines.length,
        matchedLines: s.matchedLines,
        breakCount: breaks.length,
      },
      lines: positions.lines.map((l) => ({
        address: l.address,
        holderIds: l.holderIds,
        chainUnits: fmt(l.chainUnits),
        registerUnits: fmt(l.registerUnits),
        difference: fmt(l.difference),
        chainStatus: l.chainStatus ?? null,
        registerStatus: l.registerStatus ?? null,
        matched: l.matched,
      })),
      movement,
      breaks,
      coverage,
    };
    const openBreaks = this.annotate(asset.id, "recon", breaks).filter((b) => b.status === "open").length;
    const id = this.db.insert(
      `INSERT INTO runs (asset_id, register_id, as_of, created_by, created_at, summary, status, chain_behind, open_breaks, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      asset.id,
      Number(reg.id),
      asOf,
      actor?.label ?? null,
      now(),
      JSON.stringify(result.summary),
      result.status,
      chainBehind ? 1 : 0,
      openBreaks,
      JSON.stringify(result),
    );
    if (breaks.length > 0) {
      this.alert("run.breaks", asset, breaks.length, `/#/a/${asset.id}/reconciliation`);
    }
    return this.run(id);
  }

  run(id: number) {
    const row = this.db.get("SELECT * FROM runs WHERE id = ?", id);
    if (!row) throw new NotFound(`reconciliation ${id} not found`);
    const result = JSON.parse(String(row.result)) as RunResult;
    const breaks = this.annotate(String(row.asset_id), "recon", result.breaks);
    return {
      id: Number(row.id),
      assetId: String(row.asset_id),
      createdAt: String(row.created_at),
      ...result,
      breaks,
      openBreaks: breaks.filter((b) => b.status === "open").length,
    };
  }

  runReport(id: number) {
    const row = this.db.get("SELECT * FROM runs WHERE id = ?", id);
    if (!row) throw new NotFound(`reconciliation ${id} not found`);
    const stored = String(row.result);
    const result = JSON.parse(stored) as RunResult;
    const asset = this.asset(String(row.asset_id));
    const breaks = this.annotate(asset.id, "recon", result.breaks);
    const digest = sha256(stored);
    const historyStart = this.historyStart(asset);
    const value = (raw: unknown) => (raw === null || raw === undefined || raw === "" ? "n/a" : escapeHtml(raw));
    const facts = (entries: Array<[string, unknown]>) =>
      entries
        .map(([label, raw]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${value(raw)}</td></tr>`)
        .join("\n            ");
    const summary = facts([
      ["Status", result.status],
      ...Object.entries(result.summary).map(([key, raw]): [string, unknown] => [SUMMARY_LABELS[key] ?? key, raw]),
    ]);
    const coverage = facts([
      ["History starts", historyStart ?? null],
      ["Start mode", asset.startMode],
      ["Start ledger", asset.startLedger ?? null],
      ["Baseline ledger", asset.baselineLedger ?? null],
      ["Indexed to ledger", asset.syncedLedger ?? null],
      ["Indexed to time", asset.syncedAt ?? null],
      ["Chain ledger at run", result.chainLedger],
      ["Chain synced at run", result.chainSyncedAt],
      ["Chain behind register", result.chainBehind ? "yes" : "no"],
      ["Ignored addresses", asset.ignore.length === 0 ? "none" : asset.ignore.join(", ")],
    ]);
    const warnings =
      result.warnings.length === 0
        ? `<p class="empty">No warnings.</p>`
        : `<ul>\n            ${result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("\n            ")}\n          </ul>`;
    const breakSections =
      breaks.length === 0
        ? `<p class="empty">No breaks in this run.</p>`
        : breaks
            .map((b) => {
              const history = this.noteHistory(asset.id, "recon", b.key);
              const historyRows =
                history.length === 0
                  ? `<tr><td colspan="4">No sign-off history.</td></tr>`
                  : history
                      .map(
                        (h) =>
                          `<tr><td>${value(h.at)}</td><td>${value(h.status)}</td><td>${value(h.author)}</td><td>${value(h.note)}</td></tr>`,
                      )
                      .join("\n                  ");
              const factsRows = facts([
                ["Scope", b.scope],
                ["Key", b.key],
                ["Address", b.address],
                ["Holder IDs", b.holderIds?.join(", ") ?? null],
                ["Chain units", b.chainUnits],
                ["Register units", b.registerUnits],
                ["Difference", b.difference],
                ["Expected", b.expected],
                ["Observed", b.observed],
                ["Transaction", b.txHash],
                ["Event", b.eventId],
                ["First seen", b.firstSeen],
                ["Current status", b.status],
                ["Current note", b.note],
                ["Noted by", b.noteAuthor],
                ["Noted at", b.noteAt],
                ["Stale note", b.noteStale ? "yes" : "no"],
              ]);
              return `<article class="break">
          <h3>${escapeHtml(b.type)} <span class="severity severity-${escapeHtml(b.severity)}">${escapeHtml(b.severity)}</span></h3>
          <p>${escapeHtml(b.message)}</p>
          <table class="facts">
            ${factsRows}
          </table>
          <h4>Sign-off history</h4>
          <table>
            <thead><tr><th>When</th><th>Status</th><th>By</th><th>Note</th></tr></thead>
            <tbody>
                  ${historyRows}
            </tbody>
          </table>
        </article>`;
            })
            .join("\n        ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Concord reconciliation report ${escapeHtml(asset.code)} ${escapeHtml(result.asOf)}</title>
<style>
:root { color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: #f6f7f9; color: #16181d; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 24px 64px; background: #fff; }
header { border-bottom: 2px solid #16181d; padding-bottom: 16px; margin-bottom: 24px; }
.eyebrow { margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: #5b6070; }
h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.2; }
h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #d8dbe2; }
h3 { font-size: 15px; margin: 0 0 6px; }
h4 { font-size: 13px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: 0.04em; color: #5b6070; }
.meta, .empty { color: #5b6070; }
section { margin-bottom: 28px; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 0; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid #e3e5ea; }
th { font-weight: 600; color: #3b3f4a; }
table.facts th { width: 34%; }
.break { border: 1px solid #d8dbe2; border-radius: 6px; padding: 12px 14px; margin: 12px 0; page-break-inside: avoid; break-inside: avoid; }
.severity { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; background: #eef0f4; color: #3b3f4a; }
.severity-high { background: #fde8e6; color: #9f1d14; }
.severity-medium { background: #fff2d9; color: #8a5a00; }
.severity-low { background: #e7f0fb; color: #1f4e8c; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
ul { margin: 6px 0 0; padding-left: 20px; }
@media print {
  body { background: #fff; font-size: 11pt; }
  main { max-width: none; padding: 0; }
  h2 { page-break-after: avoid; break-after: avoid; }
  .break { page-break-inside: avoid; break-inside: avoid; }
  @page { margin: 16mm; }
}
</style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">Concord reconciliation report</p>
    <h1>${escapeHtml(asset.name)} (${escapeHtml(asset.code)})</h1>
    <p class="meta">Run ${escapeHtml(row.id)} | ${escapeHtml(asset.network)} | created ${value(row.created_at)} | as of ${value(result.asOf)}</p>
  </header>

  <section>
    <h2>Integrity</h2>
    <table class="facts">
      <tr><th scope="row">Run result SHA-256</th><td><code>${escapeHtml(digest)}</code></td></tr>
      <tr><th scope="row">Register SHA-256</th><td><code>${escapeHtml(result.registerSha256)}</code></td></tr>
    </table>
  </section>

  <section>
    <h2>Summary</h2>
    <table class="facts">
      ${summary}
    </table>
  </section>

  <section>
    <h2>Coverage</h2>
    <table class="facts">
      ${coverage}
    </table>
    <h3>Warnings</h3>
    ${warnings}
  </section>

  <section>
    <h2>Breaks</h2>
    ${breakSections}
  </section>
</main>
</body>
</html>
`;
  }

  /**
   * The last 200 reconciliations as summaries. Everything comes from columns so that listing
   * never parses a stored result body, which for a thousand-holder register is hundreds of KB.
   */
  runs(ref: string) {
    const asset = this.asset(ref);
    return this.db
      .all<{
        id: number;
        as_of: string;
        created_at: string;
        status: string;
        chain_behind: number;
        summary: string;
        open_breaks: number;
      }>(
        `SELECT id, as_of, created_at, status, chain_behind, summary, open_breaks
         FROM runs WHERE asset_id = ? ORDER BY id DESC LIMIT 200`,
        asset.id,
      )
      .map((r) => ({
        id: Number(r.id),
        asOf: String(r.as_of),
        createdAt: String(r.created_at),
        status: String(r.status) as RunResult["status"],
        chainBehind: Number(r.chain_behind) === 1,
        summary: JSON.parse(String(r.summary)) as RunResult["summary"],
        openBreaks: Number(r.open_breaks),
      }));
  }

  /**
   * What changed between two reconciliations of one asset, yesterday's against today's say.
   * Breaks are matched by `key`: `new` ones appear only in the later run, `resolved` ones only
   * in the earlier, and of those in both, `changed` ones have a different `fingerprint` (the
   * figures moved) while `persisting` ones do not. Every list is sorted by key.
   */
  diffRuns(fromId: number, toId: number) {
    const load = (id: number) => {
      const row = this.db.get("SELECT id, asset_id, as_of, result FROM runs WHERE id = ?", id);
      if (!row) throw new NotFound(`reconciliation ${id} not found`);
      const breaks = new Map<string, StoredBreak>();
      for (const b of (JSON.parse(String(row.result)) as RunResult).breaks) breaks.set(b.key, b);
      return { assetId: String(row.asset_id), ref: { runId: id, asOf: String(row.as_of) }, breaks };
    };
    const from = load(fromId);
    const to = load(toId);
    if (from.assetId !== to.assetId) {
      throw new Invalid(`reconciliations ${fromId} and ${toId} are of different assets`);
    }
    const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const added: StoredBreak[] = [];
    const resolved: StoredBreak[] = [];
    const persisting: StoredBreak[] = [];
    const changed: Array<{ key: string; type: string; from: StoredBreak; to: StoredBreak }> = [];
    for (const [key, after] of to.breaks) {
      const before = from.breaks.get(key);
      if (!before) added.push(after);
      else if (before.fingerprint === after.fingerprint) persisting.push(after);
      else changed.push({ key, type: after.type, from: before, to: after });
    }
    for (const [key, before] of from.breaks) if (!to.breaks.has(key)) resolved.push(before);
    for (const list of [added, resolved, persisting, changed]) list.sort(byKey);
    return {
      assetId: from.assetId,
      from: from.ref,
      to: to.ref,
      summary: { new: added.length, resolved: resolved.length, persisting: persisting.length, changed: changed.length },
      new: added,
      resolved,
      persisting,
      changed,
    };
  }

  /** The newest reconciliation of one register, if it has been reconciled. */
  latestRunForRegister(registerId: number) {
    const row = this.db.get<{ id: number }>("SELECT id FROM runs WHERE register_id = ? ORDER BY id DESC LIMIT 1", registerId);
    return row ? this.run(row.id) : null;
  }

  latestRun(assetId: string) {
    const row = this.db.get<{ id: number }>(
      "SELECT id FROM runs WHERE asset_id = ? ORDER BY as_of DESC, id DESC LIMIT 1",
      assetId,
    );
    return row ? this.run(row.id) : null;
  }

  // ── break notes ───────────────────────────────────────────────────────────

  /**
   * Overlay sign-off notes. A note only holds while the numbers it was written against are
   * unchanged; if the break moves, it reopens and the note is shown as stale.
   */
  private annotate(assetId: string, scope: string, breaks: StoredBreak[]) {
    const notes = new Map<string, Row>();
    for (const n of this.db.all("SELECT * FROM break_notes WHERE asset_id = ? AND scope = ?", assetId, scope)) {
      notes.set(String(n.key), n);
    }
    const histories = new Map<string, Array<{ status: string; note: string; author: string | null; at: string }>>();
    for (const h of this.db.all(
      "SELECT key, status, note, author, at FROM break_note_history WHERE asset_id = ? AND scope = ? ORDER BY id ASC",
      assetId,
      scope,
    )) {
      const k = String(h.key);
      const list = histories.get(k) ?? [];
      list.push({
        status: String(h.status),
        note: String(h.note),
        author: h.author ? String(h.author) : null,
        at: String(h.at),
      });
      histories.set(k, list);
    }
    return breaks.map((b) => {
      const n = notes.get(b.key);
      const current = n !== undefined && String(n.fingerprint) === b.fingerprint;
      return {
        ...b,
        noteScope: scope,
        status: current ? String(n.status) : "open",
        note: n ? String(n.note) : null,
        noteAuthor: n?.author ? String(n.author) : null,
        noteAt: n ? String(n.updated_at) : null,
        noteStale: n !== undefined && !current,
        history: histories.get(b.key) ?? [],
        assigneeId: n?.assignee_id ? String(n.assignee_id) : null,
        assigneeLabel: n?.assignee_label ? String(n.assignee_label) : null,
      };
    });
  }

  /** Sign a break off, or reopen it. The author is whoever is acting, never what the caller says. */
  setNote(ref: string, scope: string, key: string, input: NoteInput, actor?: Actor) {
    const asset = this.asset(ref);
    if (!["open", "acknowledged", "resolved"].includes(input.status)) throw new Invalid("bad status");
    if (typeof input.note !== "string" && input.note !== undefined) throw new Invalid("note must be text");
    if (input.status !== "open" && !input.note?.trim()) throw new Invalid("a note is required to sign off a break");
    if ((input.note?.length ?? 0) > 4000) throw new Invalid("note is too long");
    if (
      typeof key !== "string" ||
      key.length > 500 ||
      typeof input.fingerprint !== "string" ||
      input.fingerprint.length > 500
    ) {
      throw new Invalid("key and fingerprint must be short text");
    }
    // Only a break that exists now can be signed off: a typo or a stale tab would otherwise leave
    // an orphan row for a later break with the same key to inherit.
    const current = this.currentBreaks(asset.id, scope);
    if (!current?.some((b) => b.key === key)) throw new NotFound(`no break ${key} in the current ${scope.split(":")[0]} results`);

    if (this.requireSecondSigner && input.status === "resolved") {
      const actorId = actor?.id;
      const actorLabel = actor?.label;
      if (actorId || actorLabel) {
        const existingNote = this.db.get<{ status: string; author: string | null; author_id: string | null }>(
          "SELECT status, author, author_id FROM break_notes WHERE asset_id = ? AND scope = ? AND key = ?",
          asset.id,
          scope,
          key,
        );
        if (existingNote && existingNote.status === "acknowledged") {
          const sameId = actorId && existingNote.author_id && existingNote.author_id === actorId;
          const sameLabel = actorLabel && existingNote.author && existingNote.author === actorLabel;
          if (sameId || sameLabel) {
            throw new Invalid("four-eyes rule: the resolver cannot be the same user who acknowledged the break");
          }
        }

        if (scope === "recon") {
          const run = this.latestRun(asset.id);
          if (run) {
            const reg = this.db.get<{ imported_by: string | null; imported_by_id: string | null }>(
              "SELECT imported_by, imported_by_id FROM registers WHERE id = ?",
              run.registerId,
            );
            if (reg) {
              const sameId = actorId && reg.imported_by_id && reg.imported_by_id === actorId;
              const sameLabel = actorLabel && reg.imported_by && reg.imported_by === actorLabel;
              if (sameId || sameLabel) {
                throw new Invalid("four-eyes rule: the person who signs off a break cannot be the one who imported the books");
              }
            }
          }
        }
      }
    }

    const at = now();
    this.db.tx(() => {
      // An upsert, not a replace: a replace would drop the break's owner when it is signed off.
      this.db.insert(
        `INSERT INTO break_notes (asset_id, scope, key, fingerprint, status, note, author, author_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (asset_id, scope, key) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           status = excluded.status,
           note = excluded.note,
           author = excluded.author,
           author_id = excluded.author_id,
           updated_at = excluded.updated_at`,
        asset.id,
        scope,
        key,
        input.fingerprint,
        input.status,
        input.note ?? "",
        actor?.label ?? null,
        actor?.id ?? null,
        at,
      );
      this.db.insert(
        `INSERT INTO break_note_history (asset_id, scope, key, fingerprint, status, note, author, author_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        asset.id,
        scope,
        key,
        input.fingerprint,
        input.status,
        input.note ?? "",
        actor?.label ?? null,
        actor?.id ?? null,
        at,
      );
      // A sign-off moves a break out of the open count the runs list reads from a column.
      if (scope === "recon") this.countOpenBreaks(asset.id);
    });
    return { ok: true };
  }

  /**
   * Rewrite the stored open-break count for every reconciliation of an asset, applying the same
   * overlay as `annotate`. This is the only listing-adjacent path that reads result bodies, and it
   * runs on a sign-off rather than on every list request.
   */
  private countOpenBreaks(assetId: string): void {
    this.db.write(
      `UPDATE runs SET open_breaks = (
         SELECT COUNT(*) FROM json_each(runs.result, '$.breaks') b
         WHERE NOT EXISTS (
           SELECT 1 FROM break_notes n
           WHERE n.asset_id = runs.asset_id AND n.scope = 'recon'
             AND n.key = json_extract(b.value, '$.key')
             AND n.fingerprint = json_extract(b.value, '$.fingerprint')
             AND n.status <> 'open'
         )
       ) WHERE asset_id = ?`,
      assetId,
    );
  }

  /** The breaks one scope currently produces, or a rejection naming the scopes that exist. */
  private currentBreaks(assetId: string, scope: string) {
    if (scope === "recon") return this.latestRun(assetId)?.breaks;
    if (scope === "controls") return this.controls(assetId).breaks;
    const action = /^action:(\d+)$/.exec(String(scope));
    const owned =
      action && this.db.get("SELECT id FROM actions WHERE id = ? AND asset_id = ?", Number(action[1]), assetId);
    if (!owned) throw new Invalid("scope must be recon, controls or an action of this asset");
    return this.action(Number(action![1])).result?.breaks;
  }

  /**
   * Give a break an owner, or clear it with null. The caller checks that the person is a member of
   * the workspace; this only records them beside the note, where every payload and the CSV read it.
   */
  assignBreak(ref: string, scope: string, key: string, assignee: Actor | null) {
    const asset = this.asset(ref);
    if (typeof key !== "string" || !key.trim() || key.length > 500) throw new Invalid("key must be short text");
    const brk = this.currentBreaks(asset.id, scope)?.find((b) => b.key === key);
    if (!brk) throw new NotFound(`no break ${key} in the current ${scope.split(":")[0]} results`);
    if (assignee !== null && (!assignee.id || !assignee.label)) {
      throw new Invalid("an assignee needs a member id and a label");
    }
    // The row is the same one the sign-off lives in, so an owner survives re-runs and a sign-off
    // does not remove them. Only the assignment columns change; the note keeps its own timestamp.
    this.db.insert(
      `INSERT INTO break_notes (asset_id, scope, key, fingerprint, status, note, assignee_id, assignee_label, updated_at)
       VALUES (?, ?, ?, ?, 'open', '', ?, ?, ?)
       ON CONFLICT (asset_id, scope, key) DO UPDATE SET
         assignee_id = excluded.assignee_id,
         assignee_label = excluded.assignee_label`,
      asset.id,
      scope,
      key,
      brk.fingerprint,
      assignee?.id ?? null,
      assignee?.label ?? null,
      now(),
    );
    return { ok: true, scope, key, assigneeId: assignee?.id ?? null, assigneeLabel: assignee?.label ?? null };
  }

  /**
   * Current breaks across every scope, with their sign-off and owner. An assignee id narrows the
   * list to that member's breaks; "none" (or "unassigned") narrows it to the unowned ones.
   */
  breaks(ref: string, assignee?: string) {
    const asset = this.asset(ref);
    const all = [
      ...(this.latestRun(asset.id)?.breaks ?? []),
      ...this.controls(asset.id).breaks,
      // A voided action is in the trail, but its breaks are not current.
      ...this.actions(asset.id)
        .filter((a) => a.voidedAt === null)
        .flatMap((a) => a.result?.breaks ?? []),
    ];
    if (assignee === undefined) return all;
    const unassigned = assignee === "none" || assignee === "unassigned";
    return all.filter((b) => (unassigned ? b.assigneeId === null : b.assigneeId === assignee));
  }

  /** Every sign-off change for one break, oldest first: who, when, what status, and the note. */
  noteHistory(ref: string, scope?: string, key?: string) {
    const asset = this.asset(ref);
    return this.db
      .all(
        `SELECT scope, key, fingerprint, status, note, author, at FROM break_note_history
         WHERE asset_id = ?${scope === undefined ? "" : " AND scope = ?"}${key === undefined ? "" : " AND key = ?"}
         ORDER BY id`,
        ...[asset.id, ...(scope === undefined ? [] : [scope]), ...(key === undefined ? [] : [key])],
      )
      .map((r) => ({
        scope: String(r.scope),
        key: String(r.key),
        fingerprint: String(r.fingerprint),
        status: String(r.status),
        note: String(r.note),
        author: r.author ? String(r.author) : null,
        at: String(r.at),
      }));
  }

  /** Sign-off history for one break, oldest first: who, when, what status, and the note. */
  breakHistory(ref: string, scope: string, key: string) {
    if (!scope || !key) throw new Invalid("scope and key are required");
    return this.noteHistory(ref, scope, key).map(({ status, note, author, at }) => ({ status, note, author, at }));
  }

  // ── corporate actions ─────────────────────────────────────────────────────

  async createAction(ref: string, input: ActionInput, actor?: Actor) {
    const asset = this.asset(ref);
    const recordTime = isoTime(String(input.recordTime ?? ""), "recordTime");
    const params: Record<string, unknown> = { exclude: addresses(input.exclude, "exclude") };
    if (input.windowTo) params.windowTo = isoTime(input.windowTo, "windowTo");
    if (input.windowFromLedger !== undefined) {
      if (!Number.isInteger(input.windowFromLedger) || input.windowFromLedger < 1) {
        throw new Invalid("windowFromLedger must be a positive ledger sequence number");
      }
      params.windowFromLedger = input.windowFromLedger;
    }
    if (input.windowToLedger !== undefined) {
      if (!Number.isInteger(input.windowToLedger) || input.windowToLedger < 1) {
        throw new Invalid("windowToLedger must be a positive ledger sequence number");
      }
      params.windowToLedger = input.windowToLedger;
    }
    if (input.type === "dividend") {
      if (!input.ratePerUnit || !/^\d+(\.\d+)?$/.test(input.ratePerUnit)) {
        throw new Invalid("dividend needs ratePerUnit as a decimal");
      }
      params.ratePerUnit = input.ratePerUnit;
      const pay = input.payAsset ? this.asset(String(input.payAsset)) : asset;
      if (pay.network !== asset.network) throw new Invalid("the pay asset must be on the same network");
      params.payAsset = pay.id;
      const payer = address(input.payer, "payer");
      if (payer) params.payer = payer;
      if (input.rounding !== undefined && input.rounding !== "floor" && input.rounding !== "half-up") {
        throw new Invalid("rounding must be floor or half-up");
      }
      params.rounding = input.rounding ?? "floor";
      const fraction = (value: unknown, field: string): string => {
        if (typeof value !== "string" || !/^(0(\.\d+)?|1(\.0+)?)$/.test(value)) {
          throw new Invalid(`${field} must be a decimal from 0 to 1, such as 0.15`);
        }
        return value;
      };
      if (input.withholdingRate !== undefined) {
        params.withholdingRate = fraction(input.withholdingRate, "withholdingRate");
      }
      if (input.withholdingOverrides !== undefined) {
        const given = input.withholdingOverrides;
        if (given === null || typeof given !== "object" || Array.isArray(given) || Object.keys(given).length > 500) {
          throw new Invalid("withholdingOverrides must map addresses to rates");
        }
        const overrides: Record<string, string> = {};
        for (const [key, value] of Object.entries(given)) {
          const holder = address(key, "a withholdingOverrides address")!;
          overrides[holder] = fraction(value, `withholdingOverrides for ${holder}`);
        }
        params.withholdingOverrides = overrides;
      }
    } else if (input.type === "split" || input.type === "redemption") {
      if (!input.num || !input.den || !/^\d+$/.test(input.num) || !/^\d+$/.test(input.den)) {
        throw new Invalid(`${input.type} needs whole-number num and den`);
      }
      if (BigInt(input.num) === 0n || BigInt(input.den) === 0n) throw new Invalid("num and den must be positive");
      if (input.type === "redemption" && BigInt(input.num) > BigInt(input.den)) {
        throw new Invalid("a redemption cannot exceed the holding");
      }
      params.num = input.num;
      params.den = input.den;
      if (input.type === "split" && input.cashInLieu) {
        if (!input.cashInLieu.asset) throw new Invalid("cashInLieu needs asset");
        const cash = this.asset(String(input.cashInLieu.asset));
        if (cash.network !== asset.network) throw new Invalid("the cash in lieu asset must be on the same network");
        if (!input.cashInLieu.pricePerUnit || !/^\d+(\.\d+)?$/.test(input.cashInLieu.pricePerUnit)) {
          throw new Invalid("cashInLieu needs pricePerUnit as a decimal");
        }
        const cilPayer = address(input.cashInLieu.payer ?? input.payer, "payer");
        params.cashInLieu = {
          asset: cash.id,
          pricePerUnit: input.cashInLieu.pricePerUnit,
          ...(cilPayer ? { payer: cilPayer } : {}),
        };
      }
    } else {
      throw new Invalid("type must be dividend, split or redemption");
    }
    if (input.cashInLieu && input.type !== "split") {
      throw new Invalid("cashInLieu is only valid for split actions");
    }
    const title =
      label(input.label, "label") ??
      (input.type === "dividend"
        ? `Dividend ${input.ratePerUnit} per unit`
        : input.type === "split"
          ? `Split ${input.num}:${input.den}`
          : `Redemption ${input.num}/${input.den}`);
    const id = this.db.insert(
      "INSERT INTO actions (asset_id, type, label, record_time, params, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      asset.id,
      input.type,
      title,
      recordTime,
      JSON.stringify(params),
      actor?.label ?? null,
      now(),
    );
    return this.reconcileAction(id);
  }

  /** Establish where the asset's indexed history begins. */
  private historyStart(asset: AssetRecord): string | undefined {
    if (asset.historyFrom) return asset.historyFrom;
    const first = this.db.get<{ closed_at: string }>(
      "SELECT closed_at FROM events WHERE asset_id = ? ORDER BY ledger ASC, id ASC LIMIT 1",
      asset.id,
    );
    return first?.closed_at;
  }

  /**
   * The instant range the asset's indexed history can be trusted for, and whether `instant` is
   * inside it. A baseline asset with no events yet is covered from when it was watched.
   */
  private coverage(asset: AssetRecord, instant: string): Coverage {
    const from = this.historyStart(asset) ?? (asset.startMode === "baseline" ? asset.createdAt : null);
    const to = asset.syncedAt ?? null;
    return {
      from,
      to,
      mode: asset.startMode,
      complete: to !== null && instant <= to && (from === null || instant >= from),
    };
  }

  /** Freeze the record-date holdings once the indexed chain has passed the record time. */
  private snapshot(asset: AssetRecord, row: Row): HoldingsState | undefined {
    if (row.snapshot) {
      const stored = JSON.parse(String(row.snapshot)) as { ledger: number; holders: Record<string, string> };
      const balances = new Map(Object.entries(stored.holders).map(([a, v]) => [a, BigInt(v)]));
      let supply = 0n;
      for (const v of balances.values()) supply += v;
      return { balances, authorized: new Map(), supply, ledger: stored.ledger, eventCount: 0, incomplete: [] };
    }
    const recordTime = String(row.record_time);
    const start = this.historyStart(asset);
    if (start && recordTime < start) return undefined;
    if (!asset.syncedAt || asset.syncedAt < recordTime) return undefined;
    const state = this.state(asset, recordTime);
    const holders: Record<string, string> = {};
    for (const [address, units] of state.balances) holders[address] = units.toString();
    this.db.write(
      "UPDATE actions SET snapshot = ? WHERE id = ?",
      JSON.stringify({ ledger: state.ledger, takenAt: now(), holders }),
      Number(row.id),
    );
    return state;
  }

  async reconcileAction(id: number, options: { sync?: boolean } = {}) {
    const row = this.db.get("SELECT * FROM actions WHERE id = ?", id);
    if (!row) throw new NotFound(`corporate action ${id} not found`);
    // A voided action is history: it is never read from the chain or reconciled again.
    if (row.voided_at) return this.action(id);
    const params = JSON.parse(String(row.params)) as Record<string, unknown>;
    const type = String(row.type) as ActionType;
    const warnings: string[] = [];
    const refresh = options.sync !== false;
    if (refresh) await this.trySync(this.asset(String(row.asset_id)), warnings);
    const asset = this.asset(String(row.asset_id));
    let flowAsset = type === "dividend" ? this.asset(String(params.payAsset)) : asset;
    if (refresh && flowAsset.id !== asset.id) {
      await this.trySync(flowAsset, warnings);
      // The sync moved the pay asset's read-through time; the record read above is stale.
      flowAsset = this.asset(flowAsset.id);
    }
    const cilParams =
      type === "split" && params.cashInLieu
        ? (params.cashInLieu as { asset: string; pricePerUnit: string; payer?: string })
        : undefined;
    let cashAsset = cilParams ? this.asset(cilParams.asset) : undefined;
    if (refresh && cashAsset && cashAsset.id !== asset.id && cashAsset.id !== flowAsset.id) {
      await this.trySync(cashAsset, warnings);
      cashAsset = this.asset(cashAsset.id);
    }

    const recordTime = String(row.record_time);
    const start = this.historyStart(asset);
    if (start && recordTime < start) {
      warnings.push(
        `Record time (${recordTime}) is earlier than history start (${start}); cannot snapshot holdings before the asset was indexed.`,
      );
      const result: ActionResult = {
        reconciledThrough: flowAsset.syncedAt ?? null,
        warnings,
        status: "clean",
        flowAsset: { id: flowAsset.id, code: flowAsset.code },
        summary: { holders: 0, expectedTotal: "0", observedTotal: "0", difference: "0", breakCount: 0 },
        lines: [],
        breaks: [],
        coverage: this.coverage(asset, recordTime),
      };
      this.db.write("UPDATE actions SET result = ?, reconciled_at = ? WHERE id = ?", JSON.stringify(result), now(), id);
      return this.action(id);
    }

    const snapshot = this.snapshot(asset, row);
    if (!snapshot) return this.action(id);

    const exclude = [...asset.ignore, ...((params.exclude as string[] | undefined) ?? [])];
    let expected: ExpectedFlows;
    let plus: EventKind[];
    let minus: EventKind[] = [];
    let splitFractions: Map<string, bigint> | undefined;
    const payer = params.payer as string | undefined;
    // Only a dividend with withholding terms shows gross, withheld and net on its lines.
    let withholding: Map<string, DividendAmounts> | undefined;
    if (type === "dividend") {
      const terms: DividendTerms = {
        ratePerUnit: String(params.ratePerUnit),
        baseDecimals: asset.decimals,
        payDecimals: flowAsset.decimals,
        rounding: (params.rounding as Rounding | undefined) ?? "floor",
        exclude,
      };
      if (params.withholdingRate !== undefined) terms.withholdingRate = String(params.withholdingRate);
      if (params.withholdingOverrides !== undefined) {
        terms.withholdingOverrides = params.withholdingOverrides as Record<string, string>;
      }
      expected = dividendEntitlements(snapshot, terms);
      if (terms.withholdingRate !== undefined || terms.withholdingOverrides !== undefined) {
        withholding = dividendBreakdown(snapshot, terms);
      }
      // A payment made by the pay asset's own issuer surfaces as a mint, not a transfer.
      plus = payer && payer !== flowAsset.issuer ? ["transfer"] : ["mint"];
    } else {
      const ratio = { num: BigInt(String(params.num)), den: BigInt(String(params.den)) };
      if (type === "split") {
        const splitRes = splitDeltas(snapshot, ratio, exclude);
        expected = splitRes.deltas;
        splitFractions = splitRes.fractions;
        plus = ["mint"];
        // Reverse splits can retire units via burn as well as issuer clawback.
        minus = ["burn", "clawback"];
      } else {
        expected = redemptionDeltas(snapshot, ratio, exclude);
        plus = [];
        minus = ["burn", "clawback"];
      }
    }
    const windowTo = params.windowTo as string | undefined;
    const windowFromLedger = params.windowFromLedger as number | undefined;
    const windowToLedger = params.windowToLedger as number | undefined;
    const observed = observeFlows(this.loadEvents(flowAsset.id), {
      afterTime: recordTime,
      plus,
      minus,
      ...(windowTo ? { untilTime: windowTo } : {}),
      ...(windowFromLedger !== undefined ? { fromLedger: windowFromLedger } : {}),
      ...(windowToLedger !== undefined ? { toLedger: windowToLedger } : {}),
      ...(payer ? { payer } : {}),
    });
    if (payer && observed.size === 0) {
      warnings.push(`Payer ${payer} has no recorded flows in the action window`);
    }
    const ignore = [...exclude, ...(payer ? [payer] : [])];
    const recon = reconcileDistribution(snapshot, expected, observed, { ignore });

    let cashFlowResult: ActionFlowResult | undefined;
    if (type === "split" && cilParams && cashAsset && splitFractions) {
      const ratio = { num: BigInt(String(params.num)), den: BigInt(String(params.den)) };
      const cashExpected = splitCashInLieu(splitFractions, ratio.den, {
        pricePerUnit: String(cilParams.pricePerUnit),
        baseDecimals: asset.decimals,
        payDecimals: cashAsset.decimals,
        rounding: (params.rounding as Rounding | undefined) ?? "floor",
      });
      const cashPayer = cilParams.payer ?? payer;
      const cashPlus: EventKind[] = cashPayer && cashPayer !== cashAsset.issuer ? ["transfer"] : ["mint"];
      const cashObserved = observeFlows(this.loadEvents(cashAsset.id), {
        afterTime: recordTime,
        plus: cashPlus,
        minus: [],
        ...(windowTo ? { untilTime: windowTo } : {}),
        ...(windowFromLedger !== undefined ? { fromLedger: windowFromLedger } : {}),
        ...(windowToLedger !== undefined ? { toLedger: windowToLedger } : {}),
        ...(cashPayer ? { payer: cashPayer } : {}),
      });
      if (cashPayer && cashObserved.size === 0) {
        warnings.push(`Payer ${cashPayer} has no recorded flows in the action window for cash in lieu`);
      }
      const cashIgnore = [...exclude, ...(cashPayer ? [cashPayer] : [])];
      const cashRecon = reconcileDistribution(snapshot, cashExpected, cashObserved, { ignore: cashIgnore });
      const cflow = (v: bigint) => formatUnits(v, cashAsset.decimals);
      cashFlowResult = {
        reconciledThrough: cashAsset.syncedAt ?? null,
        status: cashRecon.breaks.length === 0 ? "clean" : "breaks",
        flowAsset: { id: cashAsset.id, code: cashAsset.code },
        summary: {
          holders: cashRecon.summary.holders,
          expectedTotal: cflow(cashRecon.summary.expectedTotal),
          observedTotal: cflow(cashRecon.summary.observedTotal),
          difference: cflow(cashRecon.summary.difference),
          breakCount: cashRecon.summary.breakCount,
        },
        lines: cashRecon.lines.map((l) => ({
          address: l.address,
          basis: base(l.basis),
          expected: cflow(l.expected),
          observed: cflow(l.observed),
          difference: cflow(l.difference),
          txHashes: l.txHashes,
          status: l.status,
        })),
        breaks: cashRecon.breaks.map((b): StoredBreak => ({
          scope: "distribution",
          type: b.type,
          severity: b.severity,
          key: `cash:${b.key}`,
          fingerprint: `${b.expected}|${b.observed}`,
          message: `${b.message} (cash in lieu)`,
          address: b.address,
          expected: cflow(b.expected),
          observed: cflow(b.observed),
          difference: cflow(b.difference),
        })),
      };
    }

    const base = (v: bigint) => formatUnits(v, asset.decimals);
    const flow = (v: bigint) => formatUnits(v, flowAsset.decimals);

    const unitBreaks = recon.breaks.map((b): StoredBreak => ({
      scope: "distribution",
      type: b.type,
      severity: b.severity,
      key: b.key,
      fingerprint: `${b.expected}|${b.observed}`,
      message: b.message,
      address: b.address,
      expected: flow(b.expected),
      observed: flow(b.observed),
      difference: flow(b.difference),
    }));

    const allBreaks = cashFlowResult ? [...unitBreaks, ...cashFlowResult.breaks] : unitBreaks;
    const isClean = recon.breaks.length === 0 && (!cashFlowResult || cashFlowResult.breaks.length === 0);

    const chainBehind = !asset.syncedAt || asset.syncedAt < recordTime;
    const coverage = this.coverage(asset, recordTime);
    if (chainBehind) {
      warnings.push(
        `Chain is indexed to ${asset.syncedAt ?? "nothing"}, before the action's record time; later activity is not reflected`,
      );
    }
    const result: ActionResult = {
      reconciledThrough: flowAsset.syncedAt ?? null,
      warnings,
      status: isClean ? "clean" : "breaks",
      flowAsset: { id: flowAsset.id, code: flowAsset.code },
      summary: {
        holders: recon.summary.holders,
        expectedTotal: flow(recon.summary.expectedTotal),
        observedTotal: flow(recon.summary.observedTotal),
        difference: flow(recon.summary.difference),
        breakCount: recon.summary.breakCount,
      },
      lines: recon.lines.map((l) => {
        const amounts = withholding?.get(l.address);
        return {
          address: l.address,
          basis: base(l.basis),
          expected: flow(l.expected),
          ...(withholding
            ? {
                gross: flow(amounts?.gross ?? 0n),
                withheld: flow(amounts?.withheld ?? 0n),
                net: flow(amounts?.net ?? 0n),
              }
            : {}),
          observed: flow(l.observed),
          difference: flow(l.difference),
          txHashes: l.txHashes,
          status: l.status,
        };
      }),
      breaks: allBreaks,
      ...(cashFlowResult ? { cashInLieu: cashFlowResult } : {}),
      coverage,
    };
    this.db.write("UPDATE actions SET result = ?, reconciled_at = ? WHERE id = ?", JSON.stringify(result), now(), id);
    if (result.breaks.length > 0) {
      this.alert("action.breaks", asset, result.breaks.length, `/#/a/${asset.id}/actions`);
    }
    return this.action(id);
  }

  action(id: number) {
    const row = this.db.get("SELECT * FROM actions WHERE id = ?", id);
    if (!row) throw new NotFound(`corporate action ${id} not found`);
    const asset = this.asset(String(row.asset_id));
    const snapshot = row.snapshot
      ? (JSON.parse(String(row.snapshot)) as { ledger: number; takenAt: string; holders: Record<string, string> })
      : null;
    const result = row.result ? (JSON.parse(String(row.result)) as ActionResult) : null;
    const breaks = result ? this.annotate(asset.id, `action:${id}`, result.breaks) : [];
    const voidedAt = row.voided_at ? String(row.voided_at) : null;
    return {
      id: Number(row.id),
      assetId: asset.id,
      type: String(row.type),
      label: String(row.label),
      recordTime: String(row.record_time),
      params: JSON.parse(String(row.params)) as Record<string, unknown>,
      createdAt: String(row.created_at),
      reconciledAt: row.reconciled_at ? String(row.reconciled_at) : null,
      state: voidedAt ? "voided" : snapshot ? (result?.status ?? "pending") : "scheduled",
      snapshot: snapshot && {
        ledger: snapshot.ledger,
        takenAt: snapshot.takenAt,
        holderCount: Object.keys(snapshot.holders).length,
        holders: Object.entries(snapshot.holders).map(([address, v]) => ({
          address,
          units: formatUnits(BigInt(v), asset.decimals),
        })),
      },
      result: result && { ...result, breaks },
      // The breaks stay on the record for the audit trail, but a voided action is not open.
      openBreaks: voidedAt ? 0 : breaks.filter((b) => b.status === "open").length,
      voidedAt,
      voidedBy: row.voided_by ? String(row.voided_by) : null,
      voidReason: row.void_reason ? String(row.void_reason) : null,
    };
  }

  actions(ref: string) {
    const asset = this.asset(ref);
    return this.db
      .all<{ id: number }>("SELECT id FROM actions WHERE asset_id = ? ORDER BY record_time DESC, id DESC", asset.id)
      .map(({ id }) => this.action(id));
  }

  /**
   * Cancel an action entered in error, keeping it in the audit trail. Nothing is deleted: the
   * record keeps its snapshot, its result and its breaks, gains who voided it and why, and stops
   * counting as open from then on.
   */
  async voidAction(id: number, reason: string, actor?: Actor): Promise<Awaited<ReturnType<typeof this.action>>> {
    const row = this.db.get("SELECT * FROM actions WHERE id = ?", id);
    if (!row) throw new NotFound(`corporate action ${id} not found`);
    if (typeof reason !== "string" || !reason.trim()) {
      throw new Invalid("a reason is required to void a corporate action");
    }
    const text = reason.trim();
    if (text.length > 4000) throw new Invalid("reason is too long");
    if (row.voided_at) throw new Invalid(`corporate action ${id} is already voided`);
    this.db.write(
      "UPDATE actions SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?",
      now(),
      actor?.label ?? null,
      text,
      id,
    );
    return this.action(id);
  }


  /**
   * Reconcile the corporate actions whose record time the indexed chain has now passed, and
   * re-run the ones already reconciled whose execution window is still open and whose flow asset
   * has been read further since. Run after a sync, so a scheduled action advances, and a late
   * payment lands in the stored result, without anyone pressing a button. A voided action is
   * never due.
   */
  async reconcileDue(): Promise<number> {
    const due = this.db
      .all<{ id: number }>(
        `SELECT a.id FROM actions a JOIN assets s ON s.id = a.asset_id
         WHERE a.snapshot IS NULL AND s.synced_at IS NOT NULL AND s.synced_at >= a.record_time
           AND a.voided_at IS NULL`,
      )
      .map(({ id }) => id);
    const reconciled = this.db.all<{ id: number; params: string; result: string; voided_at: string | null }>(
      "SELECT id, params, result, voided_at FROM actions WHERE snapshot IS NOT NULL AND result IS NOT NULL AND voided_at IS NULL",
    );
    for (const row of reconciled) {
      const result = JSON.parse(row.result) as ActionResult;
      const windowTo = (JSON.parse(row.params) as { windowTo?: string }).windowTo;
      // Chain already read past the end of the window: nothing later can change the result.
      if (windowTo && result.reconciledThrough !== null && result.reconciledThrough >= windowTo) continue;
      const flow = this.db.get<{ synced_at: string | null }>(
        "SELECT synced_at FROM assets WHERE id = ?",
        result.flowAsset.id,
      );
      if (flow?.synced_at && (result.reconciledThrough === null || flow.synced_at > result.reconciledThrough)) {
        due.push(row.id);
        continue;
      }
      if (result.cashInLieu?.flowAsset?.id) {
        const cashFlow = this.db.get<{ synced_at: string | null }>(
          "SELECT synced_at FROM assets WHERE id = ?",
          result.cashInLieu.flowAsset.id,
        );
        if (
          cashFlow?.synced_at &&
          (result.cashInLieu.reconciledThrough === null || cashFlow.synced_at > result.cashInLieu.reconciledThrough)
        ) {
          due.push(row.id);
        }
      }
    }
    let done = 0;
    for (const id of due) {
      try {
        await this.reconcileAction(id, { sync: false });
        done++;
      } catch (err) {
        console.error(`action ${id}: ${describeFailure(err)}`);
      }
    }
    return done;
  }

  // ── controls log ──────────────────────────────────────────────────────────

  /**
   * The controls log as of now, or as of a period `{ from, to }`: events and instructions after
   * `to` are left out, and so is everything that happened before `from`, with the summary,
   * pending list and breaks recomputed to match the records that remain.
   */
  controls(ref: string, window?: { from: string; to: string }) {
    const asset = this.asset(ref);
    const initialFrozen = new Set<string>();
    for (const [address, opening] of this.openings(asset.id)) {
      if (opening.authorized === false) initialFrozen.add(address);
    }
    // Only a baseline or a rolling RPC window leaves history unseen; a start ledger the caller
    // named is trusted to begin where they meant.
    const indexedFrom = asset.startMode === "baseline" ? asset.createdAt : asset.historyFrom;
    const instructionList = this.instructions(asset.id);
    const full = buildControlsLog(
      this.loadControlEvents(asset.id).filter((e) => !window || e.closedAt <= window.to),
      instructionList.filter((i) => !window || Date.parse(i.issuedAt) <= Date.parse(window.to)),
      {
        asOf: window?.to ?? asset.syncedAt ?? new Date().toISOString(),
        windowMs: asset.instructionWindowHours * 3600_000,
        initialFrozen,
        ...(indexedFrom ? { indexedFrom } : {}),
      },
    );
    let log = full;
    if (window) {
      const issuedInPeriod = (ref: string | undefined) => {
        const i = instructionList.find((x) => x.ref === ref);
        return i !== undefined && Date.parse(i.issuedAt) >= Date.parse(window.from);
      };
      const records = full.records.filter((r) => r.closedAt >= window.from);
      const kept = new Set(records.map((r) => r.eventId));
      const breaks = full.breaks.filter((b) => (b.eventId ? kept.has(b.eventId) : issuedInPeriod(b.ref)));
      const instructed = records.filter((r) => r.instruction).length;
      log = {
        records,
        breaks,
        pending: full.pending.filter((i) => issuedInPeriod(i.ref)),
        unverifiable: full.unverifiable.filter((i) => issuedInPeriod(i.ref)),
        summary: {
          controls: records.length,
          instructed,
          uninstructed: records.length - instructed,
          unexecuted: breaks.filter((b) => b.type === "UNEXECUTED_INSTRUCTION").length,
          pending: full.pending.filter((i) => issuedInPeriod(i.ref)).length,
        },
      };
    }
    const instructionJson = (i: Instruction) => ({
      ref: i.ref,
      type: i.type,
      account: i.account,
      units: i.units === undefined ? null : formatUnits(i.units, asset.decimals),
      issuedAt: i.issuedAt,
      approvedBy: i.approvedBy ?? null,
      reason: i.reason ?? null,
    });
    // The sign-off follows the facts behind the break: the instruction's fields and the on-chain
    // event's. A re-import that changes either leaves the sign-off stale and the break open.
    const instructionByRef = new Map(this.instructions(asset.id).map((i) => [i.ref, i]));
    const recordById = new Map(log.records.map((r) => [r.eventId, r]));
    const fingerprintOf = (b: (typeof log.breaks)[number]) => {
      const i = b.ref === undefined ? undefined : instructionByRef.get(b.ref);
      const r = b.eventId === undefined ? undefined : recordById.get(b.eventId);
      return [
        i ? `${i.account}|${i.type}|${i.units ?? ""}|${i.issuedAt}` : "",
        r ? `${r.account}|${r.type}|${r.units ?? ""}|${r.closedAt}` : "",
      ].join("#");
    };
    const breaks = this.annotate(
      asset.id,
      "controls",
      log.breaks.map((b) => ({
        scope: "control",
        type: b.type,
        severity: b.severity,
        key: b.key,
        fingerprint: fingerprintOf(b),
        message: b.message,
        address: b.address,
        ref: b.ref ?? null,
        eventId: b.eventId ?? null,
        txHash: b.txHash ?? null,
      })),
    );
    return {
      asOf: window?.to ?? asset.syncedAt ?? null,
      summary: log.summary,
      records: log.records
        .map((r) => ({
          eventId: r.eventId,
          type: r.type,
          account: r.account,
          units: r.units === undefined ? null : formatUnits(r.units, asset.decimals),
          ledger: r.ledger,
          closedAt: r.closedAt,
          txHash: r.txHash,
          instruction: r.instruction ? instructionJson(r.instruction) : null,
        }))
        .reverse(),
      pending: log.pending.map(instructionJson),
      unverifiable: log.unverifiable.map(instructionJson),
      breaks,
      openBreaks: breaks.filter((b) => b.status === "open").length,
    };
  }

  // ── overview and export ───────────────────────────────────────────────────

  overview(network?: NetworkName) {
    return {
      networks: this.networkNames(),
      assets: this.assets(network).map((asset) => this.assetSummary(asset)),
    };
  }

  /** One asset with the headline figures the dashboard lists. */
  assetSummary(asset: AssetRecord) {
    const state = this.state(asset);
    const run = this.latestRun(asset.id);
    const controls = this.controls(asset.id);
    const actions = this.actions(asset.id);
    const events = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE asset_id = ?", asset.id)!.n;
    return {
      ...asset,
      supply: formatUnits(state.supply, asset.decimals),
      holderCount: state.balances.size,
      eventCount: events,
      incomplete: state.incomplete.length > 0,
      lastRun: run && { id: run.id, asOf: run.asOf, status: run.status, openBreaks: run.openBreaks },
      openBreaks: {
        reconciliation: run?.openBreaks ?? 0,
        controls: controls.openBreaks,
        actions: actions.reduce((n, a) => n + a.openBreaks, 0),
      },
    };
  }

  /**
   * Returns the voided-flag for breakdowns that read the live result rather than the summary object.
   * A voided action still carries its breaks in the trail, but they must not read as open anywhere.
   */
  isVoided(row: Row): boolean {
    return row.voided_at !== null && row.voided_at !== undefined;
  }

  /** Everything an auditor needs for a period, with a digest over the content. */
  auditExport(
    ref: string,
    period: { from?: string; to?: string } = {},
    options: { signingKey?: string } = {},
  ) {
    const asset = this.asset(ref);
    const to = period.to ? isoTime(period.to, "to") : (asset.syncedAt ?? now());
    const from = period.from ? isoTime(period.from, "from") : "1970-01-01T00:00:00.000Z";
    if (from > to) throw new Invalid("from must not be after to");
    const inPeriod = (t: string) => t >= from && t <= to;
    const controls = this.controls(asset.id, { from, to });
    const runs = this.db
      .all<{ id: number }>("SELECT id FROM runs WHERE asset_id = ? ORDER BY as_of, id", asset.id)
      .map(({ id }) => this.run(id))
      .filter((r) => inPeriod(r.asOf));
    const runRegisterIds = new Set(runs.map((r) => r.registerId));
    const registers = this.registers(asset.id)
      .filter((r) => inPeriod(r.asOf) || runRegisterIds.has(r.id))
      .sort((a, b) => a.asOf.localeCompare(b.asOf) || a.id - b.id);
    const content = {
      asset: {
        id: asset.id,
        network: asset.network,
        code: asset.code,
        issuer: asset.issuer ?? null,
        name: asset.name,
        decimals: asset.decimals,
        indexedFromLedger: asset.startLedger ?? null,
        baselineLedger: asset.baselineLedger ?? null,
        historyFrom: asset.historyFrom ?? null,
        indexedToLedger: asset.syncedLedger ?? null,
        indexedTo: asset.syncedAt ?? null,
        ignoredAddresses: asset.ignore,
        instructionWindowHours: asset.instructionWindowHours,
        movementWindowHours: asset.movementWindowHours,
      },
      period: { from, to },
      holdings: (() => {
        const { beforeHistory: _beforeHistory, warnings: _warnings, ...rest } = this.holdings(asset.id, to);
        return rest;
      })(),
      registers,
      reconciliations: runs,
      // A voided action stays in the pack. The pack's shape is a closed contract, so the void
      // trail travels in the action's free-form params rather than as new top-level fields.
      corporateActions: this.actions(asset.id)
        .filter((a) => inPeriod(a.recordTime))
        .map(({ result, voidedAt, voidedBy, voidReason, ...rest }) => {
          const action = {
            ...rest,
            result: result
              ? {
                  reconciledThrough: result.reconciledThrough,
                  warnings: result.warnings,
                  status: result.status,
                  flowAsset: result.flowAsset,
                  summary: result.summary,
                  lines: result.lines,
                  breaks: result.breaks,
                  coverage: result.coverage,
                }
              : null,
          };
          return voidedAt === null
            ? action
            : {
                ...action,
                state: result?.status ?? (rest.snapshot ? "pending" : "scheduled"),
                params: { ...rest.params, voided: { at: voidedAt, by: voidedBy, reason: voidReason } },
              };
        }),
      controls,
      // The whole trail, not the period: sign-offs happen in wall-clock time, not chain time.
      signoffHistory: this.noteHistory(asset.id),
      events: this.loadEvents(asset.id)
        .filter((e) => inPeriod(e.closedAt))
        .map((e) => this.eventJson(e, asset.decimals)),
    };
    const digest = auditPackDigest({ schemaVersion: AUDIT_PACK_SCHEMA_VERSION, generator: "concord/0.1.0", ...content });
    const signingKey = options.signingKey ?? this.options.signingKey ?? process.env.CONCORD_SIGNING_KEY;
    let signature: string | undefined;
    let keyId: string | undefined;
    if (signingKey) {
      const pem = signingKey.includes("-----BEGIN") ? signingKey : readFileSync(signingKey, "utf8");
      const priv = createPrivateKey(pem);
      if (priv.asymmetricKeyType !== "ed25519") {
        throw new Invalid("signing key must be an ed25519 private key");
      }
      const pub = createPublicKey(priv);
      keyId = createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
      signature = sign(null, Buffer.from(digest), priv).toString("base64");
    }
    return {
      schemaVersion: AUDIT_PACK_SCHEMA_VERSION,
      generatedAt: now(),
      generator: "concord/0.1.0",
      sha256: digest,
      ...(signature ? { keyId, signature } : {}),
      ...content,
    };
  }

  /**
   * Stream events for an asset over a period as CSV or NDJSON lines one by one.
   * Yields formatted strings with line breaks. Does not materialize all events in memory.
   * Peak memory growth remains bounded under 50 MB even for 200,000+ events.
   */
  *exportEvents(
    ref: string,
    period: { from?: string; to?: string; format?: "csv" | "ndjson" } = {},
    formatOrOptions?: "csv" | "ndjson" | { format?: "csv" | "ndjson" },
  ): Generator<string, void, undefined> {
    const format =
      (typeof formatOrOptions === "string"
        ? formatOrOptions
        : formatOrOptions?.format ?? period.format) ?? "csv";
    if (format !== "csv" && format !== "ndjson") {
      throw new Invalid("format must be csv or ndjson");
    }
    const asset = this.asset(ref);
    const to = period.to ? isoTime(period.to, "to") : (asset.syncedAt ?? now());
    const from = period.from ? isoTime(period.from, "from") : "1970-01-01T00:00:00.000Z";
    if (from > to) throw new Invalid("from must not be after to");

    const header = format === "csv" ? toCsv([...EVENT_COLUMNS], []) : "";
    if (format === "csv") {
      yield header;
    }

    const stmt = this.db.raw.prepare(
      "SELECT * FROM events WHERE asset_id = ? AND closed_at >= ? AND closed_at <= ? ORDER BY id",
    );
    const iter = stmt.iterate(asset.id, from, to);
    try {
      for (const row of iter) {
        const ev = this.eventJson(toEvent(row as Row), asset.decimals);
        if (format === "csv") {
          yield toCsv([...EVENT_COLUMNS], [ev]).slice(header.length);
        } else {
          yield JSON.stringify(ev) + "\n";
        }
      }
    } finally {
      iter.return?.();
    }
  }

  /** One section of the audit pack, or one corporate action's entitlement table, as CSV. */
  exportCsv(ref: string, section: string, period: { from?: string; to?: string; id?: number } = {}): string {
    // Reject an unknown section before building the audit pack, which replays every event.
    if (!(EXPORT_CSV_SECTIONS as readonly string[]).includes(section)) throw new Invalid(EXPORT_CSV_SECTION_ERROR);
    if (section === "action") {
      const asset = this.asset(ref);
      if (period.id === undefined || !Number.isSafeInteger(period.id) || period.id < 1) {
        throw new Invalid("action export needs a positive integer id");
      }
      const act = this.action(period.id);
      if (act.assetId !== asset.id) {
        throw new Invalid(`corporate action ${period.id} belongs to another asset`);
      }
      const lines = (act.result?.lines ?? []) as Array<{
        address: string;
        basis: string;
        expected: string;
        observed: string;
        difference: string;
        status: string;
        txHashes: string[];
      }>;
      return toCsv(
        ["address", "recordHolding", "expected", "observed", "difference", "status", "txHashes"],
        lines.map((l) => ({
          address: l.address,
          recordHolding: l.basis,
          expected: l.expected,
          observed: l.observed,
          difference: l.difference,
          status: l.status,
          txHashes: l.txHashes.join(";"),
        })),
      );
    }
    const pack = this.auditExport(ref, period);
    const asset = this.asset(ref);
    switch (section) {
      case "holdings":
        return toCsv(["address", "units", "share", "status", "ignored"], pack.holdings.holders);
      case "events":
        return toCsv([...EVENT_COLUMNS], pack.events);
      case "controls":
        return toCsv(
          ["closedAt", "ledger", "type", "account", "units", "txHash", "instructionRef", "approvedBy", "reason"],
          pack.controls.records.map((r) => ({
            ...r,
            instructionRef: r.instruction?.ref ?? "",
            approvedBy: r.instruction?.approvedBy ?? "",
            reason: r.instruction?.reason ?? "",
          })),
        );
      case "breaks": {
        const rows: Array<Record<string, unknown>> = [];
        for (const run of pack.reconciliations) {
          for (const b of run.breaks) rows.push({ source: `reconciliation ${run.id}`, asOf: run.asOf, ...b });
        }
        for (const a of pack.corporateActions) {
          // A voided action is in the trail, but its breaks are not open. The pack's shape is
          // closed, so a void travels in params rather than as a state of its own.
          const breaks = a.params.voided ? [] : a.result?.breaks ?? [];
          for (const b of breaks) rows.push({ source: `${a.type} ${a.id}`, asOf: a.recordTime, ...b });
        }
        for (const b of pack.controls.breaks) rows.push({ source: "controls", asOf: pack.period.to, ...b });
        return toCsv(
          [
            "source",
            "asOf",
            "scope",
            "type",
            "severity",
            "address",
            "ref",
            "txHash",
            "chainUnits",
            "registerUnits",
            "expected",
            "observed",
            "difference",
            "message",
            "firstSeen",
            "status",
            "note",
            "noteAuthor",
            "assigneeId",
            "assigneeLabel",
            "history",
          ],
          rows.map((r) => ({
            ...r,
            history: Array.isArray(r.history) && r.history.length > 0 ? JSON.stringify(r.history) : "",
          })),
        );
      }
      case "positions": {
        const rows: Array<Record<string, unknown>> = [];
        for (const run of pack.reconciliations) {
          for (const l of run.lines) {
            rows.push({
              runId: run.id,
              asOf: run.asOf,
              address: l.address,
              holderIds: Array.isArray(l.holderIds) ? l.holderIds.join(";") : "",
              chainUnits: l.chainUnits,
              registerUnits: l.registerUnits,
              difference: l.difference,
              chainStatus: l.chainStatus ?? "",
              registerStatus: l.registerStatus ?? "",
              matched: l.matched,
            });
          }
        }
        return toCsv(
          [
            "runId",
            "asOf",
            "address",
            "holderIds",
            "chainUnits",
            "registerUnits",
            "difference",
            "chainStatus",
            "registerStatus",
            "matched",
          ],
          rows,
        );
      }
      case "runs": {
        const rows = pack.reconciliations.map((r) => ({
          id: r.id,
          asOf: r.asOf,
          createdAt: r.createdAt,
          registerId: r.registerId,
          status: r.status,
          chainLedger: r.chainLedger,
          chainSyncedAt: r.chainSyncedAt ?? "",
          chainBehind: r.chainBehind,
          chainSupply: r.summary.chainSupply,
          registerTotal: r.summary.registerTotal,
          supplyDifference: r.summary.supplyDifference,
          chainHolders: r.summary.chainHolders,
          registerHolders: r.summary.registerHolders,
          lines: r.summary.lines,
          matchedLines: r.summary.matchedLines,
          breakCount: r.summary.breakCount,
          openBreaks: r.openBreaks,
        }));
        return toCsv(
          [
            "id",
            "asOf",
            "createdAt",
            "registerId",
            "status",
            "chainLedger",
            "chainSyncedAt",
            "chainBehind",
            "chainSupply",
            "registerTotal",
            "supplyDifference",
            "chainHolders",
            "registerHolders",
            "lines",
            "matchedLines",
            "breakCount",
            "openBreaks",
          ],
          rows,
        );
      }
      case "actions": {
        const rows = pack.corporateActions.map((a) => ({
          id: a.id,
          type: a.type,
          label: a.label,
          recordTime: a.recordTime,
          state: a.state,
          createdAt: a.createdAt,
          reconciledAt: a.reconciledAt ?? "",
          openBreaks: a.openBreaks,
        }));
        return toCsv(
          ["id", "type", "label", "recordTime", "state", "createdAt", "reconciledAt", "openBreaks"],
          rows,
        );
      }
      case "journal": {
        const entries = this.db.all("SELECT * FROM journal WHERE asset_id = ? ORDER BY date, ref", asset.id);
        const rows = entries.map((r) => ({
          ref: String(r.ref),
          date: String(r.date),
          type: String(r.type),
          from_account: r.from_addr ? String(r.from_addr) : "",
          to_account: r.to_addr ? String(r.to_addr) : "",
          units: formatUnits(BigInt(String(r.units)), asset.decimals),
          tx_hash: r.tx_hash ? String(r.tx_hash) : "",
        }));
        return toCsv(["ref", "date", "type", "from_account", "to_account", "units", "tx_hash"], rows);
      }
      case "instructions": {
        const list = this.db.all("SELECT * FROM instructions WHERE asset_id = ? ORDER BY issued_at, ref", asset.id);
        const rows = list.map((r) => ({
          ref: String(r.ref),
          type: String(r.type),
          account: String(r.account),
          units: r.units ? formatUnits(BigInt(String(r.units)), asset.decimals) : "",
          issued_at: String(r.issued_at),
          approved_by: r.approved_by ? String(r.approved_by) : "",
          reason: r.reason ? String(r.reason) : "",
        }));
        return toCsv(["ref", "type", "account", "units", "issued_at", "approved_by", "reason"], rows);
      }
      default:
        throw new Invalid(EXPORT_CSV_SECTION_ERROR);
    }
  }

  get requireSecondSigner(): boolean {
    const row = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'require_second_signer'");
    return row?.value === "true";
  }

  setRequireSecondSigner(enabled: boolean): void {
    this.db.write(
      "INSERT INTO meta (key, value) VALUES ('require_second_signer', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(enabled),
    );
  }

  settings(): { requireSecondSigner: boolean } {
    return { requireSecondSigner: this.requireSecondSigner };
  }

  updateSettings(patch: { requireSecondSigner?: boolean }): { requireSecondSigner: boolean } {
    if (patch.requireSecondSigner !== undefined) {
      if (typeof patch.requireSecondSigner !== "boolean") throw new Invalid("requireSecondSigner must be a boolean");
      this.setRequireSecondSigner(patch.requireSecondSigner);
    }
    return this.settings();
  }
}

export interface VerifyPackResult {
  digestValid: boolean;
  digest: string;
  expectedDigest: string;
  signed: boolean;
  keyId: string | null;
  signatureChecked: boolean;
  signatureValid?: boolean;
  error?: string;
}

export function verifyPack(pack: unknown, publicKeyPemOrPath?: string): VerifyPackResult {
  if (!pack || typeof pack !== "object") {
    throw new Invalid("audit pack must be a JSON object");
  }
  const p = pack as Record<string, unknown>;
  const { sha256: packSha256, keyId, signature } = p;
  if (typeof packSha256 !== "string") {
    throw new Invalid("audit pack is missing sha256 digest");
  }
  const expectedDigest = auditPackDigest(p);
  const digestValid = packSha256 === expectedDigest;
  const signed = typeof signature === "string";

  let signatureChecked = false;
  let signatureValid: boolean | undefined = undefined;
  let error: string | undefined = undefined;

  if (publicKeyPemOrPath) {
    signatureChecked = true;
    if (!signed) {
      signatureValid = false;
      error = "pack is not signed";
    } else {
      try {
        const pem = publicKeyPemOrPath.includes("-----BEGIN") ? publicKeyPemOrPath : readFileSync(publicKeyPemOrPath, "utf8");
        const pub = createPublicKey(pem);
        if (pub.asymmetricKeyType !== "ed25519") {
          throw new Invalid("public key must be an ed25519 public key");
        }
        const computedKeyId = createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
        if (typeof keyId === "string" && keyId !== computedKeyId) {
          signatureValid = false;
          error = `keyId mismatch (pack: ${keyId}, public key: ${computedKeyId})`;
        } else {
          signatureValid = verify(null, Buffer.from(packSha256), pub, Buffer.from(signature as string, "base64"));
          if (!signatureValid) error = "invalid signature";
        }
      } catch (err) {
        signatureValid = false;
        error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    digestValid,
    digest: packSha256,
    expectedDigest,
    signed,
    keyId: typeof keyId === "string" ? keyId : null,
    signatureChecked,
    signatureValid,
    ...(error ? { error } : {}),
  };
}
