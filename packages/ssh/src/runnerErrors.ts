import * as Schema from "effect/Schema";

export class SshInvalidArchiveVersionError extends Schema.TaggedError<SshInvalidArchiveVersionError>()(
  "SshInvalidArchiveVersionError",
  { archiveVersion: Schema.String },
) {
  override get message(): string {
    return `'${this.archiveVersion}' is not an exact GOAT version and cannot name a runtime directory.`;
  }
}

// The version names a runtime directory, so it must be one exact SemVer segment.
export const EXACT_ARCHIVE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export class SshMissingRunnerError extends Schema.TaggedError<SshMissingRunnerError>()(
  "SshMissingRunnerError",
  {},
) {
  override get message(): string {
    return "A remote goat runner needs an archive version or a node script path.";
  }
}
