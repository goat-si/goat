// @effect-diagnostics nodeBuiltinImport:off -- symlinks, renames, chmod and mkfifo have no Effect API.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { CHANNEL_GATEWAY_WS_METHODS, ChannelGatewayError, EnvironmentId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ChannelBotArtifacts from "./ChannelBotArtifacts.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import * as ChannelBotNotesReader from "./ChannelBotNotesReader.ts";
import * as ChannelBotThreads from "./ChannelBotThreads.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";
import { channelBotWorkRpcHandlers } from "./channelBotWorkRpc.ts";
import { owner } from "./testkit/ChannelHarness.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const home = (requireHome: Effect.Effect<void, ChannelGatewayError>) =>
  Layer.succeed(
    ChannelBotHome.ChannelBotHome,
    ChannelBotHome.ChannelBotHome.of({
      requireHome,
      read: Effect.die("unused"),
      claimHere: () => Effect.die("unused"),
    }),
  );

const artifactsLayer = (
  options: ChannelBotArtifacts.ArtifactsOptions = {},
  requireHome: Effect.Effect<void, ChannelGatewayError> = Effect.void,
) =>
  Layer.effect(ChannelBotArtifacts.ChannelBotArtifacts, ChannelBotArtifacts.make(options)).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "goat-bot-artifacts-" }),
        home(requireHome),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const folders = Effect.gen(function* () {
  const path = yield* Path.Path;
  const state = (yield* ServerConfig.ServerConfig).stateDir;
  const root = channelBotFilesFor(path, state).artifacts;
  const outside = path.join(state, "outside");
  NodeFS.mkdirSync(root, { recursive: true });
  NodeFS.mkdirSync(outside, { recursive: true });
  NodeFS.writeFileSync(path.join(outside, "secret.txt"), "secret");
  return { path, root, outside, at: (...parts: Array<string>) => path.join(root, ...parts) };
});

const write = (file: string, content: string | Uint8Array, mtimeSeconds: number) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, content);
  NodeFS.utimesSync(file, mtimeSeconds, mtimeSeconds);
};

const service = ChannelBotArtifacts.ChannelBotArtifacts;
const read = (relativePath: string, offset?: number, version?: string) =>
  Effect.flatMap(service, (artifacts) =>
    artifacts.read({
      relativePath,
      ...(offset === undefined ? {} : { offset }),
      ...(version === undefined ? {} : { version }),
    }),
  );
const list = Effect.flatMap(service, (artifacts) => artifacts.list);
const reason = <A, R>(effect: Effect.Effect<A, ChannelGatewayError, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.reason);

/**
 * Holds the first `count` reads where the OS would answer. `started` settles once all of them
 * are held; `wentOn` counts those that ran past the hold instead of being abandoned.
 */
const holdFirst = (count: number, abandonable = false) => {
  const started = Deferred.makeUnsafe<void>();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let wentOn = 0;
  const wait = Effect.promise(() => gate).pipe(Effect.andThen(Effect.sync(() => wentOn++)));
  const hold = Effect.suspend(() => {
    calls += 1;
    if (calls > count) return Effect.void;
    const signal = calls === count ? Deferred.succeed(started, undefined) : Effect.void;
    // An OS read cannot end early; a path lookup's promise can be abandoned.
    return Effect.andThen(signal, abandonable ? wait : Effect.uninterruptible(wait));
  });
  return {
    hold,
    started: Deferred.await(started),
    release: Effect.sync(() => release()),
    wentOn: () => wentOn,
  };
};

/** A request's answer if it has one, without waiting for it. */
const statusOf = (fiber: Fiber.Fiber<{ readonly status: string }, unknown>) => {
  const exit = fiber.pollUnsafe();
  if (exit === undefined) return "no answer";
  return Exit.isSuccess(exit) ? exit.value.status : "failed";
};

