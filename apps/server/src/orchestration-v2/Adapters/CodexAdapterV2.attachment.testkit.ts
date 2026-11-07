/** The replayed Codex thread the attachment, reload and subagent tests drive. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as M from "@goat/contracts";
import { CodexSettings, ProviderSessionId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexTestTurnInput,
  makeReplayServerConfig,
  withCodexReplayChildMetadata,
  withReplayRequestId,
} from "./CodexAdapterV2.testkit.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
} from "./CodexReplay.testkit.ts";
export const layerAdapterTest = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
// Every memory tool by the name /mcp lists, which is what Codex disables.
export const GOAT_MEMORY_TOOLS = [
  "goat_memory_list",
  "goat_memory_search",
  "goat_memory_recall",
  "goat_memory_read",
  "goat_memory_history",
  "goat_memory_sync_status",
  "goat_memory_source_read",
  "goat_memory_remember",
  "goat_memory_upsert",
  "goat_memory_forget",
  "goat_memory_revert_resolution",
];
export const unusedRegistry = {
  issue: () => Effect.die("unused"),
  resolve: () => Effect.succeed(undefined),
  touch: () => Effect.void,
  revokeProviderSession: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
  subscribeChanges: Effect.die("unused"),
  inspect: () => Effect.undefined,
  currentMemoryPolicy: () => Effect.succeed(undefined),
} satisfies McpSessionRegistry.McpSessionRegistry["Service"];

/** Subagent threads Codex still holds after a restart, by id: their parent and status answers. */
type Survivors = Readonly<
  Record<
    string,
    {
      readonly parent: string;
      readonly statuses: Array<string>;
      readonly updates?: Array<number>;
      /** Codex answers its reads without a status. */
      readonly malformed?: boolean;
    }
  >
>;

/** What Codex holds after a restart: the root's status answers and anything it lists with it. */
export interface HeldReplay {
  readonly statuses: ReadonlyArray<string>;
  readonly survivors?: Survivors;
  /** How Codex refuses thread/loaded/list, if it does. */
  readonly listError?: CodexErrors.CodexAppServerRequestError;
  readonly threadId?: ThreadId;
}

// The next answer of a sequence; the last one repeats.
const nextOf = <A>(answers: Array<A>) => (answers.length > 1 ? answers.shift() : answers[0]);

/**
 * Opens one replayed Codex session and records the thread requests the adapter sends. With
 * `heldAs`, the session resumes the thread instead of starting it, as a restarted server does, and
 * Codex answers each thread/read with the next of those statuses (`notLoaded` when it holds none).
 * Codex also lists `survivors` as loaded and answers their reads.
 */
