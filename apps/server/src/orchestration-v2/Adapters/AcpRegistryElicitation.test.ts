// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { AcpRegistrySettings } from "@goat/provider-acp-registry/settings";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeAcpRegistryAdapterV2 } from "@goat/provider-acp-registry/testing";
import { AcpRegistryCatalog } from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import { type ProviderUserInputAnswers } from "@goat/contracts";
import { appendUserInputAttachmentPaths } from "../../provider/userInputAttachments.ts";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const DROID_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({ agentId: "factory-droid" });
const OPENCODE_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({
  source: "local",
  commandPath: "/usr/local/bin/opencode",
  commandArgs: ["acp"],
});

const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("ACP Registry elicitation", () => {
  const droidChoice = {
    type: "string",
    title: "Format",
    description: "Which reply format?",
    oneOf: [
      { const: "option_0", title: "JSON" },
      { const: "option_1", title: "Plain text" },
      { const: "other", title: "Other answer" },
    ],
  };

  const droidSchema = {
    type: "object",
    properties: {
      question_1: droidChoice,
      question_1_other: { type: "string" },
      question_2: { ...droidChoice, title: "Alternative" },
      question_2_other: { type: "string" },
    },
    required: ["question_1", "question_2"],
  };

  const droidQuestions = ["question_1", "question_2"].map((id, index) => ({
    id,
    header: index === 0 ? "Format" : "Alternative",
    question: "Which reply format?",
    options: [
      { label: "JSON", description: "JSON", value: "option_0" },
      { label: "Plain text", description: "Plain text", value: "option_1" },
    ],
  }));

  // OpenCode 2.1 pairs each qN choice with a qN_custom free-form companion.
  const openCodeSchema = {
    type: "object",
    properties: {
      q0: {
        type: "string",
        title: "Color preference",
        description: "Which color do you prefer?",
        oneOf: [
          { const: "red", title: "Red", description: "Choose the color red" },
          { const: "blue", title: "Blue" },
        ],
        default: "red",
      },
      q0_custom: {
        type: "string",
        title: "Color preference (other)",
        description: "Type your own answer",
        minLength: 1,
      },
    },
  };
  const openCodeQuestions = [
    {
      id: "q0",
      header: "Color preference",
      question: "Which color do you prefer?",
      options: [
        { label: "Red", description: "Choose the color red", value: "red" },
        { label: "Blue", description: "Blue", value: "blue" },
      ],
      allowCustomAnswer: true,
    },
  ];

  it.live.each([
    {
      scenario: "preserves selected IDs and encodes custom answers",
      schema: droidSchema,
      questions: droidQuestions,
      answers: { question_1: "option_1", question_2: "Markdown" },
      result: {
        action: "accept",
        content: { question_1: "option_1", question_2: "other", question_2_other: "Markdown" },
      },
    },
    {
      scenario: "preserves selected labels and attachment paths in custom answers",
      schema: droidSchema,
      questions: droidQuestions,
      withAttachments: true,
      answers: {
        question_1: "option_1",
        question_2: "option_1\n\nAttached notes: keep this custom text",
      },
      result: (directory: string) => ({
        action: "accept",
        content: {
          question_1: "other",
          question_1_other: `Plain text\n\nAttached image "shot.png": ${JSON.stringify(NodePath.join(directory, "droid-shot.png"))}\nAttached file "spec.txt": ${JSON.stringify(NodePath.join(directory, "droid-spec.txt"))}`,
          question_2: "other",
          question_2_other: "option_1\n\nAttached notes: keep this custom text",
        },
      }),
    },
    {
      scenario: "cancels without accepting answers",
      schema: droidSchema,
      questions: droidQuestions,
      answers: undefined,
      result: { action: "cancel" },
    },
    {
      scenario: "falls back for an unrelated form",
      schema: { type: "object", properties: { name: { type: "string" } } },
      questions: [{ id: "name", header: "Question 1", question: "Your answer?", options: [] }],
      answers: { name: "Ada" },
      result: { action: "accept", content: { name: "Ada" } },
    },
    {
      scenario: "OpenCode keeps the selected option and hides the custom companion",
      settings: OPENCODE_SETTINGS,
      schema: openCodeSchema,
      questions: openCodeQuestions,
      answers: { q0: "blue" },
      result: { action: "accept", content: { q0: "blue" } },
    },
  ])("Registry elicitation $scenario", (fixture) => {
    const { schema, questions, answers, result } = fixture;
    const withAttachments = "withAttachments" in fixture && fixture.withAttachments;
    const settings = "settings" in fixture ? fixture.settings : DROID_SETTINGS;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-droid-form-" });
      const statusPath = path.join(directory, "status.json");
      const expectedResult = typeof result === "function" ? result(directory) : result;
      let preparedAnswers: ProviderUserInputAnswers | undefined = answers;
      if (withAttachments && answers !== undefined) {
        yield* fileSystem.writeFileString(path.join(directory, "droid-shot.png"), "image");
        yield* fileSystem.writeFileString(path.join(directory, "droid-spec.txt"), "spec");
        preparedAnswers = yield* appendUserInputAttachmentPaths({
          answers,
          attachmentsDir: directory,
          attachmentsByQuestionId: {
            question_1: [
              {
                type: "image",
                id: "droid-shot",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
              {
                type: "file",
                id: "droid-spec",
                name: "spec.txt",
                mimeType: "text/plain",
                sizeBytes: 4,
              },
            ],
          },
        });
      }
      const driver = ProviderDriverKind.make("acpRegistry");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: driver,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "droid-form",
          entries: [
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "initialize", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "initialize",
                result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/new", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/new",
                result: { sessionId: "droid-session" },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method: "session/prompt", params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "request",
                method: "elicitation/create",
                params: {
                  mode: "form",
                  sessionId: "droid-session",
                  message: "Your answer?",
                  requestedSchema: schema,
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                kind: "response",
                method: "elicitation/create",
                result: expectedResult,
              },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/prompt",
                result: { stopReason: "end_turn" },
              },
            },
            { type: "runtime_exit", status: "success" },
          ],
        },
        driver,
      );
      const instanceId = ProviderInstanceId.make("droid-form-test");
      const adapter = yield* makeAcpRegistryAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        settings,
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          fileSystem,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        }),
      }).pipe(
        Effect.provide(
          Layer.mock(AcpRegistryCatalog)({ resolve: () => Effect.die("runtime is injected") }),
        ),
      );
      const threadId = ThreadId.make("droid-form-thread");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: directory,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        modelSelection,
        runtimePolicy,
        providerSessionId: ProviderSessionId.make("droid-form-session"),
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.startTurn(
        makeTurnInput({
          threadId,
          providerThread,
          instanceId,
          runtimePolicy,
          now: yield* DateTime.now,
        }),
      );
      const item = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
          ),
          Stream.runHead,
        ),
      );
      if (item.type !== "turn_item.updated" || item.turnItem.type !== "user_input_request")
        return yield* Effect.die("Expected Droid question");
      assert.deepEqual(item.turnItem.questions, questions);
      yield* runtime.respondToRuntimeRequest({
        requestId: item.turnItem.requestId,
        ...(preparedAnswers === undefined ? {} : { answers: preparedAnswers }),
      });
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(Option.getOrThrow(terminal).status, "completed");
    }).pipe(Effect.provide(layerTest), Effect.scoped);
  });
});
