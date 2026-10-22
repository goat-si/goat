import { useRef, useState } from "react";

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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { profileLabel, type OpenCodexSituation } from "./firstRunPrompts.logic";

const devices = (count: number) => (count === 1 ? "1 device" : `${count} devices`);

function openCodexDescription(hostLabel: string, situation: OpenCodexSituation): string {
  switch (situation.kind) {
    case "home":
      return `OpenCodex on ${hostLabel} is the Home for ${devices(situation.devices)}. Connect Codex here and its runs use the Home's account pool instead of a single sign-in.`;
    case "linked":
      return `OpenCodex on ${hostLabel} is linked to ${situation.homeName ? `the Home on ${situation.homeName}` : "your Home"}. Connect Codex here and its runs use the Home's accounts instead of this machine's own sign-in.`;
    case "unlinked":
      return `OpenCodex is installed on ${hostLabel} but not linked to a Home yet. Connect Codex to it now and link ${hostLabel} from your Home later, or keep running standalone.`;
  }
}

/** Closing without a choice is "later": the question is not asked again. */
export function OpenCodexFirstRunDialog({
  hostLabel,
  situation,
  onClose,
}: {
  hostLabel: string;
  situation: OpenCodexSituation;
  onClose: (outcome: "connect" | "standalone" | "later") => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose("later")}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Connect Codex to OpenCodex?</DialogTitle>
          <DialogDescription>{openCodexDescription(hostLabel, situation)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            Connect opens Codex's settings, where you confirm the switch. Standalone keeps Codex's
            own sign-in. Change either later in Settings → Providers → Codex.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onClose("standalone")}>
            Run standalone
          </Button>
          <Button onClick={() => onClose("connect")}>Connect</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export interface GoatclawChoice {
  readonly hub: boolean;
  readonly profiles: boolean;
  readonly defaultProfile: string;
}

/**
 * Both switches start off, as the settings do. Closing without a choice is "later"; Keep off
 * answers the question without changing anything.
 */
export function GoatclawFirstRunDialog({
  hostLabel,
  situation,
  profileIds,
  defaultProfile,
  onTurnOn,
  onClose,
}: {
  hostLabel: string;
  situation: Exclude<OpenCodexSituation, { kind: "linked" }>;
  profileIds: ReadonlyArray<string>;
  defaultProfile: string;
  /** Resolves to an error message when the settings could not be saved. */
  onTurnOn: (choice: GoatclawChoice) => Promise<string | null>;
  onClose: (outcome: "answered" | "later") => void;
}) {
  const [hub, setHub] = useState(false);
  const [profiles, setProfiles] = useState(false);
  const [profile, setProfile] = useState(defaultProfile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const turnOn = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    const failure = await onTurnOn({ hub, profiles, defaultProfile: profile });
    inFlight.current = false;
    setSaving(false);
    if (failure === null) onClose("answered");
    else setError(failure);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !inFlight.current && onClose("later")}>
      <DialogPopup showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Run goatclaw on {hostLabel}?</DialogTitle>
          <DialogDescription>
            {situation.kind === "home"
              ? `${hostLabel.charAt(0).toUpperCase()}${hostLabel.slice(1)} is the OpenCodex Home for ${devices(situation.devices)}. goatclaw can run it as their hub`
              : `goatclaw can make ${hostLabel} the hub for your devices`}{" "}
            and let agents launch work under a permission profile. Both stay off until you turn them
            on.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <ChoiceRow
              title="This machine is the hub"
              description="Checks each linked device's setup and holds cloud runs."
              checked={hub}
              disabled={saving}
              onCheckedChange={setHub}
            />
            <ChoiceRow
              title="Permission profiles"
              description="Agents can launch, merge or change settings only as far as their profile allows. Agents without one get the default."
              checked={profiles}
              disabled={saving}
              onCheckedChange={setProfiles}
            />
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">Default profile</span>
              <div className="w-40 shrink-0">
                <Select
                  value={profile}
                  disabled={saving || !profiles}
                  onValueChange={(value) => {
                    if (typeof value === "string") setProfile(value);
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Default profile">
                    <SelectValue>{(value: string) => profileLabel(value)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {profileIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {profileLabel(id)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Change these any time in Settings → Hub.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => onClose("answered")}>
            Keep off
          </Button>
          <Button disabled={saving || (!hub && !profiles)} onClick={() => void turnOn()}>
            Turn on
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ChoiceRow(props: {
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{props.title}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Switch
        aria-label={props.title}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
    </div>
  );
}