const openReplay = Effect.fn("CodexComputerUseTest.openReplay")(function* (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  held?: HeldReplay,
) {
  const heldAs = held?.statuses;
  const statuses = [...(heldAs ?? [])];
  const survivors = held?.survivors ?? {};
  const answerHeld = (method: string, params: unknown) => {
    if (method === "thread/loaded/list")
      return held?.listError === undefined
        ? Effect.succeed({
            data: [transcript.scenario, ...Object.keys(survivors)],
            nextCursor: null,
          })
        : Effect.fail(held.listError);
    const threadId = (params as { threadId: string }).threadId;
    const survivor = survivors[threadId];
    if (survivor?.malformed) return Effect.succeed({ thread: { id: threadId } });
    return Effect.succeed({
      thread: {
        id: threadId,
        ...(survivor === undefined ? {} : { parentThreadId: survivor.parent }),
        status: { type: nextOf(survivor?.statuses ?? statuses) },
        updatedAt: nextOf(survivor?.updates ?? [1]),
      },
    });
  };
  const driver = yield* CodexReplay.makeReplayDriver(transcript);
  const threadConfigs: Array<Record<string, unknown>> = [];
  const requests: Array<string> = [];
  // Each turn/interrupt the adapter sends, by turn, for tests that await one sent in the background.
  const interrupts = yield* Queue.unbounded<string>();
  const record = (method: string, params: unknown) =>
    Effect.gen(function* () {
      requests.push(method);
      if (method === "turn/interrupt")
        yield* Queue.offer(interrupts, (params as { turnId: string }).turnId);
      const config = (params as { config?: Record<string, unknown> } | undefined)?.config;
      if ((method === "thread/start" || method === "thread/resume") && config !== undefined)
        threadConfigs.push(config);
    });
  const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
    instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    settings: DEFAULT_CODEX_SETTINGS,
    environment: {},
    clientFactory: {
      open: (openInput) =>
        Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
          ),
          // Answers the adapter's reads of a spawned subagent thread's metadata.
          Effect.map((client) => withCodexReplayChildMetadata(client, transcript)),
          Effect.map(
            (client) =>
              ({
                ...client,
                request: (method, params) =>
                  record(method, params).pipe(Effect.andThen(client.request(method, params))),
                raw: {
                  ...client.raw,
                  request: (method, params) =>
                    record(method, params).pipe(
                      Effect.andThen(
                        heldAs !== undefined &&
                          (method === "thread/read" || method === "thread/loaded/list")
                          ? answerHeld(method, params)
                          : client.raw.request(method, params),
                      ),
                    ),
                },
              }) satisfies CodexClient.CodexAppServerClient["Service"],
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
        ),
    },
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
  });
  const threadId = held?.threadId ?? ThreadId.make(`thread-${transcript.scenario}`);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  });
  const now = yield* DateTime.now;
  const providerThread =
    heldAs === undefined
      ? yield* runtime.ensureThread({
          threadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        })
      : yield* runtime.resumeThread({
          threadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          providerThread: {
            id: M.ProviderThreadId.make(`provider-thread-${transcript.scenario}`),
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            providerSessionId: ProviderSessionId.make("before-restart"),
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeId: transcript.scenario,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
  const terminals = yield* Queue.unbounded<{
    readonly providerTurnId: string;
    readonly status: string;
  }>();
  const goalTokens = yield* Queue.unbounded<number>();
  // Every status a subagent task was given, in order.
  const subagentStatuses: Array<string> = [];
  // Every status each execution node was given, in order.
  const nodeStatuses = new Map<string, Array<string>>();
  // Each provider turn the adapter reported, latest state last.
  type ReportedTurn = {
    readonly id: string;
    readonly runAttemptId: string | null;
    readonly nativeId: string | null;
    readonly status: string;
  };
  const providerTurns: Array<ReportedTurn> = [];
  const turnListeners = new Set<() => void>();
  // Waits until the adapter has reported a provider turn that matches.
  const providerTurn = (matches: (turn: ReportedTurn) => boolean) =>
    Effect.callback<ReportedTurn>((resume) => {
      const check = () => {
        const found = providerTurns.findLast(matches);
        if (found === undefined) return;
        turnListeners.delete(check);
        resume(Effect.succeed(found));
      };
      turnListeners.add(check);
      check();
      return Effect.sync(() => void turnListeners.delete(check));
    });
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      event.type === "turn.terminal"
        ? Queue.offer(terminals, { providerTurnId: event.providerTurnId, status: event.status })
        : event.type === "provider_turn.updated"
          ? Effect.sync(() => {
              providerTurns.push({
                id: event.providerTurn.id,
                runAttemptId: event.providerTurn.runAttemptId,
                nativeId: event.providerTurn.nativeTurnRef?.nativeId ?? null,
                status: event.providerTurn.status,
              });
              for (const listener of turnListeners) listener();
            })
          : event.type === "subagent.updated"
            ? Effect.sync(() => void subagentStatuses.push(event.subagent.status))
            : event.type === "node.updated"
              ? Effect.sync(
                  () =>
                    void nodeStatuses.set(event.node.id, [
                      ...(nodeStatuses.get(event.node.id) ?? []),
                      event.node.status,
                    ]),
                )
              : event.type === "provider_thread.updated" && event.providerThread.goal
                ? Queue.offer(goalTokens, event.providerThread.goal.tokensUsed ?? 0)
                : Effect.void,
    ),
    Effect.forkScoped,
  );
  const startTurn = (
    ordinal: number,
    text = `turn-${ordinal}`,
    target: { readonly threadId: ThreadId; readonly providerThread: typeof providerThread } = {
      threadId,
      providerThread,
    },
  ) =>
    Effect.gen(function* () {
      yield* runtime.startTurn(
        makeCodexTestTurnInput({
          ...target,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`${transcript.scenario}-${ordinal}`),
          text,
        }),
      );
    });
  return {
    threadConfigs,
    requests,
    interrupted: Queue.take(interrupts),
    startTurn,
    terminal: Queue.take(terminals),
    goalTokens: Queue.take(goalTokens),
    goalUpdates: Stream.fromQueue(goalTokens),
    subagentStatuses,
    nodeStatuses,
    providerTurns,
    providerTurn,
    threadId,
    runtime,
    providerThread,
  };
});

