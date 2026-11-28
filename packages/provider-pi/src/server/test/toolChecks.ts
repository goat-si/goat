import { OrchestrationV2UserInputQuestion } from "@goat/contracts";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as FileSystem from "effect/FileSystem";
import { PI_PROVIDER } from "../adapter.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Fixture from "../adapter.test.ts";
import type * as FakePiModule from "./fakePi.ts";
import { registerPiAsyncSubagentChecks } from "./asyncSubagentChecks.ts";

const decodeUserInputQuestions = Schema.decodeUnknownSync(
  Schema.Array(OrchestrationV2UserInputQuestion),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function registerPiToolChecks({
  makeFakePi,
  makeAdapter,
  openRuntime,
  startTurn,
  THREAD_ID,
  SESSION_ID,
  modelSelection,
  runtimePolicy,
  layerTest,
}: {
  makeFakePi: typeof FakePiModule.makeFakePi;
  makeAdapter: typeof Fixture.makeAdapter;
  openRuntime: typeof Fixture.openRuntime;
  startTurn: typeof Fixture.startTurn;
  THREAD_ID: typeof Fixture.THREAD_ID;
  SESSION_ID: typeof Fixture.SESSION_ID;
  modelSelection: typeof Fixture.modelSelection;
  runtimePolicy: typeof Fixture.runtimePolicy;
  layerTest: typeof Fixture.layerTest;
}) {
  it.effect("replaces a restarted reasoning block, including a published empty replacement", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      const thinking = (event: Record<string, unknown>) =>
        fake.emit({ type: "message_update", assistantMessageEvent: { contentIndex: 0, ...event } });
      yield* thinking({ type: "thinking_start" });
      yield* thinking({ type: "thinking_delta", delta: "abandoned" });
      yield* thinking({ type: "thinking_start" });
      yield* thinking({ type: "thinking_delta", delta: "replacement" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "barrier",
        toolName: "read",
        args: {},
      });
      yield* takeEvent(
        (event) =>
          event.type === "node.updated" && event.node.nativeItemRef?.nativeId === "barrier",
      );
      yield* TestClock.adjust("50 millis");
      const published = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "reasoning",
      );
      if (published.type !== "turn_item.updated" || published.turnItem.type !== "reasoning")
        return assert.fail("expected reasoning");
      assert.equal(published.turnItem.text, "replacement");
      yield* thinking({ type: "thinking_start" });
      yield* thinking({ type: "thinking_end" });
      const completed = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "reasoning" &&
          event.turnItem.status === "completed",
      );
      if (completed.type !== "turn_item.updated" || completed.turnItem.type !== "reasoning")
        return assert.fail("expected completed reasoning");
      assert.equal(completed.turnItem.text, "");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  /* oxlint-disable goat/no-em-dash-copy -- Matches Pi extension protocol values. */
  it.effect("renders an ask_user_question select from the tool call's structured question", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "ask-call",
        toolName: "ask_user_question",
        args: {
          questions: [
            {
              header: "Area",
              question: "Which area should we work on?",
              options: [
                {
                  label: "Docker/Compose",
                  description: "Review or edit Compose projects",
                  preview: "services:\n  web: {}",
                },
                { label: "Home Assistant", description: "Automations, dashboards or YAML" },
              ],
            },
          ],
        },
      });
      const dockerLine = "1. Docker/Compose \u2014 Review or edit Compose projects";
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-ask",
        method: "select",
        title:
          "[Area] Which area should we work on?\n\n--- 1. Docker/Compose preview ---\nservices:\n  web: {}",
        options: [
          dockerLine,
          "2. Home Assistant \u2014 Automations, dashboards or YAML",
          "3. Type something.",
        ],
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request") {
        return assert.fail("expected a user input request");
      }
      const question = decodeUserInputQuestions(event.turnItem.questions)[0];
      assert.deepEqual(
        {
          header: question?.header,
          question: question?.question,
          options: question?.options.map(({ label, description }) => ({ label, description })),
        },
        {
          header: "Area",
          question:
            "Which area should we work on?\n\n--- 1. Docker/Compose preview ---\nservices:\n  web: {}",
          options: [
            { label: "Docker/Compose", description: "Review or edit Compose projects" },
            { label: "Home Assistant", description: "Automations, dashboards or YAML" },
          ],
        },
      );
      yield* runtime.respondToRuntimeRequest({
        requestId: event.turnItem.requestId,
        answers: { [question!.id]: question!.options[0]!.value },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["id"], "ui-ask");
      assert.equal(response["value"], dockerLine);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("matches an ask_user_question select to the question with the same full title", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const options = [
        { label: "Yes", description: "Go ahead" },
        { label: "No", description: "Stop here" },
      ];
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "ask-call",
        toolName: "ask_user_question",
        // Some models JSON-encode `questions`; the extension decodes it before asking.
        args: {
          questions: encodeJson([
            { header: "Deploy", question: "Proceed?", options },
            { header: "Deploy", question: "Proceed? Only for staging?", options },
          ]),
        },
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-ask",
        method: "select",
        title: "[Deploy] Proceed? Only for staging?",
        options: ["1. Yes \u2014 Go ahead", "2. No \u2014 Stop here", "3. Type something."],
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request") {
        return assert.fail("expected a user input request");
      }
      const question = decodeUserInputQuestions(event.turnItem.questions)[0];
      assert.equal(question?.question, "Proceed? Only for staging?");
      // Option lines that differ from the recorded call keep the raw select.
      const unmatchedLines = ["1. Yes \u2014 Go", "2. No \u2014 Stop here", "3. Type something."];
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-unmatched",
        method: "select",
        title: "[Deploy] Proceed?",
        options: unmatchedLines,
      });
      const unmatched = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (
        unmatched.type !== "turn_item.updated" ||
        unmatched.turnItem.type !== "user_input_request"
      ) {
        return assert.fail("expected a user input request");
      }
      const unmatchedQuestion = decodeUserInputQuestions(unmatched.turnItem.questions)[0];
      assert.deepEqual(
        {
          header: unmatchedQuestion?.header,
          question: unmatchedQuestion?.question,
          options: unmatchedQuestion?.options.map(({ label, value }) => [label, value]),
        },
        {
          header: "Question",
          question: "[Deploy] Proceed?",
          options: unmatchedLines.map((line) => [line, line]),
        },
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("answers each ask_user_question custom text through its follow-up input", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      const args = {
        questions: [
          {
            question: "How many replicas?",
            options: [
              { label: "One", description: "Single instance" },
              { label: "Three", description: "High availability" },
            ],
          },
        ],
      };
      // Parallel questionnaires can ask the same question.
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "ask-call",
        toolName: "ask_user_question",
        args,
      });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "ask-call-parallel",
        toolName: "ask_user_question",
        args,
      });
      const lines = ["1. One \u2014 Single instance", "2. Three \u2014 High availability"];
      const followUpTitle = `How many replicas?\n\n${lines.join("\n")}\n\nType your answer:`;
      const takeWaitingRequest = Effect.fnUntraced(function* () {
        const event = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.status === "waiting",
        );
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request") {
          return assert.fail("expected a user input request");
        }
        return event.turnItem;
      });
      const answerWithCustomText = Effect.fnUntraced(function* (id: string, text: string) {
        yield* fake.emit({
          type: "extension_ui_request",
          id,
          method: "select",
          title: "How many replicas?",
          options: [...lines, "3. Type something."],
        });
        const request = yield* takeWaitingRequest();
        yield* runtime.respondToRuntimeRequest({
          requestId: request.requestId,
          answers: { [request.questions[0]!.id]: text },
        });
        const selectResponse = yield* fake.takeRequest("extension_ui_response");
        assert.equal(selectResponse["value"], "3. Type something.");
      });
      // The extension reads a bare number sent as the select's value as that option.
      yield* answerWithCustomText("ui-ask", "2");
      yield* answerWithCustomText("ui-ask-parallel", "3. Type something.");
      // Parallel dialogs can arrive before the follow-up input, including a multi-select of the
      // same question, which the extension asks as an input with a non-empty placeholder.
      const multiSelectTitle = `How many replicas?\n\n${lines.join("\n")}\n\nEnter the numbers of all that apply.`;
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-multi",
        method: "input",
        title: multiSelectTitle,
        placeholder: "1,3; custom answer",
      });
      // Another extension's blank-placeholder input that only shares the question is asked.
      const unrelatedTitle = "How many replicas?\n\nEnter the release note:";
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-unrelated",
        method: "input",
        title: unrelatedTitle,
        placeholder: "",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-other",
        method: "input",
        title: "Anything else?",
      });
      assert.equal((yield* takeWaitingRequest()).title, multiSelectTitle);
      assert.equal((yield* takeWaitingRequest()).title, unrelatedTitle);
      assert.equal((yield* takeWaitingRequest()).title, "Anything else?");
      for (const [id, value] of [
        ["ui-custom", "2"],
        ["ui-custom-parallel", "3. Type something."],
      ]) {
        yield* fake.emit({
          type: "extension_ui_request",
          id,
          method: "input",
          title: followUpTitle,
          placeholder: "",
        });
        const nextTitle = `Next question after ${id}?`;
        yield* fake.emit({
          type: "extension_ui_request",
          id: `next-${id}`,
          method: "input",
          title: nextTitle,
        });
        assert.equal((yield* takeWaitingRequest()).questions[0]?.id, `next-${id}`);
        const inputResponse = yield* fake.takeRequest("extension_ui_response");
        assert.deepEqual({ id: inputResponse["id"], value: inputResponse["value"] }, { id, value });
      }
      // An answer staged when the turn ends is dropped, so a later matching input is asked.
      yield* answerWithCustomText("ui-ask-late", "7");
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-custom-late",
        method: "input",
        title: followUpTitle,
        placeholder: "",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-after",
        method: "input",
        title: "Anything else?",
      });
      assert.equal((yield* takeWaitingRequest()).title, followUpTitle);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  /* oxlint-enable goat/no-em-dash-copy */
  it.effect("nests tools called through another tool under their caller", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const takeToolEvents = Effect.fnUntraced(function* (toolCallId: string) {
        const node = yield* takeEvent(
          (event) =>
            event.type === "node.updated" && event.node.nativeItemRef?.nativeId === toolCallId,
        );
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === toolCallId,
        );
        if (node.type !== "node.updated" || item.type !== "turn_item.updated")
          return yield* Effect.die("Expected tool node and item events");
        return { node: node.node, item: item.turnItem };
      });

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_code",
        toolName: "codemode",
        args: { code: "await read({ path: 'a.ts' })" },
      });
      const caller = yield* takeToolEvents("call_code");
      assert.equal(caller.node.parentNodeId, caller.node.rootNodeId);
      assert.isNull(caller.item.parentItemId);

      // Pi tags every phase, so an update that arrives before its start still nests.
      const phases = [
        { type: "tool_execution_update", partialResult: { content: [] }, status: "running" },
        { type: "tool_execution_start", args: { path: "a.ts" }, status: "running" },
        {
          type: "tool_execution_end",
          isError: true,
          result: { content: [{ type: "text", text: "ENOENT" }] },
          status: "failed",
        },
      ] as const;
      for (const { status, ...phase } of phases) {
        yield* fake.emit({
          ...phase,
          toolCallId: "call_code/1",
          toolName: "read",
          parentToolCallId: "call_code",
        });
        const nested = yield* takeToolEvents("call_code/1");
        assert.equal(nested.node.status, status);
        assert.equal(nested.node.parentNodeId, caller.node.id);
        assert.equal(nested.item.parentItemId, caller.item.id);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("emits only new shell output from repeated Pi snapshots", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "shell-delta",
        toolName: "bash",
        args: { command: "echo hello" },
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
      );
      for (const [text, totalBytes, expected] of [
        ["hel", undefined, "hel"],
        ["hello", undefined, "lo"],
        ["lo\n\u00e9!", 9, "\n\u00e9!"],
      ] as const) {
        yield* fake.emit({
          type: "tool_execution_update",
          toolCallId: "shell-delta",
          toolName: "bash",
          partialResult: {
            content: [{ type: "text", text }],
            ...(totalBytes === undefined ? {} : { details: { truncation: { totalBytes } } }),
          },
        });
        const event = yield* takeEvent(
          (event) =>
            event.type === "command_output.delta" ||
            (event.type === "turn_item.updated" && event.turnItem.type === "command_execution"),
        );
        assert.equal(event.type, "command_output.delta");
        if (event.type === "command_output.delta") assert.equal(event.chunk, expected);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("classifies Pi notifications and keeps unknown notices at the legacy default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      for (const [notifyType, severity] of [
        ["info", "info"],
        ["warning", "warning"],
        ["error", "warning"],
        ["other", undefined],
        [undefined, undefined],
      ] as const) {
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "notice",
          ...(notifyType === undefined ? {} : { notifyType }),
        });
        const event = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        );
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "system_notice")
          return yield* Effect.die("Expected notice");
        assert.equal(event.turnItem.severity, severity);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("forks resumed sessions from another cwd into the runtime cwd", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = `${dir}/old.jsonl`;
      yield* fs.writeFileString(
        file,
        `${encodeJson({ type: "session", version: 3, id: "s", cwd: `${host.paths.cwd}-old` })}\n{}\n`,
      );
      const forkFile = "/fake/forked-into-worktree.jsonl";
      forkFake.queueState({ sessionFile: forkFile });
      fake.queueState({ sessionFile: "/fake/other-session.jsonl" });
      fake.queueState({ sessionFile: forkFile });
      const resumed = yield* runtime.resumeThread({
        providerThread: {
          ...thread,
          nativeThreadRef: { driver: PI_PROVIDER, nativeId: file, strength: "strong" },
        },
      });
      assert.equal(forkFake.lastSpawn().args.at(-1), file);
      assert.equal(
        fake.allRequests().findLast((request) => request.type === "switch_session")?.sessionPath,
        forkFile,
      );
      assert.equal(resumed.nativeThreadRef?.nativeId, forkFile);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  registerPiAsyncSubagentChecks({
    makeFakePi,
    openRuntime,
    startTurn,
    THREAD_ID,
    modelSelection,
    runtimePolicy,
    layerTest,
  });
  it.effect("attaches an initial session at startup without a redundant extension reload", () =>
    Effect.gen(function* () {
      const source = yield* makeFakePi;
      const { runtime: prior } = yield* openRuntime(source);
      const existing = yield* prior.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const fake = yield* makeFakePi;
      const session = "/fake/attached.jsonl";
      fake.queueState({ sessionFile: session });
      const adapter = yield* makeAdapter(fake);
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        initialNativeThreadId: session,
      });
      assert.include(fake.lastSpawn().args, "--session");
      assert.include(fake.lastSpawn().args, session);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: {
          ...existing,
          nativeThreadRef: { driver: PI_PROVIDER, nativeId: session, strength: "strong" },
        },
      });
      assert.equal(thread.nativeThreadRef?.nativeId, session);
      assert.isFalse(fake.allRequests().some((request) => request.type === "switch_session"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("keeps a resumed session already attached to the same file", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ sessionFile: thread.nativeThreadRef?.nativeId });
      yield* runtime.resumeThread({ providerThread: thread });
      assert.isFalse(fake.allRequests().some((request) => request.type === "switch_session"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("reserves the session while same-file registration reads state", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.takeRequest("get_state");
      fake.deferNextState();
      const registration = yield* runtime
        .resumeThread({ providerThread: thread })
        .pipe(Effect.forkChild);
      yield* fake.takeRequest("get_state");
      const overlapping = yield* startTurn(runtime, thread).pipe(Effect.result);
      assert.equal(overlapping._tag, "Failure");
      yield* fake.resolveDeferredState({ sessionFile: thread.nativeThreadRef?.nativeId });
      yield* Fiber.join(registration);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("recovers when a startup attachment exits before Pi accepts requests", () =>
    Effect.gen(function* () {
      const source = yield* makeFakePi;
      const { runtime: original } = yield* openRuntime(source);
      const thread = yield* original.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const failed = yield* makeFakePi;
      const replacement = yield* makeFakePi;
      let count = 0;
      const fake = {
        ...replacement,
        spawner: ChildProcessSpawner.make((command) => {
          count += 1;
          return count === 1 ? failed.spawner.spawn(command) : replacement.spawner.spawn(command);
        }),
      };
      yield* failed.closeStdout;
      const adapter = yield* makeAdapter(fake);
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        initialNativeThreadId: thread.nativeThreadRef!.nativeId!,
      });
      const resumed = yield* runtime.resumeThread({ providerThread: thread }).pipe(Effect.result);
      assert.equal(resumed._tag, "Success");
      assert.equal(count, 2);
      assert.notInclude(replacement.lastSpawn().args, "--session");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("buffers native work arriving before the attached session is registered", () =>
    Effect.gen(function* () {
      const source = yield* makeFakePi;
      const { runtime: prior } = yield* openRuntime(source);
      const thread = yield* prior.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const fake = yield* makeFakePi;
      fake.queueState({ sessionFile: thread.nativeThreadRef!.nativeId });
      const offers =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const adapter = yield* makeAdapter(fake, "", undefined, {
        offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
      });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: SESSION_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        initialNativeThreadId: thread.nativeThreadRef!.nativeId!,
      });
      const observed = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(observed, event)),
        Effect.forkScoped,
      );
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: "barrier",
        statusText: "ready",
      });
      const event = yield* Queue.take(observed);
      assert.isFalse(
        event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      yield* runtime.resumeThread({ providerThread: thread });
      const offer = yield* Queue.take(offers);
      assert.equal(offer.threadId, THREAD_ID);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect(
    "does not replace an attached session while its early native work awaits ownership",
    () =>
      Effect.gen(function* () {
        const source = yield* makeFakePi;
        const { runtime: prior } = yield* openRuntime(source);
        const thread = yield* prior.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const fake = yield* makeFakePi;
        fake.queueState({ sessionFile: thread.nativeThreadRef!.nativeId });
        const adapter = yield* makeAdapter(fake);
        const runtime = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
          initialNativeThreadId: thread.nativeThreadRef!.nativeId!,
        });
        const observed = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(observed, event)),
          Effect.forkScoped,
        );
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "barrier",
          statusText: "ready",
        });
        yield* Queue.take(observed);
        const other = {
          ...thread,
          nativeThreadRef: { ...thread.nativeThreadRef!, nativeId: "/fake/other.jsonl" },
        };
        const result = yield* runtime.resumeThread({ providerThread: other }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(fake.allRequests().some((request) => request.type === "switch_session"));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("passes the GOAT thread identity to Pi without an MCP session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* openRuntime(fake);
      assert.equal(fake.lastSpawn().env.GOAT_THREAD_ID, THREAD_ID);
      assert.equal(fake.lastSpawn().env.T3CODE_THREAD_ID, THREAD_ID); // goat-rename: legacy
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("attaches image preview paths to completed Pi reads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, thread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "read-image",
        toolName: "read",
        args: { path: "@/workspace/shot.png" },
        result: { content: [{ type: "text", text: "image" }] },
      });
      const event = yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
        return yield* Effect.die("Expected read item");
      assert.equal(event.turnItem.viewedImagePath, "/workspace/shot.png");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect.each(["settled", "abort", "runtime restart"] as const)(
    "retains the live session after extension handoff (%s)",
    (mode) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const thread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, thread);
        yield* fake.takeRequest("prompt");
        const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
        if (running.type !== "provider_turn.updated") return yield* Effect.die("Expected turn");
        yield* fake.emit({ type: "agent_start" });
        if (mode !== "settled") {
          fake.queueState({ sessionFile: "/fake/extension-child.jsonl" });
          yield* runtime.interruptTurn({
            providerThread: thread,
            providerTurnId: running.providerTurn.id,
            requestRuntimeRestart: mode === "runtime restart",
          });
        } else fake.queueState({ sessionFile: "/fake/extension-child.jsonl" });
        if (mode !== "runtime restart")
          yield* fake.emit({ type: "agent_settled", aborted: mode === "abort" });
        const idle = yield* takeEvent(
          (event) =>
            event.type === "provider_thread.updated" && event.providerThread.status === "idle",
        );
        if (idle.type !== "provider_thread.updated") return yield* Effect.die("Expected thread");
        assert.equal(idle.providerThread.nativeThreadRef?.nativeId, "/fake/extension-child.jsonl");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect("reapplies the selected model and thinking after native changes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const selection = {
        ...modelSelection("anthropic/model-a"),
        options: [{ id: "thinking", value: "high" }],
      };
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection,
        runtimePolicy,
      });
      yield* startTurn(runtime, thread, "anthropic/model-a", [], "first", selection);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");
      fake.queueState({ model: { provider: "openai", id: "model-b" }, thinkingLevel: "low" });
      yield* startTurn(runtime, thread, "anthropic/model-a", [], "next", selection, 2);
      yield* fake.takeRequest("prompt");
      assert.equal(fake.allRequests().filter((request) => request.type === "set_model").length, 2);
      assert.equal(
        fake.allRequests().filter((request) => request.type === "set_thinking_level").length,
        2,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
  it.effect.each([
    { aborted: false, expected: "failed" },
    { aborted: true, expected: "completed" },
  ] as const)(
    "reports failed manual compaction unless cancelled (aborted=$aborted)",
    ({ aborted, expected }) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const thread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, thread, "default", [], "/compact");
        yield* fake.takeRequest("compact");
        yield* fake.emit({ type: "compaction_start", reason: "manual" });
        yield* fake.emit({ type: "compaction_end", reason: "manual", result: null, aborted });
        yield* fake.emit({
          type: "response",
          command: "compact",
          success: false,
          error: "compaction failed",
        });
        const event = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.equal(event.type === "turn.terminal" ? event.status : undefined, expected);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
}
