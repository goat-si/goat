import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OpenCodexUpdateStatus } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { hostStatusAtom } from "~/state/hostStatus";
import { OpenCodexSyncButton } from "../opencodex/OpenCodexSyncDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/tabs";
import {
  buildRuntimesTab,
  selectedRows,
  updateButtonLabel,
  type UpdateDialogRow,
  type UpdateDialogTab,
  type UpdateTab,
} from "./updateEverything.logic";
import type { UpdateEverything } from "./useUpdateEverything";

const TAB_LABELS: Record<UpdateTab, string> = { app: "App & servers", runtimes: "Runtimes" };
const TAB_NOTES: Record<UpdateTab, string> = {
  app: "Servers go first and this Mac restarts last. Busy machines wait until their threads finish.",
  runtimes: "Provider CLIs update in place. OpenCodex updates the Home before its Children.",
};

export interface UpdateDialogSelection {
  readonly tab: UpdateTab;
  readonly rows: ReadonlyArray<UpdateDialogRow>;
}

type DialogEverything = Pick<
  UpdateEverything,
  "appTab" | "providerMachines" | "localEnvironmentId"
>;

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly everything: DialogEverything;
  readonly onConfirm: (selection: UpdateDialogSelection) => void;
}

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  everything,
  onConfirm,
}: UpdateEverythingDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="sm:max-w-xl">
        {open ? (
          everything.localEnvironmentId === null ? (
            <DialogWithOpenCodex everything={everything} status={null} onConfirm={onConfirm} />
          ) : (
            <LocalOpenCodexDialog
              environmentId={everything.localEnvironmentId}
              everything={everything}
              onConfirm={onConfirm}
            />
          )
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Read while the dialog is open: the read samples CPU, so the sidebar button never polls it. */
function LocalOpenCodexDialog({
  environmentId,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly everything: DialogEverything;
  readonly onConfirm: (selection: UpdateDialogSelection) => void;
}) {
  const result = useAtomValue(hostStatusAtom(environmentId, { local: true }));
  const hosts = Option.getOrNull(AsyncResult.value(result))?.hosts ?? [];
  const status = hosts.find((host) => host.host === null)?.opencodexUpdate ?? null;
  return <DialogWithOpenCodex {...props} status={status} />;
}

function DialogWithOpenCodex({
  everything,
  status,
  onConfirm,
}: {
  readonly everything: DialogEverything;
  readonly status: OpenCodexUpdateStatus | null;
  readonly onConfirm: (selection: UpdateDialogSelection) => void;
}) {
  const runtimes = buildRuntimesTab({
    providerMachines: everything.providerMachines,
    opencodex:
      everything.localEnvironmentId === null
        ? null
        : {
            environmentId: everything.localEnvironmentId,
            status,
            // This Mac's own server is this build, so it serves the check.
            canCheck: true,
          },
  });
  return (
    <UpdateDialogView
      app={everything.appTab}
      runtimes={runtimes}
      onConfirm={onConfirm}
      runtimesFooter={
        everything.localEnvironmentId === null ? null : (
          <div className="mt-2 flex items-center gap-3 border-t pt-2">
            <p className="min-w-0 flex-1 text-muted-foreground text-xs">
              Load OpenCodex's current models into Codex here and on each Child.
            </p>
            <OpenCodexSyncButton
              environmentId={everything.localEnvironmentId}
              homeLabel="This Mac"
            />
          </div>
        )
      }
    />
  );
}

export function UpdateDialogView({
  app,
  runtimes,
  onConfirm,
  runtimesFooter = null,
}: {
  readonly app: UpdateDialogTab;
  readonly runtimes: UpdateDialogTab;
  readonly onConfirm: (selection: UpdateDialogSelection) => void;
  /** Shown under the Runtimes rows: the Sync OpenCodex action beside the OpenCodex update. */
  readonly runtimesFooter?: ReactNode;
}) {
  const tabs: Record<UpdateTab, UpdateDialogTab> = { app, runtimes };
  const [tab, setTab] = useState<UpdateTab>(() =>
    selectedRows(app, new Set()).length === 0 && selectedRows(runtimes, new Set()).length > 0
      ? "runtimes"
      : "app",
  );
  const [unchecked, setUnchecked] = useState<Record<UpdateTab, ReadonlySet<string>>>({
    app: new Set(),
    runtimes: new Set(),
  });
  const count = (name: UpdateTab) => selectedRows(tabs[name], unchecked[name]).length;
  const selected = selectedRows(tabs[tab], unchecked[tab]);
  const toggle = (name: UpdateTab, id: string, checked: boolean) =>
    setUnchecked((current) => {
      const next = new Set(current[name]);
      if (checked) next.delete(id);
      else next.add(id);
      return { ...current, [name]: next };
    });

  return (
    <Tabs value={tab} onValueChange={(value: UpdateTab) => setTab(value)}>
      <AlertDialogHeader>
        <AlertDialogTitle>Update</AlertDialogTitle>
        <TabsList aria-label="What to update">
          {(["app", "runtimes"] as const).map((name) => (
            <TabsTab key={name} value={name}>
              {TAB_LABELS[name]}
              <span className="text-muted-foreground tabular-nums">{count(name)}</span>
            </TabsTab>
          ))}
        </TabsList>
      </AlertDialogHeader>
      {(["app", "runtimes"] as const).map((name) => (
        <TabsPanel key={name} value={name}>
          <div className="px-6 pb-4">
            <UpdateTabRows
              name={name}
              tab={tabs[name]}
              unchecked={unchecked[name]}
              onToggle={(id, checked) => toggle(name, id, checked)}
            />
            {name === "runtimes" ? runtimesFooter : null}
          </div>
        </TabsPanel>
      ))}
      <AlertDialogFooter className="sm:items-center">
        <p className="text-muted-foreground text-xs max-sm:order-last sm:mr-auto sm:max-w-72">
          {TAB_NOTES[tab]}
        </p>
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button disabled={selected.length === 0} onClick={() => onConfirm({ tab, rows: selected })}>
          {updateButtonLabel(selected.length)}
        </Button>
      </AlertDialogFooter>
    </Tabs>
  );
}

function UpdateTabRows({
  name,
  tab,
  unchecked,
  onToggle,
}: {
  readonly name: UpdateTab;
  readonly tab: UpdateDialogTab;
  readonly unchecked: ReadonlySet<string>;
  readonly onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <div className="max-h-[min(22rem,50dvh)] overflow-y-auto overscroll-contain">
      {tab.rows.length === 0 ? (
        <p className="py-3 text-muted-foreground text-sm">
          {name === "app" ? "Every connected server matches this Mac." : "No runtime updates."}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {tab.rows.map((row) => (
            <li key={row.id}>
              <UpdateRow
                row={row}
                checked={!unchecked.has(row.id)}
                onToggle={(checked) => onToggle(row.id, checked)}
              />
            </li>
          ))}
        </ul>
      )}
      {tab.skipped.length > 0 ? (
        <div className="mt-2 border-t pt-2 text-muted-foreground text-xs">
          <p className="font-medium">Skipped</p>
          <ul className="mt-1 space-y-0.5">
            {tab.skipped.map((machine) => (
              <li key={machine.environmentId} className="wrap-anywhere">
                {machine.label}: {machine.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function UpdateRow({
  row,
  checked,
  onToggle,
}: {
  readonly row: UpdateDialogRow;
  readonly checked: boolean;
  readonly onToggle: (checked: boolean) => void;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">{row.label}</span>
        <span className="block truncate text-muted-foreground text-xs">{row.detail}</span>
      </span>
      <UpdateRowState row={row} />
    </>
  );
  if (!row.selectable) {
    return <div className="flex items-center gap-3 py-2 pl-7">{body}</div>;
  }
  return (
    <label className="flex cursor-pointer items-center gap-3 py-2">
      <Checkbox checked={checked} onCheckedChange={(next) => onToggle(next === true)} />
      {body}
    </label>
  );
}

function UpdateRowState({ row }: { readonly row: UpdateDialogRow }) {
  if (row.runningThreads > 0) {
    return (
      <span className="shrink-0 text-right text-warning text-xs">
        {row.runningThreads} running
        <span className="block text-muted-foreground">waits for idle</span>
      </span>
    );
  }
  if (row.toVersion === null) return null;
  return (
    <span className="min-w-0 max-w-[45%] shrink truncate text-right text-muted-foreground text-xs tabular-nums max-sm:hidden">
      → <span className="text-foreground">{row.toVersion}</span>
    </span>
  );
}
