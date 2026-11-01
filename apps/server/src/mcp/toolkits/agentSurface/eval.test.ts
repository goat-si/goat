import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import type { EvalInput } from "@goat/contracts/agentSurface/eval";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import type { HandoffReader } from "../../operations/handoffReads.ts";
import * as ToolAdmission from "../../ToolAdmission.ts";
import { makeEvalRunner } from "./evalRunner.ts";

const read = agentSurfaceRegistry["project.list"];
// A keyed write (idempotency "key"), and a write GOAT does not deduplicate.
const keyed = agentSurfaceRegistry["project.delete"];
const plain = agentSurfaceRegistry["provider.login_cancel"];

/** What the targets saw, so a test can tell a journal restore from a second call. */
class Probe extends Context.Service<
  Probe,
  {
    readonly projects: Ref.Ref<ReadonlyArray<string>>;
    readonly busy: Ref.Ref<boolean>;
    readonly reads: Ref.Ref<number>;
    readonly writes: Ref.Ref<ReadonlyArray<string>>;
    readonly cancels: Ref.Ref<number>;
    readonly handoff: Ref.Ref<"pending" | "completed">;
    readonly parked: Deferred.Deferred<void>;
  }
>()("goat/mcp/toolkits/agentSurface/eval.test/Probe") {}

const probeTool = <const Name extends string, Fields extends Schema.Struct.Fields>(
  name: Name,
  fields: Fields,
) =>
  Tool.make(name, {
    parameters: Schema.Struct(fields),
    success: Schema.Unknown,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Probe],
  });
const ProbeToolkit = Toolkit.make(
  probeTool(read.name, { limit: Schema.optional(Schema.Number) }),
  probeTool(keyed.name, {
    projectId: Schema.String,
    clientRequestId: Schema.optional(Schema.String),
  }),
  probeTool(plain.name, { flowId: Schema.String }),
);

const handoff = (state: string) => ({
  handoffId: "handoff:1",
  kind: "approval",
  title: "Approve the deletion",
  state,
  expiresAt: null,
  targetPath: keyed.path,
});

const handlers = {
  [read.name]: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const probe = yield* Probe;
      yield* Ref.update(probe.reads, (count) => count + 1);
      const ids = yield* Ref.get(probe.projects);
      return { projects: ids.map((id) => ({ id, title: `Project ${id}`, root: `/work/${id}` })) };
    }),
  ),
  [keyed.name]: McpToolAccess.writesWithCapability(
    ({ projectId }: { readonly projectId: string }) =>
      Effect.gen(function* () {
        const probe = yield* Probe;
        if (projectId === "flaky" && (yield* Ref.get(probe.busy)))
          return yield* new OrchestratorMcpFailure({ code: "host_pressure", message: "busy" });
        yield* Ref.update(probe.writes, (writes) => [...writes, projectId]);
        if (projectId === "lost")
          return yield* new OrchestratorMcpFailure({
            code: "host_unavailable",
            reason: "ssh_failed",
            mayHaveStarted: true,
            message: "The host stopped answering after the write was sent.",
          });
        if (projectId === "human") return { kind: "needs_human", handoff: handoff("pending") };
        if (projectId === "park") {
          yield* Deferred.succeed(probe.parked, undefined);
          return yield* Effect.never;
        }
        return { deleted: projectId };
      }),
  ),
  [plain.name]: McpToolAccess.writesWithCapability(() =>
    Effect.gen(function* () {
      const probe = yield* Probe;
      yield* Ref.update(probe.cancels, (count) => count + 1);
      return { cancelled: true };
    }),
  ),
} as unknown as McpToolAccess.Handlers<typeof ProbeToolkit.tools>;

