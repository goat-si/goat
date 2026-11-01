import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopHeadlessServer from "./DesktopHeadlessServer.ts";

const VERSION = "1.4.2";
const ENVIRONMENT_ID = "env-headless";
const INSTANCE_ID = "instance-1";

const runtimeJson = (input: {
  pid?: number;
  port?: number;
  origin?: string;
  startedAt?: string;
  instanceId?: string | null;
  devUrl?: string;
}) =>
  JSON.stringify({
    version: 1,
    serverVersion: VERSION,
    pid: input.pid ?? process.pid,
    port: input.port ?? 3773,
    origin: input.origin ?? `http://127.0.0.1:${input.port ?? 3773}`,
    startedAt: input.startedAt ?? "2026-10-12T10:00:00.000Z",
    ...(input.instanceId === null ? {} : { instanceId: input.instanceId ?? INSTANCE_ID }),
    ...(input.devUrl === undefined ? {} : { devUrl: input.devUrl }),
  });

interface ListenerAnswer {
  readonly environmentId?: string;
  readonly instanceId?: string;
  readonly serverVersion?: string;
}

/**
 * The process answering on the recorded port. `answer` is asked once per
 * descriptor request, in order; null means it refuses to describe itself.
 */
const fakeListener = (answer: (request: number) => ListenerAnswer | null) => {
  let requests = 0;
  return HttpClient.make((request) => {
    const value = answer(++requests);
    if (value === null)
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
      );
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          environmentId: value.environmentId ?? ENVIRONMENT_ID,
          label: "headless",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: value.serverVersion ?? VERSION,
          instanceId: value.instanceId ?? INSTANCE_ID,
          capabilities: {},
        }),
      ),
    );
  });
};

/**
 * A runtime binary that records each invocation and prints a fresh session.
 * `expiresAt` names each session's expiry by call number; null makes that call fail.
 */
