import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { HubDevice } from "@goat/client-runtime/state/hub-fleet";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, HubDeviceOperationResult } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useContext, useId, useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  HUB_ACTION_LABEL,
  HUB_ACTION_PLAN,
  HUB_DEVICE_ACTIONS,
  HUB_STATE_LABEL,
  hubStepRows,
  type HubAction,
} from "./hubDeviceSteps";

export interface HubActionEntry {
  readonly environmentId: EnvironmentId;
  readonly alias: string;
  readonly action: HubAction;
  readonly status: "running" | "done" | "error";
  /** The decision this call carried, so the result can say the key was approved. */
  readonly decisionId?: string;
  readonly result?: HubDeviceOperationResult;
  readonly error?: string;
}

const entryKey = (environmentId: EnvironmentId, alias: string) => `${environmentId}\u0000${alias}`;

/**
 * The last action per device. Kept alive so a decision answered in Settings → Decision inbox can
 * be continued here, and so a device that left the hub keeps its result after the list refreshes.
 */
export const hubActionsAtom = Atom.make<Readonly<Record<string, HubActionEntry>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("hub-device-actions"),
);

const STATE_BADGE = {
  child: "success",
  ready: "success",
  degraded: "warning",
  needs_human: "info",
  failed: "error",
} as const;

const OUTCOME_TEXT = {
  ok: "text-success-foreground",
  failed: "text-destructive-foreground",
  deferred: "text-warning-foreground",
  waiting: "text-info-foreground",
} as const;

const OUTCOME_LABEL = { ok: "ok", failed: "failed", deferred: "deferred", waiting: "waiting" };

export function useHubActions(environmentId: EnvironmentId, onDone: () => void) {
  const registry = useContext(RegistryContext);
  const entries = useAtomValue(hubActionsAtom);
  const allowed = useAtomValue(serverEnvironment.joinHubDevice.permissionAtom(environmentId));
  const commands = {
    join: useAtomCommand(serverEnvironment.joinHubDevice, { reportFailure: false }),
    leave: useAtomCommand(serverEnvironment.leaveHubDevice, { reportFailure: false }),
    repair: useAtomCommand(serverEnvironment.repairHubDevice, { reportFailure: false }),
  };
  const put = (entry: HubActionEntry) =>
    registry.set(hubActionsAtom, {
      ...registry.get(hubActionsAtom),
      [entryKey(entry.environmentId, entry.alias)]: entry,
    });
  const run = async (action: HubAction, alias: string, decisionId?: string) => {
    const base = { environmentId, alias, action, ...(decisionId ? { decisionId } : {}) };
    put({ ...base, status: "running" });
    const outcome = await commands[action]({
      environmentId,
      input: { deviceAlias: alias, ...(decisionId ? { decisionId } : {}) },
    });
    if (outcome._tag === "Failure") {
      const failure = squashAtomCommandFailure(outcome);
      put({
        ...base,
        status: "error",
        error: failure instanceof Error ? failure.message : String(failure),
      });
    } else put({ ...base, status: "done", result: outcome.value });
    onDone();
  };
  return {
    allowed,
    run,
    entry: (alias: string) => entries[entryKey(environmentId, alias)],
    entries: Object.values(entries).filter((entry) => entry.environmentId === environmentId),
  };
}

export type HubActions = ReturnType<typeof useHubActions>;

/** Join for a standalone device; Repair and Leave for a Remote Link Child. Leave asks first. */
export function HubDeviceActionButtons({
  device,
  actions,
}: {
  readonly device: HubDevice;
  readonly actions: HubActions;
}) {
  const [confirming, setConfirming] = useState(false);
  const busy = actions.entry(device.alias)?.status === "running";
  return (
    <>
      {HUB_DEVICE_ACTIONS[device.transport].map((action) => (
        <Button
          key={action}
          size="xs"
          variant="outline"
          disabled={busy || !actions.allowed}
          onClick={() =>
            action === "leave" ? setConfirming(true) : void actions.run(action, device.alias)
          }
        >
          {HUB_ACTION_LABEL[action]}
        </Button>
      ))}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {device.alias} from the hub?</AlertDialogTitle>
            <AlertDialogDescription>
              GOAT disconnects {device.alias} from this Home and restarts its OpenCodex, then
              revokes the link here. {device.alias} goes back to its own sign-ins, and its model
              traffic stops going through the hub.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void actions.run("leave", device.alias);
              }}
            >
              Disconnect and remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** Progress while a call runs, then each step H3 reports, and the way on from a decision. */
