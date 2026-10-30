import { settlePromise } from "@goat/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthStandardClientScopes,
  type AdvertisedEndpoint,
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
  type DesktopServerExposureState,
  type EnvironmentId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { useEffect, useRef, useState } from "react";
import { createServerPairingCredential } from "~/environments/primary";
import { readEnvironmentScope } from "~/state/session";
import { QrCodeIcon } from "~/components/solar";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import {
  buildHubPhoneQrPayload,
  isTailscaleHttpsEndpoint,
  missingTailscaleEndpointDescription,
  selectHubPhoneQrTarget,
  type HubPhoneQrTarget,
} from "./ConnectionsSettings.logic";
import { finishConnectFlowResume, peekConnectFlowResume } from "./connectFlowResume";
import {
  type ConnectReachabilityActions,
  ConnectReachabilityNotice,
  connectReachabilityStep,
} from "./ConnectReachabilityNotice";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useDeadlinePassed } from "../../hooks/useDeadline";

type HubDeviceCardProps = {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly isDesktop: boolean;
  readonly canWriteAccess: boolean;
  readonly canManageLocalBackend: boolean;
  readonly delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  /** Null outside the desktop app or while it loads. */
  readonly exposureState: DesktopServerExposureState | null;
  readonly connectActions: ConnectReachabilityActions & {
    readonly onTurnOffTailscaleHttps: (endpoint: AdvertisedEndpoint) => void;
  };
  readonly isNetworkAccessPending: boolean;
  readonly networkAccessError: string | null;
  readonly onPairingLinkCreated: (created: AuthPairingCredentialResult) => void;
};

type IssuedPhoneQr = {
  readonly result: AuthPairingCredentialResult;
  readonly target: HubPhoneQrTarget;
};

function HubPhoneQrView({ issued }: { readonly issued: IssuedPhoneQr }) {
  const expired = useDeadlinePassed(DateTime.toEpochMillis(issued.result.expiresAt));
  if (expired) {
    return <p role="status">This QR has expired. Close this dialog and show a new QR.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="break-all text-xs text-muted-foreground">{issued.target.endpointOrigin}</p>
      {issued.target.kind !== "tailscale-https" ? (
        <p className="text-xs text-muted-foreground">
          {issued.target.kind === "tailnet"
            ? "Keep your phone connected to the same tailnet."
            : "Keep your phone on the same local network."}
        </p>
      ) : null}
      <div className="flex justify-center">
        <QRCodeSvg
          value={buildHubPhoneQrPayload(issued.target, issued.result.credential)}
          size={240}
          level="M"
          marginSize={4}
          title="Scan to pair the GOAT app"
        />
      </div>
    </div>
  );
}