describe("ChannelBotArtifacts list", () => {
  // Windows refuses colons and trailing spaces in names and needs elevated rights for symlinks.
  it.effect.skipIf(windowsHost)(
    "lists saved files newest first, leaves out hidden files, links and odd names, and opens each",
    () =>
      Effect.gen(function* () {
        const { root, outside, at } = yield* folders;
        NodeFS.mkdirSync(at("reports", "2026"), { recursive: true });
        write(at("old.txt"), "old", 1_700_000_000);
        write(at("reports", "2026", "new.md"), "new", 1_700_000_200);
        write(at("chart.png"), "png", 1_700_000_100);
        write(at(".hidden"), "x", 1_700_000_300);
        NodeFS.mkdirSync(at(".cache"));
        write(at(".cache", "inside.txt"), "x", 1_700_000_300);
        write(at("odd:name.txt"), "x", 1_700_000_300);
        write(at("trailing.txt "), "x", 1_700_000_300);
        NodeFS.symlinkSync(outside + "/secret.txt", at("link.txt"));
        NodeFS.symlinkSync(outside, at("linked-folder"));
        const result = yield* list;
        assert.isFalse(result.truncated);
        assert.deepStrictEqual(
          result.artifacts.map((artifact) => [artifact.relativePath, artifact.size]),
          [
            ["reports/2026/new.md", 3],
            ["chart.png", 3],
            ["old.txt", 3],
          ],
        );
        assert.strictEqual(result.artifacts[0]?.modifiedAt, "2023-11-14T22:16:40.000Z");
        assert.isTrue(NodeFS.existsSync(root));
        for (const artifact of result.artifacts) {
          assert.strictEqual((yield* read(artifact.relativePath)).status, "chunk");
        }
      }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect.skipIf(windowsHost)(
    "returns nothing for a missing folder or a folder that is itself a link",
    () =>
      Effect.gen(function* () {
        const { root, outside } = yield* folders;
        NodeFS.rmSync(root, { recursive: true });
        assert.deepStrictEqual(yield* list, { root, artifacts: [], truncated: false });
        NodeFS.symlinkSync(outside, root);
        assert.deepStrictEqual(yield* list, { root, artifacts: [], truncated: false });
        assert.strictEqual(yield* reason(read("secret.txt")), "not_found");
      }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect.skipIf(windowsHost)("reports a folder it may not read as a failure", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      NodeFS.mkdirSync(at("locked"));
      NodeFS.chmodSync(at("locked"), 0o000);
      const error = yield* reason(list);
      NodeFS.chmodSync(at("locked"), 0o700);
      assert.strictEqual(error, "persistence_failed");
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect.skipIf(windowsHost)("reports a file it may not look at as a failure", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("listed", "report.txt"), "x", 1_700_000_000);
      // Readable but not searchable: the name is listed, its details cannot be read.
      NodeFS.chmodSync(at("listed"), 0o444);
      const error = yield* reason(list);
      NodeFS.chmodSync(at("listed"), 0o700);
      assert.strictEqual(error, "persistence_failed");
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect("keeps the newest files and says the list is cut when there are more", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      for (let index = 0; index < 3; index++) write(at("f" + index), "x", 1_700_000_000 + index);
      const result = yield* list;
      assert.isTrue(result.truncated);
      assert.deepStrictEqual(
        result.artifacts.map((artifact) => artifact.relativePath),
        ["f2", "f1"],
      );
    }).pipe(Effect.provide(artifactsLayer({ bounds: { files: 2 } }))),
  );

  it.effect("says the list is cut when the depth or visit bound stops the walk", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      NodeFS.mkdirSync(at("a", "b", "c"), { recursive: true });
      write(at("a", "b", "c", "deep.txt"), "x", 1_700_000_000);
      const deep = yield* list;
      assert.isTrue(deep.truncated);
      assert.deepStrictEqual(deep.artifacts, []);
    }).pipe(Effect.provide(artifactsLayer({ bounds: { depth: 2 } }))),
  );

  it.effect("stops after the visit bound", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      for (let index = 0; index < 4; index++) write(at("f" + index), "x", 1_700_000_000 + index);
      const result = yield* list;
      assert.isTrue(result.truncated);
      assert.isAtMost(result.artifacts.length, 2);
    }).pipe(Effect.provide(artifactsLayer({ bounds: { visits: 2 } }))),
  );
});

