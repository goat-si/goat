import {
  SSH_PREFLIGHT_STEP_ORDER,
  buildSshKeyAuthInstructions,
  SshHostProbeError,
  type SshPreflightInput,
  type SshPreflightReport,
  type SshPreflightStep,
} from "@goat/contracts";
import { cliArchivePlatformKey } from "@goat/shared/cliRelease";
import { parseSshDestination } from "@goat/shared/sshDestination";
import { sshFailureDiagnostic, sshLocalProxyFailure } from "@goat/shared/sshFailure";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveSshCommand } from "./command.ts";
import { readOnlySshArgs, readOnlyProxyJumpArgs } from "./probeOptions.ts";
import { probeHostKey } from "./hostKey.ts";
import { runPreflightProcess } from "./preflightProcess.ts";
import { checkRuntimeAvailability } from "./runtimeAvailability.ts";
import type { RemoteGoatRunnerOptions } from "./tunnel.ts";

const FACTS = String.raw`printf 'GOAT_OS=%s\n' "$(uname -s)"
printf 'GOAT_ARCH=%s\n' "$(uname -m)"
df -Pk "$HOME" | awk 'END { print "GOAT_FREE_KIB=" $4 }'
for dir in "$HOME"/.goat/runtime/goat/versions/*; do
  version="$(basename "$dir")"
  if [ -d "$dir" ] && [ -x "$dir/goat" ] && [ "$(cat "$dir/.install-complete" 2>/dev/null)" = "$version" ]; then
    printf 'GOAT_INSTALLED=%s\n' "$version"
    held_file="$HOME/.goat/runtime/goat/held/$version"
    if [ -e "$held_file" ] || [ -L "$held_file" ]; then
      case "$(cat "$held_file" 2>/dev/null || true)" in rejected) held=rejected ;; *) held=pending ;; esac
      printf 'GOAT_HELD=%s:%s\n' "$version" "$held"
    fi
  fi
done
for db in "$HOME/.goat/userdata/statev2.sqlite" "$HOME/.goat/userdata/state.sqlite"; do
  if [ -e "$db" ] || [ -L "$db" ]; then printf 'GOAT_HAS_DATA=1\n'; break; fi
done
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    command -v cygpath >/dev/null 2>&1 && printf 'GOAT_CYGPATH=yes\n'
    root="$(cygpath -u "$SystemRoot" 2>/dev/null)"
    [ -x "$root/System32/tar.exe" ] && printf 'GOAT_SYSTEM_TAR=yes\n'
    ;;
esac
printf 'GOAT_FACTS_DONE=yes\n'
`;
const commonArgs = readOnlySshArgs;
const methodList = (stderr: string) => {
  const denied = [...stderr.matchAll(/Permission denied\s*\(([^)]+)\)/giu)].at(-1)?.[1];
  return (
    denied ??
    [...stderr.matchAll(/Authentications that can continue:\s*([a-z0-9,-]+)/giu)].at(-1)?.[1] ??
    ""
  );
};
const safeLine = (text: string) =>
  text
    // SSH and local proxy stderr can contain terminal escape sequences.
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)
    .find((line) => line.trim())
    ?.slice(0, 1000) ?? "SSH command failed.";
const tailscaleHost = (hostname: string) =>
  /\.ts\.net$/iu.test(hostname) || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u.test(hostname);

const tailscalePolicyRefusal = (stderr: string) =>
  /tailscale: tailnet policy does not permit you to SSH as user /iu.test(stderr);

