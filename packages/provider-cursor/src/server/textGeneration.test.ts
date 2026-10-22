import { type RunResult, type SDKMessage } from "@cursor/sdk";
import * as M from "@goat/contracts";
import { ProviderInstanceId, TextGenerationError } from "@goat/contracts";
import { CursorSettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@goat/shared/model";
import { beforeEach, vi } from "vite-plus/test";
import { makeCursorTextGeneration } from "./textGeneration.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";

let memoryEvents: Array<SDKMessage> = [];

const memorySelection = M.MemoryModelSelection.make({
  instanceId: M.ProviderInstanceId.make("cursor"),
  model: "auto",
  options: [],
});

const memoryContext = {
  providerInstanceId: memorySelection.instanceId,
  environmentId: M.EnvironmentId.make("memory-owner"),
};

const memoryId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const memoryRevision = M.MemoryRevision.make({
  memorySpaceId: M.MemorySpaceId.make(memoryId(1)),
  memoryId: M.MemoryId.make(memoryId(2)),
  revisionId: M.MemoryRevisionId.make(memoryId(3)),
  payloadRef: M.MemoryRevisionId.make(memoryId(3)),
  operationId: M.MemoryOperationId.make(memoryId(4)),
  parents: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  provenance: { environmentId: memoryContext.environmentId },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
});

const memoryPayload = M.MemoryPayload.make({
  text: "Synthetic input",
  evidence: [],
  derivedFromMemoryRevisions: [],
});

const memorySummary = M.GenerateMemorySummaryInput.make({
  cwd: "/synthetic-checkout",
  sourceThread: {
    environmentId: memoryContext.environmentId,
    threadId: M.ThreadId.make("synthetic-thread"),
  },
  sourceWatermark: {
    fromEventId: M.EventId.make("e1"),
    toEventId: M.EventId.make("e2"),
    throughSequence: 2,
  },
  messages: [{ messageId: M.MessageId.make("m1"), text: "Synthetic input", completed: true }],
  modelSelection: memorySelection,
});

const memoryConflict = M.ResolveMemoryConflictInput.make({
  cwd: memorySummary.cwd,
  memorySpaceId: memoryRevision.memorySpaceId,
  memoryId: memoryRevision.memoryId,
  conflictId: M.MemoryConflictId.make(memoryId(8)),
  heads: [
    { revision: memoryRevision, payload: memoryPayload },
    {
      revision: {
        ...memoryRevision,
        revisionId: M.MemoryRevisionId.make(memoryId(5)),
        payloadRef: M.MemoryRevisionId.make(memoryId(5)),
      },
      payload: memoryPayload,
    },
  ],
  modelSelection: memorySelection,
});

const memoryOutput = { text: "Synthetic result", assertionKind: "inference", evidence: [] };

const memoryOperations = ["resolveMemoryConflict", "generateMemorySummary"] as const;

const runMemory = (
  generation: Effect.Success<ReturnType<typeof makeCursorTextGeneration>>,
  operation: (typeof memoryOperations)[number],
  selection = memorySelection,
) =>
  operation === "resolveMemoryConflict"
    ? generation.resolveMemoryConflict!({ ...memoryConflict, modelSelection: selection })
    : generation.generateMemorySummary!({ ...memorySummary, modelSelection: selection });

const mockMemoryOutput = (operation: (typeof memoryOperations)[number], extra = {}) =>
  cursorSdkMock.prompt.mockResolvedValue({
    id: "synthetic-memory-run",
    status: "finished",
    result: JSON.stringify({
      ...memoryOutput,
      ...(operation === "resolveMemoryConflict" ? { judgment: "Synthetic judgment" } : {}),
      ...extra,
    }),
  });

const decodeToolPolicy = Schema.decodeUnknownSync(
  Schema.Struct({ tools: Schema.Array(Schema.String) }),
);

const provideMemoryTest = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(layerTest),
    Effect.provideService(HostProcess.HomeDirectory, "/synthetic-cursor-home"),
  );

