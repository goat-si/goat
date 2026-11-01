import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type CloudMachine,
  type CloudMachineType,
  type DesktopSshPreparationProgress,
  type EnvironmentId,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import * as Effect from "effect/Effect";
import { sshRuntimePhaseText } from "@goat/client-runtime/state/sshRuntime";
import { isSshConnectionSuperseded } from "./ConnectionsSettings.logic";

import { requestConfirmDialog } from "~/confirmDialog";
import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  CLOUD_MACHINE_AUTO_STOP_SECONDS,
  CLOUD_MACHINE_SIZES,
  cloudMachineActions,
  cloudMachineStatus,
  formatAutoStop,
} from "./CloudMachinesSettings.logic";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

type CommandResult = AtomCommandResult<unknown, unknown>;

const failureMessage = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.length > 0 ? failure.message : fallback;
};

/**
 * Boat cloud machines owned by this computer's GOAT server. The key, the machine list and the SSH
 * files all live on that server; this panel only asks it to act.
 */
export function CloudMachinesSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const listed = useAtomValue(serverEnvironment.cloudMachines({ environmentId, input: {} }));
  const canChange = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const value = Option.getOrNull(AsyncResult.value(listed));
  const { id, title } = searchableSetting("cloud-machines");
  const summary =
    value === null
      ? null
      : !value.configured && value.machines.length === 0
        ? "Not set up"
        : `${value.machines.length} ${value.machines.length === 1 ? "machine" : "machines"}`;
  return (
    <FoldedSettingsSection id={id} title={title} summary={summary}>
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Create Boat machines that this computer's GOAT server can reach over SSH. Boat bills each
        machine while it runs.
      </p>
      {AsyncResult.isFailure(listed) && value === null ? (
        <p className="px-3 pb-2.5 text-xs text-destructive sm:px-4">
          Could not load cloud machines from this server.
        </p>
      ) : null}
      {value === null ? null : value.configured ? (
        <CreateMachineForm environmentId={environmentId} disabled={!canChange} />
      ) : (
        <ConnectBoatForm environmentId={environmentId} disabled={!canChange} />
      )}
      {!canChange ? (
        <p className="px-3 pb-2.5 text-xs text-muted-foreground sm:px-4">
          Changing cloud machines needs permission to change this server's settings.
        </p>
      ) : null}
      {value?.unconfirmedCreates ? (
        <UnconfirmedCreates
          environmentId={environmentId}
          count={value.unconfirmedCreates}
          disabled={!canChange}
        />
      ) : null}
      {value?.machines.map((machine) => (
        <CloudMachineRow
          key={`${environmentId}:${machine.alias}`}
          environmentId={environmentId}
          machine={machine}
          configured={value.configured}
          disabled={!canChange}
        />
      ))}
      {value?.configured ? (
        <DisconnectBoat environmentId={environmentId} disabled={!canChange} />
      ) : null}
    </FoldedSettingsSection>
  );
}

