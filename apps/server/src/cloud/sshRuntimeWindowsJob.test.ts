// @effect-diagnostics nodeBuiltinImport:off - Exercises the native process handle and socket lifetime boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SshRuntimeAutoUpdate from "./sshRuntimeAutoUpdate.ts";
import { windowsJobCommand } from "./sshRuntimeWindowsJob.ts";

// quarantine: #612 Native Job Object ownership must also run in the coordinated Windows slot.
describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("Windows runtime jobs", () => {
  it("keeps the detached job alive after its launching process exits", async () => {
    const connection = Promise.withResolvers<NodeNet.Socket>();
    await using server = NodeNet.createServer((socket) => connection.resolve(socket));
    server.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const owned = await windowsJobCommand({
      command: process.execPath,
      args: [
        "-e",
        `
        const socket = require('node:net').connect(${address.port}, '127.0.0.1');
        socket.on('connect', () => socket.write('ready'));
        socket.once('data', () => socket.end('survived'));
      `,
      ],
      env: process.env,
    });
    let socket: NodeNet.Socket | undefined;
    let watcher: NodeChildProcess.ChildProcess | undefined;
    const owner = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `
      const child = require('node:child_process').spawn(${JSON.stringify(owned.command)}, ${JSON.stringify(owned.args)}, {
        detached: true, windowsHide: true, stdio: 'ignore'
      });
      child.unref();
      process.send({ pid: child.pid }, () => process.exit(0));
    `,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const ownerClosed = NodeEvents.EventEmitter.once(owner, "close");
    try {
      const [message] = await NodeEvents.EventEmitter.once(owner, "message");
      const jobPid = Number(message.pid);
      expect(Number.isSafeInteger(jobPid) && jobPid > 0).toBe(true);
      const script = `$p = [Diagnostics.Process]::GetProcessById(${jobPid}); $null = $p.Handle; [Console]::Out.WriteLine('watching'); if ([Console]::In.ReadLine() -eq 'kill') { $p.Kill() }; $p.WaitForExit(); $p.Dispose()`;
      watcher = NodeChildProcess.spawn(
        NodePath.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      const watched = NodeEvents.EventEmitter.once(watcher.stdout!, "data");
      const watcherClosed = NodeEvents.EventEmitter.once(watcher, "close");
      socket = await connection.promise;
      socket.on("error", (error) => {
        if (!("code" in error) || error.code !== "ECONNRESET") throw error;
      });
      expect((await NodeEvents.EventEmitter.once(socket, "data"))[0].toString()).toBe("ready");
      // Reading the socket after the owner has exited proves a live command, not just a PID.
      await ownerClosed;
      await watched;
      const response = NodeEvents.EventEmitter.once(socket, "data");
      socket.write("finish");
      const [bytes] = await response;
      expect(bytes.toString()).toBe("survived");
      watcher.stdin!.end("wait\n");
      expect((await watcherClosed)[0]).toBe(0);
    } finally {
      if (watcher !== undefined && watcher.exitCode === null) {
        const closed = NodeEvents.EventEmitter.once(watcher, "close");
        watcher.stdin?.end("kill\n");
        await closed;
      }
      if (owner.exitCode === null) owner.kill();
      await ownerClosed;
      socket?.destroy();
      await owned.dispose();
    }
  });

  it.live("forwards stdin, arguments, stdout, stderr and the command's exit code", () =>
    Effect.gen(function* () {
      const host = yield* SshRuntimeAutoUpdate.SshRuntimeHost;
      const argument = 'a quoted "argument" with spaces and a trailing slash\\';
      const stdin = "한글 input\nsecond line\n";
      const result = yield* host.run({
        command: process.execPath,
        args: [
          "-e",
          `
          let text = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', chunk => { text += chunk; });
          process.stdin.on('end', () => {
            process.stdout.write(JSON.stringify({ argument: process.argv[1], text }));
            process.stderr.write('command stderr');
            process.exitCode = 3;
          });
        `,
          argument,
        ],
        stdin,
        env: { ...process.env },
        timeoutMs: 30_000,
      });
      expect(result).toEqual({
        code: 3,
        stdout: JSON.stringify({ argument, text: stdin }),
        stderr: "command stderr",
      });
    }).pipe(Effect.provide(SshRuntimeAutoUpdate.layerHost)),
  );

  it.live.each(["timeout", "interruption"] as const)(
    "%s closes orphan pipes after the command exits without stopping an unrelated child",
    (mode) =>
      Effect.gen(function* () {
        const sockets = new Set<NodeNet.Socket>();
        const parentExited = Promise.withResolvers<void>();
        const orphanReady = Promise.withResolvers<void>();
        const orphanClosed = Promise.withResolvers<void>();
        const unrelatedReady = Promise.withResolvers<NodeNet.Socket>();
        const server = NodeNet.createServer((socket) => {
          sockets.add(socket);
          let owned = false;
          // Windows resets these sockets when their owning process exits or its job is killed.
          // The close milestones and unrelated-child assertions still establish who stopped.
          socket.on("error", (error) => {
            if (!owned || !("code" in error) || error.code !== "ECONNRESET") throw error;
          });
          socket.once("data", (data) => {
            switch (data.toString()) {
              case "parent":
                owned = true;
                socket.once("close", () => parentExited.resolve());
                break;
              case "orphan":
                owned = true;
                socket.once("close", () => orphanClosed.resolve());
                orphanReady.resolve();
                break;
              case "unrelated":
                unrelatedReady.resolve(socket);
                break;
            }
          });
        });
        let unrelated: NodeChildProcess.ChildProcess | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            vi.useRealTimers();
            for (const socket of sockets) socket.destroy();
            if (unrelated !== undefined && unrelated.exitCode === null) {
              const exited = new Promise<void>((resolve) =>
                unrelated?.once("exit", () => resolve()),
              );
              unrelated.kill();
              await exited;
            }
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
        const connection = `require('node:net').connect(${address.port}, '127.0.0.1')`;
        unrelated = NodeChildProcess.spawn(
          process.execPath,
          ["-e", `const s = ${connection}; s.on('connect', () => s.write('unrelated'));`],
          { stdio: "ignore" },
        );
        const unrelatedSocket = yield* Effect.promise(() => unrelatedReady.promise);
        const orphan = `
      const s = ${connection};
      s.on('connect', () => { s.write('orphan'); process.send('ready'); });
      process.stdout.write('orphan output\\n');
    `;
        const parent = `
      const s = ${connection};
      s.on('connect', () => {
        s.write('parent');
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(orphan)}], {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc']
        });
        child.once('message', () => process.exit(0));
      });
    `;
        // Advance only the timeout under test, after the parent has actually exited. Sockets
        // provide the milestones; no sleep or process-name lookup stands in for completion.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const host = yield* SshRuntimeAutoUpdate.SshRuntimeHost;
        let completed = false;
        const run = yield* host
          .run({
            command: process.execPath,
            args: ["-e", parent],
            env: { ...process.env },
            timeoutMs: 1000,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
            Effect.forkScoped,
          );
        yield* Effect.raceFirst(
          Effect.promise(() => parentExited.promise),
          Fiber.join(run).pipe(
            Effect.flatMap((result) =>
              Effect.die(new Error(`Command ended before parent exit: ${result.stderr}`)),
            ),
          ),
        );
        yield* Effect.promise(() => orphanReady.promise);
        expect(completed).toBe(false);
        if (mode === "timeout") {
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1000));
          const result = yield* Fiber.join(run);
          expect(result.code).not.toBe(0);
        } else {
          yield* Fiber.interrupt(run);
          expect(completed).toBe(false);
        }
        yield* Effect.promise(() => orphanClosed.promise);
        expect(unrelated.exitCode).toBeNull();
        expect(unrelatedSocket.destroyed).toBe(false);
      }).pipe(Effect.provide(SshRuntimeAutoUpdate.layerHost), Effect.scoped),
  );
});
