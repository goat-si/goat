import {
  envOutput,
  makeProcess,
  makeHungProcess,
  runShellEnvironment,
} from "./DesktopShellEnvironment.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off -- The process fixture runs real shell commands with isolated config files.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

vi.mock("node:os", { spy: true });

const cacheCodec = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    key: Schema.String,
    environment: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  }),
);
const encodeCache = Schema.encodeSync(cacheCodec);
const decodeCache = Schema.decodeUnknownEffect(cacheCodec);
// The fixture home is /test-home; these always follow whatever the shell and launcher gave.
const DARWIN_CLI_DIRS =
  "/test-home/.local/bin:/test-home/.bun/bin:/opt/homebrew/bin:/usr/local/bin";
const LINUX_CLI_DIRS =
  "/test-home/.local/bin:/test-home/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin";

describe("DesktopShellEnvironment", () => {
  it.effect.each([
    { platform: "linux" as const, runtime: { APPDIR: "/opt/t3.AppDir/" }, scrub: true },
    { platform: "linux" as const, runtime: { APPIMAGE: "/opt/T3.AppImage" }, scrub: true },
    { platform: "linux" as const, runtime: {}, scrub: false },
    { platform: "darwin" as const, runtime: { APPDIR: "/opt/t3.AppDir/" }, scrub: false },
  ])(
    "keeps AppImage mounts out of cached and discovered PATH: %j",
    ({ platform, runtime, scrub }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const cachePath = `${stateDir}/shell-environment-cache.json`;
        const inheritedPath =
          "/tmp/.mount_T3-Codold123/usr/bin:/launcher/bin:/opt/t3.AppDir/usr/bin";
        const cachedPath = "/cached/bin:/tmp/.mount_T3-Codcache1/usr/bin";
        const discoveredPath = "/fresh/bin:/tmp/.mount_GOATprobe1/usr/bin";
        const retainedPath = "/tmp/tools:/tmp/.mount_Other123/usr/bin:/opt/t3.AppDir-backup/bin";
        const cleanInherited = scrub
          ? `/launcher/bin${runtime.APPDIR ? "" : ":/opt/t3.AppDir/usr/bin"}`
          : inheritedPath;
        const cleanCached = scrub ? "/cached/bin" : cachedPath;
        const cleanDiscovered = scrub ? "/fresh/bin" : discoveredPath;
        const env: NodeJS.ProcessEnv = {
          ...runtime,
          SHELL: "/bin/bash",
          PATH: `${inheritedPath}:${retainedPath}`,
        };
        yield* fs.writeFileString(
          cachePath,
          encodeCache({
            version: 1,
            key: JSON.stringify([platform, "/test-home", "/bin/bash", ""]),
            environment: { PATH: cachedPath, __MISE_DIFF: "cached-mise" },
          }),
        );
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const probePath = yield* Deferred.make<string | undefined>();
        yield* runShellEnvironment({
          env,
          platform,
          stateDir,
          handler: () => "",
          processSpawner: ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              const value =
                command._tag === "StandardCommand" ? command.options.env?.PATH : undefined;
              const path = typeof value === "string" ? value : undefined;
              yield* Deferred.succeed(probePath, path);
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return makeProcess(
                envOutput({ PATH: `${discoveredPath}:${path}`, __MISE_DIFF: "fresh-mise" }),
              );
            }),
          ),
          use: (service) =>
            Effect.gen(function* () {
              yield* service.installIntoProcess;
              const extra =
                platform === "linux" ? "/home/linuxbrew/.linuxbrew/bin" : "/opt/homebrew/bin";
              const suffix = `:/test-home/.local/bin:/test-home/.bun/bin:${extra}:/usr/local/bin`;
              const expectedCached = `${cleanCached}:${cleanInherited}:${retainedPath}${suffix}`;
              assert.equal(env.PATH, expectedCached);
              assert.equal(env.__MISE_DIFF, "cached-mise");
              const cached = yield* Stream.runHead(service.updates);
              assert.equal(Option.getOrThrow(cached).environment.PATH, expectedCached);
              yield* Deferred.await(started);
              assert.equal(yield* Deferred.await(probePath), `${cleanInherited}:${retainedPath}`);
              yield* Deferred.succeed(release, undefined);
              yield* service.awaitDiscovery;
              const expectedFresh = `${cleanDiscovered}:${cleanInherited}:${retainedPath}${suffix}`;
              assert.equal(env.PATH, expectedFresh);
              assert.equal(env.__MISE_DIFF, "fresh-mise");
              const fresh = yield* Stream.runHead(service.updates);
              assert.equal(Option.getOrThrow(fresh).environment.PATH, expectedFresh);
              return true;
            }),
        });
        const cached = yield* fs.readFileString(cachePath).pipe(Effect.flatMap(decodeCache));
        assert.equal(
          cached.environment.PATH,
          `${cleanDiscovered}:${cleanInherited}:${retainedPath}`,
        );
        assert.equal(cached.environment.__MISE_DIFF, "fresh-mise");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { platform: "darwin" as const, env: { PATH: "/usr/bin" }, expectedPath: "/usr/bin" },
    {
      platform: "linux" as const,
      env: { APPDIR: "/tmp/.mount_T3-Codnew123", PATH: ":/tmp/.mount_T3-Codold123/bin::/usr/bin:" },
      expectedPath: "::/usr/bin:",
    },
    {
      platform: "linux" as const,
      env: { APPDIR: "/tmp/.mount_T3-Codnew123", PATH: "/tmp/.mount_T3-Codnew123/bin" },
      expectedPath: undefined,
    },
  ])(
    "does not wait for discovery when the cache is missing: %j",
    ({ platform, env: initial, expectedPath }) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const env: NodeJS.ProcessEnv = { SHELL: "/test-shell", ...initial };
        let probePath: string | undefined;
        yield* runShellEnvironment({
          env,
          platform,
          handler: () => "",
          processSpawner: ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              const value =
                command._tag === "StandardCommand" ? command.options.env?.PATH : undefined;
              probePath = typeof value === "string" ? value : undefined;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return makeProcess(envOutput({ PATH: "/fresh/bin" }));
            }),
          ),
          use: (service) =>
            Effect.gen(function* () {
              const startup = yield* service.installIntoProcess.pipe(Effect.forkChild);
              yield* Deferred.await(started);
              assert.isDefined(startup.pollUnsafe());
              const extra =
                platform === "linux" ? "/home/linuxbrew/.linuxbrew/bin" : "/opt/homebrew/bin";
              const suffix = `/test-home/.local/bin:/test-home/.bun/bin:${extra}:/usr/local/bin`;
              assert.equal(
                env.PATH,
                expectedPath === undefined ? undefined : `${expectedPath}:${suffix}`,
              );
              assert.equal(probePath, expectedPath);
              yield* Deferred.succeed(release, undefined);
              return yield* service.awaitDiscovery;
            }),
        });
      }),
  );

  it.effect(
    "reuses cached paths immediately and streams fresh discovery without keeping removed paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const first = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
        yield* runShellEnvironment({
          env: first,
          stateDir,
          platform: "darwin",
          handler: () =>
            envOutput({
              PATH: "/old/bin:/usr/bin",
              __MISE_DIFF: "old-mise",
              SSH_AUTH_SOCK: "/old-session.sock",
              JAVA_HOME: "/old/java",
              SSL_CERT_FILE: "/old/cert.pem",
            }),
        });
        const cachePath = `${stateDir}/shell-environment-cache.json`;
        const cached = yield* fs.readFileString(cachePath).pipe(Effect.flatMap(decodeCache));
        assert.equal(cached.environment.PATH, "/old/bin:/usr/bin");
        assert.notProperty(cached.environment, "SSH_AUTH_SOCK");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const env: NodeJS.ProcessEnv = {
          SHELL: "/bin/zsh",
          PATH: "/launcher/bin",
          SSH_AUTH_SOCK: "/current-session.sock",
        };
        let calls = 0;
        yield* runShellEnvironment({
          env,
          stateDir,
          platform: "darwin",
          handler: () => "",
          processSpawner: ChildProcessSpawner.make((command) => {
            calls++;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  assert.equal(command._tag, "StandardCommand");
                  if (command._tag !== "StandardCommand") return makeProcess("");
                  assert.equal(command.options.env?.PATH, "/launcher/bin");
                  return makeProcess(
                    envOutput({ PATH: "/fresh/bin:/launcher/bin", __MISE_DIFF: "fresh-mise" }),
                  );
                }),
              ),
            );
          }),
          use: (service) =>
            Effect.gen(function* () {
              yield* service.installIntoProcess;
              yield* service.installIntoProcess;
              assert.equal(env.PATH, `/old/bin:/usr/bin:/launcher/bin:${DARWIN_CLI_DIRS}`);
              assert.equal(env.SSH_AUTH_SOCK, "/current-session.sock");
              const replay = yield* Stream.runHead(service.updates);
              assert.isTrue(Option.isSome(replay));
              if (Option.isSome(replay))
                assert.equal(replay.value.environment.__MISE_DIFF, "old-mise");
              yield* Deferred.await(started);
              assert.equal(calls, 1);
              yield* Deferred.succeed(release, undefined);
              yield* service.awaitDiscovery;
              assert.equal(env.PATH, `/fresh/bin:/launcher/bin:${DARWIN_CLI_DIRS}`);
              assert.equal(env.__MISE_DIFF, "fresh-mise");
              assert.isUndefined(env.JAVA_HOME);
              assert.isUndefined(env.SSL_CERT_FILE);
              const fresh = yield* Stream.runHead(service.updates);
              assert.isTrue(Option.isSome(fresh));
              if (Option.isSome(fresh)) {
                assert.equal(fresh.value.environment.PATH, env.PATH);
                assert.isTrue(fresh.value.discovered);
              }
              return true;
            }),
        });
        const refreshed = yield* fs.readFileString(cachePath).pipe(Effect.flatMap(decodeCache));
        assert.equal(refreshed.environment.PATH, "/fresh/bin:/launcher/bin");
        assert.notProperty(refreshed.environment, "JAVA_HOME");
        assert.notProperty(refreshed.environment, "SSL_CERT_FILE");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    "not json",
    '{"version":2,"key":"old","environment":{"PATH":"/bad/bin"}}',
    '{"version":1,"key":"other-shell","environment":{"PATH":"/bad/bin"}}',
  ])("ignores an unusable cache and still starts before discovery: %s", (contents) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${stateDir}/shell-environment-cache.json`, contents);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      yield* runShellEnvironment({
        env,
        stateDir,
        platform: "darwin",
        handler: () => "",
        processSpawner: ChildProcessSpawner.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(makeProcess(envOutput({ PATH: "/fresh/bin" }))),
          ),
        ),
        use: (service) =>
          Effect.gen(function* () {
            const startup = yield* service.installIntoProcess.pipe(Effect.forkChild);
            yield* Deferred.await(started);
            assert.isDefined(startup.pollUnsafe());
            // The server may start now, before any snapshot: it already has the well-known folders.
            assert.equal(env.PATH, `/usr/bin:${DARWIN_CLI_DIRS}`);
            yield* Deferred.succeed(release, undefined);
            return yield* service.awaitDiscovery;
          }),
      });
      assert.equal(env.PATH, `/fresh/bin:/usr/bin:${DARWIN_CLI_DIRS}`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains the last successful cache on refresh failure and ignores session values in the cache",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const contents = encodeCache({
          version: 1,
          key: '["darwin","/test-home","/bin/zsh",""]',
          environment: {
            PATH: "/cached/bin",
            __MISE_DIFF: "cached-mise",
            JAVA_HOME: "/cached/java",
            NODE_EXTRA_CA_CERTS: "/cached/ca.pem",
            SSL_CERT_FILE: "/cached/cert.pem",
            SSL_CERT_DIR: "/cached/certs",
            SSH_AUTH_SOCK: "/stale.sock",
            NODE_OPTIONS: "--bad",
          },
        });
        const cachePath = `${stateDir}/shell-environment-cache.json`;
        yield* fs.writeFileString(cachePath, contents);
        const env: NodeJS.ProcessEnv = {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin",
          __MISE_DIFF: "launcher-mise",
          JAVA_HOME: "/launcher/java",
          NODE_EXTRA_CA_CERTS: "/launcher/ca.pem",
          SSL_CERT_FILE: "",
          SSH_AUTH_SOCK: "/current.sock",
        };
        const prepared = yield* runShellEnvironment({
          env,
          stateDir,
          platform: "darwin",
          handler: () => "",
          use: (service) =>
            Effect.gen(function* () {
              yield* service.installIntoProcess;
              const replay = yield* Stream.runHead(service.updates);
              assert.isTrue(Option.isSome(replay));
              if (Option.isSome(replay)) {
                assert.equal(replay.value.environment.JAVA_HOME, "/launcher/java");
                assert.equal(replay.value.environment.NODE_EXTRA_CA_CERTS, "/launcher/ca.pem");
              }
              return yield* service.awaitDiscovery;
            }),
        });
        assert.isFalse(prepared);
        assert.equal(env.PATH, `/cached/bin:/usr/bin:${DARWIN_CLI_DIRS}`);
        assert.equal(env.__MISE_DIFF, "cached-mise");
        assert.equal(env.JAVA_HOME, "/launcher/java");
        assert.equal(env.NODE_EXTRA_CA_CERTS, "/launcher/ca.pem");
        assert.equal(env.SSL_CERT_FILE, "");
        assert.equal(env.SSL_CERT_DIR, "/cached/certs");
        assert.equal(env.SSH_AUTH_SOCK, "/current.sock");
        assert.isUndefined(env.NODE_OPTIONS);
        assert.equal(yield* fs.readFileString(cachePath), contents);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels background discovery when the application scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      yield* runShellEnvironment({
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
        platform: "darwin",
        handler: () => "",
        processSpawner: ChildProcessSpawner.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        ),
        use: (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            yield* Deferred.await(started);
            return true;
          }),
      });
      yield* Deferred.await(stopped);
    }),
  );

  it.effect(
    "captures the login-shell PATH when startup writes more than a pipe buffer to stderr",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
          Effect.provide(NodeServices.layer),
        );
        const executable = yield* HostProcess.ExecutablePath;
        const env: NodeJS.ProcessEnv = { SHELL: "/test-shell", PATH: "/usr/bin" };
        const commands: string[] = [];
        const source = [
          "process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 120), () => {",
          `process.stdout.write(${JSON.stringify(envOutput({ PATH: "/shell-only/bin:/usr/bin" }))});`,
          "});",
        ].join("\n");

        yield* runShellEnvironment({
          env,
          platform: "linux",
          handler: () => "",
          processSpawner: ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return Effect.succeed(makeProcess(""));
            commands.push(command.command);
            return command.command === "/test-shell"
              ? spawner.spawn(ChildProcess.make(executable, ["-e", source], command.options))
              : Effect.succeed(makeProcess(""));
          }),
        }).pipe(Effect.provide(Logger.layer([])));

        assert.equal(env.PATH, `/shell-only/bin:/usr/bin:${LINUX_CLI_DIRS}`);
        assert.deepEqual(commands, ["/test-shell"]);
      }),
  );

  it.effect("rejects PATH output from a failed shell and tries the next candidate", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/failing", PATH: "/usr/bin" };
      const commands: string[] = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        userShell: "/usr/local/bin/fish",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          return command.command === "/bin/failing"
            ? { output: envOutput({ PATH: "/failed/bin" }), exitCode: 7 }
            : envOutput({ PATH: "/home/test/.local/bin:/usr/bin" });
        },
      }).pipe(Effect.provide(Logger.layer([])));

      assert.deepEqual(commands, ["/bin/failing", "/usr/local/bin/fish"]);
      assert.equal(env.PATH, `/home/test/.local/bin:/usr/bin:${LINUX_CLI_DIRS}`);
    }),
  );

  it.effect("keeps literal whitespace and quotes in a POSIX login PATH", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () => envOutput({ PATH: ' /fixture path :"/literal"' }),
      });
      assert.isTrue(env.PATH?.startsWith(' /fixture path :"/literal":/usr/bin:') ?? false);
    }),
  );

  it.effect("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/Users/test/.local/bin:/usr/bin",
      };
      const commands: ChildProcess.Command[] = [];

      const prepared = yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: (command) => {
          commands.push(command);
          return envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            SSH_AUTH_SOCK: "/tmp/secretive.sock",
            HOMEBREW_PREFIX: "/opt/homebrew",
          });
        },
      });

      assert.equal(commands.length, 1);
      assert.equal(commands[0]?._tag === "StandardCommand" ? commands[0].command : "", "/bin/zsh");
      assert.equal(
        env.PATH,
        "/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin:/test-home/.local/bin:/test-home/.bun/bin:/usr/local/bin",
      );
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/secretive.sock");
      assert.equal(env.HOMEBREW_PREFIX, "/opt/homebrew");
      assert.isTrue(prepared);
    }),
  );

  it.effect.each(["darwin", "win32"] as const)(
    "loads a release mirror from the login shell on %s",
    (platform) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
        yield* runShellEnvironment({
          env,
          platform,
          handler: () =>
            envOutput({
              PATH: "/usr/bin",
              GOAT_RELEASE_BASE_URL: "https://mirror.example/releases",
            }),
        });
        assert.equal(env.GOAT_RELEASE_BASE_URL, "https://mirror.example/releases");
      }),
  );

  it.effect("rejects shell mirror credentials before publishing the shell patch", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/usr/bin",
            GOAT_RELEASE_BASE_URL: "https://name:secret@mirror.example/releases",
          }),
        use: (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            yield* service.awaitDiscovery;
            const snapshot = yield* Stream.runHead(service.updates);
            assert.isTrue(Option.isSome(snapshot));
            if (Option.isSome(snapshot))
              assert.notInclude(JSON.stringify(snapshot.value), "secret");
            return true;
          }),
      });
      assert.isUndefined(env.GOAT_RELEASE_BASE_URL);
    }),
  );

  it.effect("does not mix login-shell locale categories into an inherited locale", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            LC_ALL: "de_DE.UTF-8",
          }),
      });

      assert.equal(env.LANG, "en_US.UTF-8");
      assert.equal(env.LC_ALL, undefined);
    }),
  );

  it.effect("falls back to a UTF-8 LC_CTYPE when no locale is available on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () => envOutput({ PATH: "/opt/homebrew/bin:/usr/bin" }),
      });

      assert.equal(env.LANG, undefined);
      assert.equal(env.LC_ALL, undefined);
      assert.equal(env.LC_CTYPE, "en_US.UTF-8");
    }),
  );

  it.effect("hydrates missing CA trust variables from the login shell", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        SSL_CERT_DIR: "/etc/ssl/certs",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/zerobrew/bin:/usr/bin",
            SSL_CERT_FILE: "/opt/zerobrew/etc/ca-certificates/cacert.pem",
            SSL_CERT_DIR: "/opt/zerobrew/etc/ca-certificates",
            NODE_EXTRA_CA_CERTS: "/Users/me/corp-root.pem",
          }),
      });

      assert.equal(env.SSL_CERT_FILE, "/opt/zerobrew/etc/ca-certificates/cacert.pem");
      assert.equal(env.SSL_CERT_DIR, "/etc/ssl/certs");
      assert.equal(env.NODE_EXTRA_CA_CERTS, "/Users/me/corp-root.pem");
    }),
  );

  it.effect.each([
    {
      name: "hydrates both Android SDK names when neither is inherited",
      inherited: {},
      expected: { ANDROID_HOME: "/shell/android-home", ANDROID_SDK_ROOT: "/shell/android-root" },
    },
    {
      // The device host reads ANDROID_HOME before ANDROID_SDK_ROOT, so a shell
      // ANDROID_HOME next to an inherited ANDROID_SDK_ROOT would change the SDK.
      name: "keeps an inherited ANDROID_SDK_ROOT selected over a login-shell ANDROID_HOME",
      inherited: { ANDROID_SDK_ROOT: "/inherited/android-sdk" },
      expected: { ANDROID_HOME: undefined, ANDROID_SDK_ROOT: "/inherited/android-sdk" },
    },
  ])("$name", ({ inherited, expected }) =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", ...inherited };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/usr/bin",
            ANDROID_HOME: "/shell/android-home",
            ANDROID_SDK_ROOT: "/shell/android-root",
          }),
      });

      assert.equal(env.ANDROID_HOME, expected.ANDROID_HOME);
      assert.equal(env.ANDROID_SDK_ROOT, expected.ANDROID_SDK_ROOT);
    }),
  );

  it.effect("keeps mise's PATH record with the login shell PATH", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/bash",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            __MISE_DIFF: "mise-diff",
          }),
      });

      assert.equal(env.__MISE_DIFF, "mise-diff");
    }),
  );

  it.effect("falls back to launchctl PATH on macOS when shell probing does not return one", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/opt/homebrew/bin/nu",
        PATH: "/usr/bin",
      };
      const commands: string[] = [];

      const prepared = yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          return command.command === "/bin/launchctl" ? "/opt/homebrew/bin:/usr/bin" : "";
        },
      });

      assert.deepEqual(commands, ["/opt/homebrew/bin/nu", "/bin/zsh", "/bin/launchctl"]);
      assert.equal(
        env.PATH,
        "/opt/homebrew/bin:/usr/bin:/test-home/.local/bin:/test-home/.bun/bin:/usr/local/bin",
      );
      assert.isFalse(prepared);
    }),
  );

  it.effect("waits ten seconds for a slow login shell on macOS before giving up on it", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const started = yield* Deferred.make<void>();
      const fiber = yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () => "",
        processSpawner: ChildProcessSpawner.make((command) =>
          command._tag === "StandardCommand" && command.command === "/bin/zsh"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.sleep("7 seconds")),
                Effect.as(makeProcess(envOutput({ PATH: "/slow-shell/bin" }))),
              )
            : Effect.succeed(makeProcess("")),
        ),
      }).pipe(Effect.provide(Logger.layer([])), Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(started);
      yield* TestClock.adjust("7 seconds");
      assert.isTrue(yield* Fiber.join(fiber));
      assert.equal(env.PATH, `/slow-shell/bin:/usr/bin:${DARWIN_CLI_DIRS}`);
    }),
  );

  it.effect("leaves macOS preparation incomplete when no login shell returns a PATH", () =>
    Effect.gen(function* () {
      const prepared = yield* runShellEnvironment({
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        platform: "darwin",
        handler: () => "",
      });

      assert.isFalse(prepared);
    }),
  );

  it.effect(
    "uses a fallback shell's PATH without ending discovery, then finishes when the person's shell answers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const cachePath = `${stateDir}/shell-environment-cache.json`;
        const env: NodeJS.ProcessEnv = { SHELL: "/usr/local/bin/fish", PATH: "/usr/bin" };
        const firstProbe = yield* Deferred.make<void>();
        const cacheWritten = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<void>();
        let ownShellProbes = 0;
        yield* runShellEnvironment({
          env,
          stateDir,
          cacheWritten,
          platform: "darwin",
          handler: () => "",
          processSpawner: ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return Effect.succeed(makeProcess(""));
            if (command.command === "/bin/zsh")
              return Effect.succeed(makeProcess(envOutput({ PATH: "/fallback/bin" })));
            if (command.command !== "/usr/local/bin/fish") return Effect.succeed(makeProcess(""));
            ownShellProbes++;
            return ownShellProbes === 1
              ? Deferred.succeed(firstProbe, undefined).pipe(
                  Effect.andThen(
                    // Gone 20 s after the kill, before the retry is due.
                    Effect.acquireRelease(Effect.succeed(makeHungProcess(exited)), () =>
                      Effect.sleep("20 seconds").pipe(
                        Effect.andThen(Deferred.succeed(exited, undefined)),
                      ),
                    ),
                  ),
                )
              : Effect.succeed(makeProcess(envOutput({ PATH: "/own/bin" })));
          }),
          use: (service) =>
            Effect.gen(function* () {
              yield* service.installIntoProcess;
              yield* Deferred.await(firstProbe);
              yield* TestClock.adjust("10 seconds");
              assert.isFalse(yield* service.awaitDiscovery);
              const pending = Option.getOrUndefined(yield* Stream.runHead(service.updates));
              assert.isFalse(pending?.discovered);
              assert.equal(pending?.environment.PATH, `/fallback/bin:/usr/bin:${DARWIN_CLI_DIRS}`);
              assert.isFalse(yield* Effect.orDie(fs.exists(cachePath)));

              yield* TestClock.adjust("30 seconds");
              assert.equal(ownShellProbes, 2);
              const recovered = yield* service.updates.pipe(
                Stream.filter((snapshot) => snapshot.discovered),
                Stream.runHead,
              );
              assert.equal(
                Option.getOrUndefined(recovered)?.environment.PATH,
                `/own/bin:/usr/bin:${DARWIN_CLI_DIRS}`,
              );
              yield* Deferred.await(cacheWritten);
              const cached = yield* fs
                .readFileString(cachePath)
                .pipe(Effect.flatMap(decodeCache), Effect.orDie);
              assert.equal(cached.environment.PATH, "/own/bin:/usr/bin");
              return true;
            }),
        }).pipe(Effect.provide(Logger.layer([])));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps a good cache when only a fallback shell answers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const cachePath = `${stateDir}/shell-environment-cache.json`;
      const contents = encodeCache({
        version: 1,
        key: '["darwin","/test-home","/usr/local/bin/fish",""]',
        environment: { PATH: "/own-cached/bin" },
      });
      yield* fs.writeFileString(cachePath, contents);
      const env: NodeJS.ProcessEnv = { SHELL: "/usr/local/bin/fish", PATH: "/usr/bin" };
      const prepared = yield* runShellEnvironment({
        env,
        stateDir,
        platform: "darwin",
        handler: (command) =>
          command._tag === "StandardCommand" && command.command === "/bin/zsh"
            ? envOutput({ PATH: "/fallback/bin" })
            : { output: "", exitCode: 1 },
      }).pipe(Effect.provide(Logger.layer([])));

      assert.isFalse(prepared);
      assert.equal(env.PATH, `/own-cached/bin:/usr/bin:${DARWIN_CLI_DIRS}`);
      assert.equal(yield* fs.readFileString(cachePath), contents);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("loads PowerShell profile environment on Windows", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows\\System32",
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      };

      const prepared = yield* runShellEnvironment({
        env,
        platform: "win32",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          const loadProfile = !command.args.includes("-NoProfile");
          return loadProfile
            ? envOutput({
                PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
                FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
                FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
              })
            : envOutput({ PATH: 'C:\\Custom\\Bin;C:";C:\\Windows\\System32' });
        },
      });

      assert.isTrue(prepared);
      assert.equal(
        env.PATH,
        [
          "C:\\Profile\\Node",
          "C:\\Windows\\System32",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Custom\\Bin",
          "C:",
        ].join(";"),
      );
      assert.equal(env.FNM_DIR, "C:\\Users\\testuser\\AppData\\Roaming\\fnm");
      assert.equal(
        env.FNM_MULTISHELL_PATH,
        "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      );
    }),
  );

  it.effect.each([false, true])(
    "leaves Windows preparation incomplete when loadProfile=%s fails",
    (loadProfile) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };
        let calls = 0;
        const prepared = yield* runShellEnvironment({
          env,
          platform: "win32",
          handler: (command) => {
            calls++;
            if (command._tag !== "StandardCommand") return "";
            return !command.args.includes("-NoProfile") === loadProfile
              ? { output: "", exitCode: 1 }
              : envOutput({ PATH: "C:\\Working" });
          },
        }).pipe(Effect.provide(Logger.layer([])));
        assert.isFalse(prepared);
        assert.equal(calls, 3);
        assert.include(env.PATH, "C:\\Working");
        assert.include(env.PATH, "C:\\Windows\\System32");
      }),
  );

  it.effect("gives up on a Windows shell that survives the kill", () =>
    Effect.gen(function* () {
      const commands: Array<string> = [];
      // Both PowerShell probes spawn pwsh, time out, then spawn powershell. Each probe's timeout
      // is armed before its spawn runs, so waiting for the spawns keeps the clock in step.
      const spawned = yield* Effect.forEach([0, 1, 2, 3], () => Deferred.make<void>());
      const fiber = yield* runShellEnvironment({
        env: { PATH: "C:\\Windows", APPDATA: "C:\\Roaming" },
        platform: "win32",
        handler: () => "",
        processSpawner: ChildProcessSpawner.make((command) => {
          const spawn = spawned[commands.length];
          commands.push(command._tag === "StandardCommand" ? command.command : "");
          return (spawn ? Deferred.succeed(spawn, undefined) : Effect.void).pipe(
            Effect.andThen(
              Effect.acquireRelease(Effect.succeed(makeHungProcess()), () => Effect.never),
            ),
          );
        }),
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.forEach(spawned.slice(0, 2), Deferred.await);
      yield* TestClock.adjust("5 seconds");
      yield* Effect.forEach(spawned.slice(2), Deferred.await);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);
      assert.deepEqual([...new Set(commands)], ["pwsh.exe", "powershell.exe"]);
    }),
  );

  it.effect("keeps Windows telemetry opt-outs over inherited opt-ins", () =>
    Effect.gen(function* () {
      for (const [name, inherited, discovered, expected] of [
        ["GOAT_TELEMETRY_ENABLED", undefined, "false", "false"],
        ["GOAT_TELEMETRY_ENABLED", "true", "false", "false"],
        ["GOAT_TELEMETRY_ENABLED", "false", "true", "false"],
        ["T3CODE_TELEMETRY_ENABLED", "true", "false", "false"],
      ] as const) {
        const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows", [name]: inherited };
        yield* runShellEnvironment({
          env,
          platform: "win32",
          handler: (command) => {
            const capture = command._tag === "StandardCommand" ? String(command.args.at(-1)) : "";
            if (capture.includes(name)) {
              assert.match(capture, /GetEnvironmentVariable\('[^']+','User'\)/);
              assert.include(capture, "-notin");
              return envOutput({ PATH: "C:\\Windows", [name]: discovered });
            }
            return envOutput({ PATH: "C:\\Windows" });
          },
        });
        assert.equal(env[name], expected);
      }
    }),
  );

  it.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32" };

      yield* runShellEnvironment({
        env,
        platform: "win32",
        handler: (command) =>
          command._tag === "StandardCommand" && command.args.includes("-NoProfile")
            ? envOutput({ PATH: "C:\\Shell\\Bin" })
            : "",
      });

      assert.deepEqual(env, { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" });
    }),
  );

  it.effect("prefers login-shell desktop session hints over inherited values on linux", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        XDG_CURRENT_DESKTOP: "wrong-launcher",
        XDG_SESSION_DESKTOP: "wrong-launcher",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
            XDG_CURRENT_DESKTOP: "KDE",
            XDG_SESSION_DESKTOP: "KDE",
            XDG_SESSION_TYPE: "wayland",
          }),
      });

      assert.equal(env.XDG_CURRENT_DESKTOP, "KDE");
      assert.equal(env.XDG_SESSION_DESKTOP, "KDE");
      assert.equal(env.XDG_SESSION_TYPE, "wayland");
    }),
  );
});
