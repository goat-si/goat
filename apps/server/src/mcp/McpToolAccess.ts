import {
  OrchestratorMcpFailure,
  type PermissionCapability,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import {
  type AgentSurfaceEffect,
  type AgentSurfaceEntry,
  agentSurfaceRegistry,
} from "@goat/contracts/agentSurface";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

/**
 * Their private constructors only stop the type checker; this also stops
 * `Reflect.construct` and friends at runtime.
 */
const builtHere: unique symbol = Symbol("goat/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

let declare: <P, A, E, R>(
  effect: AgentSurfaceEffect,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools> | ToolEffects, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/**
 * Effect's own registration functions accept any handler, so the
 * `goat/no-raw-mcp-registration` lint rule keeps Effect's `McpServer` inside
 * McpHttpServer.
 */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  readonly effect: AgentSurfaceEffect;
  private constructor(token: typeof builtHere, effect: AgentSurfaceEffect, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
    this.effect = effect;
  }
  static {
    declare = (effect, handle) => new Declaration(builtHere, effect, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

/** Marks a potentially destructive write while preserving its existing caller checks. */
export const destructive = <P, A, E, R>(
  declaration: Declaration<(params: P) => Effect.Effect<A, E, R>>,
) => {
  if (declaration.effect === "read")
    throw new TypeError("A read declaration cannot be destructive.");
  return declare("destructive", checkedHandler(declaration));
};

/** Scoped to one registration so concurrently built toolkits cannot overwrite each other's effects. */
export class ToolEffects extends Context.Service<
  ToolEffects,
  Readonly<Record<string, AgentSurfaceEffect>>
>()("goat/mcp/McpToolAccess/ToolEffects") {}

const refuseReadOnlyClientWith = (message: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) =>
      scope.client?.access === "read-only"
        ? Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message }))
        : Effect.void,
    ),
  );

const refuseReadOnlyClient = refuseReadOnlyClientWith(
  "This tool changes the environment, and this MCP client was approved for read-only access.",
);

const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
);

const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
);

/** What a read that uses this machine's SSH keys to reach another host must pass first. */
export const hostReachingCaller = refuseReadOnlyClientWith(
  "This call reaches other machines with this machine's SSH keys, and this MCP client was approved for read-only access.",
).pipe(Effect.andThen(readCaller()), Effect.tap(assertLiveCaller));

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

// Keyed by the served legacy names and by path.
const declaredEntries: ReadonlyMap<string, AgentSurfaceEntry> = new Map(
  Object.values(agentSurfaceRegistry).flatMap((entry) =>
    [...entry.legacyNames, entry.path].map((name) => [name, entry as AgentSurfaceEntry] as const),
  ),
);

