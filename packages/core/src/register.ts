import { parseUnits, DEFAULT_DECIMALS } from "./amount.js";
import { parseCsvTable } from "./csv.js";

export type HolderStatus = "active" | "frozen";

/** One line of the official register: a beneficial holder and where their units sit on-chain. */
export interface RegisterPosition {
  holderId: string;
  holderName?: string;
  /** Stellar address. Several holders may share one (omnibus). Empty when not yet mapped. */
  account?: string;
  units: bigint;
  status?: HolderStatus;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParsedRegister {
  positions: RegisterPosition[];
  issues: ParseIssue[];
}

const ALIASES: Record<string, string[]> = {
  holder_id: ["holder_id", "holder", "investor_id", "account_id", "id"],
  holder_name: ["holder_name", "name", "investor_name"],
  account: ["account", "address", "stellar_address", "wallet", "stellar_account"],
  units: ["units", "balance", "shares", "quantity", "holding"],
  status: ["status", "state"],
};

function pick(headers: string[], field: string): string | undefined {
  return ALIASES[field]!.find((a) => headers.includes(a));
}

function parseStatus(raw: string): HolderStatus | undefined {
  const s = raw.toLowerCase();
  if (s === "") return undefined;
  if (["active", "authorized", "authorised", "open"].includes(s)) return "active";
  if (["frozen", "restricted", "blocked", "suspended"].includes(s)) return "frozen";
  throw new Error(`unknown status "${raw}"`);
}

/** The register's columns as Concord names them, in the order a template lists them. */
export const REGISTER_COLUMNS = ["holder_id", "holder_name", "account", "units", "status"] as const;

/**
 * Parses a register CSV into positions.
 *
 * Columns: holder_id and units are required; holder_name, account and status are optional.
 * Header names may use any alias listed in ALIASES. Rows that fail validation are reported
 * in `issues` (with line numbers) and skipped rather than aborting the whole file.
 */
export function parseRegisterCsv(text: string, decimals = DEFAULT_DECIMALS): ParsedRegister {
  const table = parseCsvTable(text);
  const idCol = pick(table.headers, "holder_id");
  const unitsCol = pick(table.headers, "units");
  if (!idCol || !unitsCol) {
    throw new Error("register CSV needs a holder_id column and a units column");
  }
  const nameCol = pick(table.headers, "holder_name");
  const accountCol = pick(table.headers, "account");
  const statusCol = pick(table.headers, "status");
  const positions: RegisterPosition[] = [];
  const issues: ParseIssue[] = [];
  for (const { line, values } of table.records) {
    try {
      const holderId = values[idCol]!;
      if (!holderId) throw new Error("missing holder_id");
      const position: RegisterPosition = { holderId, units: parseUnits(values[unitsCol]!, decimals) };
      if (position.units < 0n) throw new Error("negative units");
      if (nameCol && values[nameCol]) position.holderName = values[nameCol];
      if (accountCol && values[accountCol]) position.account = values[accountCol];
      if (statusCol) {
        const status = parseStatus(values[statusCol]!);
        if (status) position.status = status;
      }
      positions.push(position);
    } catch (err) {
      issues.push({ line, message: (err as Error).message });
    }
  }
  return { positions, issues };
}
