// First run (board 2LEV-2): no providers added yet. Lists what GOAT found on this Mac with one-click Add.
import type { ServerProviderEntry } from "./wire.ts";
import { useAction, useProviderCall } from "./context.tsx";
import { detected, detectedLine, enableBody, titleParts, iconOf } from "./view.ts";
import { Button, ErrorLine, INK, Logo, MUTED, text } from "./ui.tsx";

export function FirstRun({ entries, keptOff, hidden, onAdded, onBrowse }: { entries: ServerProviderEntry[]; keptOff: string[]; hidden: string[]; onAdded: (instanceId: string) => void; onBrowse: () => void }) {
  const call = useProviderCall();
  const act = useAction();
  const found = detected(entries, keptOff, hidden);
  const add = (list: ServerProviderEntry[]) => act.run(list.length > 1 ? "all" : list[0]!.instanceId, async () => {
    for (const e of list) await call("goat2.setProviderInstance", enableBody(e));
    onAdded(list[0]!.instanceId);
  });
  return (
    <div data-provider-first-run="" style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", paddingTop: 140, paddingInline: 32, boxSizing: "border-box" }}>
      <h1 style={{ margin: 0, ...text(20, INK, 600) }}>No providers yet</h1>
      <div style={{ ...text(14, MUTED), marginTop: 8, maxWidth: 420, textAlign: "center" }}>
        A provider is a coding agent GOAT runs for you, like Codex or Claude. {found.length > 0 ? "We found these on this Mac." : "We didn\u2019t find one on this Mac yet."}
      </div>
      {found.length > 0 ? (
        <div style={{ marginTop: 24, width: 556, borderRadius: 10, boxShadow: "#ECECEC 0px 0px 0px 1px inset", display: "flex", flexDirection: "column" }}>
          {found.map((e, n) => (
            <div key={e.instanceId} style={{ alignItems: "center", display: "flex", gap: 12, padding: "14px 16px", ...(n > 0 ? { borderTop: "1px solid #F0F0F0" } : {}) }}>
              <Logo icon={iconOf(e)} tile={32} />
              <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", gap: 2 }}>
                <div style={text(14, INK, 600)}>{titleParts(e).name}</div>
                <div style={text(12, MUTED)}>{detectedLine(e)}</div>
              </div>
              <Button primary={n === 0} onClick={() => void add([e])} disabled={act.busy !== null}>Add</Button>
            </div>
          ))}
        </div>
      ) : null}
      <ErrorLine error={act.error} />
      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        {found.length > 1 ? <Button primary onClick={() => void add(found)} disabled={act.busy !== null}>Add all {found.length}</Button> : null}
        <Button onClick={onBrowse}>Browse all providers</Button>
      </div>
    </div>
  );
}

