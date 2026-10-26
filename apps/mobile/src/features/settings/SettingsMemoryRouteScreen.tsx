import { RegistryContext, useAtomValue, useAtomSet } from "@effect/atom-react";
import { useNavigation, useFocusEffect, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthMemoryReadScope,
  AuthOrchestrationReadScope,
  MemoryId,
  ProjectId,
  MemoryOperationId,
  supportsMemoryProtocol,
  type EnvironmentId,
  type MemoryItem,
  type MemoryScope,
  type MemorySpaceId,
  type MemorySyncStatus,
  type MemoryReportReference,
  type MemoryReadSourceInput,
  type MemoryHistoryPage,
  type MemoryRevisionId,
  type MemoryRevertResolutionInput,
  type MemoryRevertResult,
  type MemoryForgetInput,
  type MemoryProjectBinding,
} from "@goat/contracts";
import {
  presentMemoryItem,
  presentMemoryResolution,
  presentMemoryRevertResult,
  presentMemoryRevert,
  memoryLocalSpace,
  presentMemoryReport,
  presentMemoryStorage,
  memoryHoldRefreshDelayMs,
  presentMemoryProcessing,
  isMemoryReportRetryCandidate,
  presentMemoryReportReset,
  memoryReportTarget,
  MEMORY_FORGET_NOTICE,
} from "@goat/client-runtime/memory-presentation";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { resolveMemoryModelSelection } from "@goat/shared/serverSettings";
import {
  memoryBrowseInput,
  memorySearchInput,
  memoryProjectScope,
  memoryPreview,
  memoryScopeLabel,
  presentMemoryPage,
} from "@goat/client-runtime/memory-browsing";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Modal, FlatList, Pressable, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { memoryEnvironment as memory } from "../../state/memory";
import { useThreadShell, useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { MemorySyncDiagnostics } from "./MemorySyncDiagnostics";
import { MemoryImportSettings } from "./MemoryImportSettings";
import { MemoryProjectSettings } from "./MemoryProjectSettings";
import { MemoryProjectPicker } from "./MemoryProjectPicker";
import { MemoryAdministration } from "./MemorySharingSettings";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";
import {
  memoryExpectedHeads,
  memoryScopeForSelection,
  validateMemoryDestination,
  type MemoryScreenParams,
} from "./SettingsMemoryRouteScreen.logic";

const operationId = () => MemoryOperationId.make(Crypto.randomUUID());
const PAGE_SIZE = 30;
function formatMemoryTime(value: string | null) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "The request could not be completed.";
}
function Copy({ children }: { readonly children: React.ReactNode }) {
  return (
    <Text selectable className="p-3 text-sm text-foreground-muted">
      {children}
    </Text>
  );
}
function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly tone?: "danger";
}) {
  return <SettingsActionRow icon="brain" {...props} />;
}
function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly multiline?: boolean;
}) {
  return (
    <View className="gap-2 p-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        editable={!props.disabled}
        multiline={props.multiline}
        className="rounded-lg border border-border p-3 text-foreground"
      />
    </View>
  );
}

/** A dialog and its callbacks belong to one connected screen lifetime. */
function useMemoryLifetime(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const connection = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const config = registry.get(serverEnvironment.configValueAtom(environmentId));
    return (
      mounted.current &&
      Option.isSome(connection) &&
      registry.get(environmentSession.preparedConnectionValueAtom(environmentId)) === connection &&
      config !== null &&
      supportsMemoryProtocol(config.environment.capabilities)
    );
  };
}
function MemoryConfirmation({
  title,
  message,
  label,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  label: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View className="flex-1 justify-center bg-background p-6" accessibilityViewIsModal>
        <Copy>{title}</Copy>
        <Copy>{message}</Copy>
        <Action label="Cancel" onPress={onClose} />
        <Action label={label} tone="danger" onPress={onConfirm} />
      </View>
    </Modal>
  );
}

/** Same explicit destination in Settings, native headers, palette and Bot reports. */
export function useMemoryNavigation(
  environmentId: EnvironmentId | null,
  extra: Omit<MemoryScreenParams, "environmentId"> = {},
) {
  const navigation = useNavigation();
  const thread = useThreadShell(extra.thread ?? null);
  const project =
    extra.project ??
    (thread && environmentId ? { environmentId, projectId: thread.projectId } : undefined);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const visible = config !== null && supportsMemoryProtocol(config.environment.capabilities);
  const destination = useMemo(
    () => ({ environmentId, ...extra, ...(project ? { project } : {}) }),
    [environmentId, extra, project],
  );
  const open = useCallback(() => {
    if (environmentId === null) return;
    navigation.navigate("SettingsMemory", destination as MemoryScreenParams);
  }, [navigation, environmentId, destination]);
  return { visible, open };
}

export function MemoryEnvironmentEntry({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { visible, open } = useMemoryNavigation(environmentId);
  const { savedConnectionsById } = useSavedRemoteConnections();
  return visible ? (
    <SettingsRow
      icon="brain"
      label={`Memory · ${savedConnectionsById[environmentId]?.environmentLabel ?? "Unknown device"}`}
      onPress={open}
    />
  ) : null;
}

export function MemoryReportLink({ reference }: { readonly reference: MemoryReportReference }) {
  const target = memoryReportTarget(reference);
  const { visible, open } = useMemoryNavigation(target.environmentId, target);
  const allowed = useAtomValue(memory.syncStatus.permissionAtom(target.environmentId));
  if (!visible) return null;
  return (
    <Action
      label={
        allowed ? "View memory details" : "Memory read permission is required to view this report"
      }
      onPress={open}
    />
  );
}

export function SettingsMemoryRouteScreen({
  route,
}: StaticScreenProps<MemoryScreenParams | undefined>) {
  const params = route.params;
  if (!validateMemoryDestination(params))
    return (
      <SettingsScreen title="Memory">
        <Copy>This memory link is invalid. Open Memory from Settings.</Copy>
      </SettingsScreen>
    );
  return (
    <SettingsScreen title="Memory">
      {params?.environmentId ? (
        <MemoryEnvironment
          key={JSON.stringify(params)}
          params={params as MemoryScreenParams & { environmentId: EnvironmentId }}
        />
      ) : (
        <MemoryChooser />
      )}
    </SettingsScreen>
  );
}
function MemoryChooser() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <Copy>Choose the environment whose memory you want to manage.</Copy>
      {Object.values(savedConnectionsById).map((connection) => (
        <MemoryEnvironmentEntry
          key={connection.environmentId}
          environmentId={connection.environmentId}
        />
      ))}
      <Copy>Missing an environment? Connect it or update its server to use Memory.</Copy>
    </ScreenScrollView>
  );
}

