// @effect-diagnostics nodeBuiltinImport:off - The test stands in for the app server with a real loopback HTTP listener.
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { servedRuntimeProtocolRanges } from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  HOST_ENVIRONMENT_ID_SCRIPT,
  parseAppServerProbe,
  probeAppServer,
  shouldMoveToAppServer,
} from "./appServer.ts";
import {
  ARCHIVE,
  makeSuccessfulProcess,
  remoteShell,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import * as SshAuth from "./auth.ts";
import * as NetService from "@goat/shared/Net";
import {
  SshEnvironmentManager,
  issueRemoteMcpClientSession,
  launchOrReuseRemoteServer,
} from "./tunnel.ts";

const TOKEN = "app-control-secret";

interface AppServer {
  readonly port: number;
  readonly sessions: Array<{ readonly header: string | undefined; readonly body: unknown }>;
}

/** A loopback stand-in for the GOAT app's server: its descriptor and its runtime session route. */
const startAppServer = (descriptor: object, sessionStatus = 200) =>
  Effect.acquireRelease(
    Effect.callback<AppServer & { readonly server: NodeHttp.Server }>((resume) => {
      const sessions: AppServer["sessions"] = [];
      const server = NodeHttp.createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          if (request.method === "GET" && request.url === "/.well-known/goat/environment") {
            response.end(JSON.stringify(descriptor));
            return;
          }
          if (request.method === "POST" && request.url === "/.well-known/goat/runtime/session") {
            const header = request.headers["x-goat-runtime-control"];
            sessions.push({
              header: typeof header === "string" ? header : undefined,
              body: JSON.parse(body),
            });
            response.statusCode = header === TOKEN ? sessionStatus : 403;
            response.end(
              JSON.stringify({ token: "app-session-token", expiresAt: "2026-10-27T00:00:00.000Z" }),
            );
            return;
          }
          response.statusCode = 404;
          response.end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            server,
            sessions,
            port: typeof address === "object" && address !== null ? address.port : 0,
          }),
        );
      });
    }),
    ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

const attachableDescriptor = {
  serverVersion: "0.1.0-nightly.20261025.3",
  protocol: servedRuntimeProtocolRanges(),
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { runtimeSessions: true },
};

/** A host whose home holds the app server's runtime record; ssh runs the scripts under it. */
const makeHost = Effect.fn("test.appServer.host")(function* (record: {
  readonly pid: number;
  readonly port: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const real = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-app-server-" });
  const userdata = `${home}/.goat/desktop/userdata`;
  yield* fs.makeDirectory(userdata, { recursive: true });
  yield* fs.writeFileString(
    `${userdata}/server-runtime.json`,
    `${JSON.stringify({ version: 1, pid: record.pid, port: record.port, origin: `http://127.0.0.1:${record.port}`, startedAt: "2026-10-26T00:00:00.000Z", serverVersion: attachableDescriptor.serverVersion })}\n`,
  );
  yield* fs.writeFileString(`${userdata}/runtime-control.token`, `${TOKEN}\n`);
  const scripts: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || !command.command.endsWith("ssh"))
        return yield* real.spawn(command);
      const stdin = command.options.stdin;
      if (
        stdin === undefined ||
        typeof stdin !== "object" ||
        !("stream" in stdin) ||
        !Stream.isStream(stdin.stream)
      )
        return makeSuccessfulProcess("");
      const bytes = yield* stdin.stream.pipe(Stream.runCollect);
      scripts.push(
        new TextDecoder().decode(new Uint8Array(bytes.flatMap((chunk) => Array.from(chunk)))),
      );
      return yield* real.spawn(
        ChildProcess.make(remoteShell, ["-s"], {
          env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          extendEnv: false,
          stdin: { stream: Stream.fromIterable(bytes), endOnDone: true },
        }),
      );
    }),
  );
  return {
    home,
    scripts,
    spawner: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
});

