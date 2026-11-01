import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { useRef, useState } from "react";
import { TrashIcon as Trash2Icon } from "~/components/solar";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { ProviderInstallRow } from "./ProviderInstallRow";

interface ProviderSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly binaryPath?: string | undefined;
  readonly authMethod?: AntigravityAuthMethod | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}

export function readAntigravityAuthMethod(config: unknown): AntigravityAuthMethod {
  const value =
    config !== null && typeof config === "object" && "authMethod" in config
      ? config.authMethod
      : undefined;
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === value)?.value ?? "oauth-personal"
  );
}

export function ProviderSetupSection(props: ProviderSetupSectionProps) {
  return (
    <section
      aria-label="Antigravity setup"
      className="@container/setup divide-y divide-border/50 text-xs [&_[data-slot=settings-row]]:rounded-none"
    >
      <SettingsRow
        className="@max-lg/setup:[&>div:first-child]:flex @max-lg/setup:[&>div:first-child]:items-stretch @max-lg/setup:[&>div:first-child]:gap-3"
        title="Environment"
        description="Device that runs this provider."
        control={
          <div className="flex min-w-0 flex-col gap-2 sm:items-end">
            <span className="text-muted-foreground [overflow-wrap:anywhere]">
              {props.environmentLabel}
            </span>
            {!props.enabled && !props.readOnly ? (
              <Button size="sm" variant="outline" onClick={props.onEnable}>
                Enable Antigravity
              </Button>
            ) : null}
          </div>
        }
      />
      {props.readOnly ? (
        <SettingsRow title="Setup unavailable" description="Provider setup is read-only." />
      ) : props.provider?.setup === undefined ? (
        <SettingsRow
          title="Update required"
          description="Update this environment to manage Antigravity."
        />
      ) : (
        <ProviderSetupActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          binaryPath={props.binaryPath}
          authMethod={props.authMethod ?? "oauth-personal"}
          enabled={props.enabled}
        />
      )}
    </section>
  );
}

function ProviderSetupActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  enabled,
  binaryPath,
}: Pick<
  ProviderSetupSectionProps,
  "environmentId" | "environmentLabel" | "instanceId" | "enabled" | "binaryPath"
> & {
  readonly provider: ServerProvider;
  readonly authMethod: AntigravityAuthMethod;
}) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const auth = authQuery.data;
  const installation = installQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const removeInstall = useAtomCommand(
    serverEnvironment.removeProviderInstallation,
    commandOptions,
  );
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const usesCustomBinary = Boolean(binaryPath?.trim());
  const installed =
    provider.installed || (!usesCustomBinary && installation?.installedVersion != null);
  const authError = authQuery.error;
  const actionsDisabled =
    pendingLabel !== null || authError !== null || installQuery.error !== null;
  const customBinaryStatus = !usesCustomBinary
    ? null
    : installation?.installedVersion
      ? `Installed version ${installation.installedVersion}. Installation keeps the custom binary path.`
      : enabled
        ? "The configured Antigravity runtime is unavailable."
        : "The configured Antigravity runtime has not been checked.";

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingLabel(label);
    setError(null);
    const settled = await settlePromise(request);
    pendingRef.current = false;
    setPendingLabel(null);
    if (settled._tag === "Failure") {
      setError("Provider setup failed. Try again.");
      return false;
    }
    const result = settled.value;
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Provider setup failed.");
      }
      return false;
    }
    return true;
  }

  async function removeRuntime() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove the downloaded Antigravity runtime from ${environmentLabel}? Google sign-in and thread history are kept.`,
    );
    if (confirmed) {
      await runCommand("Removing runtime", () => removeInstall(target));
    }
  }

  return (
    <div className="divide-y divide-border/50">
      {/* Keep the live region first so sibling divider rules do not add a divider after the last visible
       * row. */}
      <p className="sr-only" role="status">
        {pendingLabel ? `${pendingLabel}.` : null}
      </p>
      {usesCustomBinary || !provider.setup?.canInstall ? (
        <SettingsRow
          title="Runtime"
          description="Install and manage Antigravity."
          status={
            <div className="space-y-2">
              {customBinaryStatus ? (
                <p className="text-muted-foreground">{customBinaryStatus}</p>
              ) : null}
              {!installed && !provider.setup?.canInstall ? (
                <p className="text-muted-foreground">
                  Automatic installation unavailable. Set a binary path or use another environment.
                </p>
              ) : null}
              {!provider.setup?.canInstall && installation?.installedVersion ? (
                <p className="text-muted-foreground">
                  Installed version {installation.installedVersion}.
                </p>
              ) : null}
            </div>
          }
        />
      ) : null}
      {provider.setup?.canInstall ? (
        <ProviderInstallRow
          environmentId={environmentId}
          instanceId={instanceId}
          label="Antigravity"
          disabled={authActive || pendingLabel !== null}
        />
      ) : null}
      {installation?.canRemove && !installActive ? (
        <SettingsRow
          title="Downloaded runtime"
          description="Google sign-in and thread history are kept."
          control={
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove downloaded runtime"
                    disabled={actionsDisabled || authActive}
                    onClick={() => void removeRuntime()}
                  />
                }
              >
                <Trash2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Remove downloaded runtime</TooltipPopup>
            </Tooltip>
          }
        />
      ) : null}

      <ProviderAuthenticationSection
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={instanceId}
        provider={provider}
        readOnly={false}
      />

      {error || authError || installQuery.error ? (
        <div className="grid gap-2 px-3 py-3 sm:px-4">
          {error || authError ? (
            <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
              {error ?? authError}
            </p>
          ) : null}
          {authError || installQuery.error ? (
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            >
              Retry setup status
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
