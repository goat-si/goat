import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import * as HomeRoute from "./OpenCodexRoute.ts";
import { checkCodexProviderStatus } from "./CodexProvider.ts";
import { CodexSettings } from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
/**
 * Read-only provider diagnosis behind `goat_provider_diagnose` and
 * `goat provider diagnose`. For each provider instance it says why the
 * instance cannot run and what the next step is, naming whether an agent or a
 * person takes it.
 *
 * Claude Cloud and Devin Cloud are checked live through the same functions
 * their drivers use, so diagnosis cannot pass what the driver refuses. Every
 * other driver is judged from its readiness snapshot. Nothing here writes
 * settings, state, or credentials, and no check returns an environment value.
 *
 * @module provider/ProviderDiagnosis
 */
import {
  ClaudeCloudSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  implicitDefaultInstance,
  isDevinAcpRegistryInstance,
  providerSettingsFixPath,
  type ProviderDiagnoseInput,
  type ProviderDiagnoseResult,
  type ProviderDiagnosis,
  type ProviderDiagnosisCheck,
  type ProviderDiagnosisFix,
  type ProviderDiagnosisReason,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import { ClaudeCloudCli } from "@goat/provider-claude-cloud/server";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { DevinCloudCli } from "@goat/provider-devin-cloud/server";
import { DevinCloudSettings } from "@goat/provider-devin-cloud/settings";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  forbiddenClaudeCloudVariables,
  resolveClaudeCloudSibling,
} from "./Drivers/ClaudeCloudLogin.ts";
import { detectCloudClis, planCloudAutoSetup } from "./CloudProviderAutoSetup.ts";
import { resolveEntryEnabled } from "./ProviderInstanceRegistry.ts";

const CLAUDE_CLOUD = ProviderDriverKind.make("claudeCloud");
const DEVIN_CLOUD = ProviderDriverKind.make("devinCloud");
/** Drivers diagnosed live, and diagnosed even when no instance exists. */
export const LIVE_DIAGNOSIS_DRIVERS: ReadonlySet<string> = new Set([CLAUDE_CLOUD, DEVIN_CLOUD]);
const SETTINGS = "Settings → Providers";
const decodeCodex = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeCloud = Schema.decodeUnknownOption(ClaudeCloudSettings);
const decodeDevinCloud = Schema.decodeUnknownOption(DevinCloudSettings);
/** One instance to diagnose: what settings say about it and what the registry last reported. */
interface Target {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly entry: ProviderInstanceConfig | undefined;
  readonly snapshot: ServerProvider | undefined;
}

export interface DiagnoseOptions {
  readonly input: ProviderDiagnoseInput;
  /** The registry's snapshots: live in the server, the persisted status cache in the CLI. */
  readonly snapshots: ReadonlyArray<ServerProvider>;
  readonly checkedBy: ProviderDiagnoseResult["checkedBy"];
}

const check = (
  id: string,
  status: ProviderDiagnosisCheck["status"],
  summary: string,
  reason?: ProviderDiagnosisReason,
  fix?: ProviderDiagnosisFix,
): ProviderDiagnosisCheck => ({
  id,
  status,
  summary,
  ...(reason ? { reason } : {}),
  ...(fix ? { fix } : {}),
});

const human = (
  instruction: string,
  extra: Omit<ProviderDiagnosisFix, "actor" | "instruction"> = {},
): ProviderDiagnosisFix => ({ actor: "human", instruction, ...extra });

const agent = (
  instruction: string,
  extra: Omit<ProviderDiagnosisFix, "actor" | "instruction"> = {},
): ProviderDiagnosisFix => ({ actor: "agent", instruction, ...extra });

type FixCall = NonNullable<ProviderDiagnosisFix["call"]>;

/**
 * A settings change. Its call runs directly for a provider manager; others get an approval. With
 * no call, no GOAT tool makes the change: a person follows the instruction in Settings.
 */
const settingsChange = (instruction: string, call?: FixCall) =>
  human(
    instruction,
    call === undefined ? {} : { path: providerSettingsFixPath(call), handoff: "approval", call },
  );

const enableCall = (instanceId: string): FixCall => ({
  tool: "goat_provider_update",
  arguments: { instanceId, enabled: true },
});

const retry = (subject: string) =>
  agent(
    `Run provider.diagnose again. If it fails the same way, ask a person to check ${subject} on this machine.`,
    { path: "provider.diagnose" },
  );

const nameOf = (target: Target) =>
  target.entry?.displayName ?? target.snapshot?.displayName ?? target.instanceId;

const finish = (
  target: Target,
  configured: boolean,
  checks: ReadonlyArray<ProviderDiagnosisCheck>,
): ProviderDiagnosis => {
  const displayName = target.entry?.displayName ?? target.snapshot?.displayName;
  return {
    instanceId: target.instanceId,
    driver: target.driver,
    ...(displayName ? { displayName } : {}),
    configured,
    ready: checks.every((item) => item.status !== "fail"),
    checks,
  };
};

const missingInstance = (target: Target) =>
  check(
    "instance",
    "fail",
    `No provider instance ${target.instanceId} is configured on this environment.`,
    "instance_missing",
    agent(
      'List the configured providers with goat_call {path:"provider.list"} and use one of their instance ids.',
      { path: "provider.list" },
    ),
  );

