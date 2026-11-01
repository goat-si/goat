import { driverError } from "./DesktopDriverReplies.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { ScreenTargetRef } from "@goat/contracts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { ScreenHostBridge } from "./ScreenHostBridge.ts";
import { createScreenDispatchRouter } from "./ScreenDispatchRouter.ts";
import { active, harness, CONTROL } from "../cua/ComputerUseLeaseProxy.testkit.ts";
import { call, context, fixture, UnknownOutcome } from "./DesktopTargetHost.testkit.ts";
const isScreenTargetRef = Schema.is(ScreenTargetRef);

it.effect.each(["outer stop", "nested stop"])(
  "desktop replies merge terminal codes when %s",
  (order) =>
    Effect.gen(function* () {
      const outer = order === "outer stop" ? "stopped_by_person" : "screen_locked";
      const nested = order === "outer stop" ? "screen_locked" : "stopped_by_person";
      const { host } = fixture({
        list_apps: new UnknownOutcome({ code: outer, refusal: { code: nested } }),
      });
      const result = yield* host.discover(call("list_apps"), context).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("stopped_by_person");
        expect(result.failure.safety?.retryClass).toBe("never");
      }
    }),
);

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

import { terminalFailure as probeTerminalFailure } from "../cua/ComputerUseTerminal.ts";
it.effect.each(["stopped_by_person", "screen_locked"] as const)(
  "round6 post-read keeps terminal %s",
  (reason) =>
    Effect.gen(function* () {
      const base = fixture();
      let stopped = false;
      let refusedReads = 0;
      const host = createDesktopTargetHost({
        leases: base.leases,
        platform: "darwin",
        primitiveChannel: {
          ...base.channel,
          request: (request) => {
            if (stopped) {
              refusedReads++;
              const failure = probeTerminalFailure(
                { reason, possibleCommit: false },
                request.tool,
                request.args,
              );
              if (failure === undefined) return Effect.die("expected terminal failure");
              return Effect.fail(failure);
            }
            return base.channel.request(request).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (request.tool === "click") stopped = true;
                }),
              ),
            );
          },
        },
      });
      const bound = yield* host.bindApp(
        {
          ...call("bind_app", { bundle_id: "org.example.Editor", window_id: 7 }),
          deadlineMillis: 30000,
        },
        context,
      );
      if (!isScreenTargetRef(bound.value)) return yield* Effect.die("expected bound target");
      const result = yield* host
        .invoke(
          { ...call("click", { x: 1, y: 2, verify: true }, bound.value), deadlineMillis: 30000 },
          context,
        )
        .pipe(Effect.result);
      expect(refusedReads).toBeGreaterThan(0);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe(reason);
        expect(result.failure.safety?.possibleCommit).toBe(true);
        expect(result.failure.safety?.retryClass).toBe("never");
      }
    }),
);

it.effect("a terminal unknown outcome preserves reported possible input", () =>
  Effect.gen(function* () {
    const { host } = fixture({
      list_apps: new UnknownOutcome({
        code: "stopped_by_person",
        detail: "screen_locked",
        refused: "screenLocked",
        safety: { possibleCommit: true, retryClass: "never" },
      }),
    });
    const result = yield* host.discover(call("list_apps"), context).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("stopped_by_person");
      expect(result.failure.safety?.retryClass).toBe("never");
      expect(result.failure.safety?.possibleCommit).toBe(true);
      expect(result.failure.effectStarted).toBe(true);
    }
  }),
);

it("terminal driver errors retain possible input from the replaced reply", () => {
  const reply: import("@goat/contracts").ComputerUsePrimitiveReply = {
    requestId: "request",
    registrationId: "registration",
    controlId: "control",
    connectionGeneration: "g",
    runId: "r",
    turnId: "t",
    callId: 1,
    status: "settled",
    result: {
      isError: true,
      structuredContent: {
        code: "stopped_by_person",
        safety: { possibleCommit: true, retryClass: "never" },
      },
    },
  };
  const error = driverError(reply);
  expect(error?.code).toBe("stopped_by_person");
  expect(error?.safety?.possibleCommit).toBe(true);
  expect(error?.safety?.retryClass).toBe("never");
});
