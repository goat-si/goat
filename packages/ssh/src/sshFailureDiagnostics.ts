import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import { buildSshKeyAuthInstructions } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { resolveSshTarget, runSshCommand, targetConnectionKey } from "./command.ts";
import {
  isSshHostUnreachable,
  sshAuthenticationFailure,
  sshFailureDiagnostic,
  sshLocalProxyFailure,
} from "@goat/shared/sshFailure";
import type { SshHostFailure, SshHostResult } from "@goat/contracts";
import { archiveFailure } from "./runtimePreparationErrors.ts";
import {
  SshCommandError,
  SshLaunchError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

// A timeout headline and a local proxy diagnosis outrank incidental warnings
// and OpenSSH's trailing generic closure. Only one sanitized line is public.
function publicSshDiagnostic(error: { readonly message: string }) {
  return sshFailureDiagnostic(
    error.message,
    error instanceof SshCommandError ? error.stderr : error.message,
  )
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(
      /((?:token|password|secret|credential|authorization|api[_-]?key)[\w-]*[\s"']*[:=][\s"']*)[^\s"'&,;]+/giu,
      "$1[redacted]",
    )
    .replace(
      /((?:--)?(?:token|password|secret|credential|api[_-]?key)[\w-]*\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(?:sk-|gh[opusr]_|github_pat_)[A-Za-z0-9_-]+/gu, "[redacted]")
    .slice(0, 500);
}

export function runtimeFailureResult(
  host: string,
  requestedVersion: string,
  runtimeVersion: string | null,
  error: { readonly message: string },
): SshHostResult {
  const base = { host, requestedVersion, runtimeVersion };
  const diagnostic = publicSshDiagnostic(error);
  const evidence = error instanceof SshCommandError ? error.stderr : error.message;
  const failed = (failure: SshHostFailure): SshHostResult => ({
    kind: "ok",
    status: { ...base, state: "failed", failure },
  });
  if (error instanceof SshLaunchError) {
    const failure = archiveFailure(error);
    if (failure !== undefined) return failed(failure);
    if (error.reason === "runtime-newer") {
      return { kind: "ok", status: { ...base, state: "update_blocked", detail: diagnostic } };
    }
  }
  if (/cannot open its data because a newer GOAT build already upgraded it/iu.test(diagnostic)) {
    return {
      kind: "ok",
      status: {
        ...base,
        state: "failed",
        detail: diagnostic,
        failure: {
          reason: "operation_failed",
          fix: {
            actor: "human",
            instruction: `Update this app or the GOAT runtime on ${host}, then reconnect.`,
          },
        },
      },
    };
  }
  const source = `${error.message}\n${evidence}`;
  const proxy = sshLocalProxyFailure(source);
  if (proxy !== undefined) {
    return {
      kind: "error",
      code: "operation_failed",
      message: `${host}: ${diagnostic}`,
      fix: { actor: "human", instruction: proxy.fix },
    };
  }
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|host key.*changed|offending .* key/iu.test(evidence)
  ) {
    return failed({
      reason: "host_key_changed",
      fix: {
        actor: "human",
        instruction: "Forget the host, then add it again to review its new fingerprint.",
        path: "ssh.host_forget",
      },
    });
  }
  if (
    /host key verification failed|no .* host key is known|authenticity of host/iu.test(evidence)
  ) {
    return { kind: "ok", status: { ...base, state: "untrusted", detail: diagnostic } };
  }
  if (
    error instanceof SshPasswordPromptError ||
    sshAuthenticationFailure(source) !== undefined ||
    /permission denied|authentication failed|SSH authentication timed out for /iu.test(diagnostic)
  ) {
    return { kind: "ok", status: { ...base, state: "auth_failed", detail: diagnostic } };
  }
  if (
    error instanceof SshReadinessError ||
    /GOAT.*(?:did not become ready|(?:start|launch).*timed out)/iu.test(diagnostic)
  ) {
    return failed({ reason: "start_timeout", fix: { actor: "agent", instruction: "Try again" } });
  }
  if (/Remote host .+ has no GOAT release archive\./iu.test(diagnostic)) {
    return failed({
      reason: "unsupported_platform",
      fix: { actor: "human", instruction: "Use Linux, an Apple Silicon Mac, or Windows." },
    });
  }
  if (
    /Remote host is missing node on PATH|Install shasum or sha256sum|Remote host needs curl or wget|tar(?:\.exe)?:.*(?:not found|not recognized)|[/\\]tar\.exe:\s*No such file or directory|'sh' is not recognized as an internal or external command|\bsh\s*:\s*The term 'sh' is not recognized/iu.test(
      source,
    )
  ) {
    const instruction = /missing node/iu.test(source)
      ? `Install Node on ${host} for the source runtime, then try again.`
      : /curl or wget/iu.test(source)
        ? `Install curl or wget on ${host}, then try again.`
        : /'sh' is not recognized|\bsh\s*:\s*The term 'sh' is not recognized/iu.test(source)
          ? `Install Git for Windows on ${host} and set Git Bash as the OpenSSH DefaultShell, then try again.`
          : /tar(?:\.exe)?:/iu.test(source)
            ? `Install tar on ${host}, then try again.`
            : `Install sha256sum (coreutils) on ${host}, then try again.`;
    return failed({ reason: "missing_tools", fix: { actor: "human", instruction } });
  }
  return {
    kind: "error",
    code:
      error instanceof SshCommandError && isSshHostUnreachable(source)
        ? "host_unreachable"
        : "operation_failed",
    message: `${host}: ${diagnostic}`,
    fix: { actor: "agent", instruction: "Try again" },
  };
}

interface FailureEnrichmentDeps {
  /** The manager's managed hosts directory, when a home directory is known. */
  readonly managedDirectory: Effect.Effect<string | undefined, never, Path.Path>;
  readonly resolvedTargets: ReadonlyMap<string, DesktopSshEnvironmentTarget>;
}

/**
 * Turns a failed status into an actionable one: a package-manager command for missing tools, or
 * key-auth instructions for GOAT's own key. Each manager makes one with its own state.
 */
export function makeFailureEnrichment({
  managedDirectory,
  resolvedTargets,
}: FailureEnrichmentDeps) {
  const enrichFailure = Effect.fn("ssh/tunnel.enrichFailure")(function* (
    target: DesktopSshEnvironmentTarget,
    result: SshHostResult,
  ) {
    if (result.status?.failure?.reason === "missing_tools") {
      const snapshot = result.status;
      const failure = result.status.failure;
      const tools = failure.fix.instruction.includes("curl")
        ? "curl"
        : failure.fix.instruction.includes("Node")
          ? "nodejs"
          : failure.fix.instruction.includes("Install tar")
            ? "tar"
            : "coreutils";
      const probe = yield* runSshCommand(target, {
        batchMode: "yes",
        interactiveAuth: false,
        preHostArgs: ["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"],
        remoteCommandArgs: ["sh", "-s"],
        timeoutMs: 10_000,
        stdin:
          "GOAT_TOOL_FIX_PROBE=1\nid -u\nuname -s\nif [ -r /etc/os-release ]; then cat /etc/os-release; fi\n",
      }).pipe(Effect.option);
      if (Option.isSome(probe)) {
        const [uid, os, ...release] = probe.value.stdout.trim().split(/\r?\n/u);
        const id = /^ID=["']?([a-z0-9-]+)["']?$/mu.exec(release.join("\n"))?.[1];
        const command =
          uid === "0" && os === "Linux"
            ? id === "debian" || id === "ubuntu"
              ? `apt-get update && apt-get install -y ${tools}`
              : id === "alpine"
                ? `apk add ${tools}`
                : id === "fedora" || id === "rhel" || id === "rocky"
                  ? `dnf install -y ${tools}`
                  : undefined
            : undefined;
        if (command !== undefined)
          return {
            ...result,
            status: { ...snapshot, failure: { ...failure, fix: { ...failure.fix, command } } },
          };
      }
      return result;
    }
    if (
      result.status?.state !== "auth_failed" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(target.alias)
    )
      return result;
    // Expose only GOAT's generated public key; an arbitrary IdentityFile is never disclosed.
    const directory = yield* managedDirectory;
    if (directory === undefined) return result;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of ["goat-hosts", "goat-cloud"]) {
      const dir = path.join(path.dirname(directory), name);
      const conf = yield* fs
        .readFileString(path.join(dir, `${target.alias}.conf`))
        .pipe(Effect.orElseSucceed(() => ""));
      const identity = /^\s*IdentityFile\s+"?(.+?)"?\s*$/imu.exec(conf)?.[1];
      if (identity === undefined) continue;
      const expandedIdentity = identity.replace(
        /^~(?=[/\\])/u,
        path.dirname(path.dirname(directory)),
      );
      const publicPath = expandedIdentity.endsWith(".pub")
        ? expandedIdentity
        : `${expandedIdentity}.pub`;
      const linked = yield* fs.readLink(publicPath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) continue;
      const key = (yield* fs
        .readFileString(publicPath)
        .pipe(Effect.orElseSucceed(() => ""))).trim();
      if (
        !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}( .*)?$/u.test(
          key,
        )
      )
        continue;
      const generatedKey = expandedIdentity === path.join(dir, "id_ed25519");
      const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
      const resolved =
        known.username === null
          ? yield* resolveSshTarget(target.alias, target).pipe(Effect.option)
          : Option.none();
      const user =
        /^\s*User\s+(.+?)\s*$/imu.exec(conf)?.[1] ??
        known.username ??
        (Option.isSome(resolved) ? resolved.value.username : null);
      const port = Number(
        /^\s*Port\s+(\d+)\s*$/imu.exec(conf)?.[1] ??
          known.port ??
          (Option.isSome(resolved) ? resolved.value.port : null) ??
          22,
      );
      if (user === null) {
        if (generatedKey) return { ...result, status: { ...result.status, publicKey: key } };
        continue;
      }
      const keyAuth = buildSshKeyAuthInstructions({
        originLabel: "the computer that owns this SSH connection",
        host: target.alias,
        user,
        port,
        publicKeyPath: publicPath,
        generatedKey,
        ...(generatedKey ? { publicKey: key } : {}),
      });
      return {
        ...result,
        status: { ...result.status, ...(generatedKey ? { publicKey: key } : {}), keyAuth },
      };
    }
    return result;
  });
  return { enrichFailure };
}
