import * as Exit from "effect/Exit";
import type { ProviderDriverKind } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import { AgentScope, type AgentScopeShape } from "@goat/shared/AgentScope";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { PiAdapterV2Options } from "./adapter.ts";
import type { PiRuntimeProfile } from "./profile.ts";
import { buildPiRpcLaunch } from "./mcpInjection.ts";
import { makePiRpcConnection, type PiRpcConnection } from "./rpc.ts";

export const startPiConnection = Effect.fnUntraced(function* ({
  launch,
  options,
  profile,
  input,
  cwd,
  agentScope,
  spawner,
  driver,
  scope,
}: {
  launch: ReturnType<typeof buildPiRpcLaunch>;
  options: PiAdapterV2Options;
  profile: PiRuntimeProfile;
  input: ProviderAdapter.ProviderAdapterV2OpenSessionInput;
  cwd: string;
  agentScope: AgentScopeShape;
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  driver: ProviderDriverKind;
  scope: Scope.Scope;
}) {
  const scopedLaunch = yield* agentScope.wrap({
    command: options.settings.binaryPath || profile.defaultBinary,
    args: launch.args,
    name: profile.driver,
    threadId: input.threadId,
    env: launch.env,
  });
  // Finalizers run in reverse order: reap detached work after terminating Pi.
  const scopeUnit = scopedLaunch.unit;
  const stopScope =
    scopeUnit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(scopeUnit));
  yield* Effect.addFinalizer(() => stopScope);
  const connection: PiRpcConnection = yield* makePiRpcConnection({
    threadId: input.threadId,
    command: scopedLaunch.command,
    args: scopedLaunch.args,
    cwd,
    env: launch.env,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(AgentScope, agentScope),
    Effect.mapError(
      (cause) =>
        new Adapter.ProviderAdapterOpenSessionError({
          driver,
          providerSessionId: input.providerSessionId,
          cause,
        }),
    ),
  );
  // Detached children can keep stdout open after Pi exits.
  if (scopeUnit !== undefined) {
    yield* connection.exited.pipe(
      Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
      Effect.forkIn(scope),
    );
  }
  return connection;
});

export const startScopedPiConnection = Effect.fnUntraced(function* (
  input: Omit<Parameters<typeof startPiConnection>[0], "launch"> & {
    launchInput: Parameters<typeof buildPiRpcLaunch>[0];
    currentEnvironment: Effect.Effect<NodeJS.ProcessEnv>;
    sessionPath?: string;
  },
) {
  const connectionScope = yield* Scope.fork(input.scope, "sequential");
  const launch = buildPiRpcLaunch({
    ...input.launchInput,
    environment: { ...(yield* input.currentEnvironment), GOAT_THREAD_ID: input.input.threadId },
    sessionPath: input.sessionPath,
  });
  const connection = yield* startPiConnection({ ...input, launch, scope: connectionScope }).pipe(
    Effect.provideService(Scope.Scope, connectionScope),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? Scope.close(connectionScope, exit) : Effect.void,
    ),
  );
  return { connection, scope: connectionScope };
});
