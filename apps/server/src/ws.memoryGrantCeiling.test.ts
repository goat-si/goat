import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { enqueuePublicOrchestrationCommand } from "./ws.ts";

it.effect.each([
  ["dispatchCommand", "read"],
  ["dispatchCommand", "read_write"],
  ["launchThread", "read"],
  ["launchThread", "read_write"],
] as const)("%s rejects %s before entering a pending startup gate", ([route, ceiling]) =>
  Effect.gen(function* () {
    const gate = yield* ServerRuntimeStartup.makeCommandGate;
    let enqueues = 0;
    const executions = yield* Ref.make(0);
    const startup: Pick<ServerRuntimeStartup.ServerRuntimeStartup["Service"], "enqueueCommand"> = {
      enqueueCommand: (work) => {
        // Count entry itself, including eager calls which never execute.
        enqueues += 1;
        return gate.enqueueCommand(work);
      },
    };
    const input =
      route === "dispatchCommand"
        ? { type: "message.dispatch", memoryGrantCeiling: ceiling }
        : { projectId: "fixture", memoryGrantCeiling: ceiling };
    // Readiness is deliberately never signalled. Joining a rejected request
    // must finish here without a clock advance or readiness failure.
    const error = yield* enqueuePublicOrchestrationCommand(
      input,
      startup,
      Ref.update(executions, (count) => count + 1),
    ).pipe(Effect.flip);
    assert.equal(error._tag, "EnvironmentAuthorizationError");
    assert.equal(enqueues, 0);
    assert.equal(yield* Ref.get(executions), 0);
  }).pipe(Effect.scoped),
);

it.effect("valid public metadata enters the real gate and executes after readiness", () =>
  Effect.gen(function* () {
    const gate = yield* ServerRuntimeStartup.makeCommandGate;
    yield* gate.signalCommandReady;
    assert.equal(
      yield* enqueuePublicOrchestrationCommand(
        { memoryGrantCeiling: "none" },
        gate,
        Effect.succeed("accepted"),
      ),
      "accepted",
    );
  }).pipe(Effect.scoped),
);