const enabledCheck = (target: Target, enabled: boolean) =>
  enabled
    ? check("enabled", "pass", `${nameOf(target)} is enabled.`)
    : check(
        "enabled",
        "fail",
        `${nameOf(target)} is disabled.`,
        "disabled",
        settingsChange(`Enable ${nameOf(target)} in ${SETTINGS}.`, enableCall(target.instanceId)),
      );

const implicitCloudEnabledCheck = (
  target: Target,
  enabled: boolean,
  sibling: string,
  call: FixCall,
) =>
  enabled
    ? check("enabled", "pass", `${nameOf(target)} follows the enabled ${sibling} provider.`)
    : check(
        "enabled",
        "fail",
        `${nameOf(target)} is off because its ${sibling} provider is disabled or missing.`,
        "disabled",
        settingsChange(`Enable the ${sibling} provider in ${SETTINGS}.`, call),
      );

// ── Generic drivers: judged from the registry's readiness snapshot ─────────

const isUncheckedSnapshot = (snapshot: ServerProvider) => Date.parse(snapshot.checkedAt) <= 0;

/** Checks every driver gets from its snapshot. `cached` marks a status read from disk by the CLI. */
export const snapshotChecks = (
  snapshot: ServerProvider,
  cached = false,
): ReadonlyArray<ProviderDiagnosisCheck> => {
  const name = snapshot.displayName ?? snapshot.instanceId;
  const checks: ProviderDiagnosisCheck[] = [];
  if (snapshot.availability === "unavailable") {
    return [
      check(
        "driver",
        "fail",
        snapshot.unavailableReason ??
          `This GOAT build does not include the ${snapshot.driver} driver.`,
        "driver_unavailable",
        human(`Update GOAT, or return to the build that added the ${snapshot.driver} driver.`),
      ),
    ];
  }
  checks.push(
    snapshot.enabled
      ? check("enabled", "pass", `${name} is enabled.`)
      : check(
          "enabled",
          "fail",
          `${name} is disabled.`,
          "disabled",
          settingsChange(`Enable ${name} in ${SETTINGS}.`, enableCall(snapshot.instanceId)),
        ),
  );
  if (!snapshot.enabled) return checks;
  if (isUncheckedSnapshot(snapshot)) {
    checks.push(
      check(
        "readiness",
        "warn",
        `${name} has not finished its first readiness check.`,
        "not_checked",
        agent("Run provider.diagnose again in a few seconds.", { path: "provider.diagnose" }),
      ),
    );
    return checks;
  }
  const docs = snapshot.setup?.documentationUrl;
  if (!snapshot.installed) {
    checks.push(
      check(
        "executable",
        "fail",
        snapshot.message ?? `${name} is not installed on this machine.`,
        "executable_missing",
        snapshot.setup?.canInstall
          ? settingsChange(
              `Install ${name} from ${SETTINGS}.`,
              snapshot.driver === "acpRegistry"
                ? {
                    tool: "goat_provider_update",
                    arguments: { instanceId: snapshot.instanceId, install: true },
                  }
                : undefined,
            )
          : human(
              `Install ${name} on this machine, or set its binary path in ${SETTINGS}.${docs ? ` See ${docs}.` : ""}`,
              { handoff: "terminal" },
            ),
      ),
    );
    return checks;
  }
  checks.push(
    check(
      "executable",
      "pass",
      snapshot.version ? `${name} ${snapshot.version} is installed.` : `${name} is installed.`,
    ),
  );
  const compatibility = snapshot.compatibilityAdvisory;
  if (compatibility?.status === "unsupported" || compatibility?.status === "broken") {
    const update = snapshot.versionAdvisory?.updateCommand;
    const target = compatibility.recommendedVersion ?? compatibility.recommendedRange;
    checks.push(
      check(
        "version",
        "fail",
        compatibility.message ?? `GOAT does not support ${name} ${snapshot.version ?? ""}.`.trim(),
        "version_unsupported",
        human(`Update ${name}${target ? ` to ${target}` : ""}.`, {
          handoff: "terminal",
          ...(update ? { command: update } : {}),
        }),
      ),
    );
  }
  if (snapshot.auth.status === "unauthenticated") {
    const sourceName =
      snapshot.driver === ProviderDriverKind.make("cursorCloud")
        ? `Cursor provider ${snapshot.authSourceInstanceId ?? "cursor"}`
        : undefined;
    checks.push(
      check(
        "auth",
        "fail",
        `${name} is not signed in.`,
        "not_signed_in",
        sourceName
          ? human(`Sign in to ${sourceName} from the Cursor Cloud card in ${SETTINGS}.`, {
              path: "provider.login_start",
              handoff: "oauth",
            })
          : snapshot.setup?.canAuthenticate
            ? human(`Sign in to ${name} from ${SETTINGS}.`, {
                path: "provider.login_start",
                handoff: "oauth",
              })
            : human(`Sign in with ${name}'s own CLI on this machine.`, {
                path: "provider.login_start",
                handoff: "terminal",
              }),
      ),
    );
  } else {
    checks.push(
      check(
        "auth",
        snapshot.auth.status === "authenticated" ? "pass" : "unknown",
        snapshot.auth.status === "authenticated"
          ? `${name} is signed in.`
          : `${name} does not report its sign-in state.`,
      ),
    );
  }
  const when = cached ? ` (status saved by the server at ${snapshot.checkedAt})` : "";
  const explained = checks.some((item) => item.status === "fail");
  if (snapshot.status === "error" && !explained) {
    checks.push(
      check(
        "readiness",
        "fail",
        `${snapshot.message ?? `${name} reported an error.`}${when}`,
        "provider_error",
        human(
          `Open ${name} in ${SETTINGS} and follow its message, then run provider.diagnose again.`,
        ),
      ),
    );
  } else if (snapshot.status === "warning") {
    checks.push(
      check(
        "readiness",
        "warn",
        `${snapshot.message ?? `${name} reported a warning.`}${when}`,
        "provider_error",
      ),
    );
  } else if (snapshot.status === "ready") {
    checks.push(check("readiness", "pass", `${name} is ready${when}.`));
  }
  return checks;
};

