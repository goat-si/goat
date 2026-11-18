import { V2ConfigRequirementsReadResponse } from "effect-codex-app-server/schema";
import * as Schema from "effect/Schema";

export const Version = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u),
);
export const ActiveRelease = Schema.Struct({ version: Version });
export const InstalledRelease = Schema.Struct({
  version: Version,
  target: Schema.String,
  sha256: Schema.String,
});
export const PackageManifest = Schema.Struct({
  layoutVersion: Schema.Literal(1),
  version: Version,
  target: Schema.String,
  entrypoint: Schema.String,
});
export const decodeVersion = Schema.decodeUnknownEffect(Version);
export const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));
export const encodeActive = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
// The one-shot envelope is not in the protocol bundle. Source: openai/codex
// 1277bcfddc69800c5e3538dccf3f26bedbd80290, app-server/src/startup_config.rs.
export const decodeStartupConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ error: Schema.Struct({ code: Schema.Int, message: Schema.String }) }),
      Schema.Struct({
        appServerVersion: Schema.NonEmptyString,
        configRequirements: V2ConfigRequirementsReadResponse,
        error: Schema.optionalKey(Schema.Never),
      }),
    ]),
  ),
);
export const STARTUP_WARNINGS = {
  configuration: "Codex startup check warning: local configuration validation failed.",
  invalid: "Codex startup check warning: the diagnostic returned an invalid response.",
  unsupported: "Codex startup check warning: this executable does not support the diagnostic.",
  unavailable: "Codex startup check warning: the diagnostic could not complete.",
  timeout: "Codex startup check warning: the diagnostic timed out.",
} as const;
export const STARTUP_STDOUT_MAX_BYTES = 64 * 1024;
export const STARTUP_STDERR_MAX_BYTES = 4 * 1024;
export interface CodexReleaseAsset {
  readonly version: string;
  readonly target: string;
  readonly url: string;
  readonly sha256: string;
  /** Null for an upstream release, whose package checksum is published without a size. */
  readonly archiveBytes: number | null;
}
const RELEASES: Readonly<Record<string, CodexReleaseAsset>> = {
  "darwin-arm64": {
    version: "0.166.0",
    target: "aarch64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-apple-darwin.tar.gz",
    sha256: "55a440cb579f970abe7c79ab181e54b0ea4c419be99f333bbd868eebac9c21f0",
    archiveBytes: 165951869,
  },
  "darwin-x64": {
    version: "0.166.0",
    target: "x86_64-apple-darwin",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-apple-darwin.tar.gz",
    sha256: "1cb65690230be5982c654ba2655e3a3b594dce9c55b780e78bfdfeff829d7ad9",
    archiveBytes: 180076524,
  },
  "linux-arm64": {
    version: "0.166.0",
    target: "aarch64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-unknown-linux-musl.tar.gz",
    sha256: "7821b77dda2e6283fb1f63f3165177a271da8833e857cf673c6ca1c9db3bfcc6",
    archiveBytes: 187370368,
  },
  "linux-x64": {
    version: "0.166.0",
    target: "x86_64-unknown-linux-musl",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-unknown-linux-musl.tar.gz",
    sha256: "1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254",
    archiveBytes: 199694962,
  },
  "win32-arm64": {
    version: "0.166.0",
    target: "aarch64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-pc-windows-msvc.tar.gz",
    sha256: "9383152a72f97bb5dd148493c8214e4fed38d805aa2c3297cb3739f7f130becf",
    archiveBytes: 187024318,
  },
  "win32-x64": {
    version: "0.166.0",
    target: "x86_64-pc-windows-msvc",
    url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
    sha256: "d559bb88e74d471265857b93b7f19bc250dae527673b9191b33534478093f6bc",
    archiveBytes: 202589789,
  },
};
export const resolveCodexReleaseAsset = (platform: NodeJS.Platform, arch: string) =>
  RELEASES[`${platform}-${arch}`] ?? null;
export class CodexInstallationError extends Schema.TaggedError<CodexInstallationError>()(
  "CodexInstallationError",
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
const isInstallationError = Schema.is(CodexInstallationError);
export const installationError = (operation: string, detail: string, cause?: unknown) =>
  new CodexInstallationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
export const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);
export interface CodexExecutable {
  readonly executablePath: string;
  readonly source: "managed" | "local";
  readonly version: string;
  readonly managedVersionDirectory: string | null;
  readonly startupWarning?: (typeof STARTUP_WARNINGS)[keyof typeof STARTUP_WARNINGS];
}
export interface CodexAcquisitionOptions {
  /** Use only GOAT's managed release, even when Codex is on PATH. */
  readonly managedOnly?: boolean;
}