function ConnectBoatForm({
  environmentId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const configure = useAtomCommand(serverEnvironment.configureCloudMachines, {
    reportFailure: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!consent || apiKey.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await configure({
      environmentId,
      input: { apiKey: apiKey.trim(), consentToSshInclude: true },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setError(failureMessage(result, "Could not save the Boat key."));
      return;
    }
    // The key now lives only on the server.
    setApiKey("");
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-3 sm:px-4">
      <Input
        size="sm"
        type="password"
        autoComplete="off"
        aria-label="Boat API key"
        placeholder="Boat API key"
        value={apiKey}
        disabled={disabled || busy}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={consent}
          disabled={disabled || busy}
          onCheckedChange={(checked) => setConsent(checked === true)}
        />
        <span>
          Add one <code>Include ~/.ssh/goat-cloud/*.conf</code> line at the top of this computer's
          ~/.ssh/config. The rest of the file stays as it is.
        </span>
      </label>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={disabled || busy || !consent || apiKey.trim().length === 0}
          onClick={() => void save()}
        >
          {busy ? "Checking key…" : "Connect Boat"}
        </Button>
        {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function CreateMachineForm({
  environmentId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const create = useAtomCommand(serverEnvironment.createCloudMachine, { reportFailure: false });
  const [label, setLabel] = useState("");
  const [size, setSize] = useState<CloudMachineType>("small");
  const [autoStop, setAutoStop] = useState<number>(3_600);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (label.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const result = await create({
      environmentId,
      input: { label: label.trim(), type: size, ttlSeconds: autoStop },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setError(failureMessage(result, "Could not create the machine."));
      return;
    }
    setLabel("");
  };
  return (
    <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="min-w-40 flex-1"
          aria-label="Machine name"
          placeholder="Machine name"
          maxLength={120}
          value={label}
          disabled={disabled || busy}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Select
          disabled={disabled || busy}
          value={size}
          onValueChange={(next) => {
            if (next !== null) setSize(next as CloudMachineType);
          }}
        >
          <SelectTrigger size="sm" aria-label="Machine size">
            <SelectValue>
              {CLOUD_MACHINE_SIZES.find((entry) => entry.value === size)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {CLOUD_MACHINE_SIZES.map((entry) => (
              <SelectItem key={entry.value} value={entry.value}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          disabled={disabled || busy}
          value={String(autoStop)}
          onValueChange={(next) => {
            if (next !== null) setAutoStop(Number(next));
          }}
        >
          <SelectTrigger size="sm" aria-label="Auto-stop after">
            <SelectValue>Stops after {formatAutoStop(autoStop)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {CLOUD_MACHINE_AUTO_STOP_SECONDS.map((seconds) => (
              <SelectItem key={seconds} value={String(seconds)}>
                Stops after {formatAutoStop(seconds)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          disabled={disabled || busy || label.trim().length === 0}
          onClick={() => void submit()}
        >
          {busy ? "Creating…" : "Create machine"}
        </Button>
      </div>
      <p className={error === null ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
        {error ??
          "Boat bills the machine while it runs. Each use you start restarts its auto-stop time."}
      </p>
    </div>
  );
}

function CloudMachineRow({
  environmentId,
  machine,
  configured,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly machine: CloudMachine;
  readonly configured: boolean;
  readonly disabled: boolean;
}) {
  const stop = useAtomCommand(serverEnvironment.stopCloudMachine, { reportFailure: false });
  const resume = useAtomCommand(serverEnvironment.resumeCloudMachine, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteCloudMachine, { reportFailure: false });
  const forget = useAtomCommand(serverEnvironment.forgetCloudMachine, { reportFailure: false });
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [preparation, setPreparation] = useState<DesktopSshPreparationProgress | null>(null);
  const submission = useRef(0);
  useEffect(
    () => () => {
      submission.current += 1;
    },
    [],
  );
  const actions = configured
    ? cloudMachineActions(machine)
    : cloudMachineActions({ ...machine, presence: "unknown" });
  const bridge = window.desktopBridge;
  const input = { environmentId, input: { alias: machine.alias } };

  const run = async (
    label: string,
    action: () => Promise<CommandResult>,
    fallback: string,
  ): Promise<boolean> => {
    const generation = submission.current;
    setBusy(label);
    const result = await action();
    if (generation !== submission.current) return false;
    setBusy(null);
    if (result._tag !== "Failure") return true;
    if (!isAtomCommandInterrupted(result))
      toastManager.add({
        type: "error",
        title: `${machine.label}: ${fallback}`,
        description: failureMessage(result, fallback),
      });
    return false;
  };

  const connect = async () => {
    if (bridge === undefined || busy !== null) return;
    const submissionId = ++submission.current;
    // Resume waits until the machine accepts SSH and refreshes its address and host key.
    if (!(await run("Starting…", () => resume(input), "Could not start the machine"))) return;
    if (submission.current !== submissionId) return;
    setBusy("Connecting…");
    const connectMachine = async () => {
      const target = await bridge.resolveSshHost(machine.alias);
      if (submission.current !== submissionId) return;
      const result = await connectSshEnvironment({
        target,
        label: machine.label,
        onPreparationProgress: (progress) =>
          Effect.sync(() => {
            if (submission.current === submissionId)
              setPreparation(progress.phase === null ? null : progress);
          }),
      });
      if (submission.current !== submissionId) return;
      if (
        result._tag === "Failure" &&
        !isAtomCommandInterrupted(result) &&
        !isSshConnectionSuperseded(squashAtomCommandFailure(result))
      )
        toastManager.add({
          type: "error",
          title: `Could not connect ${machine.label}`,
          description: failureMessage(result, "The SSH connection failed."),
        });
    };
    await connectMachine()
      .catch((error: unknown) => {
        if (submission.current !== submissionId || isSshConnectionSuperseded(error)) return;
        toastManager.add({
          type: "error",
          title: `Could not connect ${machine.label}`,
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (submission.current !== submissionId) return;
        submission.current += 1;
        setPreparation(null);
        setBusy(null);
      });
  };

  const confirmDelete = async () => {
    const confirmed = await requestConfirmDialog(
      `Delete ${machine.label} (${machine.sandboxId}) from Boat? Its disk and snapshot are erased permanently.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await run("Deleting…", () => remove(input), "Could not delete the machine");
  };

  const confirmForget = async () => {
    const confirmed = await requestConfirmDialog(
      `Forget ${machine.label}? GOAT stops listing it but Boat keeps ${machine.sandboxId}; find or delete it in the Boat dashboard.`,
    );
    if (confirmed !== true) return;
    await run("Forgetting…", () => forget(input), "Could not forget the machine");
  };

  const locked = disabled || busy !== null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-2.5 sm:px-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{machine.label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[
            preparation?.phase
              ? sshRuntimePhaseText(preparation.phase)
              : (busy ?? cloudMachineStatus(machine)),
            machine.alias,
            `stops after ${formatAutoStop(machine.ttlSeconds)}`,
            machine.lastError,
          ]
            .filter((part): part is string => part !== null)
            .join(" · ")}
        </p>
      </div>
      {actions.connect && bridge !== undefined ? (
        <Button size="xs" variant="outline" disabled={locked} onClick={() => void connect()}>
          Connect
        </Button>
      ) : null}
      {actions.resume ? (
        <Button
          size="xs"
          variant="outline"
          disabled={locked}
          onClick={() => void run("Starting…", () => resume(input), "Could not start the machine")}
        >
          Resume
        </Button>
      ) : null}
      {actions.stop ? (
        <Button
          size="xs"
          variant="outline"
          disabled={locked}
          onClick={() => void run("Stopping…", () => stop(input), "Could not stop the machine")}
        >
          Stop
        </Button>
      ) : null}
      {actions.forget ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={locked}
          onClick={() => void confirmForget()}
        >
          Forget
        </Button>
      ) : null}
      {actions.delete ? (
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={locked}
          onClick={() => void confirmDelete()}
        >
          Delete
        </Button>
      ) : null}
    </div>
  );
}

/** Create requests whose outcome GOAT never learned; Boat may have made a machine anyway. */
function UnconfirmedCreates({
  environmentId,
  count,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly count: number;
  readonly disabled: boolean;
}) {
  const dismiss = useAtomCommand(serverEnvironment.dismissUnconfirmedCloudMachines, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const confirmDismiss = async () => {
    const confirmed = await requestConfirmDialog(
      "Stop tracking these create requests? Check the Boat dashboard first: a machine Boat made for one would keep billing without appearing here.",
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await dismiss({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success" && result.value.dismissed === 0)
      toastManager.add({
        type: "info",
        title: "Nothing dismissed yet",
        description:
          "Requests from the last day are retried by the next create. Dismiss them after a day if they stay unconfirmed.",
      });
  };
  return (
    <div className="flex items-center gap-2 px-3 pb-2.5 sm:px-4">
      <p className="flex-1 text-xs text-muted-foreground">
        GOAT could not confirm {count} create {count === 1 ? "request" : "requests"}. Check the Boat
        dashboard for a machine missing here.
      </p>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={disabled || busy}
        onClick={() => void confirmDismiss()}
      >
        Dismiss
      </Button>
    </div>
  );
}
function DisconnectBoat({
  environmentId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const disconnect = useAtomCommand(serverEnvironment.disconnectCloudMachines, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const removeKey = async () => {
    const confirmed = await requestConfirmDialog(
      "Remove the Boat key from this server? Running machines keep running and billing, and stay listed here. Connect a key again to manage them.",
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await disconnect({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      toastManager.add({
        type: "error",
        title: "Could not remove the Boat key",
        description: failureMessage(result, "Try again."),
      });
  };
  return (
    <div className="flex justify-end border-t border-border/50 px-3 py-2 sm:px-4">
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={disabled || busy}
        onClick={() => void removeKey()}
      >
        Remove Boat key
      </Button>
    </div>
  );
}