// ── Shared probes ─────────────────────────────────────────────────────────

const runCommand = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, { cwd, shell: false, stdin: "ignore" }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.runDrain(handle.stderr),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.timeout("10 seconds"), Effect.option);

/** `host/owner/repo` from a remote URL, without user info, tokens, or scheme. */
export const describeRemote = (url: string): { host: string; path: string } | undefined => {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+?)(?:\.git)?\/?$/u.exec(url);
  if (scp && !url.includes("://")) return { host: scp[1]!.toLowerCase(), path: scp[2]! };
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    if (!parsed.hostname || !path) return undefined;
    return { host: parsed.hostname.toLowerCase(), path };
  } catch {
    return undefined;
  }
};

const repositoryCheck = Effect.fn("ProviderDiagnosis.repository")(function* (
  cwd: string,
  provider: "claudeCloud" | "devinCloud",
) {
  const remotes = yield* runCommand("git", ["remote", "-v"], cwd);
  if (Option.isNone(remotes) || remotes.value.exitCode !== 0) {
    return check(
      "repository",
      "fail",
      `${cwd} is not a Git repository GOAT can read.`,
      "repository_missing",
      human("Open a project that is a Git repository with a remote the cloud account can reach."),
    );
  }
  const url = /^\S+\s+(\S+)\s+\(fetch\)$/mu.exec(remotes.value.stdout)?.[1];
  const remote = url ? describeRemote(url) : undefined;
  if (!remote) {
    return check(
      "repository",
      "fail",
      `${cwd} has no remote. Cloud tasks start from a remote repository.`,
      "repository_missing",
      human("Push this project to a remote repository the cloud account can reach."),
    );
  }
  const name = `${remote.host}/${remote.path}`;
  if (provider === "claudeCloud" && remote.host !== "github.com") {
    return check(
      "repository",
      "fail",
      `${name} is not on GitHub. Claude Cloud works with GitHub repositories.`,
      "repository_unsupported",
      human("Use a project whose remote is on github.com, or choose a local provider."),
    );
  }
  return check(
    "repository",
    "unknown",
    `Remote ${name}. Whether the cloud account can reach it is only known when a task starts.`,
    "repository_access_unverified",
    human(
      provider === "claudeCloud"
        ? `Make sure the Claude GitHub app can access ${remote.path} (claude.ai/code).`
        : `Make sure your Devin organization can access ${name}.`,
    ),
  );
});

/** Whether `command` resolves to an executable for `environment`, as the spawn will. */
const resolvesExecutable = Effect.fn("ProviderDiagnosis.resolvesExecutable")(function* (
  command: string,
  environment: NodeJS.ProcessEnv,
) {
  const resolve = yield* SpawnExecutableResolution;
  const platform = yield* HostProcess.Platform;
  return resolve(command, platform, environment);
});

// ── Claude Cloud ──────────────────────────────────────────────────────────

const claudeLoginCommand = (environment: NodeJS.ProcessEnv, processEnv: NodeJS.ProcessEnv) => {
  const configDir = environment.CLAUDE_CONFIG_DIR;
  return configDir && configDir !== processEnv.CLAUDE_CONFIG_DIR
    ? `CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} claude auth login --claudeai`
    : "claude auth login --claudeai";
};

