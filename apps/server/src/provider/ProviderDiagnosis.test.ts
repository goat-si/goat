import * as HomeRoute from "./OpenCodexRoute.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderDiagnoseInput,
  type ProviderDiagnosis,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { DevinCloudCli } from "@goat/provider-devin-cloud/server";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { describeRemote, diagnoseProviders, snapshotChecks } from "./ProviderDiagnosis.ts";

const id = ProviderInstanceId.make;
const driver = ProviderDriverKind.make;
const OPENCODEX_TOKEN = "opencodex-intercept-token-value";

interface Fixture {
  readonly instances?: Record<string, ProviderInstanceConfig>;
  readonly env?: NodeJS.ProcessEnv;
  /** Command name to the path it resolves to; absent means not on PATH. */
  readonly executables?: Record<string, string>;
  /** "<binary basename> <args>" to [exit code, stdout]. */
  readonly outputs?: Record<string, readonly [number, string]>;
  readonly snapshots?: ReadonlyArray<ServerProvider>;
}

const READY_OUTPUTS: Record<string, readonly [number, string]> = {
  "claude --version": [0, "2.1.299 (Claude Code)\n"],
  "claude --help": [0, "  --cloud [description|session_id|url]  Start a cloud session\n"],
  "claude auth status": [0, '{"loggedIn":true,"authMethod":"claude.ai"}\n'],
  "devin --version": [0, "devin 3000.11.3 (9c803229faa4)\n"],
  "devin acp --help": [0, "  --cloud  Relay to a cloud session\n"],
  "devin auth status": [0, "Logged in (via Devin).\n"],
  "git remote -v": [
    0,
    "origin\thttps://octo:ghp_secret@github.com/goat-si/goat.git (fetch)\norigin\thttps://github.com/goat-si/goat.git (push)\n",
  ],
};

const devinSibling = (config: Record<string, unknown> = {}, enabled?: boolean) => ({
  driver: driver("acpRegistry"),
  ...(enabled === undefined ? {} : { enabled }),
  config: { source: "local", commandPath: "devin", ...config },
});

/** Runs diagnosis against fake settings, PATH, and CLI output; returns the result and every spawn. */
const diagnose = (input: ProviderDiagnoseInput, fixture: Fixture = {}) =>
  Effect.gen(function* () {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      // Fixture ids are plain strings; settings key instances by branded id.
      providerInstances: (fixture.instances ?? {}) as ServerSettings["providerInstances"],
    };
    const outputs = { ...READY_OUTPUTS, ...fixture.outputs };
    const executables = fixture.executables ?? { claude: "/bin/claude", devin: "/bin/devin" };
    const spawned: ChildProcess.StandardCommand[] = [];
    const encoder = new TextEncoder();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline.");
        spawned.push(command);
        const name = command.command.split("/").pop();
        const [code, stdout] = outputs[[name, ...command.args].join(" ")] ?? [127, ""];
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const host = ProviderHost.ProviderHost.of({
      paths: {
        cwd: "/project",
        baseDir: "/goat",
        stateDir: "/goat/userdata",
        providerStatusCacheDir: "/goat/caches",
        attachmentsDir: "/goat/attachments",
      },
      settings: {
        get: Effect.succeed(settings),
        withSnapshot: (use) => use(settings),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(false),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("Diagnosis must not read stored credentials."),
    });
    const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
      search: () => Effect.die("No registry search"),
      prepare: () => Effect.die("No install"),
      uninstallManagedBinary: () => Effect.die("No uninstall"),
      inspect: (selected) =>
        Effect.succeed(
          executables[selected.commandPath]
            ? {
                status: "ready" as const,
                agentId: "devin",
                version: null,
                distribution: "local" as const,
              }
            : { status: "missing_runner" as const, version: null, distribution: "local" as const },
        ),
      resolve: (selected, cwd, env) =>
        Effect.succeed({
          distribution: "local" as const,
          spawn: {
            command: executables[selected.commandPath]!,
            args: [],
            cwd,
            env: env ?? {},
            shell: false,
          },
        }),
    });
    const result = yield* diagnoseProviders({
      input,
      snapshots: fixture.snapshots ?? [],
      checkedBy: "server",
    }).pipe(
      Effect.provide(DevinCloudCli.layer),
      Effect.provideService(ProviderHost.ProviderHost, host),
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(SpawnExecutableResolution, (command) => executables[command]),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, "/home/user"),
      Effect.provideService(HostProcess.Environment, fixture.env ?? { HOME: "/home/user" }),
      Effect.provide(Layer.mergeAll(NodeServices.layer)),
    );
    return { result, spawned };
  });

