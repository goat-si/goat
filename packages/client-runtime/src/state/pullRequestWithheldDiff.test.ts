import { ProjectId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AtomRegistry } from "effect/reactivity";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeTestRuntime, session, TARGET } from "./pullRequests.testkit.ts";

it.effect(
  "sends withheld file requests only after the same connection advertises the revision",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = {} as WsRpcProtocolClient;
        const revision = { baseSha: "a".repeat(40), headSha: "b".repeat(40) };
        const page = {
          patch: "page",
          truncated: true,
          nextCursor: null,
          withheldFilesReadable: true,
          revision,
        };
        const reads: string[] = [];
        const { atoms, registry, supervisor } = yield* makeTestRuntime(
          client,
          undefined,
          false,
          (_, input) =>
            Effect.sync(() => {
              if (input.path === undefined) return page;
              reads.push(input.path);
              return { patch: input.path, truncated: false, nextCursor: null };
            }),
        );
        const target = {
          environmentId: TARGET.environmentId,
          input: { projectId: ProjectId.make("project"), repository: "acme/web", number: 1 },
        };
        const file = (path: string) =>
          atoms.withheldDiff({ ...target, input: { ...target.input, revision, path } });
        expect(
          (yield* Effect.result(AtomRegistry.getResult(registry, file("early.js"))))._tag,
        ).toBe("Failure");
        expect(reads).toEqual([]);
        yield* AtomRegistry.getResult(registry, atoms.diff(target));
        expect((yield* AtomRegistry.getResult(registry, file("current.js"))).patch).toBe(
          "current.js",
        );
        yield* SubscriptionRef.set(supervisor.session, Option.some(session(client)));
        expect(
          (yield* Effect.result(AtomRegistry.getResult(registry, file("rolled-back.js"))))._tag,
        ).toBe("Failure");
        expect(reads).toEqual(["current.js"]);
      }),
    ),
);
