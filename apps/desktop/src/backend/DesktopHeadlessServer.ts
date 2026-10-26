import type { DesktopEnvironmentBootstrap } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

// SSH clients use this app's own server while it runs (structure/ssh.md#app-server).
// SSH work that arrived while the app was closed started a headless
// `goat serve --base-dir ~/.goat` instead, which keeps running and whose database
// is never moved or merged. This service attaches that server as a
// desktop-local environment, so the threads it holds show up here.
//
// Its session is issued by the headless server's own runtime binary, never by
// this app's bundled server: the CLI migrates the database it opens, and a
// newer app must not migrate a database an older live server is using.

export const HEADLESS_LOCAL_ENVIRONMENT_ID = "headless";
const LABEL = "Headless server";
const POLL_INTERVAL = "5 seconds";
const SESSION_TTL = "30d";
const SESSION_RENEW_MARGIN_MS = 24 * 60 * 60 * 1000;
const FAILED_ISSUE_RETRY_MS = 5 * 60 * 1000;

const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const RuntimeRecord = Schema.Struct({
  pid: Schema.Number,
  port: Schema.Number,
  origin: Schema.String,
  startedAt: Schema.String,
  serverVersion: Schema.optionalKey(Schema.String),
});
const decodeRuntimeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeRecord));

const IssuedSession = Schema.Struct({ token: Schema.String, expiresAt: Schema.String });
const decodeIssuedSession = Schema.decodeUnknownOption(Schema.fromJsonString(IssuedSession));

export interface HeadlessServerRuntime {
  readonly pid: number;
  readonly startedAt: string;
  readonly serverVersion: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * The loopback server a `server-runtime.json` describes, or none when it is not
 * one this app can attach: a non-loopback origin, or no exact version naming
 * the runtime binary that can issue its sessions.
 */
function parseHeadlessServerRuntime(text: string): Option.Option<HeadlessServerRuntime> {
  return Option.flatMap(decodeRuntimeRecord(text), (record) => {
    if (
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      !Number.isSafeInteger(record.port) ||
      record.port < 1 ||
      record.port > 65535 ||
      record.serverVersion === undefined ||
      !EXACT_VERSION.test(record.serverVersion)
    )
      return Option.none();
    const origin = URL.parse(record.origin);
    if (
      origin === null ||
      origin.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(origin.hostname) ||
      Number(origin.port || "80") !== record.port
    )
      return Option.none();
    return Option.some({
      pid: record.pid,
      startedAt: record.startedAt,
      serverVersion: record.serverVersion,
      httpBaseUrl: `http://127.0.0.1:${record.port}/`,
      wsBaseUrl: `ws://127.0.0.1:${record.port}/`,
    });
  });
}

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
};

interface Attached {
  readonly identity: string;
  readonly runtime: HeadlessServerRuntime;
  readonly token: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
}

export class DesktopHeadlessServer extends Context.Service<
  DesktopHeadlessServer,
  {
    /** The attached headless server, or none while there is no usable one. */
    readonly bootstrap: Effect.Effect<Option.Option<DesktopEnvironmentBootstrap>>;
    /** Re-reads the runtime descriptor; polled in the background. */
    readonly refresh: Effect.Effect<void>;
  }
>()("@goat/desktop/backend/DesktopHeadlessServer") {}

/**
 * Builds the service. `attachEnabled` is read on every poll: a person can turn the headless
 * server off on this Mac (Settings > Connections), which detaches it and stops issuing sessions
 * until they turn it back on. It never stops the server, which SSH clients may still use.
 */
