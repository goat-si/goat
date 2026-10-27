import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import {
  AuthSessionId,
  CodexSettings,
  EnvironmentId,
  EnvironmentAuthorizationError,
  HandoffError,
  ProviderHomeRequestInput,
  ProviderInstanceConfig,
  type Handoff,
  type HandoffRespondInput,
  type ProviderHomeRequestResult,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { authorizeApprovalRequest } from "../sshRemote/SshHostAuthorization.ts";
import { resolveAuthlessManagedRuntime } from "./CodexManagedRuntime.ts";
import { withCodexAppServerClient } from "./CodexProvider.ts";
import * as Routes from "./CodexRouteService.ts";
import * as HomeRoute from "./OpenCodexRoute.ts";
import * as HomeAdapters from "./ProviderHomeAdapters.ts";
import {
  inspectProviderHomeRuntime,
  layerProviderHomeInventory,
  type ProviderHomeRuntimeEnv,
} from "./ProviderHomeRuntime.ts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";

const Intent = Schema.Struct({
  version: Schema.Literal(1),
  request: ProviderHomeRequestInput,
  instance: ProviderInstanceConfig,
  expectedFingerprint: Schema.String,
  expectedRevision: Schema.Struct({ epoch: Schema.String, sequence: Schema.Int }),
  environmentId: EnvironmentId,
});
const decodeIntent = Schema.decodeUnknownEffect(Intent);
const decodeConfig = Schema.decodeUnknownEffect(CodexSettings);
const invalid = (cause?: unknown) =>
  new HandoffError({ reason: "invalid_request", ...(cause === undefined ? {} : { cause }) });
const MANAGED_NEEDS_NONE =
  "Set opencodexAuth to none for this instance in Settings or with provider.update, then connect again.";

/**
 * Checks a Codex Home connection before it is saved. A managed instance is read through the
 * executable and managed home it will actually run with, so an inherited credential in its
 * effective configuration fails here; this reads configuration only and requests no inference.
 */
const preflightCodex = Effect.fn("ProviderHomeRequests.preflightCodex")(function* (
  homeRoute: HomeRoute.OpenCodexRoute["Service"],
  instanceId: ProviderInstanceId,
  codex: CodexSettings,
  environment: ProviderInstanceEnvironment | undefined,
) {
  const ambient = yield* mergeProviderInstanceEnvironment(environment);
  if (codex.setupMode !== "managed") {
    const layout = yield* resolveCodexHomeLayout(codex);
    const route = yield* HomeRoute.resolveCodexRouteContext({
      settings: codex,
      binaryPath: codex.binaryPath,
      home: layout.effectiveHomePath ?? layout.sharedHomePath,
      cwd: process.cwd(),
      environment: ambient,
      configArgv: [],
    });
    return yield* homeRoute.requireAvailable(route);
  }
  const runtime = yield* resolveAuthlessManagedRuntime({
    settings: codex,
    instanceId,
    environment: ambient,
  });
  const route = yield* HomeRoute.resolveCodexRouteContext({
    settings: runtime.config,
    binaryPath: runtime.binaryPath,
    home: runtime.home,
    cwd: process.cwd(),
    environment: runtime.environment,
    configArgv: [],
  });
  yield* homeRoute.requireAvailable(route);
  yield* withCodexAppServerClient({
    binaryPath: runtime.binaryPath,
    homePath: runtime.home,
    launchArgs: runtime.config.launchArgs,
    cwd: route.execution.cwd,
    environment: route.execution.environment,
    route,
  }).pipe(Effect.provideService(HomeRoute.OpenCodexRoute, homeRoute));
}, Effect.scoped);
type PreflightEnv = Effect.Services<ReturnType<typeof preflightCodex>> | ProviderHomeRuntimeEnv;

/** The goat_provider_home_request application owner for Codex, Claude Code, OpenCode and Pi. */
export class ProviderHomeRequests extends Context.Service<
  ProviderHomeRequests,
  {
    readonly request: (
      input: ProviderHomeRequestInput,
      scope: McpInvocationScope,
    ) => Effect.Effect<ProviderHomeRequestResult>;
    readonly respond: (
      input: HandoffRespondInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Handoff, HandoffError | EnvironmentAuthorizationError>;
    readonly resumeContinuations: Effect.Effect<void, HandoffError>;
  }
>()("goat/provider/ProviderHomeRequests") {}
const make = Effect.gen(function* () {
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* Threads.ThreadManagementService;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const routes = yield* Routes.CodexRouteService;
  const homeRoute = yield* HomeRoute.OpenCodexRoute;
  const lock = yield* Semaphore.make(1);
  const context = yield* Effect.context<PreflightEnv>();
  const request = Effect.fn("ProviderHomeRequests.request")(
    function* (input: ProviderHomeRequestInput, scope: McpInvocationScope) {
      if (
        !scope.thread ||
        scope.environmentId !== (yield* environment.getEnvironmentId) ||
        scope.readOnly
      )
        return {
          kind: "error" as const,
          code: "unsupported",
          message: "Ask again in a thread on the target environment.",
          fix: {
            actor: "human" as const,
            instruction: "Open a thread or Settings on the target environment.",
          },
        };
      const allowed = yield* authorizeApprovalRequest(scope).pipe(
        Effect.as(true),
        Effect.catchTags({ EnvironmentAuthorizationError: () => Effect.succeed(false) }),
      );
      if (!allowed)
        return {
          kind: "error" as const,
          code: "capability_denied",
          message: "The requesting thread must have live authorization.",
        };
      const snapshot = yield* routes.capture(input.instanceId);
      const driver = snapshot.instance.driver;
      if (driver === "codex" && input.action === "connect") {
        const codex = yield* decodeConfig(snapshot.instance.config ?? {});
        if (codex.setupMode === "managed" && codex.opencodexAuth !== "none")
          return { kind: "error" as const, code: "unsupported", message: MANAGED_NEEDS_NONE };
      }
      // Validates the requested change only; creating an approval never launches inference.
      yield* HomeAdapters.changeProviderHomeConfig(snapshot.instance, input);
      const view = yield* threads.getThreadSnapshot(scope.thread.threadId);
      const run = view.projection.runs.at(-1);
      if (!run || run.rootNodeId === null)
        return {
          kind: "error" as const,
          code: "unsupported",
          message: "Ask again in a thread on the target environment.",
        };
      const intent: typeof Intent.Type = {
        version: 1,
        request: input,
        instance: snapshot.instance,
        expectedFingerprint: snapshot.fingerprint,
        expectedRevision: snapshot.revision,
        environmentId: scope.environmentId,
      };
      const label = HomeAdapters.providerHomeLabel(driver);
      const name = snapshot.instance.displayName ?? input.instanceId;
      const host = yield* HostProcess.Hostname;
      const isolation =
        driver === "pi"
          ? " Pi uses an isolated GOAT configuration while routed; existing Pi credentials, settings and extensions are not copied."
          : "";
      const handoff = yield* handoffs.create({
        kind: "approval",
        title:
          input.action === "connect"
            ? `Use OpenCodex Home for this ${label} instance?`
            : "Stop using OpenCodex Home?",
        reason:
          input.action === "connect"
            ? `An agent asked to route this ${label} instance through OpenCodex Home.`
            : `An agent asked to stop routing this ${label} instance through OpenCodex Home.`,
        requestedBy: {
          threadId: scope.thread.threadId,
          providerInstanceId: scope.thread.providerInstanceId,
          path: "provider.home_request",
        },
        target: { environmentId: scope.environmentId, path: "provider.home_request" },
        runId: run.id,
        nodeId: run.rootNodeId,
        human: {
          location:
            input.action === "connect"
              ? `${name} on ${host} will send model requests through OpenCodex Home and use its accounts and shared quota. If Home is unavailable, it stops instead of switching accounts.${isolation}`
              : `${name} on ${host} goes back to ${label}'s own settings. OpenCodex stays connected to Home; run ocx disconnect on ${host} to disconnect it.`,
        },
        args: intent,
        expiresAt: DateTime.add(yield* DateTime.now, { minutes: 15 }),
      });
      return {
        kind: "needs_human" as const,
        handoff,
        next: { after: "approval" as const, call: "goat_provider_diagnose" as const },
      };
    },
    Effect.orElseSucceed(() => ({
      kind: "error" as const,
      code: "request_failed",
      message: "Could not request this route change. Refresh the instance and ask again.",
    })),
  );
  const execute = Effect.fn("ProviderHomeRequests.execute")(function* (entry: {
    readonly handoff: Handoff;
    readonly args: Readonly<Record<string, unknown>>;
    readonly approvedBySessionId: AuthSessionId;
  }) {
    const address = {
      threadId: entry.handoff.requestedBy.threadId,
      handoffId: entry.handoff.handoffId,
    };
    const intent = yield* decodeIntent(entry.args).pipe(Effect.mapError(invalid));
    const current = (yield* handoffs.open(address, entry.approvedBySessionId)).handoff;
    if (
      current.state !== "completed" ||
      current.expiresAt === null ||
      DateTime.toEpochMillis(current.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now) ||
      current.target.environmentId !== intent.environmentId
    )
      return yield* invalid();
    // This read is deliberately non-authoritative. The captured private
    // fingerprint/revision is checked by persistence under both write locks.
    const latest = yield* routes.capture(intent.request.instanceId).pipe(Effect.mapError(invalid));
    const nextConfig = yield* HomeAdapters.changeProviderHomeConfig(
      latest.instance,
      intent.request,
    ).pipe(Effect.mapError(invalid));
    if (intent.request.action === "connect") {
      const overlay = HomeAdapters.providerHomeOverlayDriver(latest.instance.driver);
      if (overlay === undefined) {
        const codex = yield* decodeConfig(nextConfig).pipe(Effect.mapError(invalid));
        yield* preflightCodex(
          homeRoute,
          intent.request.instanceId,
          codex,
          latest.instance.environment,
        ).pipe(Effect.provideContext(context), Effect.mapError(invalid));
      } else
        // Observational: the route is published only when the committed settings are applied.
        yield* inspectProviderHomeRuntime(
          overlay,
          intent.request.instanceId,
          nextConfig,
          latest.instance.environment,
        ).pipe(Effect.provideContext(context), Effect.mapError(invalid));
    }
    yield* routes
      .mutateProviderInstance(
        {
          mutation: {
            operation: "upsert",
            instanceId: intent.request.instanceId,
            instance: { ...latest.instance, config: nextConfig },
          },
        },
        { kind: "client", sessionId: entry.approvedBySessionId },
        {
          handoffId: current.handoffId,
          environmentId: intent.environmentId,
          instanceId: intent.request.instanceId,
          expectedFingerprint: intent.expectedFingerprint,
          expectedRevision: intent.expectedRevision,
          expiresAt: DateTime.toEpochMillis(current.expiresAt),
        },
      )
      .pipe(Effect.mapError(invalid));
  });
  const consume = (entry: Parameters<typeof execute>[0]) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const outcome = yield* restore(Effect.exit(execute(entry)));
        yield* handoffs.finishProviderHomeContinuation({
          threadId: entry.handoff.requestedBy.threadId,
          handoffId: entry.handoff.handoffId,
        });
        if (Exit.isFailure(outcome)) return yield* Effect.failCause(outcome.cause);
      }),
    );
  const resumeContinuations = Effect.gen(function* () {
    for (const entry of yield* handoffs.completedProviderHomeContinuations)
      yield* consume(entry).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Provider Home approval was not applied; refresh and request approval again.",
            cause,
          ),
        ),
      );
  }).pipe(lock.withPermits(1));
  return ProviderHomeRequests.of({
    request,
    resumeContinuations,
    respond: Effect.fn("ProviderHomeRequests.respond")(function* (input, sessionId) {
      const handoff = yield* handoffs.respond(input, sessionId);
      if (handoff.target.path !== "provider.home_request" || handoff.state !== "completed")
        return handoff;
      const entry = (yield* handoffs.completedProviderHomeContinuations).find(
        (entry) => entry.handoff.handoffId === handoff.handoffId,
      );
      if (!entry) return yield* new HandoffError({ reason: "conflict" });
      yield* consume(entry);
      return handoff;
    }, lock.withPermits(1)),
  });
});
/** Reads the OpenCodex inventory from its caller; tests supply the local OpenCodex boundary. */
export const layerWithoutInventory = Layer.effect(ProviderHomeRequests, make);
export const layer = layerWithoutInventory.pipe(Layer.provide(layerProviderHomeInventory));
