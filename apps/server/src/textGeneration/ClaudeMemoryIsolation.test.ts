import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";

import { verifyClaudeMemoryHooks } from "./ClaudeMemoryIsolation.ts";

describe("Claude memory registry isolation", () => {
  it.effect.each([
    { scenario: "absent policy key", allowed: true },
    { scenario: "absent Policies parent", allowed: true },
    { scenario: "absent Settings value", allowed: true },
    { scenario: "managed hook", allowed: false },
    { scenario: "access denied", allowed: false },
    { scenario: "unreadable ancestor", allowed: false },
    { scenario: "malformed listing", allowed: false },
    { scenario: "unexpected exit code", allowed: false },
    { scenario: "reg.exe unavailable", allowed: false },
  ])("$scenario permits memory generation: $allowed", ({ scenario, allowed }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const queries: string[] = [];
      const spawner = lazyChildProcessSpawner((command) => {
        if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
        expect(command.command).toBe("reg.exe");
        const candidate = command.args[1]!;
        queries.push(candidate);
        if (scenario === "reg.exe unavailable")
          return Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                pathOrDescriptor: "reg.exe",
              }),
            ),
          );
        const fullKey = candidate
          .replace(/^HKLM/, "HKEY_LOCAL_MACHINE")
          .replace(/^HKCU/, "HKEY_CURRENT_USER");
        const header = `${fullKey}\n`;
        const valueOnly = command.args.includes("/v");
        let stdout = "";
        // Deliberately locale-neutral fixture: absence must follow the successful listing.
        let stderr = "synthetic registry failure";
        let code = scenario === "unexpected exit code" ? 2 : 1;
        if (scenario === "managed hook") {
          stdout = `${header}    Settings    REG_SZ    {"hooks":{"SessionStart":[]}}\n`;
          stderr = "";
          code = 0;
        } else if (
          !valueOnly &&
          scenario !== "unreadable ancestor" &&
          scenario !== "unexpected exit code"
        ) {
          const successful =
            scenario === "absent Settings value"
              ? fullKey.endsWith("\\ClaudeCode")
              : scenario === "absent Policies parent"
                ? fullKey.endsWith("\\SOFTWARE")
                : fullKey.endsWith("\\Policies");
          if (successful) {
            stdout =
              scenario === "malformed listing"
                ? "unexpected response"
                : `${header}${scenario === "access denied" ? `${fullKey}\\ClaudeCode\n` : ""}`;
            stderr = "";
            code = 0;
          }
        }
        const output = Stream.make(new TextEncoder().encode(stdout));
        const errors = Stream.make(new TextEncoder().encode(stderr));
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: output,
            stderr: errors,
            all: Stream.merge(output, errors),
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
      });
      const verification = verifyClaudeMemoryHooks("generateMemorySummary", {}).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: () => Effect.succeed(false),
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      if (allowed) {
        yield* verification;
        expect(queries).toContain("HKLM\\SOFTWARE\\Policies\\ClaudeCode");
        expect(queries).toContain("HKCU\\SOFTWARE\\Policies\\ClaudeCode");
      } else {
        const failure = yield* Effect.flip(verification);
        expect(failure.cause).toMatchObject({ code: "unavailable" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
