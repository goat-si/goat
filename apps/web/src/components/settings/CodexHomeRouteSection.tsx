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
  providerHomeNeedsSetup,
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
  /** Codex, Claude Code, OpenCode or Pi; only Codex has Home authentication and a link status. */
  readonly driver?: string;
  readonly providerLabel?: string;
  readonly settings: Pick<CodexSettings, "setupMode" | "modelRoute" | "opencodexBaseUrl"> &
    Partial<Pick<CodexSettings, "opencodexAuth">>;
  /** Codex's route with its link state, or another adapter's prepared Home route. */
  readonly status?: CodexRouteStatus | undefined;
  readonly readOnly: boolean;
  readonly active?: boolean;
  readonly canRefresh?: boolean;
  /** False on servers that would drop Home authentication and write preconditions. */
  readonly writesSupported?: boolean;
  readonly onChange: (route: {
    readonly modelRoute: CodexModelRoute;
    readonly opencodexBaseUrl: string;
    readonly opencodexAuth?: CodexHomeAuth;
  }) => Promise<void>;
  readonly onAddInstance: () => void;
  readonly onOpenDashboard?: (() => Promise<void>) | undefined;
  /** Opens Hub devices, where Home sets this machine up; absent where no router is available. */
  readonly onOpenHubSetup?: (() => void) | undefined;
  readonly onRefresh: () => Promise<void>;
}

/** Route changes use the owning editor's atomic instance mutation. */
export function CodexHomeRouteSection(props: CodexHomeRouteSectionProps) {
  const [baseUrl, setBaseUrl] = useState(props.settings.opencodexBaseUrl);
  const [confirmRoute, setConfirmRoute] = useState<CodexModelRoute | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const driver = props.driver ?? "codex";
  const codex = driver === "codex";
  const providerLabel = props.providerLabel ?? "Codex";
  const managed = codex && props.settings.setupMode === "managed";
  const savedAuth = props.settings.opencodexAuth ?? "openai";
  const [authDraft, setAuthDraft] = useState<CodexHomeAuth>(savedAuth);
  // Managed Codex holds no OpenAI credential that may be sent through Home.
  const authMode: CodexHomeAuth = managed ? "none" : authDraft;
  const usesHome = props.settings.modelRoute === "opencodex";
  const writesBlocked = props.writesSupported === false;
  const disabled = props.readOnly || props.active || pending || writesBlocked;
  // Never show an old route's successful observation after a settings change.
  const observed =
    props.status?.modelRoute === props.settings.modelRoute ? props.status : undefined;
  const ownSettings = codex ? "Uses Codex's own settings" : "Uses the provider's own settings";
  const status = !codex
    ? usesHome
      ? observed?.effectiveBaseUrl
        ? `Uses OpenCodex Home · ${observed.effectiveBaseUrl}`
        : "OpenCodex Home route not checked. Check status."
      : ownSettings
    : usesHome && observed?.state === "not_running"
      ? `OpenCodex isn't running on ${props.environmentLabel}.`
      : openCodexRouteSummary(observed ?? { modelRoute: props.settings.modelRoute });
  const needsSetup = usesHome && providerHomeNeedsSetup(driver, observed);
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
  const apply = (modelRoute: CodexModelRoute) => {
    if (props.readOnly || props.active || writesBlocked) return;
    void run(async () => {
      await props.onChange({
        modelRoute,
        ...(codex && modelRoute === "opencodex" ? { opencodexAuth: authMode } : {}),
        opencodexBaseUrl:
          modelRoute === "default"
            ? props.settings.opencodexBaseUrl
            : baseUrl.trim() || DEFAULT_OPENCODEX_BASE_URL,
      });
      setConfirmRoute(null);
      await props.onRefresh();
    });
  };
  // Codex confirms route changes; for the other adapters the settings action is the consent.
  const request = (modelRoute: CodexModelRoute) =>
    codex ? setConfirmRoute(modelRoute) : apply(modelRoute);
  return (
    <SettingsSection title="Model route">
      <SettingsRow
        title={status ?? "Check model route status"}
        description={`${providerLabel} runs on ${props.environmentLabel}.`}
      />
      {codex ? (
        <SettingsRow
          title="Home authentication"
          description={
            writesBlocked
              ? "Update GOAT on this machine to change Home authentication."
              : managed
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
      ) : writesBlocked ? (
        <SettingsRow title="Update GOAT on this machine to route this instance through Home." />
      ) : null}
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
        title={usesHome ? "Uses OpenCodex Home" : ownSettings}
        description={
          usesHome || codex ? undefined : "OpenCodex Home uses Home's accounts and shared quota."
        }
        control={
          !props.readOnly ? (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => request(usesHome ? "default" : "opencodex")}
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
      (baseUrl !== props.settings.opencodexBaseUrl || (codex && authMode !== savedAuth)) ? (
        <SettingsRow
          title="Home route"
          control={
            <Button variant="ghost" disabled={disabled} onClick={() => request("opencodex")}>
              Save route
            </Button>
          }
        />
      ) : null}
      {needsSetup ? (
        <SettingsRow
          title="Set up this machine from Home"
          description={
            openCodexHomeHandoff({
              environmentLabel: props.environmentLabel,
              action: "connect",
            }).instruction
          }
          control={
            props.onOpenHubSetup ? (
              <Button variant="outline" onClick={props.onOpenHubSetup}>
                Open Hub devices
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {!props.readOnly ? (
        <SettingsRow
          title="Home connection"
          control={
            <div className="flex flex-wrap gap-2">
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
              <Button disabled={disabled} onClick={() => apply(confirmRoute)}>
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
