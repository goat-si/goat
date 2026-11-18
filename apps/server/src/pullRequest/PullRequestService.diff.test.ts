import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind, type ProjectId } from "@goat/contracts";
import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  makeService,
  project,
  hostedChangeRequest,
  changeRequest,
} from "./pullRequestTestFixtures.ts";

it.effect("reads the fresh diff when detail or summary discovers a changed revision", () =>
  Effect.gen(function* () {
    const summaryStarted = yield* Deferred.make<void>();
    const releaseSummary = yield* Deferred.make<void>();
    let revision = "2026-07-02T00:00:00Z";
    let patch = "old patch";
    let diffCalls = 0;
    const reference = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          getChangeRequest: () =>
            Effect.sync(() => ({ ...hostedChangeRequest("body"), updatedAt: revision })),
          getChangeRequestSummary: () =>
            Effect.gen(function* () {
              const result = changeRequest(1, revision);
              yield* Deferred.succeed(summaryStarted, undefined);
              yield* Deferred.await(releaseSummary);
              return result;
            }),
          getDiff: () =>
            Effect.sync(() => {
              diffCalls += 1;
              return { patch, truncated: false, nextCursor: null };
            }),
        }),
      ],
    });

    const coldSummary = yield* service.summary(reference).pipe(Effect.forkChild());
    yield* Deferred.await(summaryStarted);
    yield* service.detail(reference);
    assert.strictEqual((yield* service.diff(reference)).patch, "old patch");
    revision = "2026-07-02T00:01:00Z";
    patch = "new patch";
    yield* TestClock.adjust("61 seconds");
    yield* service.detail(reference);
    yield* Effect.yieldNow;
    assert.strictEqual((yield* service.detail(reference)).updatedAt, revision);
    yield* Deferred.succeed(releaseSummary, undefined);
    yield* Fiber.join(coldSummary);
    yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual((yield* service.diff(reference)).patch, "new patch");
    assert.strictEqual(diffCalls, 2);

    revision = "2026-07-02T00:02:00Z";
    patch = "summary-discovered patch";
    yield* TestClock.adjust("61 seconds");
    yield* service.summary(reference, { recoverTransientFailure: false });
    assert.strictEqual((yield* service.diff(reference)).patch, patch);
    assert.strictEqual(diffCalls, 3);
  }),
);

it.effect("isolates withheld reads by path and revision, and refuses them on other hosts", () =>
  Effect.gen(function* () {
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 10 };
    const projects = [
      project({ id: "p1", title: "web", workspaceRoot: "/a", repository: "acme/web" }),
    ];
    const answers: string[] = [];
    const provider = fakePullRequestProvider(SourceControlProviderKind.make("github"), {
      getDiff: (input) =>
        Effect.sync(() => {
          const patch =
            input.path === undefined
              ? "page"
              : [input.commit, input.revision?.headSha, input.path].filter(Boolean).join(":");
          answers.push(patch);
          return { patch, truncated: false, nextCursor: null };
        }),
    });
    const service = yield* makeService({
      projects,
      providers: [
        { ...provider, capabilities: { ...provider.capabilities, withheldFileDiff: true } },
      ],
    });
    const path = { ...ref, path: "large.js" };
    const firstHead = "a".repeat(40);
    const nextHead = "b".repeat(40);
    assert.strictEqual((yield* service.diff(ref)).patch, "page");
    assert.strictEqual(
      (yield* service.diff({ ...path, revision: { baseSha: firstHead, headSha: firstHead } }))
        .patch,
      firstHead + ":large.js",
    );
    assert.strictEqual(
      (yield* service.diff({ ...path, revision: { baseSha: firstHead, headSha: nextHead } })).patch,
      nextHead + ":large.js",
    );
    assert.strictEqual(
      (yield* service.diff({ ...path, commit: firstHead, path: "old.js" })).patch,
      firstHead + ":old.js",
    );
    assert.strictEqual((yield* service.diff(ref)).patch, "page");
    assert.lengthOf(answers, 4);

    const unsupported = yield* makeService({ projects, providers: [provider] });
    const error = yield* Effect.flip(unsupported.diff(path));
    assert.strictEqual(error._tag, "PullRequestOperationError");
    assert.lengthOf(answers, 4);
  }),
);
