import { makeTurnInput } from "./AcpAdapterV2.testkit.ts";
import { makeMockRuntime, bundledMockAgentPath } from "./AcpMockRuntime.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "@goat/provider-acp/server/adapter";
import { layerTest, ACP_TEST_DRIVER } from "./AcpAdapterV2.host.testkit.ts";

describe("AcpAdapterV2 prompt outcome resume", () => {
  it.live("resends a resumable outcome failure's prompt once before failing the turn", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("acp-test-prompt-resume");
      const threadId = ThreadId.make("thread-acp-prompt-resume");
      const notFound = {
        class: "provider_error",
        message: "Requested entity was not found.",
        code: "NOT_FOUND",
        retryable: true,
      } as const;
      const promptTexts: Array<string> = [];
      // Checks 1, 3 and 4 fail: turn 1 resumes and completes, turn 2 fails after one resume.
      let checks = 0;
      const adapter = yield* makeAcpAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ACP_TEST_DRIVER,
          capabilities: AcpProviderCapabilitiesV2,
          steersWithPrompt: () => true,
          watchPromptOutcome: () =>
            Effect.sync(() => {
              checks += 1;
              const outcome =
                checks === 2 ? undefined : { failure: notFound, resumeWith: "continue" };
              return () => Effect.succeed(outcome);
            }),
          makeRuntime: makeMockRuntime({
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            mockAgentPath: yield* bundledMockAgentPath,
            wrapRuntime: (runtime) => ({
              ...runtime,
              prompt: (payload) =>
                Effect.sync(() => {
                  promptTexts.push(
                    payload.prompt
                      .flatMap((block) => (block.type === "text" ? [block.text] : []))
                      .join("\n"),
                  );
                  return { stopReason: "end_turn" as const };
                }),
            }),
          }),
        },
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-prompt-resume"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const runTurn = (ordinal: number) =>
        Effect.gen(function* () {
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now: yield* DateTime.now,
              ordinal,
            }),
          );
          return Array.from(
            yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            ),
          );
        });
      const retryStatuses = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
        events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.retry !== undefined
            ? [event.turnItem.status]
            : [],
        );

      const resumed = yield* runTurn(1);
      const completed = resumed.at(-1);
      assert.equal(completed?.type === "turn.terminal" ? completed.status : null, "completed");
      assert.deepEqual(promptTexts.slice(1), ["continue"]);
      assert.deepEqual(retryStatuses(resumed), ["running", "completed"]);

      const failedEvents = yield* runTurn(2);
      const failed = failedEvents.at(-1);
      if (failed?.type !== "turn.terminal" || failed.status !== "failed") {
        return assert.fail("expected a failed terminal");
      }
      assert.deepEqual(failed.failure, notFound);
      assert.deepEqual(promptTexts.slice(3), ["continue"], "a turn resumes only once");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
