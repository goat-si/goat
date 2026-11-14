import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeHarness } from "./bootService.testkit.ts";

it.layer(NodeServices.layer)("boot service user manager", (it) => {
  it.effect("does not reach a running root user manager under sudo", () =>
    Effect.gen(function* () {
      const { makeService, commands, control } = yield* makeHarness();
      control.busNeedsRuntimeDir = true;
      const service = yield* makeService(undefined, "1.2.3", undefined, false, undefined, true);
      expect(yield* service.install().pipe(Effect.flip)).toMatchObject({
        _tag: "BootServicePrerequisiteError",
        problem: "user-manager-unavailable",
      });
      expect(commands).not.toContain("systemctl --user enable goat.service");
    }),
  );

  it.effect("starts the user manager after three probes", () =>
    Effect.gen(function* () {
      const { makeService, control } = yield* makeHarness();
      control.linger = "no";
      control.managerReachable = false;
      control.lingerStartsManager = false;
      const service = yield* makeService();
      const clock = yield* Clock.Clock;
      const firstPause = yield* Deferred.make<void>();
      const waited: number[] = [];
      const fiber = yield* service.install().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          // Recorded when it ends, so a timeout that loses its race is not counted as a pause.
          sleep: (duration) =>
            Deferred.succeed(firstPause, undefined).pipe(
              Effect.andThen(clock.sleep(duration)),
              Effect.andThen(
                Effect.sync(() => {
                  if (waited.push(Duration.toMillis(duration)) === 3)
                    control.managerReachable = true;
                }),
              ),
            ),
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(firstPause);
      yield* TestClock.adjust(Duration.millis(1500));
      yield* Fiber.join(fiber);
      expect(waited).toEqual([500, 500, 500]);
      expect((yield* service.status).current).toBe(true);
    }),
  );

  it.effect("passes the runtime directory to all systemd user commands", () =>
    Effect.gen(function* () {
      const { service, invocations, makeService } = yield* makeHarness();
      yield* service.install();
      const inside = yield* makeService(undefined, "1.2.4", undefined, true);
      yield* inside.install({ allowDowngrade: true });
      const calls = invocations.filter(({ command }) =>
        ["systemctl", "busctl", "systemd-run", "loginctl"].includes(command),
      );
      expect(new Set(calls.map(({ command }) => command)).size).toBe(4);
      expect(calls.filter(({ env }) => env?.XDG_RUNTIME_DIR !== "/run/user/501")).toEqual([]);
    }),
  );
});