const forbiddenEnvironmentFix = (
  variables: ReadonlyArray<string>,
  sourceId: ProviderInstanceId,
  sibling: ProviderInstanceConfig | undefined,
  checkedBy: ProviderDiagnoseResult["checkedBy"],
) => {
  const fromInstance = variables.filter((name) =>
    sibling?.environment?.some(
      (variable) => variable.name === name && (variable.valueRedacted || variable.value.trim()),
    ),
  );
  const fromProcess = variables.filter((name) => !fromInstance.includes(name));
  const steps: string[] = [];
  if (fromInstance.length > 0) {
    steps.push(
      `Remove ${fromInstance.join(", ")} from the environment of Claude instance ${sourceId} in ${SETTINGS}, or choose a Claude instance that signs in with claude.ai.`,
    );
  }
  if (fromProcess.length > 0) {
    const them = fromProcess.length === 1 ? "it" : "them";
    const origin = fromProcess.some((name) => name.startsWith("ANTHROPIC_"))
      ? "for example by an OpenCodex Claude intercept or a shell profile"
      : "for example by a shell profile or an agent harness";
    steps.push(
      checkedBy === "cli"
        ? `This shell has ${fromProcess.join(", ")} set, ${origin}. If GOAT starts with ${them} too, add ${them} with an empty value to the environment of Claude instance ${sourceId} in ${SETTINGS}, or start GOAT without ${them}.`
        : `GOAT started with ${fromProcess.join(", ")} set, ${origin}. Add ${them} with an empty value to the environment of Claude instance ${sourceId} in ${SETTINGS}, or restart GOAT without ${them}.`,
    );
  }
  return settingsChange(steps.join(" "), {
    tool: "goat_provider_update",
    arguments: {
      instanceId: sourceId,
      environment: [
        ...fromInstance.map((name) => ({ name, value: null })),
        ...fromProcess.map((name) => ({ name, value: "" })),
      ],
    },
  });
};

/** `environment` without the routing variables Claude Cloud refuses, to probe what else blocks. */
const withoutVariables = (environment: NodeJS.ProcessEnv, names: ReadonlyArray<string>) =>
  Object.fromEntries(Object.entries(environment).filter(([key]) => !names.includes(key)));

const isForbiddenName = (name: string) =>
  forbiddenClaudeCloudVariables({ [name]: "set" }).length > 0;

const diagnoseClaudeCloud = Effect.fn("ProviderDiagnosis.claudeCloud")(function* (
  target: Target,
  checkedBy: ProviderDiagnoseResult["checkedBy"],
) {
  const checks: ProviderDiagnosisCheck[] = [];
  const configured = target.entry !== undefined;
  const config = Option.getOrElse(decodeClaudeCloud(target.entry?.config ?? {}), () =>
    Option.getOrThrow(decodeClaudeCloud({})),
  );
  const sourceId = config.sourceInstanceId;
  const host = yield* ProviderHost.ProviderHost;
  const settings = yield* host.settings.get;
  const implicit =
    !configured &&
    target.instanceId === ProviderInstanceId.make("claudeCloud") &&
    implicitDefaultInstance(settings, CLAUDE_CLOUD).present;
  if (implicit) {
    checks.push(check("instance", "pass", "Claude Cloud is available automatically."));
    checks.push(
      implicitCloudEnabledCheck(
        target,
        implicitDefaultInstance(settings, CLAUDE_CLOUD).enabled,
        `Claude instance ${sourceId}`,
        enableCall(sourceId),
      ),
    );
  } else if (!configured) {
    checks.push(
      check(
        "instance",
        "fail",
        `No Claude Cloud instance ${target.instanceId} exists on this environment.`,
        "instance_missing",
        settingsChange(
          `Use the automatic Claude Cloud card and sign in to Claude instance ${sourceId} with claude.ai, or add a custom Claude Cloud instance in ${SETTINGS}.`,
        ),
      ),
    );
  } else {
    checks.push(
      check("instance", "pass", `Claude Cloud instance ${target.instanceId} is configured.`),
    );
    checks.push(enabledCheck(target, resolveEntryEnabled(target.entry!, config)));
  }

  const sibling = settings.providerInstances[sourceId];
  const processEnv = yield* HostProcess.Environment;
  const resolution = yield* Effect.result(resolveClaudeCloudSibling(sourceId));
  if (Result.isFailure(resolution)) {
    const error = resolution.failure;
    checks.push(
      error.reason === "sibling_missing"
        ? check(
            "sibling",
            "fail",
            `Claude instance ${sourceId} does not exist.`,
            "sibling_missing",
            settingsChange(
              `Pick an existing Claude instance as the login source of ${nameOf(target)} in ${SETTINGS}.`,
            ),
          )
        : error.reason === "sibling_invalid"
          ? check(
              "sibling",
              "fail",
              `Instance ${sourceId} is not a Claude instance.`,
              "sibling_invalid",
              settingsChange(
                `Pick a Claude instance as the login source of ${nameOf(target)} in ${SETTINGS}.`,
              ),
            )
          : check("readiness", "fail", error.detail, "probe_failed", retry("the Claude settings")),
    );
    return finish(target, configured || implicit, checks);
  }
  checks.push(check("sibling", "pass", `Uses Claude instance ${sourceId}.`));
  const { nativeBinary } = resolution.success;
  // settings.json stores sensitive values redacted, so the CLI sees them empty; a redacted one is set.
  const redacted = (sibling?.environment ?? [])
    .filter((variable) => variable.valueRedacted && isForbiddenName(variable.name))
    .map((variable) => variable.name);
  const forbidden = [...new Set([...resolution.success.forbidden, ...redacted])].toSorted();
  if (forbidden.length > 0) {
    checks.push(
      check(
        "environment",
        "fail",
        `Claude Cloud refuses to run with ${forbidden.join(", ")} set. They route Claude through an API key, a proxy, or Git overrides instead of the claude.ai login.`,
        "forbidden_environment",
        forbiddenEnvironmentFix(forbidden, sourceId, sibling, checkedBy),
      ),
    );
  } else {
    checks.push(
      check("environment", "pass", "No API-key, proxy, or Git routing variables are set."),
    );
  }
  // Probe the rest with those variables removed, so one pass reports every blocker.
  const login = {
    ...resolution.success.login,
    environment: withoutVariables(resolution.success.login.environment, forbidden),
  };
  if (!nativeBinary) {
    checks.push(
      check(
        "executable",
        "fail",
        "Claude Cloud needs the native Claude executable, and this sibling uses a launcher script.",
        "executable_missing",
        settingsChange(
          `Set the native Claude binary path of Claude instance ${sourceId} in ${SETTINGS}.`,
        ),
      ),
    );
    return finish(target, configured || implicit, checks);
  }

  const resolved = yield* resolvesExecutable(login.binary, login.environment);
  if (resolved === undefined) {
    checks.push(
      check(
        "executable",
        "fail",
        `The Claude binary ${login.binary} is not on this machine's PATH.`,
        "executable_missing",
        human(
          `Install Claude Code on this machine, or set the binary path of Claude instance ${sourceId} in ${SETTINGS}.`,
          { handoff: "terminal" },
        ),
      ),
    );
    return finish(target, configured || implicit, checks);
  }

  const home = yield* HostProcess.HomeDirectory;
  const readiness = yield* Effect.result(ClaudeCloudCli.probeReadiness(login, home));
  if (Result.isSuccess(readiness)) {
    checks.push(
      check(
        "executable",
        "pass",
        `Claude Code ${readiness.success.version ?? ""} is installed at ${resolved}.`.replace(
          "  ",
          " ",
        ),
      ),
      check("auth", "pass", "Signed in with claude.ai."),
      check("cloud", "pass", "The Claude CLI supports cloud sessions."),
    );
  } else {
    const error = readiness.failure;
    const command = claudeLoginCommand(login.environment, processEnv);
    checks.push(check("executable", "pass", `Claude Code is installed at ${resolved}.`));
    if (error.reason === "not_signed_in" || error.reason === "wrong_sign_in") {
      checks.push(
        check(
          "auth",
          "fail",
          error.reason === "wrong_sign_in"
            ? `Claude is signed in with ${error.authMethod ?? "another method"}. Claude Cloud needs a claude.ai subscription login.`
            : "Claude is not signed in.",
          error.reason,
          human(
            `Sign in to claude.ai from the Claude Cloud card in ${SETTINGS}, or run ${command} on this machine.`,
            {
              path: "provider.login_start",
              handoff: "terminal",
              command,
            },
          ),
        ),
      );
    } else if (error.reason === "cloud_unsupported") {
      checks.push(
        check("auth", "pass", "Signed in with claude.ai."),
        check(
          "cloud",
          "fail",
          "This Claude CLI does not support cloud sessions.",
          "cloud_unsupported",
          human("Update Claude Code on this machine.", {
            handoff: "terminal",
            command: "claude update",
          }),
        ),
      );
    } else {
      checks.push(
        check("readiness", "fail", error.detail, "probe_failed", retry("the Claude CLI")),
      );
    }
  }
  return finish(target, configured || implicit, checks);
});

