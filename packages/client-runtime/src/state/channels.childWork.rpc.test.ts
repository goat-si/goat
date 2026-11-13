import { CHANNEL_GATEWAY_WS_METHODS, ChannelTaskId, type ServerConfig } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Atom, AtomRegistry } from "effect/reactivity";
import type * as RpcSession from "../rpc/session.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";
import { makeEnvironmentQueryHarness, QUERY_ENVIRONMENT } from "./runtimeTestSupport.ts";

const config = Atom.make<ServerConfig | null>({
  environment: { capabilities: { goatBotChildWork: true } },
} as ServerConfig);
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ initialConfigValueAtom: () => config }),
}));

it.effect("refreshing child work retries the failed RPC and returns its next answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let requests = 0;
      const session = {
        client: {
          [CHANNEL_GATEWAY_WS_METHODS.listChildWork]: () =>
            Effect.suspend(() => {
              requests += 1;
              return requests === 1
                ? Effect.fail(
                    new EnvironmentRpcUnavailableError({
                      environmentId: QUERY_ENVIRONMENT.environmentId,
                      message: "failed first read",
                    }),
                  )
                : Effect.succeed({ groups: [] });
            }),
        },
      } as unknown as RpcSession.RpcSession;
      const harness = yield* makeEnvironmentQueryHarness(Effect.void, { rpcSession: session });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const query = createChannelEnvironmentAtoms(harness.runtime).listChildWork({
        environmentId: QUERY_ENVIRONMENT.environmentId,
        input: { taskIds: [ChannelTaskId.make("task")] },
      });
      registry.mount(query);
      const first = yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(first)).toBe(true);
      expect(requests).toBe(1);
      registry.refresh(query);
      const second = yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      expect(second).toEqual({ groups: [] });
      expect(requests).toBe(2);
    }),
  ),
);
