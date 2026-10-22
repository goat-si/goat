import {
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@goat/contracts";
import type { AgentSurfaceEffect } from "@goat/contracts/agentSurface";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Struct from "effect/Struct";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

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

const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "read-only"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
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
export const hostReachingCaller = orchestratingCaller;

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare("read", (params: P) => handle(params));

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
      ? orchestratingCaller.pipe(Effect.flatMap(() => handle(params)))
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
        ? orchestratingCaller.pipe(Effect.flatMap(() => handle(params)))
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

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

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
