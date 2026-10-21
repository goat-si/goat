import { codexRouteErrorMessage } from "@goat/client-runtime/state/provider-instance-display";
import { computerUseGrantLabel } from "@goat/client-runtime/computerUseGrant";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  computerUseGrantLiveUntil,
  isHandoffPending,
  isProviderHandoffPath,
  PROVIDER_SETUP_HANDOFF_PATH,
  ProviderDriverKind,
  type EnvironmentId,
  type Handoff,
  type HandoffHuman,
} from "@goat/contracts";
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as DateTime from "effect/DateTime";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment, sshHost } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  sshHostPollDelay,
  sshHostProgressComplete,
  sshHostProgressText,
  sshHostProgressRecovery,
} from "@goat/client-runtime/state/sshHost";
import { HandoffReview } from "./HandoffReview";
import { Button } from "../ui/button";

// Loaded on demand so threads that never show a provider setup request skip the wizard code.
const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

/** Human instructions are fetched only on review; they never enter the thread transcript. */
type HandoffCardProps = {
  environmentId: EnvironmentId;
  handoff: Handoff;
  inherited: boolean;
};

export function HandoffCard(props: HandoffCardProps) {
  const canOpen = useAtomValue(serverEnvironment.openHandoff.permissionAtom(props.environmentId));
  const canRespond = useAtomValue(
    serverEnvironment.respondHandoff.permissionAtom(props.environmentId),
  );
  const canManageProviders = useEnvironmentScope(
    props.handoff.target.environmentId,
    AuthProvidersManageScope,
  );
  const canWriteSettings = useEnvironmentScope(
    props.handoff.target.environmentId,
    AuthSettingsWriteScope,
  );
  const canTargetPermission = useAtomValue(
    (isProviderHandoffPath(props.handoff.target.path)
      ? serverEnvironment.mutateProviderInstance
      : props.handoff.target.path === "ssh.host_add"
        ? serverEnvironment.trustSshHost
        : serverEnvironment.prepareSshHost
    ).permissionAtom(props.handoff.target.environmentId),
  );
  const canTarget =
    props.handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH
      ? canWriteSettings
      : canTargetPermission &&
        (!isProviderHandoffPath(props.handoff.target.path) || canManageProviders);
  return (
    <HandoffCardContent
      key={`${props.environmentId}:${props.handoff.handoffId}:${canOpen}:${canRespond}:${canTarget}`}
      {...props}
    />
  );
}

