import {
  CLOUD_AGENT_PROVIDERS,
  EnvironmentAuthorizationError,
  type AuthSessionId,
  type CloudAgentProvider,
  type CloudHolder,
  type Handoff,
  HandoffError,
  type HandoffRespondInput,
  ProviderDriverKind,
  ProviderHostSyncError,
  type ProviderHostMatrixInput,
  ProviderHostMatrixResult,
  type ProviderHostProviderState,
  type ProviderHostRow,
  type ProviderHostSyncDriver,
  type ProviderInstanceId,
  type ProviderSyncCancelInput,
  type ProviderSyncInput,
  type ProviderSyncLogin,
  ProviderSyncResultJson,
  type ProviderSyncResult,
  ProviderSyncState,
  type ProviderSyncStatusInput,
  type ProviderAuthState,
  type RuntimeMode,
  type ServerProvider,
  isCloudAgentProvider,
} from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@goat/shared/shell";
import { servedRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { cloudReadinessFromHolders, holderFromDiagnoses } from "../cloudAgents/cloudHolders.ts";

import packageJson from "../../package.json" with { type: "json" };
import * as SessionStore from "../auth/SessionStore.ts";
import * as CuaDriver from "../cua/CuaDriver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { judgeRemoteHost, LOCAL_HOST_COMPATIBILITY } from "../mcp/hostStatusModel.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  authorizeApprovalRequest,
  authorizeSshHost,
  type SshHostCaller,
} from "../sshRemote/SshHostAuthorization.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import { HOST_SYNC_PATH, makeApprovedSyncs, syncApprovalCard } from "./approvedSyncs.ts";
import * as ProviderAuth from "./ProviderAuthService.ts";
import * as Diagnosis from "./ProviderDiagnosisService.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { checksCli, ProviderCliGate } from "./ProviderCliGate.ts";
import { installArtifact } from "./ProviderHostSyncArtifact.ts";
import { installFailure, runInstaller, withProbedCli } from "./ProviderHostSyncInstall.ts";
import {
  describeInstall,
  describeInstallFailure,
  forgetCommandMisses,
  hostPlatform,
  installCommand,
  installMethod,
  PROVIDER_HOST_SYNC_DRIVERS,
  parseDeviceLogin,
  recipeFor,
  relayableBrowserUrl,
  versionCore,
} from "./ProviderHostSyncRecipes.ts";
import {
  askFailed,
  callerKey,
  cancelsSettled,
  cancelTask,
  claimCancel,
  classify,
  type Failure,
  fail,
  type HostTask,
  lostTrack,
  ownerSession,
  type RemoteFailure,
  remoteHostState,
  type SyncOperation,
  unverifiedRemote,
  update,
} from "./ProviderHostSyncTasks.ts";

export { HOST_SYNC_PATH };
const MATRIX_TOOL = "goat_provider_host_matrix";
const SYNC_TOOL = "goat_provider_sync";
const STATUS_TOOL = "goat_provider_sync_status" as const;
const CANCEL_TOOL = "goat_provider_sync_cancel";
/** Shared with sync status polling and cancel. Cloud diagnosis uses its own deadline. */
const MATRIX_DEADLINE_MS = 20_000;
/** Holder diagnosis probes three CLIs, so only a cloud matrix row waits this long. */
const CLOUD_MATRIX_DEADLINE_MS = 120_000;
const CALL_DEADLINE_MS = 60_000;
const LOGIN_DEADLINE = Duration.minutes(15);
const REMOTE_POLL = Duration.seconds(3);
const REMOTE_DEADLINE_MS = 30 * 60_000;
const SYNC_RETENTION_MS = 2 * 60 * 60_000;
const OUTPUT_LIMIT = 16_384;
const MAX_ACTIVE_SYNCS = 8;
const MAX_CONCURRENT_INSTALLERS = 2;

const decodeMatrix = Schema.decodeUnknownEffect(ProviderHostMatrixResult);
const decodeSyncResult = Schema.decodeUnknownEffect(ProviderSyncResultJson);
const decodeSyncState = Schema.decodeUnknownEffect(ProviderSyncState);

