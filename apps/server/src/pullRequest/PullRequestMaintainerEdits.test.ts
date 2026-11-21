import { project, hostedChangeRequest, makeService } from "./pullRequestTestFixtures.ts";
import { SourceControlProviderKind, type ProjectId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { fakePullRequestProvider } from "@goat/source-control-testing/fakeSourceControlDriver";

it.effect("reads maintainer edits and changes them through the update command", () =>
  Effect.gen(function* () {
    let enabled = true;
    const provider = fakePullRequestProvider(SourceControlProviderKind.make("github"), {
      getChangeRequest: () =>
        Effect.succeed({ ...hostedChangeRequest("Body"), maintainerCanModify: enabled }),
      updateChangeRequest: (input) =>
        Effect.sync(() => {
          assert.strictEqual(input.title, undefined);
          assert.strictEqual(input.body, undefined);
          enabled = input.maintainerCanModify!;
        }),
    });
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/w", repository: "acme/web" })],
      providers: [
        {
          ...provider,
          capabilities: {
            ...provider.capabilities,
            edit: { changeRequest: true, comment: true, maintainerEdits: true },
          },
        },
      ],
    });
    const ref = { projectId: "p1" as ProjectId, repository: "acme/web", number: 1 };
    assert.strictEqual((yield* service.detail(ref)).maintainerCanModify, true);
    yield* service.update({ ...ref, maintainerCanModify: false });
    assert.strictEqual((yield* service.detail(ref)).maintainerCanModify, false);
  }),
);

it.effect("refuses maintainer edits on a host without the capability", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* makeService({
      projects: [project({ id: "p1", title: "web", workspaceRoot: "/w", repository: "acme/web" })],
      providers: [
        fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          updateChangeRequest: () =>
            Effect.sync(() => {
              writes += 1;
            }),
        }),
      ],
    });
    const result = yield* service
      .update({
        projectId: "p1" as ProjectId,
        repository: "acme/web",
        number: 1,
        maintainerCanModify: false,
      })
      .pipe(Effect.flip);
    assert.strictEqual(result._tag, "PullRequestOperationError");
    assert.strictEqual(writes, 0);
  }),
);
