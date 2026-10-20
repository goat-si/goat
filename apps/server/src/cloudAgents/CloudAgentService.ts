import {
  CLOUD_AGENT_PROVIDERS,
  type CloudAgentProvider,
  type CloudHolder,
  type CloudHoldersInput,
  CloudHoldersResult,
  CloudLaunchResult,
  type CloudLaunchInput,
  type CloudRunForgetInput,
  type CloudRunForgetResult,
  type CloudRunListInput,
  type CloudRunListResult,
  type CloudRunRegisterInput,
  CloudRunRegisterResult,
  type CloudRunSummary,
  type OrchestrationV2CloudTask,
  type ProviderInteractionMode,
  ProviderDiagnoseResult,
  ProviderHostMatrixResult,
  type ProviderHostCloudReadiness,
  ProviderInstanceId,
  OrchestratorMcpFailure,
  type RuntimeMode,
  ThreadId,
  isCloudAgentProvider,
  parseCloudRunReference,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunchMcp from "../mcp/ThreadLaunchMcpService.ts";
import { newCommandId } from "../mcp/threadAccess.ts";
import {
  decodeProviderThreadPayload,
  decodeThreadPayload,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as HostSync from "../provider/ProviderHostSync.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SshDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  CAN_FOLLOW_REGISTERED,
  CLOUD_AGENT_LABELS,
  chooseHolder,
  holderFromCloudCell,
  holderFromDiagnoses,
} from "./cloudHolders.ts";

/**
 * Routes cloud agent launches to an environment that holds the provider's login, and tracks
 * cloud runs other agents launched. Holders come from the provider × host matrix cloud column,
 * which is the same diagnosis goat_cloud_holders reduces. Nothing here reads, copies, or
 * forwards a credential. See docs/internals/cloud-credential-holders.md.
 *
 * @module cloudAgents/CloudAgentService
 */

/** A holder's answer is reused this long, so a launch does not re-run every sign-in probe. */
export const HOLDER_CACHE_TTL_MS = 60_000;
const HOST_DEADLINE_MS = 120_000;
/** How long a registration waits to learn whether its holder can follow the run. */
export const REGISTER_ATTACH_WAIT_MS = 20_000;
const MISSING_HOLDERS = "does not have goat_cloud_holders";
const MISSING_MATRIX = "does not have goat_provider_host_matrix";

const decodeHolders = Schema.decodeUnknownEffect(CloudHoldersResult);
const decodeMatrix = Schema.decodeUnknownEffect(ProviderHostMatrixResult);
const decodeDiagnosis = Schema.decodeUnknownEffect(ProviderDiagnoseResult);
const decodeLaunch = Schema.decodeUnknownEffect(CloudLaunchResult);
const decodeRegister = Schema.decodeUnknownEffect(CloudRunRegisterResult);

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** These describe the caller, not a host, so they fail the whole call. */
const callerFailure = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "runtime_mode_escalation_denied" ||
  error.code === "interaction_mode_escalation_denied";

export interface StartModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface CloudAgentServiceShape {
  readonly holders: (
    scope: McpInvocationScope,
    input: CloudHoldersInput,
  ) => Effect.Effect<CloudHoldersResult, OrchestratorMcpFailure>;
  readonly launch: (
    scope: McpInvocationScope,
    input: CloudLaunchInput,
    modes: Effect.Effect<StartModes, OrchestratorMcpFailure>,
  ) => Effect.Effect<CloudLaunchResult, OrchestratorMcpFailure>;
  readonly register: (
    scope: McpInvocationScope,
    input: CloudRunRegisterInput,
    modes: Effect.Effect<StartModes, OrchestratorMcpFailure>,
  ) => Effect.Effect<CloudRunRegisterResult, OrchestratorMcpFailure>;
  readonly list: (
    input: CloudRunListInput,
  ) => Effect.Effect<CloudRunListResult, OrchestratorMcpFailure>;
  readonly forget: (
    input: CloudRunForgetInput,
  ) => Effect.Effect<CloudRunForgetResult, OrchestratorMcpFailure>;
}

export class CloudAgentService extends Context.Service<CloudAgentService, CloudAgentServiceShape>()(
  "goat/cloudAgents/CloudAgentService",
) {}

interface StoredRun {
  readonly summary: CloudRunSummary;
  readonly externalId: string | undefined;
}

/** A project whose repository identity names owner/name, compared without case. */
export function projectMatchesRepository(
  identity:
    | {
        readonly canonicalKey: string;
        readonly owner?: string;
        readonly name?: string;
        readonly origin?: { readonly canonicalKey: string };
      }
    | null
    | undefined,
  repo: string,
): boolean {
  if (!identity) return false;
  const wanted = repo.toLowerCase();
  if (
    identity.owner &&
    identity.name &&
    `${identity.owner}/${identity.name}`.toLowerCase() === wanted
  )
    return true;
  return [identity.canonicalKey, identity.origin?.canonicalKey].some(
    (key) =>
      key !== undefined &&
      key
        .toLowerCase()
        .replace(/\.git$/u, "")
        .endsWith(`/${wanted}`),
  );
}

const readCloudRuns = Effect.fn("CloudAgentService.readRuns")(function* (limit: number) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly provider_json: string; readonly thread_json: string }>`
    SELECT p.payload_json AS provider_json, t.payload_json AS thread_json
    FROM orchestration_v2_projection_provider_threads AS p
    JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
    WHERE p.driver IN ('claudeCloud', 'cursorCloud', 'devinCloud')
      AND p.owner_node_id IS NULL
      AND t.deleted_at IS NULL
      AND json_type(p.payload_json, '$.cloudTask') = 'object'
    ORDER BY p.updated_at DESC, p.provider_thread_id ASC
    LIMIT ${limit}
  `;
  const runs: Array<StoredRun> = [];
  for (const row of rows) {
    const providerThread = yield* decodeProviderThreadPayload(row.provider_json).pipe(
      Effect.option,
    );
    const thread = yield* decodeThreadPayload(row.thread_json).pipe(Effect.option);
    if (Option.isNone(providerThread) || Option.isNone(thread)) continue;
    const task = providerThread.value.cloudTask;
    const driver = providerThread.value.driver;
    if (task === undefined || !isCloudAgentProvider(driver)) continue;
    runs.push({
      externalId: providerThread.value.nativeThreadRef?.nativeId ?? undefined,
      summary: {
        threadId: thread.value.id,
        provider: driver,
        instanceId: providerThread.value.providerInstanceId,
        title: thread.value.title,
        status: task.status,
        tracking: task.tracking,
        ...(task.url === undefined ? {} : { url: task.url }),
        ...(task.prUrl === undefined ? {} : { prUrl: task.prUrl }),
        repository: task.source.repository,
        ...(task.branch !== undefined
          ? { branch: task.branch }
          : task.source.branch !== "HEAD"
            ? { branch: task.source.branch }
            : {}),
        ...(thread.value.externalLauncher === undefined
          ? {}
          : { launchedBy: thread.value.externalLauncher }),
        registered: task.attach === "registered",
        updatedAt: task.updatedAt,
      },
    });
  }
  return runs;
});
/** Cloud runs this environment follows or links, newest first. Needs only the database. */
export const listCloudRuns = (input: CloudRunListInput) =>
  readCloudRuns(input.limit ?? 50).pipe(
    Effect.map((stored): CloudRunListResult => ({
      runs: stored
        .map((run) => run.summary)
        .filter((run) => input.provider === undefined || run.provider === input.provider),
    })),
    Effect.mapError(() => failure("orchestration_error", "Could not read cloud runs here.")),
  );