// ── Devin Cloud ───────────────────────────────────────────────────────────

/** ACP Registry instances that would pass Devin Cloud's sibling check. */
const devinCandidates = (settings: ServerSettings) =>
  Object.entries(settings.providerInstances).flatMap(([id, entry]) =>
    isDevinAcpRegistryInstance(entry) ? [id] : [],
  );

const devinProbeChecks = (
  result: Result.Result<DevinCloudCli.DevinCliReadiness, DevinCloudCli.DevinCloudCliError>,
  where: string,
): ProviderDiagnosisCheck[] => {
  if (Result.isSuccess(result)) {
    return [
      check("executable", "pass", `Devin CLI ${result.success.version} at ${where}.`),
      check("cloud", "pass", "The Devin CLI supports cloud sessions."),
      check("auth", "pass", "Signed in to Devin."),
    ];
  }
  const update = human("Update the Devin CLI to 3000.11.1 or newer on this machine.", {
    handoff: "terminal",
    command: "devin update",
  });
  switch (result.failure.stage) {
    case "version":
      return [
        check(
          "version",
          "fail",
          `The Devin CLI at ${where} is older than 3000.11.1.`,
          "version_unsupported",
          update,
        ),
      ];
    case "relay":
      return [
        check(
          "cloud",
          "fail",
          `The Devin CLI at ${where} does not support cloud sessions.`,
          "cloud_unsupported",
          update,
        ),
      ];
    case "auth":
      return [
        check("executable", "pass", `Devin CLI at ${where}.`),
        check(
          "auth",
          "fail",
          "The Devin CLI is not signed in.",
          "not_signed_in",
          human(
            `Sign in from the Devin Cloud card in ${SETTINGS}, or run devin auth login on this machine.`,
            {
              path: "provider.login_start",
              handoff: "terminal",
              command: "devin auth login",
            },
          ),
        ),
      ];
    default:
      return [
        check("readiness", "fail", result.failure.message, "probe_failed", retry("the Devin CLI")),
      ];
  }
};