// goat_call itself, its ToolDispatch, ToolAdmission and the journal all run as served.
const served = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(ProbeToolkit, McpToolAccess.toLayer(ProbeToolkit, handlers)),
  McpHttpServer.catalogRegistrations.agentSurface,
).pipe(
  Layer.provideMerge(
    Layer.effect(
      Probe,
      Effect.all({
        projects: Ref.make<ReadonlyArray<string>>(["a", "b"]),
        busy: Ref.make(false),
        reads: Ref.make(0),
        writes: Ref.make<ReadonlyArray<string>>([]),
        cancels: Ref.make(0),
        handoff: Ref.make<"pending" | "completed">("pending"),
        parked: Deferred.make<void>(),
      }),
    ),
  ),
  Layer.provideMerge(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
    }),
  ),
  Layer.provideMerge(Profiles.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          liveThreadShell(threadId, { runtimeMode: "full-access", interactionMode: "default" }),
        ),
    }),
  ),
  Layer.provideMerge(Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({})),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest({ goatclaw: { enabled: false } })),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "eval-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "eval-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scopeOf = (thread: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${thread}`,
  thread: {
    threadId: ThreadId.make(thread),
    providerSessionId: `provider:${thread}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const caller = scopeOf("thread:caller");

/** The handoff store as the runner reads it: pending until the test settles it. */
const handoffReader =
  (state: Ref.Ref<"pending" | "completed">): HandoffReader =>
  () =>
    Effect.map(Ref.get(state), (current): AgentSurfaceResult =>
      current === "pending"
        ? { status: "needs_human", handoff: handoff("pending") }
        : { status: "ok", value: { handoff: handoff("completed"), applying: false } },
    );

const evaluate = (
  input: EvalInput,
  as = caller,
  answer: (result: AgentSurfaceResult) => AgentSurfaceResult = (result) => result,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const probe = yield* Probe;
    const runner = makeEvalRunner({
      // Exactly what goat_call does for a direct caller.
      invoke: (path, args) =>
        server.callTool({ name: "goat_call", arguments: { path, args } }).pipe(
          Effect.map((result) => answer(result.structuredContent as AgentSurfaceResult)),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.orDie,
        ),
      dispatch: {
        call: () => Effect.die("unused"),
        served: (name) => server.tools.find(({ tool }) => tool.name === name)?.tool,
      },
      permissions: yield* Profiles.PermissionProfiles,
      admission: yield* ToolAdmission.makeEvalAdmission(),
      readHandoff: handoffReader(probe.handoff),
    });
    return (yield* runner.run(input)) as Record<string, unknown> & {
      readonly status: string;
    };
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, as));

const probed = Effect.gen(function* () {
  const probe = yield* Probe;
  return {
    reads: yield* Ref.get(probe.reads),
    writes: yield* Ref.get(probe.writes),
    cancels: yield* Ref.get(probe.cancels),
  };
});