const only = (diagnoses: ReadonlyArray<ProviderDiagnosis>) => {
  expect(diagnoses).toHaveLength(1);
  return diagnoses[0]!;
};
const checkOf = (diagnosis: ProviderDiagnosis, checkId: string) =>
  diagnosis.checks.find((item) => item.id === checkId);
const failures = (diagnosis: ProviderDiagnosis) =>
  diagnosis.checks.filter((item) => item.status === "fail").map((item) => item.reason);

const claudeCloud = (config: Record<string, unknown> = {}) => ({
  "cloud-work": { driver: driver("claudeCloud"), config: { enabled: true, ...config } },
});

it.effect("a configured Claude Cloud with a signed-in claude.ai sibling is ready", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose(
      { instanceId: id("cloud-work") },
      { instances: claudeCloud() },
    );
    const diagnosis = only(result.diagnoses);
    expect(diagnosis).toMatchObject({ driver: "claudeCloud", configured: true, ready: true });
    expect(diagnosis.checks.map((item) => [item.id, item.status])).toEqual([
      ["instance", "pass"],
      ["enabled", "pass"],
      ["sibling", "pass"],
      ["environment", "pass"],
      ["executable", "pass"],
      ["auth", "pass"],
      ["cloud", "pass"],
    ]);
  }),
);

it.effect.each([false, true])(
  "Claude Cloud diagnosis neutralizes GIT_PAGER (redacted sibling: %s)",
  (redacted) =>
    Effect.gen(function* () {
      const env = { HOME: "/home/user", GIT_PAGER: "less -FRX", PAGER: "less" };
      const { result, spawned } = yield* diagnose(
        { instanceId: id("cloud-work") },
        {
          instances: {
            ...claudeCloud(),
            ...(redacted
              ? {
                  claudeAgent: {
                    driver: driver("claudeAgent"),
                    environment: [
                      { name: "GIT_PAGER", value: "", sensitive: true, valueRedacted: true },
                    ],
                  },
                }
              : {}),
          },
          env,
        },
      );
      expect(only(result.diagnoses).ready).toBe(true);
      expect(failures(only(result.diagnoses))).toEqual([]);
      expect(spawned.map((command) => command.args)).toEqual([
        ["auth", "status"],
        ["--version"],
        ["--help"],
      ]);
      for (const command of spawned) {
        expect(command.options.env).toEqual({ HOME: "/home/user", GIT_PAGER: "", PAGER: "less" });
      }
      expect(env.GIT_PAGER).toBe("less -FRX");
    }),
);

it.effect.each([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_SSH_COMMAND",
  "GIT_UNKNOWN_OVERRIDE",
])("Claude Cloud diagnosis still refuses %s alongside GIT_PAGER", (key) =>
  Effect.gen(function* () {
    const { result } = yield* diagnose(
      { instanceId: id("cloud-work") },
      {
        instances: claudeCloud(),
        env: { HOME: "/home/user", GIT_PAGER: "less", [key]: "fixture-routing" },
      },
    );
    const diagnosis = only(result.diagnoses);
    expect(diagnosis.ready).toBe(false);
    expect(failures(diagnosis)).toEqual(["forbidden_environment"]);
    expect(checkOf(diagnosis, "environment")?.summary).toContain(key);
    expect(checkOf(diagnosis, "environment")?.summary).not.toContain("GIT_PAGER");
  }),
);

it.effect("the automatic Claude Cloud slot checks its default claude.ai login", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose({ driver: driver("claudeCloud") });
    const diagnosis = only(result.diagnoses);
    expect(diagnosis).toMatchObject({ instanceId: "claudeCloud", configured: true, ready: true });
    expect(failures(diagnosis)).toEqual([]);
    expect(checkOf(diagnosis, "instance")?.status).toBe("pass");
    expect(checkOf(diagnosis, "auth")?.status).toBe("pass");
  }),
);

