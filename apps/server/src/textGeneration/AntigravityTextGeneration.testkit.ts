import { ProviderInstanceId, ProviderSetupError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type AcpError, AcpRequestError } from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";
import { expect } from "vite-plus/test";
import type * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import {
  type AntigravityTextGenerationOptions,
  makeAntigravityTextGeneration,
} from "./AntigravityTextGeneration.ts";

type TextRuntime = Effect.Success<ReturnType<AntigravityTextGenerationOptions["makeRuntime"]>>;

export const requestContext = { requestId: "test-request", method: "test" };
export const SESSION_ID = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";
export const modelSelection = {
  instanceId: ProviderInstanceId.make("antigravity-test"),
  model: "gemini-test",
};
export const encodeMetadata = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

interface PromptContext {
  readonly emit: (
    update: AcpSchema.SessionNotification["update"],
    sessionId?: string,
  ) => Effect.Effect<void, AcpError>;
  permission: Parameters<TextRuntime["handleRequestPermission"]>[0];
  question: Parameters<TextRuntime["handleElicitation"]>[0];
  readFile: Parameters<TextRuntime["handleReadTextFile"]>[0];
  createTerminal: Parameters<TextRuntime["handleCreateTerminal"]>[0];
  extension: Parameters<TextRuntime["handleUnknownExtRequest"]>[0];
  readonly cwd: string;
}

