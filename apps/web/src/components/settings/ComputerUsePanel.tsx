import { computerUseReadinessSteps } from "@goat/client-runtime/computerUse/readinessSteps";
import { BUILTIN_SKILLS, type CuaHostStatus } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { ChevronRightIcon } from "~/components/solar";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { ComputerUseReadiness } from "../computerUse/ComputerUseReadiness";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Switch } from "../ui/switch";
import { CuaGrantTroubleshooting } from "./CuaGrantSteps";
import {
  computerUseStatusText,
  computerUseUnavailable,
  cuaGrantTitle,
  cuaHostRequirements,
  withLiveGrants,
  type CuaPermission,
} from "./CuaSetupDialog.logic";
import { SettingsRow, useSettingsSearchTargetId } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useComputerUseAutoSetup,
  type ComputerUseAutoSetup,
  type ComputerUseSetupActions,
} from "./useComputerUseAutoSetup";

export const COMPUTER_USE_ADVANCED_STORAGE_KEY = "goat:settings:computer-use-advanced-open";
// Settings search jumps that land on a row inside Advanced.
const ADVANCED_TARGETS: ReadonlyArray<string> = ["computer-use-skill", "computer-use-full-access"];

export interface ComputerUseSettingsPatch {
  readonly enableCua?: boolean;
  readonly disabledBuiltInSkills?: ReadonlyArray<string>;
  readonly cuaFullAccessAutoAdmit?: boolean;
}

interface StatusLine {
  readonly text: string;
  readonly error?: boolean;
  readonly grant?: CuaPermission;
  readonly retry?: boolean;
  readonly relaunch?: boolean;
  readonly hint?: string | null;
}

type Readiness = ReturnType<typeof computerUseReadinessSteps>;

/**
 * The one line under the switch. A live grant read outranks the host's report, which trails it;
 * any failure the host reports outranks this session's passing check, since a failure carries no
 * generation that would prove it older.
 */
function statusLine(input: {
  readonly setup: ComputerUseAutoSetup;
  readonly status: CuaHostStatus | null;
  readonly error: string | null;
  readonly localMac: boolean;
  readonly hostLabel: string;
  readonly readiness: Readiness;
}): StatusLine | null {
  const { setup, status, error, localMac } = input;
  const { phase } = setup;
  if (setup.notice) return { text: setup.notice, error: true };
  if (setup.busy) return { text: "Setting up…" };
  if (phase.step === "failed")
    return { text: phase.message, error: true, retry: true, relaunch: phase.relaunch };
  if (!setup.on) {
    const text = computerUseStatusText({ enabled: false, status, error });
    return text ? { text } : null;
  }
  if (localMac && setup.unusable) return { text: setup.unusable, error: true, retry: true };
  if (localMac && setup.missing)
    return {
      text: `Needs your OK in System Settings: ${cuaGrantTitle(setup.missing)}`,
      grant: setup.missing,
      relaunch: setup.needsRelaunch,
      hint:
        setup.pollError ??
        (setup.opened && setup.holder
          ? `Drag ${setup.holder.name} into the list and turn on its switch. Setup continues on its own.`
          : null),
    };
  if (error || status === null)
    return { text: computerUseStatusText({ enabled: true, status, error }) ?? "" };
  if (status.failure) return { text: status.failure, error: true, retry: localMac };
  if (phase.step === "ready" || input.readiness.ready) {
    const limits = status.display?.capability === "partial" ? status.display.reason : null;
    const later = status.tools === "available" ? null : "Starts with the next agent turn.";
    if (!limits && !later) return { text: "Ready" };
    return {
      text: [limits ? "Ready with limits." : "Ready.", later, limits].filter(Boolean).join(" "),
    };
  }
  const reported = status.readiness?.grants;
  if (
    !localMac &&
    status.platform === "darwin" &&
    reported &&
    (reported.accessibility !== "granted" || reported.screenCapture !== "granted")
  )
    return { text: cuaHostRequirements("darwin", input.hostLabel) };
  return { text: computerUseStatusText({ enabled: true, status, error }) ?? "" };
}

