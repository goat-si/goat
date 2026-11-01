import { CodexSettings } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HomeRoute from "./OpenCodexRoute.ts";
const decode = Schema.decodeSync(CodexSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const fixture = (
  options: {
    readonly role?: "client" | "home";
    readonly credential?: string;
    readonly modelsStatus?: number;
    readonly cliPid?: number;
    readonly cliOutput?: string;
    readonly linkRole?: string;
    readonly ready?: string;
    readonly response?: () => Response;
    readonly onModelsRequest?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-route-" });
    const catalog = path.join(home, "opencodex-catalog.json");
    yield* fs.writeFileString(catalog, '{"models":[]}');
    const input = yield* HomeRoute.resolveCodexRouteContext({
      settings: decode({ modelRoute: "opencodex", homePath: home }),
      binaryPath: "/selected/codex",
      home,
      cwd: home,
      environment: {},
      configArgv: [],
    });
    const calls: string[] = [];
    const reads: string[] = [];
    const health = {
      service: "opencodex",
      version: "2.88.0",
      pid: 1234,
      port: 10100,
      ...(options.role === "home" ? {} : { role: "client" }),
    };
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
        calls.push(`${command.command} ${command.args.join(" ")}`);
        const stdout =
          command.args[0] === "link"
            ? encodeJson({
                schemaVersion: 1,
                role: options.linkRole ?? "home",
                child: null,
                links: [],
              })
            : encodeJson({
                schemaVersion: 1,
                runtimeRole: "client",
                proxy: {
                  running: true,
                  pid: options.cliPid ?? health.pid,
                  health: { ok: true, url: "http://127.0.0.1:10100/healthz" },
                },
                listen: { hostname: "127.0.0.1", port: 10100 },
                connection: {
                  state: options.role === "home" ? "disconnected" : "connected",
                  credentialFile: options.credential ?? "missing",
                  readiness: "incompatible",
                },
              });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(99),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(options.cliOutput ?? stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const client = HttpClient.make((request) =>
      (request.url.endsWith("/models")
        ? (options.onModelsRequest ?? Effect.void)
        : Effect.void
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            calls.push(request.url);
            const response = request.url.endsWith("/models")
              ? (options.response?.() ??
                new Response(
                  encodeJson(
                    options.modelsStatus === 503
                      ? { error: "link tunnel unavailable" }
                      : { data: [{ id: "home-model" }] },
                  ),
                  {
                    status: options.modelsStatus ?? 200,
                    ...(options.modelsStatus === 503 ? { headers: { "retry-after": "1" } } : {}),
                  },
                ))
              : new Response(
                  encodeJson({
                    ...health,
                    ...(request.url.endsWith("/readyz")
                      ? { status: options.ready ?? "ready", protocolVersion: 1 }
                      : {}),
                  }),
                );
            return HttpClientResponse.fromWeb(request, response);
          }),
        ),
      ),
    );
    const recordingFs = {
      ...fs,
      readFileString: (filename: string, encoding?: string) => {
        reads.push(filename);
        return fs.readFileString(filename, encoding);
      },
    };
    const service = Context.get(
      yield* Layer.build(
        HomeRoute.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, recordingFs)),
        ),
      ),
      HomeRoute.OpenCodexRoute,
    );
    return { service, input, catalog, calls, reads };
  });