function HandoffCardContent(props: HandoffCardProps) {
  const { handoff } = props;
  const isSsh = handoff.target.path.startsWith("ssh.");
  const isComputerUse = handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH;
  // Computer use grants share the provider cards' host-bound review, labels and gating.
  const isProvider = isProviderHandoffPath(handoff.target.path) || isComputerUse;
  const isProviderHome = handoff.target.path === "provider.home_request";
  const isProviderSetup = handoff.target.path === PROVIDER_SETUP_HANDOFF_PATH;
  const isKeyAuth = handoff.kind === "terminal" && handoff.target.path === "ssh.host_prepare";
  const canCancel = handoff.target.path !== "ssh.host_add" && !isKeyAuth;
  const resolvedLabel =
    isSsh || isProvider
      ? {
          completed: "Approved",
          declined: "Declined",
          cancelled: "Cancelled",
          expired: "Expired",
          failed: "Failed",
          pending: "Pending",
          opened: "Opened",
        }[handoff.state]
      : handoff.state;
  const isRuntimeUpdate =
    handoff.kind === "approval" && handoff.target.path === "ssh.runtime_update";
  const canManageProviders = useEnvironmentScope(
    handoff.target.environmentId,
    AuthProvidersManageScope,
  );
  const canWriteSettings = useEnvironmentScope(
    handoff.target.environmentId,
    AuthSettingsWriteScope,
  );
  const canTargetPermission = useAtomValue(
    (isProvider
      ? serverEnvironment.mutateProviderInstance
      : handoff.target.path === "ssh.host_add"
        ? serverEnvironment.trustSshHost
        : serverEnvironment.prepareSshHost
    ).permissionAtom(handoff.target.environmentId),
  );
  const canTarget = isComputerUse
    ? canWriteSettings
    : canTargetPermission && (!isProvider || canManageProviders);
  const liveUntil = useComputerUseGrantLiveUntil(handoff);
  const canOpen = useAtomValue(serverEnvironment.openHandoff.permissionAtom(props.environmentId));
  const canRespond = useAtomValue(
    serverEnvironment.respondHandoff.permissionAtom(props.environmentId),
  );
  const open = useAtomCommand(serverEnvironment.openHandoff, {
    label: "open handoff",
    reportFailure: false,
    reportDefect: false,
  });
  const respond = useAtomCommand(serverEnvironment.respondHandoff, {
    label: "respond to handoff",
    reportFailure: false,
    reportDefect: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
    reportDefect: false,
  });
  const canReadProviders = useEnvironmentScope(
    handoff.target.environmentId,
    AuthOrchestrationReadScope,
  );
  const canRefreshPermission = useAtomValue(
    serverEnvironment.refreshProviders.permissionAtom(handoff.target.environmentId),
  );
  const canRefresh = canRefreshPermission && canReadProviders;
  const [routeCheck, setRouteCheck] = useState<string | null>(null);
  const checkProviderRoute = async () => {
    const result = await refreshProviders({
      environmentId: handoff.target.environmentId,
      input: { fresh: true, refreshModels: true },
    });
    if (result._tag === "Failure")
      setRouteCheck(codexRouteErrorMessage(squashAtomCommandFailure(result)));
    else setRouteCheck(null);
  };
  const [human, setHuman] = useState<HandoffHuman | null>(null);
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const targetLabel = useEnvironment(handoff.target.environmentId)?.label ?? "this environment";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const lifetime = useRef(0);
  useEffect(
    () => () => {
      lifetime.current += 1;
    },
    [],
  );
  const pending = isHandoffPending(handoff.state);
  const act = async (action: "opened" | "completed" | "declined" | "cancelled") => {
    if (
      inFlight.current ||
      (isProvider && (!canTarget || !(action === "opened" ? canOpen : canRespond)))
    )
      return;
    inFlight.current = true;
    const generation = lifetime.current;
    setBusy(true);
    setError(null);
    const input = { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId };
    const runAction = async () => {
      if (action === "opened") {
        const result = await open({ environmentId: props.environmentId, input });
        if (generation !== lifetime.current) return;
        if (result._tag === "Success") setHuman(result.value.human);
        else
          setError(
            "Could not open this handoff. It may have expired or require additional permissions.",
          );
      } else {
        const result = await respond({
          environmentId: props.environmentId,
          input: { ...input, action },
        });
        if (generation !== lifetime.current) return;
        if (result._tag === "Success") {
          setHuman(null);
          if (isProviderHome && action === "completed" && canRefresh) await checkProviderRoute();
        } else
          setError(
            isProviderHome
              ? codexRouteErrorMessage(squashAtomCommandFailure(result))
              : "Could not update this handoff. It may already be resolved or expired.",
          );
      }
    };
    await runAction().finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };
  return (
    <section
      aria-label={handoff.title}
      data-v2-item-type="human_handoff"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">{handoff.title}</h3>
        <p className="text-sm text-muted-foreground">{handoff.reason}</p>
        {isSsh || isProvider ? (
          pending && handoff.expiresAt ? (
            <p className="text-xs text-muted-foreground">
              Expires {DateTime.toDate(handoff.expiresAt).toLocaleTimeString()}
            </p>
          ) : null
        ) : (
          <p className="text-xs text-muted-foreground">
            {handoff.kind.replaceAll("_", " ")} · {handoff.state}
            {handoff.expiresAt && pending
              ? ` · Expires ${DateTime.toDate(handoff.expiresAt).toLocaleTimeString()}`
              : ""}
          </p>
        )}
      </div>
      {!pending ? (
        isComputerUse ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {computerUseGrantLabel(handoff, liveUntil)}
            </p>
            {liveUntil !== null && !props.inherited ? (
              <div>
                <Button
                  variant="outline"
                  disabled={busy || !canRespond || !canTarget}
                  onClick={() => void act("cancelled")}
                >
                  End computer use
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {handoff.resolvedBy ? `${resolvedLabel} by ${handoff.resolvedBy}` : resolvedLabel}
          </p>
        )
      ) : props.inherited ? (
        <p className="text-sm text-muted-foreground">Review this request in its original thread.</p>
      ) : (
        <>
          {human === null ? (
            <div>
              <Button
                disabled={busy || !canOpen || ((isSsh || isProvider) && !canTarget)}
                onClick={() => void act("opened")}
              >
                Review request
              </Button>
            </div>
          ) : (
            <>
              {isProviderSetup ? (
                <div>
                  <Button
                    disabled={busy || !canTarget || !canRespond}
                    onClick={() => setIsSetupOpen(true)}
                  >
                    Open setup
                  </Button>
                </div>
              ) : null}
              <HandoffReview
                human={human}
                busy={busy}
                allowed={canRespond && (!(isSsh || isProvider) || canTarget)}
                approveLabel={
                  isRuntimeUpdate
                    ? "Update now"
                    : handoff.kind === "approval"
                      ? "Approve"
                      : isKeyAuth
                        ? "I've added the key"
                        : "I've completed this step"
                }
                onApprove={() => void act("completed")}
                {...(isRuntimeUpdate ? {} : { onDecline: () => void act("declined") })}
                {...(canCancel ? { onCancel: () => void act("cancelled") } : {})}
                cancelLabel={isRuntimeUpdate ? "Cancel" : "Cancel request"}
              />
            </>
          )}
          {human === null ? (
            <div className="flex flex-wrap gap-2">
              {!isRuntimeUpdate ? (
                <Button
                  variant="ghost-muted"
                  disabled={busy || !canRespond || ((isSsh || isProvider) && !canTarget)}
                  onClick={() => void act("declined")}
                >
                  Decline
                </Button>
              ) : null}
              {canCancel ? (
                <Button
                  variant="ghost-muted"
                  disabled={busy || !canRespond || ((isSsh || isProvider) && !canTarget)}
                  onClick={() => void act("cancelled")}
                >
                  {isRuntimeUpdate ? "Cancel" : "Cancel request"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {isProviderSetup && isSetupOpen && human !== null && pending && canTarget ? (
        <Suspense fallback={null}>
          <AddProviderInstanceDialog
            open
            environmentId={handoff.target.environmentId}
            environmentLabel={targetLabel}
            initialDriver={
              human.providerSetup?.driver
                ? ProviderDriverKind.make(human.providerSetup.driver)
                : undefined
            }
            initialInstanceId={human.providerSetup?.instanceId}
            onOpenChange={(open) => {
              if (!open) setIsSetupOpen(false);
            }}
            onFinished={({ signedIn }) => {
              if (signedIn) void act("completed");
            }}
          />
        </Suspense>
      ) : null}
      {isProviderHome && handoff.state === "completed" && !props.inherited ? (
        <div className="space-y-2">
          {routeCheck ? (
            <p role="alert" className="text-sm text-destructive">
              {routeCheck}
            </p>
          ) : null}
          <Button
            variant="outline"
            disabled={busy || !canRefresh}
            onClick={() => void checkProviderRoute()}
          >
            Check provider status
          </Button>
        </div>
      ) : null}
      {isSsh && handoff.state === "completed" && !props.inherited ? (
        <SshHandoffProgress environmentId={props.environmentId} handoff={handoff} />
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** A completed card restores its binding even after private instructions have been cleared. */
function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function SshHandoffProgress(props: { environmentId: EnvironmentId; handoff: Handoff }) {
  const visibility = useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState,
    () => "visible",
  );
  return visibility === "visible" ? <VisibleSshHandoffProgress {...props} /> : null;
}

function VisibleSshHandoffProgress({
  environmentId,
  handoff,
}: {
  environmentId: EnvironmentId;
  handoff: Handoff;
}) {
  const registry = useContext(RegistryContext);
  const [copyError, setCopyError] = useState<string | null>(null);
  const target = {
    environmentId,
    input: { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId },
    targetPath: handoff.target.path,
  };
  const query = useAtomValue(sshHost.handoffProgress(target));
  const progress = query._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(query));
  const approvalFresh =
    handoff.state === "completed" &&
    handoff.kind === "approval" &&
    handoff.resolvedAt !== undefined &&
    query._tag === "Success" &&
    query.timestamp - DateTime.toEpochMillis(handoff.resolvedAt) < 10 * 60_000;
  const snapshot = progress?.kind === "available" ? progress.result.status : undefined;
  const awaitingResume =
    snapshot?.setup?.stage === "runtime" &&
    (snapshot.state === "untrusted" ||
      snapshot.state === "trust_pending" ||
      snapshot.state === "stopped");
  const approvalExpired =
    handoff.state === "completed" &&
    ((handoff.kind === "approval" && awaitingResume && !approvalFresh) ||
      (snapshot?.state === "failed" && snapshot.failure?.reason === "approval_expired"));
  const delay =
    progress?.kind === "available" && !approvalExpired
      ? sshHostPollDelay(progress.result, approvalFresh)
      : null;
  useEffect(() => {
    if (handoff.state === "completed" || isHandoffPending(handoff.state))
      sshHost.refreshHandoffProgress(registry, target);
  }, [registry, target, handoff.state]);
  useEffect(() => {
    if (delay === null || query.waiting) return;
    const timer = setTimeout(() => sshHost.refreshHandoffProgress(registry, target), delay);
    return () => clearTimeout(timer);
  }, [registry, target, query, delay]);
  if (progress === null)
    return query._tag === "Failure" ? (
      <p role="alert">Could not read host progress. Check your connection and permissions.</p>
    ) : null;
  const text = approvalExpired
    ? progress.kind === "available" && handoff.target.path === "ssh.runtime_update"
      ? `This approval expired before GOAT could update ${progress.host}. Ask again.`
      : progress.kind === "available"
        ? `This approval expired before GOAT could set up ${progress.host}. Ask the agent again.`
        : null
    : sshHostProgressText(progress);
  const recovery = approvalExpired ? null : sshHostProgressRecovery(progress);
  const publicKey =
    progress.kind === "available" && progress.result.status?.state === "auth_failed"
      ? (progress.result.status.keyAuth?.publicKey ?? progress.result.status.publicKey)
      : undefined;
  return (
    <div role="status" className="space-y-1 text-sm text-muted-foreground">
      {progress.kind === "available" && handoff.state === "completed" && delay !== null ? (
        <p>
          Approved · GOAT is{" "}
          {handoff.target.path === "ssh.runtime_update" ? "updating" : "setting up"} {progress.host}
        </p>
      ) : null}
      {text ? <p>{text}</p> : null}
      {recovery ? <p>{recovery}</p> : null}
      {progress.kind === "available" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={query.waiting}
            onClick={() => sshHost.refreshHandoffProgress(registry, target)}
          >
            Refresh host status
          </Button>
          {publicKey ? (
            <Button
              variant="ghost-muted"
              size="xs"
              onClick={() =>
                void navigator.clipboard
                  .writeText(publicKey)
                  .catch(() => setCopyError("Could not copy the public key. Try again."))
              }
            >
              Copy public key
            </Button>
          ) : null}
        </div>
      ) : null}
      {copyError ? <p role="alert">{copyError}</p> : null}
      {typeof window.desktopBridge === "undefined" &&
      sshHostProgressComplete(progress) &&
      progress.kind === "available" ? (
        <p>
          {progress.host} is ready for agents on this environment. It won't appear as its own
          environment in the sidebar.
        </p>
      ) : null}
    </div>
  );
}

/** An approved computer use admission: when it ends, refreshed once when that time passes. */
function useComputerUseGrantLiveUntil(handoff: Handoff): Date | null {
  const [now, setNow] = useState(() => Date.now());
  const until = computerUseGrantLiveUntil(handoff, now) ?? undefined;
  useEffect(() => {
    if (until === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [until]);
  return until === undefined ? null : new Date(until);
}