/** Closed by default and remembered; a settings search for a row inside opens it for this visit. */
function useAdvancedOpen() {
  const [stored, setStored] = useLocalStorage(
    COMPUTER_USE_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const searchTargetId = useSettingsSearchTargetId();
  const [searchOpened, setSearchOpened] = useState(false);
  const [handled, setHandled] = useState<string | null>(null);
  if (
    searchTargetId !== null &&
    ADVANCED_TARGETS.includes(searchTargetId) &&
    handled !== searchTargetId
  ) {
    setHandled(searchTargetId);
    setSearchOpened(true);
  }
  if (searchTargetId === null && handled !== null) setHandled(null);
  const setOpen = (next: boolean) => {
    setStored(next);
    if (!next) setSearchOpened(false);
  };
  return { open: stored || searchOpened, setOpen };
}

export function ComputerUsePanel({
  hostLabel,
  enabled,
  canConfigure,
  status,
  error,
  localMac,
  disabledSkills,
  fullAccessAutoAdmit,
  save,
  bridge,
}: {
  hostLabel: string;
  enabled: boolean;
  canConfigure: boolean;
  status: CuaHostStatus | null;
  error: string | null;
  /** This desktop runs the host, so it can read, grant and prove its macOS permissions. */
  localMac: boolean;
  disabledSkills: ReadonlyArray<string>;
  fullAccessAutoAdmit: boolean;
  save: (patch: ComputerUseSettingsPatch) => Promise<string | null>;
  bridge: Omit<ComputerUseSetupActions, "save"> & {
    readonly reveal?: (() => Promise<void>) | undefined;
  };
}) {
  const setup = useComputerUseAutoSetup({
    enabled,
    localMac,
    actions: { ...bridge, save: (patch) => save(patch) },
  });
  const advanced = useAdvancedOpen();
  const [revealError, setRevealError] = useState<string | null>(null);
  const supported = status !== null && !computerUseUnavailable(status);
  const readinessInput = {
    platform: status?.platform,
    machine: hostLabel,
    readiness: withLiveGrants(status?.readiness, setup.holder),
    tools: status?.tools,
    signals: status?.signals,
  };
  const line = statusLine({
    setup,
    status,
    error,
    localMac,
    hostLabel,
    readiness: computerUseReadinessSteps(readinessInput),
  });
  const reveal = bridge.reveal;

  return (
    <>
      <SettingsRow
        {...searchableSetting("computer-use")}
        serverScoped
        settingKeys={["enableCua"]}
        description={`Let agents see and use apps on ${hostLabel} in the background, without taking over your cursor. Turning it on sets everything up; turning it off stops computer use right away.`}
        status={
          line || (setup.on && !advanced.open) ? (
            <ComputerUseStatus
              line={line}
              setup={setup}
              canConfigure={canConfigure}
              onDetails={setup.on && !advanced.open ? () => advanced.setOpen(true) : undefined}
            />
          ) : undefined
        }
        control={
          <Switch
            aria-label="Computer use"
            checked={setup.on}
            disabled={!canConfigure || (!setup.on && !supported)}
            onCheckedChange={(checked) => void (checked ? setup.start() : setup.stop())}
          />
        }
      />
      <Collapsible open={advanced.open} onOpenChange={advanced.setOpen}>
        <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
              advanced.open && "rotate-90",
            )}
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="border-t border-border/50 pt-3 [&>*+*]:border-t [&>*+*]:border-border/50">
            <ComputerUseReadiness {...readinessInput} />
            {localMac && setup.holder ? (
              <div className="space-y-2 px-4 py-3">
                <CuaGrantTroubleshooting
                  grants={setup.holder}
                  onReveal={
                    reveal
                      ? () =>
                          void reveal().catch(() =>
                            setRevealError(
                              `Could not show ${setup.holder?.name ?? "the helper"} in Finder.`,
                            ),
                          )
                      : undefined
                  }
                />
                {revealError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {revealError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <SettingSwitchRow
              {...searchableSetting("computer-use-full-access")}
              settingKey="cuaFullAccessAutoAdmit"
              description={`Threads in full access mode use every app on ${hostLabel} without asking, including scheduled tasks and GOAT Bot. Stop and turning computer use off still end them.`}
              label="Full access without approval"
              checked={fullAccessAutoAdmit}
              canConfigure={canConfigure}
              onChange={(checked) => save({ cuaFullAccessAutoAdmit: checked })}
            />
            <BuiltInSkillRows
              disabledSkills={disabledSkills}
              canConfigure={canConfigure}
              save={save}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </>
  );
}

function ComputerUseStatus({
  line,
  setup,
  canConfigure,
  onDetails,
}: {
  line: StatusLine | null;
  setup: ComputerUseAutoSetup;
  canConfigure: boolean;
  onDetails: (() => void) | undefined;
}) {
  const grant = line?.grant;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {line ? (
          <span role="status" className={line.error ? "text-destructive" : undefined}>
            {line.text}
          </span>
        ) : null}
        {grant ? (
          <Button
            size="xs"
            variant={setup.opened === grant ? "outline" : "default"}
            disabled={setup.opening}
            aria-label={`${setup.opened === grant ? "Open again" : "Open"}: ${cuaGrantTitle(grant)} in System Settings`}
            onClick={() => setup.openGrant(grant)}
          >
            {setup.opened === grant ? "Open again" : "Open"}
          </Button>
        ) : null}
        {line?.retry ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!canConfigure}
            onClick={() => void setup.start()}
          >
            Retry setup
          </Button>
        ) : null}
        {line?.relaunch && setup.relaunch ? (
          <Button size="xs" variant="outline" onClick={setup.relaunch}>
            Quit & reopen
          </Button>
        ) : null}
        {onDetails ? (
          <Button size="xs" variant="link" onClick={onDetails}>
            Details
          </Button>
        ) : null}
      </div>
      {line?.hint ? <p className="text-xs text-muted-foreground">{line.hint}</p> : null}
    </div>
  );
}

