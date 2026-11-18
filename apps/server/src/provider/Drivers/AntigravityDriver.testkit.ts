// @effect-diagnostics preferSchemaOverJson:off -- The mock agent reads its error fixture as a raw JSON environment value.
import { expect } from "@effect/vitest";
import { ProviderInstanceId, type AntigravitySettings } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  resolveAntigravityInstanceDirectories,
} from "../antigravityAuthSupport.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";

const plainEnvValue = (value: string | Redacted.Redacted<string> | undefined) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

export const hostPlatform = HostProcess.Platform.defaultValue();
export const windowsHost = hostPlatform === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const blockedCredentialKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const makeHarness = Effect.fn("makeAntigravityDriverHarness")(function* (
  options: {
    readonly config?: Partial<AntigravitySettings>;
    readonly enabled?: boolean;
    readonly inheritPath?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcess.ExecutablePath;
  const baseEnv = yield* HostProcess.Environment;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-antigravity-driver-" });
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  const directories = yield* resolveAntigravityInstanceDirectories(config.stateDir, instanceId);
  const profileDirectory = directories.profile;
  const instancePath = `${path.join(root, "instance-bin")}:${baseEnv.PATH ?? ""}`;

  const makeExecutable = Effect.fn("AntigravityDriverTest.makeExecutable")(function* (
    name: string,
    options:
      | {
          loginRequired?: boolean;
          initialMode?: string;
          newSessionErrorData?: unknown;
          promptCommand?: string;
          emitToolCalls?: boolean;
        }
      | boolean = {},
  ) {
    const loginRequired = typeof options === "boolean" ? options : (options.loginRequired ?? false);
    const initialMode = typeof options === "boolean" ? undefined : options.initialMode;
    const newSessionErrorData =
      typeof options === "boolean" ? undefined : options.newSessionErrorData;
    const promptCommand = typeof options === "boolean" ? undefined : options.promptCommand;
    const emitToolCalls = typeof options === "boolean" ? false : (options.emitToolCalls ?? false);
    const directory = path.join(root, name);
    const executablePath = path.join(directory, "agy_acp_server.par");
    const harnessPath = path.join(directory, "localharness_external");
    yield* fs.makeDirectory(directory, { recursive: true });
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
    yield* fs.writeFileString(
      executablePath,
      [
        "#!/bin/sh",
        ...(loginRequired
          ? [`printf '%s\\n' ${shellQuote(ANTIGRAVITY_AUTH_STDOUT_PREFIX + authorizationUrl)}`]
          : []),
        ...(initialMode === undefined
          ? []
          : [`export GOAT_ACP_INITIAL_MODE=${shellQuote(initialMode)}`]),
        ...(promptCommand === undefined
          ? []
          : [`export GOAT_ACP_PROMPT_COMMAND=${shellQuote(promptCommand)}`]),
        ...(emitToolCalls ? ["export GOAT_ACP_EMIT_TOOL_CALLS=1"] : []),
        ...(newSessionErrorData === undefined
          ? []
          : [
              `export GOAT_ACP_NEW_SESSION_ERROR_DATA=${shellQuote(JSON.stringify(newSessionErrorData))}`,
            ]),
        `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.writeFileString(harnessPath, "#!/bin/sh\nexit 99\n");
    yield* fs.chmod(executablePath, 0o755);
    yield* fs.chmod(harnessPath, 0o755);
    return {
      executablePath,
      harnessPath,
      source: "managed",
      version: name,
      managedVersionDirectory: directory,
    } satisfies AntigravityInstallation.AntigravityExecutable;
  });

  const first = yield* makeExecutable("runtime 'one");
  const second = yield* makeExecutable("runtime two");
  const signedOut = yield* makeExecutable("runtime signed-out", true);
  const controls: {
    selected: AntigravityInstallation.AntigravityExecutable;
    failResolution: boolean;
    beforeAcquire: Effect.Effect<void>;
  } = { selected: first, failResolution: false, beforeAcquire: Effect.void };
  const acquisitions: Array<{ binaryPath: string | undefined; path: string | undefined }> = [];
  const resolutions: Array<string | undefined> = [];
  const releases: Array<string | null> = [];
  const launches: Array<{
    command: string;
    path: string | undefined;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    extendEnv: boolean | undefined;
    profileDirectory: string | undefined;
    harnessPath: string | undefined;
    forceFileStorage: string | undefined;
    credentialKeys: ReadonlyArray<string>;
    geminiApiKey: string | undefined;
    tempDirectory: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];

  const layerInstallation = Layer.mock(AntigravityInstallation.AntigravityInstallation)({
    managedDirectory: root,
    resolve: (_binaryPath, environment) =>
      Effect.gen(function* () {
        resolutions.push(environment?.PATH);
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        return controls.selected;
      }),
    acquire: (binaryPath, environment) =>
      Effect.gen(function* () {
        acquisitions.push({ binaryPath, path: environment?.PATH });
        yield* controls.beforeAcquire;
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        const selected = controls.selected;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases.push(selected.version);
          }),
        );
        return selected;
      }),
  });
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      const handle = yield* spawner.spawn(command);
      const environment = command.options.env ?? {};
      launches.push({
        command: command.command,
        path: plainEnvValue(environment.PATH),
        args: command.args.map(String),
        cwd: command.options.cwd,
        extendEnv: command.options.extendEnv,
        profileDirectory: plainEnvValue(environment.GEMINI_HOME),
        harnessPath: plainEnvValue(environment.ANTIGRAVITY_HARNESS_PATH),
        forceFileStorage: plainEnvValue(environment.AGY_ACP_FORCE_FILE_STORAGE),
        credentialKeys: Object.keys(environment).filter((key) =>
          blockedCredentialKeys.has(key.toUpperCase()),
        ),
        geminiApiKey: plainEnvValue(environment.GEMINI_API_KEY),
        tempDirectory:
          environment.ANTIGRAVITY_HARNESS_PATH === undefined
            ? undefined
            : plainEnvValue(environment.TMPDIR),
        handle,
      });
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: options.enabled ?? true,
    config: { ...AntigravityDriver.defaultConfig(), ...options.config },
    environment: [
      ...(options.inheritPath ? [] : [{ name: "PATH", value: instancePath }]),
      { name: "GOAT_ACP_ANTIGRAVITY", value: "1" },
      { name: "GOAT_ACP_REQUEST_LOG_PATH", value: requestLog },
      { name: "GEMINI_API_KEY", value: "must-not-be-used" },
      { name: "google_api_key", value: "must-not-be-used" },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/must-not-be-used.json" },
      { name: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
      { name: "GEMINI_HOME", value: "/must-not-be-used" },
      { name: "ANTIGRAVITY_HARNESS_PATH", value: "/must-not-be-used" },
      { name: "BROWSER", value: "must-not-run" },
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(
    Effect.provide(layerInstallation),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
  );
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  const readRequests = Effect.gen(function* () {
    if (!(yield* fs.exists(requestLog))) return [];
    const text = yield* fs.readFileString(requestLog);
    return yield* Effect.forEach(text.split(/\r?\n/u).filter(Boolean), (line) =>
      decodeRequest(line),
    );
  });
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd) expect(yield* fs.exists(launch.cwd)).toBe(false);
      if (launch.tempDirectory) expect(yield* fs.exists(launch.tempDirectory)).toBe(false);
    }
  });
  return {
    instance,
    instanceId,
    makeExecutable,
    refresh,
    fs,
    path,
    profileDirectory,
    directories,
    instancePath,
    first,
    second,
    signedOut,
    controls,
    acquisitions,
    resolutions,
    releases,
    launches,
    readRequests,
    assertClosed,
    makeReplacement: () =>
      AntigravityDriver.create({
        instanceId,
        displayName: "Replacement",
        enabled: false,
        config: AntigravityDriver.defaultConfig(),
        environment: [],
      }).pipe(Effect.provide(layerInstallation)),
  };
});
