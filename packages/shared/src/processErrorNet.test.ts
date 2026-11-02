// @effect-diagnostics nodeBuiltinImport:off - Subprocess fixtures exercise process-level error handlers.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { isUnheardErrorEvent } from "./processErrorNet.ts";

const moduleUrl = new URL("./processErrorNet.ts", import.meta.url).href;
// The package directory, so fixtures resolve this package's dependencies.
const packageDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const SETUP = {
  net: "installProcessErrorNet();",
  rejections:
    'containRejections((reason) => reason instanceof Error && reason.name === "WriteIterableClosedError" && reason.message === "WritableIterable is closed" ? "closed exec stream" : undefined);',
  none: "",
} as const;

const runFixture = (setup: keyof typeof SETUP, body: string) =>
  Effect.callback<{ code: number | null; stdout: string; stderr: string }>((resume) => {
    const script = [
      `import { installProcessErrorNet, containRejections } from ${JSON.stringify(moduleUrl)};`,
      'import * as NodeEvents from "node:events";',
      SETUP[setup],
      body,
    ].join("\n");
    const child = NodeChildProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: packageDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const fail = (error: Error) => resume(Effect.die(error));
    child.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resume(Effect.succeed({ code, stdout, stderr })));
    // An interrupted test must not leave its fixture running.
    return Effect.sync(() => {
      child.kill();
    });
  });

const emitUnheard = (fields: string) =>
  `setImmediate(() => new NodeEvents.EventEmitter().emit("error", Object.assign(new Error("teardown"), ${fields})));
setImmediate(() => console.log("alive"));`;

it.live("an emitted EPIPE nobody heard leaves the process running", () =>
  Effect.gen(function* () {
    const result = yield* runFixture("net", emitUnheard('{ code: "EPIPE", syscall: "write" }'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("alive");
    expect(result.stderr).toContain("contained EPIPE");
  }),
);

it.live("an emitted ECONNRESET from a read leaves the process running", () =>
  Effect.gen(function* () {
    const result = yield* runFixture("net", emitUnheard('{ code: "ECONNRESET", syscall: "read" }'));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("alive");
    expect(result.stderr).toContain("contained ECONNRESET");
  }),
);

it.live("a thrown EPIPE exits 1, because the throw may have left state half-updated", () =>
  Effect.gen(function* () {
    const result = yield* runFixture(
      "net",
      `setImmediate(() => { throw Object.assign(new Error("teardown"), { code: "EPIPE", syscall: "write" }); });
setImmediate(() => console.log("alive"));`,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("alive");
    expect(result.stderr).toContain("teardown");
  }),
);

it.live("an ECONNRESET without a syscall, like an http socket hang up, exits 1", () =>
  Effect.gen(function* () {
    const result = yield* runFixture("net", emitUnheard('{ code: "ECONNRESET" }'));
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("alive");
  }),
);

it.live("a ws closed while connecting, with no error listener, leaves the process running", () =>
  Effect.gen(function* () {
    const result = yield* runFixture(
      "net",
      `const NodeNet = await import("node:net");
const { NodeWS } = await import("@effect/platform-node/NodeSocket");
let ws;
// Accepts the connection and never answers the upgrade, so the client stays CONNECTING.
const server = NodeNet.createServer((socket) => {
  socket.on("error", () => {});
  ws.close();
  setImmediate(() => { socket.destroy(); server.close(); console.log("alive"); });
});
server.on("error", (error) => { console.error(error); process.exit(2); });
server.listen(0, "127.0.0.1", () => { ws = new NodeWS.WebSocket("ws://127.0.0.1:" + server.address().port); });`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("alive");
    expect(result.stderr).toContain("contained WS_CLOSED_CONNECTING");
  }),
);

it.live("a rejection carrying EPIPE exits 1, because its producer may be mid-update", () =>
  Effect.gen(function* () {
    const result = yield* runFixture(
      "net",
      `void Promise.reject(Object.assign(new Error("teardown"), { code: "EPIPE", syscall: "write" }));
setImmediate(() => console.log("alive"));`,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("alive");
  }),
);

it.live("a classified rejection is contained by containRejections alone", () =>
  Effect.gen(function* () {
    const result = yield* runFixture(
      "rejections",
      `void Promise.reject(Object.assign(new Error("WritableIterable is closed"), { name: "WriteIterableClosedError" }));
setImmediate(() => console.log("alive"));`,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("alive");
    expect(result.stderr).toContain("closed exec stream");
  }),
);

it.live("containRejections leaves uncaught exceptions to Node's default exit", () =>
  Effect.gen(function* () {
    const result = yield* runFixture(
      "rejections",
      `setImmediate(() => { throw new TypeError("real bug"); });
setImmediate(() => console.log("alive"));`,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("alive");
    expect(result.stderr).toContain("real bug");
  }),
);

it.live(
  "another unhandledRejection listener decides about the rejections the net does not contain",
  () =>
    Effect.gen(function* () {
      const result = yield* runFixture(
        "net",
        `process.on("unhandledRejection", () => console.log("other heard"));
void Promise.reject(new Error("unclassified"));
setImmediate(() => console.log("alive"));`,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("other heard");
      expect(result.stdout).toContain("alive");
    }),
);

it.live("another uncaughtException listener does not keep the process alive after a real bug", () =>
  Effect.gen(function* () {
    const result = yield* runFixture(
      "net",
      `process.on("uncaughtException", () => console.log("other heard"));
setImmediate(() => { throw new TypeError("real bug"); });
setImmediate(() => console.log("alive"));`,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("alive");
    expect(result.stderr).toContain("real bug");
  }),
);

it.live(
  "a rejection the handler cannot even inspect, a revoked Proxy, still logs and exits 1",
  () =>
    Effect.gen(function* () {
      const result = yield* runFixture(
        "net",
        `const { proxy, revoke } = Proxy.revocable({}, {});
revoke();
void Promise.reject(proxy);
setImmediate(() => console.log("alive"));`,
      );
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("alive");
      expect(result.stderr).toContain("goat: fatal error while handling an uncaught error");
    }),
);

it.live("an unheard error whose code getter throws still logs and exits 1", () =>
  Effect.gen(function* () {
    const result = yield* runFixture(
      "net",
      `const error = new Error("exotic");
Object.defineProperty(error, "code", { get() { throw new Error("getter"); } });
setImmediate(() => new NodeEvents.EventEmitter().emit("error", error));
setImmediate(() => console.log("alive"));`,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("alive");
    expect(result.stderr).toContain("goat: fatal error while handling an uncaught error");
  }),
);

it("tells an unheard 'error' event apart from a throw (pins Node's internal tag)", () => {
  const error = new Error("unheard");
  let raised: unknown;
  try {
    new NodeEvents.EventEmitter().emit("error", error);
  } catch (caught) {
    raised = caught;
  }
  expect(raised).toBe(error);
  expect(isUnheardErrorEvent(error)).toBe(true);
  expect(isUnheardErrorEvent(new Error("thrown"))).toBe(false);
});

it.live("without the net, an emitted EPIPE ends the process (today's behavior)", () =>
  Effect.gen(function* () {
    const result = yield* runFixture("none", emitUnheard('{ code: "EPIPE", syscall: "write" }'));
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("alive");
  }),
);