const fakeRuntime = (expiresAt: (call: number) => string | null) => {
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { command: executable, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      calls.push({ command: executable, args });
      const expiry = expiresAt(calls.length);
      const stdout = JSON.stringify({
        sessionId: `session-${calls.length}`,
        token: `token-${calls.length}`,
        expiresAt: expiry,
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(expiry === null ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { calls, spawner };
};

const setup = (input?: {
  stateDir?: (home: string) => string;
  installed?: boolean;
  attachEnabled?: () => boolean;
  platform?: NodeJS.Platform;
  listener?: (request: number) => ListenerAnswer | null;
  expiresAt?: (call: number) => string | null;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-headless-" });
    const goatHome = path.join(home, ".goat");
    yield* fs.makeDirectory(path.join(goatHome, "userdata"), { recursive: true });
    yield* fs.writeFileString(
      path.join(goatHome, "userdata", "environment-id"),
      `${ENVIRONMENT_ID}\n`,
    );
    const runtimeDir = path.join(goatHome, "runtime", "goat", "versions", VERSION);
    if (input?.installed !== false) {
      yield* fs.makeDirectory(runtimeDir, { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, ".install-complete"), `${VERSION}\n`);
    }
    const runtime = fakeRuntime(input?.expiresAt ?? (() => "2099-01-01T00:00:00.000Z"));
    const environment = DesktopEnvironment.DesktopEnvironment.of({
      path,
      platform: input?.platform ?? "darwin",
      isDevelopment: false,
      homeDirectory: home,
      stateDir: input?.stateDir?.(home) ?? path.join(goatHome, "desktop", "userdata"),
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);
    const service = yield* DesktopHeadlessServer.makeWith({
      attachEnabled: Effect.sync(input?.attachEnabled ?? (() => true)),
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, runtime.spawner),
      Effect.provideService(HttpClient.HttpClient, fakeListener(input?.listener ?? (() => ({})))),
    );
    const writeRuntime = (contents: string) =>
      fs.writeFileString(path.join(goatHome, "userdata", "server-runtime.json"), contents);
    return { service, calls: runtime.calls, goatHome, runtimeDir, writeRuntime };
  });

it.layer(NodeServices.layer)("DesktopHeadlessServer", (it) => {
  it.effect("attaches a live headless server with a session from its own runtime", () =>
    Effect.gen(function* () {
      const { service, calls, goatHome, runtimeDir, writeRuntime } = yield* setup();
      yield* writeRuntime(runtimeJson({ port: 3774 }));
      yield* service.refresh;

      const bootstrap = Option.getOrThrow(yield* service.bootstrap);
      expect(bootstrap).toMatchObject({
        id: DesktopHeadlessServer.HEADLESS_LOCAL_ENVIRONMENT_ID,
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        accessToken: "token-1",
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(bootstrap.bootstrapToken).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe(`${runtimeDir}/goat`);
      expect(calls[0]!.args.slice(0, 5)).toEqual([
        "auth",
        "session",
        "issue",
        "--base-dir",
        goatHome,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps its session for the same server and renews it for a restarted one", () =>
    Effect.gen(function* () {
      const { service, calls, writeRuntime } = yield* setup();
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;
      yield* service.refresh;
      expect(calls).toHaveLength(1);

      yield* writeRuntime(runtimeJson({ startedAt: "2026-10-12T11:00:00.000Z" }));
      yield* service.refresh;
      expect(calls).toHaveLength(2);
      expect(Option.getOrThrow(yield* service.bootstrap).accessToken).toBe("token-2");
    }).pipe(Effect.scoped),
  );

  it.effect("detaches when the server stops and ignores servers it cannot attach", () =>
    Effect.gen(function* () {
      const { service, calls, writeRuntime } = yield* setup();
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;
      expect(Option.isSome(yield* service.bootstrap)).toBe(true);

      // A stale descriptor whose process is gone.
      yield* writeRuntime(runtimeJson({ pid: 2 ** 30 }));
      yield* service.refresh;
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);

      // A server not on loopback.
      yield* writeRuntime(runtimeJson({ origin: "http://10.0.0.5:3773" }));
      yield* service.refresh;
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);
      expect(calls).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("never issues a session without the live server's own runtime binary", () =>
    Effect.gen(function* () {
      const { service, calls, writeRuntime } = yield* setup({ installed: false });
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);
      expect(calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("stays off when this app's own state is the headless state", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { service, calls, writeRuntime } = yield* setup({
        stateDir: (home) => path.join(home, ".goat", "userdata"),
      });
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);
      expect(calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not attach while the person turned the headless server off, and drops it when they do",
    () =>
      Effect.gen(function* () {
        let on = true;
        const { service, calls, writeRuntime } = yield* setup({ attachEnabled: () => on });
        yield* writeRuntime(runtimeJson({}));
        yield* service.refresh;
        expect(Option.isSome(yield* service.bootstrap)).toBe(true);

        on = false;
        yield* service.refresh;
        expect(Option.isNone(yield* service.bootstrap)).toBe(true);

        // A restarted server stays hidden too, and no session is issued for it.
        yield* writeRuntime(runtimeJson({ startedAt: "2026-10-12T11:00:00.000Z" }));
        yield* service.refresh;
        expect(Option.isNone(yield* service.bootstrap)).toBe(true);
        expect(calls).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect("attaches on Windows with the runtime's goat.exe", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { service, calls, goatHome, runtimeDir, writeRuntime } = yield* setup({
        platform: "win32",
      });
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;

      expect(Option.getOrThrow(yield* service.bootstrap).accessToken).toBe("token-1");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe(path.join(runtimeDir, "goat.exe"));
      expect(calls[0]!.args.slice(3, 5)).toEqual(["--base-dir", goatHome]);
    }).pipe(Effect.scoped),
  );

  it.effect("never issues a session to a listener that is not the recorded server", () =>
    Effect.gen(function* () {
      const answers: Array<ListenerAnswer | null> = [
        { environmentId: "another-home" },
        { instanceId: "a-later-start" },
        { serverVersion: "1.5.0" },
        null,
      ];
      for (const answer of answers) {
        const { service, calls, writeRuntime } = yield* setup({ listener: () => answer });
        yield* writeRuntime(runtimeJson({}));
        yield* service.refresh;
        expect(Option.isNone(yield* service.bootstrap)).toBe(true);
        expect(calls).toHaveLength(0);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("ignores development servers and records without an instance id", () =>
    Effect.gen(function* () {
      const { service, calls, writeRuntime } = yield* setup();
      yield* writeRuntime(runtimeJson({ devUrl: "http://127.0.0.1:5733/" }));
      yield* service.refresh;
      yield* writeRuntime(runtimeJson({ instanceId: null, startedAt: "2026-10-12T11:00:00.000Z" }));
      yield* service.refresh;
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);
      expect(calls).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("publishes nothing when the listener changes while the session is issued", () =>
    Effect.gen(function* () {
      const { service, calls, writeRuntime } = yield* setup({
        listener: (request) => (request === 1 ? {} : { instanceId: "a-later-start" }),
      });
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;
      expect(calls).toHaveLength(1);
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("detaches once the listener stops answering as the recorded server", () =>
    Effect.gen(function* () {
      let replaced = false;
      const { service, writeRuntime } = yield* setup({
        listener: () => (replaced ? { instanceId: "a-later-start" } : {}),
      });
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;
      expect(Option.isSome(yield* service.bootstrap)).toBe(true);

      replaced = true;
      yield* service.refresh;
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("detaches a session kept through a failed renewal once the listener changes", () =>
    Effect.gen(function* () {
      let replaced = false;
      const { service, calls, writeRuntime } = yield* setup({
        listener: () => (replaced ? { instanceId: "a-later-start" } : {}),
        // The first session is inside the renewal margin; renewing it fails.
        expiresAt: (call) => (call === 1 ? "1970-01-01T01:00:00.000Z" : null),
      });
      yield* writeRuntime(runtimeJson({}));
      yield* service.refresh;
      yield* service.refresh;
      expect(calls).toHaveLength(2);
      expect(Option.getOrThrow(yield* service.bootstrap).accessToken).toBe("token-1");

      replaced = true;
      yield* service.refresh;
      expect(Option.isNone(yield* service.bootstrap)).toBe(true);
      expect(calls).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("compares Windows state paths without case or separator style", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { sameDirectory } = DesktopHeadlessServer;
      expect(
        sameDirectory(
          "C:\\Users\\Jun\\.goat\\userdata",
          "c:/users/jun/.GOAT/userdata\\",
          "win32",
          path,
        ),
      ).toBe(true);
      expect(
        sameDirectory("/Users/jun/.goat/userdata", "/users/jun/.goat/userdata", "darwin", path),
      ).toBe(false);
    }),
  );
});