const cursorSdkMock = vi.hoisted(() => ({
  resume: vi.fn(),
  create: vi.fn<(options: unknown) => Promise<unknown>>(),
  send: vi.fn<(prompt: string) => Promise<unknown>>(),
  close: vi.fn(),
  cancel: vi.fn(async () => {}),
  storeOpen: vi.fn<(options: unknown) => Promise<unknown>>(),
  storeDispose: vi.fn(async () => {}),
  prompt: vi.fn<(prompt: string, options: unknown) => Promise<RunResult>>(async () => ({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  })),
}));

vi.mock("./sdk.ts", () => ({
  Agent: { create: cursorSdkMock.create, resume: cursorSdkMock.resume },
  createAgentPlatform: vi.fn(),
  SqliteLocalAgentStore: { open: cursorSdkMock.storeOpen },
}));

let hasCustomPolicy = false;

const layerFs = FileSystem.layerNoop({
  exists: () => Effect.succeed(hasCustomPolicy),
  makeTempDirectoryScoped: () => Effect.succeed("/isolated-text-generation"),
});

const layerTest = Layer.merge(layerFs, CursorSdk.layer);

const decodeCursorSettings = Schema.decodeSync(CursorSettings);

const cursorSettings = decodeCursorSettings({ enabled: true });

beforeEach(() => {
  hasCustomPolicy = false;
  memoryEvents = [];
  cursorSdkMock.resume.mockReset();
  cursorSdkMock.create.mockReset();
  cursorSdkMock.send.mockReset();
  cursorSdkMock.create.mockImplementation(async (options) => {
    cursorSdkMock.send.mockImplementation(async (prompt) => ({
      status: "running",
      cancel: cursorSdkMock.cancel,
      wait: () => cursorSdkMock.prompt(prompt, options),
      stream: async function* () {
        yield* memoryEvents;
      },
    }));
    return {
      close: cursorSdkMock.close,
      [Symbol.asyncDispose]: async () => {
        cursorSdkMock.close();
      },
      send: cursorSdkMock.send,
    };
  });
  cursorSdkMock.close.mockClear();
  cursorSdkMock.cancel.mockClear();
  cursorSdkMock.storeDispose.mockClear();
  cursorSdkMock.storeOpen.mockReset();
  cursorSdkMock.storeOpen.mockResolvedValue({ dispose: cursorSdkMock.storeDispose });
  cursorSdkMock.prompt.mockReset();
  cursorSdkMock.prompt.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  });
});

