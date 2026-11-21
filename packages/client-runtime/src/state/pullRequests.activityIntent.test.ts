import { ProjectId, WS_METHODS } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeTestRuntime, TARGET } from "./pullRequests.testkit.ts";

it.effect("shares one activity request for repeated subscriptions to the same PR target", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.sync(() => {
            reads += 1;
            return {
              comments: [],
              commentCount: 0,
              commentsTruncated: false,
              reviewThreads: [],
              commits: [],
            };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          host: "github.com",
          repository: "owner/repo",
          number: 7,
        },
      };
      const first = atoms.activity(target);
      const second = atoms.activity({ ...target, input: { ...target.input } });
      expect(first).toBe(second);
      const stopFirst = registry.mount(first);
      const stopSecond = registry.mount(second);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopFirst();
          stopSecond();
        }),
      );
      yield* AtomRegistry.getResult(registry, first, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, second, { suspendOnWaiting: true });
      expect(reads).toBe(1);
    }),
  ),
);