describe("GOAT app server attachment", () => {
  it.live(
    "a host running the app server serves SSH clients from it, credentials included, and starts no managed server",
    () =>
      Effect.gen(function* () {
        const app = yield* startAppServer(attachableDescriptor);
        const host = yield* makeHost({ pid: process.pid, port: app.port });
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provide(host.spawner));

        const launch = yield* run(launchOrReuseRemoteServer(uploadTarget, {}, ARCHIVE));
        expect(launch.status).toBe("ready");
        if (launch.status !== "ready") return;
        expect(launch.remoteServerKind).toBe("app");
        expect(launch.remotePort).toBe(app.port);
        expect(launch.selectedRuntime.version).toBe(attachableDescriptor.serverVersion);

        const session = yield* run(
          issueRemoteMcpClientSession(
            uploadTarget,
            {
              label: "hub",
              ttl: "12h",
              runtimeModeCeiling: "approval-required",
              approvals: true,
              memoryScopes: ["memory:read"],
            },
            {},
            ARCHIVE,
            launch.selectedRuntime,
          ),
        );
        expect(session).toEqual({
          token: "app-session-token",
          expiresAt: "2026-10-27T00:00:00.000Z",
          runtimeModeCeilingApplied: true,
        });
        expect(app.sessions).toEqual([
          {
            header: TOKEN,
            body: {
              kind: "session",
              subject: "mcp-client",
              scopes: [
                "orchestration:read",
                "orchestration:operate",
                "orchestration:approve",
                "memory:read",
              ],
              ttl: "12h",
              label: "hub",
              runtimeModeCeiling: "approval-required",
            },
          },
        ]);
        // The secret travels in curl's config on stdin, never in a script or argv.
        expect(host.scripts.join("\n")).not.toContain(TOKEN);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${host.home}/.goat/ssh-launch`)).toBe(false);
        expect(yield* fs.exists(`${host.home}/.goat/runtime`)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live(
    "an app server that cannot serve the client, or no longer runs, leaves the host to the managed server",
    () =>
      Effect.gen(function* () {
        const tooOld = yield* startAppServer({ ...attachableDescriptor, capabilities: {} });
        const oldHost = yield* makeHost({ pid: process.pid, port: tooOld.port });
        expect(yield* probeAppServer(uploadTarget).pipe(Effect.provide(oldHost.spawner))).toEqual({
          kind: "declined",
          reason: "no-runtime-sessions",
        });

        // A record left by an app that quit: its PID no longer runs.
        const exited = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
          Effect.flatMap((spawner) => spawner.spawn(ChildProcess.make("true", []))),
        );
        yield* exited.exitCode;
        const goneHost = yield* makeHost({ pid: Number(exited.pid), port: tooOld.port });
        expect(yield* probeAppServer(uploadTarget).pipe(Effect.provide(goneHost.spawner))).toEqual({
          kind: "none",
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("declines an app server whose protocols this client cannot speak", () => {
    const answer = (descriptor: object) =>
      parseAppServerProbe(`GOAT_APP_SERVER=live 1 3773\n${JSON.stringify(descriptor)}\n`);
    expect(answer(attachableDescriptor)).toEqual({
      kind: "attach",
      port: 3773,
      version: attachableDescriptor.serverVersion,
    });
    expect(
      answer({
        ...attachableDescriptor,
        protocol: { ...attachableDescriptor.protocol, ssh: { min: 9999, max: 9999 } },
      }).kind,
    ).toBe("declined");
    expect(parseAppServerProbe("GOAT_APP_SERVER=unreachable\n")).toEqual({
      kind: "declined",
      reason: "unreachable",
    });
  });
});

describe("moving a managed attachment to the app server", () => {
  const client = (activity: "idle" | "busy" | 404) =>
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          activity === 404
            ? new Response("", { status: 404 })
            : new Response(JSON.stringify({ activity, serverVersion: "1", pid: 1 })),
        ),
      ),
    );
  const decide = (
    activity: "idle" | "busy" | 404,
    input: Partial<Parameters<typeof shouldMoveToAppServer>[0]> = {},
  ) =>
    shouldMoveToAppServer({
      descriptor: { appServerLive: true },
      remoteServerKind: "managed",
      selection: {},
      httpBaseUrl: "http://127.0.0.1:41773/",
      timeoutMs: 1_000,
      ...input,
    }).pipe(Effect.provideService(HttpClient.HttpClient, client(activity)));

  it.effect(
    "moves only once the managed server is idle, so running threads finish where they started",
    () =>
      Effect.gen(function* () {
        expect(yield* decide("idle")).toBe(true);
        expect(yield* decide("busy")).toBe(false);
        expect(yield* decide(404)).toBe(false);
      }),
  );

  it.effect(
    "stays when no app server runs, it is already attached, or its launch found it unusable",
    () =>
      Effect.gen(function* () {
        expect(yield* decide("idle", { descriptor: {} })).toBe(false);
        expect(yield* decide("idle", { descriptor: undefined })).toBe(false);
        expect(yield* decide("idle", { remoteServerKind: "app" })).toBe(false);
        expect(yield* decide("idle", { selection: { appServerDeclined: true } })).toBe(false);
      }),
  );
});

describe("manager on a host running the app server", () => {
  const managerLayer = (spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>) =>
    Layer.mergeAll(
      NodeServices.layer,
      spawner,
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      Layer.succeed(SshAuth.SshPasswordPrompt, {
        isAvailable: false,
        request: () => Effect.die("no password prompt in this test"),
      }),
    ).pipe((base) =>
      SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed(ARCHIVE),
        leaveRemoteServerRunning: true,
      }).pipe(Layer.provideMerge(base)),
    );
  const appProbes = (scripts: ReadonlyArray<string>) =>
    scripts.filter((script) => script.includes("GOAT_APP_SERVER=live")).length;

  it.live(
    "reports the attached app server as ready, and hands the host to the managed server when it refuses a credential",
    () =>
      Effect.gen(function* () {
        const app = yield* startAppServer(attachableDescriptor, 500);
        const host = yield* makeHost({ pid: process.pid, port: app.port });
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const bootstrap = yield* manager.ensureEnvironment(uploadTarget);
          expect("type" in bootstrap ? bootstrap.type : bootstrap.remoteServerKind).toBe("app");
          const status = yield* manager.status(uploadTarget);
          expect(status.kind === "ok" ? status.status : status).toMatchObject({
            state: "ready",
            runtimeVersion: attachableDescriptor.serverVersion,
          });

          const before = host.scripts.length;
          // The managed runtime cannot be installed in this fixture, so the retry fails after the move.
          yield* manager
            .issueMcpClientSession(uploadTarget, {
              label: "hub",
              ttl: "12h",
              runtimeModeCeiling: null,
            })
            .pipe(Effect.flip);
          expect(app.sessions).toHaveLength(1);
          const after = host.scripts.slice(before);
          expect(appProbes(after)).toBe(0);
          expect(after.some((script) => script.includes("ready_version()"))).toBe(true);
          // Later connections keep to the managed server instead of the refusing app server.
          yield* manager.ensureEnvironment(uploadTarget).pipe(Effect.ignore);
          expect(appProbes(host.scripts.slice(before))).toBe(0);
        }).pipe(Effect.provide(managerLayer(host.spawner)));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live(
    "a ready-only request on a refusing app server reports the refusal and starts nothing",
    () =>
      Effect.gen(function* () {
        const app = yield* startAppServer(attachableDescriptor, 500);
        const host = yield* makeHost({ pid: process.pid, port: app.port });
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          yield* manager.ensureEnvironment(uploadTarget);
          const before = host.scripts.length;
          yield* manager
            .issueMcpClientSession(uploadTarget, {
              label: "hub",
              ttl: "12h",
              runtimeModeCeiling: null,
              requireReady: true,
            })
            .pipe(Effect.flip);
          expect(app.sessions).toHaveLength(1);
          expect(
            host.scripts.slice(before).some((script) => script.includes("ready_version()")),
          ).toBe(false);
        }).pipe(Effect.provide(managerLayer(host.spawner)));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live(
    "the host's identity is the app server's while it runs, otherwise the managed home's",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-host-identity-" });
        const identify = Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(remoteShell, ["-c", HOST_ENVIRONMENT_ID_SCRIPT], {
              env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
              extendEnv: false,
            }),
          );
          return (yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)).trim();
        });
        yield* fs.makeDirectory(`${home}/.goat/desktop/userdata`, { recursive: true });
        yield* fs.makeDirectory(`${home}/.goat/userdata`, { recursive: true });
        yield* fs.writeFileString(`${home}/.goat/userdata/environment-id`, "managed-env");
        yield* fs.writeFileString(`${home}/.goat/desktop/userdata/environment-id`, "app-env");
        expect(yield* identify).toBe("managed-env");
        const record = `${home}/.goat/desktop/userdata/server-runtime.json`;
        yield* fs.writeFileString(record, JSON.stringify({ pid: process.pid, port: 3773 }));
        expect(yield* identify).toBe("app-env");
        const exited = yield* spawner.spawn(ChildProcess.make("true", []));
        yield* exited.exitCode;
        yield* fs.writeFileString(record, JSON.stringify({ pid: Number(exited.pid), port: 3773 }));
        expect(yield* identify).toBe("managed-env");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
