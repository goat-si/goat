import { useAtomValue } from "@effect/atom-react";
import {
  ProviderHostSyncDriver,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { CopyIcon } from "~/components/solar";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WizardFooter, WizardPanel } from "../ui/wizard";
import { resolveProviderSetupPlan } from "./AddProviderInstanceDialog.logic";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { startProviderHostSync } from "./ProviderHostMatrix.commands";
import { ProviderHostSyncDialog } from "./ProviderHostSyncDialog";
import { ProviderInstallRow } from "./ProviderInstallRow";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";

const isHostSyncDriver = Schema.is(ProviderHostSyncDriver);

/** The wizard's last step: install the CLI when missing, then sign in where the app can. */
export function ProviderWizardAuthenticationStep({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  onFinish,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly onFinish: (result: { readonly signedIn: boolean }) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
    reportDefect: false,
  });
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const auth = query.data;
  const plan = resolveProviderSetupPlan({ provider, auth, authError: query.error });
  const canSyncHosts = useAtomValue(startProviderHostSync.permissionAtom(environmentId));
  const [syncOpen, setSyncOpen] = useState(false);
  const syncDriver = provider && isHostSyncDriver(provider.driver) ? provider.driver : null;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const label = provider?.displayName ?? instanceId;
  const documentationUrl = provider?.setup?.documentationUrl;

  const checkAgain = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setCheckError(null);
    const result = await refreshProviders({
      environmentId,
      input: { instanceId, fresh: true },
    }).catch(() => null);
    checkingRef.current = false;
    setChecking(false);
    if (result?._tag !== "Success") setCheckError("Could not check the provider. Try again.");
  };
  const checkAgainControl = (
    <div className="flex flex-wrap items-center gap-1.5">
      {documentationUrl ? (
        <Button
          size="sm"
          variant="ghost-muted"
          render={<a href={documentationUrl} target="_blank" rel="noreferrer" />}
        >
          Open docs
        </Button>
      ) : null}
      <Button size="sm" variant="outline" disabled={checking} onClick={() => void checkAgain()}>
        {checking ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
  const checkErrorStatus = checkError ? (
    <p role="alert" className="text-destructive">
      {checkError}
    </p>
  ) : undefined;

  return (
    <>
      <WizardPanel className="min-h-72">
        <SettingsGroup variant="plain">
          {plan.kind === "checking" ? (
            <SettingsRow
              title="Provider"
              description={
                <span role="status">
                  Checking {label} on {environmentLabel}…
                </span>
              }
              status={checkErrorStatus}
              control={checkAgainControl}
            />
          ) : plan.kind === "install" ? (
            <>
              {plan.inApp ? (
                <ProviderInstallRow
                  environmentId={environmentId}
                  instanceId={instanceId}
                  label={label}
                />
              ) : (
                <SettingsRow
                  title="Install"
                  description={
                    <span role="status">
                      {provider?.message ?? `${label} isn't installed on ${environmentLabel}.`}{" "}
                      Install it there, then check again.
                    </span>
                  }
                  status={checkErrorStatus}
                  control={checkAgainControl}
                />
              )}
              <SettingsRow title="Account" description="Sign in after the install finishes." />
            </>
          ) : provider && plan.kind === "signedIn" && provider.setup?.canAuthenticate !== true ? (
            // Signed in through the provider's own CLI: there is no in-app flow to query.
            <SettingsRow title="Account" description={`Signed in on ${environmentLabel}.`} />
          ) : provider && (plan.kind === "signIn" || plan.kind === "signedIn") ? (
            <ProviderAuthenticationSection
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              instanceId={instanceId}
              provider={
                provider.driver === "acpRegistry"
                  ? {
                      ...provider,
                      setup: {
                        ...provider.setup,
                        canInstall: provider.setup?.canInstall ?? false,
                        canAuthenticate: plan.kind === "signIn",
                      },
                    }
                  : provider
              }
              readOnly={false}
            />
          ) : plan.kind === "discovering" ? (
            <SettingsRow
              title="Account"
              description={<span role="status">Discovering sign-in methods…</span>}
              control={
                <Button disabled size="sm" variant="outline">
                  Sign in
                </Button>
              }
            />
          ) : plan.kind === "command" ? (
            <SettingsRow
              title="Account"
              description={`${label} signs in from its own terminal. Run this on ${environmentLabel}, then check again.`}
              status={checkErrorStatus}
              control={checkAgainControl}
            >
              <div className="flex items-center gap-1.5 py-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
                  <code className="select-all font-mono">{plan.command}</code>
                </pre>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Copy sign-in command"
                        size="icon-sm"
                        variant="ghost-muted"
                        onClick={() => void writeTextToClipboard(plan.command, "Sign-in command")}
                      >
                        <CopyIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup>Copy command</TooltipPopup>
                </Tooltip>
              </div>
            </SettingsRow>
          ) : (
            <SettingsRow
              title="Account"
              description={
                query.error ??
                auth?.message ??
                "No in-app sign-in advertised. Follow the provider's docs, then check again."
              }
              status={checkErrorStatus}
              control={checkAgainControl}
            />
          )}
        </SettingsGroup>
      </WizardPanel>
      <WizardFooter>
        {plan.kind === "signedIn" && syncDriver && canSyncHosts ? (
          <Button size="sm" variant="ghost-muted" onClick={() => setSyncOpen(true)}>
            Sync to other hosts…
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={plan.kind === "signedIn" ? "default" : "outline"}
          disabled={active}
          onClick={() => onFinish({ signedIn: plan.kind === "signedIn" })}
        >
          {plan.kind === "signedIn" || plan.kind === "manual" ? "Done" : "Skip for now"}
        </Button>
      </WizardFooter>
      {syncDriver && syncOpen ? (
        <ProviderHostSyncDialog
          environmentId={environmentId}
          driver={syncDriver}
          displayName={label}
          open
          onOpenChange={setSyncOpen}
        />
      ) : null}
    </>
  );
}
