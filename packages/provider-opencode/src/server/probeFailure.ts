import { withLoginShellPathNote } from "@goat/shared/cliPath";
import {
  classifySpawnFailure,
  isCommandMissingCause,
  spawnFailureMessage,
} from "@goat/provider-core/server/snapshotProbe";
import * as Data from "effect/Data";

import { findSpawnFailure } from "./spawnFailure.ts";

export class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause?: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

const OPENCODE_MISSING = "OpenCode CLI (`opencode`) is not installed or not on PATH.";

export function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly host: Parameters<typeof withLoginShellPathNote>[1];
  readonly isExternalServer: boolean;
  readonly phase: "version" | "inventory";
  readonly serverUrl: string;
  readonly binaryPath: string;
}): {
  readonly installed: boolean;
  readonly message: string;
  readonly authStatus?: "unauthenticated";
} {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    // Bare auth-code digits can be part of the endpoint's port or path.
    if (
      /(?:^|\s)(?:status(?:\s+code)?(?:\s*[:=]\s*|\s+)|http(?:\/\d(?:\.\d)?)?\s+)(?:401|403)\b/.test(
        lower,
      ) ||
      /\b(?:unauthorized|forbidden)\b/.test(lower)
    ) {
      return {
        installed: true,
        authStatus: "unauthenticated",
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  const spawn = findSpawnFailure(input.cause);
  if (spawn !== undefined) {
    const failure = classifySpawnFailure(input.cause, spawn.cwd, undefined, {
      binary: input.binaryPath,
      env: { PATH: spawn.path },
    });
    if (failure === "missing")
      return { installed: false, message: withLoginShellPathNote(OPENCODE_MISSING, input.host) };
    const message = spawnFailureMessage(failure, spawn.cwd, input.binaryPath);
    if (message) return { installed: true, message };
  }
  let cause = spawn === undefined ? input.cause : undefined;
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    if (isCommandMissingCause(cause)) {
      return { installed: false, message: withLoginShellPathNote(OPENCODE_MISSING, input.host) };
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted. Try reinstalling OpenCode.",
    };
  }

  const failureLabel =
    input.phase === "inventory"
      ? "Failed to load OpenCode provider inventory"
      : "Failed to execute OpenCode CLI health check";
  return {
    installed: true,
    message: detail ? `${failureLabel}: ${detail}` : `${failureLabel}.`,
  };
}