it.effect("the automatic Claude Cloud slot explains a disabled Claude sibling", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose(
      { driver: driver("claudeCloud") },
      { instances: { claudeAgent: { driver: driver("claudeAgent"), enabled: false } } },
    );
    const diagnosis = only(result.diagnoses);
    expect(failures(diagnosis)).toContain("disabled");
    expect(checkOf(diagnosis, "enabled")?.fix?.instruction).toContain("Enable the Claude instance");
  }),
);

it.effect(
  "names an OpenCodex intercept's variables, never their values, and probes past them",
  () =>
    Effect.gen(function* () {
      const { result, spawned } = yield* diagnose(
        { instanceId: id("cloud-work") },
        {
          instances: claudeCloud(),
          env: {
            HOME: "/home/user",
            ANTHROPIC_AUTH_TOKEN: OPENCODEX_TOKEN,
            ANTHROPIC_BASE_URL: "http://127.0.0.1:7777",
          },
        },
      );
      const diagnosis = only(result.diagnoses);
      expect(failures(diagnosis)).toEqual(["forbidden_environment"]);
      const environment = checkOf(diagnosis, "environment")!;
      expect(environment.summary).toContain("ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL");
      expect(environment.fix).toMatchObject({ actor: "human", path: "provider.setup_open" });
      expect(environment.fix?.instruction).toContain("OpenCodex Claude intercept");
      expect(environment.fix?.instruction).toContain("empty value");
      expect(JSON.stringify(result)).not.toContain(OPENCODEX_TOKEN);
      expect(JSON.stringify(result)).not.toContain("127.0.0.1:7777");
      // The rest was probed without the refused variables.
      expect(checkOf(diagnosis, "auth")?.status).toBe("pass");
      expect(
        spawned.every((command) => command.options.env?.ANTHROPIC_AUTH_TOKEN === undefined),
      ).toBe(true);
    }),
);

it.effect("a refused variable set on the sibling instance is removed there", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose(
      { instanceId: id("cloud-work") },
      {
        instances: {
          ...claudeCloud({ sourceInstanceId: "claude-api" }),
          "claude-api": {
            driver: driver("claudeAgent"),
            environment: [
              { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
            ],
          },
        },
      },
    );
    const fix = checkOf(only(result.diagnoses), "environment")?.fix;
    expect(fix?.instruction).toContain(
      "Remove ANTHROPIC_API_KEY from the environment of Claude instance claude-api",
    );
  }),
);

it.effect("sign-in problems hand a terminal login command to a person", () =>
  Effect.gen(function* () {
    const signedOut = yield* diagnose(
      { instanceId: id("cloud-work") },
      {
        instances: {
          ...claudeCloud({ sourceInstanceId: "claude-work" }),
          "claude-work": {
            driver: driver("claudeAgent"),
            config: { homePath: "/home/user/.claude-work" },
          },
        },
        outputs: { "claude auth status": [1, '{"loggedIn":false,"authMethod":"none"}\n'] },
      },
    );
    const auth = checkOf(only(signedOut.result.diagnoses), "auth")!;
    expect(auth).toMatchObject({ status: "fail", reason: "not_signed_in" });
    expect(auth.fix).toMatchObject({
      actor: "human",
      path: "provider.login_start",
      handoff: "terminal",
      command: 'CLAUDE_CONFIG_DIR="/home/user/.claude-work" claude auth login --claudeai',
    });

    const apiKey = yield* diagnose(
      { instanceId: id("cloud-work") },
      {
        instances: claudeCloud(),
        outputs: { "claude auth status": [0, '{"loggedIn":true,"authMethod":"console"}\n'] },
      },
    );
    const wrong = checkOf(only(apiKey.result.diagnoses), "auth")!;
    expect(wrong).toMatchObject({ status: "fail", reason: "wrong_sign_in" });
    expect(wrong.summary).toContain("console");
    expect(wrong.fix?.command).toBe("claude auth login --claudeai");
  }),
);

