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
import * as Routes from "./CodexRouteService.ts";
import * as HomeRoute from "./OpenCodexRoute.ts";
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
export class CodexHomeRequests extends Context.Service<
  CodexHomeRequests,
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
>()("goat/provider/CodexHomeRequests") {}
const make = Effect.gen(function* () {
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* Threads.ThreadManagementService;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const routes = yield* Routes.CodexRouteService;
  const homeRoute = yield* HomeRoute.OpenCodexRoute;
  const lock = yield* Semaphore.make(1);
  const context = yield* Effect.context<import("effect/Path").Path>();
  const request = (input: ProviderHomeRequestInput, scope: McpInvocationScope) =>
    Effect.gen(function* () {
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
      const config = yield* decodeConfig(snapshot.instance.config ?? {});
      if (config.setupMode === "managed")
        return {
          kind: "error" as const,
          code: "unsupported",
          message: "OpenCodex routing needs a Codex instance that uses your Codex CLI.",
        };
      if (input.action === "connect")
        yield* Effect.try(() =>
          HomeRoute.normalizeOpenCodexBaseUrl(input.opencodexBaseUrl ?? config.opencodexBaseUrl),
        );
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
      const name = snapshot.instance.displayName ?? input.instanceId;
      const host = yield* HostProcess.Hostname;
      const handoff = yield* handoffs.create({
        kind: "approval",
        title:
          input.action === "connect"
            ? "Use OpenCodex Home for this Codex instance?"
            : "Stop using OpenCodex Home?",
        reason:
          input.action === "connect"
            ? "An agent asked to route this Codex instance through OpenCodex Home."
            : "An agent asked to stop routing this Codex instance through OpenCodex Home.",
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
              ? `${name} on ${host} will send model requests through OpenCodex Home and use its accounts. If Home is unavailable, it stops instead of switching accounts.`
              : `${name} on ${host} goes back to Codex's own settings. OpenCodex stays connected to Home; run ocx disconnect on ${host} to disconnect it.`,
        },
        args: intent,
        expiresAt: DateTime.add(yield* DateTime.now, { minutes: 15 }),
      });
      return {
        kind: "needs_human" as const,
        handoff,
        next: { after: "approval" as const, call: "goat_provider_diagnose" as const },
      };
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({
          kind: "error" as const,
          code: "request_failed",
          message: "Could not request this route change. Refresh the instance and ask again.",
        }),
      ),
    );
  const execute = (entry: {
    readonly handoff: Handoff;
    readonly args: Readonly<Record<string, unknown>>;
    readonly approvedBySessionId: AuthSessionId;
  }) =>
    Effect.gen(function* () {
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
      const latest = yield* routes
        .capture(intent.request.instanceId)
        .pipe(Effect.mapError(invalid));
      const config = yield* decodeConfig(latest.instance.config ?? {}).pipe(
        Effect.mapError(invalid),
      );
      const nextConfig = {
        ...config,
        modelRoute:
          intent.request.action === "connect" ? ("opencodex" as const) : ("default" as const),
        ...(intent.request.opencodexBaseUrl === undefined
          ? {}
          : { opencodexBaseUrl: intent.request.opencodexBaseUrl }),
      };
      if (intent.request.action === "connect") {
        const home = yield* resolveCodexHomeLayout(nextConfig).pipe(Effect.provideContext(context));
        const route = yield* HomeRoute.resolveCodexRouteContext({
          settings: nextConfig,
          binaryPath: nextConfig.binaryPath,
          home: home.effectiveHomePath ?? home.sharedHomePath,
          cwd: process.cwd(),
          environment: yield* mergeProviderInstanceEnvironment(latest.instance.environment),
          configArgv: [],
        }).pipe(Effect.provideContext(context), Effect.mapError(invalid));
        yield* homeRoute.requireAvailable(route).pipe(Effect.mapError(invalid));
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
            "Codex Home approval was not applied; refresh and request approval again.",
            cause,
          ),
        ),
      );
  }).pipe(lock.withPermits(1));
  return CodexHomeRequests.of({
    request,
    resumeContinuations,
    respond: (input, sessionId) =>
      Effect.gen(function* () {
        const handoff = yield* handoffs.respond(input, sessionId);
        if (handoff.target.path !== "provider.home_request" || handoff.state !== "completed")
          return handoff;
        const entry = (yield* handoffs.completedProviderHomeContinuations).find(
          (entry) => entry.handoff.handoffId === handoff.handoffId,
        );
        if (!entry) return yield* new HandoffError({ reason: "conflict" });
        yield* consume(entry);
        return handoff;
      }).pipe(lock.withPermits(1)),
  });
});
export const layer = Layer.effect(CodexHomeRequests, make);
