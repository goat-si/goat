import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { signMacArchiveContents } from "./build-cli-archive.ts";
import {
  NotarytoolSubmitError,
  isNotarytoolSubmitError,
  notarytoolAuthArgs,
  parseNotarytoolSubmitOutput,
  resolveMacNotarizationEnv,
} from "./lib/mac-notarization.ts";

const requiredMac = { signed: true, platform: "mac", requireNotarization: true };
const apiEnv = { APPLE_API_KEY: "/key.p8", APPLE_API_KEY_ID: "key-id", APPLE_API_ISSUER: "issuer" };
const appleIdEnv = {
  APPLE_ID: "apple@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "password",
  APPLE_TEAM_ID: "TEAMID",
};
const apiConfig = { appleApiKey: "/key.p8", appleApiKeyId: "key-id", appleApiIssuer: "issuer" };

describe("resolveMacNotarizationEnv", () => {
  it("gives the profile precedence and scrubs every competing credential without mutating input", () => {
    const env = {
      ...apiEnv,
      ...appleIdEnv,
      APPLE_KEYCHAIN_PROFILE: "goat-notary",
      APPLE_KEYCHAIN: "/login.keychain-db",
      GOAT_APPLE_TEAM_ID: "TEAMID",
      CSC_NAME: "Developer ID",
    };
    const result = resolveMacNotarizationEnv(env, requiredMac);
    assert.deepEqual(result, {
      env: {
        APPLE_KEYCHAIN_PROFILE: "goat-notary",
        APPLE_KEYCHAIN: "/login.keychain-db",
        GOAT_APPLE_TEAM_ID: "TEAMID",
        CSC_NAME: "Developer ID",
      },
      problem: undefined,
    });
    assert.equal(env.APPLE_API_KEY, apiEnv.APPLE_API_KEY);
    assert.equal(env.APPLE_TEAM_ID, appleIdEnv.APPLE_TEAM_ID);
  });

  it("accepts a complete API trio or Apple-ID trio without a profile", () => {
    for (const env of [apiEnv, appleIdEnv]) {
      assert.deepEqual(resolveMacNotarizationEnv(env, requiredMac), { env, problem: undefined });
    }
  });

  it("rejects missing, incomplete, or blank credentials in required mode", () => {
    for (const env of [
      {},
      { APPLE_KEYCHAIN: "/keychain" },
      { APPLE_KEYCHAIN_PROFILE: " " },
      { ...apiEnv, APPLE_API_ISSUER: undefined },
      { ...appleIdEnv, APPLE_TEAM_ID: " " },
      { APPLE_API_KEY: "/key", APPLE_APP_SPECIFIC_PASSWORD: "password" },
    ]) {
      assert.isString(resolveMacNotarizationEnv(env, requiredMac).problem);
    }
  });

  it("permits optional notarization and leaves unsigned or non-Mac environments alone", () => {
    assert.isUndefined(
      resolveMacNotarizationEnv({}, { ...requiredMac, requireNotarization: false }).problem,
    );
    const env = { ...apiEnv, ...appleIdEnv, APPLE_KEYCHAIN_PROFILE: "goat-notary" };
    for (const options of [
      { ...requiredMac, signed: false },
      { ...requiredMac, platform: "linux" },
      { ...requiredMac, platform: "win" },
    ]) {
      assert.deepEqual(resolveMacNotarizationEnv(env, options), { env, problem: undefined });
    }
  });
});

describe("notarytoolAuthArgs", () => {
  it("prefers the profile and optional keychain over complete API credentials", () => {
    assert.deepEqual(
      notarytoolAuthArgs({
        ...apiConfig,
        appleKeychainProfile: " goat-notary ",
        appleKeychain: " /login.keychain-db ",
      }),
      ["--keychain-profile", "goat-notary", "--keychain", "/login.keychain-db"],
    );
    assert.deepEqual(notarytoolAuthArgs({ appleKeychainProfile: "goat-notary" }), [
      "--keychain-profile",
      "goat-notary",
    ]);
  });

  it("falls back to the complete API trio", () => {
    assert.deepEqual(notarytoolAuthArgs({ ...apiConfig, appleKeychainProfile: " " }), [
      "--key",
      "/key.p8",
      "--key-id",
      "key-id",
      "--issuer",
      "issuer",
    ]);
  });

  it("returns undefined for missing or incomplete credentials", () => {
    for (const config of [
      {},
      { appleKeychain: "/login.keychain-db" },
      { ...apiConfig, appleApiKey: " " },
      { ...apiConfig, appleApiKeyId: undefined },
      { ...apiConfig, appleApiIssuer: undefined },
    ]) {
      assert.isUndefined(notarytoolAuthArgs(config));
    }
  });
});

