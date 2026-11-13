import { useAtomValue } from "@effect/atom-react";
import { disposableSwitchSaveError } from "@goat/client-runtime/hub-devices";
import { isHubMachinesUnsupportedError } from "@goat/client-runtime/hub-nodes";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  DISPOSABLE_SWITCH_DAYS,
  HubMachinesError,
  ThreadId,
  type EnvironmentId,
  type HubDisposableMachinesPatch,
  type HubMachineStatus,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isMachinesError = Schema.is(HubMachinesError);
// One line of pen identity --json: {"nodeId","signPub","noisePub"}.
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ signPub: Schema.String, noisePub: Schema.String })),
);
const DAY_MS = 24 * 60 * 60 * 1000;
/** The hub's own refusal text; anything else (a dropped connection) gets the fixed fallback. */
function failureText(failure: unknown, fallback: string): string {
  return isMachinesError(failure) ? failure.detail : fallback;
}

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
  const [now, setNow] = useState(() => Date.now());
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
    setNow(Date.now());
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failureText(failure, "Could not save disposable machine settings."));
    } else if (patch.enabled !== undefined)
      setError(
        disposableSwitchSaveError(patch.enabled, result.value.hub.attachDisposableMachines.enabled),
      );
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
      setError(failureText(failure, "Could not reissue the invite."));
    } else {
      list.refresh();
      if (result.value.invite) setDialog({ kind: "invite", invite: result.value.invite });
      else setError(`No new invite was made: ${result.value.message}`);
    }
  }
  // The server keeps an expired switch on and reads it as closed; only a person renews it.
  const expired =
    settings.enabled && settings.expiresAt !== null && Date.parse(settings.expiresAt) <= now;
  const expires =
    settings.enabled && settings.expiresAt !== null
      ? ` Consent ${expired ? "ended" : "ends"} ${new Date(settings.expiresAt).toLocaleString()}.`
      : "";
  if (list.failure !== null && isHubMachinesUnsupportedError(list.failure))
    return (
      <SettingsSection title="Disposable machines">
        <SettingsRow
          title="Attach disposable machines"
          description="Update GOAT on this hub to attach disposable machines."
        />
      </SettingsSection>
    );
  return (
    <SettingsSection title="Disposable machines">
      <SettingsRow
        serverScoped
        settingKeys={["hub"]}
        title="Attach disposable machines"
        description={`The threads you name here, and you in Settings, may admit up to ${settings.cap} machines to your Pen mesh. Each one is a full Pen member and can reach every service on your machines' loopback until you remove it from Pen.${expires}`}
        control={
          <div className="flex items-center gap-2">
            {expired && (
              <Button
                size="xs"
                variant="outline"
                disabled={!available}
                onClick={() =>
                  void update({
                    expiresAt: new Date(Date.now() + DISPOSABLE_SWITCH_DAYS * DAY_MS).toISOString(),
                  })
                }
              >
                Renew for 30 days
              </Button>
            )}
            <Switch
              aria-label="Attach disposable machines"
              checked={settings.enabled}
              disabled={!available}
              onCheckedChange={(enabled) => void update({ enabled })}
            />
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["hub"]}
        title="Provisioner threads"
        description="Threads that may attach machines, by thread id."
        control={
          <div className="flex items-center gap-2">
            <Input
              aria-label="Thread ID"
              size="sm"
              className="w-56"
              value={thread}
              onChange={(event) => setThread(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
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
        }
      >
        {settings.provisioners.length > 0 && (
          <ul className="space-y-1 pb-2 text-muted-foreground text-xs">
            {settings.provisioners.map((id) => (
              <li key={id} className="flex items-center gap-2">
                <span className="font-mono">{id}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${id}`}
                  disabled={!available}
                  onClick={() =>
                    void update({
                      provisioners: settings.provisioners.filter((value) => value !== id),
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["hub"]}
        title="Machine cap"
        description="How many disposable machines may hold a place in Pen at once."
        control={
          <div className="flex items-center gap-2">
            <Input
              aria-label="Machine cap"
              size="sm"
              className="w-20"
              type="number"
              min={1}
              max={100}
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={
                !available ||
                !Number.isInteger(Number(cap)) ||
                Number(cap) < 1 ||
                Number(cap) > 100 ||
                Number(cap) === settings.cap
              }
              onClick={() => void update({ cap: Number(cap) })}
            >
              Save cap
            </Button>
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["hub"]}
        title="Name rule"
        description="Names machines may take: letters, digits, - _ ., classes such as [a-z0-9-] and counts such as {0,30}."
        control={
          <div className="flex items-center gap-2">
            <Input
              aria-label="Name rule"
              size="sm"
              className="w-56"
              value={rule}
              onChange={(event) => setRule(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={!available || rule === settings.nameRule}
              onClick={() => void update({ nameRule: rule })}
            >
              Save rule
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Machines"
        description="Every machine attached this way, with who vouched for it and whether its key is still in Pen."
        control={
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={list.refresh}>
              Refresh machines
            </Button>
            <Button
              size="xs"
              disabled={!canAttach || busy || !hub.enabled || !settings.enabled || expired}
              onClick={() => setDialog({ kind: "attach" })}
            >
              Attach a machine
            </Button>
          </div>
        }
      >
        {(error || list.error) && (
          <p role="alert" className="pb-2 text-destructive text-xs">
            {error ?? list.error}
          </p>
        )}
        {(list.data?.machines.length ?? 0) > 0 && (
          <ul aria-label="Disposable machines" className="space-y-1 pb-2 text-xs">
            {list.data?.machines.map((machine) => (
              <li key={machine.attachId} className="flex items-center gap-2">
                <span className="font-medium">{machine.name}</span>
                <span className="text-muted-foreground">
                  {machine.message} ·{" "}
                  {machine.provisioner.kind === "person"
                    ? "a person"
                    : `thread ${machine.provisioner.threadId}`}
                  {machine.penMember ? " · Still in Pen" : ""}
                </span>
                {machine.state === "invited" && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Reissue ${machine.name}`}
                    disabled={!canReissue || busy || !hub.enabled}
                    onClick={() => void reissueInvite(machine.attachId)}
                  >
                    Reissue
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
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
  const [copyError, setCopyError] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ onError: () => setCopyError(true) });
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
      setError(failureText(failure, "Could not attach the machine."));
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
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach a machine</DialogTitle>
          <DialogDescription>
            {invite
              ? "This invite token is a secret. Copy it now; GOAT shows it only once."
              : "Use the keys pen identity --json prints on the machine."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {invite ? (
            <div className="space-y-2">
              <Textarea
                readOnly
                aria-label="Invite token"
                value={invite.token}
                rows={3}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p className="text-muted-foreground text-xs">
                Expires {new Date(invite.expiresAt).toLocaleString()}.
              </p>
              {copyError && (
                <p role="alert" className="text-destructive text-xs">
                  Could not copy. Select the token and copy it yourself.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="disposable-identity">Output of pen identity --json</Label>
                <Textarea
                  id="disposable-identity"
                  rows={2}
                  placeholder='{"nodeId":"…","signPub":"…","noisePub":"…"}'
                  onChange={(event) => {
                    const keys = decodeIdentity(event.target.value.trim());
                    if (keys._tag === "Some") {
                      setSignPub(keys.value.signPub);
                      setNoisePub(keys.value.noisePub);
                    }
                  }}
                />
                <p className="text-muted-foreground text-xs">
                  Paste the line it prints on the machine to fill both keys.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="disposable-name">Machine name</Label>
                <Input
                  id="disposable-name"
                  placeholder="cc-1"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="disposable-sign">Signing public key</Label>
                <Input
                  id="disposable-sign"
                  placeholder="signPub"
                  value={signPub}
                  onChange={(event) => setSignPub(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="disposable-noise">Noise public key</Label>
                <Input
                  id="disposable-noise"
                  placeholder="noisePub"
                  value={noisePub}
                  onChange={(event) => setNoisePub(event.target.value)}
                />
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {invite ? (
            <Button
              onClick={() => {
                setCopyError(false);
                copyToClipboard(invite.token);
              }}
            >
              {isCopied ? "Copied" : "Copy token"}
            </Button>
          ) : (
            <Button
              disabled={!canAttach || busy || !name || !signPub || !noisePub}
              onClick={() => void submit()}
            >
              Create invite
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
