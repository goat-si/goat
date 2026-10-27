import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as Startup from "./ChildOpenCodexStartup.ts";

const NO_SYSTEMD = "systemd not found. Run 'ocx start' under your process supervisor.";
const output = (code: number, stderr = "") => ({
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdout: "",
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** The startup service over a scripted ocx: each command answers from the script. */
const fixture = (script: {
  readonly service: ReturnType<typeof output>;
  readonly healthyAfter: number;
}) => {
  const calls: Array<string> = [];
  let healthChecks = 0;
  const runner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input.args[0] ?? "");
        if (input.args[0] === "health") {
          healthChecks++;
          return output(healthChecks > script.healthyAfter ? 0 : 1);
        }
        return script.service;
      }),
  });
  return { calls, layer: Startup.layer.pipe(Layer.provide(runner)) };
};
const start = (binaryPath: string, opencodexHome: string) =>
  Effect.flatMap(Startup.ChildOpenCodexStartup, (service) =>
    service.start({
      binaryPath,
      platform: "linux",
      opencodexHome,
      environment: {},
      authorize: Effect.void,
    }),
  );

it.layer(NodeServices.layer)("ChildOpenCodexStartup", (it) => {
  it.effect("starts an installed but stopped OpenCodex through its service", () =>
    Effect.gen(function* () {
      const f = fixture({ service: output(0), healthyAfter: 1 });
      yield* start("/fixture/ocx", "/fixture/home").pipe(Effect.provide(f.layer));
      expect(f.calls).toEqual(["health", "service", "health"]);
    }),
  );

  it.effect(
    "falls back to detached startup only for the exact unsupported Linux manager signal",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "child-startup-" });
        const binary = path.join(dir, "ocx");
        yield* fs.writeFileString(binary, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(binary, 0o755);
        const f = fixture({ service: output(1, NO_SYSTEMD), healthyAfter: 1 });
        yield* start(binary, path.join(dir, "home")).pipe(Effect.provide(f.layer));
        expect(yield* fs.exists(path.join(dir, "home", "goat-start.log"))).toBe(true);
      }),
  );

  it.effect("refuses detached fallback after a service ownership or permission failure", () =>
    Effect.gen(function* () {
      const f = fixture({ service: output(1, "permission denied"), healthyAfter: 99 });
      const result = yield* start("/fixture/ocx", "/fixture/home").pipe(
        Effect.provide(f.layer),
        Effect.result,
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "service_failed" } });
      expect(f.calls).toEqual(["health", "service"]);
    }),
  );

  it.effect("withholds membership when service startup never becomes healthy", () =>
    Effect.gen(function* () {
      const f = fixture({ service: output(0), healthyAfter: 99 });
      const fiber = yield* start("/fixture/ocx", "/fixture/home").pipe(
        Effect.provide(f.layer),
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("20 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "health_timeout" } });
      expect(f.calls.filter((call) => call === "health")).toHaveLength(21);
    }),
  );

  it("recognizes only OpenCodex's exact no-service-manager answers", () => {
    expect(Startup.noUsableServiceManager("linux", output(1, NO_SYSTEMD))).toBe(true);
    expect(Startup.noUsableServiceManager("darwin", output(1, NO_SYSTEMD))).toBe(false);
    expect(Startup.noUsableServiceManager("linux", output(2, NO_SYSTEMD))).toBe(false);
    expect(Startup.noUsableServiceManager("linux", output(1, `${NO_SYSTEMD} extra`))).toBe(false);
  });
});