const devinSiblingFailure = (
  error: DevinCloudCli.DevinCloudCliError,
  siblingId: string,
  target: Target,
  candidates: ReadonlyArray<string>,
): ProviderDiagnosisCheck => {
  const pick =
    candidates.length > 0
      ? settingsChange(
          `Select ACP instance ${candidates[0]} as the Devin ACP instance of ${nameOf(target)} in ${SETTINGS}.`,
          {
            tool: "goat_provider_link",
            arguments: { instanceId: target.instanceId, siblingInstanceId: candidates[0] },
          },
        )
      : settingsChange(
          `Reset ${nameOf(target)} in ${SETTINGS} so GOAT sets it up again from the Devin CLI, or add an ACP Registry provider for Devin and select it as the Devin ACP instance of ${nameOf(target)}.`,
          {
            tool: "goat_provider_add",
            arguments: { acpAgentId: "devin", linkTo: target.instanceId },
          },
        );
  switch (error.reason) {
    case "ambiguous":
      return check(
        "sibling",
        "fail",
        "More than one enabled Devin ACP provider is available.",
        "sibling_invalid",
        settingsChange(
          `Choose a Devin ACP provider in ${nameOf(target)} settings under ${SETTINGS}.`,
        ),
      );
    case "missing":
      return check(
        "sibling",
        "fail",
        siblingId
          ? `ACP instance ${siblingId} does not exist.`
          : "No enabled Devin ACP provider is available.",
        "sibling_missing",
        pick,
      );
    case "not_acp_registry":
      return check(
        "sibling",
        "fail",
        `Instance ${siblingId} is not an ACP Registry instance.`,
        "sibling_invalid",
        pick,
      );
    case "not_devin":
      return check(
        "sibling",
        "fail",
        `ACP instance ${siblingId} does not run Devin.`,
        "sibling_invalid",
        pick,
      );
    case "disabled":
      return check(
        "sibling",
        "fail",
        `ACP instance ${siblingId} is disabled.`,
        "sibling_invalid",
        settingsChange(
          `Enable ACP instance ${siblingId} in ${SETTINGS}.`,
          siblingId ? enableCall(siblingId) : undefined,
        ),
      );
    case "unprepared":
      return check(
        "sibling",
        "fail",
        `Devin from the ACP Registry is not installed for ${siblingId} yet.`,
        "sibling_not_ready",
        settingsChange(
          `Install Devin from ${SETTINGS} → ${siblingId}.`,
          siblingId
            ? { tool: "goat_provider_update", arguments: { instanceId: siblingId, install: true } }
            : undefined,
        ),
      );
    case "missing_runner":
      return check(
        "executable",
        "fail",
        `The executable for ACP instance ${siblingId} is not on this machine's PATH.`,
        "executable_missing",
        human(
          `Install the Devin CLI on this machine, or fix the command path of ${siblingId} in ${SETTINGS}.`,
          {
            handoff: "terminal",
          },
        ),
      );
    case "package_runner":
      return check(
        "sibling",
        "fail",
        `ACP instance ${siblingId} launches Devin through a package runner. Devin Cloud needs an installed devin executable.`,
        "sibling_invalid",
        settingsChange(
          `Set the command path of ${siblingId} to an installed devin executable in ${SETTINGS}.`,
        ),
      );
    case "unconfigured":
    case "not_found":
    case "unsupported":
      return check(
        "sibling",
        "fail",
        `ACP instance ${siblingId} cannot resolve Devin (${error.reason}).`,
        "sibling_invalid",
        pick,
      );
    default:
      return check(
        "readiness",
        "fail",
        error.message,
        "probe_failed",
        retry("the Devin ACP instance"),
      );
  }
};

