import * as Data from "effect/Data";

export class SshHostDiscoveryError extends Data.TaggedError("SshHostDiscoveryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export class SshInvalidTargetError extends Data.TaggedError("SshInvalidTargetError")<{
  readonly message: string;
}> {}

export class SshCommandError extends Data.TaggedError("SshCommandError")<{
  readonly message: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout?: string;
  readonly cause?: unknown;
}> {}

export class SshLaunchError extends Data.TaggedError("SshLaunchError")<{
  /** `archive-unavailable`: no source supplied a usable runtime archive for this launch. */
  readonly reason?: "runtime-newer" | "archive-unavailable";
  readonly acquisition?: {
    readonly requestedVersion: string;
    readonly platformKey: string | null;
    readonly sourcesTried: readonly string[];
  };
  /** For `archive-unavailable`: the one step that fixes it. */
  readonly action?: string;
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshPairingError extends Data.TaggedError("SshPairingError")<{
  /** `memory-scopes-unsupported`: the remote CLI cannot issue the memory grants a task asked for. */
  readonly reason?: "memory-scopes-unsupported";
  readonly message: string;
  readonly stdout: string;
  readonly cause?: unknown;
}> {}

export class SshEnsureSupersededError extends Data.TaggedError("SshEnsureSupersededError")<{
  readonly message: string;
}> {}

export class SshPreparationTimeoutError extends Data.TaggedError("SshPreparationTimeoutError")<{
  readonly message: string;
}> {}

export class SshHttpBridgeError extends Data.TaggedError("SshHttpBridgeError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class SshReadinessError extends Data.TaggedError("SshReadinessError")<{
  /** `slow`: requests reached the server but answered too late. `unreachable`: nothing answered. */
  readonly reason?: "slow" | "unreachable";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SshPasswordPromptError extends Data.TaggedError("SshPasswordPromptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SshHostKeyProbeError extends Data.TaggedError("SshHostKeyProbeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
