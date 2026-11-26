import { msg, useGT, useLocale, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import {
  disposableConsentEnded,
  disposableSwitchSaveError,
} from "@goat/client-runtime/hub-devices";
import { isHubMachinesUnsupportedError } from "@goat/client-runtime/hub-nodes";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
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
import { useTranslatedSearchableSetting } from "./useTranslatedSearchableSetting";

const isMachinesError = Schema.is(HubMachinesError);
// One line of pen identity --json: {"nodeId","signPub","noisePub"}.
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ signPub: Schema.String, noisePub: Schema.String })),
);
const RENEW_AT = "9999-12-31T00:00:00.000Z";
/** The hub's own refusal text; anything else (a dropped connection) gets the fixed fallback. */
function failureText(failure: unknown, fallback: string): string {
  return isMachinesError(failure) ? failure.detail : fallback;
}

export function DisposableMachinesSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const setting = useTranslatedSearchableSetting();
  const hub = useEnvironmentSettings(environmentId, (settings) => settings.hub);
  const settings = hub.attachDisposableMachines;
  const canSave = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const canAttach = useAtomValue(serverEnvironment.hubMachinesAttach.permissionAtom(environmentId));
  const canReissue = useAtomValue(
    serverEnvironment.hubMachinesReissue.permissionAtom(environmentId),
  );
  const canDetach = useAtomValue(serverEnvironment.hubMachinesDetach.permissionAtom(environmentId));
  const canRelease = useAtomValue(
    serverEnvironment.hubMachinesRelease.permissionAtom(environmentId),
  );
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const detachMachine = useAtomCommand(serverEnvironment.hubMachinesDetach, {
    reportFailure: false,
  });
  const releaseMachine = useAtomCommand(serverEnvironment.hubMachinesRelease, {
    reportFailure: false,
  });
  // A detach, a forced one and a release cannot be undone, so each asks once more on the row.
  const [confirming, setConfirming] = useState<string | null>(null);
  const reissue = useAtomCommand(serverEnvironment.hubMachinesReissue, { reportFailure: false });
  const list = useEnvironmentQuery(serverEnvironment.hubMachinesList({ environmentId, input: {} }));
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [keyCopiedFor, setKeyCopiedFor] = useState<string | null>(null);
  const rowKey = useCopyToClipboard({
    onError: () => setError(gt(gt("Could not copy. Select the machine key and copy it yourself."))),
  });
  const [thread, setThread] = useState("");
  const [cap, setCap] = useState(String(settings.cap));
  const [rule, setRule] = useState(settings.nameRule);
  const [dialog, setDialog] = useState<
    { kind: "attach" } | { kind: "invite"; invite: Invite } | null
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
      setError(failureText(failure, gt("Could not save disposable machine settings.")));
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
      setError(failureText(failure, gt("Could not reissue the invite.")));
    } else {
      list.refresh();
      const minted = inviteOf(result.value);
      if (minted) setDialog({ kind: "invite", invite: minted });
      else setError(gt("No new invite was made: {reason}", { reason: result.value.message }));
    }
  }
  async function endMachine(action: MachineAction, attachId: string) {
    setConfirming(null);
    setBusy(true);
    setError(null);
    const input = { attachId, clientRequestId: randomUUID() };
    const result =
      action === "release"
        ? await releaseMachine({ environmentId, input })
        : await detachMachine({
            environmentId,
            input: action === "force" ? { ...input, force: true } : input,
          });
    setBusy(false);
    list.refresh();
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        isHubMachinesUnsupportedError(failure)
          ? gt("Update GOAT on this hub to detach or release machines.")
          : failureText(failure, m(ACTION_FAILED[action])),
      );
    }
  }
  // The hub keeps an ended consent switched on and reads it as closed; only a person renews it.
  const expired = disposableConsentEnded(settings, now);
  const expires = !settings.enabled
    ? ""
    : settings.expiresAt === null
      ? gt("Consent has ended.")
      : expired
        ? gt("Consent ended {time}.", { time: new Date(settings.expiresAt).toLocaleString(locale) })
        : gt("Consent ends {time}.", { time: new Date(settings.expiresAt).toLocaleString(locale) });
  if (list.failure !== null && isHubMachinesUnsupportedError(list.failure))
    return (
      <SettingsSection title={gt("Disposable machines")}>
        <SettingsRow
          {...setting("hub-disposable-machines")}
          description={gt("Update GOAT on this hub to attach disposable machines.")}
        />
      </SettingsSection>
    );
  return (
    <SettingsSection title={gt("Disposable machines")}>
      <SettingsRow
        serverScoped
        settingKeys={["hub"]}
        {...setting("hub-disposable-machines")}
        description={[
          gt(
            "The threads you name here, and you in Settings, may admit up to {cap} machines to your Pen mesh. Each one is a full Pen member and can reach every service on your machines' loopback until you remove it from Pen.",
            { cap: settings.cap },
          ),
          expires,
        ]
          .filter(Boolean)
          .join(" ")}
        control={
          <div className="flex items-center gap-2">
            {expired && (
              <Button
                size="xs"
                variant="outline"
                disabled={!available}
                onClick={() =>
                  // The hub holds any expiry to 30 days past its own clock, so a slow clock here
                  // cannot send a date that is already past.
                  void update({ expiresAt: RENEW_AT })
                }
              >
                {gt("Renew for 30 days")}
              </Button>
            )}
            <Switch
              aria-label={gt("Attach disposable machines")}
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
        title={gt("Provisioner threads")}
        description={gt(
          "Threads that may attach machines, by thread ID (Copy → Thread ID in a thread's menu). Changing the threads, cap or name rule cancels invites not yet used.",
        )}
        control={
          <div className="flex items-center gap-2">
            <Input
              aria-label={gt("Thread ID")}
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
              {gt("Add thread")}
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
                  aria-label={gt("Remove {name}", { name: id })}
                  disabled={!available}
                  onClick={() =>
                    void update({
                      provisioners: settings.provisioners.filter((value) => value !== id),
                    })
                  }
                >
                  {gt("Remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsRow>
      <SettingsRow
        serverScoped
        settingKeys={["hub"]}
        title={gt("Machine cap")}
        description={gt("How many disposable machines may hold a place in Pen at once.")}
        control={
          <div className="flex items-center gap-2">
            <Input
              aria-label={gt("Machine cap")}
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
              {gt("Save cap")}
            </Button>
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["hub"]}
        title={gt("Name rule")}
        description={gt(
          "Names machines may take: letters, digits, - _ ., classes such as {characters} and counts such as {range}.",
          { characters: "[a-z0-9-]", range: "{0,30}" },
        )}
        control={
          <div className="flex items-center gap-2">
            <Input
              aria-label={gt("Name rule")}
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
              {gt("Save rule")}
            </Button>
          </div>
        }
      />
      <SettingsRow
        title={gt("Machines")}
        description={gt(
          "Every machine attached this way, with who vouched for it and whether its key is still in Pen.",
        )}
        control={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setNow(Date.now());
                list.refresh();
              }}
            >
              {gt("Refresh machines")}
            </Button>
            <Button
              size="xs"
              disabled={!canAttach || busy || !hub.enabled || !settings.enabled || expired}
              onClick={() => {
                const at = Date.now();
                setNow(at);
                if (!disposableConsentEnded(settings, at)) setDialog({ kind: "attach" });
              }}
            >
              {gt("Attach a machine")}
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
          <ul aria-label={gt("Disposable machines")} className="space-y-1 pb-2 text-xs">
            {list.data?.machines.map((machine) => (
              <li key={machine.attachId} className="flex items-center gap-2">
                <span className="shrink-0 font-medium">{machine.name}</span>
                <span className="flex-1 text-muted-foreground">
                  {machine.message} ·{" "}
                  {machine.provisioner.kind === "person"
                    ? gt("a person")
                    : gt("thread {id}", { id: machine.provisioner.threadId })}
                  {machine.penMember && <> · {gt("Still in Pen")}</>}
                </span>
                {waitsForKey(machine) && machine.machineKey && (
                  <>
                    <code className="max-w-48 truncate text-muted-foreground">
                      {machine.machineKey}
                    </code>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={gt("Copy the machine key for {name}", { name: machine.name })}
                      onClick={() => {
                        setError(null);
                        setKeyCopiedFor(machine.attachId);
                        rowKey.copyToClipboard(machine.machineKey ?? "");
                      }}
                    >
                      {rowKey.isCopied && keyCopiedFor === machine.attachId
                        ? gt("Copied")
                        : gt("Copy machine key")}
                    </Button>
                  </>
                )}
                {actionsOf(machine).map((action) => {
                  const key = machine.attachId + ":" + action;
                  const label = m(ACTION_LABEL[action]);
                  return (
                    <span key={action} className="flex items-center gap-1">
                      {confirming === key && (
                        <span className="max-w-80 text-muted-foreground">
                          {m(effectOf(action, machine.penMember))}
                        </span>
                      )}
                      <Button
                        size="xs"
                        variant={confirming === key ? "destructive" : "ghost"}
                        aria-label={
                          confirming === key
                            ? gt("Confirm {action} {machine}", {
                                action: label.toLocaleLowerCase(locale),
                                machine: machine.name,
                              })
                            : gt("{action} {machine}", { action: label, machine: machine.name })
                        }
                        disabled={(action === "release" ? !canRelease : !canDetach) || busy}
                        onClick={() =>
                          confirming === key
                            ? void endMachine(action, machine.attachId)
                            : setConfirming(key)
                        }
                      >
                        {confirming === key ? gt("Confirm") : label}
                      </Button>
                    </span>
                  );
                })}
                {machine.state === "invited" && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={gt("Reissue {name}", { name: machine.name })}
                    disabled={!canReissue || busy || !hub.enabled}
                    onClick={() => void reissueInvite(machine.attachId)}
                  >
                    {gt("Reissue")}
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

type MachineAction = "detach" | "force" | "release";
const ACTION_LABEL: Record<MachineAction, string> = {
  detach: msg("Detach"),
  force: msg("Force detach"),
  release: msg("Release"),
};
const ACTION_FAILED: Record<MachineAction, string> = {
  detach: msg("Could not detach the machine."),
  force: msg("Could not force the detach."),
  release: msg("Could not release the attach."),
};
/** What confirming does; out of Pen, the open record holds the slot until the detach ends. */
const effectOf = (action: MachineAction, penMember: boolean) => {
  if (action === "release")
    return msg("Frees the slot once Pen's member list shows the machine did not join.");
  if (action === "detach")
    return penMember
      ? msg(
          "GOAT removes its OpenCodex link and the lightweight Child; it stays in Pen and keeps its slot until pen revoke.",
        )
      : msg(
          "GOAT removes its OpenCodex link and the lightweight Child; it has left Pen; its slot is free once the detach ends.",
        );
  return penMember
    ? msg(
        "GOAT removes the link without the machine and cleans the machine once it answers; it stays in Pen and keeps its slot until pen revoke.",
      )
    : msg(
        "GOAT removes the link without the machine; it has left Pen, so its slot is free once the detach ends, which after a forced removal waits for a person to forget its cleanup on the hub.",
      );
};
const REMOVABLE = new Set(["linked", "detaching", "retired"]);
const DETACHABLE = new Set([
  "admitted",
  "attaching",
  "linked",
  "paused",
  "unknown",
  "retired",
  "returned",
]);
/** What a person may end on this row: detach an admitted machine, force one detaching, or free a slot Pen cannot account for. */
const actionsOf = (machine: HubMachineStatus): ReadonlyArray<MachineAction> => {
  // A changed host key blocks every step the machine takes part in; only a force goes on without it.
  if (machine.class === "conflict" && REMOVABLE.has(machine.state)) return ["force"];
  if (machine.class !== "disposable") return [];
  // Detach again clears a stop; force removes the link without the machine.
  if (machine.state === "detaching") return ["detach", "force"];
  // A retired record's pending removal is repeated by a detach, in Pen or out of it.
  if (machine.state === "retired") return ["detach"];
  if (machine.penMember && DETACHABLE.has(machine.state)) return ["detach"];
  if (!machine.penMember && machine.state === "unknown") return ["release"];
  return [];
};

/** A machine GOAT cannot reach yet: the person still has to add the hub's key to it. */
const waitsForKey = (machine: HubMachineStatus) =>
  machine.state === "admitted" || (machine.state === "attaching" && machine.step === "reach");

/** A token shown once, with the hub key the machine must trust. */
type Invite = NonNullable<HubMachineStatus["invite"]> & { readonly machineKey?: string };
const inviteOf = (status: HubMachineStatus): Invite | null =>
  status.invite === undefined
    ? null
    : {
        ...status.invite,
        ...(status.machineKey === undefined ? {} : { machineKey: status.machineKey }),
      };

function AttachDialog({
  environmentId,
  initialInvite,
  onClose,
  onAttached,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialInvite: Invite | null;
  readonly onClose: () => void;
  readonly onAttached: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const attach = useAtomCommand(serverEnvironment.hubMachinesAttach, { reportFailure: false });
  const canAttach = useAtomValue(serverEnvironment.hubMachinesAttach.permissionAtom(environmentId));
  const [invite, setInvite] = useState(initialInvite);
  const [copyError, setCopyError] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ onError: () => setCopyError(true) });
  const copyKey = useCopyToClipboard({ onError: () => setCopyError(true) });
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
      setError(failureText(failure, gt("Could not attach the machine.")));
    } else {
      onAttached();
      const minted = inviteOf(result.value);
      if (minted) setInvite(minted);
      else
        setError(
          gt("No usable invite was returned: {reason} Create a new invite to try again.", {
            reason: result.value.message,
          }),
        );
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
          <DialogTitle>{gt("Attach a machine")}</DialogTitle>
          <DialogDescription>
            {invite
              ? gt("This invite token is a secret. Copy it now; GOAT shows it only once.")
              : gt("Use the keys pen identity --json prints on the machine.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {invite ? (
            <div className="space-y-2">
              <Textarea
                readOnly
                aria-label={gt("Invite token")}
                value={invite.token}
                rows={3}
                onFocus={(event) => event.currentTarget.select()}
              />
              <p className="text-muted-foreground text-xs">
                {gt("Expires {time}.", { time: new Date(invite.expiresAt).toLocaleString(locale) })}
              </p>
              {invite.machineKey && (
                <div className="space-y-1">
                  <Label htmlFor="disposable-machine-key">{gt("Machine key")}</Label>
                  <Textarea
                    id="disposable-machine-key"
                    readOnly
                    value={invite.machineKey}
                    rows={2}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <p className="text-muted-foreground text-xs">
                    {gt(
                      "Add this line to authorized_keys of the machine's SSH user. After the machine joins Pen, this hub reaches it with this key alone, and links it to OpenCodex once this hub's OpenCodex can use the key.",
                    )}
                  </p>
                </div>
              )}
              {copyError && (
                <p role="alert" className="text-destructive text-xs">
                  {gt("Could not copy. Select the text and copy it yourself.")}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="disposable-identity">{gt("Output of pen identity --json")}</Label>
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
                  {gt("Paste the line it prints on the machine to fill both keys.")}
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="disposable-name">{gt("Machine name")}</Label>
                <Input
                  id="disposable-name"
                  placeholder="cc-1"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="disposable-sign">{gt("Signing public key")}</Label>
                <Input
                  id="disposable-sign"
                  placeholder="signPub"
                  value={signPub}
                  onChange={(event) => setSignPub(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="disposable-noise">{gt("Noise public key")}</Label>
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
            {gt("Close")}
          </Button>
          {invite?.machineKey && (
            <Button
              variant="outline"
              onClick={() => {
                setCopyError(false);
                if (invite.machineKey) copyKey.copyToClipboard(invite.machineKey);
              }}
            >
              {copyKey.isCopied ? gt("Copied") : gt("Copy machine key")}
            </Button>
          )}
          {invite ? (
            <Button
              onClick={() => {
                setCopyError(false);
                copyToClipboard(invite.token);
              }}
            >
              {isCopied ? gt("Copied") : gt("Copy token")}
            </Button>
          ) : (
            <Button
              disabled={!canAttach || busy || !name || !signPub || !noisePub}
              onClick={() => void submit()}
            >
              {gt("Create invite")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