const diagnoseDevinCloud = Effect.fn("ProviderDiagnosis.devinCloud")(function* (target: Target) {
  const checks: ProviderDiagnosisCheck[] = [];
  const configured = target.entry !== undefined;
  const config = Option.getOrElse(decodeDevinCloud(target.entry?.config ?? {}), () =>
    Option.getOrThrow(decodeDevinCloud({})),
  );
  const host = yield* ProviderHost.ProviderHost;
  const settings = yield* host.settings.get;
  const implicit =
    !configured &&
    target.instanceId === ProviderInstanceId.make("devinCloud") &&
    implicitDefaultInstance(settings, DEVIN_CLOUD).present;
  // The same plan CloudProviderAutoSetup applies at startup and on a provider refresh.
  const autoSetup = implicit
    ? planCloudAutoSetup(settings, yield* detectCloudClis()).find(
        (step) => step.provider === "devinCloud",
      )
    : undefined;
  if (autoSetup) {
    checks.push(check("instance", "pass", "Devin Cloud is available automatically."));
    checks.push(
      check(
        "auto_setup",
        "fail",
        `GOAT sets up Devin Cloud from the Devin CLI at ${autoSetup.command}: it adds the Devin provider ${autoSetup.siblingId}, links it, and turns Devin Cloud on. This runs when GOAT starts and whenever providers refresh.`,
        "sibling_missing",
        human(
          `Refresh providers in ${SETTINGS}, or restart GOAT. Setup needs no input; sign in to Devin afterwards if the next diagnosis asks.`,
        ),
      ),
    );
    const home = yield* HostProcess.HomeDirectory;
    const probed = yield* Effect.result(
      (yield* DevinCloudCli.DevinCloudCli).probe({
        sourceInstanceId: target.instanceId,
        command: autoSetup.command,
        env: yield* HostProcess.Environment,
        cwd: home,
        binding: "",
      }),
    );
    checks.push(...devinProbeChecks(probed, autoSetup.command));
    return finish(target, true, checks);
  }
  if (implicit) {
    checks.push(check("instance", "pass", "Devin Cloud is available automatically."));
    checks.push(
      implicitCloudEnabledCheck(
        target,
        implicitDefaultInstance(settings, DEVIN_CLOUD).enabled,
        "Devin ACP",
        { tool: "goat_provider_add", arguments: { acpAgentId: "devin" } },
      ),
    );
  } else if (!configured) {
    checks.push(
      check(
        "instance",
        "fail",
        `No Devin Cloud instance ${target.instanceId} exists on this environment.`,
        "instance_missing",
        settingsChange(
          `Use the automatic Devin Cloud card and sign in to the Devin ACP provider, or add a custom Devin Cloud instance in ${SETTINGS}.`,
        ),
      ),
    );
  } else {
    checks.push(
      check("instance", "pass", `Devin Cloud instance ${target.instanceId} is configured.`),
    );
    checks.push(enabledCheck(target, resolveEntryEnabled(target.entry!, config)));
  }
  const cli = yield* DevinCloudCli.DevinCloudCli;
  const candidates = devinCandidates(settings);
  const siblingId = config.siblingInstanceId;
  const launch = yield* Effect.result(cli.resolve(siblingId, host.paths.cwd));
  if (Result.isFailure(launch)) {
    checks.push(devinSiblingFailure(launch.failure, siblingId, target, candidates));
    // Without a sibling, still say whether a devin CLI on PATH would be ready.
    if (launch.failure.stage === "sibling" && launch.failure.reason === "missing") {
      const processEnv = yield* HostProcess.Environment;
      const onPath = yield* resolvesExecutable("devin", processEnv);
      if (onPath === undefined) {
        checks.push(
          check(
            "executable",
            "fail",
            "No devin executable is on this machine's PATH.",
            "executable_missing",
            human("Install the Devin CLI on this machine (https://docs.devin.ai/cli).", {
              handoff: "terminal",
            }),
          ),
        );
      } else {
        const home = yield* HostProcess.HomeDirectory;
        const probed = yield* Effect.result(
          cli.probe({
            sourceInstanceId: target.instanceId,
            command: onPath,
            env: processEnv,
            cwd: home,
            binding: "",
          }),
        );
        checks.push(...devinProbeChecks(probed, onPath));
      }
    }
    return finish(target, configured || implicit, checks);
  }
  checks.push(check("sibling", "pass", `Uses ACP instance ${launch.success.sourceInstanceId}.`));
  const probed = yield* Effect.result(cli.probe(launch.success));
  checks.push(...devinProbeChecks(probed, launch.success.command));
  return finish(target, configured || implicit, checks);
});

// ── Entry point ───────────────────────────────────────────────────────────

const selectTargets = (
  settings: ServerSettings,
  snapshots: ReadonlyArray<ServerProvider>,
  input: ProviderDiagnoseInput,
): ReadonlyArray<Target> => {
  const byId = new Map<string, Target>();
  for (const snapshot of snapshots) {
    byId.set(snapshot.instanceId, {
      instanceId: snapshot.instanceId,
      driver: snapshot.driver,
      entry: settings.providerInstances[snapshot.instanceId],
      snapshot,
    });
  }
  for (const [id, entry] of Object.entries(settings.providerInstances)) {
    if (byId.has(id)) continue;
    const instanceId = ProviderInstanceId.make(id);
    byId.set(id, { instanceId, driver: entry.driver, entry, snapshot: undefined });
  }
  const all = [...byId.values()];
  if (input.instanceId !== undefined) {
    const found = byId.get(input.instanceId);
    if (found) return [found];
    return [
      {
        instanceId: input.instanceId,
        driver: input.driver ?? ProviderDriverKind.make("unknown"),
        entry: undefined,
        snapshot: undefined,
      },
    ];
  }
  if (input.driver === undefined) return all;
  const ofDriver = all.filter((target) => target.driver === input.driver);
  // Diagnose an automatic cloud slot even before its first snapshot arrives.
  if (ofDriver.length === 0 && LIVE_DIAGNOSIS_DRIVERS.has(input.driver)) {
    return [
      {
        instanceId: ProviderInstanceId.make(input.driver),
        driver: input.driver,
        entry: undefined,
        snapshot: undefined,
      },
    ];
  }
  return ofDriver;
};

/**
 * Diagnose the instances `input` selects: one instance, every instance of a
 * driver, or every instance. Read-only; probe failures become checks.
 */
