import { RunAttemptId } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { vi } from "vite-plus/test";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { CaptureEventQueue } from "./ClaudeAdapterV2.observations.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";
import { claudeSdkFrame, WAKE_NATIVE_SESSION } from "./ClaudeWakeFrames.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";

vi.mock("effect/Queue", async (importOriginal) => {
  const actual = await importOriginal<typeof Queue>();
  return {
    ...actual,
    take: <A, E>(queue: Queue.Dequeue<A, E>) =>
      Effect.gen(function* () {
        const capture = yield* CaptureEventQueue;
        if (capture !== undefined && actual.isEnqueue<unknown, never>(queue)) {
          yield* capture((marker) => actual.offer(queue, marker));
        }
        return yield* actual.take(queue);
      }),
  };
});

it("asks about tools Claude sends back in Auto", () => {
  assert.deepEqual(
    ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "auto",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    ),
    { permissionMode: "auto", installPermissionCallback: true },
  );
});

it.effect.each([
  { reported: "auto", when: "runs in Auto" },
  { reported: "default", when: "cannot run in Auto" },
] as const)("asks about a tool Claude sends back when the thread $when", ({ reported }) =>
  Effect.gen(function* () {
    const harness = yield* makeWakeHarnessWithOptions();
    const input = makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-auto-ask"),
      text: "Run git status.",
      attachments: [],
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "auto",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    });
    yield* harness.runtime.startTurn({
      ...input,
      appThread: { ...input.appThread, runtimeMode: "auto" },
    });
    const opened = harness.getOpenedOptions();
    assert.isDefined(opened);
    if (opened === undefined) return;
    assert.equal(opened.permissionMode, "auto");
    const canUseTool = opened.canUseTool;
    assert.isDefined(canUseTool);
    if (canUseTool === undefined) return;
    yield* harness.offerAndWait(
      claudeSdkFrame({
        type: "system",
        subtype: "init",
        permissionMode: reported,
        uuid: "auto-ask-init",
        session_id: WAKE_NATIVE_SESSION,
      }),
    );
    const decision = yield* Effect.promise(() =>
      canUseTool(
        "Bash",
        { command: "git status" },
        {
          signal: new AbortController().signal,
          toolUseID: "auto-ask-command",
          requestId: "request-auto-ask-command",
        },
      ),
    ).pipe(Effect.forkScoped);
    const first = yield* Effect.raceFirst(
      Queue.take(harness.runtimeRequestReceipts).pipe(
        Effect.map((event) => ({ type: "request", event }) as const),
      ),
      Fiber.join(decision).pipe(Effect.map((result) => ({ type: "decision", result }) as const)),
    );
    assert.equal(first.type, "request", "Auto answered a tool request without asking");
    if (first.type !== "request") return;
    assert.equal(first.event.runtimeRequest.kind, "command");
    yield* harness.runtime.respondToRuntimeRequest({
      requestId: first.event.runtimeRequest.id,
      decision: "decline",
    });
    assert.equal((yield* Fiber.join(decision))?.behavior, "deny");
  }).pipe(Effect.scoped, Effect.provide(layerClaudeAdapterTest)),
);