it.effect(
  "restores completed reads from the journal on a retry instead of calling them again",
  () =>
    Effect.gen(function* () {
      const probe = yield* Probe;
      yield* Ref.set(probe.busy, true);
      const program = `(let ((ps (. (project.list) "projects")))
      (seq (pick ps "id") (project.delete :projectId "flaky")))`;
      const first = yield* evaluate({ program, clientRequestId: "retry" });
      expect(first).toMatchObject({
        status: "error",
        error: { code: "resource_exhausted" },
        completedSteps: [{ path: "project.list" }],
      });
      yield* Ref.set(probe.busy, false);
      const retried = yield* evaluate({ program, clientRequestId: "retry" });
      // Only the picked fields come back; the read ran once.
      expect(retried).toMatchObject({
        status: "ok",
        value: [[{ id: "a" }, { id: "b" }], { deleted: "flaky" }],
        evalRunId: first.evalRunId,
        steps: { live: 1, restored: 1 },
      });
      expect(yield* probed).toEqual({ reads: 1, writes: ["flaky"], cancels: 0 });
      // Another program cannot continue the run, and another caller cannot see it.
      expect(
        yield* evaluate({ program: "(project.list)", resume: String(first.evalRunId) }),
      ).toMatchObject({ status: "error", error: { reason: "eval_program_changed" } });
      expect(
        yield* evaluate({ resume: String(first.evalRunId) }, scopeOf("thread:other")),
      ).toMatchObject({ status: "error", error: { reason: "eval_run_not_found" } });
      expect((yield* probed).reads).toBe(1);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "derives a distinct write key per map element and never sends a completed write twice",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const program =
        '(map p (. (project.list) "projects") (project.delete :projectId (. p "id")))';
      const done = yield* evaluate({ program, clientRequestId: "fan" });
      expect(done).toMatchObject({ status: "ok", value: [{ deleted: "a" }, { deleted: "b" }] });
      const keys = (yield* sql<{ readonly key: string }>`SELECT client_request_id AS key
      FROM mcp_request_reservations ORDER BY created_at, client_request_id`).map(({ key }) => key);
      expect(new Set(keys).size).toBe(2);
      // The second element's key binds the run, its place in the map, the element and the arguments.
      const element = { id: "b", title: "Project b", root: "/work/b" };
      const elementDigest = (yield* ToolAdmission.argumentsDigest(element)).slice(0, 12);
      expect(keys).toContain(
        ToolAdmission.derivedStepRequestId(
          String(done.evalRunId),
          `r.3@r[1:${elementDigest}]`,
          keyed.path,
          yield* ToolAdmission.argumentsDigest({ projectId: "b" }),
        ),
      );
      const again = yield* evaluate({ program, clientRequestId: "fan" });
      expect(again).toMatchObject({ status: "ok", steps: { live: 0, restored: 3 } });
      expect((yield* probed).writes).toEqual(["a", "b"]);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "stops at needs_human and unknown_outcome even inside try and never calls them again",
  () =>
    Effect.gen(function* () {
      const probe = yield* Probe;
      const human = { program: '(try (project.delete :projectId "human"))', clientRequestId: "h" };
      expect(yield* evaluate(human)).toMatchObject({
        status: "needs_human",
        handoff: { handoffId: "handoff:1" },
        haltedAt: "r.1",
      });
      expect(yield* evaluate(human)).toMatchObject({ status: "needs_human" });
      yield* Ref.set(probe.handoff, "completed");
      expect(yield* evaluate(human)).toMatchObject({
        status: "error",
        error: { code: "failed_precondition", reason: "eval_handoff_settled" },
      });

      const lost = { program: '(try (project.delete :projectId "lost"))', clientRequestId: "l" };
      expect(yield* evaluate(lost)).toMatchObject({
        status: "error",
        error: {
          code: "unknown_outcome",
          retryable: false,
          details: { reconcile: "project.list" },
        },
      });
      expect(yield* evaluate(lost)).toMatchObject({
        status: "error",
        error: { code: "unknown_outcome" },
      });
      expect((yield* probed).writes).toEqual(["human", "lost"]);
    }).pipe(Effect.provide(served)),
);

it.effect("halts a write a stopped server left running instead of sending it again", () =>
  Effect.gen(function* () {
    const probe = yield* Probe;
    const sql = yield* SqlClient.SqlClient;
    yield* Ref.set(probe.busy, true);
    const program = '(seq (provider.login_cancel :flowId "f") (project.delete :projectId "flaky"))';
    const first = yield* evaluate({ program, clientRequestId: "stopped" });
    expect(first).toMatchObject({ status: "error", error: { code: "resource_exhausted" } });
    // As if the server stopped after sending the cancel and before recording its outcome.
    yield* sql`UPDATE mcp_eval_steps SET state = 'running', boot_id = 'boot:stopped',
      result_json = NULL WHERE path = ${plain.path}`;
    yield* Ref.set(probe.busy, false);
    expect(yield* evaluate({ program, clientRequestId: "stopped" })).toMatchObject({
      status: "error",
      error: { code: "unknown_outcome", retryable: false },
      haltedAt: "r.1",
    });
    expect(yield* probed).toMatchObject({ cancels: 1, writes: [] });
  }).pipe(Effect.provide(served)),
);

it.effect("refuses recursion and over-limit programs before anything runs", () =>
  Effect.gen(function* () {
    const refusals = [
      [{ program: '(goat_call :path "project.list")' }, "not_callable"],
      [{ program: ["goat_eval", { program: "(project.list)" }] }, "not_callable"],
      [
        { program: ["seq", ...Array.from({ length: 33 }, () => ["project.list"])] },
        "eval_call_limit",
      ],
      [{ program: '(project.delete :projectId "a" :clientRequestId "mine")' }, "eval_explicit_key"],
      [{ program: "(if 1e999 (project.list) (project.list))" }, "eval_parse"],
      [
        {
          program: "(if x (project.list) (project.list))",
          bindings: { x: Number.POSITIVE_INFINITY },
        },
        "eval_bindings",
      ],
    ] as const;
    for (const [input, reason] of refusals) {
      const result = yield* evaluate(input);
      expect(result, reason).toMatchObject({ status: "error", error: { reason } });
      expect(result, reason).not.toHaveProperty("evalRunId");
    }
    expect(yield* probed).toEqual({ reads: 0, writes: [], cancels: 0 });
  }).pipe(Effect.provide(served)),
);

it.effect("answers dryRun with the plan alone and runs nothing", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const result = yield* evaluate({
      program: '(seq (project.list) (project.delete :projectId "a" :force true))',
      dryRun: true,
    });
    expect(result).toEqual({
      status: "ok",
      value: {
        plan: {
          maxCalls: 2,
          calls: [
            expect.objectContaining({
              path: read.path,
              effect: "read",
              keyed: false,
              args: "static",
              available: { now: true },
            }),
            expect.objectContaining({
              path: keyed.path,
              keyed: true,
              args: "static",
              argIssues: ["force is not an argument"],
            }),
          ],
        },
      },
    });
    expect(yield* probed).toEqual({ reads: 0, writes: [], cancels: 0 });
    expect(yield* sql`SELECT eval_run_id FROM mcp_eval_runs`).toEqual([]);
  }).pipe(Effect.provide(served)),
);

