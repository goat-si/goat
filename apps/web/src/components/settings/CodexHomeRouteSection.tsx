import {
  DEFAULT_OPENCODEX_BASE_URL,
  type CodexHomeAuth,
  type CodexModelRoute,
  type CodexRouteStatus,
  type CodexSettings,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@goat/contracts";
import {
  CODEX_ROUTE_BUSY_MESSAGE,
  codexRouteErrorMessage,
  openCodexHomeHandoff,
  openCodexRouteSummary,
} from "@goat/client-runtime/state/provider-instance-display";
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export interface CodexHomeRouteSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly settings: Pick<CodexSettings, "setupMode" | "modelRoute" | "opencodexBaseUrl"> &
    Partial<Pick<CodexSettings, "opencodexAuth">>;
  readonly status?: CodexRouteStatus | undefined;
  readonly readOnly: boolean;
  readonly active?: boolean;
  readonly canRefresh?: boolean;
  readonly onChange: (route: {
    readonly modelRoute: CodexModelRoute;
    readonly opencodexBaseUrl: string;
    readonly opencodexAuth?: CodexHomeAuth;
  }) => Promise<void>;
  readonly onAddInstance: () => void;
  readonly onOpenDashboard?: (() => Promise<void>) | undefined;
  readonly onRefresh: () => Promise<void>;
}

/** Route changes use the owning editor's atomic instance mutation. */
export function CodexHomeRouteSection(props: CodexHomeRouteSectionProps) {
  const [baseUrl, setBaseUrl] = useState(props.settings.opencodexBaseUrl);
  const [confirmRoute, setConfirmRoute] = useState<CodexModelRoute | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const managed = props.settings.setupMode === "managed";
  const savedAuth = props.settings.opencodexAuth ?? "openai";
  const [authDraft, setAuthDraft] = useState<CodexHomeAuth>(savedAuth);
  // Managed Codex holds no OpenAI credential that may be sent through Home.
  const authMode: CodexHomeAuth = managed ? "none" : authDraft;
  const usesHome = props.settings.modelRoute === "opencodex";
  const disabled = props.readOnly || props.active || pending;
  // Never show an old route's successful observation after a settings change.
  const observed =
    props.status?.modelRoute === props.settings.modelRoute ? props.status : undefined;
  const status =
    usesHome && observed?.state === "not_running"
      ? `OpenCodex isn't running on ${props.environmentLabel}.`
      : openCodexRouteSummary(observed ?? { modelRoute: props.settings.modelRoute });
  const canConnect = observed?.state === "not_linked" || observed?.state === "failed";
  const handoff = openCodexHomeHandoff({
    environmentLabel: props.environmentLabel,
    action: confirmRoute === "default" ? "disconnect" : "connect",
  });
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const runAction = async () => {
      await action();
    };
    await runAction()
      .catch((failure: unknown) => {
        setError(codexRouteErrorMessage(failure));
      })
      .finally(() => {
        inFlight.current = false;
        setPending(false);
      });
  }
  return (
    <SettingsSection title="Model route">
      <SettingsRow
        title={status ?? "Check model route status"}
        description={`Codex runs on ${props.environmentLabel}.`}
      />
      <SettingsRow
        title="Home authentication"
        description={
          managed
            ? "Managed Codex uses Home without a sign-in. OpenAI authentication for Home needs an instance that uses your Codex CLI."
            : "None uses Home without a sign-in on this machine. OpenAI keeps this instance's own sign-in."
        }
        control={
          <div className="flex gap-2" role="group" aria-label="Home authentication">
            {(["openai", "none"] as const).map((mode) => (
              <Button
                key={mode}
                variant="outline"
                aria-pressed={authMode === mode}
                disabled={disabled || managed}
                onClick={() => setAuthDraft(mode)}
              >
                {mode === "openai" ? "OpenAI" : "None"}
              </Button>
            ))}
          </div>
        }
      />
      {managed && !props.readOnly ? (
        <SettingsRow
          title="Use your own Codex CLI"
          control={
            <Button variant="outline" onClick={props.onAddInstance}>
              Add instance
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        title={usesHome ? "Uses OpenCodex Home" : "Uses Codex's own settings"}
        control={
          !props.readOnly ? (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => setConfirmRoute(usesHome ? "default" : "opencodex")}
            >
              {usesHome ? "Stop using OpenCodex Home" : "Use OpenCodex Home"}
            </Button>
          ) : undefined
        }
      />
      {usesHome || confirmRoute === "opencodex" ? (
        <SettingsRow
          title={`OpenCodex base URL on ${props.environmentLabel}`}
          control={
            <Input
              aria-label={`OpenCodex base URL on ${props.environmentLabel}`}
              value={baseUrl}
              placeholder={DEFAULT_OPENCODEX_BASE_URL}
              disabled={disabled}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          }
        />
      ) : null}
      {!props.readOnly &&
      usesHome &&
      (baseUrl !== props.settings.opencodexBaseUrl || authMode !== savedAuth) ? (
        <SettingsRow
          title="Home route"
          control={
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => setConfirmRoute("opencodex")}
            >
              Save route
            </Button>
          }
        />
      ) : null}
      {!props.readOnly ? (
        <SettingsRow
          title="Home connection"
          control={
            <div className="flex flex-wrap gap-2">
              {canConnect ? (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setShowInstructions(true)}
                >
                  Connect to Home
                </Button>
              ) : null}
              {props.onOpenDashboard ? (
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void run(props.onOpenDashboard!)}
                >
                  Open OpenCodex
                </Button>
              ) : null}
              <Button
                variant="ghost"
                disabled={pending || props.canRefresh === false}
                onClick={() => void run(props.onRefresh)}
              >
                Check status
              </Button>
            </div>
          }
        />
      ) : null}
      {showInstructions && canConnect ? (
        <SettingsRow
          title="Connect to Home"
          description={
            openCodexHomeHandoff({
              environmentLabel: props.environmentLabel,
              action: "connect",
            }).instruction
          }
        />
      ) : null}
      {props.active ? <SettingsRow title={CODEX_ROUTE_BUSY_MESSAGE} /> : null}
      {confirmRoute !== null && !props.readOnly ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !inFlight.current) setConfirmRoute(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmRoute === "default" ? "Stop using OpenCodex Home" : "Use OpenCodex Home"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmRoute === "default"
                  ? handoff.instruction
                  : `Codex on ${props.environmentLabel} will send model requests through OpenCodex Home and use its accounts${authMode === "none" ? ", without a sign-in on this machine" : ""}. If Home is unavailable, this instance stops working instead of switching accounts.`}
              </AlertDialogDescription>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                disabled={disabled}
                onClick={() => {
                  if (props.readOnly || props.active) return;
                  const modelRoute = confirmRoute;
                  void run(async () => {
                    await props.onChange({
                      modelRoute,
                      ...(modelRoute === "opencodex" ? { opencodexAuth: authMode } : {}),
                      opencodexBaseUrl:
                        modelRoute === "default"
                          ? props.settings.opencodexBaseUrl
                          : baseUrl.trim() || DEFAULT_OPENCODEX_BASE_URL,
                    });
                    setConfirmRoute(null);
                    await props.onRefresh();
                  });
                }}
              >
                {confirmRoute === "default" ? "Stop using OpenCodex Home" : "Use OpenCodex Home"}
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setConfirmRoute(null)}>
                Cancel
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
      {error && (confirmRoute === null || props.readOnly) ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
