/**
 * The CLI's help text, its flags and how it words a bad command line. Kept in its own module
 * so the tests can import it without pulling in the rest of the CLI (which opens databases
 * when run), and so the drift test in test/service.test.ts can hold the README's examples
 * against it.
 */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** Every flag the CLI accepts: the table parseArgs reads, and the one suggestions come from. */
export const CLI_OPTIONS = {
  org: { type: "string" },
  network: { type: "string" },
  name: { type: "string" },
  "no-baseline": { type: "boolean" },
  from: { type: "string" },
  to: { type: "string" },
  ignore: { type: "string" },
  decimals: { type: "string" },
  "as-of": { type: "string" },
  register: { type: "string" },
  record: { type: "string" },
  rate: { type: "string" },
  ratio: { type: "string" },
  "pay-asset": { type: "string" },
  payer: { type: "string" },
  until: { type: "string" },
  label: { type: "string" },
  exclude: { type: "string" },
  csv: { type: "string" },
  out: { type: "string" },
  note: { type: "string" },
  role: { type: "string" },
  limit: { type: "string" },
  before: { type: "string" },
  scope: { type: "string" },
  verify: { type: "boolean" },
  into: { type: "string" },
  force: { type: "boolean", short: "f" },
  status: { type: "string" },
  key: { type: "string" },
  run: { type: "string" },
  json: { type: "boolean" },
  "fail-on-breaks": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

const HELP_HINT = "Run 'concord --help' for usage.";

/**
 * Edit distance between two strings: insertions, deletions, substitutions, and swaps of two
 * neighbouring characters (the commonest typo, "jsno" for "json"), each costing one.
 */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i]!;
      row[j] = Math.min(d[i - 1]![j]! + 1, row[j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * The known flag a mistyped one most likely meant, or undefined when none is close: within
 * about one edit per three characters, or the only flag that starts with what was typed.
 * Names are given without their leading dashes.
 */
export function closestFlag(input: string, known: readonly string[] = Object.keys(CLI_OPTIONS)): string | undefined {
  const typed = input.toLowerCase();
  let best: { name: string; cost: number } | undefined;
  for (const name of known) {
    const cost = distance(typed, name);
    if (!best || cost < best.cost) best = { name, cost };
  }
  if (best && best.cost <= Math.max(1, Math.floor(Math.max(typed.length, best.name.length) / 3))) return best.name;
  const prefixed = typed.length >= 2 ? known.filter((name) => name.startsWith(typed)) : [];
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * One line for a command line parseArgs refused, naming the flag at fault and pointing at
 * --help, in place of Node's own wording. Undefined for any other error, which the caller
 * should report as it is.
 */
export function describeArgsError(
  err: unknown,
  args: readonly string[],
  options: ParseArgsOptionsConfig = CLI_OPTIONS,
): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !code.startsWith("ERR_PARSE_ARGS_")) return undefined;
  const { tokens } = parseArgs({ args: [...args], options, allowPositionals: true, strict: false, tokens: true });
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    const option = options[token.name];
    if (!option) {
      const guess = token.rawName.startsWith("--") ? closestFlag(token.name, Object.keys(options)) : undefined;
      return `unknown option '${token.rawName}'.${guess ? ` Did you mean '--${guess}'?` : ""} ${HELP_HINT}`;
    }
    const flag = `--${token.name}`;
    if (option.type === "string" && token.value === undefined) return `option '${flag}' needs a value. ${HELP_HINT}`;
    if (option.type === "string" && !token.inlineValue && token.value?.startsWith("-")) {
      return `option '${flag}' needs a value, not '${token.value}' (write ${flag}=${token.value} if that is the value). ${HELP_HINT}`;
    }
    if (option.type === "boolean" && token.value !== undefined) {
      return `option '${flag}' does not take a value. ${HELP_HINT}`;
    }
  }
  // Something parseArgs refused that the tokens do not show: keep its first line.
  return `${String((err as Error).message).split("\n")[0]} ${HELP_HINT}`;
}

export const USAGE = `concord — reconcile tokenized securities on Stellar against the register

Workspace commands. Name the workspace with --org <id | exact name> or CONCORD_ORG.

  watch <CODE:ISSUER | CONTRACT>   start indexing an asset
        [--network mainnet|testnet] [--name N] [--ignore A,B]
        [--from LEDGER] [--no-baseline] [--decimals D]
  unwatch ASSET                    stop watching; deletes the asset and its books
  rebuild ASSET                    re-index from fresh opening balances; books stay
  assets                           list watched assets
  sync [ASSET]                     pull new events (every workspace when no --org)
  holdings ASSET [--as-of ISO]     on-chain holders
  register ASSET FILE --as-of ISO  import a register export and reconcile it
        [--fail-on-breaks]
  registers ASSET                  list imported registers
  register-delete ASSET ID [--yes] remove a register and its reconciliation runs
  journal ASSET FILE               import the register's transaction journal
  journal-list ASSET [--limit N] [--before REF|ISO]  list imported journal entries
  instructions ASSET FILE          import control instructions
  instructions-list ASSET          list imported control instructions
  reconcile ASSET [--register ID]  re-run a reconciliation
        [--fail-on-breaks]
  runs ASSET [--limit N]           list reconciliation runs for an asset
  run ID                           show one reconciliation run
  action ASSET dividend --record ISO --rate R [--pay-asset A] [--payer G...] [--until ISO]
  action ASSET split|redemption --record ISO --ratio NUM:DEN [--until ISO]
        [--label TEXT] [--exclude A,B]
  actions ASSET                    corporate actions and their state
  controls ASSET                   freeze, authorisation and clawback log
  export ASSET [--from ISO] [--to ISO] [--csv SECTION] [--out FILE]
  signoff ASSET --scope recon|controls|action:N --key KEY --status open|acknowledged|resolved
        [--note TEXT] [--run N]
  verify-pack FILE [--key PEM]

Operator commands.

  orgs                             list workspaces
  purge-expired                    remove expired identity records
  signup-code [--note TEXT]        a code that lets one new workspace be created (CONCORD_SIGNUP=code)
  reset-link EMAIL                 a one-day link for setting a new password
  invite ORG EMAIL [--role owner|member]  create a workspace invitation link
  org-delete ORG                   delete a workspace and everything in it
  backup DIR [--verify]            copy every database to DIR while the server runs; --verify
                                   checks each copy's integrity and schema version
  restore DIR [--into DIR2] [--force]
                                   copy a backup into the data directory (refuses a non-empty one)
  serve                            run the API and dashboard

ASSET is a code or a contract id. Add --json to most commands for machine-readable output,
or --help (-h) to see this text. Settings come from the environment; see .env.example.

Exit codes: 0 success, 1 error, 2 open breaks (--fail-on-breaks).`;
