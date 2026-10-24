import { useRef, useState } from "react";
import { api, type AssetSummary, type Controls as ControlsData, type Issue } from "../api";
import { BreakTable } from "../breaks";
import {
  Addr,
  Badge,
  Button,
  Empty,
  ErrorNote,
  Field,
  Figures,
  IssueList,
  Section,
  Skeleton,
  TableWrap,
  TemplateLink,
  Tx,
  Units,
  inputClass,
  readFile,
  useAction,
  useLoad,
  when,
} from "../ui";

const TYPES: Record<string, string> = {
  authorize: "Authorise",
  freeze: "Freeze",
  unfreeze: "Unfreeze",
  clawback: "Clawback",
};

export function Controls({ asset, onChange }: { asset: AssetSummary; onChange: () => void }) {
  const { data, error, loading, reload } = useLoad(
    () => api<ControlsData>(`/assets/${asset.id}/controls`),
    [asset.id, asset.syncedLedger],
  );
  const file = useRef<HTMLInputElement>(null);
  const upload = useAction();
  const [note, setNote] = useState<string>();
  const [issues, setIssues] = useState<Issue[]>([]);
  const refresh = () => {
    reload();
    onChange();
  };
  if (loading && !data) return <Skeleton rows={8} />;
  if (!data) {
    return (
      <div className="flex flex-col items-start gap-3">
        <ErrorNote message={error ?? "The controls log could not be loaded."} />
        <Button onClick={reload}>Try again</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      {error && <ErrorNote message={`Showing the last log loaded. ${error}`} />}
      <Figures
        items={[
          { label: "Control actions on chain", value: data.summary.controls },
          { label: "Backed by an instruction", value: data.summary.instructed },
          {
            label: "No instruction",
            value: data.summary.uninstructed,
            ...(data.summary.uninstructed ? { tone: "bad" as const } : {}),
          },
          {
            label: "Instructions never executed",
            value: data.summary.unexecuted,
            ...(data.summary.unexecuted ? { tone: "bad" as const } : {}),
          },
          { label: "Awaiting execution", value: data.summary.pending },
        ]}
      />

      {data.breaks.length > 0 && (
        <Section title="Exceptions">
          <BreakTable assetId={asset.id} breaks={data.breaks} onChange={refresh} />
        </Section>
      )}

      <Section title="Log" aside={<span className="text-xs text-muted">Chain read through {when(data.asOf)}</span>}>
        {data.records.length === 0 ? (
          <Empty title="No control actions seen">
            Authorisations, freezes and clawbacks appear here as the issuer uses them on chain.
          </Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Closed</th>
                  <th>Action</th>
                  <th>Account</th>
                  <th className="r">Units</th>
                  <th>Instruction</th>
                  <th>Approved by</th>
                  <th>Reason</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {data.records.map((r) => (
                  <tr key={r.eventId}>
                    <td className="whitespace-nowrap text-[13px]">{when(r.closedAt)}</td>
                    <td className="font-medium">{TYPES[r.type] ?? r.type}</td>
                    <td>
                      <Addr value={r.account} />
                    </td>
                    <td className="r">{r.units !== null && <Units value={r.units} />}</td>
                    <td>{r.instruction ? <span className="num">{r.instruction.ref}</span> : <Badge tone="bad">None</Badge>}</td>
                    <td className="text-[13px]">{r.instruction?.approvedBy}</td>
                    <td className="max-w-[28ch] text-[13px]">{r.instruction?.reason}</td>
                    <td>
                      <Tx hash={r.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>

      {data.pending.length > 0 && (
        <Section title="Awaiting execution">
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Instruction</th>
                  <th>Action</th>
                  <th>Account</th>
                  <th>Approved</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.pending.map((i) => (
                  <tr key={i.ref}>
                    <td className="num">{i.ref}</td>
                    <td>{TYPES[i.type] ?? i.type}</td>
                    <td>
                      <Addr value={i.account} />
                    </td>
                    <td className="whitespace-nowrap text-[13px]">{when(i.issuedAt)}</td>
                    <td className="text-[13px]">{i.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Section>
      )}

      <Section title="Instructions">
        <form
          className="flex max-w-xl flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void upload.run(async () => {
              const csv = await readFile(file.current?.files?.[0]);
              const out = await api<{ instructions: number; issues: Issue[] }>(`/assets/${asset.id}/instructions`, {
                body: { csv },
              });
              setIssues(out.issues);
              setNote(`${out.instructions} ${out.instructions === 1 ? "instruction" : "instructions"} loaded.`);
              refresh();
            });
          }}
        >
          <Field
            label="Instruction file"
            hint="CSV with ref, type (authorize, freeze, unfreeze or clawback), account and issued_at. Optional: units (required for a clawback), approved_by, reason. An instruction covers an action taken within 72 hours after it. See docs/controls.md for the matching rules."
          >
            <input ref={file} type="file" accept=".csv,text/csv" className={`${inputClass} py-1`} />
          </Field>
          <TemplateLink kind="instructions" />
          {upload.error && <ErrorNote message={upload.error} />}
          {note && (
            <p role="status" className="text-[13px] text-muted">
              {note}
            </p>
          )}
          <IssueList issues={issues} what="instruction file" />
          <div>
            <Button busy={upload.busy} type="submit">
              Import instructions
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}
