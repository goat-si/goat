import { historyRows } from "@goat/client-runtime/computer-use-history";
import type { ComputerUseHistoryEntry } from "@goat/contracts";

export function ComputerUseHistoryRows(props: {
  readonly entries: ReadonlyArray<typeof ComputerUseHistoryEntry.Type>;
}) {
  return (
    <ul
      aria-label="Computer use history"
      className="max-h-64 space-y-2 overflow-y-auto text-xs text-muted-foreground"
    >
      {historyRows(props.entries).map((row) => (
        <li key={row.id} className="rounded border border-border p-2">
          <div>
            <time>{row.time}</time> · {row.target}
          </div>
          <div>
            {row.method}
            {row.label ? ` · ${row.label}` : ""}
          </div>
          <div>
            {row.verdict}
            {row.refusal ? ` · ${row.refusal}` : ""}
          </div>
          {row.typed === null ? null : <div>Typed: {row.typed}</div>}
        </li>
      ))}
    </ul>
  );
}