describe("ChannelBotArtifacts read", () => {
  it.effect("returns a saved file's bytes and type", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("charts", "q3.png"), new Uint8Array([137, 80, 78, 71]), 1_700_000_000);
      const result = yield* read("charts/q3.png");
      assert.strictEqual(result.status, "chunk");
      if (result.status !== "chunk") return;
      assert.strictEqual(result.mimeType, "image/png");
      assert.strictEqual(result.bytesBase64, "iVBORw==");
      assert.deepStrictEqual([result.size, result.offset, result.done], [4, 0, true]);
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect("refuses any path that is not plainly inside the folder", () =>
    Effect.gen(function* () {
      yield* folders;
      for (const bad of [
        "../outside/secret.txt",
        "/etc/passwd",
        "a/../../outside/secret.txt",
        "a\\b.txt",
        "a\u0000b",
        "./a.txt",
        "a//b.txt",
        "C:secret.txt",
        "a.txt:stream",
      ]) {
        assert.strictEqual(yield* reason(read(bad)), "not_found", bad);
      }
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect.skipIf(windowsHost)("refuses a linked file and a file under a linked folder", () =>
    Effect.gen(function* () {
      const { outside, at } = yield* folders;
      NodeFS.symlinkSync(outside + "/secret.txt", at("link.txt"));
      NodeFS.symlinkSync(outside, at("linked-folder"));
      assert.strictEqual(yield* reason(read("link.txt")), "not_found");
      assert.strictEqual(yield* reason(read("linked-folder/secret.txt")), "not_found");
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect.skipIf(windowsHost)("refuses a file swapped for a link after it was checked", () => {
    const swap = { run: () => {} };
    return Effect.gen(function* () {
      const { outside, at } = yield* folders;
      write(at("report.txt"), "mine", 1_700_000_000);
      swap.run = () => {
        NodeFS.rmSync(at("report.txt"));
        NodeFS.symlinkSync(outside + "/secret.txt", at("report.txt"));
      };
      assert.strictEqual(yield* reason(read("report.txt")), "not_found");
    }).pipe(Effect.provide(artifactsLayer({ beforeOpen: Effect.sync(() => swap.run()) })));
  });

  it.effect.skipIf(windowsHost)(
    "refuses a file whose folder was moved out and linked back after it was checked",
    () => {
      const swap = { run: () => {} };
      return Effect.gen(function* () {
        const { outside, at } = yield* folders;
        write(at("docs", "secret.txt"), "mine", 1_700_000_000);
        // The file keeps its identity, so only the second walk sees the folder is now a link.
        swap.run = () => {
          NodeFS.renameSync(at("docs"), outside + "/docs");
          NodeFS.symlinkSync(outside + "/docs", at("docs"));
        };
        assert.strictEqual(yield* reason(read("docs/secret.txt")), "not_found");
      }).pipe(Effect.provide(artifactsLayer({ beforeOpen: Effect.sync(() => swap.run()) })));
    },
  );

  it.effect.skipIf(windowsHost)("refuses a FIFO without waiting for a writer", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      NodeChildProcess.execFileSync("mkfifo", [at("pipe")]);
      assert.strictEqual(yield* reason(read("pipe")), "not_found");
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect.skipIf(windowsHost)("reports a file it may not read as a failure", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("locked.txt"), "x", 1_700_000_000);
      NodeFS.chmodSync(at("locked.txt"), 0o000);
      assert.strictEqual(yield* reason(read("locked.txt")), "persistence_failed");
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect("reads a file of exactly the cap in chunks and refuses one byte more", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("ten.bin"), "0123456789", 1_700_000_000);
      write(at("eleven.bin"), "0123456789A", 1_700_000_000);
      const chunks: Array<string> = [];
      let offset = 0;
      let version: string | undefined;
      for (;;) {
        const result = yield* read("ten.bin", offset, version);
        assert.strictEqual(result.status, "chunk");
        if (result.status !== "chunk") return;
        chunks.push(NodeBuffer.Buffer.from(result.bytesBase64, "base64").toString());
        version = result.version;
        offset += 4;
        if (result.done) break;
      }
      assert.deepStrictEqual(chunks, ["0123", "4567", "89"]);
      assert.deepStrictEqual(yield* read("eleven.bin"), {
        status: "too_large",
        relativePath: "eleven.bin",
        size: 11,
        maxBytes: 10,
      });
    }).pipe(Effect.provide(artifactsLayer({ limits: { chunkBytes: 4, maxBytes: 10 } }))),
  );

  it.effect("answers changed when the file changed between chunks or no version was sent", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("log.txt"), "0123456789", 1_700_000_000);
      const first = yield* read("log.txt");
      assert.strictEqual(first.status, "chunk");
      if (first.status !== "chunk") return;
      assert.deepStrictEqual(yield* read("log.txt", 4), {
        status: "changed",
        relativePath: "log.txt",
      });
      write(at("log.txt"), "abcdefghij", 1_700_000_100);
      assert.deepStrictEqual(yield* read("log.txt", 4, first.version), {
        status: "changed",
        relativePath: "log.txt",
      });
    }).pipe(Effect.provide(artifactsLayer({ limits: { chunkBytes: 4, maxBytes: 10 } }))),
  );

  it.effect("answers changed when the file changes while a chunk is read", () => {
    const grow = { run: () => {} };
    return Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("live.txt"), "0123", 1_700_000_000);
      grow.run = () => NodeFS.appendFileSync(at("live.txt"), "more");
      assert.deepStrictEqual(yield* read("live.txt"), {
        status: "changed",
        relativePath: "live.txt",
      });
    }).pipe(Effect.provide(artifactsLayer({ afterRead: Effect.sync(() => grow.run()) })));
  });

  // Same inode, same length, mtime put back: only the change time can tell.
  const rewriteInPlace = (file: string) => {
    const fd = NodeFS.openSync(file, "r+");
    NodeFS.writeSync(fd, "abcd", 0);
    NodeFS.closeSync(fd);
    NodeFS.utimesSync(file, 1_700_000_000, 1_700_000_000);
  };

  it.effect("answers changed for a same-length rewrite whose time was put back", () => {
    const rewrite = { run: () => {} };
    return Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("same.txt"), "01234567", 1_700_000_000);
      const first = yield* read("same.txt");
      if (first.status !== "chunk") return assert.fail("expected a chunk");
      rewriteInPlace(at("same.txt"));
      assert.deepStrictEqual(yield* read("same.txt", 4, first.version), {
        status: "changed",
        relativePath: "same.txt",
      });
      rewrite.run = () => rewriteInPlace(at("same.txt"));
      assert.deepStrictEqual(yield* read("same.txt"), {
        status: "changed",
        relativePath: "same.txt",
      });
    }).pipe(
      Effect.provide(
        artifactsLayer({
          limits: { chunkBytes: 4, maxBytes: 10 },
          afterRead: Effect.sync(() => rewrite.run()),
        }),
      ),
    );
  });

  it.effect("ends a file cleanly at its size and refuses offsets past it", () =>
    Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("empty.txt"), "", 1_700_000_000);
      write(at("four.txt"), "0123", 1_700_000_000);
      const empty = yield* read("empty.txt");
      assert.deepStrictEqual(empty.status === "chunk" ? [empty.bytesBase64, empty.done] : empty, [
        "",
        true,
      ]);
      const first = yield* read("four.txt");
      if (first.status !== "chunk") return assert.fail("expected a chunk");
      const end = yield* read("four.txt", 4, first.version);
      assert.deepStrictEqual(end.status === "chunk" ? [end.bytesBase64, end.done] : end, [
        "",
        true,
      ]);
      assert.strictEqual(yield* reason(read("four.txt", 5, first.version)), "not_found");
    }).pipe(Effect.provide(artifactsLayer())),
  );

  it.effect("answers only on GOAT Bot's home machine", () =>
    Effect.gen(function* () {
      yield* folders;
      const notHome = new ChannelGatewayError({
        reason: "not_home",
        homeEnvironmentId: EnvironmentId.make("environment:home"),
      });
      assert.deepStrictEqual(
        yield* Effect.provide(
          Effect.all([reason(list), reason(read("a.txt"))]),
          artifactsLayer({}, Effect.fail(notHome)),
        ),
        ["not_home", "not_home"],
      );
    }).pipe(Effect.provide(artifactsLayer())),
  );
});

