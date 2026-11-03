// @effect-diagnostics nodeBuiltinImport:off - Loopback listeners represent the remote server and SSH forward.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as NetService from "@goat/shared/Net";
import { servedRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as SshAuth from "./auth.ts";
import { targetConnectionKey } from "./command.ts";
import { makeExistingServerRoutes } from "./existingServer.ts";
import { requestedRuntime } from "./remoteRuntime.ts";
import { sshReadinessBudget } from "./sshReadiness.ts";
import {
  makeRunningProcess,
  makeSuccessfulProcess,
  remoteShell,
  uploadTarget,
} from "./tunnel.fixture.ts";
import type { SshTunnelEntry } from "./tunnel.ts";

const id = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const control = "fixture-control";
const token = "fixture-session";

const listener = (handler: NodeHttp.RequestListener, port = 0) =>
  Effect.acquireRelease(
    Effect.callback<{ server: NodeHttp.Server; port: number }>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing listener");
        resume(Effect.succeed({ server, port: address.port }));
      });
    }),
    ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

describe("existing Git Bash managed environment", () => {
  it.live("reads through a managed sidecar when the external primary uses the same port", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const reads: string[] = [];
      const owner = yield* listener((request, response) => {
        if (request.url === "/.well-known/goat/environment") {
          response.end(
            JSON.stringify({
              environmentId: id,
              serverVersion: "1.0.0",
              protocol: servedRuntimeProtocolRanges(),
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              capabilities: { runtimeSessions: true },
            }),
          );
        } else if (request.url === "/.well-known/goat/runtime/session") {
          response.statusCode = request.headers["x-goat-runtime-control"] === control ? 200 : 403;
          response.end(JSON.stringify({ token, expiresAt: null }));
        } else {
          let body = "";
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            reads.push(`${request.headers.authorization}:${JSON.parse(body).params.name}`);
            response.statusCode = request.headers.authorization === `Bearer ${token}` ? 200 : 403;
            response.end(
              JSON.stringify({ jsonrpc: "2.0", id: 1, result: { threadId: "thread-1" } }),
            );
          });
        }
      });
      const fs = yield* FileSystem.FileSystem;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Scope.Scope;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-gitbash-sidecar-" });
      yield* fs.makeDirectory(`${home}/.goat/userdata`, { recursive: true });
      yield* fs.makeDirectory(`${home}/bin`);
      yield* fs.writeFileString(`${home}/bin/uname`, "#!/bin/sh\nprintf 'MINGW64_NT-10.0\\n'\n", {
        mode: 0o755,
      });
      yield* fs.writeFileString(
        `${home}/bin/tasklist.exe`,
        '#!/bin/sh\nprintf \'"goat.exe","55140","Console","1","1 K"\\n\'\n',
        { mode: 0o755 },
      );
      yield* fs.writeFileString(`${home}/.goat/userdata/environment-id`, `${id}\n`);
      yield* fs.writeFileString(`${home}/.goat/userdata/runtime-control.token`, `${control}\n`);
      yield* fs.writeFileString(
        `${home}/.goat/userdata/server-runtime.json`,
        JSON.stringify({ pid: 55140, port: owner.port, origin: `http://127.0.0.1:${owner.port}` }),
      );
      const transport = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand" || !command.command.endsWith("ssh"))
            return yield* real.spawn(command);
          const stdin = command.options.stdin;
          if (
            !stdin ||
            typeof stdin !== "object" ||
            !("stream" in stdin) ||
            !Stream.isStream(stdin.stream)
          )
            return makeSuccessfulProcess("");
          const bytes = yield* stdin.stream.pipe(Stream.runCollect);
          return yield* real.spawn(
            ChildProcess.make(remoteShell, ["-s"], {
              env: { HOME: home, PATH: `${home}/bin:${process.env.PATH ?? "/usr/bin:/bin"}` },
              extendEnv: false,
              stdin: { stream: Stream.fromIterable(bytes), endOnDone: true },
            }),
          );
        }),
      );
      const key = targetConnectionKey(uploadTarget);
      let primaryKilled = false;
      const primaryScope = yield* Scope.fork(scope, "sequential");
      const primary: SshTunnelEntry = {
        key,
        target: uploadTarget,
        remotePort: owner.port,
        remoteServerKind: "external",
        localPort: 1,
        httpBaseUrl: "http://127.0.0.1:1/",
        wsBaseUrl: "ws://127.0.0.1:1/",
        process: makeRunningProcess(() => {
          primaryKilled = true;
        }),
        scope: primaryScope,
        selectedRuntime: requestedRuntime(undefined),
        readiness: sshReadinessBudget(0),
      };
      const tunnels = new Map([[key, primary]]);
      const forwards: number[] = [];
      const routes = makeExistingServerRoutes({
        managerScope: scope,
        tunnels,
        resolvedTargets: new Map(),
        isClosed: () => false,
        authFor: () => ({}),
        withTargetLock: (_key, effect) => effect,
        runWithSshAuth: ({ operation }) => operation({}),
        shutdownTimeoutMs: 1000,
        startTunnel: (input) =>
          Effect.gen(function* () {
            forwards.push(input.remotePort);
            yield* listener((request, response) => {
              let body = "";
              request.on("data", (chunk) => {
                body += chunk;
              });
              request.on("end", () => {
                const outbound = NodeHttp.request(
                  {
                    host: "127.0.0.1",
                    port: input.remotePort,
                    path: request.url,
                    method: "POST",
                    headers: {
                      authorization: request.headers.authorization ?? "",
                      "content-type": "application/json",
                    },
                  },
                  (remote) => {
                    let text = "";
                    remote.on("data", (chunk) => {
                      text += chunk;
                    });
                    remote.on("end", () => {
                      response.statusCode = remote.statusCode ?? 502;
                      response.end(text);
                    });
                    remote.on("error", () => {
                      response.statusCode = 502;
                      response.end();
                    });
                  },
                );
                outbound.on("error", () => {
                  response.statusCode = 502;
                  response.end();
                });
                outbound.end(body);
              });
            }, input.localPort).pipe(Scope.provide(input.scope));
            return {
              key: input.key,
              target: input.resolvedTarget,
              remotePort: input.remotePort,
              remoteServerKind: input.remoteServerKind,
              localPort: input.localPort,
              httpBaseUrl: input.httpBaseUrl,
              wsBaseUrl: input.wsBaseUrl,
              process: makeRunningProcess(() => undefined),
              scope: input.scope,
              selectedRuntime: input.selectedRuntime,
              readiness: input.readiness,
            };
          }),
      });
      yield* Effect.gen(function* () {
        const sidecar = yield* routes.existingEnvironment!(uploadTarget, id);
        expect(sidecar.httpBaseUrl).not.toBe(primary.httpBaseUrl);
        const session = yield* routes.issueExistingMcpSession!(uploadTarget, id, {
          label: "test",
          ttl: "1h",
          runtimeModeCeiling: "full-access",
        });
        expect(session.token).toBe(token);
        const response = yield* client.execute(
          HttpClientRequest.post(`${sidecar.httpBaseUrl}mcp`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${session.token}`),
            HttpClientRequest.bodyJsonUnsafe({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "goat_thread_read", arguments: { threadId: "thread-1" } },
            }),
          ),
        );
        expect(response.status).toBe(200);
        expect(yield* response.json).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { threadId: "thread-1" },
        });
        expect(reads).toEqual([`Bearer ${token}:goat_thread_read`]);
        expect(forwards).toEqual([owner.port]);
        expect(tunnels.get(key)).toBe(primary);
        expect(primaryKilled).toBe(false);
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, transport),
        Effect.provideService(NetService.NetService, NetService.make()),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          SshAuth.SshPasswordPrompt.disabledLayer,
          NodeServices.layer,
        ),
      ),
      Effect.scoped,
    ),
  );
});
