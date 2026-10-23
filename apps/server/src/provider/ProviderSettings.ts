/**
 * Provider settings changes for MCP callers: the writes Settings → Providers
 * makes, through the same ServerSettingsService.updateProviderInstance call.
 *
 * A caller makes the change itself when it may manage providers: a client
 * session holding a live providers:manage, or a live full-access thread whose
 * goatclaw profile allows providers.manage (every full-access thread while
 * goatclaw is off). Any other thread gets a provider.settings approval
 * handoff; approving it applies the stored change under the approving
 * person's session, recording each effect as it goes (ProviderSettingsProgress.ts)
 * so a restart resumes only what it can prove. Every outcome is written to
 * audit_events.
 */
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  CLOUD_SIBLING_DRIVERS,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type Handoff,
  HandoffError,
  type HandoffReadInput,
  type HandoffRespondInput,
  isCloudSiblingDriver,
  isDevinAcpRegistryInstance,
  OrchestratorMcpFailure,
  PROVIDER_SETTINGS_HANDOFF_PATH,
  PROVIDER_SETUP_HANDOFF_PATH,
  ProviderAddInput,
  ProviderDriverKind,
  type ProviderDiagnoseOnHostInput,
  type ProviderDiagnoseOnHostResult,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceSummary,
  ProviderLinkInput,
  type ProviderManageResult,
  ProviderManageResultJson,
  ProviderRemoveInput,
  ProviderUpdateInput,
  resolveProviderInstanceEnabled,
  type EnvironmentAuthorizationError,
  type RuntimeMode,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@goat/contracts";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../auth/SessionStore.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import { McpInvocationContext, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { assertLiveCaller, loadCaller } from "../mcp/threadAccess.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import { authorizeApprovalRequest } from "../sshRemote/SshHostAuthorization.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { instanceFingerprint } from "./CodexRouteService.ts";
import {
  decodeProgress,
  approvalError,
  encodeProgress,
  setupProgress,
  type ProviderSettingsEffect,
  type ProviderSettingsOutcome,
  type ProviderSettingsProgress,
} from "./ProviderSettingsProgress.ts";

const Request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("update"), input: ProviderUpdateInput }),
  Schema.Struct({ action: Schema.Literal("add"), input: ProviderAddInput }),
  Schema.Struct({ action: Schema.Literal("link"), input: ProviderLinkInput }),
  Schema.Struct({ action: Schema.Literal("remove"), input: ProviderRemoveInput }),
]);
export type ProviderSettingsRequest = typeof Request.Type;
const Approval = Schema.Struct({ version: Schema.Literal(1), request: Request });
const decodeApproval = Schema.decodeUnknownEffect(Approval);
const SetupIntent = Schema.Struct({
  version: Schema.Literal(1),
  instanceId: Schema.optional(ProviderInstanceId),
});
const decodeSetupIntent = Schema.decodeUnknownEffect(SetupIntent);
const decodeRemote = Schema.decodeUnknownEffect(ProviderManageResultJson);

const TOOLS = {
  update: "goat_provider_update",
  add: "goat_provider_add",
  link: "goat_provider_link",
  remove: "goat_provider_remove",
} as const;
const REMOTE_DEADLINE_MS = 180_000;
const DENIED = "providers_manage_denied";
const DRIVER_KINDS: ReadonlySet<string> = new Set(BUILT_IN_DRIVERS.map((d) => d.driverKind));
const driverName = (driver: string) =>
  BUILT_IN_DRIVERS.find((d) => d.driverKind === driver)?.metadata.displayName ?? driver;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const invalid = (message: string) => failure("invalid_request", message);
const denied = (message: string) => failure("capability_denied", message);
const deniedAtCommit = () =>
  new ServerSettingsError({ settingsPath: "", operation: "normalize", reason: DENIED });

