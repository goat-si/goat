import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, OpenCodexSyncReport } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { shownReport, syncAction, syncRowView, type SyncTone } from "./openCodexSync.logic";

const TONE_TEXT: Record<SyncTone, string> = {
  muted: "text-muted-foreground",
  progress: "text-info-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive-foreground",
};

const failureText = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;

/** The plan, the run and its result for one environment, read when the dialog opens. */
function useOpenCodexSync(environmentId: EnvironmentId) {
  const readPlan = useAtomCommand(serverEnvironment.planOpenCodexSync, { reportFailure: false });
  const runSync = useAtomCommand(serverEnvironment.syncOpenCodex, { reportFailure: false });
  const [plan, setPlan] = useState<OpenCodexSyncReport | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  // undefined until Sync is pressed; then the live report's time at that moment.
  const [before, setBefore] = useState<number | null | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OpenCodexSyncReport | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const refreshPlan = async () => {
    setReading(true);
    const outcome = await readPlan({ environmentId, input: {} });
    if (outcome._tag === "Failure") {
      setPlanError(
        failureText(squashAtomCommandFailure(outcome), "Could not reach this server's machines."),
      );
    } else {
      setPlan(outcome.value);
      setPlanError(null);
    }
    setReading(false);
  };
  const open = () => {
    setBefore(undefined);
    setResult(null);
    setRunError(null);
    void refreshPlan();
  };
  const start = async (liveAt: number | null) => {
    setBefore(liveAt);
    setResult(null);
    setRunError(null);
    setRunning(true);
    const outcome = await runSync({ environmentId, input: {} });
    if (outcome._tag === "Failure")
      setRunError(failureText(squashAtomCommandFailure(outcome), "The sync did not finish."));
    else setResult(outcome.value);
    setRunning(false);
    await refreshPlan();
  };
  return { plan, planError, reading, before, running, result, runError, open, start };
}

/**
 * Opens the Sync OpenCodex dialog for an environment. `homeLabel` names that environment's own
 * row, since its alias is null there.
 */
export function OpenCodexSyncButton({
  environmentId,
  homeLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const allowed = useAtomValue(serverEnvironment.syncOpenCodex.permissionAtom(environmentId));
  const sync = useOpenCodexSync(environmentId);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={!allowed}
        title={allowed ? undefined : "Syncing needs permission to maintain this server."}
        onClick={() => {
          setOpen(true);
          sync.open();
        }}
      >
        Sync OpenCodex
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-lg">
          {open ? (
            <SyncPanel
              environmentId={environmentId}
              homeLabel={homeLabel}
              allowed={allowed}
              sync={sync}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function SyncPanel({
  environmentId,
  homeLabel,
  allowed,
  sync,
}: {
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string;
  readonly allowed: boolean;
  readonly sync: ReturnType<typeof useOpenCodexSync>;
}) {
  const live = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(serverEnvironment.openCodexSyncLive({ environmentId, input: {} })),
    ),
  );
  const report = shownReport({ plan: sync.plan, live, result: sync.result, before: sync.before });
  const action = syncAction({
    allowed,
    reading: sync.reading,
    running: sync.running,
    planError: sync.planError,
    plan: sync.plan,
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync OpenCodex</DialogTitle>
        <DialogDescription>
          Fetches every provider's models and loads them into Codex, here first and then on each
          linked Child. Children always take this Home's models and settings.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {report === null ? (
          <p className="text-muted-foreground text-sm">
            {sync.planError ?? (sync.reading ? "Checking each machine…" : "No machines to sync.")}
          </p>
        ) : (
          <ul aria-label="Machines" className="divide-y divide-border">
            {report.members.map((member) => {
              const row = syncRowView(member, homeLabel);
              return (
                <li key={row.key} className="flex items-baseline gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
                  <span className={cn("min-w-0 text-right text-xs", TONE_TEXT[row.tone])}>
                    {row.status}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {sync.runError === null ? null : (
          <p role="alert" className="mt-2 text-destructive-foreground text-xs">
            {sync.runError}
          </p>
        )}
      </DialogPanel>
      <DialogFooter className="sm:items-center">
        {action.reason === null ? null : (
          <p className="text-muted-foreground text-xs max-sm:order-last sm:mr-auto">
            {action.reason}
          </p>
        )}
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        <Button disabled={!action.enabled} onClick={() => void sync.start(live?.checkedAt ?? null)}>
          Sync
        </Button>
      </DialogFooter>
    </>
  );
}
