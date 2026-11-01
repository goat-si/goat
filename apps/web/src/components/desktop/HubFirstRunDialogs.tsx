import { useRef, useState } from "react";

import { LaptopIcon, MonitorIcon, ServerIcon, ShieldCheckIcon } from "~/components/solar";
import { OpenAI } from "../Icons";
import {
  OnboardingBody,
  OnboardingFooter,
  OnboardingHeader,
  OnboardingOption,
  OnboardingOptions,
  OnboardingPopup,
} from "../onboarding/OnboardingDialog";
import { OnboardingLink, type OnboardingNode } from "../onboarding/OnboardingLink";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { profileLabel, type OpenCodexSituation } from "./firstRunPrompts.logic";

const devices = (count: number) => (count === 1 ? "1 device" : `${count} devices`);
const capitalize = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
const hostNode = (hostLabel: string, detail?: string): OnboardingNode => ({
  id: "host",
  icon: <LaptopIcon />,
  label: capitalize(hostLabel),
  detail,
});

function openCodexDescription(hostLabel: string, situation: OpenCodexSituation): string {
  switch (situation.kind) {
    case "home":
      return `OpenCodex on ${hostLabel} is the Home for ${devices(situation.devices)}. Codex runs here can draw on its account pool instead of one sign-in.`;
    case "linked":
      return `OpenCodex on ${hostLabel} is linked to ${situation.homeName ? `the Home on ${situation.homeName}` : "your Home"}. Codex runs here can use the Home's accounts instead of this machine's own sign-in.`;
    case "unlinked":
      return `OpenCodex is on ${hostLabel} but not linked to a Home yet. Connect Codex now and link ${hostLabel} from your Home later.`;
  }
}

function openCodexNodes(hostLabel: string, situation: OpenCodexSituation): OnboardingNode[] {
  const codex: OnboardingNode = { id: "codex", icon: <OpenAI />, label: "Codex" };
  switch (situation.kind) {
    case "home":
      return [
        codex,
        hostNode(hostLabel, "Home"),
        { id: "devices", icon: <MonitorIcon />, label: devices(situation.devices), later: true },
      ];
    case "linked":
      return [
        codex,
        hostNode(hostLabel),
        { id: "home", icon: <ServerIcon />, label: situation.homeName ?? "Home", detail: "Home" },
      ];
    case "unlinked":
      return [codex, hostNode(hostLabel, "Not linked")];
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
      <OnboardingPopup>
        <OnboardingHeader
          host={hostLabel}
          art={<OnboardingLink nodes={openCodexNodes(hostLabel, situation)} />}
          title="Connect Codex to OpenCodex?"
          description={openCodexDescription(hostLabel, situation)}
        />
        <OnboardingFooter hint="Connect opens Settings → Providers to confirm.">
          <Button variant="ghost" onClick={() => onClose("standalone")}>
            Run standalone
          </Button>
          <Button onClick={() => onClose("connect")}>Connect Codex</Button>
        </OnboardingFooter>
      </OnboardingPopup>
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
      <OnboardingPopup showCloseButton={!saving}>
        <OnboardingHeader
          host={hostLabel}
          art={
            <OnboardingLink
              nodes={[
                { id: "agents", icon: <ShieldCheckIcon />, label: "Agents", detail: "Profiles" },
                hostNode(hostLabel, "Hub"),
                {
                  id: "devices",
                  icon: <MonitorIcon />,
                  label: situation.kind === "home" ? devices(situation.devices) : "Your devices",
                },
              ]}
            />
          }
          title={`Run goatclaw on ${hostLabel}?`}
          description={
            situation.kind === "home"
              ? `${capitalize(hostLabel)} is the OpenCodex Home for ${devices(situation.devices)}. goatclaw can run it as their hub and let agents work within a permission profile.`
              : `goatclaw can make ${hostLabel} the hub for your devices and let agents work within a permission profile.`
          }
        />
        <OnboardingBody>
          <OnboardingOptions label="goatclaw">
            <OnboardingOption
              title="This machine is the hub"
              description="Checks each linked device's setup and holds cloud runs."
              control={
                <Switch
                  aria-label="This machine is the hub"
                  checked={hub}
                  disabled={saving}
                  onCheckedChange={setHub}
                />
              }
            />
            <OnboardingOption
              title="Permission profiles"
              description="Agents launch, merge or change settings only as far as their profile allows."
              control={
                <Switch
                  aria-label="Permission profiles"
                  checked={profiles}
                  disabled={saving}
                  onCheckedChange={setProfiles}
                />
              }
            />
            <OnboardingOption
              title="Default profile"
              description="For agents without a profile of their own."
              control={
                <div className="w-36">
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
              }
            />
          </OnboardingOptions>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </OnboardingBody>
        <OnboardingFooter hint="Change these any time in Settings → Hub.">
          <Button variant="ghost" disabled={saving} onClick={() => onClose("answered")}>
            Keep off
          </Button>
          <Button disabled={saving || (!hub && !profiles)} onClick={() => void turnOn()}>
            Turn on
          </Button>
        </OnboardingFooter>
      </OnboardingPopup>
    </Dialog>
  );
}