it.effect(
  "an old Claude CLI, a missing binary, a disabled instance, and a missing sibling each name their step",
  () =>
    Effect.gen(function* () {
      const old = yield* diagnose(
        { instanceId: id("cloud-work") },
        { instances: claudeCloud(), outputs: { "claude --help": [0, "  --print\n"] } },
      );
      expect(checkOf(only(old.result.diagnoses), "cloud")).toMatchObject({
        reason: "cloud_unsupported",
        fix: { actor: "human", command: "claude update" },
      });

      const missing = yield* diagnose(
        { instanceId: id("cloud-work") },
        { instances: claudeCloud(), executables: {} },
      );
      expect(failures(only(missing.result.diagnoses))).toEqual(["executable_missing"]);
      expect(missing.spawned).toEqual([]);

      const disabled = yield* diagnose(
        { instanceId: id("cloud-work") },
        { instances: { "cloud-work": { driver: driver("claudeCloud"), config: {} } } },
      );
      expect(failures(only(disabled.result.diagnoses))).toEqual(["disabled"]);

      const orphan = yield* diagnose(
        { instanceId: id("cloud-work") },
        { instances: claudeCloud({ sourceInstanceId: "deleted-claude" }) },
      );
      expect(failures(only(orphan.result.diagnoses))).toEqual(["sibling_missing"]);
    }),
);

it.effect("checks a project's remote without echoing credentials in it", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose(
      { instanceId: id("cloud-work"), cwd: "/project" },
      { instances: claudeCloud() },
    );
    const repository = checkOf(only(result.diagnoses), "repository")!;
    expect(repository).toMatchObject({ status: "unknown", reason: "repository_access_unverified" });
    expect(repository.summary).toContain("github.com/goat-si/goat");
    expect(JSON.stringify(result)).not.toContain("ghp_secret");

    const gitlab = yield* diagnose(
      { instanceId: id("cloud-work"), cwd: "/project" },
      {
        instances: claudeCloud(),
        outputs: { "git remote -v": [0, "origin\tgit@gitlab.com:team/app.git (fetch)\n"] },
      },
    );
    expect(failures(only(gitlab.result.diagnoses))).toEqual(["repository_unsupported"]);
    expect(describeRemote("ssh://git@example.com:2222/team/app.git")).toEqual({
      host: "example.com",
      path: "team/app",
    });
  }),
);

const devinCloud = (siblingInstanceId: string) => ({
  "devin-cloud": { driver: driver("devinCloud"), config: { enabled: true, siblingInstanceId } },
});

it.effect("Devin Cloud with a signed-in Devin ACP sibling is ready", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose(
      { instanceId: id("devin-cloud") },
      { instances: { ...devinCloud("devin-acp"), "devin-acp": devinSibling() } },
    );
    const diagnosis = only(result.diagnoses);
    expect(diagnosis.ready).toBe(true);
    expect(checkOf(diagnosis, "executable")?.summary).toContain("3000.11.3");
  }),
);

it.effect("Devin Cloud auto-resolves one enabled Devin ACP sibling", () =>
  Effect.gen(function* () {
    const unconfigured = yield* diagnose(
      { instanceId: id("devin-cloud") },
      { instances: devinCloud("") },
    );
    const alone = only(unconfigured.result.diagnoses);
    expect(failures(alone)).toEqual(["sibling_missing"]);
    // The devin CLI on PATH is still probed so the person knows what else is needed.
    expect(checkOf(alone, "auth")?.status).toBe("pass");

    const withCandidate = yield* diagnose(
      { instanceId: id("devin-cloud") },
      {
        instances: {
          ...devinCloud(""),
          "devin-acp": devinSibling({ source: "registry", agentId: "devin" }),
        },
      },
    );
    expect(only(withCandidate.result.diagnoses).ready).toBe(true);
    expect(checkOf(only(withCandidate.result.diagnoses), "sibling")?.summary).toContain(
      "devin-acp",
    );
  }),
);