export class ProviderHostSync extends Context.Service<
  ProviderHostSync,
  {
    readonly matrix: (
      input: ProviderHostMatrixInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderHostMatrixResult, Failure>;
    readonly sync: (
      input: ProviderSyncInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderSyncResult, Failure>;
    readonly status: (
      input: ProviderSyncStatusInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderSyncState, Failure>;
    readonly cancel: (
      input: ProviderSyncCancelInput,
      caller: SshHostCaller,
    ) => Effect.Effect<ProviderSyncState, Failure>;
    /** Approving the handoff starts the sync under the approver's own session. */
    readonly respondHandoff: (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Handoff, HandoffError | EnvironmentAuthorizationError>;
    /** Waits until every host of a sync has finished, without polling. */
    readonly awaitDone: (syncId: string) => Effect.Effect<ProviderSyncState, ProviderHostSyncError>;
    /** Starts approved syncs a stop left unstarted and settles ones it interrupted. */
    readonly resumeApprovals: Effect.Effect<void, HandoffError>;
  }
>()("goat/provider/ProviderHostSync") {}

const make = Effect.gen(function* () {
  const sessions = yield* SessionStore.SessionStore;
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const diagnosis = yield* Diagnosis.ProviderDiagnosisService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const auth = yield* ProviderAuth.ProviderAuthService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* Threads.ThreadManagementService;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
  >();
  const crypto = yield* Crypto.Crypto;
  const hostname = yield* HostProcess.Hostname;
  const runtimePlatform = yield* HostProcess.Platform;
  const runtimeArch = yield* HostProcess.Architecture;
  const cua = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  const platform = hostPlatform(runtimePlatform);
  const operations = new Map<string, SyncOperation>();
  const installers = yield* Semaphore.make(MAX_CONCURRENT_INSTALLERS);
  const cliGate = yield* Effect.serviceOption(ProviderCliGate);

  const readCeiling = (caller: SshHostCaller) =>
    authorizeSshHost(sessions, caller, "orchestration:read").pipe(
      Effect.as("approval-required" as RuntimeMode),
    );

  /**
   * Installing software needs a live providers:manage grant. An approved sync reaches another
   * machine as an outside client holding the approver's grant there. Thread agents never pass,
   * whatever their runtime mode: they get an approval handoff instead.
   */
  const writeCeiling = (caller: SshHostCaller): Effect.Effect<RuntimeMode, Failure> => {
    if (caller.kind === "mcp" && (caller.scope.thread !== undefined || !caller.scope.client))
      return Effect.fail(
        new EnvironmentAuthorizationError({
          requiredScope: "providers:manage",
          message: "Installing a provider needs a person's approval.",
        }),
      );
    return authorizeSshHost(sessions, caller, "providers:manage").pipe(
      Effect.as("full-access" as RuntimeMode),
    );
  };

  const canManage = (caller: SshHostCaller) =>
    writeCeiling(caller).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const snapshotFor = (all: ReadonlyArray<ServerProvider>, driver: ProviderHostSyncDriver) => {
    const own = all.filter(
      (provider) => provider.driver === driver && provider.executionLocation !== "cloud",
    );
    return own.find((provider) => provider.instanceId === driver) ?? own[0];
  };

  const localProviders = Effect.gen(function* () {
    const all = yield* providers.getProviders;
    return yield* Effect.forEach(PROVIDER_HOST_SYNC_DRIVERS, (driver) =>
      Effect.gen(function* () {
        const recipe = recipeFor(driver);
        const snapshot = snapshotFor(all, driver);
        const onPath =
          snapshot?.installed === true
            ? true
            : yield* Effect.forEach([recipe.binary, ...(recipe.aliases ?? [])], (name) =>
                resolveCommandPath(name).pipe(Effect.orElseSucceed(() => null)),
              ).pipe(Effect.map((found) => found.some((path) => path !== null)));
        const authStatus = snapshot?.auth.status;
        return {
          driver: ProviderDriverKind.make(driver),
          displayName: snapshot?.displayName ?? recipe.displayName,
          installed: onPath,
          version: snapshot?.installed ? snapshot.version : null,
          auth:
            authStatus === "authenticated"
              ? "signed_in"
              : authStatus === "unauthenticated"
                ? "signed_out"
                : "unknown",
          installMethod: installMethod(driver, platform),
          loginMethod:
            snapshot?.setup?.canAuthenticate === true
              ? "goat"
              : recipe.deviceLogin !== undefined
                ? "device_code"
                : "terminal",
        } satisfies ProviderHostProviderState;
      }),
    );
  });

  /**
   * Runs this machine is following. Routing prefers the least loaded holder.
   * Missing the database answers zero rather than failing the matrix.
   */
  const activeCloudRuns = Effect.gen(function* () {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) return new Map<CloudAgentProvider, number>();
    const rows = yield* sql.value<{ readonly driver: string; readonly runs: number }>`
      SELECT p.driver AS driver, COUNT(*) AS runs
      FROM orchestration_v2_projection_provider_threads AS p
      JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
      WHERE p.driver IN ('claudeCloud', 'cursorCloud', 'devinCloud')
        AND p.owner_node_id IS NULL
        AND t.deleted_at IS NULL
        AND json_type(p.payload_json, '$.cloudTask') = 'object'
        AND json_extract(p.payload_json, '$.cloudTask.status') IN ('running', 'submitting')
        AND IFNULL(json_extract(p.payload_json, '$.cloudTask.tracking'), '') != 'link-only'
      GROUP BY p.driver
    `.pipe(Effect.orElseSucceed(() => []));
    const counts = new Map<CloudAgentProvider, number>();
    for (const row of rows)
      if (isCloudAgentProvider(row.driver)) counts.set(row.driver, Number(row.runs));
    return counts;
  });

  /** Same reduction goat_cloud_holders uses, so the matrix column and routing cannot drift. */
  const localCloud = Effect.gen(function* () {
    const snapshots = yield* providers.getProviders;
    const counts = yield* activeCloudRuns;
    const hub = yield* settings.getSettings.pipe(
      Effect.map(({ hub }) => hub.enabled && hub.cloudHolder === "hub"),
      Effect.orElseSucceed(() => false),
    );
    const label = (instanceId: string) => {
      const auth = snapshots.find((provider) => provider.instanceId === instanceId)?.auth;
      return auth?.label ?? auth?.email;
    };
    const holders = yield* Effect.forEach(
      CLOUD_AGENT_PROVIDERS,
      (provider) =>
        diagnosis.diagnose({ driver: ProviderDriverKind.make(provider) }).pipe(
          Effect.map((result) =>
            holderFromDiagnoses({
              provider,
              host: null,
              diagnoses: result.diagnoses,
              runtime: "current",
              accountLabel: label,
              activeRuns: counts.get(provider) ?? 0,
            }),
          ),
          Effect.catch((): Effect.Effect<CloudHolder> =>
            Effect.succeed({
              provider,
              host: null,
              ready: false,
              runtime: "current",
              reason: "Could not read this environment's provider settings.",
            }),
          ),
        ),
      { concurrency: 3 },
    );
    // A hub that cannot read a login still claims the launch: another holder is another account.
    return cloudReadinessFromHolders(
      hub ? holders.map((holder) => ({ ...holder, hub: true })) : holders,
    );
  });

  const localRow = (includeCloud: boolean) =>
    Effect.gen(function* () {
      const row = {
        host: null,
        status: "ok" as const,
        platform: runtimePlatform,
        arch: runtimeArch,
        goatVersion: packageJson.version,
        protocol: servedRuntimeProtocolRanges(),
        installs: "verified" as const,
        ...(Option.isSome(cua) ? { computerUse: yield* cua.value.computerUse } : {}),
      };
      if (!includeCloud) {
        return { ...row, providers: yield* localProviders } satisfies ProviderHostRow;
      }
      const [providerRows, cloud] = yield* Effect.all([localProviders, localCloud], {
        concurrency: "unbounded",
      });
      return { ...row, providers: providerRows, cloud } satisfies ProviderHostRow;
    });

  const callRemote = (
    caller: SshHostCaller,
    call: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
      readonly timeoutMs: number;
      /** Following a sync this machine started reuses the session that started it. */
      readonly asOwner?: boolean;
    },
  ) =>
    dispatch
      .callHostTool(
        {
          host: call.host,
          tool: call.tool,
          arguments: call.arguments,
          writes: call.writes,
          timeoutMs: call.timeoutMs,
          approvals: false,
          // Only reached after writeCeiling, so the caller holds providers:manage here.
          ...(call.writes || call.asOwner === true ? { providersManage: true } : {}),
          requireReady: true,
        },
        call.writes || call.asOwner === true ? writeCeiling(caller) : readCeiling(caller),
      )
      .pipe(Effect.mapError(classify));

  const remoteRow = (caller: SshHostCaller, host: string, includeCloud: boolean, asOwner = false) =>
    callRemote(caller, {
      host,
      tool: MATRIX_TOOL,
      arguments: includeCloud ? { localOnly: true, cloud: true } : { localOnly: true },
      writes: false,
      asOwner,
      timeoutMs: includeCloud ? CLOUD_MATRIX_DEADLINE_MS : MATRIX_DEADLINE_MS,
    }).pipe(
      Effect.flatMap((raw) =>
        decodeMatrix(raw).pipe(
          Effect.mapError((): RemoteFailure => ({
            status: "update_runtime",
            message: `Update GOAT on ${host}: it returned an unreadable provider list.`,
          })),
        ),
      ),
      Effect.map((result): ProviderHostRow => {
        const row = result.rows[0];
        if (row === undefined) return { host, status: "unreachable", providers: [] };
        // Host status and this matrix share one verdict, from served protocols (ADR-0019).
        const { versionMismatch: _v, compatibility: _c, message: _m, ...reported } = row;
        const remote = { host, serverVersion: row.goatVersion, protocol: row.protocol };
        return { ...reported, host, ...judgeRemoteHost(remote, LOCAL_HOST_COMPATIBILITY) };
      }),
      Effect.catch((failure: RemoteFailure) =>
        Effect.succeed<ProviderHostRow>({
          host,
          status: failure.status === "refused" ? "unreachable" : failure.status,
          // People read this in Settings; the status tells agents which tool to call.
          message:
            failure.status === "not_ready"
              ? `This machine has no ready connection to GOAT on ${host}. Connect it in Settings → Connections, then refresh.`
              : failure.message,
          providers: [],
        }),
      ),
    );

  const matrix = Effect.fn("ProviderHostSync.matrix")(function* (
    input: ProviderHostMatrixInput,
    caller: SshHostCaller,
  ) {
    yield* readCeiling(caller);
    const includeCloud = input.cloud === true;
    const local = yield* localRow(includeCloud);
    if (input.localOnly === true) return { rows: [local] };
    // Connected hosts plus ssh-config aliases; known_hosts lists every server ever reached.
    const hosts = input.hosts ?? [
      ...(yield* dispatch.connectedHosts),
      ...(yield* dispatch.listHosts({ probe: false }).pipe(
        Effect.map((all) =>
          all.filter((host) => host.source === "ssh-config").map((host) => host.alias),
        ),
        Effect.orElseSucceed(() => []),
      )),
    ];
    const rows = yield* Effect.forEach(
      [...new Set(hosts)],
      (host) => remoteRow(caller, host, includeCloud),
      { concurrency: 6 },
    );
    return { rows: [local, ...rows] };
  });

  const view = (operation: SyncOperation): ProviderSyncState => ({
    syncId: operation.syncId,
    driver: operation.driver,
    version: operation.version,
    login: operation.login,
    startedAt: operation.startedAt,
    done: operation.hosts.every((task) => task.finished),
    hosts: operation.hosts.map((task) => task.state),
  });

  /** Uninterruptible so a cancel that interrupts the last host's fiber cannot drop the record. */
  const settleIfDone = (operation: SyncOperation) =>
    Effect.suspend(() =>
      operation.hosts.some((task) => !task.finished)
        ? Effect.void
        : Effect.forEach(operation.settlers.splice(0), (settle) => settle(view(operation)), {
            discard: true,
          }).pipe(
            Effect.andThen(Deferred.succeed(operation.allFinished, undefined)),
            Effect.uninterruptible,
          ),
    );

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cutoff = now - SYNC_RETENTION_MS;
    for (const [id, operation] of operations)
      if (operation.startedAtMs < cutoff) operations.delete(id);
  });

  const newOperation = (
    driver: ProviderHostSyncDriver,
    version: string | null,
    login: boolean,
    hosts: ReadonlyArray<string | null>,
    owners: ReadonlyArray<string>,
    settle?: SyncOperation["settlers"][number],
  ) =>
    Effect.gen(function* () {
      yield* prune;
      const active = [...operations.values()].filter((operation) =>
        operation.hosts.some((task) => !task.finished),
      );
      const same = active.find(
        (operation) =>
          operation.driver === driver &&
          operation.version === version &&
          operation.login === login &&
          operation.hosts.length === hosts.length &&
          operation.hosts.every((task) => hosts.includes(task.state.host)),
      );
      if (same !== undefined) {
        // No yield since `active` was read, so the sync cannot finish before this settler joins.
        for (const owner of owners) same.owners.add(owner);
        if (settle !== undefined) same.settlers.push(settle);
        return { operation: same, fresh: false };
      }
      if (active.length >= MAX_ACTIVE_SYNCS)
        return yield* fail(
          "unavailable",
          "Several provider syncs are already running here. Wait for one to finish.",
        );
      const now = yield* DateTime.now;
      const operation: SyncOperation = {
        syncId: `sync_${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
        driver,
        version,
        login,
        startedAt: DateTime.formatIso(now),
        startedAtMs: DateTime.toEpochMillis(now),
        hosts: hosts.map((host) => ({
          state: { host, phase: "queued", version: null },
          finished: false,
        })),
        owners: new Set(owners),
        fibers: [],
        allFinished: yield* Deferred.make<void>(),
        settlers: settle === undefined ? [] : [settle],
      };
      for (const task of operation.hosts) task.onFinished = settleIfDone(operation);
      operations.set(operation.syncId, operation);
      return { operation, fresh: true };
    });

  const fork = (
    operation: SyncOperation,
    effect: Effect.Effect<unknown, never, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(effect.pipe(Effect.provideContext(context)), scope);
      operation.fibers.push(fiber);
    });

  const instanceFor = (driver: ProviderHostSyncDriver) =>
    Effect.gen(function* () {
      const all = yield* instances.listInstances;
      const own = all.filter((instance) => instance.driverKind === driver);
      return own.find((instance) => instance.instanceId === driver) ?? own[0];
    });

  /** The sync's instance as its own probe sees it, when that probe runs a CLI from PATH. */
  const cliProbe = (driver: ProviderHostSyncDriver) =>
    Effect.gen(function* () {
      const instance = yield* instanceFor(driver);
      const cached = snapshotFor(yield* providers.getProviders, driver);
      if (Option.isNone(cliGate) || instance === undefined || !checksCli(driver, cached?.cli))
        return undefined;
      return (fresh: boolean) => cliGate.value.probe(instance.instanceId, { fresh });
    });

  const refreshDriver = (driver: ProviderHostSyncDriver) =>
    Effect.gen(function* () {
      const all = yield* instances.listInstances;
      yield* Effect.forEach(
        all.filter((instance) => instance.driverKind === driver),
        (instance) => providers.refreshInstance(instance.instanceId).pipe(Effect.ignore),
        { discard: true },
      );
      return snapshotFor(yield* providers.getProviders, driver);
    });

  const goatLogin = (
    task: HostTask,
    driver: ProviderHostSyncDriver,
    instanceId: ProviderInstanceId,
    owner: string,
  ) =>
    Effect.gen(function* () {
      const name = recipeFor(driver).displayName;
      const openHost = {
        type: "open_host",
        instruction: `Finish ${name} sign-in in GOAT on ${hostname}: Settings, Providers, ${name}.`,
      } satisfies ProviderSyncLogin;
      const loginFrom = (state: ProviderAuthState): ProviderSyncLogin => {
        const interaction = state.interaction;
        if (interaction?.type === "deviceCode")
          return { type: "device_code", url: interaction.url, userCode: interaction.userCode };
        if (interaction?.type === "browser") {
          const url = relayableBrowserUrl(driver, interaction.url, interaction.acceptsCallback);
          if (url !== null && !interaction.requiresConsent) return { type: "browser", url };
        }
        return openHost;
      };
      const started = yield* auth.start({ instanceId }, owner);
      let flowId = started.flowId;
      // A cancelled or timed-out sync must not leave the sign-in waiting on this host.
      const stopFlow = Effect.suspend(() =>
        flowId === null
          ? Effect.void
          : auth.cancel({ instanceId, flowId }, owner).pipe(Effect.ignore),
      );
      yield* update(task, { phase: "signing_in", login: loginFrom(started) });
      const watched = yield* auth.subscribe({ instanceId }, owner).pipe(
        Stream.takeUntil((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
        Stream.runForEach((state) => {
          flowId = state.flowId ?? flowId;
          return state.phase === "succeeded"
            ? update(task, { phase: "signed_in", login: undefined }, true)
            : state.phase === "failed" || state.phase === "cancelled"
              ? update(
                  task,
                  {
                    phase: state.phase === "failed" ? "failed" : "cancelled",
                    login: undefined,
                    message:
                      "Sign-in did not finish. Start it again from this host's provider settings.",
                  },
                  true,
                )
              : update(task, { login: loginFrom(state) });
        }),
        Effect.timeoutOption(LOGIN_DEADLINE),
        Effect.onInterrupt(() => stopFlow),
      );
      if (Option.isNone(watched)) yield* stopFlow;
    });

  /** The CLI's own device login; only the parsed page and code leave this process. */
  const deviceLogin = (
    task: HostTask,
    driver: ProviderHostSyncDriver,
    instanceId: ProviderInstanceId | undefined,
  ) =>
    Effect.gen(function* () {
      const recipe = recipeFor(driver);
      const device = recipe.deviceLogin!;
      const entries = deriveProviderInstanceConfigMap(yield* settings.getSettings);
      const env = yield* mergeProviderInstanceEnvironment(
        instanceId === undefined ? undefined : entries[instanceId]?.environment,
      );
      const resolved = yield* resolveSpawnCommand(recipe.binary, device.args, { env });
      yield* update(task, { phase: "signing_in" });
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          shell: resolved.shell,
          env,
          stdin: "ignore",
        }),
      );
      yield* Effect.addFinalizer(() => Effect.ignore(child.kill({ forceKillAfter: "1 second" })));
      let seen = "";
      let relayed = false;
      const decoder = new TextDecoder();
      const read = (chunk: Uint8Array) =>
        Effect.gen(function* () {
          if (relayed) return;
          seen = (seen + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_LIMIT);
          const login = parseDeviceLogin(driver, seen);
          if (login === null) return;
          relayed = true;
          seen = "";
          yield* update(task, { login });
        });
      const [, , exitCode] = yield* Effect.all(
        [
          Stream.runForEach(child.stdout, read),
          Stream.runForEach(child.stderr, read),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0)
        return yield* update(
          task,
          {
            phase: "failed",
            login: { type: "terminal", command: recipe.terminalLogin },
            message: "Sign-in did not finish. Run the sign-in command on that machine.",
          },
          true,
        );
      yield* refreshDriver(driver);
      yield* update(task, { phase: "signed_in", login: undefined }, true);
    }).pipe(Effect.scoped, Effect.timeoutOption(LOGIN_DEADLINE));

  const runLocal = (operation: SyncOperation, task: HostTask, caller: SshHostCaller) =>
    Effect.gen(function* () {
      const owner = ownerSession(caller);
      const driver = operation.driver;
      const recipe = recipeFor(driver);
      const probe = yield* cliProbe(driver);
      const row = localProviders.pipe(Effect.map((all) => all.find((p) => p.driver === driver)));
      const before = withProbedCli(yield* row, probe && (yield* probe(false)));
      const sameVersion =
        before?.installed === true &&
        (operation.version === null || before.version === null
          ? operation.version === null
          : versionCore(before.version) === operation.version);
      const command = sameVersion ? null : installCommand(driver, platform, operation.version);
      if (!sameVersion) {
        if (command === null)
          return yield* update(
            task,
            {
              phase: "failed",
              message:
                operation.version !== null && installCommand(driver, platform, null) !== null
                  ? `GOAT installs only the ${recipe.displayName} release it pins, not ${operation.version}. Sync latest, or install it with the vendor's instructions.`
                  : `GOAT cannot install ${recipe.displayName} on ${runtimePlatform}. Install it with the vendor's instructions.`,
            },
            true,
          );
        const tool = yield* resolveCommandPath(command.command).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (tool === null)
          return yield* update(
            task,
            {
              phase: "failed",
              message:
                command.method === "npm"
                  ? `Install Node.js and npm on this machine first; ${recipe.displayName} installs with npm.`
                  : `${command.command} is missing on this machine; the ${recipe.displayName} installer needs it.`,
            },
            true,
          );
        // Authority can lapse while this waits for the probe and other installs.
        const result = yield* installers.withPermits(1)(
          writeCeiling(caller).pipe(
            Effect.andThen(
              update(task, {
                phase: "installing",
                ran: describeInstall(command),
              }),
            ),
            Effect.andThen(
              command.method === "npm"
                ? runInstaller(spawner, command.command, command.args)
                : installArtifact(spawner, command.displayName, command.artifact).pipe(
                    Effect.as({ exitCode: 0 as number | null, output: "" }),
                    Effect.provideContext(context),
                  ),
            ),
            Effect.result,
          ),
        );
        if (Result.isFailure(result))
          return yield* update(task, { phase: "failed", message: result.failure.message }, true);
        if (result.success.exitCode !== 0)
          return yield* update(
            task,
            {
              phase: "failed",
              message: describeInstallFailure(result.success.exitCode, result.success.output),
            },
            true,
          );
        yield* forgetCommandMisses;
      }
      const snapshot = yield* refreshDriver(driver);
      const answer = probe && (yield* probe(true));
      const after = withProbedCli(yield* row, answer);
      const host = { env: yield* HostProcess.Environment, platform: runtimePlatform };
      const failed = installFailure(recipe, operation.version, { after, answer, host }, command);
      if (failed !== undefined || after === undefined)
        return yield* update(task, { phase: "failed", ...failed }, true);
      yield* update(task, {
        phase: "installed",
        version: after.version,
        ...(sameVersion ? { message: "Already installed." } : {}),
      });
      if (after.auth === "signed_in") return yield* update(task, { phase: "signed_in" }, true);
      // Installed only: say what a person runs there before its first thread.
      const terminal = { login: { type: "terminal", command: recipe.terminalLogin } } as const;
      if (!operation.login) return yield* update(task, terminal, true);
      const instance = yield* instanceFor(driver);
      if (snapshot?.setup?.canAuthenticate === true && instance !== undefined)
        return yield* goatLogin(task, driver, instance.instanceId, owner);
      if (recipe.deviceLogin !== undefined)
        return yield* deviceLogin(task, driver, instance?.instanceId);
      yield* update(task, terminal, true);
    }).pipe(
      Effect.catchCause(() =>
        task.finished || task.cancelling
          ? Effect.void
          : update(
              task,
              {
                phase: "failed",
                message: "Setup stopped unexpectedly. Check the provider in Settings.",
              },
              true,
            ),
      ),
      Effect.ensuring(
        Effect.suspend(() =>
          task.finished || task.cancelling ? Effect.void : update(task, {}, true),
        ),
      ),
    );

  const runRemote = (
    operation: SyncOperation,
    task: HostTask,
    host: string,
    caller: SshHostCaller,
  ) =>
    Effect.gen(function* () {
      // Read first, under the install's own authority: an older GOAT may pipe a vendor script.
      const refused = unverifiedRemote(
        yield* remoteRow(caller, host, false, true),
        operation.driver,
        recipeFor(operation.driver).displayName,
      );
      if (refused !== undefined) return yield* update(task, refused, true);
      yield* update(task, { phase: "installing" });
      // Forked into the service scope so cancelling this task leaves the call running: the
      // remote may already be installing, and only its answer names the sync to cancel there.
      const starting = yield* callRemote(caller, {
        host,
        tool: SYNC_TOOL,
        arguments: {
          driver: operation.driver,
          version: operation.version ?? "latest",
          login: operation.login,
        },
        writes: true,
        timeoutMs: CALL_DEADLINE_MS,
      }).pipe(
        Effect.flatMap((raw) => decodeSyncResult(raw).pipe(Effect.mapError(unreadable(host)))),
        Effect.forkIn(scope),
      );
      task.starting = starting;
      const started = yield* Fiber.join(starting);
      if (started.kind !== "started")
        return yield* update(
          task,
          {
            phase: "failed",
            message: `GOAT on ${host} asked for a person's approval there instead.`,
          },
          true,
        );
      task.remoteSyncId = started.sync.syncId;
      let current = started.sync;
      const deadline = (yield* Clock.currentTimeMillis) + REMOTE_DEADLINE_MS;
      while (true) {
        const remote = current.hosts[0];
        yield* update(task, remote ? remoteHostState(operation, remote, host) : {}, current.done);
        if (current.done) return;
        if ((yield* Clock.currentTimeMillis) > deadline)
          return yield* lostTrack(task, `${host} did not finish within 30 minutes.`);
        yield* Effect.sleep(REMOTE_POLL);
        current = yield* callRemote(caller, {
          host,
          tool: STATUS_TOOL,
          arguments: { syncId: started.sync.syncId },
          writes: false,
          asOwner: true,
          timeoutMs: MATRIX_DEADLINE_MS,
        }).pipe(
          Effect.flatMap((raw) => decodeSyncState(raw).pipe(Effect.mapError(unreadable(host)))),
        );
      }
    }).pipe(
      // A claimed host is the cancel's to finish: it knows whether the start may have run.
      Effect.catch((failure: RemoteFailure) =>
        task.cancelling
          ? Effect.void
          : lostTrack(
              task,
              failure.status === "update_runtime"
                ? `Update GOAT on ${host} to sync providers there. ${failure.message}`
                : failure.message,
              {
                phase: failure.status === "update_runtime" ? "update_runtime" : "failed",
                unsent: failure.unsent === true,
              },
            ),
      ),
      // An interrupted start call means this process is stopping; the restart path records that.
      Effect.catchCause((cause) =>
        task.finished || task.cancelling || Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : lostTrack(task, `Lost track of ${host}.`),
      ),
    );

  const unreadable = (host: string) => (): RemoteFailure => ({
    status: "update_runtime",
    message: `GOAT on ${host} returned an unreadable sync state.`,
  });

  const resolveRequest = (input: ProviderSyncInput) =>
    Effect.gen(function* () {
      const localVersion = (yield* localProviders).find(
        (provider) => provider.driver === input.driver,
      )?.version;
      const requested = input.version ?? (localVersion ? versionCore(localVersion) : "latest");
      return {
        driver: input.driver,
        version: requested === "latest" || requested === null ? null : requested,
        login: input.login ?? true,
        hosts: input.hosts === undefined ? [null] : [...new Set(input.hosts)],
      };
    });
  type SyncRequest = Effect.Success<ReturnType<typeof resolveRequest>>;

  const launch = (
    request: SyncRequest,
    caller: SshHostCaller,
    owners: ReadonlyArray<string>,
    settle?: SyncOperation["settlers"][number],
  ) =>
    Effect.gen(function* () {
      const { driver, version, login, hosts } = request;
      const created = yield* newOperation(driver, version, login, hosts, owners, settle);
      const { operation } = created;
      if (created.fresh)
        yield* Effect.forEach(
          operation.hosts,
          (task) =>
            fork(
              operation,
              task.state.host === null
                ? runLocal(operation, task, caller)
                : runRemote(operation, task, task.state.host, caller),
            ),
          { discard: true },
        );
      return view(operation);
    });

  const start = (input: ProviderSyncInput, caller: SshHostCaller) =>
    resolveRequest(input).pipe(
      Effect.flatMap((request) => launch(request, caller, [callerKey(caller)])),
      Effect.map((sync) => ({ kind: "started" as const, sync })),
    );

  const approvedSyncs = yield* makeApprovedSyncs(handoffs, {
    prepare: (input, sessionId, requester) =>
      authorizeSshHost(sessions, { kind: "client", sessionId }, "providers:manage").pipe(
        Effect.andThen(resolveRequest(input)),
        Effect.map((request) => ({ request, sessionId, requester })),
        Effect.provideContext(context),
      ),
    launch: ({ request, sessionId, requester }, settle) =>
      launch(request, { kind: "client", sessionId }, [`session:${sessionId}`, requester], settle),
    isTracked: (syncId) => operations.has(syncId),
  });

  const requestApproval = (
    input: ProviderSyncInput,
    caller: Extract<SshHostCaller, { kind: "mcp" }>,
  ) =>
    Effect.gen(function* () {
      const thread = caller.scope.thread;
      if (thread === undefined || caller.scope.readOnly)
        return yield* new EnvironmentAuthorizationError({
          requiredScope: "providers:manage",
          message: "Installing a provider needs providers:manage.",
        });
      const environmentId = yield* environment.getEnvironmentId;
      if (caller.scope.environmentId !== environmentId)
        return yield* fail("invalid_request", "Ask again in a thread on this environment.");
      yield* authorizeApprovalRequest(caller.scope);
      const run = (yield* threads
        .getThreadSnapshot(thread.threadId)
        .pipe(
          Effect.mapError(() => fail("unavailable", "Could not read the requesting thread.")),
        )).projection.runs.at(-1);
      if (!run || run.rootNodeId === null)
        return yield* fail("invalid_request", "Ask again while this thread is running.");
      const card = syncApprovalCard(
        input,
        recipeFor(input.driver).displayName,
        input.hosts?.join(", ") ?? hostname,
        {
          requestedBy: { threadId: thread.threadId, providerInstanceId: thread.providerInstanceId },
          environmentId,
          runId: run.id,
          nodeId: run.rootNodeId,
          expiresAt: DateTime.add(yield* DateTime.now, { minutes: 15 }),
        },
      );
      const handoff = yield* handoffs.create(card).pipe(Effect.mapError(askFailed));
      return {
        kind: "needs_human" as const,
        handoff,
        next: { after: "approval" as const, call: STATUS_TOOL },
      };
    });

  const sync = Effect.fn("ProviderHostSync.sync")(function* (
    input: ProviderSyncInput,
    caller: SshHostCaller,
  ) {
    if (caller.kind === "mcp" && caller.scope.thread !== undefined)
      return yield* requestApproval(input, caller);
    yield* writeCeiling(caller);
    return yield* start(input, caller);
  });

  const find = (syncId: string) =>
    Effect.suspend(() => {
      const operation = operations.get(syncId);
      return operation === undefined
        ? Effect.fail(
            fail("not_found", "No such sync. It may have finished more than two hours ago."),
          )
        : Effect.succeed(operation);
    });

  const status = Effect.fn("ProviderHostSync.status")(function* (
    input: ProviderSyncStatusInput,
    caller: SshHostCaller,
  ) {
    yield* readCeiling(caller);
    if (input.syncId === undefined && input.handoffId === undefined)
      return yield* fail("invalid_request", "Pass syncId or handoffId.");
    const approved =
      input.syncId === undefined && input.handoffId !== undefined
        ? yield* approvedSyncs.lookup(input.handoffId, caller)
        : undefined;
    const syncId = input.syncId ?? approved?.syncId ?? "";
    // A settled approval keeps its result, without sign-in codes, after this process forgets it.
    if (!operations.has(syncId) && approved?.result !== undefined) return approved.result;
    const operation = yield* find(syncId);
    const state = view(operation);
    if (operation.owners.has(callerKey(caller)) || (yield* canManage(caller))) return state;
    // Sign-in codes go only to whoever started or approved the sync.
    return {
      ...state,
      hosts: state.hosts.map(({ login: _login, ...host }) => host),
    };
  });

  const cancel = Effect.fn("ProviderHostSync.cancel")(function* (
    input: ProviderSyncCancelInput,
    caller: SshHostCaller,
  ) {
    const operation = yield* find(input.syncId);
    // An agent may stop a sync it asked for; anyone else needs to manage providers.
    if (!operation.owners.has(callerKey(caller))) yield* writeCeiling(caller);
    else if (caller.kind === "mcp" && caller.scope.thread !== undefined)
      yield* authorizeApprovalRequest(caller.scope);
    else yield* authorizeSshHost(sessions, caller, "orchestration:operate");
    const stopping = yield* claimCancel(operation, scope, (pending) =>
      Effect.forEach(operation.fibers, Fiber.interrupt, { discard: true }).pipe(
        Effect.andThen(
          Effect.forEach(
            pending,
            (task) =>
              cancelTask(task, operation, (host, syncId) =>
                callRemote(caller, {
                  host,
                  tool: CANCEL_TOOL,
                  arguments: { syncId },
                  writes: true,
                  timeoutMs: MATRIX_DEADLINE_MS,
                }).pipe(Effect.flatMap((raw) => decodeSyncState(raw))),
              ),
            { concurrency: "unbounded", discard: true },
          ),
        ),
        Effect.provideContext(context),
      ),
    );
    yield* Fiber.await(stopping);
    return view(operation);
  });

  const respondHandoff = Effect.fn("ProviderHostSync.respondHandoff")(function* (
    input: HandoffRespondInput,
    sessionId: AuthSessionId,
  ) {
    if (input.action === "completed")
      yield* authorizeSshHost(sessions, { kind: "client", sessionId }, "providers:manage");
    return yield* approvedSyncs.respond(input, sessionId);
  });

  const provided =
    <A extends ReadonlyArray<unknown>, B, E>(
      method: (...args: A) => Effect.Effect<B, E, FileSystem.FileSystem | Path.Path>,
    ) =>
    (...args: A) =>
      method(...args).pipe(Effect.provideContext(context));
  return ProviderHostSync.of({
    matrix: provided(matrix),
    sync: provided(sync),
    status: provided(status),
    cancel: provided(cancel),
    respondHandoff: provided(respondHandoff),
    awaitDone: (syncId) =>
      find(syncId).pipe(
        Effect.tap((operation) =>
          Deferred.await(operation.allFinished).pipe(Effect.andThen(cancelsSettled(operation))),
        ),
        Effect.map(view),
      ),
    resumeApprovals: approvedSyncs.resume,
  });
});

export const layer = Layer.effect(ProviderHostSync, make);
