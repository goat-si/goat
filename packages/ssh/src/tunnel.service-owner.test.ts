import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/process";
import { tryAcquireServerOwnerLock } from "../../../apps/server/src/serverOwnerLockFile.ts";
import { ARCHIVE } from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

it.live(
  "does not start a second server when a boot service owns the home but never becomes ready",
  () =>
    Effect.gen(function* () {
      const f = yield* makeProtocolFixture({
        live: false,
        kind: "managed",
        oldVersion: ARCHIVE.archiveVersion,
        ssh: SSH_RUNTIME_PROTOCOL_VERSION,
        orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        nodeMode: true,
      });
      yield* f.fs.writeFileString(`${f.home}/.goat/runtime/service-serving.lock`, "fixture");
      const source = yield* f.fs.readFileString(f.nodeEntry);
      const needle = 'if (args[0] === "--version") {';
      assert.include(source, needle);
      yield* f.fs.writeFileString(
        f.nodeEntry,
        source.replace(
          needle,
          'if (args[0] === "__ssh-helper" && args[1] === "home-owned") process.exit(0); else ' +
            needle,
        ),
      );
      yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
      yield* f.fs.writeFileString(`${f.test}/identity-bin/sleep`, "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.include(String(result.failure), "no second server was started");
      const events = yield* f.fs.readFileString(`${f.test}/events`);
      assert.notInclude(events, '"args":["serve"');
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("adopts the old service successor after its own launch loses the home", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    yield* f.fs.writeFileString(
      `${f.test}/serve-exit-${ARCHIVE.archiveVersion}`,
      "78\nAnother GOAT server owns this home\n",
    );
    yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
    yield* f.fs.writeFileString(
      `${f.test}/identity-bin/sleep`,
      `#!/bin/sh
if grep -q '"type":"serve-exit"' "$HOME/.test/events" && [ ! -e "$HOME/.test/successor-started" ]; then
  : > "$HOME/.test/successor-started"
  rm "$HOME/.test/serve-exit-${ARCHIVE.archiveVersion}"
  '${f.old}/goat' serve >/dev/null 2>&1 </dev/null &
  IFS= read -r ready < "$HOME/.test/ready.fifo"
fi
exit 0
`,
      { mode: 0o755 },
    );
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
    assert.isTrue(yield* f.fs.exists(`${f.test}/successor-started`));
    if (Result.isSuccess(result)) assert.equal(result.success.status, "ready");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("reports an ongoing update after the bounded wait without starting a server", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    yield* f.fs.writeFileString(`${f.home}/.goat/runtime/service-update-handoff.json`, "fixture");
    const source = yield* f.fs.readFileString(f.nodeEntry);
    const needle = 'if (args[0] === "--version") {';
    yield* f.fs.writeFileString(
      f.nodeEntry,
      source.replace(
        needle,
        'if (args[0] === "__ssh-helper" && args[1] === "home-owned") { console.log("updating"); process.exit(0); } else ' +
          needle,
      ),
    );
    yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
    yield* f.fs.writeFileString(`${f.test}/identity-bin/sleep`, "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result))
      assert.include(String(result.failure), "Remote GOAT is updating; retry");
    const events = yield* f.fs.readFileString(`${f.test}/events`);
    assert.notInclude(events, '"args":["serve"');
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("waits through an active update and attaches its ready successor", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    yield* f.fs.writeFileString(`${f.home}/.goat/runtime/service-update-handoff.json`, "fixture");
    const source = yield* f.fs.readFileString(f.nodeEntry);
    const needle = 'if (args[0] === "--version") {';
    const probe =
      'if (args[0] === "__ssh-helper" && args[1] === "home-owned") { if (fs.existsSync(path.join(test, "active-update"))) { console.log("updating"); process.exit(0); } process.exit(fs.existsSync(runtimeFile) ? 0 : 1); } else ';
    yield* f.fs.writeFileString(f.nodeEntry, source.replace(needle, probe + needle));
    yield* f.fs.writeFileString(`${f.test}/active-update`, "active");
    yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
    yield* f.fs.writeFileString(
      `${f.test}/identity-bin/sleep`,
      `#!/bin/sh
if [ -e "$HOME/.test/active-update" ]; then
  '${f.old}/goat' serve >/dev/null 2>&1 </dev/null &
  IFS= read -r ready < "$HOME/.test/ready.fifo"
  rm "$HOME/.test/active-update"
fi
exit 0
`,
      { mode: 0o755 },
    );
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
    assert.isFalse(yield* f.fs.exists(`${f.test}/active-update`));
    if (Result.isSuccess(result)) assert.equal(result.success.status, "ready");
    const events = (yield* f.fs.readFileString(`${f.test}/events`))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "start").length, 1);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("preserves all successor ownership records when the failed launch loses them", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    const source = yield* f.fs.readFileString(f.nodeEntry);
    const serve = '} else if (args[0] === "serve") {';
    const barrier = `} else if (args[0] === "serve") {
event("race-held");
const barrier = fs.openSync(path.join(test, "owner-race.fifo"), "r");
fs.readSync(barrier, Buffer.alloc(1), 0, 1, null); fs.closeSync(barrier);`;
    assert.include(source, serve);
    yield* f.fs.writeFileString(f.nodeEntry, source.replace(serve, barrier));
    yield* f.fs.writeFileString(
      `${f.test}/serve-exit-${ARCHIVE.archiveVersion}`,
      "78\nAnother GOAT server owns this home\n",
    );
    const fifo = yield* f.realSpawner.spawn(
      ChildProcess.make("mkfifo", [`${f.test}/owner-race.fifo`]),
    );
    assert.equal(Number(yield* fifo.exitCode), 0);
    yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
    yield* f.fs.writeFileString(
      `${f.test}/identity-bin/sleep`,
      `#!/bin/sh
if grep -q '"type":"race-held"' "$HOME/.test/events" && [ ! -e "$HOME/.test/changed-records" ]; then
  : > "$HOME/.test/changed-records"
  printf '9876\\n' > "$HOME/.goat/ssh-launch/runtime/pid"
  printf '54321\\n' > "$HOME/.goat/ssh-launch/runtime/port"
  printf 'managed\\n' > "$HOME/.goat/ssh-launch/runtime/managed"
  printf 'successor identity\\n' > "$HOME/.goat/ssh-launch/runtime/identity"
  printf x > "$HOME/.test/owner-race.fifo"
fi
exit 0
`,
      { mode: 0o755 },
    );
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isFailure(result));
    assert.isTrue(yield* f.fs.exists(`${f.test}/changed-records`));
    for (const [name, expected] of [
      ["pid", "9876\n"],
      ["port", "54321\n"],
      ["managed", "managed\n"],
      ["identity", "successor identity\n"],
    ] as const) {
      assert.equal(yield* f.fs.readFileString(`${f.state}/${name}`), expected);
    }
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("refuses to start when home ownership cannot be inspected", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    yield* f.fs.writeFileString(`${f.home}/.goat/runtime/service-serving.lock`, "fixture");
    const source = yield* f.fs.readFileString(f.nodeEntry);
    const needle = 'if (args[0] === "--version") {';
    yield* f.fs.writeFileString(
      f.nodeEntry,
      source.replace(
        needle,
        'if (args[0] === "__ssh-helper" && args[1] === "home-owned") { console.log("inspection-error"); process.exit(2); } else ' +
          needle,
      ),
    );
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result))
      assert.include(String(result.failure), "Cannot inspect GOAT home ownership");
    assert.notInclude(yield* f.fs.readFileString(`${f.test}/events`), '"args":["serve"');
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("starts a server when the home is free", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
    if (Result.isSuccess(result)) assert.equal(result.success.status, "ready");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("adopts the boot successor that wins the real generation lock", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: SSH_RUNTIME_PROTOCOL_VERSION,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    yield* f.fs.makeDirectory(`${f.home}/.goat/userdata`, { recursive: true });
    const lockUrl = new URL("../../../apps/server/src/serverOwnerLockFile.ts", import.meta.url)
      .href;
    const serve = '} else if (args[0] === "serve") {';
    const client = yield* f.fs.readFileString(f.nodeEntry);
    const held = `} else if (args[0] === "serve") {
event("race-held");
const barrier = fs.openSync(path.join(test, "owner-race.fifo"), "r");
fs.readSync(barrier, Buffer.alloc(1), 0, 1, null); fs.closeSync(barrier);
const own = (await import(${JSON.stringify(lockUrl)})).tryAcquireServerOwnerLock(path.join(home, ".goat/userdata"), "ssh-race");
if (!own) { event("lock-refused"); console.error("Another GOAT server is using this home"); process.exit(78); }`;
    assert.include(client, serve);
    yield* f.fs.writeFileString(f.nodeEntry, client.replace(serve, held));
    const oldEntry = `${f.old}/goat`;
    const old = yield* f.fs.readFileString(oldEntry);
    const claim = `} else if (args[0] === "serve") {
const own = (await import(${JSON.stringify(lockUrl)})).tryAcquireServerOwnerLock(path.join(home, ".goat/userdata"), "service-race");
if (!own) { console.error("service failed to acquire ownership"); process.exit(78); }
globalThis.raceLock = own;`;
    yield* f.fs.writeFileString(oldEntry, old.replace(serve, claim));
    const fifo = yield* f.realSpawner.spawn(
      ChildProcess.make("mkfifo", [`${f.test}/owner-race.fifo`]),
    );
    assert.equal(Number(yield* fifo.exitCode), 0);
    yield* f.fs.makeDirectory(`${f.test}/identity-bin`, { recursive: true });
    yield* f.fs.writeFileString(
      `${f.test}/identity-bin/sleep`,
      `#!/bin/sh
if grep -q '"type":"race-held"' "$HOME/.test/events" && [ ! -e "$HOME/.test/successor-started" ]; then
  : > "$HOME/.test/successor-started"
  '${f.old}/goat' serve >/dev/null 2>&1 </dev/null &
  IFS= read -r ready < "$HOME/.test/ready.fifo"
  printf x > "$HOME/.test/owner-race.fifo"
fi
exit 0
`,
      { mode: 0o755 },
    );
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isSuccess(result), String(Result.isFailure(result) && result.failure));
    if (Result.isSuccess(result)) assert.equal(result.success.status, "ready");
    const events = yield* f.fs.readFileString(`${f.test}/events`);
    assert.include(events, '"type":"lock-refused"');
    const competing = tryAcquireServerOwnerLock(`${f.home}/.goat/userdata`, "other-owner");
    competing?.release();
    assert.isUndefined(competing);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);

it.live("rejects an incompatible candidate before asking it about home ownership", () =>
  Effect.gen(function* () {
    const f = yield* makeProtocolFixture({
      live: false,
      kind: "managed",
      oldVersion: ARCHIVE.archiveVersion,
      ssh: 99,
      orchestration: ORCHESTRATION_PROTOCOL_VERSION,
      nodeMode: true,
    });
    yield* f.fs.writeFileString(`${f.home}/.goat/runtime/service-serving.lock`, "fixture");
    const source = yield* f.fs.readFileString(f.nodeEntry);
    const needle = 'if (args[0] === "--version") {';
    yield* f.fs.writeFileString(
      f.nodeEntry,
      source.replace(
        needle,
        'if (args[0] === "__ssh-helper" && args[1] === "home-owned") { event("bad-home-probe"); process.exit(1); } else ' +
          needle,
      ),
    );
    const result = yield* f.run("launch", false, { nodeScriptPath: f.nodeEntry });
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.include(String(result.failure), "incompatible");
    const events = yield* f.fs.readFileString(`${f.test}/events`);
    assert.notInclude(events, '"type":"bad-home-probe"');
    assert.notInclude(events, '"args":["serve"');
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
);