describe("CursorTextGeneration", () => {
  it.effect("resolves the browser credential for every request after an account change", () =>
    Effect.gen(function* () {
      let apiKey = "first-browser-key";
      const generation = yield* makeCursorTextGeneration(
        cursorSettings,
        {},
        Effect.sync(() => apiKey),
      );
      const input = {
        cwd: process.cwd(),
        branch: "feature/cursor",
        stagedSummary: "M file.ts",
        stagedPatch: "diff",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "auto"),
      };
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "first-browser-key" }),
      );
      apiKey = "second-browser-key";
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "second-browser-key" }),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("continues in the temp directory when the SDK cannot sandbox", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockImplementationOnce(async () => {
        throw new Error(
          "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.",
        );
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch: "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2"),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(cursorSdkMock.create).toHaveBeenCalledTimes(2);
      expect(cursorSdkMock.create.mock.calls[0]?.[0]).toMatchObject({
        local: { sandboxOptions: { enabled: true } },
      });
      expect(cursorSdkMock.create.mock.calls[1]?.[0]).toMatchObject({
        local: {
          cwd: "/isolated-text-generation",
          store: { dispose: cursorSdkMock.storeDispose },
          autoReview: false,
          sandboxOptions: { enabled: false },
          settingSources: [],
          enableAgentRetries: true,
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("accepts json objects with extra assistant text around them", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-text-generation-test",
        status: "finished",
        result:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-noisy-json",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.subject).toBe("Update README dummy comment with attribution and date");
      expect(generated.body).toBe("");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("generates thread titles through Cursor SDK text generation", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-title-generation-test",
        status: "finished",
        result: '{"title":"\\"Trim reconnect spinner status after resume.\\""}',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner after a resumed session.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.title).toBe("Trim reconnect spinner status after resume.");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["error", "cancelled"] as const)(
    "rejects a %s Cursor SDK run that includes valid title JSON",
    (status) =>
      Effect.gen(function* () {
        const promptResult = {
          id: "run-cursor-partial-title-test",
          status,
          result: '{"title":"Partial title from a failed run."}',
        } satisfies RunResult;
        cursorSdkMock.prompt.mockResolvedValueOnce(promptResult);
        const generation = yield* makeCursorTextGeneration(cursorSettings, {
          CURSOR_API_KEY: "test-cursor-key",
        });
        const failure = yield* Effect.flip(
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the reconnect spinner after a resumed session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          }),
        );
        expect(failure).toBeInstanceOf(TextGenerationError);
        expect(failure.operation).toBe("generateThreadTitle");
        expect(failure.detail).toBe(
          status === "cancelled"
            ? "Cursor SDK request was cancelled."
            : "Cursor SDK request finished with an error.",
        );
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails closed when ambient sandbox policy can expand write access", () =>
    Effect.gen(function* () {
      hasCustomPolicy = true;
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const failure = yield* Effect.flip(
        generation.generateThreadTitle({
          cwd: "/real-workspace",
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        }),
      );
      expect(failure.detail).toContain("custom ~/.cursor/sandbox.json");
      // Typed so memory pauses the model instead of retrying a policy that refuses every time.
      expect(failure.cause).toEqual(new MemoryGenerationRunnerError({ code: "unavailable" }));
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("requires CURSOR_API_KEY before calling the SDK", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {});

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-api-key",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe("Sign in with Cursor or add CURSOR_API_KEY in provider settings.");
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(memoryOperations)(
    "rejects assistant tool-use blocks and user input for %s",
    (operation) =>
      Effect.gen(function* () {
        mockMemoryOutput(operation);
        const generation = yield* makeCursorTextGeneration(
          cursorSettings,
          { CURSOR_API_KEY: "synthetic-key" },
          undefined,
          undefined,
          memoryContext,
        );
        for (const event of [
          {
            type: "assistant" as const,
            agent_id: "synthetic-agent",
            run_id: "synthetic-run",
            message: {
              role: "assistant" as const,
              content: [{ type: "tool_use" as const, id: "tool", name: "mcp", input: {} }],
            },
          },
          {
            type: "request" as const,
            agent_id: "synthetic-agent",
            run_id: "synthetic-run",
            request_id: "request",
          },
          { type: "task" as const, agent_id: "synthetic-agent", run_id: "synthetic-run" },
        ]) {
          memoryEvents = [event];
          const error = yield* runMemory(generation, operation).pipe(Effect.flip);
          expect(error.detail).toContain("attempted tools");
        }
        expect(cursorSdkMock.close).toHaveBeenCalledTimes(3);
      }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)(
    "cancels a stalled memory run on its deadline for %s",
    (operation) =>
      Effect.gen(function* () {
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        cursorSdkMock.prompt.mockImplementationOnce(() => {
          started();
          return new Promise(() => {});
        });
        const generation = yield* makeCursorTextGeneration(
          cursorSettings,
          { CURSOR_API_KEY: "synthetic-key" },
          undefined,
          undefined,
          memoryContext,
        );
        const child = yield* runMemory(generation, operation).pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => entered);
        yield* TestClock.adjust("180 seconds");
        expect((yield* Fiber.join(child)).detail).toContain("timed out");
        expect(cursorSdkMock.cancel).toHaveBeenCalledOnce();
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      }).pipe(provideMemoryTest, Effect.scoped),
  );

  it.effect.each(memoryOperations)("runs %s without built-in MCP or subagent tools", (operation) =>
    Effect.gen(function* () {
      mockMemoryOutput(operation);
      let accessCalls = 0;
      const generation = yield* makeCursorTextGeneration(
        cursorSettings,
        { CURSOR_API_KEY: "synthetic-key" },
        undefined,
        (effect) =>
          Effect.sync(() => {
            accessCalls++;
          }).pipe(Effect.andThen(effect)),
        memoryContext,
      );
      const selection = M.MemoryModelSelection.make({
        ...memorySelection,
        options: [
          { id: "thinking", value: "high" },
          { id: "fastMode", value: true },
        ],
      });
      const generated = yield* runMemory(generation, operation, selection);
      expect(generated.result.text).toBe(memoryOutput.text);
      expect(generated.execution).toEqual({
        requestedModelSelection: selection,
        effectiveProvider: "cursor",
        effectiveModel: "default",
        providerInstanceId: memoryContext.providerInstanceId,
        environmentId: memoryContext.environmentId,
      });
      expect(cursorSdkMock.create).toHaveBeenCalledOnce();
      expect(cursorSdkMock.create).toHaveBeenCalledWith({
        apiKey: "synthetic-key",
        mode: "plan",
        model: {
          id: "default",
          params: [
            { id: "thinking", value: "high" },
            { id: "fast", value: "true" },
          ],
        },
        tools: [],
        disallowedTools: ["mcp", "task"],
        mcpServers: {},
        local: {
          cwd: "/isolated-text-generation",
          store: { dispose: cursorSdkMock.storeDispose },
          autoReview: false,
          sandboxOptions: { enabled: true },
          settingSources: [],
          enableAgentRetries: false,
        },
      });
      expect(cursorSdkMock.resume).not.toHaveBeenCalled();
      expect(accessCalls).toBe(1);
      expect(cursorSdkMock.close).toHaveBeenCalledOnce();
    }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)(
    "rejects tool events followed by apparent success for %s",
    (operation) =>
      Effect.gen(function* () {
        mockMemoryOutput(operation);
        memoryEvents = [
          {
            type: "tool_call",
            agent_id: "synthetic-agent",
            run_id: "synthetic-run",
            call_id: "synthetic-call",
            name: "shell",
            status: "running",
          },
        ];
        const generation = yield* makeCursorTextGeneration(
          cursorSettings,
          { CURSOR_API_KEY: "synthetic-key" },
          undefined,
          undefined,
          memoryContext,
        );
        const error = yield* runMemory(generation, operation).pipe(Effect.flip);
        expect(error.operation).toBe(operation);
        expect(error.detail).toContain("attempted tools");
        expect(cursorSdkMock.cancel).toHaveBeenCalledOnce();
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)(
    "both memory operations reject SDK tool execution: %s",
    (operation) =>
      Effect.gen(function* () {
        let sideEffects = 0;
        // The fake SDK enforces its public allowlist before invoking the requested tool.
        cursorSdkMock.prompt.mockImplementation(async (_prompt, options) => {
          const policy = decodeToolPolicy(options);
          if (policy.tools.includes("shell")) sideEffects++;
          return { id: "synthetic-run", status: "error", error: { message: "Tool unavailable" } };
        });
        const generation = yield* makeCursorTextGeneration(
          cursorSettings,
          { CURSOR_API_KEY: "synthetic-key" },
          undefined,
          undefined,
          memoryContext,
        );
        const error = yield* runMemory(generation, operation).pipe(Effect.flip);
        expect(error.operation).toBe(operation);
        expect(sideEffects).toBe(0);
        expect(cursorSdkMock.resume).not.toHaveBeenCalled();
      }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)(
    "memory requests refuse unsafe sandbox fallback: %s",
    (operation) =>
      Effect.gen(function* () {
        cursorSdkMock.create.mockRejectedValue(new Error("sandboxing is not supported"));
        const generation = yield* makeCursorTextGeneration(
          cursorSettings,
          { CURSOR_API_KEY: "synthetic-key" },
          undefined,
          undefined,
          memoryContext,
        );
        const error = yield* runMemory(generation, operation).pipe(Effect.flip);
        expect(error.operation).toBe(operation);
        expect(error.detail).toContain("requires its isolated sandbox");
        expect(error.cause).toEqual(new MemoryGenerationRunnerError({ code: "unavailable" }));
        expect(cursorSdkMock.create).toHaveBeenCalledOnce();
        expect(cursorSdkMock.create).toHaveBeenCalledWith(
          expect.objectContaining({
            tools: [],
            local: expect.objectContaining({ sandboxOptions: { enabled: true } }),
          }),
        );
        expect(cursorSdkMock.send).not.toHaveBeenCalled();
        expect(cursorSdkMock.resume).not.toHaveBeenCalled();
      }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)("fails an unavailable SDK no-tool policy for %s", (operation) =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockRejectedValue(
        new Error("ConfigurationError: tools policy unavailable"),
      );
      const generation = yield* makeCursorTextGeneration(
        cursorSettings,
        { CURSOR_API_KEY: "synthetic-key" },
        undefined,
        undefined,
        memoryContext,
      );
      const error = yield* runMemory(generation, operation).pipe(Effect.flip);
      expect(error.operation).toBe(operation);
      expect(cursorSdkMock.create).toHaveBeenCalledOnce();
      expect(cursorSdkMock.send).not.toHaveBeenCalled();
    }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)("rejects forged execution JSON for %s", (operation) =>
    Effect.gen(function* () {
      mockMemoryOutput(operation, {
        execution: { effectiveModel: "forged", environmentId: "forged" },
      });
      const generation = yield* makeCursorTextGeneration(
        cursorSettings,
        { CURSOR_API_KEY: "synthetic-key" },
        undefined,
        undefined,
        memoryContext,
      );
      const error = yield* runMemory(generation, operation).pipe(Effect.flip);
      expect(error.operation).toBe(operation);
      expect(cursorSdkMock.close).toHaveBeenCalledOnce();
    }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)(
    "rejects missing and mismatched owner identity before SDK invocation for %s",
    (operation) =>
      Effect.gen(function* () {
        for (const context of [
          undefined,
          { providerInstanceId: memorySelection.instanceId },
          { ...memoryContext, providerInstanceId: M.ProviderInstanceId.make("other-instance") },
        ]) {
          const generation = yield* makeCursorTextGeneration(
            cursorSettings,
            { CURSOR_API_KEY: "synthetic-key" },
            undefined,
            undefined,
            context,
          );
          const error = yield* runMemory(generation, operation).pipe(Effect.flip);
          expect(error.operation).toBe(operation);
        }
        expect(cursorSdkMock.create).not.toHaveBeenCalled();
        expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
      }).pipe(provideMemoryTest),
  );

  it.effect.each(memoryOperations)(
    "disabled credential and custom sandbox guards are reported safely: %s",
    (operation) =>
      Effect.gen(function* () {
        const disabled = yield* makeCursorTextGeneration(
          { ...cursorSettings, enabled: false },
          { CURSOR_API_KEY: "synthetic-key" },
          undefined,
          undefined,
          memoryContext,
        );
        expect((yield* runMemory(disabled, operation).pipe(Effect.flip)).detail).toContain(
          "disabled",
        );
        const missing = yield* makeCursorTextGeneration(
          cursorSettings,
          {},
          undefined,
          undefined,
          memoryContext,
        );
        expect((yield* runMemory(missing, operation).pipe(Effect.flip)).detail).toContain(
          "Sign in",
        );
        hasCustomPolicy = true;
        const custom = yield* makeCursorTextGeneration(
          cursorSettings,
          { CURSOR_API_KEY: "synthetic-key" },
          undefined,
          undefined,
          memoryContext,
        );
        expect((yield* runMemory(custom, operation).pipe(Effect.flip)).detail).toContain(
          "custom ~/.cursor/sandbox.json",
        );
        expect(cursorSdkMock.create).not.toHaveBeenCalled();
      }).pipe(provideMemoryTest),
  );
});
