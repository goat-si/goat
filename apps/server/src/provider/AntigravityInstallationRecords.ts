import { ProviderDriverKind, type ProviderInstallState } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

export const DRIVER = ProviderDriverKind.make("antigravity");
export const DOWNLOAD_TIMEOUT = "45 minutes";
export const VALIDATION_TIMEOUT = "90 seconds";
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
export const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
export const RECORD_MAX_BYTES = 8 * 1024;
export const RELEASE_RECORD = ".install-complete.json";
export const LARGE_PAGE_KERNEL_MESSAGE =
  "Google's linux-arm64 Antigravity runtime needs a kernel with 4 KiB memory pages, and this kernel uses larger pages (as on Asahi Linux or Raspberry Pi 5). Use a remote environment or a custom Antigravity executable.";

export const ReleaseId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const ActiveRelease = Schema.Struct({ releaseId: ReleaseId });
export const InstalledRelease = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  executable: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
  harness: Schema.NullOr(Schema.Struct({ name: Schema.String, bytes: Schema.Number })),
});
export type InstalledRelease = typeof InstalledRelease.Type;
export const encodeActiveRelease = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
export const encodeInstalledRelease = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));

export class AntigravityInstallationError extends Schema.TaggedError<AntigravityInstallationError>()(
  "AntigravityInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
export const isInstallationError = Schema.is(AntigravityInstallationError);
export const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);

export interface AntigravityExecutable {
  readonly executablePath: string;
  /** Null for the `agy` CLI, which embeds the harness and runs as `agy acp`. */
  readonly harnessPath: string | null;
  readonly source: "override" | "managed" | "path";
  readonly version: string | null;
  readonly managedVersionDirectory: string | null;
}

export const installationError = (operation: string, detail: string, cause?: unknown) =>
  new AntigravityInstallationError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);

export function executableNames(platform: NodeJS.Platform) {
  return platform === "win32"
    ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { executable: "agy_acp_server.par", harness: "localharness_external" };
}

/** Antigravity CLI 1.5.0+ serves ACP itself (`agy acp`), so it has no `localharness_external` sibling. */
export function isAntigravityCli(...candidates: ReadonlyArray<string>) {
  return candidates.some((candidate) =>
    /^(?:agy|antigravity)(?:\.(?:exe|cmd|bat))?$/iu.test(candidate.split(/[\\/]/u).at(-1) ?? ""),
  );
}

export function isRunning(state: ProviderInstallState) {
  return (
    state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying"
  );
}
