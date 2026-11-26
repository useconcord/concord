import { DownloadSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { download, type AssetSummary } from "../api";
import { Button, ErrorNote, Field, LOCAL_TIME_HINT, Section, inputClass, localToIso, useAction } from "../ui";

const SECTIONS = [
  ["holdings", "Holdings", "Every holder and balance at the end of the period."],
  ["breaks", "Breaks", "Every break raised in the period with its sign-off note."],
  ["controls", "Controls log", "Freezes, authorisations and clawbacks with their instructions."],
  ["events", "Ledger events", "The raw event trail the figures are derived from."],
  ["positions", "Positions", "Lines of each reconciliation run in the period."],
  ["runs", "Reconciliation runs", "Each reconciliation run in the period with its summary."],
  ["actions", "Corporate actions", "Corporate actions recorded in the period."],
  ["journal", "Transaction journal", "The loaded transaction journal entries."],
  ["instructions", "Instructions", "The loaded control instructions."],
] as const;

export function Export({ asset }: { asset: AssetSummary }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { busy, error, run } = useAction();
  const query = () => {
    const q = new URLSearchParams();
    if (from) q.set("from", localToIso(from));
    if (to) q.set("to", localToIso(to));
    return q;
  };
  const get = (extra: Record<string, string>, name: string) =>
    run(() => {
      const q = query();
      for (const [k, v] of Object.entries(extra)) q.set(k, v);
      return download(`/assets/${asset.id}/export?${q}`, name);
    });
  return (
    <div className="flex flex-col gap-8">
      <div className="grid max-w-xl gap-4 md:grid-cols-2">
        <Field label="Period from" hint="Empty starts at the first indexed ledger.">
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </Field>
        <Field label="Period to" hint={`Empty ends at the latest indexed ledger. ${LOCAL_TIME_HINT}`}>
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </Field>
      </div>
      {error && <ErrorNote message={error} />}
      <Section title="Audit pack">
        <p className="max-w-[65ch] text-[13px] text-muted">
          One JSON file with holdings, reconciliations, corporate actions, the controls log and the event trail for the
          period. It carries a SHA-256 digest of its content so a reviewer can confirm it was not altered.
        </p>
        <div>
          <Button variant="primary" busy={busy} onClick={() => void get({ download: "1" }, `concord-${asset.code}-audit.json`)}>
            <DownloadSimple size={16} />
            Download audit pack
          </Button>
        </div>
      </Section>
      <Section title="Spreadsheets">
        <ul className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          {SECTIONS.map(([key, title, text]) => (
            <li key={key} className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-[13px] text-muted">{text}</p>
              </div>
              <Button busy={busy} onClick={() => void get({ section: key }, `concord-${asset.code}-${key}.csv`)}>
                <DownloadSimple size={16} />
                CSV
              </Button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
