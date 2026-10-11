import * as Schema from "effect/Schema";

const competingCredentials = [
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
] as const;

/** Gives electron-builder's keychain profile precedence over ambient credentials. */
export function resolveMacNotarizationEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly signed: boolean;
    readonly platform: string;
    readonly requireNotarization: boolean;
  },
) {
  const resolved = { ...env };
  if (!options.signed || options.platform !== "mac") {
    return { env: resolved, problem: undefined };
  }
  const present = (key: string) => Boolean(resolved[key]?.trim());
  if (present("APPLE_KEYCHAIN_PROFILE")) {
    for (const key of competingCredentials) {
      delete resolved[key];
    }
  }
  const complete =
    present("APPLE_KEYCHAIN_PROFILE") ||
    ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"].every(present) ||
    ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"].every(present);
  return {
    env: resolved,
    problem:
      options.requireNotarization && !complete
        ? "Notarization requires APPLE_KEYCHAIN_PROFILE, the complete APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER set, or the complete APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID set."
        : undefined,
  };
}

export interface NotarytoolAuthConfig {
  readonly appleKeychainProfile?: string | undefined;
  readonly appleKeychain?: string | undefined;
  readonly appleApiKey?: string | undefined;
  readonly appleApiKeyId?: string | undefined;
  readonly appleApiIssuer?: string | undefined;
}

/** notarytool supports the runner's stored profile or an explicit API key. */
export function notarytoolAuthArgs(config: NotarytoolAuthConfig) {
  const profile = config.appleKeychainProfile?.trim();
  const keychain = config.appleKeychain?.trim();
  if (profile) {
    return ["--keychain-profile", profile, ...(keychain ? ["--keychain", keychain] : [])];
  }
  const key = config.appleApiKey?.trim();
  const keyId = config.appleApiKeyId?.trim();
  const issuer = config.appleApiIssuer?.trim();
  return key && keyId && issuer ? ["--key", key, "--key-id", keyId, "--issuer", issuer] : undefined;
}

export class DesktopNotarizationCredentialsMissingError extends Schema.TaggedError<DesktopNotarizationCredentialsMissingError>()(
  "DesktopNotarizationCredentialsMissingError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class CliNotarizationCredentialsMissingError extends Schema.TaggedError<CliNotarizationCredentialsMissingError>()(
  "CliNotarizationCredentialsMissingError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class NotarytoolSubmitError extends Schema.TaggedError<NotarytoolSubmitError>()(
  "NotarytoolSubmitError",
  {
    id: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    detail: Schema.String,
    log: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `${this.detail}${this.id ? ` Submission ${this.id}.` : ""}${this.status ? ` Status: ${this.status}.` : ""}${this.log ? `\n${this.log}` : ""}`;
  }
}

export const isNotarytoolSubmitError = Schema.is(NotarytoolSubmitError);

const decodeSubmission = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.NonEmptyString, status: Schema.NonEmptyString }),
  ),
);

/** A successful process exit is insufficient: Apple must have accepted the submission. */
export function parseNotarytoolSubmitOutput(json: string) {
  let submission;
  try {
    submission = decodeSubmission(json);
  } catch {
    throw new NotarytoolSubmitError({ detail: "Invalid notarytool submission JSON." });
  }
  if (submission.status !== "Accepted") {
    throw new NotarytoolSubmitError({ ...submission, detail: "Notarization was not accepted." });
  }
  return submission;
}
