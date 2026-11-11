import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
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
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import * as DocumentText from "../../provider/DocumentText.ts";
import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, decodeUnknownJson } from "./AcpMockRuntime.testkit.ts";

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const layerTest = Layer.mergeAll(
  DocumentText.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
);
const ACP_TEST_DRIVER = ProviderDriverKind.make("acp-test");

const runFormElicitation = (input: {
  readonly name: string;
  readonly requestedSchema: unknown;
  readonly answer: (
    questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  ) => ProviderUserInputAnswers | undefined;
}) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-acp-form-elicitation-",
    });
    const responseLog = path.join(directory, "responses.jsonl");
    const instanceId = ProviderInstanceId.make(`acp-test-form-${input.name}`);
    const adapter = yield* makeAcpAdapterV2({
      instanceId,
      flavor: {
        driver: ACP_TEST_DRIVER,
        capabilities: AcpProviderCapabilitiesV2,
        makeRuntime: makeMockRuntime({
          childProcessSpawner,
          mockAgentPath,
          environment: {
            GOAT_ACP_EMIT_ELICITATION: "1",
            GOAT_ACP_ELICITATION_SCHEMA: JSON.stringify(input.requestedSchema),
            GOAT_ACP_ELICITATION_RESPONSE_LOG_PATH: responseLog,
          },
        }),
      },
      selfInvocation: yield* resolveSelfInvocation(),
    });
    const threadId = ThreadId.make(`thread-acp-form-${input.name}`);
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-acp-form-${input.name}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* runtime.startTurn(
      makeTurnInput({
        threadId,
        providerThread,
        instanceId,
        runtimePolicy,
        now: yield* DateTime.now,
      }),
    );
    const first = Option.getOrThrow(
      yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "turn.terminal" ||
            (event.type === "turn_item.updated" && event.turnItem.type === "user_input_request"),
        ),
        Stream.runHead,
      ),
    );
    let questions: ReadonlyArray<OrchestrationV2UserInputQuestion> | undefined;
    if (first.type === "turn_item.updated" && first.turnItem.type === "user_input_request") {
      questions = first.turnItem.questions;
      const answers = input.answer(questions);
      yield* runtime.respondToRuntimeRequest({
        requestId: first.turnItem.requestId,
        ...(answers === undefined ? {} : { answers }),
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
    }
    const responses = (yield* fileSystem.readFileString(responseLog))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => Option.getOrThrow(decodeUnknownJson(line)));
    assert.lengthOf(responses, 1);
    return { questions, response: responses[0] };
  });

/** Submits like the web and mobile clients: an option's `value`, else its label. */
const optionValues = (question: OrchestrationV2UserInputQuestion | undefined) =>
  question?.options.map((option) => option.value ?? option.label);