it.effect("treats an element with its keys in another order as the same step", () =>
  Effect.gen(function* () {
    const program = '(map p ps (project.delete :projectId (. p "id")))';
    const first = yield* evaluate({
      program,
      bindings: { ps: [{ id: "a", owner: "o" }] },
      clientRequestId: "order",
    });
    expect(first).toMatchObject({ status: "ok", value: [{ deleted: "a" }] });
    expect(
      yield* evaluate({
        program,
        bindings: { ps: [{ owner: "o", id: "a" }] },
        clientRequestId: "order",
      }),
    ).toMatchObject({ status: "ok", steps: { live: 0, restored: 1 } });
    expect((yield* probed).writes).toEqual(["a"]);
  }).pipe(Effect.provide(served)),
);

it.effect("settles a run whose call was interrupted so it can be resumed", () =>
  Effect.gen(function* () {
    const probe = yield* Probe;
    const input = { program: '(project.delete :projectId "park")', clientRequestId: "park" };
    const running = yield* Effect.forkChild(evaluate(input));
    yield* Deferred.await(probe.parked);
    yield* Fiber.interrupt(running);
    // Not refused as still running: the write may have happened, so it is never sent again.
    expect(yield* evaluate(input)).toMatchObject({
      status: "error",
      error: { code: "unknown_outcome" },
    });
    expect((yield* probed).writes).toEqual(["park"]);
  }).pipe(Effect.provide(served)),
);

it.effect("compares maps by their own keys only", () =>
  Effect.gen(function* () {
    expect(yield* evaluate({ program: '(eq {"__proto__" {}} {"other" 1})' })).toMatchObject({
      status: "ok",
      value: false,
    });
  }).pipe(Effect.provide(served)),
);

it.effect("drops a call's image blocks before they count against the result budget", () =>
  Effect.gen(function* () {
    // As a mounted goat_eval sees a screenshot: goat_call's own handle keeps the blocks in meta.
    const withImage = (result: AgentSurfaceResult): AgentSurfaceResult =>
      result.status === "ok"
        ? { ...result, meta: { content: [{ type: "image", data: new Uint8Array(300_000) }] } }
        : result;
    expect(
      yield* evaluate({ program: '(pick (project.list) "projects")' }, caller, withImage),
    ).toMatchObject({ status: "ok", value: { projects: [{ id: "a" }, { id: "b" }] } });
  }).pipe(Effect.provide(served)),
);

it.effect(
  "counts each map element's calls toward the cap and refuses a map over 16 or nesting past 8",
  () =>
    Effect.gen(function* () {
      const items = (n: number) => `[${Array.from({ length: n }, (_, i) => i).join(" ")}]`;
      // 16 elements with three reads each is 48 calls, though the program names three.
      const capped = yield* evaluate({
        program: `(map x ${items(16)} (seq (project.list) (project.list) (project.list)))`,
      });
      expect(capped).toMatchObject({
        status: "error",
        error: { code: "resource_exhausted", reason: "eval_call_limit" },
      });
      expect((yield* probed).reads).toBe(32);

      const wide = `(map x ${items(17)} (project.list))`;
      const first = yield* evaluate({ program: wide });
      expect(first).toMatchObject({
        status: "error",
        error: { code: "resource_exhausted", reason: "eval_map_limit" },
      });
      const again = yield* evaluate({ program: wide });
      expect(again.status === "error" && again.error).toEqual(
        first.status === "error" && first.error,
      );

      const nested = (depth: number) =>
        Array.from({ length: depth - 1 }).reduce<string>(
          (inner) => `(seq ${inner})`,
          "(project.list)",
        );
      expect(yield* evaluate({ program: nested(8) })).toMatchObject({ status: "ok" });
      expect(yield* evaluate({ program: nested(9) })).toMatchObject({
        status: "error",
        error: { reason: "eval_too_deep" },
      });
      expect((yield* probed).reads).toBe(33);
    }).pipe(Effect.provide(served)),
);
