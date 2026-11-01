// @effect-diagnostics nodeBuiltinImport:off -- A separate OS process must be SIGKILLed without running Effect finalizers.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeFS from "node:fs";
import {
  makeOwnedSshTunnelCommand,
  OWNER_PIPE_SUPERVISOR,
  ownedAuthDirectory,
} from "./tunnelOwner.ts";
import { assert, describe, expect, it } from "@effect/vitest";

describe("owned auth directory", () => {
  it("deletes only GOAT's per-forward askpass temp directory", () => {
    assert.equal(
      ownedAuthDirectory(
        "/var/folders/x/T/goat-ssh-runtime-a1B2/t3code-ssh-askpass/ssh-askpass.sh",
      ),
      "/var/folders/x/T/goat-ssh-runtime-a1B2",
    );
    assert.equal(ownedAuthDirectory(undefined), "");
    assert.equal(ownedAuthDirectory("/usr/libexec/ssh-askpass"), "");
    assert.equal(
      ownedAuthDirectory("/Users/jo/.goat/desktop/t3code-ssh-askpass/ssh-askpass.sh"),
      "",
    );
  });
});

const listen = (server: NodeNet.Server, port = 0) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("SSH owner lifetime", () => {
  it("reaps the pipe watcher when ssh exits and preserves its exit status", async () => {
    const command = makeOwnedSshTunnelCommand(
      HostProcess.Platform.defaultValue(),
      process.execPath,
      ["-e", "process.exit(23)"],
      { forceKillAfter: 2000 },
    );
    const child = NodeChildProcess.spawn(command.command, command.args, {
      detached: command.options.detached,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const [code] = await NodeEvents.EventEmitter.once(child, "close", {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(code, 23);
    } finally {
      if (child.exitCode === null && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }
  });
  // gracefulFirst: the owner began its own SIGTERM teardown (signalling the whole group) and
  // died inside the grace period, while ssh ignored SIGTERM.
  it.each([
    { role: "forward", gracefulFirst: false },
    { role: "forward", gracefulFirst: true },
    { role: "master", gracefulFirst: false },
    { role: "master", gracefulFirst: true },
  ])(
    "kills the $role and releases its socket and auth directory when the owner is SIGKILLed; gracefulFirst=$gracefulFirst",
    async ({ role, gracefulFirst }) => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-owner-death-"));
      const authDirectory = NodePath.join(directory, "auth");
      await NodeFSP.mkdir(authDirectory);
      const control = NodeNet.createServer();
      await listen(control);
      const address = control.address();
      assert.isNotNull(address);
      if (typeof address !== "object" || address === null)
        throw new Error("Missing control listener");
      const script = NodePath.join(directory, "ssh.cjs");
      await NodeFSP.writeFile(
        script,
        `
const net = require("node:net");
process.on("SIGTERM", () => {});
const server = net.createServer();
server.listen(${role === "master" ? JSON.stringify(NodePath.join(authDirectory, "control")) : '0, "127.0.0.1"'}, () => {
  console.log(typeof server.address() === "string" ? server.address() : server.address().port);
  net.connect(${address.port}, "127.0.0.1");
});
`,
      );
      const moduleUrl = new URL("./tunnelOwner.ts", import.meta.url).href;
      const servicesUrl = new URL(
        "../node_modules/@effect/platform-node/dist/NodeServices.js",
        import.meta.url,
      ).href;
      const effectUrl = new URL("../node_modules/effect/dist/Effect.js", import.meta.url).href;
      const streamUrl = new URL("../node_modules/effect/dist/Stream.js", import.meta.url).href;
      const spawnerUrl = new URL(
        "../node_modules/effect/dist/process/ChildProcessSpawner.js",
        import.meta.url,
      ).href;
      const ownerScript = `
import * as NodeServices from ${JSON.stringify(servicesUrl)};
import * as Effect from ${JSON.stringify(effectUrl)};
import * as Stream from ${JSON.stringify(streamUrl)};
import * as ChildProcessSpawner from ${JSON.stringify(spawnerUrl)};
import { makeOwnedSshTunnelCommand } from ${JSON.stringify(moduleUrl)};
const command = makeOwnedSshTunnelCommand(process.platform, process.execPath,
  ${JSON.stringify([script, ...(role === "master" ? ["-M", "-N", "-S", NodePath.join(authDirectory, "control")] : ["-N", "-L", "fixture"])])}, { forceKillAfter: 2000 }, ${JSON.stringify(authDirectory)});
Effect.runPromise(Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  process.send({ pid: Number(child.pid) });
  yield* child.stdout.pipe(Stream.runForEach(chunk => Effect.sync(() => process.stdout.write(chunk))));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
`;
      const owner = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "-e", ownerScript],
        {
          stdio: ["pipe", "pipe", "inherit", "ipc"],
        },
      );
      const lines = NodeReadline.createInterface({ input: owner.stdout! });
      let supervisorPid: number | undefined;
      let connection: NodeNet.Socket | undefined;
      let verified = false;
      try {
        const signal = AbortSignal.timeout(5_000);
        const message = NodeEvents.EventEmitter.once(owner, "message", { signal });
        const portLine = NodeEvents.EventEmitter.once(lines, "line", { signal });
        const connected = NodeEvents.EventEmitter.once(control, "connection", { signal });
        const [identity] = await message;
        supervisorPid = (identity as { pid: number }).pid;
        const [port] = await portLine;
        [connection] = (await connected) as [NodeNet.Socket];
        const closed = NodeEvents.EventEmitter.once(connection, "close", { signal });
        const ownerExited = NodeEvents.EventEmitter.once(owner, "exit", { signal });
        if (gracefulFirst) process.kill(-supervisorPid, "SIGTERM");
        owner.kill("SIGKILL");
        await ownerExited;
        // Socket closure is an OS notification of forward death, not a polling loop.
        await closed;
        await expect(NodeFSP.stat(authDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        const replacement = NodeNet.createServer();
        if (role === "master") {
          await NodeFSP.mkdir(authDirectory);
          await new Promise<void>((resolve, reject) => {
            replacement.once("error", reject);
            replacement.listen(String(port), resolve);
          });
        } else await listen(replacement, Number(port));
        await new Promise<void>((resolve) => replacement.close(() => resolve()));
        verified = true;
      } finally {
        owner.kill("SIGKILL");
        try {
          if (!verified && supervisorPid !== undefined) {
            // Failure cleanup only: successful teardown already proved this group stopped.
            try {
              process.kill(-supervisorPid, "SIGKILL");
            } catch (error) {
              assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
            }
          }
        } finally {
          connection?.destroy();
          lines.close();
          await new Promise<void>((resolve) => control.close(() => resolve()));
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      }
    },
  );
});

// Every shell the supervisor may meet as /bin/sh: dash on Debian and Ubuntu, bash elsewhere.
const SHELLS = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((shell) => NodeFS.existsSync(shell));
// Stands in for ssh -N: ignores SIGTERM (reporting it) and holds a connection open until it dies.
const FAKE_SSH = `
const net = require("node:net");
process.on("SIGTERM", () => process.stdout.write("term\\n"));
const server = net.createServer((socket) => socket.write("alive\\n"));
server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
`;

async function startSupervisor(shell: string) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-owner-shell-"));
  const script = NodePath.join(directory, "ssh.cjs");
  await NodeFSP.writeFile(script, FAKE_SSH);
  const child = NodeChildProcess.spawn(
    shell,
    ["-c", OWNER_PIPE_SUPERVISOR, "goat-ssh-forward", "", process.execPath, script],
    { detached: true, stdio: ["pipe", "pipe", "inherit"] },
  );
  const signal = AbortSignal.timeout(5_000);
  const closed = NodeEvents.EventEmitter.once(child, "close", { signal });
  // Socket assertions run first; retain a close failure until the test awaits it.
  void closed.catch(() => undefined);
  const lines = NodeReadline.createInterface({ input: child.stdout! });
  const nextLine = async () =>
    (await NodeEvents.EventEmitter.once(lines, "line", { signal }))[0] as string;
  const port = Number(await nextLine());
  // A held connection closes exactly when the fake ssh dies.
  const socket = NodeNet.connect(port, "127.0.0.1");
  const greeting = NodeReadline.createInterface({ input: socket });
  assert.equal((await NodeEvents.EventEmitter.once(greeting, "line", { signal }))[0], "alive");
  const died = NodeEvents.EventEmitter.once(socket, "close", { signal });
  const cleanup = async (verified: boolean) => {
    socket.destroy();
    lines.close();
    try {
      if (!verified) {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
        }
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };
  return { child, nextLine, died, closed, cleanup };
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH owner supervisor shells",
  () => {
    it.each(SHELLS)(
      "keeps the forward while the owner holds the pipe, and ends it on EOF; %s",
      async (shell) => {
        const run = await startSupervisor(shell);
        let verified = false;
        try {
          run.child.stdin!.end();
          await run.died;
          await run.closed;
          verified = true;
        } finally {
          await run.cleanup(verified);
        }
      },
    );

    it.each(SHELLS)(
      "stays the fence through repeated SIGTERM to a resistant ssh; %s",
      async (shell) => {
        const run = await startSupervisor(shell);
        let verified = false;
        try {
          process.kill(run.child.pid!, "SIGTERM");
          assert.equal(await run.nextLine(), "term");
          process.kill(run.child.pid!, "SIGTERM");
          assert.equal(await run.nextLine(), "term");
          run.child.stdin!.end();
          await run.died;
          await run.closed;
          verified = true;
        } finally {
          await run.cleanup(verified);
        }
      },
    );

    // ssh's exit status must survive a SIGTERM whether it lands while the supervisor waits
    // (forwarded) or races ssh's own exit (before or after the supervisor's wait returns).
    it.each(
      SHELLS.flatMap((shell) => [
        {
          shell,
          signalFromTest: true,
          ssh: 'process.on("SIGTERM", () => process.exit(23)); console.log("up"); setInterval(() => {}, 1e9);',
        },
        {
          shell,
          signalFromTest: false,
          ssh: 'process.on("SIGTERM", () => {}); process.kill(process.ppid, "SIGTERM"); process.exit(23);',
        },
      ]),
    )(
      "reports ssh's own exit status around a SIGTERM; $shell signalFromTest=$signalFromTest",
      async ({ shell, ssh, signalFromTest }) => {
        const child = NodeChildProcess.spawn(
          shell,
          ["-c", OWNER_PIPE_SUPERVISOR, "goat-ssh-forward", "", process.execPath, "-e", ssh],
          { detached: true, stdio: ["pipe", "pipe", "inherit"] },
        );
        let verified = false;
        try {
          const signal = AbortSignal.timeout(5_000);
          const closed = NodeEvents.EventEmitter.once(child, "close", { signal });
          if (signalFromTest) {
            const lines = NodeReadline.createInterface({ input: child.stdout! });
            await NodeEvents.EventEmitter.once(lines, "line", { signal });
            process.kill(child.pid!, "SIGTERM");
          }
          const [code] = await closed;
          assert.equal(code, 23);
          verified = true;
        } finally {
          if (!verified) {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch (error) {
              assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
            }
          }
        }
      },
    );

    // Nothing outside the supervisor can land a signal between wait returning and the
    // interrupted check, so this one inserts it there.
    it.each(SHELLS)(
      "keeps ssh's status when SIGTERM lands just after wait returns; %s",
      async (shell) => {
        const marker = "  waited=$?\n";
        assert.include(OWNER_PIPE_SUPERVISOR, marker);
        const script = OWNER_PIPE_SUPERVISOR.replace(
          marker,
          () => marker + '  [ -n "$sent" ] || { sent=1; kill -TERM "$$"; }\n',
        );
        const child = NodeChildProcess.spawn(
          shell,
          ["-c", script, "goat-ssh-forward", "", process.execPath, "-e", "process.exit(23)"],
          { detached: true, stdio: ["pipe", "ignore", "inherit"] },
        );
        let verified = false;
        try {
          const [code] = await NodeEvents.EventEmitter.once(child, "close", {
            signal: AbortSignal.timeout(5_000),
          });
          assert.equal(code, 23);
          verified = true;
        } finally {
          if (!verified) {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch (error) {
              assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
            }
          }
        }
      },
    );
  },
);