export function HubActionResult({
  entry,
  actions,
}: {
  readonly entry: HubActionEntry | undefined;
  readonly actions: HubActions;
}) {
  if (entry === undefined) return null;
  const title = `${HUB_ACTION_LABEL[entry.action]} ${entry.alias}`;
  if (entry.status === "running")
    return (
      <div role="status" className="rounded-md bg-muted/40 px-3 py-2 text-xs">
        <p className="font-medium">{title}…</p>
        <p className="text-muted-foreground">{HUB_ACTION_PLAN[entry.action]}</p>
      </div>
    );
  if (entry.status === "error")
    return (
      <div className="space-y-1.5 rounded-md bg-muted/40 px-3 py-2 text-xs">
        <p role="alert" className="text-destructive">
          {title} stopped: {entry.error}
        </p>
        {entry.decisionId === undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={!actions.allowed}
            onClick={() => void actions.run(entry.action, entry.alias)}
          >
            Start again
          </Button>
        )}
      </div>
    );
  const result = entry.result!;
  const decisionId = result.state === "needs_human" ? result.decisionId : undefined;
  return (
    <section
      aria-label={`${title} result`}
      className="space-y-1.5 rounded-md bg-muted/40 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        <Badge size="sm" variant={STATE_BADGE[result.state]}>
          {HUB_STATE_LABEL[result.state]}
        </Badge>
      </div>
      <p>{result.message}</p>
      {result.steps.length === 0 && result.parity === undefined ? null : (
        <ol className="space-y-0.5">
          {hubStepRows(result, entry.decisionId).map((row) => (
            <li key={row.key} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{row.label}</span>
              <span className={cn("font-mono", OUTCOME_TEXT[row.outcome])}>
                {OUTCOME_LABEL[row.outcome]}
              </span>
              {row.detail === undefined ? null : (
                <span className="text-muted-foreground wrap-anywhere">{row.detail}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {decisionId === undefined ? null : (
        <div className="space-y-1.5">
          <p className="text-muted-foreground">
            A person who can change this hub's settings answers it in the decision inbox. Then
            continue here.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" render={<Link to="/settings/decision-inbox" />}>
              Open decision
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!actions.allowed}
              onClick={() => void actions.run(entry.action, entry.alias, decisionId)}
            >
              Continue
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Join a device that is not in the list yet, by its SSH alias. */
export function AddHubDevice({
  actions,
  suggestions,
  onClose,
}: {
  readonly actions: HubActions;
  readonly suggestions: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  const [alias, setAlias] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const inputId = useId();
  const listId = useId();
  const trimmed = alias.trim();
  const running = submitted !== null && actions.entry(submitted)?.status === "running";
  return (
    <div className="space-y-2 px-3 py-3 sm:px-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "" || running) return;
          setSubmitted(trimmed);
          void actions.run("join", trimmed);
        }}
      >
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            SSH alias of the device
          </label>
          <Input
            id={inputId}
            list={listId}
            value={alias}
            placeholder="mac-studio"
            onChange={(event) => setAlias(event.target.value)}
          />
          <datalist id={listId}>
            {suggestions.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </div>
        <Button type="submit" size="sm" disabled={trimmed === "" || running || !actions.allowed}>
          Join
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        The device needs OpenCodex and a direct SSH alias on this machine. GOAT checks its host key
        against the key it pinned for that alias before linking.
      </p>
      {submitted === null ? null : (
        <HubActionResult entry={actions.entry(submitted)} actions={actions} />
      )}
    </div>
  );
}