export const makeWith = Effect.fn("DesktopHeadlessServer.make")(function* (options: {
  readonly attachEnabled: Effect.Effect<boolean>;
}) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = environment.path;
  const goatHome = path.join(environment.homeDirectory, ".goat");
  const runtimeFile = path.join(goatHome, "userdata", "server-runtime.json");
  // Development builds would write a session into the developer's real
  // ~/.goat, and SSH runtimes are never installed on Windows. When this app
  // itself runs on ~/.goat, the headless state is already its own.
  const enabled =
    !environment.isDevelopment &&
    environment.platform !== "win32" &&
    path.resolve(environment.stateDir) !== path.resolve(goatHome, "userdata");

  const attached = yield* Ref.make(Option.none<Attached>());
  const failed = yield* Ref.make(Option.none<{ identity: string; atMs: number }>());

  const issueSession = (runtime: HeadlessServerRuntime) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtimeDir = path.join(
          goatHome,
          "runtime",
          "goat",
          "versions",
          runtime.serverVersion,
        );
        const marker = yield* fs.readFileString(path.join(runtimeDir, ".install-complete"));
        if (marker.trim() !== runtime.serverVersion)
          return yield* Effect.fail("runtime binary is not installed");
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            path.join(runtimeDir, "goat"),
            [
              "auth",
              "session",
              "issue",
              "--base-dir",
              goatHome,
              "--subject",
              "desktop-local",
              "--label",
              "GOAT desktop on this device",
              "--ttl",
              SESSION_TTL,
              "--json",
            ],
            { stdin: "ignore", stderr: "ignore" },
          ),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) return yield* Effect.fail(`session issue exited with ${exitCode}`);
        const session = decodeIssuedSession(stdout.slice(stdout.indexOf("{")));
        if (Option.isNone(session)) return yield* Effect.fail("session issue printed no session");
        const expiresAtMs = Date.parse(session.value.expiresAt);
        if (!Number.isFinite(expiresAtMs))
          return yield* Effect.fail("session issue printed no expiry");
        return { token: session.value.token, expiresAt: session.value.expiresAt, expiresAtMs };
      }),
    );

  const serialized = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    if (!enabled) return;
    if (!(yield* options.attachEnabled)) {
      yield* Ref.set(attached, Option.none());
      return;
    }
    const runtime = yield* fs.readFileString(runtimeFile).pipe(
      Effect.map(parseHeadlessServerRuntime),
      Effect.orElseSucceed(() => Option.none<HeadlessServerRuntime>()),
    );
    if (Option.isNone(runtime) || !processExists(runtime.value.pid)) {
      yield* Ref.set(attached, Option.none());
      return;
    }
    // A restarted server may hold a different database; never reuse a token across one.
    const identity = `${runtime.value.pid}|${runtime.value.startedAt}|${runtime.value.httpBaseUrl}`;
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(attached);
    if (
      Option.isSome(current) &&
      current.value.identity === identity &&
      current.value.expiresAtMs - now > SESSION_RENEW_MARGIN_MS
    )
      return;
    const lastFailure = yield* Ref.get(failed);
    if (
      Option.isSome(lastFailure) &&
      lastFailure.value.identity === identity &&
      now - lastFailure.value.atMs < FAILED_ISSUE_RETRY_MS
    )
      return;
    const issued = yield* issueSession(runtime.value).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Could not attach the headless GOAT server.", {
          serverVersion: runtime.value.serverVersion,
          cause,
        }),
      ),
      Effect.option,
    );
    if (Option.isNone(issued)) {
      yield* Ref.set(failed, Option.some({ identity, atMs: now }));
      if (Option.isSome(current) && current.value.identity !== identity)
        yield* Ref.set(attached, Option.none());
      return;
    }
    yield* Ref.set(failed, Option.none());
    yield* Ref.set(attached, Option.some({ identity, runtime: runtime.value, ...issued.value }));
  }).pipe(serialized.withPermits(1));

  if (enabled)
    yield* refresh.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.forkScoped);

  return DesktopHeadlessServer.of({
    refresh,
    bootstrap: Ref.get(attached).pipe(
      Effect.map(
        Option.map((value): DesktopEnvironmentBootstrap => ({
          id: HEADLESS_LOCAL_ENVIRONMENT_ID,
          label: LABEL,
          runningDistro: null,
          httpBaseUrl: value.runtime.httpBaseUrl,
          wsBaseUrl: value.runtime.wsBaseUrl,
          accessToken: value.token,
          accessTokenExpiresAt: value.expiresAt,
        })),
      ),
    ),
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  return yield* makeWith({
    attachEnabled: settings.get.pipe(Effect.map((value) => value.headlessServerAttachEnabled)),
  });
});

export const layer = Layer.effect(DesktopHeadlessServer, make);
