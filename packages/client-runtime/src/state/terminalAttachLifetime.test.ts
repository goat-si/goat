import { it } from "@effect/vitest";
import { WS_METHODS } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import type * as RpcSession from "../rpc/session.ts";
import { createTerminalEnvironmentAtoms } from "./terminal.ts";
import {
  makeEnvironmentQueryHarness,
  QUERY_ENVIRONMENT,
  QUERY_RPC_SESSION,
} from "./runtimeTestSupport.ts";

// The server sizes a shared PTY to every attached viewer, so a lingering attach pins its grid.
it.effect("terminal attach detaches as soon as its last viewer leaves", () =>
  Effect.gen(function* () {
    const harness = yield* makeEnvironmentQueryHarness(Effect.void);
    const attached = yield* Deferred.make<void>();
    const detached = yield* Deferred.make<void>();
    const client = {
      [WS_METHODS.terminalAttach]: () =>
        Stream.fromEffect(Deferred.succeed(attached, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.never),
          Stream.ensuring(Deferred.succeed(detached, undefined)),
        ),
    } as unknown as RpcSession.RpcSession["client"];
    yield* SubscriptionRef.set(
      harness.supervisorSession,
      Option.some({ ...QUERY_RPC_SESSION, client }),
    );
    const atoms = createTerminalEnvironmentAtoms(harness.runtime);
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const unsubscribe = registry.subscribe(
      atoms.attach({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { threadId: "thread-1", terminalId: "terminal-1", cwd: "/tmp/project" },
      }),
      () => {},
      { immediate: true },
    );
    yield* Deferred.await(attached);

    unsubscribe();
    yield* Deferred.await(detached);
  }),
);
