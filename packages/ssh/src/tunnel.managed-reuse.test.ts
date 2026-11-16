import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, it, beforeEach, afterEach, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { REMOTE_RUNTIME_STATE_KEY } from "./command.ts";
import * as SshTunnel from "./tunnel.ts";
import baseline from "./fixtures/remote-runner-baseline.json" with { type: "json" };
import {
  remoteShell,
  makeSuccessfulProcess,
  ARCHIVE,
  uploadTarget,
  encoder,
  nativeScripts,
  installArchivePsDouble,
  isRemoteLaunch,
} from "./tunnel.fixture.ts";

// Archive acquisition stays local to these transport doubles.
beforeEach(() => vi.stubGlobal("fetch", async () => new Response(null, { status: 404 })));
afterEach(() => vi.unstubAllGlobals());

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("runtime preparation", () => {
  it.live("does not restart an existing managed server after runtime preparation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-managed-preparation-" });
      const runtime = `${root}/.goat/runtime/goat/versions/${ARCHIVE.archiveVersion}`;
      const state = `${root}/.goat/ssh-launch/${REMOTE_RUNTIME_STATE_KEY}`;
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.makeDirectory(state, { recursive: true });
      const cli = `${runtime}/goat`;
      yield* fs.writeFileString(
        cli,
        `#!${process.execPath}
import * as fs from "node:fs";
import * as net from "node:net";
import * as http from "node:http";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("goat v${ARCHIVE.archiveVersion}"); }
else if (args[0] === "__ssh-helper") {
  if (args[1] === "protocol") {
    if (!args.includes("--runtime-file")) console.log("${ARCHIVE.archiveVersion} ${SSH_RUNTIME_PROTOCOL_VERSION} ${ORCHESTRATION_PROTOCOL_VERSION} 0 0");
    else {
            const at = args.indexOf("--runtime-file");
      const value = await (await import(${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)})).readLiveSshRuntimeProtocol(args[at+1]);
      console.log((value.status+" ") + [value.serverVersion ?? "unknown",value.sshRuntimeProtocolVersion ?? "unknown",value.orchestrationProtocolVersion ?? "unknown",value.pid ?? 0,value.port ?? 0].join(" "));
    }
  }
  if (args[1] === "runtime-port") process.exit(1);
  if (args[1] === "pick-port") console.log(3773);
  if (args[1] === "wait-ready") {
    const request = http.get("http://127.0.0.1:"+args[2]+"/",response=>{response.resume();response.on("end",()=>process.exit(0));});
    request.on("error",()=>process.exit(1));
  }
} else if (args[0] === "auth") { console.log(JSON.stringify({ credential: "fixture-pairing" })); }
else {
  fs.appendFileSync("${root}/starts", "start\\n");
  const fields = {serverVersion:"${ARCHIVE.archiveVersion}",sshRuntimeProtocolVersion:${SSH_RUNTIME_PROTOCOL_VERSION},orchestrationProtocolVersion:${ORCHESTRATION_PROTOCOL_VERSION}};
  const server = http.createServer((request,response) => response.end(["/.well-known/goat/environment", "/.well-known/t3/environment"].includes(request.url) ? JSON.stringify({environmentId:"fixture",label:"Fixture",platform:{os:"linux",arch:"x64"},capabilities:{},...fields}) : "ok"));
  process.on("SIGTERM", () => { fs.appendFileSync("${root}/stops", "stop\\n"); server.close(); });
  server.listen(0, "127.0.0.1", () => {
    const record = {version:1,startedAt:"2026-10-11T00:00:00.000Z",...fields,pid:process.pid,port:server.address().port,origin:"http://127.0.0.1:"+server.address().port};
    fs.mkdirSync("${root}/.goat/userdata",{recursive:true});fs.writeFileSync("${root}/.goat/userdata/server-runtime.json",JSON.stringify(record));
    console.log(JSON.stringify(record));
  });
}
`,
      );
      yield* fs.chmod(cli, 0o700);
      yield* fs.writeFileString(`${runtime}/.install-complete`, ARCHIVE.archiveVersion);
      const child = yield* realSpawner.spawn(
        ChildProcess.make(cli, ["serve"], { detached: false }),
      );
      yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore));
      const started = JSON.parse(
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.take(1),
          Stream.mkString,
        ),
      ) as { pid: number; port: number };
      assert.equal(started.pid, child.pid);
      yield* fs.writeFileString(`${state}/pid`, `${started.pid}\n`);
      yield* fs.writeFileString(`${state}/port`, `${started.port}\n`);
      yield* fs.writeFileString(`${state}/managed`, "managed\n");
      yield* fs.writeFileString(
        `${state}/identity`,
        `${cli} serve --host 127.0.0.1 --port ${started.port} --base-dir ${root}/.goat\n`,
      );
      yield* installArchivePsDouble(root, started.pid, started.port, ARCHIVE.archiveVersion);
      // Use the persisted heredoc bytes, including existing placeholder escaping.
      const persistedRunner =
        baseline.archive.launch.split("<<'SH'\n")[1]!.split("\nSH\n")[0]! + "\n";
      yield* fs.writeFileString(`${state}/run-t3.sh`, persistedRunner);
      yield* fs.chmod(`${state}/run-t3.sh`, 0o700);
      const scripts = yield* nativeScripts(ARCHIVE);
      let uploads = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return Effect.succeed(makeSuccessfulProcess(""));
        const args = command.args;
        if (args.includes("-c")) uploads++;
        const remoteArgs = args.slice(args.indexOf("sh") + 1).filter((arg) => arg !== "-l");
        const stdin = isRemoteLaunch(args)
          ? Stream.make(encoder.encode(scripts.launch))
          : args.includes("-l")
            ? command.options.stdin
            : Stream.make(encoder.encode(scripts.pairing));
        return realSpawner.spawn(
          ChildProcess.make(remoteShell, remoteArgs, {
            env: { HOME: root, PATH: `${root}/.test/identity-bin:${process.env.PATH ?? ""}` },
            stdin,
          }),
        );
      });
      const runner = { ...ARCHIVE, archiveDirectory: `${root}/missing` };
      yield* Effect.gen(function* () {
        const first = yield* SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner);
        if (first.status !== "ready") throw new Error("Expected a ready runtime");
        assert.equal(first.remotePort, started.port);
        assert.equal(first.remoteServerKind, "managed");
        const pairing = yield* SshTunnel.issueRemotePairingToken(uploadTarget, {}, runner);
        assert.equal(pairing.credential, "fixture-pairing");
        const second = yield* SshTunnel.launchOrReuseRemoteServer(uploadTarget, {}, runner);
        if (second.status !== "ready") throw new Error("Expected a ready runtime");
        assert.equal(second.remotePort, started.port);
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(uploads, 0);
      assert.equal(yield* fs.readFileString(`${state}/run-t3.sh`), persistedRunner);
      assert.equal((yield* fs.readFileString(`${state}/pid`)).trim(), String(started.pid));
      assert.equal((yield* fs.readFileString(`${state}/port`)).trim(), String(started.port));
      assert.equal(yield* fs.readFileString(`${root}/starts`), "start\n");
      assert.isFalse(yield* fs.exists(`${root}/stops`));
      assert.isTrue(yield* fs.exists(`${root}/.goat/userdata/server-runtime.json`));
      assert.isTrue(yield* child.isRunning);
      yield* child.kill({ killSignal: "SIGTERM" });
      assert.equal(yield* child.exitCode, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