it.effect(
  "automatic Devin Cloud reports auto setup when no sibling exists and a choice when ambiguous",
  () =>
    Effect.gen(function* () {
      const noSibling = yield* diagnose({ driver: driver("devinCloud") });
      const pending = only(noSibling.result.diagnoses);
      // The devin CLI on PATH is what auto setup links; nobody is asked for an instance id.
      expect(failures(pending)).toEqual(["sibling_missing"]);
      expect(checkOf(pending, "auto_setup")?.summary).toContain("acpRegistry_devin");
      expect(checkOf(pending, "auto_setup")?.fix?.instruction).not.toContain("instance");
      expect(checkOf(pending, "auth")?.status).toBe("pass");
      expect(checkOf(pending, "instance")?.status).toBe("pass");

      const first = devinSibling({ source: "registry", agentId: "devin" });
      const one = yield* diagnose(
        { driver: driver("devinCloud") },
        { instances: { "devin-one": first } },
      );
      expect(only(one.result.diagnoses).ready).toBe(true);
      expect(only(one.result.diagnoses).configured).toBe(true);
      expect(checkOf(only(one.result.diagnoses), "sibling")?.summary).toContain("devin-one");

      const two = yield* diagnose(
        { driver: driver("devinCloud") },
        { instances: { "devin-one": first, "devin-two": first } },
      );
      const diagnosis = only(two.result.diagnoses);
      expect(checkOf(diagnosis, "enabled")?.status).toBe("pass");
      expect(checkOf(diagnosis, "sibling")?.summary).toContain("More than one enabled Devin");
      expect(checkOf(diagnosis, "sibling")?.fix?.instruction).toContain(
        "Choose a Devin ACP provider",
      );
    }),
);

it.effect("Devin Cloud names an old CLI, a signed-out CLI, and a disabled sibling", () =>
  Effect.gen(function* () {
    const instances = { ...devinCloud("devin-acp"), "devin-acp": devinSibling() };
    const old = yield* diagnose(
      { instanceId: id("devin-cloud") },
      { instances, outputs: { "devin --version": [0, "devin 3000.10.9 (x)\n"] } },
    );
    expect(checkOf(only(old.result.diagnoses), "version")).toMatchObject({
      reason: "version_unsupported",
      fix: { actor: "human", command: "devin update" },
    });

    const signedOut = yield* diagnose(
      { instanceId: id("devin-cloud") },
      { instances, outputs: { "devin auth status": [1, "Not logged in.\n"] } },
    );
    expect(checkOf(only(signedOut.result.diagnoses), "auth")).toMatchObject({
      reason: "not_signed_in",
      fix: { actor: "human", path: "provider.login_start", command: "devin auth login" },
    });

    const disabled = yield* diagnose(
      { instanceId: id("devin-cloud") },
      { instances: { ...devinCloud("devin-acp"), "devin-acp": devinSibling({}, false) } },
    );
    expect(checkOf(only(disabled.result.diagnoses), "sibling")).toMatchObject({
      reason: "sibling_invalid",
      fix: {
        instruction: expect.stringContaining("Enable ACP instance devin-acp"),
        call: {
          tool: "goat_provider_update",
          arguments: { instanceId: "devin-acp", enabled: true },
        },
      },
    });
  }),
);

it.effect("an unknown instance id tells the agent to list providers", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose({ instanceId: id("typo") });
    expect(checkOf(only(result.diagnoses), "instance")?.fix).toMatchObject({
      actor: "agent",
      path: "provider.list",
    });
  }),
);

it.effect("every fix a diagnosis emits names a path goat_call resolves", () =>
  Effect.gen(function* () {
    const results = [
      yield* diagnose({ instanceId: id("typo") }),
      yield* diagnose(
        { driver: driver("claudeCloud") },
        { instances: { claudeAgent: { driver: driver("claudeAgent"), enabled: false } } },
      ),
      yield* diagnose(
        { instanceId: id("cloud-work") },
        { instances: claudeCloud(), env: { HOME: "/home/user", ANTHROPIC_AUTH_TOKEN: "x" } },
      ),
      yield* diagnose(
        { instanceId: id("devin-cloud") },
        { instances: { ...devinCloud("devin-acp"), "devin-acp": devinSibling({}, false) } },
      ),
      yield* diagnose(
        { instanceId: id("devin-cloud") },
        { instances: { ...devinCloud("devin-acp"), "devin-acp": devinSibling() }, executables: {} },
      ),
    ].flatMap(({ result }) => result.diagnoses.flatMap((diagnosis) => diagnosis.checks));
    const checks = [
      ...results,
      ...snapshotChecks(snapshot({ enabled: false, status: "disabled" })),
      ...snapshotChecks(snapshot({ installed: false, status: "error" })),
      ...snapshotChecks(snapshot({ auth: { status: "unauthenticated" }, status: "error" })),
    ];
    const paths = checks.flatMap((item) => (item.fix?.path === undefined ? [] : [item.fix.path]));
    expect(paths.filter((path) => resolveAgentSurfaceEntry(path) === undefined)).toEqual([]);
    expect(paths).toContain("provider.setup_open");
    expect(paths).toContain("provider.update");
  }),
);

const snapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: id("codex"),
  driver: driver("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "0.162.1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T10:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it("judges other drivers from their readiness snapshot", () => {
  const reasons = (provider: ServerProvider) =>
    snapshotChecks(provider)
      .filter((item) => item.status === "fail")
      .map((item) => [item.reason, item.fix?.actor]);
  expect(reasons(snapshot())).toEqual([]);
  expect(reasons(snapshot({ enabled: false, status: "disabled" }))).toEqual([
    ["disabled", "human"],
  ]);
  expect(
    reasons(snapshot({ installed: false, status: "error", message: "Codex CLI not found." })),
  ).toEqual([["executable_missing", "human"]]);
  const signedOut = snapshotChecks(
    snapshot({
      auth: { status: "unauthenticated" },
      status: "error",
      setup: { canAuthenticate: true, canInstall: false },
    }),
  ).find((item) => item.id === "auth");
  expect(signedOut?.fix).toMatchObject({
    actor: "human",
    path: "provider.login_start",
    handoff: "oauth",
  });
  const cursorCloud = snapshotChecks(
    snapshot({
      instanceId: id("cursorCloud"),
      driver: driver("cursorCloud"),
      authSourceInstanceId: id("cursor"),
      auth: { status: "unauthenticated" },
      status: "error",
      setup: { canAuthenticate: false, canInstall: false },
    }),
  ).find((item) => item.id === "auth");
  expect(cursorCloud?.fix).toMatchObject({
    path: "provider.login_start",
    handoff: "oauth",
    instruction: expect.stringContaining("Cursor provider cursor"),
  });
  const tooOld = snapshotChecks(
    snapshot({
      compatibilityAdvisory: {
        status: "unsupported",
        message: "Codex 0.100.0 is too old.",
        recommendedVersion: "0.162.0",
        recommendedRange: null,
      },
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "0.100.0",
        latestVersion: "0.162.1",
        updateCommand: "npm install -g @openai/codex@latest",
        canUpdate: true,
        checkedAt: null,
        message: null,
      },
    }),
  ).find((item) => item.id === "version");
  expect(tooOld?.fix).toMatchObject({ command: "npm install -g @openai/codex@latest" });
  expect(
    reasons(snapshot({ status: "error", message: "Codex app-server exited during startup." })),
  ).toEqual([["provider_error", "human"]]);
});

it.effect.each(["failed", "reconnecting"] as const)(
  "adds a failing opencodex_route check with an explicit fix for %s",
  (state) =>
    Effect.gen(function* () {
      let inspections = 0;
      const { result } = yield* diagnose(
        { instanceId: id("codex-home") },
        {
          instances: {
            "codex-home": { driver: driver("codex"), config: { modelRoute: "opencodex" } },
          },
        },
      ).pipe(
        Effect.provideService(HomeRoute.OpenCodexRoute, {
          inspect: () =>
            Effect.sync(() => {
              inspections++;
              return { modelRoute: "opencodex", state, reason: "Home unavailable" };
            }),
          launchArgs: () => Effect.die("No launch after failed inspect"),
          requireAvailable: () => Effect.die("No launch after failed inspect"),
        }),
      );
      const diagnosis = only(result.diagnoses);
      expect(diagnosis.ready).toBe(false);
      expect(checkOf(diagnosis, "opencodex_route")).toMatchObject({
        status: "fail",
        fix: {
          actor: state === "reconnecting" ? "agent" : "human",
          path: state === "reconnecting" ? "provider.diagnose" : "provider.home_request",
        },
      });
      expect(inspections).toBe(1);
    }),
);
it.effect("does not probe Home for another driver", () =>
  Effect.gen(function* () {
    const { result } = yield* diagnose({ driver: driver("claudeCloud") }).pipe(
      Effect.provideService(HomeRoute.OpenCodexRoute, {
        inspect: () => Effect.die("Unrelated driver must not probe Home"),
        launchArgs: () => Effect.die("unused"),
        requireAvailable: () => Effect.die("unused"),
      }),
    );
    expect(only(result.diagnoses).ready).toBe(true);
  }),
);