const make = Effect.gen(function* () {
  const hostSync = yield* HostSync.ProviderHostSync;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const hosts = yield* HostThreads.HostThreadsMcpService;
  const dispatch = yield* SshDispatch.SshRemoteDispatch;
  const sql = yield* SqlClient.SqlClient;
  const launches = yield* ThreadLaunchMcp.ThreadLaunchMcpService;
  const projects = yield* Project.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const cache = yield* Ref.make(
    new Map<string, { readonly at: number; readonly holders: ReadonlyArray<CloudHolder> }>(),
  );
  const registering = yield* Semaphore.make(1);

  const providersOf = (provider: CloudAgentProvider | undefined) =>
    provider === undefined ? CLOUD_AGENT_PROVIDERS : [provider];

  const runs = (limit: number) =>
    readCloudRuns(limit).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => failure("orchestration_error", "Could not read cloud runs here.")),
    );

  /** Every registration, not just recent ones, so an old run is never registered twice. */
  const findRegistered = (provider: CloudAgentProvider, externalId: string) =>
    sql<{ readonly provider_json: string; readonly thread_json: string }>`
      SELECT p.payload_json AS provider_json, t.payload_json AS thread_json
      FROM orchestration_v2_projection_provider_threads AS p
      JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
      WHERE p.driver = ${provider}
        AND p.owner_node_id IS NULL
        AND t.deleted_at IS NULL
        AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ${externalId}
        AND json_extract(p.payload_json, '$.cloudTask.attach') = 'registered'
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(undefined)
          : Effect.all([
              decodeProviderThreadPayload(rows[0].provider_json),
              decodeThreadPayload(rows[0].thread_json),
            ]).pipe(
              Effect.map(([providerThread, thread]) => ({
                summary: {
                  threadId: thread.id,
                  tracking: providerThread.cloudTask?.tracking ?? ("link-only" as const),
                },
              })),
            ),
      ),
      Effect.mapError(() => failure("orchestration_error", "Could not read registered runs.")),
    );

  const holdersFromCloud = (
    cloud: ProviderHostCloudReadiness,
    host: string | null,
    runtime: CloudHolder["runtime"],
    provider: CloudAgentProvider | undefined,
  ) =>
    providersOf(provider).map((driver) =>
      holderFromCloudCell({ provider: driver, host, runtime, cell: cloud[driver] }),
    );

  const notReadyLocal = (provider: CloudAgentProvider | undefined): ReadonlyArray<CloudHolder> =>
    providersOf(provider).map((driver) => ({
      provider: driver,
      host: null,
      ready: false,
      runtime: "current" as const,
      reason: "Could not read this environment's provider settings.",
    }));

  const localHolders = Effect.fn("CloudAgentService.localHolders")(function* (
    scope: McpInvocationScope,
    provider: CloudAgentProvider | undefined,
  ) {
    return yield* hostSync.matrix({ localOnly: true, cloud: true }, { kind: "mcp", scope }).pipe(
      Effect.map((result) => {
        const row = result.rows.find((item) => item.host === null) ?? result.rows[0];
        return row?.cloud === undefined
          ? notReadyLocal(provider)
          : holdersFromCloud(row.cloud, null, "current", provider);
      }),
      Effect.catch((error) =>
        error._tag === "EnvironmentAuthorizationError"
          ? Effect.fail(failure("capability_denied", error.message))
          : Effect.succeed(notReadyLocal(provider)),
      ),
    );
  });

  /** Older hosts lack goat_cloud_holders: their own diagnosis still says who holds a login. */
  const legacyHolders = (
    scope: McpInvocationScope,
    host: string,
    provider: CloudAgentProvider | undefined,
  ) =>
    Effect.forEach(providersOf(provider), (driver) =>
      hosts
        .readOnHost(
          scope,
          {
            host,
            tool: "goat_provider_diagnose",
            arguments: { driver },
            timeoutMs: HOST_DEADLINE_MS,
            requireReady: true,
          },
          decodeDiagnosis,
        )
        .pipe(
          Effect.map((result) =>
            holderFromDiagnoses({
              provider: driver,
              host,
              diagnoses: result.diagnoses,
              runtime: "update_required",
            }),
          ),
        ),
    );

  const remoteHolders = Effect.fn("CloudAgentService.remoteHolders")(function* (
    scope: McpInvocationScope,
    host: string,
    provider: CloudAgentProvider | undefined,
  ) {
    const unreachable = (message: string): ReadonlyArray<CloudHolder> =>
      providersOf(provider).map((driver) => ({
        provider: driver,
        host,
        ready: false,
        runtime: "unreachable" as const,
        reason: message.slice(0, 1000),
      }));
    /** goat_cloud_holders, then diagnosis, for a matrix that has no cloud column. */
    const olderRuntime = hosts
      .readOnHost(
        scope,
        {
          host,
          tool: "goat_cloud_holders",
          arguments: { ...(provider === undefined ? {} : { provider }), local: true },
          timeoutMs: HOST_DEADLINE_MS,
          requireReady: true,
        },
        decodeHolders,
      )
      .pipe(
        Effect.map((result): ReadonlyArray<CloudHolder> =>
          result.holders.map((holder) => ({ ...holder, host })),
        ),
        Effect.catch((error) =>
          callerFailure(error)
            ? Effect.fail(error)
            : error.message.includes(MISSING_HOLDERS)
              ? legacyHolders(scope, host, provider).pipe(
                  Effect.catch((legacy) =>
                    callerFailure(legacy)
                      ? Effect.fail(legacy)
                      : Effect.succeed(unreachable(legacy.message)),
                  ),
                )
              : Effect.succeed(unreachable(error.message)),
        ),
      );
    const outdatedMatrix = (error: OrchestratorMcpFailure) =>
      error.message.includes(MISSING_MATRIX);
    return yield* hosts
      .readOnHost(
        scope,
        {
          host,
          tool: "goat_provider_host_matrix",
          arguments: { localOnly: true, cloud: true },
          timeoutMs: HOST_DEADLINE_MS,
          requireReady: true,
        },
        decodeMatrix,
      )
      .pipe(
        Effect.flatMap((result) => {
          const cloud = result.rows[0]?.cloud;
          return cloud === undefined
            ? olderRuntime
            : Effect.succeed(holdersFromCloud(cloud, host, "current", provider));
        }),
        Effect.catch((error) =>
          callerFailure(error)
            ? Effect.fail(error)
            : outdatedMatrix(error)
              ? olderRuntime
              : Effect.succeed(unreachable(error.message)),
        ),
      );
  });

  const cached = <E>(
    key: string,
    refresh: boolean,
    read: Effect.Effect<ReadonlyArray<CloudHolder>, E>,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const hit = (yield* Ref.get(cache)).get(key);
      if (!refresh && hit !== undefined && now - hit.at < HOLDER_CACHE_TTL_MS) return hit.holders;
      const holders = yield* read;
      // An unreachable host is asked again next time; a disconnect must not stick for a minute.
      yield* Ref.update(cache, (current) => {
        const next = new Map(current);
        if (holders.some((holder) => holder.runtime === "unreachable")) next.delete(key);
        else next.set(key, { at: now, holders });
        return next;
      });
      return holders;
    });

  const holders: CloudAgentServiceShape["holders"] = Effect.fn("CloudAgentService.holders")(
    function* (scope, input) {
      const refresh = input.refresh === true;
      const suffix = input.provider ?? "*";
      const local = yield* cached(`local|${suffix}`, refresh, localHolders(scope, input.provider));
      if (input.local === true) return { holders: local };
      const aliases = [...(yield* dispatch.connectedHosts)].toSorted();
      // Hosts that dropped off are forgotten, so their cached answers cannot route a launch.
      yield* Ref.update(cache, (current) => {
        const next = new Map(current);
        for (const key of next.keys()) {
          const host = key.slice(0, key.lastIndexOf("|"));
          if (host !== "local" && !aliases.includes(host)) next.delete(key);
        }
        return next;
      });
      const remote = yield* Effect.forEach(
        aliases,
        (host) => cached(`${host}|${suffix}`, refresh, remoteHolders(scope, host, input.provider)),
        { concurrency: 4 },
      );
      return { holders: [...local, ...remote.flat()] };
    },
  );

  const pick = Effect.fn("CloudAgentService.pick")(function* (
    scope: McpInvocationScope,
    provider: CloudAgentProvider,
    preference: string | undefined,
  ) {
    const table = yield* holders(scope, {
      provider,
      ...(preference === "local" ? { local: true } : {}),
    });
    const choice = chooseHolder(provider, table.holders, preference);
    if (!choice.ok) return yield* failure("provider_unavailable", choice.message);
    return choice.holder;
  });

  const projectFor = Effect.fn("CloudAgentService.projectFor")(function* (repo: string) {
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError(() =>
        failure("orchestration_error", "Could not read this environment's projects."),
      ),
    );
    const project = snapshot.projects.find(
      (candidate) =>
        candidate.deletedAt === null &&
        projectMatchesRepository(candidate.repositoryIdentity, repo),
    );
    if (project === undefined)
      return yield* failure(
        "invalid_request",
        `No project here has origin ${repo}. Add it with goat_project_clone or goat_project_create on this holder first.`,
      );
    return project;
  });

  const modelFor = Effect.fn("CloudAgentService.modelFor")(function* (instanceId: string) {
    const provider = (yield* registry.getProviders).find(
      (candidate) => candidate.instanceId === instanceId,
    );
    return (
      provider?.models.find((model) => model.isDefault)?.slug ??
      provider?.models[0]?.slug ??
      "default"
    );
  });

  const mapLaunchError = (error: OrchestratorMcpFailure) => error;

  const launch: CloudAgentServiceShape["launch"] = Effect.fn("CloudAgentService.launch")(
    function* (scope, input, modes) {
      const holder = yield* pick(scope, input.provider, input.holder);
      if (input.dryRun === true) return { holder, dryRun: true };
      if (holder.host !== null) {
        const result = yield* hosts.writeOnHost(
          scope,
          {
            host: holder.host,
            tool: "goat_cloud_launch",
            arguments: { ...input, holder: "local" },
          },
          decodeLaunch,
        );
        return { ...result, holder: { ...result.holder, host: holder.host } };
      }
      const project = yield* projectFor(input.repo);
      const instanceId = holder.instanceId ?? ProviderInstanceId.make(input.provider);
      const started = yield* modes;
      const launched = yield* launches
        .launch(
          scope,
          {
            projectId: project.id,
            title:
              input.title ?? `${CLOUD_AGENT_LABELS[input.provider]}: ${input.prompt.slice(0, 60)}`,
            modelSelection: { instanceId, model: yield* modelFor(instanceId) },
            workspaceStrategy: {
              type: "root",
              ...(input.branch === undefined ? {} : { branch: input.branch }),
            },
            message: input.prompt,
            standingInstructions: false,
            ...(input.notifyWebhook === undefined ? {} : { notifyWebhook: input.notifyWebhook }),
          },
          started,
        )
        .pipe(Effect.mapError(mapLaunchError));
      return {
        holder,
        dryRun: false,
        threadId: launched.threadId,
        note: "The cloud run starts in this thread; goat_cloud_run_list and goat_thread_status follow it.",
      };
    },
  );

  const waitForAttach = Effect.fn("CloudAgentService.waitForAttach")(function* (
    threadId: ThreadId,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + REGISTER_ATTACH_WAIT_MS;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const run = (yield* runs(200)).find((candidate) => candidate.summary.threadId === threadId);
      const task = run?.summary;
      if (task?.tracking === "link-only") return "link-only" as const;
      if (task !== undefined && task.status !== "running" && task.status !== "submitting")
        return task.tracking;
      if (task !== undefined && (yield* attachAccepted(threadId))) return task.tracking;
      yield* Effect.sleep(Duration.millis(500));
    }
    return "pending" as const;
  });

  /** The attach run started observing: the task names its run and the run is running. */
  const attachAccepted = (threadId: ThreadId) =>
    sql<{ readonly running: number }>`
      SELECT COUNT(*) AS running FROM orchestration_v2_projection_provider_threads
      WHERE thread_id = ${threadId}
        AND json_extract(payload_json, '$.cloudTask.acceptedAppRunId') IS NOT NULL
        AND json_extract(payload_json, '$.cloudTask.error') IS NULL
        AND status = 'active'
    `.pipe(
      Effect.map((rows) => (rows[0]?.running ?? 0) > 0),
      Effect.mapError(() => failure("orchestration_error", "Could not read the registered run.")),
    );

  const register: CloudAgentServiceShape["register"] = Effect.fn("CloudAgentService.register")(
    function* (scope, input, modes) {
      const reference = parseCloudRunReference(input.provider, input);
      if (!reference.ok) return yield* failure("invalid_request", reference.message);
      // Without a preference, a ready holder anywhere tracks it; with none, this environment
      // keeps it link-only.
      const target =
        input.holder ??
        (CAN_FOLLOW_REGISTERED[input.provider]
          ? yield* holders(scope, { provider: input.provider }).pipe(
              Effect.map((table) => {
                const choice = chooseHolder(input.provider, table.holders, undefined);
                return choice.ok ? (choice.holder.host ?? "local") : "local";
              }),
            )
          : "local");
      if (target !== "local") {
        const result = yield* hosts.writeOnHost(
          scope,
          {
            host: target,
            tool: "goat_cloud_run_register",
            arguments: {
              ...input,
              externalId: reference.externalId,
              url: undefined,
              holder: "local",
            },
          },
          decodeRegister,
        );
        return { ...result, holder: { ...result.holder, host: target } };
      }
      const outcome = yield* registering.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* findRegistered(input.provider, reference.externalId);
          const [holder] = (yield* holders(scope, { provider: input.provider, local: true }))
            .holders;
          const self: CloudHolder = holder ?? {
            provider: input.provider,
            host: null,
            ready: false,
            runtime: "current",
          };
          if (existing !== undefined)
            return {
              holder: self,
              threadId: existing.summary.threadId,
              externalId: reference.externalId,
              url: reference.url,
              created: false,
              tracking: existing.summary.tracking,
              note: "Already registered; nothing changed.",
            };
          const follow = self.ready && CAN_FOLLOW_REGISTERED[input.provider];
          const label = CLOUD_AGENT_LABELS[input.provider];
          const linkOnlyNote = !CAN_FOLLOW_REGISTERED[input.provider]
            ? `GOAT keeps only the link: ${label} sessions started outside GOAT cannot be followed through this holder's sign-in yet.`
            : `GOAT keeps only the link: no ${label} login here can follow it (${self.reason ?? "not ready"}).`;
          const project = yield* projectFor(input.repo);
          const instanceId = self.instanceId ?? ProviderInstanceId.make(input.provider);
          const now = DateTime.formatIso(yield* DateTime.now);
          const cloudTask: OrchestrationV2CloudTask = {
            taskId: reference.externalId,
            url: reference.url,
            ...(input.title === undefined ? {} : { title: input.title }),
            status: "running",
            tracking: follow ? "polled" : "link-only",
            ...(follow ? {} : { error: linkOnlyNote }),
            // The source branch is required; "HEAD" stands for "unknown" and is never shown.
            source: {
              repository: `https://github.com/${input.repo}`,
              branch: input.branch ?? "HEAD",
            },
            localChangesExcluded: true,
            updatedAt: now,
            attach: "registered",
          };
          const threadId = ThreadId.make(
            `cloud-run:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          );
          const started = yield* modes;
          yield* launches.launch(
            scope,
            {
              projectId: project.id,
              title: input.title ?? `${label} run by ${input.launchedBy}`,
              modelSelection: { instanceId, model: yield* modelFor(instanceId) },
              standingInstructions: false,
              // The attach run never sends this to the provider; it records what GOAT follows.
              ...(follow
                ? {
                    message: `Follow ${label} run ${reference.url}, launched by ${input.launchedBy}.`,
                  }
                : {}),
              ...(input.notifyWebhook === undefined ? {} : { notifyWebhook: input.notifyWebhook }),
            },
            started,
            {
              threadId,
              externalLauncher: input.launchedBy,
              importedNativeThread: {
                ref: {
                  driver: input.provider as never,
                  nativeId: reference.externalId,
                  strength: "strong",
                },
                cloudTask,
              },
            },
          );
          return { fresh: { holder: self, threadId, follow, linkOnlyNote } } as const;
        }),
      );
      if (!("fresh" in outcome)) return outcome;
      const { holder: self, threadId, follow, linkOnlyNote } = outcome.fresh;
      // Outside the lock: one slow attach must not hold up other registrations.
      const tracking = follow ? yield* waitForAttach(threadId) : ("link-only" as const);
      return {
        holder: self,
        threadId,
        externalId: reference.externalId,
        url: reference.url,
        created: true,
        tracking,
        ...(tracking === "link-only"
          ? {
              note: follow
                ? "This holder's sign-in cannot see this run, so GOAT keeps only its link."
                : linkOnlyNote,
            }
          : tracking === "pending"
            ? { note: "Still attaching; goat_cloud_run_list shows the outcome." }
            : { note: "GOAT follows this run and reports when it finishes." }),
      };
    },
  );

  const list: CloudAgentServiceShape["list"] = (input) =>
    listCloudRuns(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const forget: CloudAgentServiceShape["forget"] = Effect.fn("CloudAgentService.forget")(
    function* (input) {
      const run = (yield* runs(200)).find(
        (candidate) => candidate.summary.threadId === input.threadId,
      );
      if (run === undefined) return { threadId: input.threadId, forgotten: false };
      if (!run.summary.registered)
        return yield* failure(
          "invalid_request",
          "Only registered runs can be forgotten here; GOAT-launched runs are ordinary threads.",
        );
      // Deleting the thread stops GOAT following the run. The cloud run itself is never cancelled.
      yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: yield* newCommandId().pipe(Effect.provideService(Crypto.Crypto, crypto)),
          threadId: input.threadId,
        })
        .pipe(Effect.mapError(() => failure("orchestration_error", "Could not forget this run.")));
      return { threadId: input.threadId, forgotten: true };
    },
  );

  return CloudAgentService.of({ holders, launch, register, list, forget });
});

export const layer = Layer.effect(CloudAgentService, make);