describe("ChannelBotArtifacts over a connection's handlers", () => {
  const handlersLayer = (options: ChannelBotArtifacts.ArtifactsOptions = {}) =>
    Layer.mergeAll(
      Layer.mock(ChannelBotThreads.ChannelBotThreads)({}),
      Layer.mock(ChannelBotNotesReader.ChannelBotNotesReader)({}),
    ).pipe(Layer.provideMerge(artifactsLayer(options)));

  it.effect(
    "serves both methods from the handlers a connection gets, the listing with its folder",
    () =>
      Effect.gen(function* () {
        const { path, root, at } = yield* folders;
        write(at("a.txt"), "hi", 1_700_000_000);
        const handlers = yield* channelBotWorkRpcHandlers(owner);
        const listed = yield* handlers[CHANNEL_GATEWAY_WS_METHODS.listBotArtifacts]({});
        assert.deepStrictEqual(
          listed.artifacts.map((artifact) => artifact.relativePath),
          ["a.txt"],
        );
        // The folder the worker brief names, so a client can match a full path against it.
        assert.strictEqual(listed.root, root);
        assert.isTrue(path.isAbsolute(root));
        const result = yield* handlers[CHANNEL_GATEWAY_WS_METHODS.readBotArtifact]({
          relativePath: "a.txt",
        });
        assert.strictEqual(result.status === "chunk" ? result.bytesBase64 : result.status, "aGk=");
      }).pipe(Effect.provide(handlersLayer())),
  );

  it.effect("answers busy to a second read on the same connection while one runs", () => {
    const held = Deferred.makeUnsafe<void>();
    const reading = Deferred.makeUnsafe<void>();
    const hold = Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(held)));
    return Effect.gen(function* () {
      const { at } = yield* folders;
      write(at("a.txt"), "hi", 1_700_000_000);
      const handlers = yield* channelBotWorkRpcHandlers(owner);
      const readA = handlers[CHANNEL_GATEWAY_WS_METHODS.readBotArtifact]({ relativePath: "a.txt" });
      const first = yield* Effect.forkChild(readA);
      yield* Deferred.await(reading);
      assert.deepStrictEqual(yield* readA, { status: "busy", relativePath: "a.txt" });
      yield* Deferred.succeed(held, undefined);
      assert.strictEqual((yield* Fiber.join(first)).status, "chunk");
    }).pipe(Effect.provide(handlersLayer({ afterRead: hold })));
  });

  /** A new connection's read method. */
  const connection = Effect.map(
    channelBotWorkRpcHandlers(owner),
    (handlers) => (relativePath: string) =>
      handlers[CHANNEL_GATEWAY_WS_METHODS.readBotArtifact]({ relativePath }),
  );

  it.effect(
    "a read its client interrupted frees the connection at once; the next read there gets a chunk",
    () => {
      const disk = holdFirst(1);
      return Effect.gen(function* () {
        const { at } = yield* folders;
        write(at("a.txt"), "hi", 1_700_000_000);
        const readHere = yield* connection;
        const first = yield* Effect.forkChild(readHere("a.txt"));
        yield* disk.started;
        // RpcServer ends a request this way on a client Interrupt or a closed socket.
        first.interruptUnsafe();
        assert.strictEqual((yield* readHere("a.txt")).status, "chunk");
      }).pipe(
        Effect.ensuring(disk.release),
        Effect.provide(handlersLayer({ afterRead: disk.hold })),
      );
    },
  );

  it.effect(
    "a read with no answer within 20 seconds answers busy, and the connection reads again",
    () => {
      const disk = holdFirst(1);
      return Effect.gen(function* () {
        const { at } = yield* folders;
        write(at("a.txt"), "hi", 1_700_000_000);
        const readHere = yield* connection;
        const first = yield* Effect.forkChild(readHere("a.txt"));
        yield* disk.started;
        yield* TestClock.adjust("19999 millis");
        assert.strictEqual(statusOf(first), "no answer");
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(statusOf(first), "busy");
        assert.strictEqual((yield* readHere("a.txt")).status, "chunk");
      }).pipe(
        Effect.ensuring(disk.release),
        Effect.provide(handlersLayer({ afterRead: disk.hold })),
      );
    },
  );

  it.effect(
    "two stuck reads hold both server slots; a third answers busy at the bound, and reads go on once the disk answers",
    () => {
      const disk = holdFirst(2);
      return Effect.gen(function* () {
        const { at } = yield* folders;
        write(at("a.txt"), "hi", 1_700_000_000);
        const stuck = [
          yield* Effect.forkChild((yield* connection)("a.txt")),
          yield* Effect.forkChild((yield* connection)("a.txt")),
        ];
        yield* disk.started;
        const third = yield* Effect.forkChild((yield* connection)("a.txt"));
        yield* TestClock.adjust("20 seconds");
        assert.deepStrictEqual([...stuck, third].map(statusOf), ["busy", "busy", "busy"]);
        yield* disk.release;
        assert.strictEqual((yield* (yield* connection)("a.txt")).status, "chunk");
      }).pipe(
        Effect.ensuring(disk.release),
        Effect.provide(handlersLayer({ afterRead: disk.hold })),
      );
    },
  );

  it.effect(
    "a read whose path lookup is stuck keeps its server slot past the bound until the lookup ends",
    () => {
      const lookup = holdFirst(2, true);
      return Effect.gen(function* () {
        const { at } = yield* folders;
        write(at("a.txt"), "hi", 1_700_000_000);
        const stuck = [
          yield* Effect.forkChild((yield* connection)("a.txt")),
          yield* Effect.forkChild((yield* connection)("a.txt")),
        ];
        yield* lookup.started;
        yield* TestClock.adjust("20 seconds");
        assert.deepStrictEqual(stuck.map(statusOf), ["busy", "busy"]);
        const third = yield* Effect.forkChild((yield* connection)("a.txt"));
        yield* TestClock.adjust("20 seconds");
        assert.strictEqual(statusOf(third), "busy");
        yield* lookup.release;
        // Two later reads both get a slot only once both held lookups ran to their end.
        const later = yield* Effect.all(
          [(yield* connection)("a.txt"), (yield* connection)("a.txt")],
          {
            concurrency: 2,
          },
        );
        assert.deepStrictEqual(
          later.map((result) => result.status),
          ["chunk", "chunk"],
        );
        assert.strictEqual(lookup.wentOn(), 2);
      }).pipe(
        Effect.ensuring(lookup.release),
        Effect.provide(handlersLayer({ beforeOpen: lookup.hold })),
      );
    },
  );
});
