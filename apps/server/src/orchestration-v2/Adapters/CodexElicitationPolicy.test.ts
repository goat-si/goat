import { RunAttemptId, type OrchestrationV2RuntimeRequest } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as MemoryDerivedCache from "../../memory/MemoryDerivedCache.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import { codexReplayPreamble, makeCodexReplayHarness } from "./CodexAdapterV2.replay.testkit.ts";
import { makeCodexReplayTranscript, makeCodexReplayTurn } from "./CodexReplay.testkit.ts";

const layer = Layer.mergeAll(
  MemoryDerivedCache.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
  NodeCrypto.layer,
);

it.effect.each([
  {
    name: "fillable full access",
    mode: "full-access",
    form: "fillable",
    context: true,
    expected: "accept",
    approval: false,
  },
  {
    name: "raw enumNames",
    mode: "full-access",
    form: "enumNames",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "raw unknown annotation",
    mode: "full-access",
    form: "unknown",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "upstream Safari access",
    mode: "full-access",
    form: "safari",
    context: true,
    expected: "accept",
    approval: false,
  },
  {
    name: "unsupported required input",
    mode: "full-access",
    form: "unsupported",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "always only",
    mode: "full-access",
    form: "always",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "non scope enum",
    mode: "full-access",
    form: "nonscope",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "required remember",
    mode: "full-access",
    form: "remember",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "defaulted input",
    mode: "full-access",
    form: "defaulted",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "duration default always",
    mode: "full-access",
    form: "duration",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "save approval default true",
    mode: "full-access",
    form: "save",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "backup frequency",
    mode: "full-access",
    form: "frequency",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "extra field",
    mode: "full-access",
    form: "extra",
    context: true,
    expected: "cancel",
    approval: false,
  },
  {
    name: "pure confirmation",
    mode: "full-access",
    form: "confirm",
    context: true,
    expected: "accept",
    approval: false,
  },
  {
    name: "ordinary approval",
    mode: "auto-accept-edits",
    form: "fillable",
    context: true,
    expected: "accept",
    approval: true,
  },
  {
    name: "missing context",
    mode: "full-access",
    form: "fillable",
    context: false,
    expected: "cancel",
    approval: false,
  },
] as const)("handles $name", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeThreadId = "elicitation-thread";
      const nativeTurnId = "elicitation-turn";
      const prompt = "Open the page";
      const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }).map(
        (entry) => {
          if (
            scenario.mode !== "auto-accept-edits" ||
            entry.type !== "expect_outbound" ||
            typeof entry.frame !== "object" ||
            entry.frame === null ||
            !("method" in entry.frame) ||
            entry.frame.method !== "turn/start" ||
            !("params" in entry.frame) ||
            typeof entry.frame.params !== "object" ||
            entry.frame.params === null
          )
            return entry;
          return {
            ...entry,
            frame: {
              ...entry.frame,
              params: {
                ...entry.frame.params,
                approvalPolicy: "on-request",
                sandboxPolicy: { type: "workspaceWrite" },
              },
            },
          };
        },
      );
      const schema =
        scenario.form === "safari"
          ? {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  oneOf: [
                    { const: "once", title: "Allow once" },
                    { const: "session", title: "Allow for this session" },
                    { const: "always", title: "Always allow Safari" },
                  ],
                },
              },
              required: ["approval"],
            }
          : scenario.form === "confirm"
            ? { type: "object", properties: {}, required: [] }
            : scenario.form === "duration"
              ? {
                  type: "object",
                  properties: {
                    duration: {
                      type: "string",
                      title: "Duration",
                      enum: ["once", "always"],
                      default: "always",
                    },
                  },
                  required: ["duration"],
                }
              : scenario.form === "save"
                ? {
                    type: "object",
                    properties: {
                      save: {
                        type: "boolean",
                        title: "Save this approval for later",
                        default: true,
                      },
                    },
                    required: ["save"],
                  }
                : scenario.form === "frequency"
                  ? {
                      type: "object",
                      properties: {
                        frequency: {
                          type: "string",
                          title: "Frequency of backups",
                          enum: ["once", "always"],
                        },
                      },
                      required: ["frequency"],
                    }
                  : scenario.form === "extra"
                    ? {
                        type: "object",
                        properties: {
                          approval: { type: "string", enum: ["once", "always"] },
                          extra: { type: "string" },
                        },
                        required: ["approval"],
                      }
                    : scenario.form === "fillable"
                      ? {
                          type: "object",
                          properties: { approval: { type: "string", enum: ["once", "always"] } },
                          required: ["approval"],
                        }
                      : scenario.form === "always"
                        ? {
                            type: "object",
                            properties: { approval: { type: "string", enum: ["always"] } },
                            required: ["approval"],
                          }
                        : scenario.form === "nonscope"
                          ? {
                              type: "object",
                              properties: { choice: { type: "string", enum: ["allow", "deny"] } },
                              required: ["choice"],
                            }
                          : scenario.form === "remember"
                            ? {
                                type: "object",
                                properties: { remember: { type: "boolean" } },
                                required: ["remember"],
                              }
                            : scenario.form === "defaulted"
                              ? {
                                  type: "object",
                                  properties: {
                                    email: { type: "string", default: "chosen@example.test" },
                                  },
                                  required: ["email"],
                                }
                              : {
                                  type: "object",
                                  properties: { email: { type: "string" } },
                                  required: ["email"],
                                };
      const wireSchema =
        scenario.form === "enumNames"
          ? {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  enum: ["once", "always"],
                  enumNames: ["Always allow", "Allow once"],
                },
              },
              required: ["approval"],
            }
          : scenario.form === "unknown"
            ? {
                type: "object",
                properties: { approval: { type: "string", enum: ["once", "always"] } },
                required: ["approval"],
                unknown_annotation: "changed",
              }
            : schema;
      const harness = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: scenario.name,
          entries: [
            ...preamble,
            {
              type: "emit_inbound",
              frame: {
                id: 20,
                method: "mcpServer/elicitation/request",
                params: {
                  threadId: scenario.context ? nativeThreadId : "unknown-thread",
                  turnId: scenario.context ? nativeTurnId : null,
                  serverName: "browser",
                  mode: "form",
                  message: "Allow access?",
                  requestedSchema: wireSchema,
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 20,
                result:
                  scenario.expected === "accept"
                    ? {
                        action: "accept",
                        content: scenario.form === "confirm" ? {} : { approval: "once" },
                      }
                    : { action: "cancel" },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        }),
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
            ? Queue.offer(pending, event.runtimeRequest)
            : Effect.void,
      );
      const input = makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(`attempt-${scenario.name}`),
        text: prompt,
      });
      yield* harness.runtime.startTurn({
        ...input,
        runtimePolicy: { ...input.runtimePolicy, runtimeMode: scenario.mode },
      });
      const request = yield* Effect.raceFirst(
        Queue.take(pending),
        harness.firstTerminal.pipe(Effect.as(undefined)),
      );
      if (scenario.approval) {
        assert.isDefined(request);
        if (request)
          yield* harness.runtime.respondToRuntimeRequest({
            requestId: request.id,
            decision: "accept",
          });
        yield* harness.firstTerminal;
      } else assert.isUndefined(request);
      assert.deepEqual(
        harness.terminalEvents().map((event) => event.status),
        ["completed"],
      );
    }),
  ).pipe(Effect.provide(layer)),
);
