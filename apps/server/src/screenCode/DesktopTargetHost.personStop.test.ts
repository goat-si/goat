import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { active, harness, CONTROL } from "../cua/ComputerUseLeaseProxy.testkit.ts";
import { call, context, fixture } from "./DesktopTargetHost.testkit.ts";

it.effect("Escape stays terminal through the desktop host while the stop report is pending", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const h = yield* harness({ personStop: true, personStopGate: gate });
    yield* h.push(active());
    const driver = yield* h.driverStarted;
    const base = fixture();
    const host = createDesktopTargetHost({
      leases: base.leases,
      primitiveChannel: {
        ...base.channel,
        request: () =>
          h
            .sendPrimitive({
              state: "primitive-request",
              requestId: "request:esc-host",
              registrationId: "registration:one",
              controlId: CONTROL,
              connectionGeneration: driver.connectionId,
              runId: "r",
              turnId: "t",
              callId: 1,
              deadlineMillis: 60000,
              tool: "list_apps",
              args: {},
            })
            .pipe(Effect.andThen(h.primitiveReply)),
      },
    });
    const bridge = new ScreenHostBridge();
    bridge.setDispatcher(createScreenDispatchRouter({ app: host }));
    const running = yield* bridge.handle(call("list_apps"), context).pipe(Effect.forkChild);
    yield* h.nextToDriver;
    yield* h.escape;
    yield* h.escapeReported;
    const answer = yield* Fiber.join(running);
    expect(answer?.outcome).toBe("error");
    if (answer?.outcome === "error") {
      expect(answer.error?.code).toBe("stopped_by_person");
      expect(answer.error?.safety?.retryClass).toBe("never");
      expect(answer.error?.nextStep).not.toMatch(/try again|retry/i);
    }
    yield* Deferred.succeed(gate, undefined);
  }),
);
