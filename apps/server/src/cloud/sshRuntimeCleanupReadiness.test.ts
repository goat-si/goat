// @effect-diagnostics nodeBuiltinImport:off - Holds a real native cleanup process at its readiness boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Runtime from "./sshRuntimeAutoUpdate.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// quarantine: #612 Uses actual Windows PowerShell compilation, Job membership, and retained process HANDLEs.
describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("cleanup before readiness", () => {
  it.live.each(["interruption", "timeout"] as const)(
    "owns the held cleanup process across outer %s",
    (mode) =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-readiness-")),
          ),
          (root) =>
            Effect.promise(() => NodeFS.promises.rm(root, { recursive: true, force: true })),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            vi.stubEnv("TEMP", root);
            vi.stubEnv("TMP", root);
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          }),
          () =>
            Effect.sync(() => {
              vi.useRealTimers();
              vi.unstubAllEnvs();
            }),
        );
        const held = Promise.withResolvers<number>();
        const gateClosed = Promise.withResolvers<void>();
        let gateSocket: NodeNet.Socket | undefined;
        const server = NodeNet.createServer((socket) => {
          gateSocket = socket;
          socket.on("error", (error) => {
            if (!("code" in error) || error.code !== "ECONNRESET") held.reject(error);
          });
          socket.once("close", () => gateClosed.resolve());
          socket.once("data", (data) => held.resolve(Number(data.toString())));
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            gateSocket?.destroy();
            await server[Symbol.asyncDispose]();
          }),
        );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", resolve);
            }),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Expected TCP address");
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeChildProcess>("node:child_process"),
        );
        let artifact: string | undefined;
        using _spawn = vi
          .spyOn(NodeChildProcess, "spawn")
          .mockImplementation((command, args, options) => {
            if (command.endsWith("supervisor.exe")) artifact = command;
            if (
              command.toLowerCase().endsWith("powershell.exe") &&
              args?.includes("-EncodedCommand")
            ) {
              const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
              const payload = /FromBase64String\('([^']+)'\)/u.exec(script)?.[1];
              if (script.includes("Add-Type") && payload !== undefined) {
                const source = Buffer.from(payload, "base64").toString("utf8");
                const milestone = "[Console]::Out.WriteLine('ready');";
                if (!source.includes(milestone))
                  throw new Error("Cleanup readiness boundary not found");
                const gate = `$gate = New-Object Net.Sockets.TcpClient('127.0.0.1', ${address.port}); $stream = $gate.GetStream(); $bytes = [Text.Encoding]::UTF8.GetBytes([string]$PID); $stream.Write($bytes, 0, $bytes.Length); $null = $stream.ReadByte(); $gate.Dispose(); `;
                const gated = Buffer.from(source.replace(milestone, gate + milestone)).toString(
                  "base64",
                );
                const encoded = Buffer.from(script.replace(payload, gated), "utf16le").toString(
                  "base64",
                );
                return actual.spawn(command, [...args.slice(0, -1), encoded], options);
              }
            }
            return actual.spawn(command, args ?? [], options);
          });
        const marker = NodePath.join(root, "command-started");
        const host = yield* Runtime.SshRuntimeHost;
        const run = yield* host
          .run({
            command: process.execPath,
            args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
            env: { ...process.env },
            timeoutMs: 30_000,
          })
          .pipe(Effect.forkScoped);
        const cleanupPid = yield* Effect.raceFirst(
          Effect.promise(() => held.promise),
          Fiber.join(run).pipe(
            Effect.flatMap((result) =>
              Effect.die(new Error(`Command ended before cleanup gate: ${result.stderr}`)),
            ),
          ),
        );
        expect(Number.isSafeInteger(cleanupPid) && cleanupPid > 0).toBe(true);
        const watcherScript = `$ErrorActionPreference = 'Stop'; $p = [Diagnostics.Process]::GetProcessById(${cleanupPid}); $null = $p.Handle; [Console]::Out.WriteLine('watching'); $null = [Console]::In.ReadLine(); [Console]::Out.WriteLine($p.WaitForExit(5000)); if ([Console]::In.ReadLine() -eq 'stop' -and -not $p.HasExited) { $p.Kill() }; $p.WaitForExit(); $p.Dispose()`;
        const watcher = actual.spawn(
          NodePath.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(watcherScript, "utf16le").toString("base64"),
          ],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        const watcherClosed = NodeEvents.EventEmitter.once(watcher, "close");
        const watching = NodeEvents.EventEmitter.once(watcher.stdout!, "data");
        try {
          expect((yield* Effect.promise(() => watching))[0].toString().trim()).toBe("watching");
          if (mode === "timeout") {
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_000));
          } else run.interruptUnsafe();
          const observation = NodeEvents.EventEmitter.once(watcher.stdout!, "data");
          watcher.stdin!.write("probe\n");
          // The native wait is a failure watchdog, not a sleep or a scheduling workaround.
          expect((yield* Effect.promise(() => observation))[0].toString().trim()).toBe("True");
          if (mode === "timeout") expect((yield* Fiber.join(run)).code).not.toBe(0);
          else yield* Fiber.await(run);
          expect(NodeFS.existsSync(marker)).toBe(false);
          expect(artifact).toBeDefined();
          expect(NodeFS.existsSync(NodePath.dirname(artifact!))).toBe(false);
          yield* Effect.promise(() => gateClosed.promise);
        } finally {
          // On RED only, stop the exact still-held process after the reclamation assertion failed.
          watcher.stdin!.end("stop\n");
          yield* Effect.promise(() => watcherClosed);
          yield* Fiber.interrupt(run);
        }
      }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
  );
});