describe("parseNotarytoolSubmitOutput", () => {
  it("returns the id and Accepted status", () => {
    assert.deepEqual(
      parseNotarytoolSubmitOutput('{"id":"submission-id","status":"Accepted","message":"ok"}'),
      { id: "submission-id", status: "Accepted" },
    );
  });

  it("rejects Invalid, pending, and unknown statuses with a typed error carrying id and status", () => {
    for (const status of ["Invalid", "In Progress", "Rejected", "accepted"]) {
      const error = assert.throws(
        () => parseNotarytoolSubmitOutput(JSON.stringify({ id: "submission-id", status })),
        NotarytoolSubmitError,
      );
      assert.isTrue(isNotarytoolSubmitError(error));
      if (!isNotarytoolSubmitError(error)) return;
      assert.equal(error.id, "submission-id");
      assert.equal(error.status, status);
    }
  });

  it("rejects garbage or incomplete JSON with a typed error", () => {
    for (const json of [
      "garbage",
      "null",
      "[]",
      "{}",
      '{"status":"Accepted"}',
      '{"id":"id"}',
      '{"id":"","status":"Accepted"}',
      '{"id":12,"status":"Accepted"}',
    ]) {
      assert.throws(() => parseNotarytoolSubmitOutput(json), NotarytoolSubmitError);
    }
  });
});

function mockProcess(stdout = "", exitCode = 0, stderr = "") {
  const encoder = new TextEncoder();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const contentDir = "/stage/goat-version-darwin-arm64";
const signInput = {
  repoRoot: "/repo",
  contentDir,
  executablePath: `${contentDir}/goat`,
  requireNotarization: true,
};

function signingFixture(
  options: {
    readonly env?: Record<string, string>;
    readonly submit?: string;
    readonly submitExitCode?: number;
    readonly logExitCode?: number;
  } = {},
) {
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let cleaned = false;
  const spawner = ChildProcessSpawner.make((command) => {
    assert.isTrue(ChildProcess.isStandardCommand(command));
    if (!ChildProcess.isStandardCommand(command)) {
      return Effect.die("Unexpected piped command");
    }
    commands.push({ command: command.command, args: command.args });
    return Effect.succeed(
      command.args[1] === "submit"
        ? mockProcess(
            options.submit ?? '{"id":"submission-id","status":"Accepted"}',
            options.submitExitCode,
          )
        : command.args[1] === "log"
          ? mockProcess("native dependency failed validation", options.logExitCode)
          : mockProcess(),
    );
  });
  const fs = FileSystem.makeNoop({
    readDirectory: () =>
      Effect.succeed([
        "goat",
        "node_modules/native/addon.node",
        "node_modules/native/library.dylib",
        "node_modules/pty/spawn-helper",
        "resource-monitor/goat-resource-monitor",
        "client/index.html",
        "LICENSE-T3CODE.txt",
      ]),
    makeTempDirectoryScoped: () =>
      Effect.acquireRelease(Effect.succeed("/scratch/goat-notarize-test"), () =>
        Effect.sync(() => {
          cleaned = true;
        }),
      ),
  });
  return {
    commands,
    cleaned: () => cleaned,
    run: (input = signInput) =>
      signMacArchiveContents(input).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(Path.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: options.env ?? {
              GOAT_CLI_MAC_SIGN_IDENTITY: "Developer ID",
              APPLE_KEYCHAIN_PROFILE: "goat-notary",
              APPLE_KEYCHAIN: "/login.keychain-db",
            },
          }),
        ),
        Effect.scoped,
      ),
  };
}

