import { expect, it } from "@effect/vitest";
import { EnvironmentId, type StorageItem } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import {
  instanceId,
  person,
  threadId,
  withApprovals,
} from "../handoffs/ApprovalHandoffs.testkit.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeStorageConsent } from "./StorageConsent.ts";

const fromThread: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "test:thread",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: { threadId, providerSessionId: "session", providerInstanceId: instanceId },
  client: undefined,
};

const item = (path: string, token: string): StorageItem => ({
  id: "worktree:" + path,
  kind: "worktree",
  path,
  label: path,
  bytes: 1024 ** 3,
  state: "removable",
  selected: true,
  reason: "No thread uses it",
  token,
});
const listed = [item("/w/a", "a1"), item("/w/b", "b1")];
const asked = listed.map(({ id, token }) => ({ id, token }));

const withConsent = <A, E>(
  body: (input: {
    readonly consent: Effect.Success<typeof makeStorageConsent>;
    readonly respond: (
      handoffId: string,
      action: "completed" | "declined",
    ) => Effect.Effect<unknown, unknown>;
  }) => Effect.Effect<A, E>,
) =>
  withApprovals(({ handoffs }) =>
    Effect.gen(function* () {
      const consent = yield* makeStorageConsent;
      return yield* body({
        consent,
        respond: (handoffId, action) => handoffs.respond({ threadId, handoffId, action }, person),
      });
    }).pipe(
      Effect.provide(
        DecisionInbox.layer.pipe(
          Layer.provide(Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
          Layer.provideMerge(Profiles.layer),
          Layer.provideMerge(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provideMerge(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("origin")),
            }),
          ),
          Layer.provide(ServerSettings.layerTest({})),
        ),
      ),
    ),
  );

const message = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "admitted" }));

it.effect("a person's approval covers exactly the reviewed items on this machine, once", () =>
  withConsent(({ consent, respond }) =>
    Effect.gen(function* () {
      const request = yield* consent.ask(fromThread, asked, listed);
      if (request.kind !== "handoff")
        return expect.unreachable("a thread is asked through a handoff");
      expect(request.handoff).toMatchObject({ targetPath: "storage.clean", state: "pending" });
      expect(request.handoff.expiresAt).not.toBeNull();
      const id = request.handoff.handoffId;
      expect(yield* message(consent.admit(fromThread, id, asked))).toContain("still open");
      yield* respond(id, "completed");
      // A changed item, an extra item, or a missing one is something the person did not see.
      for (const other of [
        [asked[0]!, { ...asked[1]!, token: "b2" }],
        [...asked, { id: "worktree:/w/c", token: "c1" }],
        [asked[0]!],
      ])
        expect(yield* message(consent.admit(fromThread, id, other))).toContain("does not cover");
      expect(yield* message(consent.admit(fromThread, id, asked.toReversed()))).toBe("admitted");
      expect(yield* message(consent.admit(fromThread, id, asked))).toContain("already used");
    }),
  ),
);

it.effect("a declined approval deletes nothing", () =>
  withConsent(({ consent, respond }) =>
    Effect.gen(function* () {
      const request = yield* consent.ask(fromThread, asked, listed);
      if (request.kind !== "handoff")
        return expect.unreachable("a thread is asked through a handoff");
      yield* respond(request.handoff.handoffId, "declined");
      expect(yield* message(consent.admit(fromThread, request.handoff.handoffId, asked))).toContain(
        "was not given",
      );
    }),
  ),
);