const diagnosticHost = (stderr: string) => /(?:^|\n)[^\s@]+@(\S+):\s+/u.exec(stderr)?.[1];
const normalizedHost = (hostname: string) => {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!host.includes(":")) return host;
  try {
    return new URL(`http://[${host}]/`).hostname;
  } catch {
    return host;
  }
};
const formatDiskSpace = (kib: number) => {
  const units = ["KB", "MB", "GB", "TB"];
  let value = kib;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Math.round(value)} ${units[unit]}`;
};

export const runSshPreflight = Effect.fn("ssh/preflight.run")(function* (
  input: SshPreflightInput,
  options: {
    readonly ownerLabel: string;
    readonly runner: RemoteGoatRunnerOptions;
    readonly alias?: string;
  },
) {
  const parsed = parseSshDestination(input);
  if (
    !parsed.ok ||
    [input.host, input.user, input.identityFile].some(
      (value) => value !== undefined && /[\r\n\0]/u.test(value),
    )
  )
    return yield* new SshHostProbeError({
      host: input.host,
      reason: "invalid_request",
      message: parsed.ok ? "Invalid SSH identity file." : parsed.message,
    });
  const target = parsed.destination;
  const overrides = [
    ...(target.user ? ["-l", target.user] : []),
    ...(target.port ? ["-p", String(target.port)] : []),
    ...(input.identityFile ? ["-i", input.identityFile] : []),
  ];
  const ssh = yield* resolveSshCommand;
  const resolved = yield* runPreflightProcess(ssh, [
    "-G",
    ...commonArgs,
    ...overrides,
    target.hostname,
  ]);
  const settings = new Map<string, string>();
  const identities: string[] = [];
  for (const line of resolved.stdout.split(/\r?\n/u)) {
    const [key = "", ...rest] = line.trim().split(/\s+/u);
    if (!settings.has(key)) settings.set(key, rest.join(" "));
    if (key === "identityfile") identities.push(rest.join(" "));
  }
  const destination = {
    ...(options.alias ? { alias: options.alias } : {}),
    hostname: settings.get("hostname") || target.hostname,
    user: settings.get("user") || target.user || "unknown",
    port: Number(settings.get("port")) || target.port || 22,
  };
  const displayHost =
    options.alias === target.hostname && /^goat-.+-[a-f0-9]{8}$/u.test(target.hostname)
      ? destination.hostname
      : target.hostname;
  const steps: SshPreflightStep[] = [];
  const policyFailure = () =>
    steps.push({
      id: "key_auth",
      state: "failed",
      summary: `Tailscale's SSH policy doesn't allow signing in to ${displayHost} as ${destination.user}.`,
      fix: {
        actor: "human",
        instruction: `Sign in as a user the policy allows, or allow ${destination.user} for this device in the Tailscale admin console's SSH access rules.`,
      },
    });
  let platformKey: string | undefined;
  const finish = (): SshPreflightReport => {
    const blocker = steps.find((step) => step.state === "failed" || step.state === "needs_review");
    const ordered = SSH_PREFLIGHT_STEP_ORDER.map(
      (id) =>
        steps.find((step) => step.id === id) ?? {
          id,
          state: "skipped" as const,
          summary: blocker
            ? {
                reachability: "Waits for the connection check.",
                host_key: "Waits for the host key check.",
                key_auth: "Waits for SSH sign-in.",
                platform: "Waits for the platform check.",
                disk: "Waits for the disk space check.",
                runtime: "Waits for the runtime check.",
              }[blocker.id]
            : "Waits for SSH checks.",
        },
    );
    return {
      host: input.host,
      destination,
      steps: ordered,
      ready: !blocker,
      ...(platformKey ? { platformKey } : {}),
    };
  };
  const isJumpHop = (host: string) =>
    ![destination.hostname, target.hostname].some(
      (candidate) => normalizedHost(candidate) === normalizedHost(host),
    );
  const reachabilityFailure = (stderr: string) => {
    const hop = diagnosticHost(stderr);
    const diagnostic = sshFailureDiagnostic(`Cannot reach ${input.host}.`, stderr);
    const proxy = sshLocalProxyFailure(stderr);
    const instruction =
      proxy?.fix ??
      (/connection refused/iu.test(stderr)
        ? "Enable Remote Login (macOS) or start sshd on the host, then check again."
        : tailscaleHost(destination.hostname) ||
            (!destination.hostname.includes(".") && !destination.hostname.includes(":")) ||
            /tailscale/iu.test(stderr)
          ? "Check that Tailscale is running and signed in on both machines, then check the host name and SSH access."
          : "Check the host name, network and SSH port, then check again.");
    steps.push({
      id: "reachability",
      state: "failed",
      summary: hop && isJumpHop(hop) ? `SSH jump hop ${hop} failed: ${diagnostic}` : diagnostic,
      fix: { actor: "human", instruction },
    });
  };
  if (resolved.exitCode !== 0) {
    reachabilityFailure(resolved.stderr);
    return finish();
  }
  const proxyArgs = yield* readOnlyProxyJumpArgs(ssh, settings).pipe(Effect.result);
  if (proxyArgs._tag === "Failure") {
    reachabilityFailure(proxyArgs.failure.message);
    return finish();
  }
  const run = (authentication: string, command: ReadonlyArray<string> = ["exit", "0"]) =>
    runPreflightProcess(ssh, [
      ...commonArgs,
      ...proxyArgs.success,
      ...overrides,
      "-o",
      `PreferredAuthentications=${authentication}`,
      "-o",
      "StrictHostKeyChecking=yes",
      target.hostname,
      ...command,
    ]);
  const handshake = yield* run("none");
  const wrongHop = diagnosticHost(handshake.stderr);
  if (wrongHop && isJumpHop(wrongHop)) {
    reachabilityFailure(handshake.stderr);
    return finish();
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(handshake.stderr)) {
    steps.push(
      { id: "reachability", state: "passed", summary: `Reached ${destination.hostname}.` },
      {
        id: "host_key",
        state: "failed",
        summary: "The SSH host key changed.",
        fix: {
          actor: "human",
          instruction:
            "Verify the new fingerprint with the host's owner before changing the saved host key.",
        },
      },
    );
    return finish();
  }
  const unknownKey = /No .*host key is known|Host key verification failed/iu.test(handshake.stderr);
  const methods = methodList(handshake.stderr);
  const policyDenied = tailscalePolicyRefusal(handshake.stderr);
  if (handshake.exitCode !== 0 && !methods && !unknownKey && !policyDenied) {
    reachabilityFailure(handshake.stderr);
    return finish();
  }
  steps.push({ id: "reachability", state: "passed", summary: `Reached ${destination.hostname}.` });
  if (unknownKey || !options.alias) {
    const key = yield* probeHostKey({
      target: target.hostname,
      ...(target.user ? { user: target.user } : {}),
      ...(target.port ? { port: target.port } : {}),
      resolvedSettings: settings,
    }).pipe(Effect.result);
    steps.push({
      id: "host_key",
      state: key._tag === "Success" ? "needs_review" : "failed",
      summary:
        key._tag === "Success"
          ? "Review and pin this host's SSH fingerprint."
          : "Could not collect this host's negotiated SSH fingerprint. Check again.",
      detail:
        key._tag === "Failure"
          ? key.failure.message
          : unknownKey
            ? "This key is not trusted by known_hosts."
            : "This address is already in known_hosts. Approve it once so GOAT can pin it.",
      ...(key._tag === "Failure"
        ? {
            fix: {
              actor: "human" as const,
              instruction: `${key.failure.message} Check the host's SSH settings and try again.`,
            },
          }
        : {}),
      ...(key._tag === "Success" ? { fingerprint: key.success.fingerprint } : {}),
    });
    return finish();
  }
  steps.push({ id: "host_key", state: "passed", summary: "The SSH host key matches." });
  if (policyDenied) {
    policyFailure();
    return finish();
  }
  const facts = yield* run(handshake.exitCode === 0 ? "none,publickey" : "publickey", [
    "sh",
    "-c",
    `'${FACTS.replaceAll("'", "'\\''")}'`,
  ]);
  if (facts.exitCode !== 0 && tailscalePolicyRefusal(facts.stderr)) {
    policyFailure();
    return finish();
  }
  // Protected jump children share stderr with the destination's SSH process.
  const authentication = [
    ...facts.stderr.matchAll(
      /^(?:debug1: )?Authenticated to (\S+)[^\r\n]* using ["']?(publickey|none)\b/gimu,
    ),
  ]
    .find((match) => !isJumpHop(match[1]!))?.[2]
    ?.toLowerCase();
  if (facts.exitCode !== 0 && !authentication) {
    const offered = /Offering public key: (.+?)(?: SHA256:|$)/mu.exec(facts.stderr)?.[1];
    const authMethods = methodList(facts.stderr) || methods;
    const partial = /with partial success/iu.test(facts.stderr);
    const denied = /Permission denied/iu.test(facts.stderr);
    const fs = yield* FileSystem.FileSystem;
    const home = yield* HostProcess.HomeDirectory;
    let publicKeyPath = offered ? `${offered}.pub` : undefined;
    if (!publicKeyPath) {
      for (const identity of identities) {
        const candidate = `${identity.replace(/^~(?=\/)/u, home)}.pub`;
        if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          publicKeyPath = candidate;
          break;
        }
      }
    }
    const guidance = buildSshKeyAuthInstructions({
      originLabel: options.ownerLabel,
      host: displayHost,
      ...(options.alias ? { alias: options.alias } : {}),
      user: destination.user,
      port: destination.port,
      publicKeyPath: publicKeyPath ?? `${home}/.ssh/id_ed25519.pub`,
    });
    steps.push({
      id: "key_auth",
      state: "failed",
      summary: partial
        ? `The key was accepted, but this host also requires ${authMethods || "another authentication method"}.`
        : denied
          ? authMethods.includes("publickey")
            ? /password|keyboard-interactive/u.test(authMethods)
              ? `${displayHost} refused ${options.ownerLabel}'s SSH keys; it would ask for a password, and GOAT signs in only with keys.`
              : `${displayHost} refused ${options.ownerLabel}'s SSH keys. Add an authorized public key.`
            : `${displayHost} offers only ${authMethods || "non-key authentication"}.`
          : safeLine(facts.stderr),
      fix: {
        actor: "human",
        instruction: partial
          ? "Set AuthenticationMethods publickey for this user in sshd_config."
          : !authMethods.includes("publickey") && denied
            ? "Enable PubkeyAuthentication yes in sshd_config, then add your public key."
            : publicKeyPath
              ? denied && /password|keyboard-interactive/u.test(authMethods)
                ? `Add this computer's key to ${displayHost} once: run this command in Terminal on ${options.ownerLabel}, enter the password when asked, then choose Check again.`
                : guidance.instruction
              : `Create an SSH key on ${options.ownerLabel}, then install its public key on ${displayHost} and check again.`,
        ...(partial
          ? {}
          : guidance.command
            ? {
                command: publicKeyPath
                  ? guidance.command
                  : `ssh-keygen -t ed25519 && ${guidance.command}`,
              }
            : {}),
      },
    });
    return finish();
  }
  steps.push({
    id: "key_auth",
    state: "passed",
    summary:
      authentication === "publickey"
        ? `Signed in using ${options.ownerLabel}'s SSH key.`
        : handshake.exitCode === 0
          ? tailscaleHost(destination.hostname)
            ? "Signed in through Tailscale SSH; no key needed."
            : "The host let GOAT in without a key."
          : "Signed in using an SSH key.",
  });
  const values = new Map(
    facts.stdout.split(/\r?\n/u).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)] as const;
    }),
  );
  const os = values.get("GOAT_OS") ?? "";
  const windows = /^(MINGW|MSYS|CYGWIN)/u.test(os);
  const platform =
    os === "Darwin" ? "darwin" : os === "Linux" ? "linux" : windows ? "win32" : undefined;
  const arch = values.get("GOAT_ARCH");
  const key = platform
    ? cliArchivePlatformKey(
        platform,
        arch === "aarch64" || arch === "arm64"
          ? "arm64"
          : arch === "x86_64" || arch === "amd64"
            ? "x64"
            : (arch ?? ""),
      )
    : undefined;
  if (
    !values.has("GOAT_FACTS_DONE") ||
    !key ||
    (windows && (!values.has("GOAT_CYGPATH") || !values.has("GOAT_SYSTEM_TAR")))
  ) {
    steps.push({
      id: "platform",
      state: "failed",
      summary: !values.has("GOAT_FACTS_DONE")
        ? "SSH needs a POSIX default shell."
        : windows && !values.has("GOAT_CYGPATH")
          ? "Windows is missing cygpath."
          : windows && !values.has("GOAT_SYSTEM_TAR")
            ? "Windows is missing System32 tar."
            : `GOAT does not support ${os || "this OS"}/${arch ?? "unknown architecture"}.`,
      fix: {
        actor: "human",
        instruction:
          windows || !os
            ? "Install Git for Windows and set OpenSSH DefaultShell to its bash; ensure cygpath and Windows System32 tar are available."
            : "Use a supported GOAT host platform.",
      },
    });
    return finish();
  }
  platformKey = key;
  steps.push({ id: "platform", state: "passed", summary: `Supports ${key}.` });
  const heldVersions = new Map(
    facts.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("GOAT_HELD="))
      .map((line) => {
        const at = line.lastIndexOf(":");
        return [line.slice(10, at), line.slice(at + 1)] as const;
      }),
  );
  const installedCandidates = facts.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("GOAT_INSTALLED="))
    .map((line) => {
      const version = line.slice(15);
      const held = heldVersions.get(version);
      return {
        version,
        ...(held === "pending" || held === "rejected" ? { held: held as typeof held } : {}),
      };
    });
  const installedVersions = installedCandidates
    .filter((candidate) => candidate.held === undefined)
    .map((candidate) => candidate.version);
  const runtime = yield* checkRuntimeAvailability({
    runner: options.runner,
    ownerLabel: options.ownerLabel,
    platformKey: key,
    installedCandidates,
    hostHasData: values.get("GOAT_HAS_DATA") === "1",
    host: input.host,
  });
  steps.push(runtime.step);
  const mayNeedInstallation =
    !options.runner.nodeScriptPath?.trim() &&
    !installedVersions.includes(options.runner.archiveVersion?.trim() ?? "");
  const freeKiB = Number(values.get("GOAT_FREE_KIB"));
  steps.push({
    id: "disk",
    state: !Number.isFinite(freeKiB)
      ? "warning"
      : freeKiB < 512 * 1024
        ? runtime.needsTransfer
          ? "failed"
          : mayNeedInstallation
            ? "warning"
            : "passed"
        : "passed",
    summary: !Number.isFinite(freeKiB)
      ? "Could not check free space in the home folder."
      : freeKiB < 512 * 1024 && runtime.needsTransfer
        ? `Only ${formatDiskSpace(freeKiB)} free; installing GOAT needs ${formatDiskSpace(512 * 1024)} for the archive and extracted runtime.`
        : freeKiB < 512 * 1024 && mayNeedInstallation
          ? `Only ${formatDiskSpace(freeKiB)} free; a new GOAT installation needs 512 MB${installedVersions.length ? " if the installed runtime cannot be reused" : ""}.`
          : `${formatDiskSpace(freeKiB)} free in the home folder.`,
    ...(freeKiB < 512 * 1024 && runtime.needsTransfer
      ? {
          fix: {
            actor: "human" as const,
            instruction: `Free at least ${formatDiskSpace(512 * 1024)} in the host's home folder, then check again.`,
          },
        }
      : {}),
  });
  return finish();
});
