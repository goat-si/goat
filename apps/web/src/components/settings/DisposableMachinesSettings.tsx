import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  ThreadId,
  type EnvironmentId,
  type HubDisposableMachinesPatch,
  type HubMachineStatus,
} from "@goat/contracts";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DisposableMachinesSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const hub = useEnvironmentSettings(environmentId, (settings) => settings.hub);
  const settings = hub.attachDisposableMachines;
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canAttach = useAtomValue(serverEnvironment.hubMachinesAttach.permissionAtom(environmentId));
  const canReissue = useAtomValue(
    serverEnvironment.hubMachinesReissue.permissionAtom(environmentId),
  );
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const reissue = useAtomCommand(serverEnvironment.hubMachinesReissue, { reportFailure: false });
  const list = useEnvironmentQuery(serverEnvironment.hubMachinesList({ environmentId, input: {} }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState("");
  const [cap, setCap] = useState(String(settings.cap));
  const [rule, setRule] = useState(settings.nameRule);
  const [dialog, setDialog] = useState<
    { kind: "attach" } | { kind: "invite"; invite: NonNullable<HubMachineStatus["invite"]> } | null
  >(null);
  const available = canSave && hub.enabled && !busy;
  async function update(patch: HubDisposableMachinesPatch) {
    setBusy(true);
    setError(null);
    const result = await save({
      environmentId,
      input: { patch: { hub: { attachDisposableMachines: patch } } },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : "Could not save disposable machine settings.",
      );
    }
  }
  async function reissueInvite(attachId: string) {
    setBusy(true);
    setError(null);
    const result = await reissue({
      environmentId,
      input: { attachId, clientRequestId: randomUUID() },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not reissue the invite.");
    } else {
      list.refresh();
      if (result.value.invite) setDialog({ kind: "invite", invite: result.value.invite });
      else setError("The invite was not returned. Reissue it again if needed.");
    }
  }
  return (
    <SettingsSection title="Attach disposable machines">
      <SettingsRow
        title="Attach disposable machines"
        description={`The threads you name here, and you in Settings, may admit up to ${settings.cap} machines to your Pen mesh. Each one is a full Pen member and can reach every service on your machines' loopback until you remove it from Pen.`}
        control={
          <Switch
            aria-label="Attach disposable machines"
            checked={settings.enabled}
            disabled={!available}
            onCheckedChange={(enabled) => void update({ enabled })}
          />
        }
      />
      <div className="space-y-3 p-4">
        <p>Consent expires: {settings.expiresAt ?? "Not set"}</p>
        <div>
          <strong>Provisioner thread IDs</strong>
          <ul>
            {settings.provisioners.map((id) => (
              <li key={id}>
                {id}{" "}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!available}
                  onClick={() =>
                    void update({
                      provisioners: settings.provisioners.filter((value) => value !== id),
                    })
                  }
                >
                  Remove {id}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex gap-2">
          <Input
            aria-label="Thread ID"
            value={thread}
            onChange={(event) => setThread(event.target.value)}
          />
          <Button
            size="xs"
            disabled={
              !available ||
              !thread.trim() ||
              settings.provisioners.some((id) => id === thread.trim()) ||
              settings.provisioners.length >= 32
            }
            onClick={() => {
              const id = ThreadId.make(thread.trim());
              void update({ provisioners: [...settings.provisioners, id] });
              setThread("");
            }}
          >
            Add thread
          </Button>
        </div>
        <div className="flex gap-2">
          <label>
            Machine cap{" "}
            <Input
              aria-label="Machine cap"
              type="number"
              min={1}
              max={100}
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
          </label>
          <Button
            size="xs"
            disabled={
              !available || !Number.isInteger(Number(cap)) || Number(cap) < 1 || Number(cap) > 100
            }
            onClick={() => void update({ cap: Number(cap) })}
          >
            Save cap
          </Button>
        </div>
        <div className="flex gap-2">
          <label>
            Name rule{" "}
            <Input
              aria-label="Name rule"
              value={rule}
              onChange={(event) => setRule(event.target.value)}
            />
          </label>
          <Button size="xs" disabled={!available} onClick={() => void update({ nameRule: rule })}>
            Save rule
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
        {list.error && <p role="alert">{list.error}</p>}
        <Button size="xs" variant="outline" onClick={list.refresh}>
          Refresh machines
        </Button>
        <ul aria-label="Disposable machines">
          {list.data?.machines.map((machine) => (
            <li key={machine.attachId}>
              <strong>{machine.name}</strong> · {machine.state} · {machine.message} ·{" "}
              {machine.provisioner.kind === "person"
                ? "Person"
                : `Thread ${machine.provisioner.threadId}`}
              {machine.penMember ? " · Still in Pen" : ""}
              {machine.state === "invited" && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canReissue || busy || !hub.enabled}
                  onClick={() => void reissueInvite(machine.attachId)}
                >
                  Reissue {machine.name}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <Button
          disabled={!canAttach || busy || !hub.enabled || !settings.enabled}
          onClick={() => setDialog({ kind: "attach" })}
        >
          Attach a machine
        </Button>
      </div>
      {dialog && (
        <AttachDialog
          environmentId={environmentId}
          initialInvite={dialog.kind === "invite" ? dialog.invite : null}
          onClose={() => setDialog(null)}
          onAttached={list.refresh}
        />
      )}
    </SettingsSection>
  );
}

function AttachDialog({
  environmentId,
  initialInvite,
  onClose,
  onAttached,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialInvite: NonNullable<HubMachineStatus["invite"]> | null;
  readonly onClose: () => void;
  readonly onAttached: () => void;
}) {
  const attach = useAtomCommand(serverEnvironment.hubMachinesAttach, { reportFailure: false });
  const canAttach = useAtomValue(serverEnvironment.hubMachinesAttach.permissionAtom(environmentId));
  const [invite, setInvite] = useState(initialInvite);
  const [name, setName] = useState("");
  const [signPub, setSignPub] = useState("");
  const [noisePub, setNoisePub] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    const result = await attach({
      environmentId,
      input: { name, signPub, noisePub, clientRequestId: randomUUID() },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not attach the machine.");
    } else {
      onAttached();
      if (result.value.invite) setInvite(result.value.invite);
      else setError("The invite was not returned. Reissue it from the machine list.");
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogTitle>Attach a machine</DialogTitle>
        <DialogDescription>Use the keys from pen identity --json on the machine.</DialogDescription>
        {invite ? (
          <div>
            <p>This invite token is a secret. Copy it now; it is shown only once.</p>
            <p>Expires: {invite.expiresAt}</p>
            <code>{invite.token}</code>
            <Button onClick={() => void navigator.clipboard.writeText(invite.token)}>
              Copy token
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Input
              aria-label="Machine name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              aria-label="Signing public key"
              value={signPub}
              onChange={(event) => setSignPub(event.target.value)}
            />
            <Input
              aria-label="Noise public key"
              value={noisePub}
              onChange={(event) => setNoisePub(event.target.value)}
            />
            <Button
              disabled={!canAttach || busy || !name || !signPub || !noisePub}
              onClick={() => void submit()}
            >
              Create invite
            </Button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogPopup>
    </Dialog>
  );
}
