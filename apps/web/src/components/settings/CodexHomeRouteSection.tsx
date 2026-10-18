import {
  DEFAULT_OPENCODEX_BASE_URL,
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
import { SettingsRow, SettingsSection } from "./settingsLayout";

export interface CodexHomeRouteSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly settings: Pick<CodexSettings, "setupMode" | "modelRoute" | "opencodexBaseUrl">;
  readonly status?: CodexRouteStatus | undefined;
  readonly readOnly: boolean;
  readonly active?: boolean;
  readonly canRefresh?: boolean;
  readonly onChange: (route: {
    readonly modelRoute: CodexModelRoute;
    readonly opencodexBaseUrl: string;
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
  const usesHome = props.settings.modelRoute === "opencodex";
  const disabled = props.readOnly || props.active || pending;
  // Never show an old route's successful observation after a settings change.
  const observed =
    props.status?.modelRoute === props.settings.modelRoute ? props.status : undefined;
  const status =
    usesHome && observed?.state === "not_running"
      ? `OpenCodex isn't running on ${props.environmentLabel}.`
      : openCodexRouteSummary(observed ?? { modelRoute: props.settings.modelRoute });
  const handoff = openCodexHomeHandoff({
    environmentLabel: props.environmentLabel,
    action: confirmRoute === "default" ? "disconnect" : "connect",
  });
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(codexRouteErrorMessage(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return (
    <SettingsSection title="Model route">
      <SettingsRow
        title={status ?? "Check model route status"}
        description={`Codex runs on ${props.environmentLabel}.`}
      />
      {managed ? (
        <SettingsRow
          title="OpenCodex routing needs a Codex instance that uses your Codex CLI."
          control={
            !props.readOnly ? (
              <Button variant="outline" onClick={props.onAddInstance}>
                Add instance
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
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
          {!props.readOnly && usesHome && baseUrl !== props.settings.opencodexBaseUrl ? (
            <SettingsRow
              title="Apply endpoint change"
              control={
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setConfirmRoute("opencodex")}
                >
                  Use OpenCodex Home
                </Button>
              }
            />
          ) : null}
          {!props.readOnly ? (
            <SettingsRow
              title="Home connection"
              control={
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => setShowInstructions(true)}
                  >
                    Connect to Home
                  </Button>
                  {props.onOpenDashboard ? (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() => void run(props.onOpenDashboard!)}
                    >
                      Open OpenCodex
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={pending || props.canRefresh === false}
                    onClick={() => void run(props.onRefresh)}
                  >
                    Check status
                  </Button>
                </div>
              }
            />
          ) : null}
          {showInstructions ? (
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
            <div
              role="alertdialog"
              aria-label={
                confirmRoute === "default" ? "Stop using OpenCodex Home" : "Use OpenCodex Home"
              }
              className="space-y-3 p-4"
            >
              <p className="text-sm text-muted-foreground">
                {confirmRoute === "default"
                  ? handoff.instruction
                  : `Use OpenCodex Home on ${props.environmentLabel} for this Codex instance?`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={disabled}
                  onClick={() => {
                    if (props.readOnly || props.active) return;
                    const modelRoute = confirmRoute;
                    void run(async () => {
                      await props.onChange({
                        modelRoute,
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
              </div>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
