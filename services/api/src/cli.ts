import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve, basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";
import { parseArgs } from "node:util";
import { NotFound, type ActionInput, type Actor, type Concord, type WatchInput, verifyPack } from "./concord.js";
import { isNetworkName, loadConfig } from "./config.js";
import { openRuntime, startServer } from "./main.js";
import { CLI_OPTIONS, USAGE, describeArgsError } from "./cli-usage.js";

function table(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return console.log("(none)");
  console.table(rows);
}

/** Open a backup copy read-only and check its integrity and schema version; throws naming the file. */
export function verifyBackupFile(filePath: string, expectedUserVersion: number): void {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`corrupted backup: ${filePath} failed to open (${msg})`);
  }
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const result = rows.length > 0 ? String(Object.values(rows[0]!)[0]) : "";
    if (result !== "ok") throw new Error(`corrupted backup: ${filePath} failed integrity check (${result})`);
    const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    const version = versionRow ? Number(Object.values(versionRow)[0]) : -1;
    if (version !== expectedUserVersion) {
      throw new Error(`corrupted backup: ${filePath} user_version mismatch (expected ${expectedUserVersion}, got ${version})`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("corrupted backup:")) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`corrupted backup: ${filePath} failed integrity check (${msg})`);
  } finally {
    db.close();
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  return row ? Number(Object.values(row)[0]) : 0;
}

