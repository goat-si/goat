// @effect-diagnostics nodeBuiltinImport:off -- A loopback fake of Cursor's backend drives the real SDK.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import { makeCursorAgentOptions } from "./agentOptions.ts";
import { loadCursorSdk } from "./sdk.ts";

// The SDK reads CURSOR_BACKEND_URL once when it loads, before any test body runs.
const cursorBackendUrl = await vi.hoisted(async () => {
  const NodeNet = await import("node:net");
  const probe = NodeNet.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  process.env.CURSOR_BACKEND_URL = url;
  return url;
});

const { Agent } = loadCursorSdk();

describe("CursorAdapterV2", () => {
  it.live("honors the user's Cursor CLI attribution preferences", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-attribution-" });
      yield* fileSystem.makeDirectory(path.join(home, ".cursor"));
      yield* fileSystem.writeFileString(
        path.join(home, ".cursor", "cli-config.json"),
        JSON.stringify({
          attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
        }),
      );
      const backend = yield* fakeCursorBackend;
      // CURSOR_CONFIG_DIR outranks an ambient XDG_CONFIG_HOME; the home overrides keep the real ~/.cursor out.
      yield* scopedProcessEnv({
        HOME: home,
        USERPROFILE: home,
        CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
      });
      const agent = yield* Effect.acquireRelease(
        Effect.promise(() =>
          Agent.create(
            makeCursorAgentOptions({
              apiKey: "synthetic-cursor-api-key",
              modelSelection: {
                instanceId: ProviderInstanceId.make("cursor"),
                model: "composer-2",
              },
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: home,
              },
              threadId: ThreadId.make("cursor-attribution-thread"),
              mcpSession: undefined,
              platform: "linux",
            }),
          ),
        ),
        (agent) => Effect.sync(() => agent.close()),
      );
      yield* Effect.promise(() => agent.send("Commit hello.txt."));

      assert.deepEqual(yield* Deferred.await(backend.requestContext), {
        commitAttributionMessage: undefined,
        prAttributionMessage: undefined,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps attribution when the Cursor CLI config leaves it on", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-attribution-" });
      yield* fileSystem.makeDirectory(path.join(home, ".cursor"));
      yield* fileSystem.writeFileString(
        path.join(home, ".cursor", "cli-config.json"),
        JSON.stringify({
          attribution: { attributeCommitsToAgent: true, attributePRsToAgent: true },
        }),
      );
      const backend = yield* fakeCursorBackend;
      // CURSOR_CONFIG_DIR outranks an ambient XDG_CONFIG_HOME; the home overrides keep the real ~/.cursor out.
      yield* scopedProcessEnv({
        HOME: home,
        USERPROFILE: home,
        CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
      });
      const agent = yield* Effect.acquireRelease(
        Effect.promise(() =>
          Agent.create(
            makeCursorAgentOptions({
              apiKey: "synthetic-cursor-api-key",
              modelSelection: {
                instanceId: ProviderInstanceId.make("cursor"),
                model: "composer-2",
              },
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: home,
              },
              threadId: ThreadId.make("cursor-attribution-on-thread"),
              mcpSession: undefined,
              platform: "linux",
            }),
          ),
        ),
        (agent) => Effect.sync(() => agent.close()),
      );
      yield* Effect.promise(() => agent.send("Commit hello.txt."));

      assert.deepEqual(yield* Deferred.await(backend.requestContext), {
        commitAttributionMessage: "enabled",
        prAttributionMessage: "enabled",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const scopedProcessEnv = (values: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );

// Loopback stand-in for Cursor's backend: it asks the local SDK runtime for its request
// context over RunSSE and decodes the RequestContext the SDK appends back (agent.v1 protos).
const fakeCursorBackend = Effect.gen(function* () {
  const requestContext = yield* Deferred.make<{
    readonly commitAttributionMessage: string | undefined;
    readonly prAttributionMessage: string | undefined;
  }>();
  const requestContextExec = protoField(
    2,
    Buffer.concat([Buffer.from([0x08, 0x01]), protoField(15, Buffer.from("ctx")), protoField(10)]),
  );
  const runFrame = Buffer.alloc(5 + requestContextExec.length);
  runFrame.writeUInt32BE(requestContextExec.length, 1);
  requestContextExec.copy(runFrame, 5);
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      switch (request.url) {
        case "/auth/exchange_user_api_key":
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ accessToken: "synthetic-access-token" }));
          return;
        case "/v1/models":
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ items: [{ id: "composer-2" }] }));
          return;
        case "/agent.v1.AgentService/RunSSE":
          response.writeHead(200, { "content-type": "application/connect+proto" });
          response.write(runFrame);
          return;
        case "/aiserver.v1.BidiService/BidiAppend": {
          const appended = protoGet(Buffer.concat(chunks), 1);
          const clientMessage = Buffer.from(appended?.toString() ?? "", "hex");
          const success = protoPath(clientMessage, [2, 10, 1]);
          if (success !== undefined) {
            const context = protoGet(success, 1);
            Deferred.doneUnsafe(
              requestContext,
              context === undefined
                ? Effect.die(new Error("RequestContextSuccess carried no RequestContext"))
                : Effect.succeed({
                    commitAttributionMessage: protoGet(context, 26)?.toString(),
                    prAttributionMessage: protoGet(context, 27)?.toString(),
                  }),
            );
          }
          response.setHeader("content-type", "application/proto");
          response.end();
          return;
        }
        default:
          response.statusCode = 404;
          response.end();
      }
    });
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(Number(new URL(cursorBackendUrl).port), "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  return { requestContext };
});

function protoVarint(value: number): Buffer {
  const bytes: Array<number> = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function protoField(fieldNumber: number, value: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([protoVarint((fieldNumber << 3) | 2), protoVarint(value.length), value]);
}

function protoGet(message: Buffer, fieldNumber: number): Buffer | undefined {
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = message[offset++] ?? 0;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  while (offset < message.length) {
    const key = readVarint();
    const wireType = key & 7;
    if (wireType === 0) {
      readVarint();
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      const length = readVarint();
      if (Math.floor(key / 8) === fieldNumber) return message.subarray(offset, offset + length);
      offset += length;
    }
  }
  return undefined;
}

function protoPath(message: Buffer, fieldNumbers: ReadonlyArray<number>): Buffer | undefined {
  let current: Buffer | undefined = message;
  for (const fieldNumber of fieldNumbers) {
    current = current === undefined ? undefined : protoGet(current, fieldNumber);
  }
  return current;
}
