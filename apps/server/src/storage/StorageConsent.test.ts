import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type AuthClientSession,
  type HandoffSummary,
  type StorageItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type * as Handoffs from "../handoffs/Handoffs.ts";
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
import { makeStorageConsent, storageApprovalText } from "./StorageConsent.ts";

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

/** The signed-in clients, as the session store lists them; the test sets their scopes. */
const signedIn: { scopes: AuthClientSession["scopes"] } = { scopes: [] };
const ownerSession = "session:owner";
const fromClient: McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "test:client",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "session:cli", label: "goat storage", access: "full-access" },
};

const withConsent = <A, E>(
  body: (input: {
    readonly consent: Effect.Success<typeof makeStorageConsent>;
    readonly inbox: DecisionInbox.DecisionInbox["Service"];
    readonly respond: (
      handoffId: HandoffSummary["handoffId"],
      action: "completed" | "declined",
    ) => ReturnType<Handoffs.Handoffs["Service"]["respond"]>;
  }) => Effect.Effect<A, E>,
) =>
  withApprovals(({ handoffs }) =>
    Effect.gen(function* () {
      const consent = yield* makeStorageConsent;
      return yield* body({
        consent,
        inbox: yield* DecisionInbox.DecisionInbox,
        respond: (handoffId, action) => handoffs.respond({ threadId, handoffId, action }, person),
      });
    }).pipe(
      Effect.provide(
        DecisionInbox.layer.pipe(
          Layer.provide(Layer.mock(PendingQuestions.PendingQuestionsMcpService)({})),
          Layer.provideMerge(Profiles.layer),
          Layer.provideMerge(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provideMerge(
            Layer.mock(SessionStore.SessionStore)({
              cookieName: "test",
              legacyCookieName: undefined,
              listActive: () =>
                Effect.sync(() => {
                  const now = DateTime.makeUnsafe("2026-10-25T00:00:00Z");
                  return [
                    {
                      sessionId: ownerSession,
                      subject: "browser",
                      method: "browser-session-cookie",
                      scopes: signedIn.scopes,
                      client: { label: "Laptop", deviceType: "unknown" },
                      issuedAt: now,
                      expiresAt: DateTime.add(now, { days: 1 }),
                      lastConnectedAt: now,
                      connected: true,
                      current: false,
                    } as AuthClientSession,
                  ];
                }),
            }),
          ),
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

it("the person is shown every path an approval covers, however many", () => {
  const many = Array.from({ length: 200 }, (_, index) => item("/w/many-" + index, "t" + index));
  const shown = storageApprovalText(many).location;
  for (const listedItem of many) expect(shown).toContain(listedItem.path + " (");
});

it.effect("a decision approves a deletion only for a person who may delete GOAT storage", () =>
  withConsent(({ consent, inbox }) =>
    Effect.gen(function* () {
      const request = yield* consent.ask(fromClient, asked, listed);
      if (request.kind !== "decision") return expect.unreachable("a client is asked by a decision");
      // An owner who may operate and change settings, but not maintain this machine.
      signedIn.scopes = ["orchestration:operate", "settings:write"];
      yield* inbox.answer(
        {
          kind: "client",
          environmentId: EnvironmentId.make("origin"),
          sessionId: ownerSession,
          scopes: signedIn.scopes,
        },
        { id: request.decisionId, optionId: "approve", reason: "Free the space." },
      );
      expect(yield* message(consent.admit(fromClient, request.decisionId, asked))).toContain(
        "environment:maintain",
      );
      signedIn.scopes = ["orchestration:operate", "settings:write", "environment:maintain"];
      expect(yield* message(consent.admit(fromClient, request.decisionId, asked))).toBe("admitted");
    }),
  ),
);