const stringArgument = (args: unknown, key: string) => {
  const value =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

const capabilityRefused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const admitCapability = (
  tool: string,
  capability: PermissionCapability,
  result: Profiles.CheckResult,
) =>
  result.ok
    ? Effect.void
    : Effect.fail(
        capabilityRefused(`${tool} needs the goatclaw ${capability} capability. ${result.reason}`),
      );

/**
 * With goatclaw on, a GOAT thread runs a write only when its effective profile holds the
 * capability the tool's registry entry declares, plus threads.remote and an allowed host when
 * the call names a host. Direct calls and goat_call reach it through the served handle, before
 * arguments decode. Outside clients stay bounded by their approved access: other GOAT hosts
 * call writes as one. A call without an invocation scope comes from inside this process.
 */
export const requireDeclaredCapability = (
  permissions: Profiles.PermissionProfiles["Service"],
  tool: string,
  declaredEffect: AgentSurfaceEffect,
  args: unknown,
): Effect.Effect<void, OrchestratorMcpFailure> => {
  const entry = declaredEntries.get(tool);
  const capability = entry?.capability;
  // A mismatch between the registry and the handler's declaration fails closed below.
  const reads = declaredEffect === "read" && (entry?.effect ?? "read") === "read";
  if (reads || capability === "none") return Effect.void;
  return Effect.gen(function* () {
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    if (Option.isNone(scope) || scope.value.thread === undefined) return;
    const effective = yield* permissions.resolve(scope.value).pipe(
      Effect.mapError(
        (failure) =>
          new OrchestratorMcpFailure({
            code: failure.code,
            message: `${tool}: ${failure.message}`,
          }),
      ),
    );
    if (capability === undefined) {
      if (effective.enabled)
        return yield* capabilityRefused(`${tool} declares no goatclaw capability.`);
      return;
    }
    const host = entry?.hostRoutable === true ? stringArgument(args, "host") : undefined;
    yield* admitCapability(
      tool,
      capability,
      Profiles.checkProfile(effective, capability, { host }),
    );
    if (host !== undefined)
      yield* admitCapability(
        tool,
        "threads.remote",
        Profiles.checkProfile(effective, "threads.remote", { host }),
      );
  });
};

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("read", (params: P) => handle(params));

/**
 * Runs other registered tools, each through its own declaration, so it adds no
 * gate of its own. Declared a write so clients never auto-approve it as read-only.
 */
export const dispatches = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("write", (params: P) => handle(params));

/**
 * Receives a tool's original failure before the MCP layer flattens it into text.
 * goat_call provides one per nested call, so the envelope keeps the error's tag,
 * code and computed message; ordinary requests have none and nothing is recorded.
 */
export class CallFailureCapture extends Context.Service<
  CallFailureCapture,
  { readonly record: (error: unknown) => Effect.Effect<void> }
>()("goat/mcp/McpToolAccess/CallFailureCapture") {}

const recordFailure = (error: unknown) =>
  Effect.serviceOption(CallFailureCapture).pipe(
    Effect.flatMap((capture) =>
      capture._tag === "Some" ? capture.value.record(error) : Effect.void,
    ),
  );

const capturingFailures = <Handler>(handler: Handler): Handler =>
  (typeof handler === "function"
    ? (...args: ReadonlyArray<unknown>) => {
        const result = (handler as (...args: ReadonlyArray<unknown>) => unknown)(...args);
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- wraps every handler shape; Handler restores the types.
        return Effect.isEffect(result) ? result.pipe(Effect.tapError(recordFailure)) : result;
      }
    : handler) as Handler;

/**
 * Changes nothing, but when `reachesHost` says the call goes to another
 * machine it uses this machine's SSH keys, so it then needs what
 * goat_ssh_browse needs: thread control, a client approved for more than
 * read-only access, and a live caller.
 */
export const readsOrReachesHost = <P, A, E, R>(
  reachesHost: (params: P) => boolean,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare("read", (params: P) =>
    reachesHost(params)
      ? hostReachingCaller.pipe(Effect.flatMap(() => handle(params)))
      : handle(params),
  );

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("read", (params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("write", (params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("write", (params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * `writes` for a tool whose service acts for the calling thread, so an outside
 * client is refused here, where goat_describe can see it, instead of in the service.
 */
export const writesAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("write", (params: P) =>
    requireThreadCaller.pipe(
      Effect.andThen(orchestratingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

/**
 * Unlike `writes` it does not need thread control; the handler checks its
 * capability, as the capability toolkits do.
 */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("write", (params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
  options: { readonly refusalSuffix?: string } = {},
) =>
  declare("write", (params: P) =>
    Effect.gen(function* () {
      const caller = yield* writingCaller;
      for (const threadId of threads(params)) {
        if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
        const target = yield* caller.threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (target !== null && target.deletedAt === null) {
          yield* assertTargetWithinLimits(caller.limits, target).pipe(
            Effect.mapError((error) =>
              options.refusalSuffix === undefined
                ? error
                : new OrchestratorMcpFailure({
                    code: error.code,
                    message: error.message + options.refusalSuffix,
                  }),
            ),
          );
        }
      }
      // The target's user can raise its modes after the check above; the
      // orchestrator checks again under the thread's lock and records its
      // refusal here, since handlers wrap dispatch errors their own way.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      return yield* handle(params).pipe(
        Effect.provideService(DispatchModeLimit, { ...caller.limits, refused }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail<E | OrchestratorMcpFailure>(
              refusal === undefined ? error : escalationDenied(refusal, options.refusalSuffix),
            ),
          ),
        ),
      );
    }),
  );

const escalationDenied = (refusal: DispatchModeRefusal, refusalSuffix = "") =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.${refusalSuffix}`,
  });

export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare("write", (params: P) =>
    Effect.gen(function* () {
      const { limits } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/**
 * `check` re-checks the caller wherever the handler waits before writing, such
 * as for a lock, since the caller's modes can change meanwhile.
 */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
) => {
  const check = orchestratingCaller.pipe(
    Effect.tap((caller) => assertFullAccess(caller, fullAccessRequired)),
  );
  return declare("write", (params: P) => check.pipe(Effect.flatMap(() => handle(params, check))));
};

type CheckServices = Effect.Services<typeof orchestratingCaller>;

const removesCheckoutsRequired =
  "Removing worktrees needs a live full-access/default calling thread or a full-access client.";

/**
 * Deletes checkouts when `removes` says so, which needs a full-access/default
 * caller: a plan or approval-required thread, or an `auto` client, may not
 * destroy a working tree. Otherwise it reads, and needs thread control only
 * when `reachesHost` says the call uses this machine's SSH keys.
 */
export const removesCheckouts = <P, A, E, R>(
  removes: (params: P) => boolean,
  reachesHost: (params: P) => boolean,
  handle: (params: P) => Effect.Effect<A, E, R>,
) =>
  declare("destructive", (params: P) =>
    removes(params)
      ? orchestratingCaller.pipe(
          Effect.tap((caller) => assertFullAccess(caller, removesCheckoutsRequired)),
          Effect.flatMap(() => handle(params)),
        )
      : reachesHost(params)
        ? hostReachingCaller.pipe(Effect.flatMap(() => handle(params)))
        : handle(params),
  );
type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

type NotCallable = { readonly call?: never } & { readonly apply?: never };

export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools> | ToolEffects, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools> | ToolEffects, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers => {
  const handlers: Readonly<Record<string, unknown>> = Struct.map(declarations, checkedHandler);
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, capturingFailures(handler)]),
  ) as Handlers;
};

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> => {
  const checked = (declarations: Handlers<Tools>) => ({
    handlers: checkedHandlers<Toolkit.HandlersFrom<Tools>>(declarations),
    effects: Object.fromEntries(
      Object.entries<Declaration<unknown>>(declarations).map(([name, declaration]) => [
        name,
        declaration.effect,
      ]),
    ),
  });
  const prepared = Effect.isEffect(build)
    ? Effect.map(build, checked)
    : Effect.succeed(checked(build));
  return handlersLayer(
    Layer.effectContext(
      Effect.gen(function* () {
        const { handlers, effects } = yield* prepared;
        return Context.add(yield* toolkit.toHandlers(handlers), ToolEffects, effects);
      }),
    ),
  );
};