/** The replayed Codex thread every test drives, with the frames it expects in order. */
export const fixture = (scenario: string) => {
  const nativeThreadId = scenario;
  const threadId = ThreadId.make(`thread-${scenario}`);
  const config: McpProviderSession.McpProviderSessionConfig = {
    environmentId: M.EnvironmentId.make("fixture"),
    threadId,
    providerSessionId: "credential-cua",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader: "Bearer fixture-cua",
    browserToolsAvailable: false,
    grantedScopes: [],
  };
  // Synthetic native driver generations exercise reloads; Stop keeps the real proxy's identity.
  const driver = (generation: string): M.CuaDriverMcpConfiguration => ({
    command: "/resources/cua-driver",
    args: ["mcp", "--socket", "/tmp/cua.sock", "--generation", generation],
    environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
    socketPath: "/tmp/cua.sock",
  });
  // The wire shape Codex receives: each server under its own dotted path.
  const managed = (generation: string) => ({
    command: "/resources/cua-driver",
    args: ["mcp", "--socket", "/tmp/cua.sock", "--generation", generation],
    env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
  });
  // The thread params Codex receives: which credential and memory tools GOAT's server carries,
  // the computer use server, and any further config such as subagent limits.
  const threadParams = (
    cua?: Record<string, unknown>,
    attachment: Pick<McpProviderSession.McpProviderSessionConfig, "authorizationHeader"> = config,
    disabledTools: ReadonlyArray<string> = GOAT_MEMORY_TOOLS,
    extra: Record<string, unknown> = {},
  ) => ({
    cwd: "/workspace",
    model: CODEX_TEST_MODEL_SELECTION.model,
    config: {
      "tools.update_plan.enabled": true,
      mcp_optional_startup_grace_ms: 10_000,
      ...extra,
      "mcp_servers.goat": {
        url: config.endpoint,
        disabled_tools: disabledTools,
        tool_timeout_sec: 3900,
        http_headers: { Authorization: attachment.authorizationHeader },
      },
      ...(cua === undefined ? {} : { "mcp_servers.cua-driver": cua }),
    },
  });
  const preamble = codexReplayPreamble({
    nativeThreadId,
    nativeTurnId: "unused",
    prompt: "unused",
  });
  const threadResult = preamble[4];
  if (threadResult === undefined) throw new Error("The replay preamble answers thread/start.");
  const entries: CodexReplay.CodexAppServerReplayEntry[] = preamble.slice(0, 3);
  const start = (cua?: Record<string, unknown>, params = threadParams(cua)) =>
    entries.push(
      {
        type: "expect_outbound",
        frame: { id: 2, method: "thread/start", params },
      },
      threadResult,
    );
  // Before reloading a quiet conversation the adapter asks Codex for each thread's goal.
  const goalGet = (id: number, threadId: string, response: Record<string, unknown>) =>
    entries.push(
      { type: "expect_outbound", frame: { id, method: "thread/goal/get", params: { threadId } } },
      { type: "emit_inbound", frame: { id, ...response } },
    );
  // Codex ignores resume overrides on a thread a client holds: a reload unsubscribes first.
  // Returns the next request id.
  // A thread/resume Codex answers with the idle thread; `error` answers it with that failure.
  // Codex's answer to a request that loads a thread: the idle thread it names.
  const answer = (id: number, thread = nativeThreadId): CodexReplay.CodexAppServerReplayEntry => {
    const entry = withReplayRequestId(threadResult, id);
    if (entry.type !== "emit_inbound" || thread === nativeThreadId) return entry;
    const frame = entry.frame as { result: { thread: Record<string, unknown> } };
    const named = { ...frame.result.thread, id: thread, sessionId: thread };
    return { ...entry, frame: { ...frame, result: { ...frame.result, thread: named } } };
  };
  const resume = (
    id: number,
    params: Record<string, unknown>,
    error?: Record<string, unknown>,
    thread = nativeThreadId,
  ) =>
    entries.push(
      {
        type: "expect_outbound",
        frame: {
          id,
          method: "thread/resume",
          params: { threadId: thread, excludeTurns: true, ...params },
        },
      },
      error === undefined ? answer(id, thread) : { type: "emit_inbound", frame: { id, error } },
    );
  // Before resuming a thread it has no record of, the adapter asks whether Codex holds it already.
  const read = (id: number, status: string, thread = nativeThreadId) =>
    entries.push(
      {
        type: "expect_outbound",
        frame: { id, method: "thread/read", params: { threadId: thread, includeTurns: false } },
      },
      {
        type: "emit_inbound",
        frame: { id, result: { thread: { id: thread, status: { type: status } } } },
      },
    );
  const reload = (
    first: number,
    cua?: Record<string, unknown>,
    options: {
      /** The conversation Codex is asked about; the reload unsubscribes and resumes the first. */
      readonly threads?: ReadonlyArray<string>;
      readonly goal?: Record<string, unknown>;
      readonly params?: Record<string, unknown>;
      /** Answers the resume with this error instead of the thread. */
      readonly error?: Record<string, unknown>;
      /** Any change but a new driver also waits for background terminals (#1569). */
      readonly terminals?: boolean;
    } = {},
  ) => {
    const threads = options.threads ?? [nativeThreadId];
    const thread = threads[0] ?? nativeThreadId;
    threads.forEach((threadId, index) =>
      goalGet(first + index, threadId, options.goal ?? { result: { goal: null } }),
    );
    let id = first + threads.length;
    if (options.terminals)
      for (const threadId of threads) {
        entries.push(
          {
            type: "expect_outbound",
            frame: { id, method: "thread/backgroundTerminals/list", params: { threadId } },
          },
          { type: "emit_inbound", frame: { id, result: { data: [], nextCursor: null } } },
        );
        id++;
      }
    entries.push(
      {
        type: "expect_outbound",
        frame: { id, method: "thread/unsubscribe", params: { threadId: thread } },
      },
      { type: "emit_inbound", frame: { id, result: { status: "unsubscribed" } } },
    );
    resume(id + 1, options.params ?? threadParams(cua), options.error, thread);
    return id + 2;
  };
  // Each helper below drives the fixture's thread unless given another native thread. A turn on a
  // prepared attachment session also carries the screen-code guide that session lists.
  // A run's message steered into a turn it adopts carries the context its turn/start would.
  const turnSteer = (id: number, expectedTurnId: string, text: string, thread = nativeThreadId) =>
    Effect.gen(function* () {
      const { additionalContext } = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: thread,
        codexInput: [{ type: "text", text }],
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        hasGoatMcp: true,
        browserToolsAvailable: false,
        computerUse: false,
        computerUseDeferred: false,
        screenCode: false,
      });
      entries.push({
        type: "expect_outbound",
        frame: {
          id,
          method: "turn/steer",
          params: {
            threadId: thread,
            expectedTurnId,
            input: [{ type: "text", text }],
            ...(additionalContext === undefined ? {} : { additionalContext }),
          },
        },
      });
    });
  const turnStart = (
    id: number,
    ordinal: number,
    skills:
      | boolean
      | {
          readonly computerUse: boolean;
          readonly screenCode: boolean;
          readonly reloadedAfterRestart?: boolean;
          /** The turn runs without GOAT's MCP server. */
          readonly detached?: boolean;
        },
    deferred = false,
    thread = nativeThreadId,
    text = `turn-${ordinal}`,
  ) =>
    Effect.gen(function* () {
      const { computerUse, screenCode, reloadedAfterRestart, detached } =
        typeof skills === "boolean" ? { computerUse: skills, screenCode: false } : skills;
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: thread,
        codexInput: [{ type: "text", text }],
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        hasGoatMcp: detached !== true,
        browserToolsAvailable: detached === true,
        computerUse,
        computerUseDeferred: deferred,
        reloadedAfterRestart: reloadedAfterRestart === true,
        screenCode,
      });
      entries.push({ type: "expect_outbound", frame: { id, method: "turn/start", params } });
      entries.push({
        type: "emit_inbound",
        frame: {
          id,
          result: { turn: makeCodexReplayTurn({ id: `turn-${ordinal}`, status: "inProgress" }) },
        },
      });
      // Codex answers turn/start before its task reports the thread active and the turn started.
      status(thread, "active");
      entries.push({
        type: "emit_inbound",
        frame: {
          method: "turn/started",
          params: {
            threadId: thread,
            turn: makeCodexReplayTurn({ id: `turn-${ordinal}`, status: "inProgress" }),
          },
        },
      });
    });
  // Codex reports a thread's status as it changes: active for a turn, idle once it ends.
  const status = (
    threadId: string,
    type: "active" | "idle" | "systemError",
    flags: ReadonlyArray<string> = [],
  ) =>
    entries.push({
      type: "emit_inbound",
      frame: {
        method: "thread/status/changed",
        params: {
          threadId,
          status: type === "active" ? { type, activeFlags: [...flags] } : { type },
        },
      },
    });
  const turnCompleted = (ordinal: number, thread = nativeThreadId) => {
    status(thread, "idle");
    entries.push({
      type: "emit_inbound",
      frame: {
        method: "turn/completed",
        params: {
          threadId: thread,
          turn: makeCodexReplayTurn({ id: `turn-${ordinal}`, status: "completed" }),
        },
      },
    });
  };
  const openWith = (registry: McpSessionRegistry.McpSessionRegistry["Service"]) =>
    openReplay(makeCodexReplayTranscript({ scenario, entries })).pipe(
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
    );
  const open = openWith(unusedRegistry);
  const openResumed = (...heldAs: ReadonlyArray<string>) => openHeld({ statuses: heldAs });
  const openHeld = (held: HeldReplay) =>
    openReplay(makeCodexReplayTranscript({ scenario, entries }), held).pipe(
      Effect.provideService(McpSessionRegistry.McpSessionRegistry, unusedRegistry),
    );
  return {
    config,
    nativeThreadId,
    threadParams,
    driver,
    managed,
    entries,
    start,
    goalGet,
    answer,
    resume,
    read,
    reload,
    turnStart,
    turnSteer,
    turnCompleted,
    status,
    open,
    openWith,
    openResumed,
    openHeld,
  };
};

// A spawned subagent is its own native thread; Codex reports each thread's status separately.
export const spawnChild = (f: ReturnType<typeof fixture>, root: string, child: string) =>
  f.entries.push({
    type: "emit_inbound",
    frame: {
      method: "item/completed",
      params: {
        item: {
          type: "subAgentActivity",
          id: `spawn-${child}`,
          kind: "started",
          agentThreadId: child,
          agentPath: "/root/child",
        },
        threadId: root,
        turnId: "turn-1",
        completedAtMs: 1782622441000,
      },
    },
  });

// What a child spawnChild started shows: its subagent node in the parent and its thread's root node.
export const childNodes = (allocator: IdAllocator.IdAllocatorV2["Service"], child: string) =>
  ["", ":thread-root"].map((suffix) =>
    allocator.derive.nodeFromProviderItem({
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      nativeItemId: `spawn-${child}:${child}${suffix}`,
    }),
  );