type Decision =
  | { readonly kind: "direct"; readonly actor: string; readonly profile: string }
  | { readonly kind: "approval" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const targetOf = (request: ProviderSettingsRequest) => {
  const subject =
    request.action === "add"
      ? (request.input.instanceId ?? request.input.acpAgentId ?? request.input.driver ?? "new")
      : request.input.instanceId;
  return `${subject}@${request.input.host ?? "local"}`;
};

export const mergeConfig = (base: unknown, patch: Readonly<Record<string, unknown>> = {}) => {
  const next: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
};

export const mergeEnvironment = (
  base: ProviderInstanceConfig["environment"],
  patch: ProviderUpdateInput["environment"],
): ProviderInstanceConfig["environment"] => {
  if (patch === undefined) return base;
  const byName = new Map((base ?? []).map((variable) => [variable.name, variable]));
  for (const change of patch) {
    if (change.value === null) {
      byName.delete(change.name);
      continue;
    }
    byName.set(change.name, {
      name: change.name,
      value: change.value,
      sensitive: change.sensitive ?? byName.get(change.name)?.sensitive ?? false,
    });
  }
  return [...byName.values()];
};

export const summarize = (
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
): ProviderInstanceSummary => ({
  instanceId,
  driver: instance.driver,
  ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
  enabled: resolveProviderInstanceEnabled(instance),
  environment: (instance.environment ?? []).map((variable) => variable.name),
  configKeys: isRecord(instance.config) ? Object.keys(instance.config).toSorted() : [],
});

/** What the person is asked to approve. Built from ids and keys only, never agent text or values. */
export const describeRequest = (request: ProviderSettingsRequest): string => {
  switch (request.action) {
    case "update": {
      const input = request.input;
      const parts = [
        input.enabled === true ? "turn it on" : input.enabled === false ? "turn it off" : null,
        input.displayName !== undefined ? "rename it" : null,
        input.accentColor !== undefined ? "change its color" : null,
        input.config ? `change its settings: ${Object.keys(input.config).join(", ")}` : null,
        input.environment
          ? `change environment variables: ${input.environment.map((v) => v.name).join(", ")}`
          : null,
        input.defaultModel ? `make ${input.defaultModel.model} the default model` : null,
        input.install ? "install its registry agent" : null,
      ].filter((part) => part !== null);
      return `Change provider ${input.instanceId}: ${parts.length > 0 ? parts.join("; ") : "no changes"}.`;
    }
    case "add": {
      const input = request.input;
      const driver = input.driver ?? (input.acpAgentId ? "acpRegistry" : "a provider");
      const agent = input.acpAgentId ? ` running ACP Registry agent ${input.acpAgentId}` : "";
      const link = input.linkTo ? `, then make ${input.linkTo} use it for sign-in` : "";
      return `Add a ${driverName(driver)} provider${agent}${link}.`;
    }
    case "link":
      return `Make ${request.input.instanceId} use ${request.input.siblingInstanceId} for its executable and sign-in.`;
    case "remove":
      return `Remove provider ${request.input.instanceId} from Settings.`;
  }
};

export class ProviderSettings extends Context.Service<
  ProviderSettings,
  {
    readonly manage: (
      request: ProviderSettingsRequest,
      scope: McpInvocationScope,
    ) => Effect.Effect<ProviderManageResult, OrchestratorMcpFailure>;
    /**
     * Marks diagnosis fixes this caller can apply as agent fixes. Others stay
     * with a person, who approves the change a fix's call would request.
     */
    readonly presentDiagnosis: (
      result: ProviderDiagnoseOnHostResult,
      scope: McpInvocationScope,
    ) => Effect.Effect<ProviderDiagnoseOnHostResult>;
    readonly respond: (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Handoff, HandoffError | EnvironmentAuthorizationError>;
    /** Applies approvals that completed before a restart cut their application short. */
    readonly resumeContinuations: Effect.Effect<void, HandoffError>;
    /**
     * What GOAT did with an approved settings change, while it runs and for a day after. The
     * handoff's state says a person approved; this says whether the change was applied.
     */
    readonly readChange: (
      input: HandoffReadInput,
    ) => Effect.Effect<Pick<ProviderSettingsProgress, "effects" | "outcome"> | null, HandoffError>;
  }
>()("goat/provider/ProviderSettings") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const profiles = yield* Profiles.PermissionProfiles;
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* Threads.ThreadManagementService;
  const sessions = yield* SessionStore.SessionStore;
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);

  const audit = Effect.fn("ProviderSettings.audit")(
    function* (
      who: { readonly actor: string; readonly profile: string },
      request: ProviderSettingsRequest,
      outcome: "applied" | "needs_human" | "failed" | "unknown_outcome",
      decisionId?: string,
    ) {
      const time = DateTime.formatIso(yield* DateTime.now);
      const target = targetOf(request);
      yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${time}, ${who.actor}, ${who.profile}, ${`provider.${request.action}`}, ${target}, ${outcome}, ${decisionId ?? null})`;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Provider settings audit row not written.", cause),
    ),
  );

  const decide = Effect.fn("ProviderSettings.decide")(function* (
    scope: McpInvocationScope,
    host: string | undefined,
  ) {
    if (scope.readOnly === true || scope.client?.access === "read-only")
      return yield* denied("This caller has read-only access.");
    if (scope.thread === undefined) {
      if (
        scope.client === undefined ||
        scope.reauthorize === undefined ||
        !scope.grantedScopes?.includes(AuthProvidersManageScope)
      )
        return yield* denied("Changing providers needs a client signed in with providers:manage.");
      yield* scope
        .reauthorize([AuthProvidersManageScope])
        .pipe(Effect.mapError((error) => denied(error.message)));
      return {
        kind: "direct",
        actor: `client:${scope.client.sessionId}`,
        profile: "person",
      } satisfies Decision as Decision;
    }
    const caller = yield* loadCaller().pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(Threads.ThreadManagementService, threads),
    );
    yield* assertLiveCaller(caller);
    if (caller.limits.runtimeMode !== "full-access" || caller.limits.interactionMode !== "default")
      return { kind: "approval" } satisfies Decision as Decision;
    const checked = yield* profiles.check(
      scope,
      "providers.manage",
      host === undefined ? {} : { host },
    );
    if (!checked.ok) return { kind: "approval" } satisfies Decision as Decision;
    return {
      kind: "direct",
      actor: `thread:${scope.thread.threadId}`,
      profile: checked.effective.enabled ? checked.effective.profile.id : "goatclaw-off",
    } satisfies Decision as Decision;
  });

  /** Runs inside the settings write lock, so authority lost while waiting cannot commit. */
  const recheckCaller = (scope: McpInvocationScope, host: string | undefined) =>
    decide(scope, host).pipe(
      Effect.flatMap((decision) =>
        decision.kind === "direct" ? Effect.void : Effect.fail(deniedAtCommit()),
      ),
      Effect.catchTags({ OrchestratorMcpFailure: () => Effect.fail(deniedAtCommit()) }),
    );

  const approverHolds = (sessionId: AuthSessionId, scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    sessions.listActive().pipe(
      Effect.mapError(() => deniedAtCommit()),
      Effect.flatMap((active) => {
        const session = active.find((entry) => entry.sessionId === sessionId);
        const held = session?.permissions ?? session?.scopes ?? [];
        return session !== undefined && scopes.every((scope) => held.includes(scope))
          ? Effect.void
          : Effect.fail(deniedAtCommit());
      }),
    );

  const saveFailure = (error: ServerSettingsError) =>
    error.reason === DENIED
      ? denied("The caller lost permission to manage providers before the change was saved.")
      : error.operation === "create-provider-instance"
        ? invalid(
            `Provider instance ${error.providerInstanceId ?? ""} already exists. Change it with goat_provider_update.`,
          )
        : failure("orchestration_error", "Could not save the provider settings.");

  const current = settings.getSettings.pipe(
    Effect.mapError(() => failure("orchestration_error", "Could not read the provider settings.")),
  );

  /** The stored entry, or the unconfigured default instance a built-in driver runs under its own name. */
  const resolveEntry = (
    instances: Readonly<Record<string, ProviderInstanceConfig>>,
    instanceId: ProviderInstanceId,
  ): ProviderInstanceConfig | undefined =>
    Object.hasOwn(instances, instanceId)
      ? instances[instanceId]
      : DRIVER_KINDS.has(instanceId)
        ? { driver: ProviderDriverKind.make(instanceId) }
        : undefined;

  const install = Effect.fn("ProviderSettings.install")(function* (
    instance: ProviderInstanceConfig,
    instanceId: ProviderInstanceId,
  ) {
    const config = isRecord(instance.config) ? instance.config : {};
    const agentId = typeof config.agentId === "string" ? config.agentId.trim() : "";
    if (instance.driver !== "acpRegistry" || config.source === "local" || agentId === "")
      return yield* invalid(
        `install applies only to ACP Registry agents; ${instanceId} has no registry agent to download.`,
      );
    const prepared = yield* catalog
      .prepare({ agentId })
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", `Could not install ACP Registry agent ${agentId}.`),
        ),
      );
    return { agentId: prepared.agentId, version: prepared.version };
  });

  const save = (
    mutation: Parameters<Settings.ServerSettingsService["Service"]["updateProviderInstance"]>[0],
    patch: ServerSettingsPatch,
    authorize: Effect.Effect<void, ServerSettingsError>,
  ) =>
    settings
      .updateProviderInstance(mutation, patch, undefined, authorize)
      .pipe(Effect.mapError(saveFailure));

  const link = Effect.fn("ProviderSettings.link")(function* (
    cloudId: ProviderInstanceId,
    siblingId: ProviderInstanceId,
    authorize: Effect.Effect<void, ServerSettingsError>,
  ) {
    const instances = (yield* current).providerInstances;
    const cloud = resolveEntry(instances, cloudId);
    if (cloud === undefined || !isCloudSiblingDriver(cloud.driver))
      return yield* invalid(
        `${cloudId} is not a Cursor Cloud, Claude Cloud, or Devin Cloud instance.`,
      );
    const expected = CLOUD_SIBLING_DRIVERS[cloud.driver as keyof typeof CLOUD_SIBLING_DRIVERS];
    const sibling = resolveEntry(instances, siblingId);
    if (sibling === undefined || sibling.driver !== expected)
      return yield* invalid(
        `${driverName(cloud.driver)} needs a ${driverName(expected)} instance; ${siblingId} is not one.`,
      );
    if (
      cloud.driver === "devinCloud" &&
      !isDevinAcpRegistryInstance({
        ...sibling,
        enabled: true,
        config: { ...mergeConfig(sibling.config), enabled: true },
      })
    )
      return yield* invalid(`ACP instance ${siblingId} does not run Devin.`);
    const key = cloud.driver === "devinCloud" ? "siblingInstanceId" : "sourceInstanceId";
    const next: ProviderInstanceConfig = {
      ...cloud,
      enabled: true,
      config: mergeConfig(cloud.config, { [key]: siblingId }),
    };
    yield* save({ operation: "upsert", instanceId: cloudId, instance: next }, {}, authorize);
    return summarize(cloudId, next);
  });

  const uniqueId = (instances: Readonly<Record<string, unknown>>, base: string) => {
    const slug = base.replace(/[^a-zA-Z0-9_-]/gu, "-").replace(/^[^a-zA-Z]+/u, "") || "provider";
    const taken = (id: string) => Object.hasOwn(instances, id) || DRIVER_KINDS.has(id);
    if (!taken(slug)) return ProviderInstanceId.make(slug);
    for (let n = 2; ; n++)
      if (!taken(`${slug}-${n}`)) return ProviderInstanceId.make(`${slug}-${n}`);
  };

  const applied = (
    action: ProviderSettingsRequest["action"],
    fields: Omit<
      Extract<ProviderManageResult, { kind: "applied" }>,
      "kind" | "action" | "next" | "host"
    >,
  ): ProviderManageResult => ({
    kind: "applied",
    action,
    ...fields,
    next: { call: "goat_provider_diagnose" },
  });

  type AddPlan = NonNullable<ProviderSettingsProgress["plan"]>;

  /** Fixes the instance id and entry an add writes, before any of its effects run. */
  const planAdd = Effect.fn("ProviderSettings.planAdd")(function* (input: ProviderAddInput) {
    const instances = (yield* current).providerInstances;
    const driver = input.driver ?? (input.acpAgentId === undefined ? undefined : "acpRegistry");
    if (driver === undefined)
      return yield* invalid("Pass driver, or acpAgentId for an ACP Registry agent.");
    if (!DRIVER_KINDS.has(driver))
      return yield* invalid(
        `GOAT has no provider driver ${driver}. goat_provider_addable_list lists them.`,
      );
    if (input.acpAgentId !== undefined && driver !== "acpRegistry")
      return yield* invalid("acpAgentId needs the acpRegistry driver.");
    const config = mergeConfig(
      input.acpAgentId !== undefined
        ? { source: "registry", agentId: input.acpAgentId, distribution: "auto" }
        : driver === "codex"
          ? { setupMode: "existing" }
          : {},
      input.config,
    );
    const instanceId = input.instanceId ?? uniqueId(instances, input.acpAgentId ?? driver);
    if (Object.hasOwn(instances, instanceId))
      return yield* invalid(
        `Provider instance ${instanceId} already exists. Change it with goat_provider_update.`,
      );
    const environment = mergeEnvironment(undefined, input.environment);
    const instance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make(driver),
      enabled: input.enabled ?? true,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(Object.keys(config).length === 0 ? {} : { config }),
      ...(environment === undefined || environment.length === 0 ? {} : { environment }),
    };
    return {
      instanceId,
      instance,
      install: driver === "acpRegistry" && config.source !== "local" && (input.install ?? true),
      ...(input.linkTo === undefined ? {} : { linkTo: input.linkTo }),
    } satisfies AddPlan as AddPlan;
  });

  const addResult = (
    plan: AddPlan,
    installed: ProviderSettingsProgress["installed"],
    linked: ProviderSettingsProgress["linked"],
  ) =>
    applied("add", {
      instance: summarize(plan.instanceId, plan.instance),
      ...(linked === undefined ? {} : { linked }),
      ...(installed === undefined ? {} : { installed }),
    });

  const applyLocal = Effect.fn("ProviderSettings.applyLocal")(function* (
    request: ProviderSettingsRequest,
    authorize: Effect.Effect<void, ServerSettingsError>,
  ) {
    const instances = (yield* current).providerInstances;
    switch (request.action) {
      case "update": {
        const { input } = request;
        const base = resolveEntry(instances, input.instanceId);
        if (base === undefined)
          return yield* invalid(
            `No provider instance ${input.instanceId} on this environment. goat_provider_addable_list lists them.`,
          );
        const { displayName: _name, accentColor: _color, ...rest } = base;
        const displayName =
          input.displayName === null ? undefined : (input.displayName ?? base.displayName);
        const accentColor =
          input.accentColor === null ? undefined : (input.accentColor ?? base.accentColor);
        const merged =
          input.config === undefined ? base.config : mergeConfig(base.config, input.config);
        // Legacy entries keep enabled inside config; turning one on must clear that flag too.
        const config =
          input.enabled === true && isRecord(merged) && merged.enabled === false
            ? mergeConfig(merged, { enabled: null })
            : merged;
        const environment = mergeEnvironment(base.environment, input.environment);
        const next: ProviderInstanceConfig = {
          ...rest,
          ...(displayName === undefined ? {} : { displayName }),
          ...(accentColor === undefined ? {} : { accentColor }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(config === undefined ? {} : { config }),
          ...(environment === undefined ? {} : { environment }),
        };
        const installed =
          input.install === true ? yield* install(next, input.instanceId) : undefined;
        const patch: ServerSettingsPatch =
          input.defaultModel === undefined
            ? {}
            : {
                defaultModelSelection: {
                  instanceId: input.instanceId,
                  model: input.defaultModel.model,
                  ...(input.defaultModel.options === undefined
                    ? {}
                    : { options: input.defaultModel.options }),
                },
              };
        yield* save(
          { operation: "upsert", instanceId: input.instanceId, instance: next },
          patch,
          authorize,
        );
        return applied("update", {
          instance: summarize(input.instanceId, next),
          ...(installed === undefined ? {} : { installed }),
        });
      }
      case "add": {
        const plan = yield* planAdd(request.input);
        const installed = plan.install ? yield* install(plan.instance, plan.instanceId) : undefined;
        yield* save(
          { operation: "create", instanceId: plan.instanceId, instance: plan.instance },
          {},
          authorize,
        );
        const linked =
          plan.linkTo === undefined
            ? undefined
            : yield* link(plan.linkTo, plan.instanceId, authorize);
        return addResult(plan, installed, linked);
      }
      case "link": {
        const linked = yield* link(
          request.input.instanceId,
          request.input.siblingInstanceId,
          authorize,
        );
        const sibling = resolveEntry(
          (yield* current).providerInstances,
          request.input.siblingInstanceId,
        );
        return applied("link", {
          instance:
            sibling === undefined ? null : summarize(request.input.siblingInstanceId, sibling),
          linked,
        });
      }
      case "remove": {
        const { instanceId } = request.input;
        if (!Object.hasOwn(instances, instanceId))
          return yield* invalid(`Provider instance ${instanceId} has no Settings entry to remove.`);
        yield* save({ operation: "remove", instanceId }, {}, authorize);
        return applied("remove", { instance: null });
      }
    }
  });

  /** Calls the host's own tool and returns its raw result, keeping dispatch errors intact. */
  const dispatchRemote = (
    request: ProviderSettingsRequest,
    host: string,
    authorize: Effect.Effect<RuntimeMode, OrchestratorMcpFailure>,
  ) => {
    const { host: _host, ...args } = request.input;
    return dispatch.callHostTool(
      {
        host,
        tool: TOOLS[request.action],
        arguments: args,
        writes: true,
        timeoutMs: REMOTE_DEADLINE_MS,
        approvals: false,
        // Reached only after this machine admitted the caller or a person's approval.
        providersManage: true,
        requireReady: true,
      },
      authorize,
    );
  };

  const remoteFailure = (request: ProviderSettingsRequest, host: string) => (error: unknown) =>
    error instanceof Dispatch.SshRemoteDispatchError
      ? failure(
          error.reason === "invalid_request" || error.reason === "host_unknown"
            ? "invalid_request"
            : "orchestration_error",
          error.reason === "remote_refused" && error.remoteCode === undefined
            ? `${host} refused ${TOOLS[request.action]}: ${error.message} Update GOAT there if it does not have this tool yet.`
            : error.message,
        )
      : isMcpFailure(error)
        ? error
        : failure("orchestration_error", `Could not reach ${host}.`);

  /**
   * The remote may have applied the change: the call failed after its request could have
   * arrived, so nothing proves it did not run there.
   */
  const mayHaveReached = (error: unknown): error is Dispatch.SshRemoteDispatchError =>
    error instanceof Dispatch.SshRemoteDispatchError &&
    (error.launchMayHaveStarted === true ||
      error.reason === "ssh_failed" ||
      error.reason === "host_unavailable");

  const forward = Effect.fn("ProviderSettings.forward")(function* (
    request: ProviderSettingsRequest,
    host: string,
    authorize: Effect.Effect<RuntimeMode, OrchestratorMcpFailure>,
  ) {
    const raw = yield* dispatchRemote(request, host, authorize).pipe(
      Effect.mapError(remoteFailure(request, host)),
    );
    const result = yield* decodeRemote(raw).pipe(
      Effect.mapError(() =>
        failure("orchestration_error", `Update GOAT on ${host}: it returned an unreadable result.`),
      ),
    );
    return { ...result, host };
  });

  const requestApproval = Effect.fn("ProviderSettings.requestApproval")(function* (
    request: ProviderSettingsRequest,
    scope: McpInvocationScope,
  ) {
    if (scope.thread === undefined) return yield* denied("Only a thread can ask for approval.");
    yield* authorizeApprovalRequest(scope).pipe(Effect.mapError((error) => denied(error.message)));
    const view = yield* threads
      .getThreadSnapshot(scope.thread.threadId)
      .pipe(
        Effect.mapError(() => failure("orchestration_error", "The calling thread is unavailable.")),
      );
    const run = view.projection.runs.at(-1);
    if (!run || run.rootNodeId === null)
      return yield* invalid("Ask again from a thread with an active turn.");
    const where = request.input.host ?? (yield* HostProcess.Hostname);
    const handoff = yield* handoffs
      .create({
        kind: "approval",
        title: "Change provider settings?",
        reason: "An agent asked to change provider settings.",
        requestedBy: {
          threadId: scope.thread.threadId,
          providerInstanceId: scope.thread.providerInstanceId,
          path: PROVIDER_SETTINGS_HANDOFF_PATH,
        },
        target: { environmentId: scope.environmentId, path: PROVIDER_SETTINGS_HANDOFF_PATH },
        runId: run.id,
        nodeId: run.rootNodeId,
        human: {
          location: `On ${where}: ${describeRequest(request)} GOAT applies it when you approve.`,
        },
        args: { version: 1, request },
        expiresAt: DateTime.add(yield* DateTime.now, { minutes: 30 }),
      })
      .pipe(Effect.mapError(() => failure("orchestration_error", "Could not ask for approval.")));
    yield* audit(
      { actor: `thread:${scope.thread.threadId}`, profile: "approval" },
      request,
      "needs_human",
      handoff.handoffId,
    );
    return {
      kind: "needs_human" as const,
      handoff,
      next: { after: "approval" as const, call: "goat_provider_diagnose" as const },
      ...(request.input.host === undefined ? {} : { host: request.input.host }),
    };
  });

  const manage = Effect.fn("ProviderSettings.manage")(function* (
    request: ProviderSettingsRequest,
    scope: McpInvocationScope,
  ) {
    const host = request.input.host;
    const decision = yield* decide(scope, host);
    if (decision.kind === "approval") return yield* requestApproval(request, scope);
    const outcome = yield* Effect.exit(
      host === undefined
        ? applyLocal(request, recheckCaller(scope, undefined))
        : forward(
            request,
            host,
            decide(scope, host).pipe(
              Effect.flatMap((again) =>
                again.kind === "direct"
                  ? Effect.succeed("full-access" as RuntimeMode)
                  : Effect.fail(denied("The caller lost permission to manage providers.")),
              ),
            ),
          ),
    );
    yield* audit(decision, request, Exit.isSuccess(outcome) ? "applied" : "failed");
    return yield* outcome;
  });

  const presentDiagnosis = (result: ProviderDiagnoseOnHostResult, scope: McpInvocationScope) =>
    decide(scope, result.host).pipe(
      Effect.map((decision) => decision.kind === "direct"),
      Effect.orElseSucceed(() => false),
      Effect.map((permitted) =>
        !permitted
          ? result
          : {
              ...result,
              diagnoses: result.diagnoses.map((diagnosis) => ({
                ...diagnosis,
                checks: diagnosis.checks.map((check) =>
                  check.fix?.call === undefined
                    ? check
                    : {
                        ...check,
                        fix: {
                          actor: "agent" as const,
                          instruction: `Call ${check.fix.call.tool}${result.host === undefined ? "" : ` with host ${result.host}`}: ${check.fix.instruction}`,
                          path: `provider.${check.fix.call.tool.replace(/^goat_provider_/u, "")}`,
                          call: {
                            tool: check.fix.call.tool,
                            arguments:
                              result.host === undefined
                                ? check.fix.call.arguments
                                : { ...check.fix.call.arguments, host: result.host },
                          },
                        },
                      },
                ),
              })),
            },
      ),
    );

  const unavailableHandoff = (cause: unknown) => new HandoffError({ reason: "unavailable", cause });

  const recordProgress = (address: HandoffReadInput, progress: ProviderSettingsProgress) =>
    encodeProgress(progress).pipe(
      Effect.mapError(unavailableHandoff),
      Effect.flatMap((encoded) => handoffs.recordProviderProgress(address, encoded)),
      Effect.as(progress),
    );

  /** Runs one effect and returns its exit; a stop still stops, leaving its record at started. */
  const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.exit(effect).pipe(
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.interrupt
          : Effect.succeed(exit),
      ),
    );

  const describeFailure = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    return isMcpFailure(error)
      ? { reason: error.code, message: error.message }
      : { reason: "orchestration_error", message: "Could not apply the provider settings change." };
  };

  /** What goat_provider_diagnose needs to show whether a change landed. */
  const diagnoseArgs = (
    request: ProviderSettingsRequest,
    plan: AddPlan | undefined,
  ): ProviderDiagnoseOnHostInput => {
    const host = request.input.host === undefined ? {} : { host: request.input.host };
    if (plan !== undefined) return { instanceId: plan.instanceId, ...host };
    if (request.action !== "add") return { instanceId: request.input.instanceId, ...host };
    const { instanceId, driver, acpAgentId } = request.input;
    if (instanceId !== undefined) return { instanceId, ...host };
    const kind = driver ?? (acpAgentId === undefined ? undefined : "acpRegistry");
    return { ...(kind === undefined ? {} : { driver: ProviderDriverKind.make(kind) }), ...host };
  };

  /**
   * Applies an approved change from wherever its recorded progress left off, recording each
   * effect before and after it runs. Returns the progress with its outcome; fails only when the
   * progress itself could not be recorded, which the next resume picks up from its last record.
   */
  const applyApproved = Effect.fn("ProviderSettings.applyApproved")(function* (
    address: HandoffReadInput,
    request: ProviderSettingsRequest,
    authorize: Effect.Effect<void, ServerSettingsError>,
    prior: ProviderSettingsProgress | undefined,
  ) {
    let progress: ProviderSettingsProgress = prior ?? { version: 1, effects: {} };
    const write = (next: ProviderSettingsProgress) =>
      recordProgress(address, next).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            progress = next;
          }),
        ),
      );
    const mark = (
      effect: ProviderSettingsEffect,
      state: "started" | "done",
      extra: Pick<ProviderSettingsProgress, "installed" | "linked" | "outcome"> = {},
    ) => write({ ...progress, ...extra, effects: { ...progress.effects, [effect]: state } });
    const settle = (outcome: ProviderSettingsOutcome) => write({ ...progress, outcome });
    const failed = (effect: ProviderSettingsEffect | undefined, cause: Cause.Cause<unknown>) =>
      settle({
        state: "failed",
        ...(effect === undefined ? {} : { effect }),
        ...describeFailure(cause),
      });
    const unknown = (effect: ProviderSettingsEffect, reason: string, message: string) =>
      settle({
        state: "unknown_outcome",
        effect,
        reason,
        message,
        reconcile: {
          call: "goat_provider_diagnose",
          arguments: diagnoseArgs(request, progress.plan),
        },
      });
    const stored = current.pipe(
      Effect.map((settings) => settings.providerInstances),
      Effect.mapError(unavailableHandoff),
    );

    const host = request.input.host;
    if (host !== undefined) {
      const tool = TOOLS[request.action];
      // The remote applies the whole change in one call; once sent, only the remote knows.
      if (progress.effects.remote === "started")
        return yield* unknown(
          "remote",
          "effect_unconfirmed",
          `GOAT stopped after it may have sent ${tool} to ${host}, before ${host} answered.`,
        );
      yield* mark("remote", "started");
      const sent = yield* attempt(
        dispatchRemote(
          request,
          host,
          authorize.pipe(
            Effect.as("full-access" as RuntimeMode),
            Effect.mapError(() => denied("The approving person cannot manage providers.")),
          ),
        ),
      );
      if (Exit.isFailure(sent)) {
        const error = Cause.squash(sent.cause);
        if (mayHaveReached(error)) return yield* unknown("remote", error.reason, error.message);
        const mapped = remoteFailure(request, host)(error);
        return yield* settle({
          state: "failed",
          effect: "remote",
          reason:
            error instanceof Dispatch.SshRemoteDispatchError
              ? (error.remoteCode ?? error.reason)
              : mapped.code,
          message: mapped.message,
        });
      }
      const result = yield* Effect.exit(decodeRemote(sent.value));
      if (Exit.isFailure(result))
        return yield* unknown(
          "remote",
          "unreadable_result",
          `${host} answered ${tool} with a result this GOAT cannot read. Update GOAT there.`,
        );
      return yield* mark("remote", "done", {
        outcome: { state: "applied", result: { ...result.value, host } },
      });
    }

    if (request.action !== "add") {
      // Update and link write the same values over the current entry, so they repeat safely.
      // A remove found already gone after a stop is proven done.
      if (
        progress.effects.save === "started" &&
        request.action === "remove" &&
        !Object.hasOwn(yield* stored, request.input.instanceId)
      )
        return yield* mark("save", "done", {
          outcome: { state: "applied", result: applied("remove", { instance: null }) },
        });
      yield* mark("save", "started");
      const result = yield* attempt(applyLocal(request, authorize));
      if (Exit.isFailure(result)) return yield* failed("save", result.cause);
      return yield* mark("save", "done", { outcome: { state: "applied", result: result.value } });
    }

    let plan = progress.plan;
    if (plan === undefined) {
      const planned = yield* attempt(planAdd(request.input));
      if (Exit.isFailure(planned)) return yield* failed(undefined, planned.cause);
      plan = planned.value;
      yield* write({ ...progress, plan });
    }
    if (plan.install && progress.effects.install !== "done") {
      // Repeating is safe: prepare converges on the agent's versioned install or package receipt.
      yield* mark("install", "started");
      const installed = yield* attempt(install(plan.instance, plan.instanceId));
      if (Exit.isFailure(installed)) return yield* failed("install", installed.cause);
      yield* mark("install", "done", { installed: installed.value });
    }
    if (progress.effects.save !== "done") {
      const existing =
        progress.effects.save === "started" ? (yield* stored)[plan.instanceId] : undefined;
      // An entry equal to the plan is this save having landed; any other entry may be one it
      // wrote and someone then changed, or one someone else made.
      if (
        existing !== undefined &&
        instanceFingerprint(existing) !== instanceFingerprint(plan.instance)
      )
        return yield* unknown(
          "save",
          "instance_changed",
          `${plan.instanceId} changed after GOAT began saving it, so GOAT cannot tell whether this approval added it.`,
        );
      if (existing === undefined) {
        yield* mark("save", "started");
        const saved = yield* attempt(
          save(
            { operation: "create", instanceId: plan.instanceId, instance: plan.instance },
            {},
            authorize,
          ),
        );
        if (Exit.isFailure(saved)) return yield* failed("save", saved.cause);
      }
      yield* mark("save", "done");
    }
    if (plan.linkTo !== undefined && progress.effects.link !== "done") {
      // Repeating is safe: linking sets one config key on the cloud instance to the same id.
      yield* mark("link", "started");
      const linked = yield* attempt(link(plan.linkTo, plan.instanceId, authorize));
      if (Exit.isFailure(linked)) return yield* failed("link", linked.cause);
      yield* mark("link", "done", { linked: linked.value });
    }
    return yield* settle({
      state: "applied",
      result: addResult(plan, progress.installed, progress.linked),
    });
  });

  type ContinuationEntry = {
    readonly handoff: Handoff;
    readonly args: Readonly<Record<string, unknown>>;
    readonly approvedBySessionId: AuthSessionId;
    readonly progress?: unknown;
  };

  const isExpired = (handoff: Handoff) =>
    DateTime.now.pipe(
      Effect.map(
        (now) =>
          handoff.expiresAt !== null &&
          DateTime.toEpochMillis(handoff.expiresAt) <= DateTime.toEpochMillis(now),
      ),
    );

  const executeSettings = Effect.fn("ProviderSettings.executeSettings")(function* (
    entry: ContinuationEntry,
  ) {
    const address = {
      threadId: entry.handoff.requestedBy.threadId,
      handoffId: entry.handoff.handoffId,
    };
    const prior =
      entry.progress === undefined
        ? undefined
        : yield* decodeProgress(entry.progress).pipe(Effect.mapError(unavailableHandoff));
    // Settled before a stop cut its finish short: report it again, run nothing.
    if (prior?.outcome !== undefined) return prior;
    const refuse = (reason: string, message: string) =>
      recordProgress(address, {
        version: 1,
        effects: {},
        outcome: { state: "failed", reason, message },
      });
    const decoded = yield* Effect.exit(decodeApproval(entry.args));
    if (Exit.isFailure(decoded))
      return yield* refuse("invalid_request", "GOAT could not read the approved change.");
    const { request } = decoded.value;
    // The clock bounds when an approved change may start. One already under way is finished
    // or settled, since dropping it would leave its effects unreported.
    if (prior === undefined && (yield* isExpired(entry.handoff)))
      return yield* refuse("expired", "The approval expired before GOAT applied it.");
    const scopes: ReadonlyArray<AuthEnvironmentScope> =
      request.action === "update" && request.input.defaultModel !== undefined
        ? [AuthProvidersManageScope, AuthSettingsWriteScope]
        : [AuthProvidersManageScope];
    const progress = yield* applyApproved(
      address,
      request,
      approverHolds(entry.approvedBySessionId, scopes),
      prior,
    );
    const state = progress.outcome?.state;
    yield* audit(
      { actor: `client:${entry.approvedBySessionId}`, profile: "person" },
      request,
      state === "applied" ? "applied" : state === "unknown_outcome" ? "unknown_outcome" : "failed",
      entry.handoff.handoffId,
    );
    return progress;
  });

  /** A setup approval for an instance turns it on; adding and signing in happen in the window. */
  const executeSetup = Effect.fn("ProviderSettings.executeSetup")(function* (
    entry: ContinuationEntry,
  ) {
    const person = { actor: `client:${entry.approvedBySessionId}`, profile: "person" };
    if (yield* isExpired(entry.handoff))
      return yield* new HandoffError({ reason: "invalid_request" });
    const intent = yield* decodeSetupIntent(entry.args).pipe(
      Effect.mapError(() => new HandoffError({ reason: "invalid_request" })),
    );
    if (intent.instanceId === undefined) return;
    const entryNow = resolveEntry(
      (yield* current.pipe(Effect.mapError(() => new HandoffError({ reason: "unavailable" }))))
        .providerInstances,
      intent.instanceId,
    );
    if (entryNow === undefined || entryNow.enabled === true) return;
    const request: ProviderSettingsRequest = {
      action: "update",
      input: { instanceId: intent.instanceId, enabled: true },
    };
    const outcome = yield* Effect.exit(
      applyLocal(request, approverHolds(entry.approvedBySessionId, [AuthProvidersManageScope])),
    );
    yield* audit(
      person,
      request,
      Exit.isSuccess(outcome) ? "applied" : "failed",
      entry.handoff.handoffId,
    );
    if (Exit.isFailure(outcome)) return yield* new HandoffError({ reason: "invalid_request" });
    return outcome.value;
  });

  const consume = (
    path: typeof PROVIDER_SETTINGS_HANDOFF_PATH | typeof PROVIDER_SETUP_HANDOFF_PATH,
    entry: ContinuationEntry,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const address = {
          threadId: entry.handoff.requestedBy.threadId,
          handoffId: entry.handoff.handoffId,
        };
        if (path === PROVIDER_SETUP_HANDOFF_PATH) {
          const outcome = yield* restore(Effect.exit(executeSetup(entry)));
          if (Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
            return yield* Effect.failCause(outcome.cause);
          yield* handoffs.finishProviderContinuation(address, setupProgress(outcome));
          return yield* Effect.asVoid(outcome);
        }
        // A stop, or progress it could not record, leaves the continuation to resumeContinuations.
        const progress = yield* restore(executeSettings(entry));
        yield* handoffs.finishProviderContinuation(
          address,
          yield* encodeProgress(progress).pipe(Effect.mapError(unavailableHandoff)),
        );
        if (progress.outcome?.state !== "applied") return yield* approvalError(progress.outcome);
      }),
    );
  const paths = [PROVIDER_SETTINGS_HANDOFF_PATH, PROVIDER_SETUP_HANDOFF_PATH] as const;
  const isAppliedPath = (path: string): path is (typeof paths)[number] =>
    (paths as ReadonlyArray<string>).includes(path);

  return ProviderSettings.of({
    manage,
    presentDiagnosis,
    respond: Effect.fn("ProviderSettings.respond")(function* (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) {
      const handoff = yield* handoffs.respond(input, sessionId);
      const path = handoff.target.path;
      if (!isAppliedPath(path) || handoff.state !== "completed") return handoff;
      const entry = (yield* handoffs.completedProviderContinuations(path)).find(
        (candidate) => candidate.handoff.handoffId === handoff.handoffId,
      );
      if (entry === undefined) return handoff;
      yield* consume(path, entry);
      return handoff;
    }, lock.withPermits(1)),
    resumeContinuations: Effect.gen(function* () {
      for (const path of paths)
        for (const entry of yield* handoffs.completedProviderContinuations(path))
          yield* consume(path, entry).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("An approved provider settings change was not applied.", cause),
            ),
          );
    }).pipe(lock.withPermits(1)),
    readChange: Effect.fn("ProviderSettings.readChange")(function* (input: HandoffReadInput) {
      const stored = yield* handoffs.readProviderProgress(input);
      if (stored === undefined) return null;
      // The plan holds the entry's environment values, so only effects and outcome leave.
      const { effects, outcome } = yield* decodeProgress(stored).pipe(
        Effect.mapError(unavailableHandoff),
      );
      return outcome === undefined ? { effects } : { effects, outcome };
    }),
  });
});

export const layer = Layer.effect(ProviderSettings, make);
