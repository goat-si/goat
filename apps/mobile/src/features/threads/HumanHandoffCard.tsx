import {
  codexRouteErrorMessage,
  handoffRespondErrorMessage,
} from "@goat/client-runtime/state/provider-instance-display";
import { computerUseGrantLabel } from "@goat/client-runtime/computerUseGrant";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { CopyTextButton } from "./CopyTextButton";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import {
  sshHostPollDelay,
  sshHostProgressComplete,
  sshHostProgressText,
  sshHostProgressRecovery,
} from "@goat/client-runtime/state/sshHost";
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
  type EnvironmentId,
  type Handoff,
  type HandoffHuman,
} from "@goat/contracts";
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Linking, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment, sshHost } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/Button";

type HumanHandoffCardProps = {
  environmentId: EnvironmentId;
  handoff: Handoff;
  inherited: boolean;
};

export function HumanHandoffCard(props: HumanHandoffCardProps) {
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
    <HumanHandoffCardContent
      key={`${props.environmentId}:${props.handoff.handoffId}:${canOpen}:${canRespond}:${canTarget}`}
      {...props}
    />
  );
}

function HumanHandoffCardContent(props: HumanHandoffCardProps) {
  const { handoff } = props;
  const isSsh = handoff.target.path.startsWith("ssh.");
  const isComputerUse = handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH;
  // Computer use grants share the provider cards' host-bound review, labels and gating.
  const isProvider = isProviderHandoffPath(handoff.target.path) || isComputerUse;
  const isProviderHome = handoff.target.path === "provider.home_request";
  const isProviderSetup = handoff.target.path === PROVIDER_SETUP_HANDOFF_PATH;
  const navigation = useNavigation();
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
  const allowed = useAtomValue(
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      (isProvider && (!canTarget || !(action === "opened" ? canOpen : allowed)))
    )
      return;
    inFlight.current = true;
    const generation = lifetime.current;
    setBusy(true);
    setError(null);
    const input = { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId };
    try {
      if (action === "opened") {
        const result = await open({ environmentId: props.environmentId, input });
        if (generation !== lifetime.current) return;
        if (result._tag === "Success") setHuman(result.value.human);
        else setError("Could not open this handoff. Check its status and your permissions.");
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
              : handoffRespondErrorMessage(squashAtomCommandFailure(result)),
          );
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const openProviderSetup = () => {
    if (human === null) return;
    const setup = human.providerSetup;
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsProviderAccounts",
        params: {
          environmentId: handoff.target.environmentId,
          ...(setup?.driver ? { driver: setup.driver } : {}),
          ...(setup?.instanceId ? { instanceId: setup.instanceId } : {}),
        },
      },
    });
  };
  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-goat-bold text-base text-foreground">{handoff.title}</Text>
      <Text className="font-sans text-sm text-foreground-muted">{handoff.reason}</Text>
      {isSsh || isProvider ? (
        pending && handoff.expiresAt ? (
          <Text className="font-sans text-xs text-foreground-muted">
            Expires {DateTime.toDate(handoff.expiresAt).toLocaleTimeString()}
          </Text>
        ) : null
      ) : (
        <Text className="font-sans text-xs text-foreground-muted">
          {handoff.kind.replaceAll("_", " ")} · {handoff.state}
        </Text>
      )}
      {!pending ? (
        isComputerUse ? (
          <View className="gap-2">
            <Text className="font-sans text-sm text-foreground-muted">
              {computerUseGrantLabel(handoff, liveUntil)}
            </Text>
            {liveUntil !== null && !props.inherited ? (
              <Button
                tone="secondary"
                label="End computer use"
                disabled={busy || !allowed || !canTarget}
                onPress={() => void act("cancelled")}
              />
            ) : null}
          </View>
        ) : (
          <Text className="font-sans text-sm text-foreground-muted">
            {handoff.resolvedBy ? `${resolvedLabel} by ${handoff.resolvedBy}` : resolvedLabel}
          </Text>
        )
      ) : props.inherited ? (
        <Text className="font-sans text-sm text-foreground-muted">
          Review this request in its original thread.
        </Text>
      ) : (
        <>
          {human === null ? (
            <Button
              tone="primary"
              label="Review request"
              disabled={busy || !canOpen || ((isSsh || isProvider) && !canTarget)}
              onPress={() => void act("opened")}
            />
          ) : (
            <>
              {isProviderSetup ? (
                <Button
                  tone="primary"
                  label="Open setup"
                  disabled={busy || !allowed || !canTarget}
                  onPress={openProviderSetup}
                />
              ) : null}
              <Text className="font-sans text-sm text-foreground">{human.location}</Text>
              {human.fingerprint ? (
                <>
                  <Text className="font-sans text-sm text-foreground-muted">
                    If your server provider shows a host key, check that it matches.
                  </Text>
                  <Text selectable className="font-mono text-sm text-foreground">
                    {human.fingerprint}
                  </Text>
                </>
              ) : null}
              {human.url ? (
                <Button
                  tone="primary"
                  label="Open sign-in page"
                  onPress={() =>
                    void Linking.openURL(human.url!).catch(() =>
                      setError("Could not open the sign-in page."),
                    )
                  }
                />
              ) : null}
              {human.userCode ? (
                <Text selectable className="font-mono text-base text-foreground">
                  Code: {human.userCode}
                </Text>
              ) : null}
              {human.command ? (
                <>
                  <Text className="font-sans text-sm text-foreground-muted">
                    Run this in your own terminal on the computer that runs GOAT. If the server asks
                    for a password, enter it there; GOAT never sees it.
                  </Text>
                  <Text selectable className="font-mono text-sm text-foreground">
                    {human.command}
                  </Text>
                </>
              ) : null}
              <Text className="font-sans text-xs text-foreground-muted">
                Only you see these details. The agent never does.
              </Text>
              <Button
                tone="primary"
                label={
                  isRuntimeUpdate
                    ? "Update now"
                    : handoff.kind === "approval"
                      ? "Approve"
                      : isKeyAuth
                        ? "I've added the key"
                        : "I've completed this step"
                }
                disabled={busy || !allowed || ((isSsh || isProvider) && !canTarget)}
                onPress={() => void act("completed")}
              />
            </>
          )}
          {!isRuntimeUpdate ? (
            <Button
              tone="primary"
              label="Decline"
              disabled={busy || !allowed || ((isSsh || isProvider) && !canTarget)}
              onPress={() => void act("declined")}
            />
          ) : null}
          {canCancel ? (
            <Button
              tone="primary"
              label={isRuntimeUpdate ? "Cancel" : "Cancel request"}
              disabled={busy || !allowed || ((isSsh || isProvider) && !canTarget)}
              onPress={() => void act("cancelled")}
            />
          ) : null}
        </>
      )}
      {isProviderHome && handoff.state === "completed" && !props.inherited ? (
        <View className="gap-2">
          {routeCheck ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {routeCheck}
            </Text>
          ) : null}
          <Button
            tone="primary"
            label="Check provider status"
            disabled={busy || !canRefresh}
            onPress={() => void checkProviderRoute()}
          />
        </View>
      ) : null}
      {isSsh && handoff.state === "completed" && !props.inherited ? (
        <SshHandoffProgress environmentId={props.environmentId} handoff={handoff} />
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function subscribeAppState(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

function SshHandoffProgress(props: { environmentId: EnvironmentId; handoff: Handoff }) {
  const focused = useIsFocused();
  const appState = useSyncExternalStore(subscribeAppState, () => AppState.currentState);
  return focused && appState === "active" ? <VisibleSshHandoffProgress {...props} /> : null;
}

function VisibleSshHandoffProgress({
  environmentId,
  handoff,
}: {
  environmentId: EnvironmentId;
  handoff: Handoff;
}) {
  const registry = useContext(RegistryContext);
  const target = useMemo(
    () => ({
      environmentId,
      input: { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId },
      targetPath: handoff.target.path,
    }),
    [environmentId, handoff.requestedBy.threadId, handoff.handoffId, handoff.target.path],
  );
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
      <Text accessibilityRole="alert">
        Could not read host progress. Check your connection and permissions.
      </Text>
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
    <View accessibilityLiveRegion="polite" className="gap-1">
      {progress.kind === "available" && handoff.state === "completed" && delay !== null ? (
        <Text>
          Approved · GOAT is{" "}
          {handoff.target.path === "ssh.runtime_update" ? "updating" : "setting up"} {progress.host}
        </Text>
      ) : null}
      {text ? <Text>{text}</Text> : null}
      {recovery ? <Text>{recovery}</Text> : null}
      {publicKey ? (
        <View>
          <Text selectable className="font-mono text-sm text-foreground">
            {publicKey}
          </Text>
          <CopyTextButton accessibilityLabel="Copy public key" text={publicKey} />
        </View>
      ) : null}
      {progress.kind === "available" ? (
        <Button
          tone="primary"
          label="Refresh host status"
          disabled={query.waiting}
          onPress={() => sshHost.refreshHandoffProgress(registry, target)}
        />
      ) : null}
      {sshHostProgressComplete(progress) && progress.kind === "available" ? (
        <Text>
          {progress.host} is ready for agents on this environment. It won't appear as its own
          environment in the sidebar.
        </Text>
      ) : null}
    </View>
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