function BuiltInSkillRows({
  disabledSkills,
  canConfigure,
  save,
}: {
  disabledSkills: ReadonlyArray<string>;
  canConfigure: boolean;
  save: (patch: ComputerUseSettingsPatch) => Promise<string | null>;
}) {
  return BUILTIN_SKILLS.filter((skill) => skill.capability === "computer-use").map((skill) => (
    <SettingSwitchRow
      key={skill.name}
      {...searchableSetting("computer-use-skill")}
      settingKey="disabledBuiltInSkills"
      description="Built in. Teaches agents to work one window at a time: look, act once, check the result, and hand sign-ins and other private steps to you. Off keeps the tools without the skill."
      label={`${skill.displayName} skill`}
      checked={!disabledSkills.includes(skill.name)}
      canConfigure={canConfigure}
      onChange={(checked) => {
        const others = disabledSkills.filter((name) => name !== skill.name);
        return save({ disabledBuiltInSkills: checked ? others : [...others, skill.name] });
      }}
    />
  ));
}

/** One server setting inside Advanced, with its own save state and error. */
function SettingSwitchRow({
  id,
  title,
  settingKey,
  description,
  label,
  checked,
  canConfigure,
  onChange,
}: {
  id: string;
  title: string;
  settingKey: "disabledBuiltInSkills" | "cuaFullAccessAutoAdmit";
  description: string;
  label: string;
  checked: boolean;
  canConfigure: boolean;
  onChange: (checked: boolean) => Promise<string | null>;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  return (
    <SettingsRow
      id={id}
      title={title}
      serverScoped
      settingKeys={[settingKey]}
      description={description}
      status={saveError ? <span role="status">{saveError}</span> : undefined}
      control={
        <Switch
          aria-label={label}
          checked={checked}
          disabled={saving || !canConfigure}
          onCheckedChange={(next) => {
            setSaveError(null);
            setSaving(true);
            void onChange(next).then((failure) => {
              setSaving(false);
              setSaveError(failure);
            });
          }}
        />
      }
    />
  );
}
