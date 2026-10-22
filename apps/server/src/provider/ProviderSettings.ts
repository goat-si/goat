/**
 * Provider settings changes for MCP callers: the writes Settings → Providers
 * makes, through the same ServerSettingsService.updateProviderInstance call.
 *
 * A caller makes the change itself when it may manage providers: a client
 * session holding a live providers:manage, or a live full-access thread whose
 * goatclaw profile allows providers.manage (every full-access thread while
 * goatclaw is off). Any other thread gets a provider.settings approval
 * handoff; approving it applies the stored change under the approving
 * person's session. Every outcome is written to audit_events.
 */
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  CLOUD_SIBLING_DRIVERS,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type Handoff,
  HandoffError,
  type HandoffRespondInput,
  isCloudSiblingDriver,
  isDevinAcpRegistryInstance,
  OrchestratorMcpFailure,
  PROVIDER_SETTINGS_HANDOFF_PATH,
  PROVIDER_SETUP_HANDOFF_PATH,
  ProviderAddInput,
  ProviderDriverKind,
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

  const audit = (
    who: { readonly actor: string; readonly profile: string },
    request: ProviderSettingsRequest,
    outcome: "applied" | "needs_human" | "failed",
    decisionId?: string,
  ) =>
    Effect.gen(function* () {
      const time = DateTime.formatIso(yield* DateTime.now);
      const target = targetOf(request);
      yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${time}, ${who.actor}, ${who.profile}, ${`provider.${request.action}`}, ${target}, ${outcome}, ${decisionId ?? null})`;
    }).pipe(
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
      Effect.catchTag("OrchestratorMcpFailure", () => Effect.fail(deniedAtCommit())),
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

  const install = (instance: ProviderInstanceConfig, instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
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

  const link = (
    cloudId: ProviderInstanceId,
    siblingId: ProviderInstanceId,
    authorize: Effect.Effect<void, ServerSettingsError>,
  ) =>
    Effect.gen(function* () {
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

  const applyLocal = (
    request: ProviderSettingsRequest,
    authorize: Effect.Effect<void, ServerSettingsError>,
  ): Effect.Effect<ProviderManageResult, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
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
          const { input } = request;
          const driver =
            input.driver ?? (input.acpAgentId === undefined ? undefined : "acpRegistry");
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
          const wantsInstall =
            driver === "acpRegistry" && config.source !== "local" && (input.install ?? true);
          const installed = wantsInstall ? yield* install(instance, instanceId) : undefined;
          yield* save({ operation: "create", instanceId, instance }, {}, authorize);
          const linked =
            input.linkTo === undefined
              ? undefined
              : yield* link(input.linkTo, instanceId, authorize);
          return applied("add", {
            instance: summarize(instanceId, instance),
            ...(linked === undefined ? {} : { linked }),
            ...(installed === undefined ? {} : { installed }),
          });
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
            return yield* invalid(
              `Provider instance ${instanceId} has no Settings entry to remove.`,
            );
          yield* save({ operation: "remove", instanceId }, {}, authorize);
          return applied("remove", { instance: null });
        }
      }
    });

  const forward = (
    request: ProviderSettingsRequest,
    host: string,
    authorize: Effect.Effect<RuntimeMode, OrchestratorMcpFailure>,
  ) =>
    Effect.gen(function* () {
      const { host: _host, ...args } = request.input;
      const raw = yield* dispatch
        .callHostTool(
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
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof Dispatch.SshRemoteDispatchError
              ? failure(
                  error.reason === "invalid_request" || error.reason === "host_unknown"
                    ? "invalid_request"
                    : "orchestration_error",
                  error.reason === "remote_refused" && error.remoteCode === undefined
                    ? `${host} refused ${TOOLS[request.action]}: ${error.message} Update GOAT there if it does not have this tool yet.`
                    : error.message,
                )
              : error,
          ),
        );
      const result = yield* decodeRemote(raw).pipe(
        Effect.mapError(() =>
          failure(
            "orchestration_error",
            `Update GOAT on ${host}: it returned an unreadable result.`,
          ),
        ),
      );
      return { ...result, host };
    });

  const requestApproval = (request: ProviderSettingsRequest, scope: McpInvocationScope) =>
    Effect.gen(function* () {
      if (scope.thread === undefined) return yield* denied("Only a thread can ask for approval.");
      yield* authorizeApprovalRequest(scope).pipe(
        Effect.mapError((error) => denied(error.message)),
      );
      const view = yield* threads
        .getThreadSnapshot(scope.thread.threadId)
        .pipe(
          Effect.mapError(() =>
            failure("orchestration_error", "The calling thread is unavailable."),
          ),
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

  const execute = (
    path: typeof PROVIDER_SETTINGS_HANDOFF_PATH | typeof PROVIDER_SETUP_HANDOFF_PATH,
    entry: {
      readonly handoff: Handoff;
      readonly args: Readonly<Record<string, unknown>>;
      readonly approvedBySessionId: AuthSessionId;
    },
  ) =>
    Effect.gen(function* () {
      const person = { actor: `client:${entry.approvedBySessionId}`, profile: "person" };
      const expiresAt = entry.handoff.expiresAt;
      if (
        expiresAt !== null &&
        DateTime.toEpochMillis(expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now)
      )
        return yield* new HandoffError({ reason: "invalid_request" });
      if (path === PROVIDER_SETUP_HANDOFF_PATH) {
        // A setup approval for an instance turns it on; adding and signing in happen in the window.
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
        return;
      }
      const { request } = yield* decodeApproval(entry.args).pipe(
        Effect.mapError(() => new HandoffError({ reason: "invalid_request" })),
      );
      const scopes: ReadonlyArray<AuthEnvironmentScope> =
        request.action === "update" && request.input.defaultModel !== undefined
          ? [AuthProvidersManageScope, AuthSettingsWriteScope]
          : [AuthProvidersManageScope];
      const host = request.input.host;
      const outcome = yield* Effect.exit(
        host === undefined
          ? applyLocal(request, approverHolds(entry.approvedBySessionId, scopes))
          : forward(
              request,
              host,
              approverHolds(entry.approvedBySessionId, scopes).pipe(
                Effect.as("full-access" as RuntimeMode),
                Effect.mapError(() => denied("The approving person cannot manage providers.")),
              ),
            ),
      );
      yield* audit(
        person,
        request,
        Exit.isSuccess(outcome) ? "applied" : "failed",
        entry.handoff.handoffId,
      );
      if (Exit.isFailure(outcome)) return yield* new HandoffError({ reason: "invalid_request" });
    });

  const consume = (
    path: typeof PROVIDER_SETTINGS_HANDOFF_PATH | typeof PROVIDER_SETUP_HANDOFF_PATH,
    entry: Parameters<typeof execute>[1],
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const outcome = yield* restore(Effect.exit(execute(path, entry)));
        yield* handoffs.finishProviderContinuation({
          threadId: entry.handoff.requestedBy.threadId,
          handoffId: entry.handoff.handoffId,
        });
        if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
      }),
    );

  const paths = [PROVIDER_SETTINGS_HANDOFF_PATH, PROVIDER_SETUP_HANDOFF_PATH] as const;
  const isAppliedPath = (path: string): path is (typeof paths)[number] =>
    (paths as ReadonlyArray<string>).includes(path);

  return ProviderSettings.of({
    manage,
    presentDiagnosis,
    respond: (input, sessionId) =>
      Effect.gen(function* () {
        const handoff = yield* handoffs.respond(input, sessionId);
        const path = handoff.target.path;
        if (!isAppliedPath(path) || handoff.state !== "completed") return handoff;
        const entry = (yield* handoffs.completedProviderContinuations(path)).find(
          (candidate) => candidate.handoff.handoffId === handoff.handoffId,
        );
        if (entry === undefined) return handoff;
        yield* consume(path, entry);
        return handoff;
      }).pipe(lock.withPermits(1)),
    resumeContinuations: Effect.gen(function* () {
      for (const path of paths)
        for (const entry of yield* handoffs.completedProviderContinuations(path))
          yield* consume(path, entry).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("An approved provider settings change was not applied.", cause),
            ),
          );
    }).pipe(lock.withPermits(1)),
  });
});

export const layer = Layer.effect(ProviderSettings, make);
