import { assert, it } from "@effect/vitest";
import { ProviderSessionId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import {
  captureRootRunTermination,
  rootTerminalEvent,
  driver,
} from "./RunExecutionService.testkit.ts";

it.effect.each(["interrupted", "cancelled"] as const)(
  "records unknown for an unrequested provider %s terminal",
  (status) =>
    Effect.gen(function* () {
      const { finalEvents } = yield* captureRootRunTermination({
        key: `unrequested:${status}`,
        shouldFinalizeRun: () => Effect.succeed(true),
        events: (ids) => Stream.make(rootTerminalEvent(ids, status)),
      });
      assert.equal(
        finalEvents.find((event) => event.type === "run.updated")?.payload.terminationCause?.kind,
        "unknown",
      );
    }),
);

it.effect("records quota for a classified provider failure", () =>
  Effect.gen(function* () {
    const { finalEvents } = yield* captureRootRunTermination({
      key: "quota-cause",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: (ids) =>
        Stream.make({
          ...rootTerminalEvent(ids, "failed"),
          failure: { class: "usage_limit", message: "Limit", code: null, retryable: null },
        } as ProviderAdapter.ProviderAdapterV2Event),
    });
    assert.equal(
      finalEvents.find((event) => event.type === "run.updated")?.payload.terminationCause?.kind,
      "quota",
    );
  }),
);

it.effect("emits run_interrupt_result when hard-stop finalizes the active attempt", () =>
  Effect.gen(function* () {
    const { written, observed, committedEffects, finalEvents } = yield* captureRootRunTermination({
      key: "hard-stop",
      shouldFinalizeRun: () => Effect.succeed(true),
      // The reason the Stop request recorded; an agent's Stop must not read as the user's.
      loadRunInterruptReason: () => Effect.succeed("Stopped by an agent: done"),
    });
    assert.deepEqual(
      written.map((item) => [item.type, "message" in item ? item.message : undefined]),
      [["run_interrupt_result", "Stopped by an agent: done"]],
    );
    assert.deepEqual(observed, ["run:interrupted", "pull-requests-refreshed"]);
    assert.equal(
      finalEvents.find((event) => event.type === "run.updated")?.payload.terminationCause?.kind,
      "agent_stop",
    );
    assert.deepEqual(
      committedEffects.map((effect) => effect.request.type),
      ["checkpoint.capture"],
    );
  }),
);

it.effect("records marked provider process exit from stream failure", () =>
  Effect.gen(function* () {
    const { finalEvents } = yield* captureRootRunTermination({
      key: "marked-process-exit",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:marked-process-exit"),
            source: "provider_process_exit",
          }),
        ),
    });
    assert.equal(
      finalEvents.find((event) => event.type === "run.updated")?.payload.terminationCause?.kind,
      "provider_process_exit",
    );
  }),
);

it.effect("refreshes pull requests after a provider stream exits with an error", () =>
  Effect.gen(function* () {
    const { written, observed, finalEvents } = yield* captureRootRunTermination({
      key: "pull-request-refresh:stream-error",
      shouldFinalizeRun: () => Effect.succeed(true),
      events: () =>
        Stream.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver,
            providerSessionId: ProviderSessionId.make("session:exited"),
            cause: "provider process exited",
          }),
        ),
    });
    assert.deepEqual(observed, ["run:failed", "pull-requests-refreshed"]);
    assert.equal(
      finalEvents.find((event) => event.type === "run.updated")?.payload.terminationCause?.kind,
      "provider_error",
    );
    assert.deepEqual(
      written.map((item) => item.type),
      ["error"],
    );
    const error = written.find((item) => item.type === "error");
    assert.include(error?.failure.message ?? "", "provider event stream closed unexpectedly");
  }),
);
