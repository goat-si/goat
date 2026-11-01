// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

const interceptSeeds = Effect.fn("test.interceptSeeds")(function* (
  collisions: number,
  unrelatedFailure = false,
) {
  const original = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const attempts: Array<{ pid: number; port: number; exited: boolean }> = [];
  const competitors: Array<{ port: number; server: NodeHttp.Server }> = [];
  let home = "";
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || command.options.env?.T3_TEST_SEED !== "1")
        return yield* original.spawn(command);
      assert.isTrue(
        attempts.every((attempt) => attempt.exited),
        "failed seed must exit before retry",
      );
      const port = Number(command.args[command.args.indexOf("--port") + 1]);
      assert.isAbove(port, 0);
      home = String(command.options.env.HOME);
      if (attempts.length < collisions) {
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve, reject) => {
                const listener = NodeHttp.createServer((_req, res) => res.end("competitor"));
                listener.once("error", reject);
                listener.listen(port, "127.0.0.1", () => resolve(listener));
              }),
          ),
          (listener) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  listener.close((error) => (error ? reject(error) : resolve()));
                  listener.closeAllConnections();
                }),
            ),
        );
        competitors.push({ port, server });
      }
      if (unrelatedFailure)
        yield* fs.writeFileString(`${home}/.test/serve-exit-1.2.2`, "3\nOld log: EADDRINUSE\n");
      const child = yield* original.spawn(command);
      const attempt = { pid: Number(child.pid), port, exited: false };
      attempts.push(attempt);
      return {
        ...child,
        exitCode: child.exitCode.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              attempt.exited = true;
            }),
          ),
        ),
      };
    }),
  );
  const fixture = makeProtocolFixture({
    live: true,
    nodeMode: true,
    kind: "managed",
    oldVersion: "1.2.2",
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const events = Effect.gen(function* () {
    return (yield* fs.readFileString(`${home}/.test/events`))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; pid?: number; port?: number });
  });
  const assertCompetitors = Effect.gen(function* () {
    for (const { port, server } of competitors) {
      assert.isTrue(server.listening);
      assert.equal(
        yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const request = NodeHttp.get(`http://127.0.0.1:${port}`, (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk) => {
                  body += chunk;
                });
                response.once("error", reject);
                response.once("end", () => resolve(body));
              });
              request.once("error", reject);
            }),
        ),
        "competitor",
      );
    }
  });
  return { fixture, attempts, competitors, events, assertCompetitors, original };
});

describe("SSH protocol fixture Node seeds", () => {
  it.live("retries one real seed bind collision after exit and preserves process identity", () =>
    Effect.gen(function* () {
      const h = yield* interceptSeeds(1);
      const f = yield* h.fixture;
      assert.lengthOf(h.attempts, 2);
      const events = yield* h.events;
      assert.lengthOf(
        events.filter((event) => event.type === "seed-bind-failure"),
        1,
      );
      assert.lengthOf(
        events.filter((event) => event.type === "start"),
        1,
      );
      assert.isTrue(h.attempts[0]!.exited);
      assert.equal(f.pid, h.attempts[1]!.pid);
      assert.equal(f.port, h.attempts[1]!.port);
      assert.notEqual(f.port, h.competitors[0]!.port);
      const record = JSON.parse(
        yield* f.fs.readFileString(`${f.home}/.goat/userdata/server-runtime.json`),
      );
      assert.equal(record.pid, f.pid);
      assert.equal(record.port, f.port);
      assert.equal(Number(yield* f.fs.readFileString(`${f.state}/pid`)), f.pid);
      assert.equal(Number(yield* f.fs.readFileString(`${f.state}/port`)), f.port);
      const ps = yield* h.original.spawn(
        ChildProcess.make("/bin/ps", ["-p", String(f.pid), "-o", "args="]),
      );
      const args = yield* ps.stdout.pipe(Stream.decodeText(), Stream.mkString);
      assert.equal(Number(yield* ps.exitCode), 0);
      assert.include(args, f.nodeEntry);
      assert.include(args, `--port ${f.port}`);
      yield* h.assertCompetitors;
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("bounds seed bind collisions at three exited children and preserves competitors", () =>
    Effect.gen(function* () {
      const h = yield* interceptSeeds(3);
      const result = yield* Effect.exit(h.fixture);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result))
        assert.include(Cause.pretty(result.cause), "exhausted 3 bind attempts");
      assert.lengthOf(h.attempts, 3);
      assert.isTrue(h.attempts.every((attempt) => attempt.exited));
      const events = yield* h.events;
      assert.lengthOf(
        events.filter((event) => event.type === "seed-bind-failure"),
        3,
      );
      assert.lengthOf(
        events.filter((event) => event.type === "start"),
        0,
      );
      yield* h.assertCompetitors;
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("does not retry an unrelated seed startup failure mentioning EADDRINUSE", () =>
    Effect.gen(function* () {
      const h = yield* interceptSeeds(0, true);
      const result = yield* Effect.exit(h.fixture);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result))
        assert.include(Cause.pretty(result.cause), "stdout ended before readiness");
      assert.lengthOf(h.attempts, 1);
      const events = yield* h.events;
      assert.lengthOf(
        events.filter((event) => event.type === "seed-bind-failure"),
        0,
      );
      assert.lengthOf(
        events.filter((event) => event.type === "start"),
        0,
      );
      assert.lengthOf(
        events.filter((event) => event.type === "serve-exit"),
        1,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
