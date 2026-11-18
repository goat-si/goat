import { submitRevisionBoundReview } from "./pullRequestRevisionReview.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import { retainWithheldDiffPaths } from "./pullRequestDiffQueries.ts";
import { ProjectId, WS_METHODS } from "@goat/contracts";
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

it("evicts the oldest withheld overlays at either row or byte limits", () => {
  const paths = ["oldest", "middle", "newest"];
  const patch = (value: string) => ({ patch: value, truncated: false, nextCursor: null });
  expect(retainWithheldDiffPaths(paths, () => patch("x\n".repeat(10_000)))).toEqual(paths.slice(1));
  expect(retainWithheldDiffPaths(paths, () => patch("x".repeat(2_000_000)))).toEqual(
    paths.slice(1),
  );
  const pending = Array.from({ length: 20 }, (_, index) => String(index));
  expect(retainWithheldDiffPaths(pending, () => undefined)).toEqual(pending.slice(-8));
});

it.effect(
  "submits guarded reviews only through a source session that advertises revision checks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const client = (name: string, supportsRevision: boolean) =>
          ({
            [WS_METHODS.serverGetConfig]: () =>
              Effect.succeed({
                environment: {
                  capabilities: { revisionBoundPullRequestReviews: supportsRevision },
                },
              }),
            [WS_METHODS.pullRequestsSubmitReview]: () =>
              Effect.sync(() => {
                calls.push(name);
              }),
          }) as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          client("old", false),
          client("alternate", true),
        );
        const input = {
          projectId: ProjectId.make("project"),
          repository: "acme/web",
          number: 1,
          verdict: "comment" as const,
          body: "review",
          comments: [],
          revision: { headSha: "a".repeat(40), baseSha: "b".repeat(40) },
        };
        const submit = environmentRegistry.run(
          TARGET.environmentId,
          submitRevisionBoundReview(input).pipe(
            Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          ),
        );
        expect(yield* Effect.flip(submit)).toMatchObject({ operation: "submitReview" });
        expect(calls).toEqual([]);

        yield* SubscriptionRef.set(
          supervisor.session,
          Option.some(session(client("current", true))),
        );
        yield* submit;
        expect(calls).toEqual(["current"]);
      }),
    ),
);