function MemoryEnvironment({
  params,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
}) {
  const { environmentId } = params;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  const [connectionVersion, setConnectionVersion] = useState({ connection: session, version: 0 });
  if (connectionVersion.connection !== session)
    setConnectionVersion({ connection: session, version: connectionVersion.version + 1 });
  const readAllowed = useAtomValue(memory.syncStatus.permissionAtom(environmentId));
  const adminAllowed = useAtomValue(memory.hubSettingsGet.permissionAtom(environmentId));
  const writeAllowed = useAtomValue(memory.upsert.permissionAtom(environmentId));
  const supported = config !== null && supportsMemoryProtocol(config.environment.capabilities);
  // Remount all projections on connection replacement or loss of access. No late reply survives.
  if (!supported)
    return (
      <MemoryConnectionHelp
        environmentId={environmentId}
        message="Update this environment's server and reconnect to use Memory."
      />
    );
  if (Option.isNone(session))
    return (
      <MemoryConnectionHelp
        environmentId={environmentId}
        message="Reconnect this environment to manage its memory."
      />
    );
  if (!readAllowed && !adminAllowed && !writeAllowed)
    return <Copy>This connection does not have permission to manage memory.</Copy>;
  return (
    <MemoryConnected
      key={`${connectionVersion.version}:${readAllowed}:${adminAllowed}:${writeAllowed}`}
      params={params}
      readAllowed={readAllowed}
    />
  );
}

function MemoryConnectionHelp({
  environmentId,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}) {
  const navigation = useNavigation();
  return (
    <>
      <Copy>{message}</Copy>
      <SettingsRow
        icon="desktopcomputer"
        label="Open environment connection"
        onPress={() => navigation.navigate("SettingsEnvironmentDetail", { environmentId })}
      />
      <SettingsRow
        icon="desktopcomputer"
        label="Saved environments"
        target="SettingsEnvironments"
      />
    </>
  );
}