function parseCommandLine(args: string[]) {
  try {
    return parseArgs({ args, allowPositionals: true, options: CLI_OPTIONS });
  } catch (err) {
    const message = describeArgsError(err, args);
    if (message) throw new Error(message);
    throw err;
  }
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { positionals, values } = parseCommandLine(argv);
  const [command, a, b] = positionals;
  if (!command || values.help) return console.log(USAGE);
  if (command === "serve") return startServer();
  if (command === "restore") {
    // Runs without opening the runtime: the destination must not be in use.
    if (!a) throw new Error(`missing backup directory\n\n${USAGE}`);
    const srcDir = resolve(a);
    const destDir = resolve(values.into ?? loadConfig(env).dataDir);
    if (!existsSync(join(srcDir, "control.db"))) {
      throw new Error(`not a valid backup directory: missing control.db in ${srcDir}`);
    }
    if (existsSync(destDir) && readdirSync(destDir).length > 0 && !values.force) {
      throw new Error(`destination directory ${destDir} is not empty; pass --force to overwrite`);
    }
    mkdirSync(destDir, { recursive: true });
    cpSync(srcDir, destDir, { recursive: true, force: true });
    console.log(`restored backup from ${srcDir} into ${destDir}`);
    return;
  }

  const config = loadConfig(env);
  const runtime = openRuntime(config);
  try {
    const { auth, tenants } = runtime;
    const actor: Actor = { id: "cli", label: `cli:${userInfo().username}` };
    const need = (value: string | undefined, what: string): string => {
      if (!value) throw new Error(`missing ${what}\n\n${USAGE}`);
      return value;
    };
    const list = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
    const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
    const orgRef = values.org ?? env.CONCORD_ORG;
  const workspace = (): Concord => tenants.forOrg(auth.findOrg(need(orgRef, "--org (see `concord orgs`)")).id);
  /**
   * A delete shows what it would remove and then does nothing until the operator confirms, with
   * `--yes` or by answering the prompt on a terminal. `--dry-run` stops after the counts.
   */
  const approved = async (what: string, counts: DeletionCounts): Promise<boolean> => {
    if (values.json) out(counts);
    else {
      console.log(what);
      table([{ ...counts }]);
    }
    if (values["dry-run"]) return false;
    if (values.yes) return true;
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`Delete ${what}? This cannot be undone. Type "yes" to continue: `);
        if (answer.trim().toLowerCase() === "yes") return true;
      } finally {
        rl.close();
      }
      throw new Error(`nothing was deleted: ${what} was not confirmed`);
    }
    throw new Error(`nothing was deleted: ${what} needs --yes`);
  };
  const printRun = (run: Awaited<ReturnType<Concord["reconcile"]>>) => {
    if (values.json) return out(run);
    console.log(`reconciliation ${run.id} · as of ${run.asOf} · ${run.status.toUpperCase()}`);
    for (const w of run.warnings) console.log(`  warning: ${w}`);
    console.table(run.summary);
    table(
      run.breaks.map((x) => ({
        type: x.type,
        subject: x.address ?? x.ref ?? "",
        chain: x.chainUnits ?? "",
        register: x.registerUnits ?? "",
        diff: x.difference ?? "",
        status: x.status,
      })),
    );
  };

  switch (command) {
    // ── operator ────────────────────────────────────────────────────────────
    case "orgs":
      table(auth.listOrgs().map((o) => ({ id: o.id, name: o.name, members: o.members, created: o.created_at })));
      break;
    case "purge-expired":
      if (values.json) out(auth.purgeExpired());
      else table([auth.purgeExpired()]);
      break;
    case "signup-code":
      console.log(auth.createSignupCode(values.note));
      break;
    case "reset-link":
      console.log(`${config.publicUrl}/#/reset/${auth.createResetToken(need(a, "email"))}`);
      console.log("Valid for one day, once. Send it to the account's owner over a channel you trust.");
      break;
    case "invite": {
      const org = auth.findOrg(need(a, "workspace"));
      const email = need(b, "email");
      if (values.role !== undefined && values.role !== "owner" && values.role !== "member") {
        throw new Error("--role must be owner or member");
      }
      const invite = auth.createInviteAs(org.id, email, values.role ?? "member", actor.label);
      console.log(`${config.publicUrl}/#/invite/${invite.token}`);
      console.log("Valid for 7 days, once. Send it to the invited person over a channel you trust.");
      break;
    }
    case "org-delete": {
      const org = auth.findOrg(need(a, "workspace"));
      const what = `workspace ${org.name} (${org.id})`;
      if (await approved(what, tenants.forOrg(org.id).deletionCounts())) {
        auth.deleteOrg(org.id);
        tenants.drop(org.id);
        console.log(`deleted ${org.name} (${org.id})`);
      }
      break;
    }
    case "backup": {
      const dir = resolve(need(a, "directory"));
      mkdirSync(join(dir, "orgs"), { recursive: true });
      const controlFile = join(dir, "control.db");
      await backup(runtime.control.raw, controlFile);
      if (values.verify) verifyBackupFile(controlFile, userVersion(runtime.control.raw));
      for (const id of auth.orgIds()) {
        const orgFile = join(dir, "orgs", `${id}.db`);
        const orgDb = tenants.forOrg(id).db.raw;
        await backup(orgDb, orgFile);
        if (values.verify) verifyBackupFile(orgFile, userVersion(orgDb));
      }
      console.log(`backed up control.db and ${auth.orgIds().length} workspaces to ${dir}`);
      break;
    }

    // ── workspace ───────────────────────────────────────────────────────────
    case "watch": {
      const network = values.network ?? config.defaultNetwork;
      if (!isNetworkName(network)) throw new Error("--network must be mainnet or testnet");
      const input: WatchInput = { network, asset: need(a, "asset"), ignore: list(values.ignore) };
      if (values.name) input.name = values.name;
      if (values["no-baseline"]) input.baseline = false;
      if (values.from) input.fromLedger = Number(values.from);
      if (values.decimals) input.decimals = Number(values.decimals);
      const concord = workspace();
      const asset = await concord.watchAsset(input, { actor });
      const { added } = await concord.sync(asset.id);
      console.log(`watching ${asset.code} (${asset.id}) on ${asset.network} from ledger ${asset.startLedger}; ${added} events indexed`);
      break;
    }
    case "unwatch": {
      const concord = workspace();
      const asset = concord.asset(need(a, "asset"));
      const what = `asset ${asset.code} (${asset.id}) on ${asset.network}`;
      if (await approved(what, concord.deletionCounts(asset.id))) {
        await concord.unwatchAsset(asset.id);
        console.log("stopped watching; the asset and its books are deleted");
      }
      break;
    }
    case "rebuild": {
      const asset = await workspace().rebuild(need(a, "asset"));
      console.log(`rebuilt ${asset.code} from ledger ${asset.startLedger}`);
      break;
    }
    case "assets":
      table(
        workspace()
          .overview()
          .assets.map((x) => ({
            code: x.code,
            network: x.network,
            supply: x.supply,
            holders: x.holderCount,
            events: x.eventCount,
            syncedAt: x.syncedAt ?? "",
            lastRun: x.lastRun?.status ?? "",
            openBreaks: x.openBreaks.reconciliation + x.openBreaks.controls + x.openBreaks.actions,
            problem: x.syncError ?? "",
          })),
      );
      break;
    case "sync":
      if (a) out(await workspace().sync(a));
      else if (orgRef) out(await workspace().syncAll());
      else out(await tenants.syncAll());
      break;
    case "holdings": {
      const h = workspace().holdings(need(a, "asset"), values["as-of"]);
      if (values.json) return out(h);
      console.log(`supply ${h.supply} · ${h.holderCount} holders · ledger ${h.ledger}`);
      table(h.holders);
      break;
    }
    case "register": {
      const concord = workspace();
      const asset = need(a, "asset");
      const file = need(b, "file");
      const imported = concord.importRegister(
        asset,
        { csv: readFileSync(file, "utf8"), asOf: need(values["as-of"], "--as-of"), source: basename(file) },
        actor,
      );
      if (imported.duplicate) {
        console.log(`register ${imported.registerId}: already imported (same file and as-of time), not added again`);
      } else {
        console.log(`register ${imported.registerId}: ${imported.positions} positions, ${imported.issues.length} rejected rows`);
        for (const issue of imported.issues) console.log(`  line ${issue.line}: ${issue.message}`);
      }
      const run =
        (imported.duplicate && concord.latestRunForRegister(imported.registerId)) ||
        (await concord.reconcile(asset, imported.registerId, actor));
      printRun(run);
      if (values["fail-on-breaks"] && run.openBreaks > 0) process.exitCode = 2;
      break;
    }
    case "registers": {
      const asset = need(a, "asset");
      const list = workspace().registers(asset);
      if (values.json) return out(list);
      table(
        list.map((r) => ({
          id: r.id,
          "as-of": r.asOf,
          source: r.source,
          positions: r.positions,
          "rejected rows": r.issues.length,
          importer: r.importedBy ?? "",
        })),
      );
      break;
    }
    case "register-delete": {
      const asset = need(a, "asset");
      const registerId = Number(need(b, "register id"));
      if (Number.isNaN(registerId)) throw new Error("register id must be a number");
      if (!values.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await rl.question(`Delete register ${registerId} and all associated runs? [y/N] `);
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("aborted");
            break;
          }
        } finally {
          rl.close();
          process.stdin.pause();
        }
      }
      const { runs } = workspace().deleteRegister(asset, registerId);
      if (values.json) {
        out({ deleted: registerId, runs });
      } else {
        console.log(`deleted register ${registerId} (${runs} reconciliation ${runs === 1 ? "run" : "runs"} removed)`);
      }
      break;
    }
    case "journal":
      out(workspace().importJournal(need(a, "asset"), readFileSync(need(b, "file"), "utf8")));
      break;
    case "instructions":
      out(workspace().importInstructions(need(a, "asset"), readFileSync(need(b, "file"), "utf8")));
      break;
    case "journal-list": {
      const limit = values.limit ? Number(values.limit) : undefined;
      const rows = workspace().journalEntries(need(a, "asset"), {
        ...(limit !== undefined ? { limit } : {}),
        ...(values.before ? { before: values.before } : {}),
      });
      if (values.json) {
        out(rows);
        break;
      }
      table(
        rows.map((r) => ({
          ref: r.ref,
          date: r.date,
          type: r.type,
          from: r.from ?? "",
          to: r.to ?? "",
          units: r.units,
          txHash: r.txHash ?? "",
          status: r.status ?? "",
        })),
      );
      break;
    }
    case "instructions-list": {
      const rows = workspace().instructionList(need(a, "asset"));
      if (values.json) {
        out(rows);
        break;
      }
      table(
        rows.map((r) => ({
          ref: r.ref,
          type: r.type,
          account: r.account,
          units: r.units ?? "",
          issuedAt: r.issuedAt,
          approvedBy: r.approvedBy ?? "",
          reason: r.reason ?? "",
        })),
      );
      break;
    }
    case "reconcile": {
      const run = await workspace().reconcile(need(a, "asset"), values.register ? Number(values.register) : undefined, actor);
      printRun(run);
      if (values["fail-on-breaks"] && run.openBreaks > 0) process.exitCode = 2;
      break;
    }
    case "runs": {
      const limit = values.limit ? Number(values.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error("--limit must be a positive integer");
      }
      const all = workspace().runs(need(a, "asset"));
      const items = limit !== undefined ? all.slice(0, limit) : all;
      if (values.json) {
        out(items);
        break;
      }
      table(
        items.map((r) => ({
          id: r.id,
          asOf: r.asOf,
          status: r.status,
          openBreaks: r.openBreaks,
        })),
      );
      break;
    }
    case "run": {
      const concord = workspace();
      const id = Number(need(a, "run id"));
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("run id must be a positive integer");
      printRun(concord.run(id));
      break;
    }
    case "action": {
      const type = need(b, "action type") as ActionInput["type"];
      const input: ActionInput = { type, recordTime: need(values.record, "--record"), exclude: list(values.exclude) };
      if (values.label) input.label = values.label;
      if (values.until) input.windowTo = values.until;
      if (type === "dividend") {
        input.ratePerUnit = need(values.rate, "--rate");
        if (values["pay-asset"]) input.payAsset = values["pay-asset"];
        if (values.payer) input.payer = values.payer;
      } else {
        const [num, den] = need(values.ratio, "--ratio").split(":");
        input.num = need(num, "ratio numerator");
        input.den = need(den, "ratio denominator");
      }
      const action = await workspace().createAction(need(a, "asset"), input, actor);
      if (values.json) return out(action);
      console.log(`${action.label} · record ${action.recordTime} · ${action.state.toUpperCase()}`);
      if (action.result) {
        for (const w of action.result.warnings) console.log(`  warning: ${w}`);
        console.table(action.result.summary);
        table(action.result.lines.map(({ txHashes: _, ...line }) => line));
      }
      break;
    }
    case "actions":
      table(
        workspace()
          .actions(need(a, "asset"))
          .map((x) => ({ id: x.id, label: x.label, record: x.recordTime, state: x.state, openBreaks: x.openBreaks })),
      );
      break;
    case "controls": {
      const log = workspace().controls(need(a, "asset"));
      if (values.json) return out(log);
      console.table(log.summary);
      table(
        log.records.map((r) => ({
          time: r.closedAt,
          type: r.type,
          account: r.account,
          units: r.units ?? "",
          instruction: r.instruction?.ref ?? "— none —",
        })),
      );
      break;
    }
    case "break-history": {
      const concord = workspace();
      const asset = need(a, "asset");
      const scope = need(b ?? values.scope, "scope");
      const key = need(positionals[3] ?? values.key, "break key");
      const history = concord.breakHistory(asset, scope, key);
      if (values.json) return out(history);
      table(history);
      break;
    }
    case "export": {
      const concord = workspace();
      const asset = need(a, "asset");
      const period: { from?: string; to?: string } = {};
      if (values.from) period.from = values.from;
      if (values.to) period.to = values.to;
      const text = values.csv
        ? concord.exportCsv(asset, values.csv, period)
        : JSON.stringify(concord.auditExport(asset, period, config.signingKey ? { signingKey: config.signingKey } : {}), null, 2);
      if (values.out) {
        writeFileSync(values.out, text);
        console.log(`wrote ${values.out}`);
      } else {
        process.stdout.write(text);
      }
      break;
    }
    case "signoff": {
      const asset = need(a, "asset");
      const scope = need(values.scope, "--scope");
      const key = need(values.key, "--key");
      const rawStatus = need(values.status, "--status");
      if (!/^(recon|controls|action:[1-9]\d*)$/.test(scope)) {
        throw new Error("--scope must be recon, controls, or action:N (N a positive integer)");
      }
      if (!["open", "acknowledged", "resolved"].includes(rawStatus)) {
        throw new Error("--status must be open, acknowledged, or resolved");
      }
      const status = rawStatus as "open" | "acknowledged" | "resolved";
      // A note is required to acknowledge or resolve a break; reopening needs none.
      const note = values.note ?? "";
      if (status !== "open" && !note.trim()) throw new Error(`--note is required when --status is ${status}`);
      const concord = workspace();
      const assetRecord = concord.asset(asset);
      let breaks: Array<{ key: string; fingerprint: string }>;
      if (scope === "recon") {
        const r = values.run !== undefined ? concord.run(Number(values.run)) : concord.latestRun(assetRecord.id);
        if (!r) throw new Error("no reconciliation run found for this asset");
        breaks = r.breaks;
      } else if (scope === "controls") {
        breaks = concord.controls(assetRecord.id).breaks;
      } else {
        breaks = concord.action(Number(scope.slice("action:".length))).result?.breaks ?? [];
      }
      const brk = breaks.find((x) => x.key === key);
      if (!brk) throw new NotFound(`no break ${key} in the current ${scope.split(":")[0]} results`);
      concord.setNote(asset, scope, key, { fingerprint: brk.fingerprint, status, note }, actor);
      if (values.json) return out({ ok: true, asset, scope, key, status });
      console.log(`signed off: ${key} → ${status.toUpperCase()}`);
      break;
    }
    case "verify-pack": {
      const file = need(a, "pack file");
      // `pnpm concord` runs from services/api; INIT_CWD is where the operator typed the command.
      const raw = readFileSync(existsSync(file) ? file : resolve(env.INIT_CWD ?? process.cwd(), file), "utf8");
      const pack = JSON.parse(raw);
      const res = verifyPack(pack, values.key ? resolve(values.key) : undefined);
      if (values.json) {
        out(res);
      } else {
        if (!res.digestValid) {
          console.error(`FAIL: digest mismatch (expected ${res.expectedDigest}, got ${res.digest})`);
          process.exitCode = 1;
        } else if (res.signatureChecked && !res.signatureValid) {
          console.error(`FAIL: signature verification failed: ${res.error ?? "invalid signature"}`);
          process.exitCode = 1;
        } else if (res.signatureChecked && res.signatureValid) {
          console.log(`OK: digest verified (${res.digest}), signature valid (key: ${res.keyId})`);
        } else if (res.signed) {
          console.log(`OK: digest verified (${res.digest}), pack is signed (key: ${res.keyId})`);
        } else {
          console.log(`OK: digest verified (${res.digest})`);
        }
      }
      break;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
  } finally {
    runtime.close();
  }
}

function isEntry(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  runCli().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
