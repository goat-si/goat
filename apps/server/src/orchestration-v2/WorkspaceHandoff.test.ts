import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { captureRootRunTermination } from "./RunExecutionService.testkit.ts";

it.effect("completes the root run after a workspace handoff", () =>
  Effect.gen(function* () {
    const { finalEvents } = yield* captureRootRunTermination({
      key: "workspace-handoff",
      shouldFinalizeRun: () => Effect.succeed(true),
      hasWorkspaceMoved: () => Effect.succeed(true),
    });
    const statuses = (type: string) =>
      finalEvents.flatMap((event) =>
        event.type === type ? [(event.payload as { readonly status: string }).status] : [],
      );
    assert.deepEqual(statuses("run.updated"), ["waiting"]);
    assert.deepEqual(statuses("run-attempt.updated"), ["completed"]);
  }),
);

it.effect("keeps a Stop that commits while a workspace handoff completes the run", () =>
  Effect.gen(function* () {
    const stopped = yield* Ref.make(false);
    const { finalEvents, written } = yield* captureRootRunTermination({
      key: "stop-races-handoff",
      shouldFinalizeRun: () => Effect.succeed(true),
      hasWorkspaceMoved: () => Ref.set(stopped, true).pipe(Effect.as(true)),
      beforeTerminalWrite: (request) =>
        Ref.get(stopped).pipe(
          Effect.map((value) => !(value && request.unlessInterruptRequested !== undefined)),
        ),
    });
    const statuses = (type: string) =>
      finalEvents.flatMap((event) =>
        event.type === type ? [(event.payload as { readonly status: string }).status] : [],
      );
    assert.deepEqual(statuses("run.updated"), ["interrupted"]);
    assert.deepEqual(statuses("run-attempt.updated"), ["interrupted"]);
    assert.deepEqual(
      written.map((item) => item.type),
      ["run_interrupt_result"],
    );
  }),
);