export function HubDeviceCard({
  primaryEnvironmentId,
  isDesktop,
  canWriteAccess,
  canManageLocalBackend,
  delegatableScopes,
  endpoints,
  exposureState,
  connectActions,
  isNetworkAccessPending,
  networkAccessError,
  onPairingLinkCreated,
}: HubDeviceCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // A relaunch for Network access or Tailscale HTTPS reopens the dialog; it stays open, showing
  // loading state, until the user closes it, so a remount while state loads keeps it.
  const [resuming, setResuming] = useState(
    () => isDesktop && peekConnectFlowResume() === "phone-qr",
  );
  const [isCreating, setIsCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedPhoneQr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const target = selectHubPhoneQrTarget(endpoints);
  const tailscaleHttpsEndpoint = endpoints.find(isTailscaleHttpsEndpoint) ?? null;
  const showTailscaleRow = isDesktop && canManageLocalBackend;
  const exposureMode = showTailscaleRow ? (exposureState?.mode ?? null) : null;
  const open = dialogOpen || resuming;
  const scopes = AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope));
  const allowed =
    isDesktop &&
    canManageLocalBackend &&
    primaryEnvironmentId !== null &&
    canWriteAccess &&
    scopes.length > 0;
  const unavailable = isNetworkAccessPending || networkAccessError !== null;
  const issuedTargetIsCurrent =
    issued !== null &&
    target !== null &&
    issued.target.endpointOrigin === target.endpointOrigin &&
    issued.target.kind === target.kind;

  async function issueCredential(selected: HubPhoneQrTarget) {
    if (
      !allowed ||
      unavailable ||
      creatingRef.current ||
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope) ||
      !readEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope) ||
      !scopes.every((scope) => readEnvironmentScope(primaryEnvironmentId, scope))
    )
      return;
    creatingRef.current = true;
    setIsCreating(true);
    setError(null);
    const settled = await settlePromise(() =>
      createServerPairingCredential({
        label: "Phone",
        scopes,
      }),
    );
    creatingRef.current = false;
    if (!mountedRef.current) return;
    setIsCreating(false);
    if (settled._tag === "Failure") {
      const cause = Cause.squash(settled.cause);
      setError(cause instanceof Error ? cause.message : "Could not create a phone QR.");
      return;
    }
    onPairingLinkCreated(settled.value);
    finishConnectFlowResume("phone-qr");
    setIssued({ result: settled.value, target: selected });
  }

  function changeOpen(next: boolean) {
    if (creatingRef.current) return;
    setDialogOpen(next);
    if (!next && resuming) {
      setResuming(false);
      finishConnectFlowResume("phone-qr");
    }
    setIssued(null);
    setError(null);
    if (next && target?.kind === "tailscale-https") void issueCredential(target);
  }

  const tailscaleRow = showTailscaleRow ? (
    <SettingsRow
      title={searchableSetting("tailscale-https").title}
      description={
        tailscaleHttpsEndpoint
          ? tailscaleHttpsEndpoint.status === "available"
            ? tailscaleHttpsEndpoint.httpBaseUrl
            : "Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL."
          : missingTailscaleEndpointDescription(exposureState)
      }
      control={
        tailscaleHttpsEndpoint ? (
          <Switch
            checked={tailscaleHttpsEndpoint.status === "available"}
            disabled={isNetworkAccessPending}
            onCheckedChange={(checked) =>
              checked
                ? connectActions.onTurnOnTailscaleHttps(tailscaleHttpsEndpoint)
                : connectActions.onTurnOffTailscaleHttps(tailscaleHttpsEndpoint)
            }
            aria-label="Enable Tailscale HTTPS"
          />
        ) : connectReachabilityStep(exposureMode, null) === "network-access" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={isNetworkAccessPending}
            onClick={connectActions.onTurnOnNetworkAccess}
          >
            Turn on Network access
          </Button>
        ) : null
      }
    />
  ) : null;

  const phoneDescription = !isDesktop ? (
    <>
      To use this server as a hub, run <code>goat serve --tailscale-serve</code> on the server.{" "}
      Create a pairing link under Authorized clients.
    </>
  ) : primaryEnvironmentId === null ? (
    "Connect an environment to pair your phone."
  ) : !canManageLocalBackend ? (
    "Phone QR needs access to this device’s network settings. Create a link under Authorized clients."
  ) : !allowed ? (
    "This connection cannot create pairing links."
  ) : (
    "Scan a QR with your phone to pair the GOAT app."
  );

  return (
    <SettingsSection {...searchableSetting("hub-device")}>
      {tailscaleRow}
      <SettingsRow
        title="Phone pairing"
        description={phoneDescription}
        status={networkAccessError ? <span role="alert">{networkAccessError}</span> : undefined}
        control={
          isDesktop ? (
            <Dialog open={open} onOpenChange={changeOpen}>
              <DialogTrigger
                render={<Button size="sm" variant="outline" disabled={!allowed || unavailable} />}
              >
                <QrCodeIcon aria-hidden />
                Show phone QR
              </DialogTrigger>
              <DialogPopup showCloseButton={!isCreating}>
                <DialogHeader>
                  <DialogTitle>Pair your phone</DialogTitle>
                  <DialogDescription>
                    Scan with the GOAT app on your phone: Connect hub → Scan QR code.
                  </DialogDescription>
                </DialogHeader>
                <DialogPanel>
                  {isNetworkAccessPending ? (
                    <p role="status">
                      <Spinner size="sm" /> Checking network settings…
                    </p>
                  ) : networkAccessError !== null ? (
                    <p role="status">
                      Could not read network settings. Close this dialog and try again.
                    </p>
                  ) : !allowed ? (
                    <p role="status">This connection cannot create pairing links.</p>
                  ) : isCreating ? (
                    <p role="status">
                      <Spinner size="sm" /> Creating phone QR…
                    </p>
                  ) : issued ? (
                    issuedTargetIsCurrent ? (
                      <HubPhoneQrView issued={issued} />
                    ) : (
                      <p role="status">
                        The network address changed. Close this dialog and show a new QR.
                      </p>
                    )
                  ) : (
                    <div className="space-y-3">
                      {target?.kind !== "tailscale-https" ? (
                        connectReachabilityStep(exposureMode, tailscaleHttpsEndpoint) !== null ? (
                          <ConnectReachabilityNotice
                            flow="phone-qr"
                            mode={exposureMode}
                            tailscaleHttpsEndpoint={tailscaleHttpsEndpoint}
                            onBeforeAction={() => changeOpen(false)}
                            actions={connectActions}
                          />
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Start Tailscale on this computer and your phone for a secure HTTPS
                            address.
                          </p>
                        )
                      ) : null}
                      {target?.kind === "tailnet" || target?.kind === "lan" ? (
                        <>
                          <p className="break-all text-xs text-muted-foreground">
                            {target.endpointOrigin}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {target.kind === "tailnet"
                              ? "Your phone must be on the same tailnet."
                              : "Your phone must be on the same local network. This address will not work away from it."}
                          </p>
                          <Button onClick={() => void issueCredential(target)}>
                            {target.kind === "tailnet"
                              ? "Use tailnet address"
                              : "Use local network"}
                          </Button>
                        </>
                      ) : target?.kind === "tailscale-https" ? (
                        <Button onClick={() => void issueCredential(target)}>
                          Create phone QR
                        </Button>
                      ) : exposureMode === "local-only" ? null : (
                        <p className="text-xs text-muted-foreground">
                          No reachable address is available yet.
                        </p>
                      )}
                    </div>
                  )}
                  {error ? <p role="alert">Could not create a phone QR. {error}</p> : null}
                </DialogPanel>
                <DialogFooter>
                  <Button variant="outline" disabled={isCreating} onClick={() => changeOpen(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </DialogPopup>
            </Dialog>
          ) : undefined
        }
      />
    </SettingsSection>
  );
}