export const makeFixture = Effect.fn("makeAntigravityTextGenerationFixture")(function* (
  options: {
    readonly currentModel?: string;
    readonly modelOptions?: ReadonlyArray<string>;
    readonly memoryRunnerContext?: import("@goat/provider-core/server/memoryGenerationRunner").MemoryGenerationRunnerContext;
    readonly outputs?: ReadonlyArray<string>;
    readonly prompt?: (context: PromptContext) => Effect.Effect<AcpSchema.PromptResponse, AcpError>;
    readonly startError?: AcpError;
    readonly rejectAdmission?: boolean;
    readonly sessionId?: string;
    readonly startupSkills?: boolean;
    readonly rejectThinkingUpdate?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-antigravity-text-test-" });
  const profileDirectory = path.join(root, "profile");
  const projectDirectory = path.join(root, "project");
  const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
  const nativeSessionId = options.sessionId ?? SESSION_ID;
  const sessionBase = path.join(conversations, SESSION_ID);
  const brainDirectory = path.join(profileDirectory, "antigravity-acp", "brain", SESSION_ID);
  yield* fs.makeDirectory(projectDirectory, { recursive: true });
  yield* fs.makeDirectory(conversations, { recursive: true });
  yield* fs.writeFileString(path.join(projectDirectory, "keep.txt"), "untouched");
  yield* fs.writeFileString(path.join(conversations, "user-session.db"), "keep native history");
  const enteredPrompt = yield* Deferred.make<void>();
  const state = {
    workspaces: [] as Array<string>,
    closed: [] as Array<string>,
    prompts: [] as Array<Parameters<TextRuntime["prompt"]>[0]>,
    selectedModels: [] as Array<string>,
    selectedModes: [] as Array<string>,
    thinkingUpdates: [] as Array<string>,
    promptThinkingLevels: [] as Array<string>,
    nativeFilesAtClose: [] as Array<boolean>,
    cancellations: 0,
    stop: undefined as Effect.Effect<void> | undefined,
  };
  const outputs = [...(options.outputs ?? ['{"title":"Repair login"}'])];
  const incoming: Omit<PromptContext, "cwd" | "emit"> = {
    permission: () => Effect.die("No permission handler."),
    question: () => Effect.die("No question handler."),
    readFile: () => Effect.die("No file handler."),
    createTerminal: () => Effect.die("No terminal handler."),
    extension: () => Effect.die("No extension handler."),
  };

  const withProcess: AntigravityTextGenerationOptions["withProcess"] = (stop, task) =>
    Effect.gen(function* () {
      if (options.rejectAdmission) {
        return yield* new ProviderSetupError({
          instanceId: modelSelection.instanceId,
          operation: "launch",
          detail: "Sign in before starting Antigravity.",
        });
      }
      const scope = yield* Scope.Scope;
      const child = yield* Effect.forkIn(task, scope);
      state.stop = Fiber.interrupt(child).pipe(Effect.andThen(stop));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.stop = undefined;
        }),
      );
      return yield* Fiber.await(child).pipe(
        Effect.flatMap((exit) => exit),
        Effect.ensuring(Fiber.interrupt(child)),
      );
    });

  const makeRuntime: AntigravityTextGenerationOptions["makeRuntime"] = (cwd) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<AcpSessionRuntime.AcpSessionRuntimeEvent>();
      state.workspaces.push(cwd);
      expect(yield* fs.readDirectory(cwd).pipe(Effect.orDie)).toEqual([]);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          state.nativeFilesAtClose.push(yield* fs.exists(`${sessionBase}.db`).pipe(Effect.orDie));
          state.closed.push(cwd);
        }),
      );
      let thinkingLevel = "high";
      let currentModel = options.currentModel ?? modelSelection.model;
      let sessionUpdate: Parameters<TextRuntime["handleSessionUpdate"]>[0] = () => Effect.void;

      return {
        start: () =>
          Effect.gen(function* () {
            if (options.startError) return yield* options.startError;
            if (options.startupSkills) {
              for (const directory of [".agents", ".gemini"]) {
                yield* fs
                  .makeDirectory(path.join(cwd, directory, "skills"), { recursive: true })
                  .pipe(Effect.orDie);
              }
            }
            yield* fs.makeDirectory(brainDirectory, { recursive: true }).pipe(Effect.orDie);
            yield* fs.writeFileString(`${sessionBase}.db`, "helper session").pipe(Effect.orDie);
            yield* fs.writeFileString(`${sessionBase}.db-wal`, "helper journal").pipe(Effect.orDie);
            const metadata = yield* encodeMetadata({ cwd }).pipe(Effect.orDie);
            yield* fs.writeFileString(`${sessionBase}.meta`, metadata).pipe(Effect.orDie);
            yield* fs
              .writeFileString(path.join(brainDirectory, "output.txt"), "helper artifact")
              .pipe(Effect.orDie);
            return {
              sessionId: nativeSessionId,
              initializeResult: { protocolVersion: 1 },
              sessionSetupResult: { sessionId: nativeSessionId },
              modelConfigId: "model",
            };
          }),
        setMode: (mode) =>
          Effect.sync(() => {
            state.selectedModes.push(mode);
            return {};
          }),
        getConfigOptions: Effect.sync(
          () =>
            [
              {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: currentModel,
                options: (options.modelOptions ?? [modelSelection.model]).map((value) => ({
                  value,
                  name: value,
                })),
              },
              {
                id: "thinking_level",
                name: "Thinking level",
                category: "thought_level",
                type: "select",
                currentValue: thinkingLevel,
                options: [
                  { value: "low", name: "Low" },
                  { value: "high", name: "High" },
                ],
              },
            ] satisfies Array<AcpSchema.SessionConfigOption>,
        ),
        getEvents: () => Stream.fromQueue(events),
        setModel: (model) =>
          Effect.sync(() => {
            state.selectedModels.push(model);
            currentModel = model;
          }),
        setConfigOption: (id, value) =>
          Effect.gen(function* () {
            if (id === "thinking_level" && typeof value === "string") {
              state.thinkingUpdates.push(value);
              if (options.rejectThinkingUpdate)
                return yield* AcpRequestError.invalidParams(
                  "Thinking level is no longer available.",
                );
              thinkingLevel = value;
            }
            return { configOptions: [] };
          }),
        prompt: (request) =>
          Effect.gen(function* () {
            state.prompts.push(request);
            state.promptThinkingLevels.push(thinkingLevel);
            yield* Deferred.succeed(enteredPrompt, undefined);
            const emit: PromptContext["emit"] = (update, sessionId = nativeSessionId) =>
              sessionUpdate({ sessionId, update });
            if (options.prompt) {
              return yield* options.prompt({
                emit,
                ...incoming,
                cwd,
              });
            }
            const output = outputs.shift() ?? '{"title":"Repair login"}';
            yield* emit({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Choose concise text." },
            });
            yield* emit(
              {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "unrelated session" },
              },
              "another-session",
            );
            for (const text of [output.slice(0, 9), output.slice(9)]) {
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text },
              });
            }
            return { stopReason: "end_turn" };
          }),
        cancel: Effect.gen(function* () {
          state.cancellations += 1;
          const acknowledge = yield* Deferred.make<void>();
          yield* Queue.offer(events, { _tag: "EventStreamBarrier", acknowledge });
          yield* Deferred.await(acknowledge);
        }),
        handleSessionUpdate: (handler) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }),
        handleRequestPermission: (handler) =>
          Effect.sync(() => {
            incoming.permission = handler;
          }),
        handleElicitation: (handler) =>
          Effect.sync(() => {
            incoming.question = handler;
          }),
        handleReadTextFile: (handler) =>
          Effect.sync(() => {
            incoming.readFile = handler;
          }),
        handleWriteTextFile: () => Effect.void,
        handleCreateTerminal: (handler) =>
          Effect.sync(() => {
            incoming.createTerminal = handler;
          }),
        handleTerminalOutput: () => Effect.void,
        handleTerminalWaitForExit: () => Effect.void,
        handleTerminalKill: () => Effect.void,
        handleTerminalRelease: () => Effect.void,
        handleUnknownExtRequest: (handler) =>
          Effect.sync(() => {
            incoming.extension = handler;
          }),
      } satisfies TextRuntime;
    });

  const textGeneration = yield* makeAntigravityTextGeneration({
    profileDirectory,
    ...(options.memoryRunnerContext === undefined
      ? {}
      : { memoryRunnerContext: options.memoryRunnerContext }),
    makeRuntime,
    withProcess,
  });
  const titleInput = { cwd: projectDirectory, message: "Repair Google login", modelSelection };
  const assertCleaned = Effect.gen(function* () {
    expect(state.closed).toEqual(state.workspaces);
    for (const workspace of state.workspaces) {
      expect(yield* fs.exists(workspace)).toBe(false);
    }
    expect(yield* fs.exists(`${sessionBase}.db`)).toBe(false);
    expect(yield* fs.exists(`${sessionBase}.db-wal`)).toBe(false);
    expect(yield* fs.exists(`${sessionBase}.meta`)).toBe(false);
    expect(yield* fs.exists(brainDirectory)).toBe(false);
    expect(yield* fs.readFileString(path.join(projectDirectory, "keep.txt"))).toBe("untouched");
    expect(yield* fs.readFileString(path.join(conversations, "user-session.db"))).toBe(
      "keep native history",
    );
  });
  return {
    fs,
    path,
    profileDirectory,
    projectDirectory,
    sessionBase,
    brainDirectory,
    state,
    incoming,
    enteredPrompt,
    textGeneration,
    titleInput,
    assertCleaned,
  };
});
