import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
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
      const { makeService, control, onManagerProbe } = yield* makeHarness();
      control.linger = "no";
      control.managerReachable = false;
      control.lingerStartsManager = false;
      const service = yield* makeService();
      const firstProbe = yield* Deferred.make<void>();
      let probes = 0;
      onManagerProbe.push(() => {
        probes++;
        if (probes === 2) Deferred.doneUnsafe(firstProbe, Effect.void);
        if (probes === 5) control.managerReachable = true;
      });
      const fiber = yield* service.install().pipe(Effect.forkChild);
      yield* Deferred.await(firstProbe);
      yield* TestClock.adjust(Duration.millis(1500));
      yield* Fiber.join(fiber);
      expect(probes).toBeGreaterThanOrEqual(5);
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