function MemoryConnected({
  params,
  readAllowed,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly readAllowed: boolean;
}) {
  const registry = useContext(RegistryContext);
  const { environmentId } = params;
  const sync = useAtomCommand(memory.syncStatus);
  const [status, setStatus] = useState<MemorySyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedSpace, setSavedSpace] = useState<MemorySpaceId | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    if (!mounted.current || !registry.get(memory.syncStatus.permissionAtom(environmentId))) return;
    const before = ++generation.current;
    setError(null);
    const result = await sync({ environmentId, input: {} });
    if (
      !mounted.current ||
      before !== generation.current ||
      !registry.get(memory.syncStatus.permissionAtom(environmentId))
    )
      return;
    if (AsyncResult.isSuccess(result)) {
      setStatus(result.value);

      setError(null);
    } else if (AsyncResult.isFailure(result)) setError(failureMessage(result));
  }, [registry, environmentId, sync]);
  useFocusEffect(
    useCallback(() => {
      if (readAllowed) void load();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active" && readAllowed) void load();
      });
      return () => {
        generation.current += 1;
        subscription.remove();
      };
    }, [load, readAllowed]),
  );
  // Turning memory off or a new effective memory model clears a pause, so status is read again.
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const memoryModel = config
    ? JSON.stringify([
        config.settings.memoryEnabled,
        resolveMemoryModelSelection(config.settings, undefined),
      ])
    : null;
  const seenModel = useRef(memoryModel);
  useEffect(() => {
    // The first value was already loaded on focus; only a change needs another read.
    // Without read access the focus effect loads once access arrives.
    if (seenModel.current === memoryModel || !readAllowed) return;
    const timer = setTimeout(() => {
      seenModel.current = memoryModel;
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [memoryModel, load, readAllowed]);
  const generationHold = status?.generationHold;
  useEffect(() => {
    const delay = memoryHoldRefreshDelayMs(generationHold, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [generationHold, load]);
  const readySpace = memoryLocalSpace(status);
  if (readySpace && readySpace !== savedSpace) setSavedSpace(readySpace);
  const space = params.memorySpaceId ?? readySpace ?? savedSpace;
  const enabled =
    status !== null && status.state !== "disabled" && status.state !== "bootstrapping";
  return (
    <View className="flex-1">
      {status?.state === "bootstrapping" && status.memorySpaceId ? (
        <MemoryBootstrapRefresh
          environmentId={environmentId}
          memorySpaceId={status.memorySpaceId}
          onChange={load}
        />
      ) : null}
      {error ? <Copy>Could not load memory status.</Copy> : null}
      {space && readAllowed ? (
        <MemoryBrowser
          key={space}
          params={params}
          memorySpaceId={space}
          memoryEnabled={enabled}
          onSyncRefresh={load}
          status={status}
        />
      ) : (
        <ScreenScrollView>
          <MemoryGeneration environmentId={environmentId} />
          <MemoryAgentAccess environmentId={environmentId} />
          {status ? <MemoryStatusRows status={status} /> : null}
          <MemorySyncDiagnostics environmentId={environmentId} status={status} onRefresh={load} />
          <MemoryAdministration
            environmentId={environmentId}
            onSharingRefresh={() => void load()}
            sync={status}
          />
          <SettingsSection title="Memories">
            <Copy>
              {!readAllowed
                ? "Memory read permission is required to view records."
                : status?.state === "disabled"
                  ? "Turn on memory to see and save memories."
                  : "Memory is getting ready."}
            </Copy>
          </SettingsSection>
          {error ? <Action label="Retry memory status" onPress={() => void load()} /> : null}
        </ScreenScrollView>
      )}
    </View>
  );
}

function MemoryBootstrapRefresh({
  environmentId,
  memorySpaceId,
  onChange,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  onChange: () => Promise<void>;
}) {
  const exposure = useAtomValue(memory.exposureAtom({ environmentId, input: { memorySpaceId } }));
  useEffect(() => {
    if (exposure.ready) void onChange();
  }, [exposure, onChange]);
  return null;
}

function MemoryBrowser({
  params,
  memorySpaceId,
  ...props
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly onSyncRefresh: () => Promise<void>;
  readonly memoryEnabled: boolean;
  readonly status: MemorySyncStatus | null;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === params.environmentId,
  );
  const getBinding = useAtomCommand(memory.projectBindingGet);
  const canGetBinding = useAtomValue(memory.projectBindingGet.permissionAtom(params.environmentId));
  const [scope, setScope] = useState<MemoryScope | null>({ kind: "user" });
  const [selection, setSelection] = useState("user");
  const [browsing, setBrowsing] = useState(false);
  const retireImport = useRef<() => Promise<void>>(async () => {});
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  async function choose(project: (typeof projects)[number] | null, thread = false) {
    const attempt = ++generation.current;
    try {
      await retireImport.current();
    } catch {
      if (generation.current === attempt)
        setError("Could not clear the previous import. Reopen Settings before changing projects.");
      return;
    }
    if (generation.current !== attempt) return;
    setBrowsing(true);
    setSelection(thread ? "thread" : project ? `project:${project.id}` : "user");
    setError(null);
    const projectRef = project
      ? { environmentId: params.environmentId, projectId: project.id }
      : thread
        ? params.project
        : undefined;
    setScope(
      projectRef
        ? null
        : thread
          ? (memoryScopeForSelection("thread", params, null) ?? null)
          : { kind: "user" },
    );
    if (!projectRef) return;
    const result = await getBinding({
      environmentId: params.environmentId,
      input: {
        memorySpaceId,
        project: projectRef,
      },
    });
    if (generation.current !== attempt) return;
    if (!AsyncResult.isSuccess(result)) {
      setError("Could not load project memory scope. Choose the project again to retry.");
      return;
    }
    const next = thread
      ? memoryScopeForSelection("thread", params, result.value.projectKey)
      : memoryProjectScope(result.value, project?.repositoryIdentity);
    setScope(next ?? null);
    if (!next) setError("This project needs a repository or an explicit shared memory key.");
  }
  const selectedProjectMissing =
    selection.startsWith("project:") &&
    !projects.some((project) => `project:${project.id}` === selection);
  const scopePicker = (
    <SettingsSection title="Memory scope">
      <Menu
        title="Memory scope"
        actions={[
          { id: "user", title: "User", state: selection === "user" ? "on" : "off" },
          ...(params.thread
            ? [
                {
                  id: "thread",
                  title: "Thread",
                  state: selection === "thread" ? ("on" as const) : ("off" as const),
                  attributes: { disabled: Boolean(params.project) && !canGetBinding },
                },
              ]
            : []),
          ...projects.map((project) => ({
            id: `project:${project.id}`,
            title: project.title,
            state: selection === `project:${project.id}` ? ("on" as const) : ("off" as const),
            attributes: { disabled: !canGetBinding },
          })),
        ]}
        onPressAction={({ nativeEvent }) => {
          if (nativeEvent.event === "user") void choose(null);
          else if (nativeEvent.event === "thread") void choose(null, true);
          else {
            const project = projects.find((item) => `project:${item.id}` === nativeEvent.event);
            if (project && canGetBinding) void choose(project);
          }
        }}
      >
        <SettingsRow
          icon="brain"
          label="Memory scope"
          value={
            selection === "thread"
              ? "Thread"
              : selection === "user"
                ? "User"
                : projects.find((project) => `project:${project.id}` === selection)?.title
          }
        />
      </Menu>
      {!canGetBinding && projects.length > 0 ? (
        <Copy>Project scope requires memory write permission to look up its shared key.</Copy>
      ) : null}
      {error ? <Copy>{error}</Copy> : null}
      {selectedProjectMissing ? (
        <Copy>Selected project is no longer available. Choose another scope.</Copy>
      ) : !scope && !error ? (
        <Copy>Loading project memory scope</Copy>
      ) : null}
    </SettingsSection>
  );
  return scope && !selectedProjectMissing ? (
    <ScopedMemoryBrowser
      key={JSON.stringify(scope)}
      {...props}
      params={
        browsing
          ? {
              ...params,
              memoryId: undefined,
              resolutionId: undefined,
              project:
                selection === "thread"
                  ? params.project
                  : selection === "user"
                    ? undefined
                    : {
                        environmentId: params.environmentId,
                        projectId: ProjectId.make(selection.slice("project:".length)),
                      },
              thread: selection === "thread" ? params.thread : undefined,
            }
          : params
      }
      memorySpaceId={memorySpaceId}
      scope={scope}
      scopePicker={scopePicker}
      retireImport={retireImport}
    />
  ) : (
    <ScreenScrollView>{scopePicker}</ScreenScrollView>
  );
}

function ScopedMemoryBrowser({
  params,
  memorySpaceId,
  onSyncRefresh,
  memoryEnabled,
  status,
  scope,
  scopePicker,
  retireImport,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly onSyncRefresh: () => Promise<void>;
  readonly memoryEnabled: boolean;
  readonly status: MemorySyncStatus | null;
  readonly scope: MemoryScope;
  readonly scopePicker: React.ReactNode;
  readonly retireImport: React.RefObject<() => Promise<void>>;
}) {
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState(params.memoryId);
  const [creating, setCreating] = useState(false);
  const projects = useProjects().filter(
    (project) => project.environmentId === params.environmentId,
  );
  const [projectRef, setProjectRef] = useState(params.project);
  const effectiveParams = useMemo(
    () => ({
      ...params,
      project: projectRef,
      thread: projectRef?.projectId === params.project?.projectId ? params.thread : undefined,
    }),
    [params, projectRef],
  );
  const [binding, setBinding] = useState<MemoryProjectBinding | null>(null);
  const acceptBinding = useCallback((value: MemoryProjectBinding | null) => setBinding(value), []);
  const [scopeKind, setScopeKind] = useState<MemoryScope["kind"] | null>("user");
  const importScope = useMemo(
    () =>
      scopeKind
        ? memoryScopeForSelection(scopeKind, effectiveParams, binding?.projectKey ?? null)
        : undefined,
    [scopeKind, effectiveParams, binding],
  );
  const bindingToken = JSON.stringify([projectRef, binding?.version, binding?.projectKey]);
  const [seenProjects, setSeenProjects] = useState<ReadonlySet<string>>(
    () => new Set(projects.map((project) => project.id)),
  );
  if (projects.some((project) => !seenProjects.has(project.id)))
    setSeenProjects(new Set([...seenProjects, ...projects.map((project) => project.id)]));
  const projectExists =
    !projectRef ||
    projects.some((project) => project.id === projectRef.projectId) ||
    (!seenProjects.has(projectRef.projectId) && params.project?.projectId === projectRef.projectId);

  const [quarantine, setQuarantine] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const forget = useAtomCommand(memory.forget);
  const liveDestination = useMemoryLifetime(params.environmentId);
  // This owner survives the detail's immediate forget fence.
  async function forgetMemory(input: MemoryForgetInput, imported: boolean) {
    const result = await forget({ environmentId: params.environmentId, input });
    if (
      liveDestination() &&
      readEnvironmentScope(params.environmentId, AuthMemoryReadScope) &&
      registry.get(memory.forget.permissionAtom(params.environmentId))
    ) {
      if (AsyncResult.isSuccess(result)) {
        if (result.value.outcome === "rejected") {
          setNotice("Could not forget this memory. Review the record before trying again.");
        } else {
          setSelected((current) => (current === input.memoryId ? undefined : current));
          setNotice(
            "Forgotten. Other devices remove it when they sync." +
              (imported ? ` ${MEMORY_FORGET_NOTICE}` : ""),
          );
          registry.refresh(atom);
        }
      } else if (AsyncResult.isFailure(result))
        setNotice("Forget request failed. Try again to continue this request.");
    }
    return result;
  }
  const exposure = useAtomValue(
    memory.exposureAtom({ environmentId: params.environmentId, input: { memorySpaceId } }),
  );
  const [forgetGeneration, setForgetGeneration] = useState(exposure.forgetGeneration);
  if (forgetGeneration !== exposure.forgetGeneration) {
    setForgetGeneration(exposure.forgetGeneration);
    setSelected(undefined);
    setCreating(false);
  }
  const [wasEnabled, setWasEnabled] = useState(memoryEnabled);
  if (wasEnabled !== memoryEnabled) {
    setWasEnabled(memoryEnabled);
    setCreating(false);
  }

  const input = memoryBrowseInput({
    memorySpaceId,
    limit: PAGE_SIZE,
    scope,
    ...(cursor ? { cursor } : {}),
  });
  const atom = search
    ? memory.search({
        environmentId: params.environmentId,
        input: memorySearchInput(input, search),
      })
    : memory.list({
        environmentId: params.environmentId,
        input: { ...input, includeQuarantined: quarantine },
      });
  const result = useAtomValue(atom);
  const page = AsyncResult.isSuccess(result) ? Option.getOrNull(result.value) : null;
  if (selected)
    return (
      <MemoryDetails
        key={selected}
        params={params}
        memorySpaceId={memorySpaceId}
        memoryId={selected}
        memoryEnabled={memoryEnabled}
        onClose={() => setSelected(undefined)}
        onForget={forgetMemory}
      />
    );
  if (creating && memoryEnabled)
    return (
      <MemoryEditor
        params={params}
        memorySpaceId={memorySpaceId}
        scope={scope}
        scopeLabel={
          projects.find((project) => project.id === params.project?.projectId)?.title ??
          memoryScopeLabel(scope)
        }
        onClose={() => {
          setCreating(false);
          registry.refresh(atom);
        }}
      />
    );
  return (
    <FlatList
      data={page?.items ?? []}
      keyExtractor={(item) => item.memoryId}
      contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={
        <>
          <MemoryAdministration
            environmentId={params.environmentId}
            onSharingRefresh={() => void onSyncRefresh()}
            sync={status}
          />
          <MemoryGeneration environmentId={params.environmentId} />
          <MemoryAgentAccess environmentId={params.environmentId} />
          {status ? <MemoryStatusRows status={status} /> : null}
          <MemorySyncDiagnostics
            environmentId={params.environmentId}
            status={status}
            onRefresh={onSyncRefresh}
          />
          {scopePicker}
          <SettingsSection title="Import scope">
            <Copy>Select a scope for imports. Existing memories keep their scope.</Copy>
            {(["user", "project", "thread"] as const).map((kind) => (
              <SettingsSwitchRow
                key={kind}
                label={`Scope: ${kind}`}
                value={scopeKind === kind}
                disabled={
                  kind === "project"
                    ? !binding?.projectKey || !projectExists
                    : kind === "thread"
                      ? !effectiveParams.thread
                      : false
                }
                onValueChange={(value) => {
                  setScopeKind(value ? kind : null);
                  setCursor(undefined);
                }}
              />
            ))}
            {projectRef ? (
              <Copy>
                {projects.find((project) => project.id === projectRef.projectId)?.title ??
                  "Selected project"}
              </Copy>
            ) : (
              <Copy>
                No project selected. User scope is available; select a project for project scope.
              </Copy>
            )}
            <MemoryProjectPicker
              environmentId={params.environmentId}
              label="Choose project…"
              candidateLabel="Select project: "
              onSelect={(projectId) => {
                void (async () => {
                  await retireImport.current();
                  setBinding(null);
                  setScopeKind(null);
                  setProjectRef({ environmentId: params.environmentId, projectId });
                })().catch(() =>
                  setNotice(
                    "Could not clear the previous import. Reopen Settings before changing projects.",
                  ),
                );
              }}
            />
            {projectRef ? (
              <Action
                label="Clear selected project"
                onPress={() => {
                  void (async () => {
                    await retireImport.current();
                    setProjectRef(undefined);
                    setBinding(null);
                    setScopeKind(null);
                  })().catch(() =>
                    setNotice(
                      "Could not clear the previous import. Reopen Settings before changing projects.",
                    ),
                  );
                }}
              />
            ) : null}
          </SettingsSection>
          {projectRef && projectExists ? (
            <MemoryProjectSettings
              key={JSON.stringify(projectRef)}
              environmentId={params.environmentId}
              memorySpaceId={memorySpaceId}
              project={projectRef}
              onBinding={acceptBinding}
              beforeChange={() => retireImport.current()}
            />
          ) : null}
          {!projectRef || binding ? (
            <MemoryImportSettings
              params={effectiveParams}
              memorySpaceId={memorySpaceId}
              scope={importScope}
              bindingToken={bindingToken}
              enabled={memoryEnabled && projectExists}
              retireRef={retireImport}
            />
          ) : null}
          <SettingsSection title="Memories">
            {!memoryEnabled ? (
              <Copy>Saved memories stay. Turn on memory to save new memories.</Copy>
            ) : null}
            {notice ? <Copy>{notice}</Copy> : null}
            {page && page.items.length > 0 && presentMemoryPage(page, Boolean(search)) ? (
              <Copy>{presentMemoryPage(page, Boolean(search))}</Copy>
            ) : null}
          </SettingsSection>
          <Field label="Search memory" value={query} onChange={setQuery} />
          <Action
            label="Search"
            onPress={() => {
              setSearch(query.trim());
              setCursor(undefined);
            }}
          />
          {query || search ? (
            <Action
              label="Clear"
              onPress={() => {
                setQuery("");
                setSearch("");
                setCursor(undefined);
              }}
            />
          ) : null}
          <SettingsSwitchRow
            label="Include quarantined"
            value={quarantine}
            onValueChange={(value) => {
              setQuarantine(value);
              setCursor(undefined);
            }}
          />
          <Action
            label="Remember something"
            onPress={() => setCreating(true)}
            disabled={!canWrite || !memoryEnabled || !scope}
          />
        </>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open memory: ${item.status === "active" ? memoryPreview(item.payload.text) : item.status === "forgotten" ? "Forgotten memory" : "Conflicting memory"}`}
          onPress={() => {
            registry.refresh(
              memory.read({
                environmentId: params.environmentId,
                input: { memorySpaceId, memoryId: item.memoryId },
              }),
            );
            setSelected(item.memoryId);
          }}
          className="gap-1 border-b border-border p-4"
        >
          <Text
            className={item.status === "forgotten" ? "text-foreground-muted" : "text-foreground"}
          >
            {item.status === "active"
              ? memoryPreview(item.payload.text)
              : item.status === "forgotten"
                ? "Forgotten memory"
                : "Conflicting memory"}
          </Text>
          {item.status === "forgotten" ? <Copy>The memory body has been removed.</Copy> : null}
          <Text className="text-sm text-foreground-muted">
            {presentMemoryItem(item).label}
            {presentMemoryItem(item).syncLabel ? ` · ${presentMemoryItem(item).syncLabel}` : ""}
          </Text>
        </Pressable>
      )}
      ListEmptyComponent={
        <Copy>
          {AsyncResult.isFailure(result)
            ? "Could not load memory. Refresh to try again."
            : page
              ? presentMemoryPage(page, Boolean(search))
              : "Waiting for memory access or fresh data. Refresh to try again."}
        </Copy>
      }
      ListFooterComponent={
        <>
          {!page || AsyncResult.isFailure(result) ? (
            <Action label="Refresh memories" onPress={() => registry.refresh(atom)} />
          ) : null}
          {page?.nextCursor ? (
            <Action
              label="Next page"
              disabled={!page?.nextCursor}
              onPress={() => setCursor(page?.nextCursor ?? undefined)}
            />
          ) : null}
          {cursor ? <Action label="First page" onPress={() => setCursor(undefined)} /> : null}
        </>
      }
    />
  );
}

function originalDisplay(history: MemoryHistoryPage, id: MemoryRevisionId) {
  const index = history.revisions.findIndex((pair) => pair.revision.revisionId === id);
  const pair = history.revisions[index];
  return { number: index + 1, pair };
}

function MemoryDetails({
  params,
  memorySpaceId,
  memoryId,
  memoryEnabled,
  onForget,
  onClose,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly memoryId: MemoryId;
  readonly memoryEnabled: boolean;
  readonly onForget: (
    input: MemoryForgetInput,
    imported: boolean,
  ) => Promise<AsyncResult.AsyncResult<import("@goat/contracts").MemoryMutationReceipt, unknown>>;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const deviceName = (id: EnvironmentId) =>
    savedConnectionsById[id]?.environmentLabel ?? "Unknown device";
  const target = { environmentId: params.environmentId, input: { memorySpaceId, memoryId } };
  const readAtom = memory.read(target);
  const result = useAtomValue(readAtom);
  const item = AsyncResult.isSuccess(result) ? Option.getOrNull(result.value) : null;
  const [cursor, setCursor] = useState<string | undefined>();
  const historyAtom = memory.history({
    ...target,
    input: { ...target.input, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
  });
  const historyResult = useAtomValue(historyAtom);
  const history = AsyncResult.isSuccess(historyResult)
    ? Option.getOrNull(historyResult.value)
    : null;
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState<MemoryReadSourceInput | null>(null);
  const canWrite = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const canForget = useAtomValue(memory.forget.permissionAtom(params.environmentId));
  const canReadOriginal = useEnvironmentScope(params.environmentId, AuthOrchestrationReadScope);
  const liveDestination = useMemoryLifetime(params.environmentId);
  const [confirmForget, setConfirmForget] = useState(false);
  const intent = useRef<{
    operationId: MemoryOperationId;
    expectedHeads: ReturnType<typeof memoryExpectedHeads>;
  } | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const [hadItem, setHadItem] = useState(item !== null);
  if (hadItem !== (item !== null)) {
    setHadItem(item !== null);
    if (!item) {
      setSource(null);
      setEditing(false);
      setConfirmForget(false);
    }
  }
  async function performForget() {
    const current = registry.get(readAtom);
    const live = AsyncResult.isSuccess(current) ? Option.getOrNull(current.value) : null;
    if (
      !liveDestination() ||
      !readEnvironmentScope(params.environmentId, AuthMemoryReadScope) ||
      busy.current ||
      !registry.get(memory.forget.permissionAtom(params.environmentId))
    )
      return;
    if (!intent.current) {
      if (!live) return;
      intent.current = { operationId: operationId(), expectedHeads: memoryExpectedHeads(live) };
    }
    busy.current = true;
    setPending(true);
    try {
      const result = await onForget(
        { memorySpaceId, memoryId, ...intent.current },
        live?.status === "active" && live.payload.evidence.some((e) => e.origin === "import"),
      );
      if (!mounted.current || !registry.get(memory.forget.permissionAtom(params.environmentId)))
        return;
      if (AsyncResult.isSuccess(result)) {
        if (result.value.outcome === "rejected") {
          intent.current = null;
          setRetry(false);
          setNotice("Could not forget this memory. Review the record before trying again.");
          return;
        }
        intent.current = null;
        setRetry(false);
        registry.refresh(readAtom);
        registry.refresh(historyAtom);
      } else if (AsyncResult.isFailure(result)) {
        setRetry(true);
        setNotice(`${failureMessage(result)} Retry uses the same request.`);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  if (editing && memoryEnabled && item?.status === "active")
    return (
      <MemoryEditor
        params={params}
        memorySpaceId={memorySpaceId}
        scope={item.scope}
        item={item}
        onClose={() => {
          setEditing(false);
          registry.refresh(readAtom);
        }}
      />
    );
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <Action label="Close details" onPress={onClose} />
      {notice ? <Copy>{notice}</Copy> : null}
      {item ? (
        <>
          <Copy>
            {presentMemoryItem(item).label}
            {presentMemoryItem(item).syncLabel ? ` · ${presentMemoryItem(item).syncLabel}` : ""}
            {presentMemoryItem(item).cleanupLabel
              ? ` · ${presentMemoryItem(item).cleanupLabel}`
              : ""}
          </Copy>
          {item.status === "active" ? (
            <>
              <Copy>{item.payload.text}</Copy>
              <Copy>
                Source: {item.revision.provenance.provider ?? "User"} ·{" "}
                {deviceName(item.revision.provenance.environmentId)}
              </Copy>
              <Action
                label="Edit"
                disabled={!canWrite || !memoryEnabled || pending}
                onPress={() => setEditing(true)}
              />
              {item.payload.evidence.map((evidence) =>
                evidence.sourceThread && evidence.messageIds.length > 0 ? (
                  <Action
                    key={JSON.stringify(evidence)}
                    label={`Read original on ${deviceName(evidence.sourceThread.environmentId)}`}
                    disabled={!canReadOriginal}
                    onPress={() =>
                      setSource({
                        memorySpaceId,
                        memoryId,
                        sourceThread: evidence.sourceThread!,
                        messageIds: evidence.messageIds,
                        limit: PAGE_SIZE,
                      })
                    }
                  />
                ) : null,
              )}
            </>
          ) : null}
          {!retry ? (
            <Action
              label="Forget"
              disabled={!canForget || !presentMemoryItem(item).canForget || pending}
              onPress={() => setConfirmForget(true)}
            />
          ) : null}
        </>
      ) : (
        <Copy>
          {AsyncResult.isFailure(result)
            ? "Could not load this memory."
            : "Memory unavailable or awaiting fresh access."}
        </Copy>
      )}
      {pending ? <Copy>Forget request pending.</Copy> : null}
      {retry ? (
        <Action
          label="Retry forget request"
          disabled={!canForget || pending}
          onPress={() => void performForget()}
        />
      ) : null}
      {confirmForget ? (
        <MemoryConfirmation
          title="Forget this memory?"
          message={
            "Forget this memory and its derived content?" +
            (item?.status === "active" && item.payload.evidence.some((e) => e.origin === "import")
              ? ` ${MEMORY_FORGET_NOTICE}`
              : "")
          }
          label="Confirm forget"
          onClose={() => setConfirmForget(false)}
          onConfirm={() => {
            setConfirmForget(false);
            void performForget();
          }}
        />
      ) : null}
      <Action
        label="Refresh details"
        onPress={() => {
          registry.refresh(readAtom);
          registry.refresh(historyAtom);
        }}
      />
      {source && item ? (
        <MemorySource
          key={JSON.stringify(source)}
          environmentId={params.environmentId}
          input={source}
          onClose={() => setSource(null)}
        />
      ) : null}
      <SettingsSection title="History">
        {item ? (
          <>
            {history?.revisions.map((pair) => (
              <View key={pair.revision.revisionId}>
                <Copy>
                  {history.resolutions.some((r) =>
                    r.resolution.inputRevisionIds.includes(pair.revision.revisionId),
                  )
                    ? "Original"
                    : "Version"}{" "}
                  {originalDisplay(history, pair.revision.revisionId).number} ·{" "}
                  {formatMemoryTime(pair.revision.createdAtUtc)} ·{" "}
                  {pair.revision.provenance.provider ?? "User"}
                </Copy>
                <Copy>{pair.payload?.text ?? "Original unavailable"}</Copy>
              </View>
            ))}
            {history?.resolutions.map((entry) => {
              const view = presentMemoryResolution(entry);
              return (
                <View key={entry.resolution.resolutionId}>
                  <Copy>
                    {params.resolutionId === entry.resolution.resolutionId
                      ? "Selected resolution · "
                      : ""}
                    {view.label} · {view.providerLabel} · {view.effectiveModel} ·{" "}
                    {deviceName(view.resolvingEnvironmentId)}
                  </Copy>
                  <Copy>
                    Applied: {formatMemoryTime(view.appliedAtUtc)} · Revert deadline:{" "}
                    {formatMemoryTime(view.revertDeadlineUtc)}
                  </Copy>
                  <Copy>{entry.payload?.judgment ?? "Judgment unavailable"}</Copy>
                  {item?.status === "active" &&
                  history &&
                  memoryEnabled &&
                  item.revision.revisionId === entry.resolution.resultRevisionId &&
                  entry.resolution.revertsResolutionId === undefined ? (
                    <MemoryRevertControl
                      environmentId={params.environmentId}
                      item={item}
                      entry={entry}
                      history={history}
                      readCurrent={() => {
                        const value = registry.get(readAtom);
                        return AsyncResult.isSuccess(value) ? Option.getOrNull(value.value) : null;
                      }}
                      readHistory={() => {
                        const value = registry.get(historyAtom);
                        return AsyncResult.isSuccess(value) ? Option.getOrNull(value.value) : null;
                      }}
                      onSettled={() => {
                        registry.refresh(readAtom);
                        registry.refresh(historyAtom);
                      }}
                    />
                  ) : null}
                </View>
              );
            })}
          </>
        ) : null}
        {history?.revertResults.map((value) => (
          <Copy key={value.operationId}>{presentMemoryRevertResult(value).label}</Copy>
        ))}
        {history?.reports.map((report) => (
          <MemoryReport key={report.reportId} report={report} />
        ))}
        {history ? (
          <MemoryReportRetry
            reports={history.reports}
            environmentId={params.environmentId}
            memorySpaceId={memorySpaceId}
            memoryId={memoryId}
          />
        ) : null}
        <Copy>History is live. Return to the first page to see new changes.</Copy>
        <Action
          label="Next history page"
          disabled={!history?.nextCursor}
          onPress={() => setCursor(history?.nextCursor ?? undefined)}
        />
        <Action
          label="First history page"
          disabled={!cursor}
          onPress={() => setCursor(undefined)}
        />
      </SettingsSection>
    </ScreenScrollView>
  );
}

function MemoryRevertControl({
  environmentId,
  item,
  entry,
  history,
  readCurrent,
  readHistory,
  onSettled,
}: {
  environmentId: EnvironmentId;
  item: MemoryItem;
  entry: MemoryHistoryPage["resolutions"][number];
  history: MemoryHistoryPage;
  readCurrent: () => MemoryItem | null;
  readHistory: () => MemoryHistoryPage | null;
  onSettled: () => void;
}) {
  const registry = useContext(RegistryContext);
  const liveDestination = useMemoryLifetime(environmentId);
  const allowed = useAtomValue(memory.revertResolution.permissionAtom(environmentId));
  const revert = useAtomCommand(memory.revertResolution);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supportsInputs = config?.environment.capabilities.memory?.resolutionInputs === true;
  const [originalCursor, setOriginalCursor] = useState<string | undefined>();
  const originalsAtom = memory.history({
    environmentId,
    input: {
      memorySpaceId: item.memorySpaceId,
      memoryId: item.memoryId,
      ...(supportsInputs ? { resolutionInputsFor: entry.resolution.resolutionId } : {}),
      limit: 20,
      ...(originalCursor ? { cursor: originalCursor } : {}),
    },
  });
  const originalsResult = useAtomValue(originalsAtom);
  const originalPage = AsyncResult.isSuccess(originalsResult)
    ? Option.getOrNull(originalsResult.value)
    : null;
  const revertHistory = supportsInputs
    ? {
        ...history,
        revisions: originalPage?.revisions ?? [],
        restorableRevisionIds: originalPage?.restorableRevisionIds ?? [],
      }
    : history;
  const previousHistory = useRef(history);
  useEffect(() => {
    if (previousHistory.current !== history) registry.refresh(originalsAtom);
    previousHistory.current = history;
  }, [history, registry, originalsAtom]);
  const [selected, setSelected] = useState<MemoryRevisionId | null>(null);
  const [intent, setIntent] = useState<MemoryRevertResolutionInput | null>(null);
  const [result, setResult] = useState<MemoryRevertResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [openedAt] = useState(Date.now);
  const display = presentMemoryRevert({
    item,
    entry,
    history: revertHistory,
    requireCompleteHistory: !supportsInputs,
    now: openedAt,
    ...(selected ? { restoredRevisionId: selected } : {}),
  });
  const available = allowed && display.canRevert;
  if (
    (!available ||
      (intent &&
        (item.status !== "active" || intent.expectedHeads[0] !== item.revision.revisionId))) &&
    selected !== null
  ) {
    setSelected(null);
    setIntent(null);
    setError(null);
  }
  function active() {
    return liveDestination() && registry.get(memory.revertResolution.permissionAtom(environmentId));
  }
  async function submit() {
    if (!selected || busy.current || (result && result.status !== "refused") || !active()) return;
    const current = readCurrent();
    const page = readHistory();
    const originals = registry.get(originalsAtom);
    const liveOriginals = AsyncResult.isSuccess(originals)
      ? Option.getOrNull(originals.value)
      : null;
    const resolution = page?.resolutions.find(
      (value) => value.resolution.resolutionId === entry.resolution.resolutionId,
    );
    if (
      !current ||
      !page ||
      (supportsInputs && !liveOriginals) ||
      !resolution ||
      current.memoryId !== item.memoryId ||
      current.memorySpaceId !== item.memorySpaceId ||
      current.status !== "active"
    )
      return;
    if (
      !presentMemoryRevert({
        item: current,
        entry: resolution,
        history:
          supportsInputs && liveOriginals
            ? {
                ...page,
                revisions: liveOriginals.revisions,
                restorableRevisionIds: liveOriginals.restorableRevisionIds ?? [],
              }
            : page,
        requireCompleteHistory: !supportsInputs,
        now: Date.now(),
        restoredRevisionId: selected,
      }).canRevert
    )
      return;
    if (intent && intent.expectedHeads[0] !== current.revision.revisionId) return;
    const input = intent ?? {
      memorySpaceId: current.memorySpaceId,
      memoryId: current.memoryId,
      resolutionId: resolution.resolution.resolutionId,
      restoredRevisionId: selected,
      expectedHeads: [current.revision.revisionId],
      operationId: operationId(),
    };
    setIntent(input);
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await revert({ environmentId, input });
      if (!active()) return;
      if (AsyncResult.isFailure(response)) {
        setError("Revert request failed. Retry uses the same request.");
      } else if (AsyncResult.isSuccess(response)) {
        setResult(response.value);
        setIntent(null);
        setSelected(null);
        registry.refresh(originalsAtom);
        onSettled();
      }
    } finally {
      busy.current = false;
      if (active()) setPending(false);
    }
  }
  return (
    <View>
      <Copy>{display.windowLabel}</Copy>
      {display.timeNotice ? <Copy>{display.timeNotice}</Copy> : null}
      {display.reason ? <Copy>{display.reason}</Copy> : null}
      {supportsInputs && AsyncResult.isFailure(originalsResult) ? (
        <Copy>Could not load retained originals.</Copy>
      ) : null}
      {originalCursor ? (
        <Action
          label="First originals page"
          disabled={pending}
          onPress={() => {
            setOriginalCursor(undefined);
            setSelected(null);
            setIntent(null);
          }}
        />
      ) : null}
      {supportsInputs && originalPage?.nextCursor ? (
        <Action
          label="Next originals page"
          disabled={pending}
          onPress={() => {
            setOriginalCursor(originalPage.nextCursor!);
            setSelected(null);
            setIntent(null);
          }}
        />
      ) : null}
      {display.notice ? <Copy>{display.notice}</Copy> : null}
      {!allowed ? <Copy>Memory write permission is required to revert.</Copy> : null}
      {error ? <Copy>{error}</Copy> : null}
      {result ? <Copy>{presentMemoryRevertResult(result).label}</Copy> : null}
      {(!result || result.status === "refused") && available ? (
        <>
          <Copy>Choose the retained original to restore.</Copy>
          {display.restorableRevisionIds.map((id) => {
            const { number, pair } = originalDisplay(revertHistory, id);
            return (
              <View key={id}>
                <Action
                  label={`${selected === id ? "Selected original" : "Restore original"} ${number}`}
                  disabled={pending || intent !== null}
                  onPress={() => setSelected(id)}
                />
                <Copy>{pair?.payload?.text ?? "Retained original is too large to preview."}</Copy>
                {pair ? (
                  <Copy>
                    {formatMemoryTime(pair.revision.createdAtUtc)} ·{" "}
                    {pair.revision.provenance.provider ?? "User"} ·{" "}
                    {savedConnectionsById[pair.revision.provenance.environmentId]
                      ?.environmentLabel ?? "Unknown device"}
                  </Copy>
                ) : null}
              </View>
            );
          })}
          <Action
            label={intent ? "Retry revert request" : "Revert resolution"}
            disabled={!selected || pending}
            onPress={() => void submit()}
          />
          <Action
            label="Cancel revert"
            disabled={pending}
            onPress={() => {
              setSelected(null);
              setIntent(null);
              setError(null);
            }}
          />
        </>
      ) : null}
    </View>
  );
}

function MemorySource({
  environmentId,
  input,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: MemoryReadSourceInput;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [cursor, setCursor] = useState<string | undefined>();
  const atom = memory.readSource({
    environmentId,
    input: { ...input, ...(cursor ? { cursor } : {}) },
  });
  const result = useAtomValue(atom);
  const page = AsyncResult.isSuccess(result) ? Option.getOrNull(result.value) : null;
  return (
    <SettingsSection title="Original">
      <Action label="Close original" onPress={onClose} />
      <Copy>
        {page
          ? page.messages.map((message) => message.text).join("\n\n")
          : "Original unavailable. Check source permissions and the owner's connection."}
      </Copy>
      <Action label="Refresh original" onPress={() => registry.refresh(atom)} />
      <Action
        label="Next original page"
        disabled={!page?.nextCursor}
        onPress={() => setCursor(page?.nextCursor ?? undefined)}
      />
    </SettingsSection>
  );
}

function MemoryReport({ report }: { readonly report: Parameters<typeof presentMemoryReport>[0] }) {
  const view = presentMemoryReport(report);
  const navigation = useNavigation();
  const target = view.reportTarget;
  const config = useAtomValue(serverEnvironment.configValueAtom(target?.environmentId ?? null));
  const allowed = useEnvironmentScope(target?.environmentId ?? null, AuthOrchestrationReadScope);
  return (
    <View>
      <Copy>
        {view.label} · Automatic attempts: {view.automaticAttempts ?? "Unknown"}
      </Copy>
      {target ? (
        <Action
          label="Open report"
          disabled={!config || !allowed}
          onPress={() => {
            if (readEnvironmentScope(target.environmentId, AuthOrchestrationReadScope))
              navigation.navigate("Thread", {
                environmentId: target.environmentId,
                threadId: target.threadId,
              });
          }}
        />
      ) : null}
    </View>
  );
}

function MemoryEditor({
  params,
  memorySpaceId,
  scope,
  scopeLabel,
  item,
  onClose,
}: {
  readonly params: MemoryScreenParams & { environmentId: EnvironmentId };
  readonly memorySpaceId: MemorySpaceId;
  readonly scope: MemoryScope;
  readonly scopeLabel?: string;
  readonly item?: Extract<MemoryItem, { status: "active" }>;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [id] = useState(() => item?.memoryId ?? MemoryId.make(Crypto.randomUUID()));
  const draftAtom = useMemo(
    () =>
      memory.draftAtom({
        environmentId: params.environmentId,
        input: { memorySpaceId },
        draftId: `native:${id}`,
      }),
    [params.environmentId, memorySpaceId, id],
  );
  const text = useAtomValue(draftAtom);
  const setDraft = useAtomSet(draftAtom);
  const allowed = useAtomValue(memory.upsert.permissionAtom(params.environmentId));
  const upsert = useAtomCommand(memory.upsert);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<MemoryOperationId | null>(null);
  const [retry, setRetry] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    registry.set(draftAtom, { text: item?.payload.text ?? "", memoryIds: item ? [id] : [] });
    return () => {
      mounted.current = false;
      registry.set(draftAtom, null);
    };
  }, [registry, draftAtom, item, id]);
  async function save() {
    const current = registry.get(draftAtom);
    if (
      !current?.trim() ||
      busy.current ||
      !registry.get(memory.upsert.permissionAtom(params.environmentId))
    )
      return;
    intent.current ??= operationId();
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await upsert({
        environmentId: params.environmentId,
        input: {
          memorySpaceId,
          operationId: intent.current,
          memoryId: id,
          expectedHeads: item ? [item.revision.revisionId] : [],
          scope,
          assertionKind: item?.revision.assertionKind ?? "fact",
          payload: {
            text: current,
            evidence: item?.payload.evidence ?? [{ origin: "user", messageIds: [] }],
            derivedFromMemoryRevisions: item?.payload.derivedFromMemoryRevisions ?? [],
          },
          baseBoundary: null,
        },
      });
      if (
        !mounted.current ||
        registry.get(draftAtom) !== current ||
        !registry.get(memory.upsert.permissionAtom(params.environmentId))
      )
        return;
      if (AsyncResult.isSuccess(result)) {
        setError(
          `Request ${result.value.outcome}${result.value.pendingSync ? " · Propagation pending" : ""}`,
        );
        intent.current = null;
        if (result.value.outcome === "accepted" || result.value.outcome === "noop") onClose();
      } else if (AsyncResult.isFailure(result)) {
        setRetry(true);
        setError(`${failureMessage(result)} Retry uses the same request.`);
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <Action label="Close editor" onPress={onClose} />
      <Copy>Save to: {scopeLabel ?? memoryScopeLabel(scope)}</Copy>
      {text === null ? (
        <Copy>The draft is no longer available. Close and reopen this memory.</Copy>
      ) : (
        <>
          <Field
            label="Memory text"
            value={text}
            onChange={(value) => setDraft({ text: value, memoryIds: item ? [id] : [] })}
            disabled={pending || retry || !allowed}
            multiline
          />
          <Action
            label={retry ? "Retry save request" : "Save memory"}
            onPress={() => void save()}
            disabled={!allowed || pending || !text.trim()}
          />
        </>
      )}
      {error ? <Copy>{error}</Copy> : null}
    </ScreenScrollView>
  );
}

function MemoryStatusRows({ status }: { status: MemorySyncStatus }) {
  const processing = presentMemoryProcessing(status.processing, status.generationHold);
  const storage = presentMemoryStorage(status.storage);
  return (
    <SettingsSection title="Memory status">
      {[
        processing.coverage.label,
        storage.label,
        storage.searchLabel,
        ...storage.reasons,
        processing.pausedLabel,
        processing.checkingLabel,
        processing.heldLabel,
        processing.waitingLabel,
        processing.cleanupLabel,
        processing.receiveLabel,
        processing.reportLabel,
        processing.admissionLabel,
      ]
        .filter(Boolean)
        .map((label) => (
          <Copy key={label}>{label}</Copy>
        ))}
    </SettingsSection>
  );
}

function MemoryGeneration({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const live = useMemoryLifetime(environmentId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SettingsSection title="Memory">
      <Copy>
        GOAT summarizes finished conversations. Turning this off stops new summaries and keeps saved
        memories.
      </Copy>
      <SettingsSwitchRow
        label="Remember conversations"
        value={config?.settings.memoryEnabled ?? true}
        disabled={!allowed || !config || busy}
        onValueChange={(value) => {
          if (
            pending.current ||
            !registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))
          )
            return;
          pending.current = true;
          setBusy(true);
          void update({ environmentId, input: { patch: { memoryEnabled: value } } })
            .then((result) => {
              if (live())
                setNotice(
                  result._tag === "Success" ? "Memory updated." : "Could not update memory.",
                );
            })
            .finally(() => {
              pending.current = false;
              if (live()) setBusy(false);
            });
        }}
      />
      {notice ? <Copy>{notice}</Copy> : null}
    </SettingsSection>
  );
}

function MemoryAgentAccess({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const live = useMemoryLifetime(environmentId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <SettingsSection title="Agent memory access">
      <Copy>
        Allow agents in this environment to use memory. Sharing is managed separately. Turning this
        on does not increase saved task access.
      </Copy>
      <SettingsSwitchRow
        label="Allow agent memory access"
        value={config?.settings.enableAgentMemoryAccess ?? false}
        disabled={!allowed || !config || busy}
        onValueChange={(value) => {
          if (
            pending.current ||
            !registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId))
          )
            return;
          pending.current = true;
          setBusy(true);
          void update({ environmentId, input: { patch: { enableAgentMemoryAccess: value } } })
            .then((result) => {
              if (live())
                setNotice(
                  result._tag === "Success"
                    ? "Agent memory access updated."
                    : "Could not update agent memory access. Try again.",
                );
            })
            .finally(() => {
              pending.current = false;
              if (live()) setBusy(false);
            });
        }}
      />
      {notice ? <Copy>{notice}</Copy> : null}
    </SettingsSection>
  );
}

/** Bounded selection on this Settings history page; final approval and claim checks remain server-owned. */
function MemoryReportRetry({
  reports,
  environmentId,
  memorySpaceId,
  memoryId,
}: {
  reports: MemoryHistoryPage["reports"];
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  memoryId: MemoryId;
}) {
  const registry = useContext(RegistryContext);
  const allowed = useAtomValue(memory.resetReportAttempts.permissionAtom(environmentId));
  const reset = useAtomCommand(memory.resetReportAttempts, { reportFailure: false });
  const live = useMemoryLifetime(environmentId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const candidates = reports.filter((report) =>
    isMemoryReportRetryCandidate(report, environmentId),
  );
  return (
    <>
      {candidates.length ? (
        <Copy>
          Select up to 32 exhausted failed reports. Resetting attempts lets the delivery worker try
          again; it does not generate a new report.
        </Copy>
      ) : null}
      {candidates.map((report, index) => (
        <SettingsSwitchRow
          key={report.reportId}
          label={`Select exhausted report ${index + 1}`}
          value={selected.has(report.reportId)}
          disabled={!allowed || busy || (!selected.has(report.reportId) && selected.size >= 32)}
          onValueChange={(value) =>
            setSelected((old) => {
              const next = new Set(old);
              if (value && next.size < 32) next.add(report.reportId);
              else next.delete(report.reportId);
              return next;
            })
          }
        />
      ))}
      {candidates.length ? (
        <Action
          label="Retry selected reports"
          disabled={!selected.size || !allowed || busy}
          onPress={() => {
            if (
              pending.current ||
              !registry.get(memory.resetReportAttempts.permissionAtom(environmentId))
            )
              return;
            const reportIds = candidates
              .filter((report) => selected.has(report.reportId))
              .slice(0, 32)
              .map((report) => report.reportId);
            if (!reportIds.length) return;
            pending.current = true;
            setBusy(true);
            void reset({ environmentId, input: { memorySpaceId, environmentId, reportIds } })
              .then((result) => {
                if (!live()) return;
                if (result._tag === "Success") {
                  setNotice(presentMemoryReportReset(result.value).label);
                  setSelected(new Set());
                  registry.refresh(
                    memory.history({
                      environmentId,
                      input: { memorySpaceId, memoryId, limit: PAGE_SIZE },
                    }),
                  );
                } else
                  setNotice(
                    "Report retry was denied or could not be saved. Review the latest reports.",
                  );
              })
              .finally(() => {
                pending.current = false;
                if (live()) setBusy(false);
              });
          }}
        />
      ) : null}
      {notice ? <Copy>{notice}</Copy> : null}
    </>
  );
}