describe("signMacArchiveContents", () => {
  it.effect(
    "signs native dependencies and submits the whole directory outside the shipped tree",
    () =>
      Effect.gen(function* () {
        const fixture = signingFixture();
        yield* fixture.run();
        assert.equal(
          fixture.commands.filter((command) => command.command === "codesign").length,
          5,
        );
        assert.deepEqual(fixture.commands.find((command) => command.command === "ditto")?.args, [
          "-c",
          "-k",
          "--keepParent",
          contentDir,
          "/scratch/goat-notarize-test/goat.zip",
        ]);
        assert.deepEqual(fixture.commands.find((command) => command.command === "xcrun")?.args, [
          "notarytool",
          "submit",
          "/scratch/goat-notarize-test/goat.zip",
          "--wait",
          "--output-format",
          "json",
          "--keychain-profile",
          "goat-notary",
          "--keychain",
          "/login.keychain-db",
        ]);
        assert.isTrue(fixture.cleaned());
      }),
  );

  it.effect(
    "rejects required ad hoc signing or missing credentials before invoking any process",
    () =>
      Effect.gen(function* () {
        for (const env of [
          {},
          { GOAT_CLI_MAC_SIGN_IDENTITY: "-", APPLE_KEYCHAIN_PROFILE: "goat-notary" },
          { GOAT_CLI_MAC_SIGN_IDENTITY: "Developer ID" },
        ]) {
          const fixture = signingFixture({ env });
          const error = yield* fixture.run().pipe(Effect.flip);
          assert.equal(error._tag, "CliNotarizationCredentialsMissingError");
          assert.isEmpty(fixture.commands);
        }
      }),
  );

  it.effect("honors required notarization from the environment even without the flag", () =>
    Effect.gen(function* () {
      const fixture = signingFixture({ env: { GOAT_REQUIRE_NOTARIZATION: "1" } });
      const error = yield* fixture
        .run({ ...signInput, requireNotarization: false })
        .pipe(Effect.flip);
      assert.equal(error._tag, "CliNotarizationCredentialsMissingError");
      assert.isEmpty(fixture.commands);
    }),
  );

  it.effect("preserves optional ad hoc and Developer ID signing without credentials", () =>
    Effect.gen(function* () {
      for (const env of [{}, { GOAT_CLI_MAC_SIGN_IDENTITY: "Developer ID" }]) {
        const fixture = signingFixture({ env });
        yield* fixture.run({ ...signInput, requireNotarization: false });
        assert.isTrue(fixture.commands.every((command) => command.command === "codesign"));
      }
    }),
  );

  it.effect("fetches rejection logs with the same authentication and cleans up the zip", () =>
    Effect.gen(function* () {
      const fixture = signingFixture({ submit: '{"id":"rejected-id","status":"Invalid"}' });
      const error = yield* fixture.run().pipe(Effect.flip);
      assert.instanceOf(error, NotarytoolSubmitError);
      if (!isNotarytoolSubmitError(error)) return;
      assert.equal(error.id, "rejected-id");
      assert.equal(error.status, "Invalid");
      assert.include(error.message, "native dependency failed validation");
      assert.deepEqual(fixture.commands.at(-1)?.args, [
        "notarytool",
        "log",
        "rejected-id",
        "--keychain-profile",
        "goat-notary",
        "--keychain",
        "/login.keychain-db",
      ]);
      assert.isTrue(fixture.cleaned());
    }),
  );

  it.effect("rejects malformed output and failed submission exits", () =>
    Effect.gen(function* () {
      for (const options of [{ submit: "garbage" }, { submitExitCode: 1 }]) {
        const fixture = signingFixture(options);
        const error = yield* fixture.run().pipe(Effect.flip);
        assert.equal(error._tag, "NotarytoolSubmitError");
        assert.isTrue(fixture.cleaned());
      }
    }),
  );

  it.effect("retains the rejection when fetching its log fails", () =>
    Effect.gen(function* () {
      const fixture = signingFixture({
        submit: '{"id":"rejected-id","status":"Invalid"}',
        logExitCode: 1,
      });
      const error = yield* fixture.run().pipe(Effect.flip);
      assert.instanceOf(error, NotarytoolSubmitError);
      assert.include(error.message, "Status: Invalid");
      assert.include(error.message, "notarytool log exited with code 1");
    }),
  );
});