describe("AcpAdapterV2 forms", () => {
  it.live("asks form fields with their fixed choices and answers in the declared types", () =>
    Effect.gen(function* () {
      const { questions, response } = yield* runFormElicitation({
        name: "typed",
        requestedSchema: {
          type: "object",
          properties: {
            color: { type: "string", title: "Color", enum: ["red", "green"] },
            size: {
              type: "string",
              oneOf: [
                { const: "m", title: "Medium" },
                { const: "l", title: "Large" },
              ],
            },
            tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } },
            areas: {
              type: "array",
              items: {
                anyOf: [
                  { const: "api", title: "API", description: "Server routes" },
                  { const: "ui", title: "Interface" },
                ],
              },
            },
            confirm: { type: "boolean" },
            count: { type: "integer" },
            ratio: { type: "number" },
            limit: { type: "integer" },
            note: { type: "string", enum: null },
          },
          required: ["color", "tags", "confirm", "count"],
        },
        answer: (asked) => {
          const byId = new Map(asked.map((question) => [question.id, question]));
          return {
            color: optionValues(byId.get("color"))?.[1],
            size: optionValues(byId.get("size"))?.[1],
            tags: ["c", "a", "unknown", "a"],
            areas: optionValues(byId.get("areas"))?.toReversed(),
            confirm: optionValues(byId.get("confirm"))?.[1],
            count: "3",
            ratio: " 0.5 ",
            // Not an integer: omitted, since the field is optional.
            limit: "3.7",
            note: "hi",
            extra: "not in the form",
          };
        },
      });
      assert.deepStrictEqual(
        questions?.map((question) => ({
          id: question.id,
          labels: question.options.map((option) => option.label),
          values: optionValues(question),
          multiSelect: question.multiSelect,
          allowCustomAnswer: question.allowCustomAnswer,
        })),
        [
          {
            id: "color",
            labels: ["red", "green"],
            values: ["red", "green"],
            multiSelect: undefined,
            allowCustomAnswer: false,
          },
          {
            id: "size",
            labels: ["Medium", "Large"],
            values: ["m", "l"],
            multiSelect: undefined,
            allowCustomAnswer: false,
          },
          {
            id: "tags",
            labels: ["a", "b", "c"],
            values: ["a", "b", "c"],
            multiSelect: true,
            allowCustomAnswer: false,
          },
          {
            id: "areas",
            labels: ["API", "Interface"],
            values: ["api", "ui"],
            multiSelect: true,
            allowCustomAnswer: false,
          },
          {
            id: "confirm",
            labels: ["true", "false"],
            values: ["true", "false"],
            multiSelect: undefined,
            allowCustomAnswer: false,
          },
          ...["count", "ratio", "limit", "note"].map((id) => ({
            id,
            labels: [],
            values: [],
            multiSelect: undefined,
            allowCustomAnswer: undefined,
          })),
        ],
      );
      assert.deepStrictEqual(response, {
        action: "accept",
        content: {
          color: "green",
          size: "l",
          tags: ["c", "a"],
          areas: ["ui", "api"],
          confirm: false,
          count: 3,
          ratio: 0.5,
          note: "hi",
        },
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("keeps explicit empty selections and checks selection counts", () =>
    Effect.gen(function* () {
      const items = { type: "string", enum: ["a", "b", "c"] };
      const requestedSchema = {
        type: "object",
        properties: {
          none: { type: "array", items, default: [] },
          all: { type: "array", items, maxItems: 3 },
          optionalNone: { type: "array", items },
          some: { type: "array", items, minItems: 1 },
          tooMany: { type: "array", items, maxItems: 1 },
          single: { type: "array", items },
          unknownOnly: { type: "array", items },
          omitted: { type: "array", items },
        },
        required: ["none", "all", "some"],
      };
      const accepted = yield* runFormElicitation({
        name: "selection-counts",
        requestedSchema,
        answer: () => ({
          none: [],
          all: ["a", "b", "c"],
          optionalNone: [],
          some: ["b"],
          // Optional and not valid selections, so they are left out.
          tooMany: ["a", "b"],
          single: "a",
          unknownOnly: ["z"],
        }),
      });
      assert.deepStrictEqual(accepted.response, {
        action: "accept",
        content: { none: [], all: ["a", "b", "c"], optionalNone: [], some: ["b"] },
      });
      const belowMinimum = yield* runFormElicitation({
        name: "selection-below-minimum",
        requestedSchema,
        answer: () => ({ none: [], all: ["a"], some: [] }),
      });
      assert.deepStrictEqual(belowMinimum.response, { action: "cancel" });
      const requiredOmitted = yield* runFormElicitation({
        name: "selection-required-omitted",
        requestedSchema,
        answer: () => ({ all: ["a"], some: ["a"] }),
      });
      assert.deepStrictEqual(requiredOmitted.response, { action: "cancel" });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("answers a field named __proto__ like any other field", () =>
    Effect.gen(function* () {
      const { questions, response } = yield* runFormElicitation({
        name: "proto-field",
        requestedSchema: {
          type: "object",
          properties: {
            ["__proto__"]: { type: "string", enum: ["a", "b"] },
            name: { type: "string" },
          },
          required: ["__proto__", "name"],
        },
        answer: () => ({ ["__proto__"]: "b", name: "hi" }),
      });
      assert.deepStrictEqual(
        questions?.map((question) => question.id),
        ["__proto__", "name"],
      );
      assert.deepStrictEqual(response, {
        action: "accept",
        content: { ["__proto__"]: "b", name: "hi" },
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("declines a form whose selection counts the client cannot answer, without asking", () =>
    Effect.gen(function* () {
      const items = { type: "string", enum: ["a", "b"] };
      for (const [name, bounds] of [
        ["min-above-max", { minItems: 2, maxItems: 1 }],
        ["min-above-options", { minItems: 3 }],
        ["empty-only", { maxItems: 0 }],
      ] as const) {
        const { questions, response } = yield* runFormElicitation({
          name,
          requestedSchema: {
            type: "object",
            properties: { tags: { type: "array", items, ...bounds } },
          },
          answer: () => assert.fail("an impossible form must not reach the user"),
        });
        assert.isUndefined(questions);
        assert.deepStrictEqual(response, { action: "decline" });
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("cancels a form whose required answer does not fit, or that is dismissed", () =>
    Effect.gen(function* () {
      const requestedSchema = {
        type: "object",
        properties: { count: { type: "integer" }, note: { type: "string" } },
        required: ["count"],
      };
      const invalid = yield* runFormElicitation({
        name: "invalid-required",
        requestedSchema,
        answer: () => ({ count: "two", note: "hi" }),
      });
      assert.deepStrictEqual(invalid.response, { action: "cancel" });
      const dismissed = yield* runFormElicitation({
        name: "dismissed",
        requestedSchema,
        answer: () => undefined,
      });
      assert.deepStrictEqual(dismissed.response, { action: "cancel" });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("declines a form with a field it cannot ask for, without asking", () =>
    Effect.gen(function* () {
      const { questions, response } = yield* runFormElicitation({
        name: "unsupported",
        requestedSchema: {
          type: "object",
          properties: {
            color: { type: "string", enum: ["red"] },
            files: { type: "array", items: { type: "_upload" } },
          },
        },
        answer: () => assert.fail("an unsupported form must not reach the user"),
      });
      assert.isUndefined(questions);
      assert.deepStrictEqual(response, { action: "decline" });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