export const diagnoseProviders = Effect.fn("ProviderDiagnosis.diagnose")(function* (
  options: DiagnoseOptions,
) {
  const host = yield* ProviderHost.ProviderHost;
  const path = yield* Path.Path;
  const settings = yield* host.settings.get;
  const cwd = options.input.cwd ? path.resolve(options.input.cwd) : undefined;
  const targets = selectTargets(settings, options.snapshots, options.input);
  const diagnoses = yield* Effect.forEach(
    targets,
    (target) =>
      Effect.gen(function* () {
        if (target.driver === CLAUDE_CLOUD || target.driver === DEVIN_CLOUD) {
          const diagnosis =
            target.driver === CLAUDE_CLOUD
              ? yield* diagnoseClaudeCloud(target, options.checkedBy)
              : yield* diagnoseDevinCloud(target);
          if (!cwd) return diagnosis;
          const repository = yield* repositoryCheck(
            cwd,
            target.driver === CLAUDE_CLOUD ? "claudeCloud" : "devinCloud",
          );
          return {
            ...diagnosis,
            checks: [...diagnosis.checks, repository],
            ready: diagnosis.ready && repository.status !== "fail",
          };
        }
        if (target.driver === "codex" && (target.entry || target.snapshot)) {
          const config = decodeCodex(target.entry?.config ?? {});
          if (Option.isNone(config))
            return finish(target, true, [
              check("opencodex_route", "fail", "Invalid Codex settings.", "provider_error"),
            ]);
          const environment = yield* mergeProviderInstanceEnvironment(target.entry?.environment);
          const routes = yield* Effect.serviceOption(HomeRoute.OpenCodexRoute);
          const home = yield* resolveCodexHomeLayout(config.value);
          const snapshot = Option.isSome(routes)
            ? yield* checkCodexProviderStatus(
                { ...config.value, homePath: home.effectiveHomePath ?? home.sharedHomePath },
                undefined,
                environment,
              ).pipe(Effect.provideService(HomeRoute.OpenCodexRoute, routes.value))
            : target.snapshot;
          const checks = snapshot
            ? [
                ...snapshotChecks(
                  { ...snapshot, driver: target.driver, instanceId: target.instanceId },
                  options.checkedBy === "cli",
                ),
              ]
            : [];
          const route = snapshot?.codexRoute;
          if (config.value.modelRoute === "opencodex") {
            const success = route?.state === "connected" || route?.state === "home";
            checks.push(
              check(
                "opencodex_route",
                success ? "pass" : "fail",
                success
                  ? route.state === "home"
                    ? "This machine is your OpenCodex Home."
                    : "Home connected."
                  : (route?.reason ?? "Could not read OpenCodex status"),
                config.value.setupMode === "managed"
                  ? "forbidden_environment"
                  : success
                    ? undefined
                    : "provider_error",
                success
                  ? undefined
                  : route?.state === "reconnecting"
                    ? agent("Check OpenCodex and retry diagnosis.", { path: "provider.diagnose" })
                    : human(
                        config.value.setupMode === "managed"
                          ? "Add a Codex instance that uses your Codex CLI."
                          : "Check OpenCodex on the machine where Codex runs. Connect Home there, or request approval to stop GOAT's Home override.",
                        { path: "provider.home_request", handoff: "terminal" },
                      ),
              ),
            );
          } else
            checks.push(
              check(
                "opencodex_route",
                route?.effectiveBaseUrl
                  ? new URL(route.effectiveBaseUrl).port === "10100"
                    ? "warn"
                    : "pass"
                  : "unknown",
                route?.effectiveBaseUrl
                  ? new URL(route.effectiveBaseUrl).port === "10100"
                    ? "Codex's own configuration still routes through OpenCodex."
                    : `Uses Codex's own settings · ${route.effectiveBaseUrl}`
                  : "Could not verify the effective Codex endpoint.",
                route?.effectiveBaseUrl ? undefined : "not_checked",
              ),
            );
          return finish(target, true, checks);
        }
        if (target.driver === ProviderDriverKind.make("cursorCloud") && !target.entry) {
          const settings = yield* (yield* ProviderHost.ProviderHost).settings.get;
          const step = planCloudAutoSetup(settings, yield* detectCloudClis()).find(
            (candidate) => candidate.provider === "cursorCloud",
          );
          if (step)
            return finish(target, true, [
              check("instance", "pass", "Cursor Cloud is available automatically."),
              check(
                "auto_setup",
                "fail",
                `GOAT turns on the Cursor provider because the Cursor CLI is at ${step.command}, which turns Cursor Cloud on. This runs when GOAT starts and whenever providers refresh.`,
                "disabled",
                human(
                  `Refresh providers in ${SETTINGS}, or restart GOAT. Then sign in to Cursor from the Cursor Cloud card if the next diagnosis asks.`,
                ),
              ),
            ]);
        }
        if (target.snapshot) {
          return finish(target, true, snapshotChecks(target.snapshot, options.checkedBy === "cli"));
        }
        return finish(target, target.entry !== undefined, [
          target.entry === undefined
            ? missingInstance(target)
            : check(
                "readiness",
                "unknown",
                options.checkedBy === "cli"
                  ? `No saved status for ${nameOf(target)}. Start GOAT once, or call goat_call {path:"provider.diagnose"} from a thread.`
                  : `${nameOf(target)} has no readiness snapshot yet.`,
                "not_checked",
              ),
        ]);
      }),
    { concurrency: 4 },
  );
  return { checkedBy: options.checkedBy, diagnoses } satisfies ProviderDiagnoseResult;
});
