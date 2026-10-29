import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  PullRequestOperationError,
  SourceControlProviderKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry, type AgentSurfaceEntry } from "@goat/contracts/agentSurface";
import { PullRequestProviderError } from "@goat/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { mcpClientScopes } from "../../../auth/mcpClientScopes.ts";
import * as Sync from "../../../orchestration-v2/PullRequestSyncReactor.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as Settings from "../../../serverSettings.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { catalog, client, dependenciesWithPullRequests } from "../../agentSurface.testkit.ts";
import { type McpInvocationScope, McpInvocationContext } from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { makeProject } from "./handlers.testkit.ts";
import { PullRequestsToolkit } from "./tools.ts";

const callerId = ThreadId.make("pr-writer");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("pr-writes-test"),
  requestNamespace: "pr-writes-test",
  capabilities: new Set(["pull-requests", "orchestration"]),
  issuedAt: 0,
  thread: {
    threadId: callerId,
    providerSessionId: "pr-writes-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const target = { url: "https://github.com/sample-tools/goat/pull/42" };
const receipt = {
  host: "github.com",
  repository: "sample-tools/goat",
  number: 42,
  url: target.url,
  status: "accepted",
};

const harness = Effect.fn("prWritesTest.harness")(function* (
  options: {
    profile?: string;
    plan?: boolean;
    partial?: "comment" | "submitReview";
    refuse?: "comment" | "runAction";
    hang?: "comment";
  } = {},
) {
  const calls = yield* Ref.make<ReadonlyArray<{ method: string; input: unknown }>>([]);
  const syncs = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const record = (method: string, input: unknown) =>
    Ref.update(calls, (all) => [...all, { method, input }]).pipe(
      Effect.andThen(
        options.partial === method
          ? Effect.fail(
              // The host failed after an earlier request of the same write, so part of it may have
              // landed; a GitLab review can be throttled after its comments posted.
              new PullRequestOperationError({
                operation: method,
                detail: "partly posted",
                cause: new PullRequestProviderError({
                  provider: SourceControlProviderKind.make("github"),
                  operation: method,
                  reason: method === "submitReview" ? "rate-limited" : "failed",
                  detail: "partly posted",
                }),
              }),
            )
          : options.refuse === method
            ? // The service's own check, before any request to the host.
              Effect.fail(
                new PullRequestOperationError({
                  operation: method,
                  detail:
                    method === "runAction"
                      ? "This host cannot enforce the expected head for this merge action and method."
                      : "You need write access on this repository to comment on a change request.",
                }),
              )
            : options.hang === method
              ? Effect.never
              : Effect.void,
      ),
    );
  const project = makeProject();
  const shell = {
    ...liveThreadShell(callerId, { interactionMode: options.plan ? "plan" : "default" }),
    projectId: project.id,
  };
  const overrides = Layer.mergeAll(
    dependenciesWithPullRequests({
      update: (input) => record("update", input),
      comment: (input) => record("comment", input),
      updateComment: (input) => record("updateComment", input),
      submitReview: (input) => record("submitReview", input),
      replyToThread: (input) => record("replyToThread", input),
      setThreadResolution: (input) => record("setThreadResolution", input),
      setReaction: (input) => record("setReaction", input),
      setLabels: (input) => record("setLabels", input),
      requestReviewers: (input) => record("requestReviewers", input),
      runAction: (input) => record("runAction", input),
    }),
    Layer.mock(Projects.ProjectService)({ listShells: () => Effect.succeed([project]) }),
    Layer.mock(Orchestrator.OrchestratorV2)({ getThreadShell: () => Effect.succeed(shell) }),
    Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(shell) }),
    Layer.mock(Sync.PullRequestSyncReactor)({
      requestSync: (key) => Ref.update(syncs, (all) => [...all, key]),
    }),
  );
  const registered = catalog.pipe(
    Layer.provide(overrides),
    Layer.provideMerge(
      Settings.layerTest({
        goatclaw: { enabled: true, defaultProfile: options.profile ?? "merge-manager" },
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(McpServer.McpServer.layer),
  );
  return { calls, syncs, registered };
});

const seed = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${callerId}, 'project-1', 'PR writes', 'codex', 'full-access', 'default', '2026-10-28', '2026-10-28', '{}')`,
  ),
);
const reservations = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) => sql`SELECT path, state FROM mcp_request_reservations`),
);
const call = (name: string, args: object, as = scope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result) => {
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      return JSON.parse(text) as Record<string, unknown>;
    }),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(McpInvocationContext, as),
  );
const write = (verb: string, args: object, as = scope) =>
  call(`goat_pull_request_${verb}`, { ...target, ...args }, as);

it.effect("replays a comment receipt once and refuses a different body for the same key", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* seed;
      expect(yield* write("comment", { body: "Hello", clientRequestId: "comment-1" })).toEqual(
        receipt,
      );
      expect(yield* write("comment", { body: "Hello", clientRequestId: "comment-1" })).toEqual(
        receipt,
      );
      expect(
        yield* write("comment", { body: "Changed", clientRequestId: "comment-1" }),
      ).toMatchObject({ code: "conflict", reason: "idempotency_mismatch" });
      expect(yield* Ref.get(h.calls)).toHaveLength(1);
      expect(yield* reservations).toEqual([{ path: "pull_request.comment", state: "completed" }]);
    }).pipe(Effect.provide(h.registered));
  }),
);

it.effect(
  "requires a non-null advertised key and refuses missing or null keys before reservation",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        yield* seed;
        const server = yield* McpServer.McpServer;
        for (const [verb, args] of [
          ["comment", { body: "Hello" }],
          ["review_submit", { verdict: "approve", body: "", comments: [] }],
          ["thread_reply", { threadId: "review-thread", body: "Hello" }],
        ] as const) {
          const name = `goat_pull_request_${verb}` as const;
          const tool = server.tools.find(({ tool }) => tool.name === name)?.tool;
          expect(tool, name).toBeDefined();
          const schema = tool!.inputSchema;
          expect(schema.required).toContain("clientRequestId");
          expect(schema.properties?.clientRequestId).toMatchObject({ type: "string" });
          expect(JSON.stringify(schema.properties?.clientRequestId)).not.toContain('"null"');
          const raw = PullRequestsToolkit.tools[name];
          const advertised: { properties?: Readonly<Record<string, unknown>> } =
            advertisedJsonSchema(raw);
          expect(advertised).toMatchObject({
            required: expect.arrayContaining(["clientRequestId"]),
            properties: { clientRequestId: { type: "string" } },
          });
          expect(JSON.stringify(advertised.properties?.clientRequestId)).not.toContain('"null"');
          for (const key of [{}, { clientRequestId: null }])
            expect(yield* write(verb, { ...args, ...key })).toMatchObject({
              code: "invalid_request",
            });
        }
        expect(yield* Ref.get(h.calls)).toEqual([]);
        expect(yield* reservations).toEqual([]);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect.each(["worker", "merge-manager"])(
  "%s only merges and closes with pr.merge, before reservation",
  (profile) =>
    Effect.gen(function* () {
      const h = yield* harness({ profile });
      yield* Effect.gen(function* () {
        yield* seed;
        for (const verb of ["merge", "close", "branch_delete"]) {
          const result = yield* write(
            verb,
            verb === "branch_delete" ? {} : { clientRequestId: verb },
          );
          expect(result).toMatchObject(
            profile === "worker" ? { code: "capability_denied" } : receipt,
          );
        }
        expect(yield* Ref.get(h.calls)).toHaveLength(profile === "worker" ? 0 : 3);
        expect(yield* reservations).toHaveLength(profile === "worker" ? 0 : 2);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect("repeats branch deletion without reserving a retry key", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* Effect.gen(function* () {
      yield* seed;
      for (let repeat = 0; repeat < 2; repeat++)
        expect(
          yield* call("goat_call", { path: "pull_request.branch_delete", args: target }),
        ).toMatchObject({ status: "ok", value: receipt });
      expect(yield* Ref.get(h.calls)).toHaveLength(2);
      expect(yield* reservations).toEqual([]);
    }).pipe(Effect.provide(h.registered));
  }),
);

it.effect("returns the service's unsupported head-pin refusal through goat_call", () =>
  Effect.gen(function* () {
    const h = yield* harness({ refuse: "runAction" });
    yield* Effect.gen(function* () {
      yield* seed;
      expect(
        yield* call("goat_call", {
          path: "pull_request.merge",
          args: { ...target, headSha: "reviewed-head", clientRequestId: "pinned" },
        }),
      ).toMatchObject({
        status: "error",
        error: { code: "failed_precondition", message: expect.stringContaining("expected head") },
      });
    }).pipe(Effect.provide(h.registered));
  }),
);

it.effect.each(["plan", "readOnly"])(
  "refuses %s PR writes before the service or reservation",
  (restriction) =>
    Effect.gen(function* () {
      const h = yield* harness({ plan: restriction === "plan" });
      yield* Effect.gen(function* () {
        yield* seed;
        expect(
          yield* write(
            "comment",
            { body: "Hello", clientRequestId: "refused" },
            { ...scope, readOnly: restriction === "readOnly" },
          ),
        ).toMatchObject({ code: "capability_denied" });
        expect(yield* Ref.get(h.calls)).toEqual([]);
        expect(yield* reservations).toEqual([]);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect(
  "requires outside clients to hold and reauthorize source-control:write before reserving",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const reauthorized = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const outside: McpInvocationScope = {
        ...scope,
        thread: undefined,
        client: { sessionId: "outside", label: "Outside", access: "auto" },
      };
      yield* Effect.gen(function* () {
        const args = { body: "Hello", clientRequestId: "outside" };
        for (const as of [
          outside,
          {
            ...outside,
            grantedScopes: mcpClientScopes("auto"),
            reauthorize: () => Effect.void,
          },
          { ...outside, grantedScopes: ["source-control:write"] as const },
          {
            ...outside,
            grantedScopes: ["source-control:write"] as const,
            reauthorize: () =>
              Effect.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: "source-control:write",
                  message: "Revoked",
                }),
              ),
          },
          {
            ...outside,
            client: { ...outside.client!, access: "read-only" as const },
            grantedScopes: ["source-control:write"] as const,
            reauthorize: () => Effect.void,
          },
        ]) {
          expect(yield* write("comment", args, as)).toMatchObject({ code: "capability_denied" });
          expect(yield* Ref.get(h.calls)).toEqual([]);
          expect(yield* reservations).toEqual([]);
        }
        expect(
          yield* write("comment", args, {
            ...outside,
            grantedScopes: ["source-control:write"],
            reauthorize: (required) => Ref.update(reauthorized, (all) => [...all, required]),
          }),
        ).toEqual(receipt);
        expect(yield* Ref.get(reauthorized)).toContainEqual(["source-control:write"]);
        expect(yield* Ref.get(h.calls)).toHaveLength(1);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect(
  "maps PR writes to existing services, requests action syncs, and returns accepted receipts",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        yield* seed;
        const cases = [
          ["update", { title: "New title", body: "" }, "update", { title: "New title", body: "" }],
          [
            "comment_update",
            { commentId: "c1", kind: "issue-comment", body: "Edit" },
            "updateComment",
            { commentId: "c1", kind: "issue-comment", body: "Edit" },
          ],
          [
            "review_submit",
            { verdict: "approve", body: "", comments: [] },
            "submitReview",
            { verdict: "approve", body: "", comments: [] },
          ],
          [
            "thread_reply",
            { threadId: "r1", body: "Reply" },
            "replyToThread",
            { threadId: "r1", body: "Reply" },
          ],
          [
            "thread_resolve",
            { threadId: "r1", resolved: false },
            "setThreadResolution",
            { threadId: "r1", resolved: false },
          ],
          [
            "react",
            { content: "thumbs-up", reacted: false },
            "setReaction",
            { content: "thumbs-up", reacted: false },
          ],
          [
            "labels",
            { labels: ["bug"], applied: false },
            "setLabels",
            { labels: ["bug"], applied: false },
          ],
          [
            "reviewers",
            { reviewers: [{ id: "alice", kind: "user" }], requested: false },
            "requestReviewers",
            { reviewers: [{ id: "alice", kind: "user" }], requested: false },
          ],
          [
            "action",
            { action: "update-branch", updateMethod: "rebase" },
            "runAction",
            { action: "update-branch", updateMethod: "rebase" },
          ],
          [
            "merge",
            { method: "squash", headSha: "abc123" },
            "runAction",
            { action: "merge", mergeMethod: "squash", headSha: "abc123" },
          ],
          [
            "merge",
            { auto: true, method: "merge" },
            "runAction",
            { action: "enable-auto-merge", mergeMethod: "merge" },
          ],
          ["close", {}, "runAction", { action: "close" }],
          ["branch_delete", {}, "runAction", { action: "delete-branch" }],
        ] as const;
        for (const [index, [verb, args, method, mapped]] of cases.entries()) {
          expect(
            yield* write(
              verb,
              verb === "branch_delete" ? args : { ...args, clientRequestId: `write-${index}` },
            ),
          ).toEqual(receipt);
          expect((yield* Ref.get(h.calls)).at(-1)).toEqual({
            method,
            input: {
              projectId: "project-1",
              host: "github.com",
              repository: "sample-tools/goat",
              number: 42,
              ...mapped,
            },
          });
        }
        expect(yield* Ref.get(h.syncs)).toEqual(
          Array.from({ length: 5 }, () => ({
            host: "github.com",
            repository: "sample-tools/goat",
            number: 42,
          })),
        );
        const before = (yield* Ref.get(h.calls)).length;
        for (const action of ["delete-branch", "revert", "approve-workflows", "merge", "close"])
          expect(
            yield* write("action", { action, clientRequestId: `excluded-${action}` }).pipe(
              Effect.result,
            ),
          ).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidParams" } });
        expect(yield* Ref.get(h.calls)).toHaveLength(before);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect.each(["comment", "submitReview"] as const)(
  "never reruns %s after a partial host effect with an unsettled key",
  (partial) =>
    Effect.gen(function* () {
      const h = yield* harness({ partial });
      yield* Effect.gen(function* () {
        yield* seed;
        const verb = partial === "comment" ? "comment" : "review_submit";
        const args = {
          ...target,
          clientRequestId: "partial",
          ...(partial === "comment"
            ? { body: "Hello" }
            : { verdict: "approve", body: "", comments: [] }),
        };
        expect(yield* call("goat_call", { path: `pull_request.${verb}`, args })).toMatchObject({
          status: "error",
          error: { code: "unknown_outcome", retryable: false },
        });
        expect(yield* call(`goat_pull_request_${verb}`, args)).toMatchObject({
          code: "conflict",
          reason: "outcome_unknown",
          reconcile: "pull_request.activity",
        });
        expect(yield* call("goat_call", { path: `pull_request.${verb}`, args })).toMatchObject({
          status: "error",
          error: { code: "unknown_outcome", retryable: false },
        });
        expect(yield* Ref.get(h.calls)).toHaveLength(1);
        expect(yield* reservations).toEqual([{ path: `pull_request.${verb}`, state: "unknown" }]);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect(
  "preserves goat_call keys and derives eval keys for runs, journal retries and dryRun",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* Effect.gen(function* () {
        yield* seed;
        const args = { ...target, body: "Wrapped", clientRequestId: "wrapped" };
        for (let repeat = 0; repeat < 2; repeat++)
          expect(yield* call("goat_call", { path: "pull_request.comment", args })).toMatchObject({
            status: "ok",
            value: receipt,
          });
        expect(yield* Ref.get(h.calls)).toHaveLength(1);
        const program =
          '(pull_request.comment :url "https://github.com/sample-tools/goat/pull/42" :body "Eval")';
        expect(yield* call("goat_eval", { program, dryRun: true })).toMatchObject({
          status: "ok",
          value: {
            plan: { calls: [{ path: "pull_request.comment", keyed: true, argIssues: [] }] },
          },
        });
        expect(yield* Ref.get(h.calls)).toHaveLength(1);
        const first = yield* call("goat_eval", { program, clientRequestId: "eval-comments" });
        expect(first).toMatchObject({
          status: "ok",
          value: receipt,
          steps: { live: 1, restored: 0 },
        });
        expect(
          yield* call("goat_eval", { program, clientRequestId: "eval-comments" }),
        ).toMatchObject({
          status: "ok",
          value: receipt,
          evalRunId: first.evalRunId,
          steps: { live: 0, restored: 1 },
        });
        expect(yield* Ref.get(h.calls)).toHaveLength(2);
        expect(yield* reservations).toHaveLength(2);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect(
  "settles a refusal before posting, so a new key runs while the old key answers the same",
  () =>
    Effect.gen(function* () {
      const h = yield* harness({ refuse: "comment" });
      yield* Effect.gen(function* () {
        yield* seed;
        const args = { ...target, body: "Hello", clientRequestId: "refused" };
        for (let repeat = 0; repeat < 2; repeat++)
          expect(yield* call("goat_call", { path: "pull_request.comment", args })).toMatchObject({
            status: "error",
            error: {
              code: "failed_precondition",
              message: expect.stringContaining("write access"),
            },
          });
        expect(yield* reservations).not.toContainEqual(
          expect.objectContaining({ state: "unknown" }),
        );
        yield* call("goat_call", {
          path: "pull_request.comment",
          args: { ...args, clientRequestId: "after-access" },
        });
        expect(yield* Ref.get(h.calls)).toHaveLength(2);
      }).pipe(Effect.provide(h.registered));
    }),
);

it.effect("keeps the pull request guidance when goat_eval stops on an unknown outcome", () =>
  Effect.gen(function* () {
    const h = yield* harness({ partial: "comment" });
    yield* Effect.gen(function* () {
      yield* seed;
      const program =
        '(pull_request.comment :url "https://github.com/sample-tools/goat/pull/42" :body "Eval")';
      const guidance = expect.stringContaining("Never resend with a new key");
      for (let repeat = 0; repeat < 2; repeat++)
        expect(
          yield* call("goat_eval", { program, clientRequestId: "eval-partial" }),
        ).toMatchObject({
          status: "error",
          error: { code: "unknown_outcome", message: guidance },
        });
      expect(yield* Ref.get(h.calls)).toHaveLength(1);
    }).pipe(Effect.provide(h.registered));
  }),
);

it.effect("keeps the pull request caution when goat_eval times out during a write", () =>
  Effect.gen(function* () {
    const h = yield* harness({ hang: "comment" });
    yield* Effect.gen(function* () {
      yield* seed;
      const program =
        '(pull_request.comment :url "https://github.com/sample-tools/goat/pull/42" :body "Slow")';
      const running = yield* Effect.forkChild(
        call("goat_eval", { program, clientRequestId: "eval-slow" }),
      );
      yield* TestClock.adjust("121 seconds");
      expect(yield* Fiber.join(running)).toMatchObject({
        status: "error",
        error: {
          code: "unknown_outcome",
          message: expect.stringContaining("Never resend with a new key"),
        },
      });
    }).pipe(Effect.provide(h.registered));
  }),
);

it("starts thread reconciliation from activity and warns that GitLab approval cannot be confirmed there", () => {
  const entries: Readonly<Record<string, AgentSurfaceEntry>> = agentSurfaceRegistry;
  for (const verb of ["thread_reply", "thread_resolve"])
    expect(entries[`pull_request.${verb}`]?.reconcile).toBe("pull_request.activity");
  expect(entries["pull_request.review_submit"]?.guide).toContain("approve-only");
  expect(entries["pull_request.review_submit"]?.guide).toContain("unknown_outcome");
  expect(entries["pull_request.review_submit"]?.guide).toContain("tell the user");
});
