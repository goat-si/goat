import * as CliError from "effect/cli/CliError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

/**
 * Which credential a CLI command calls the origin's /mcp with
 * (docs/internals/agent-surface.md#credentials). Kept free of heavy imports: the
 * terminal fallback resolves it on an agent's first-message path.
 */

/** GOAT sets these for an agent's processes, so the CLI inside a thread has that thread's grant. */
const THREAD_ENDPOINT_VARIABLE = "GOAT_ACP_MCP_ENDPOINT";
const THREAD_AUTHORIZATION_VARIABLE = "GOAT_ACP_MCP_AUTHORIZATION";

export type ThreadEnvironment =
  | { readonly _tag: "absent" }
  | { readonly _tag: "present"; readonly endpoint: string; readonly authorization: string }
  /** Set but unusable. Never a reason to try another credential. */
  | { readonly _tag: "invalid"; readonly detail: string };

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export const threadEnvironmentFrom = (
  env: Readonly<Record<string, string | undefined>>,
): ThreadEnvironment => {
  const endpoint = env[THREAD_ENDPOINT_VARIABLE];
  const authorization = env[THREAD_AUTHORIZATION_VARIABLE];
  if (endpoint === undefined && authorization === undefined) return { _tag: "absent" };
  if (endpoint === undefined || authorization === undefined)
    return {
      _tag: "invalid",
      detail: `${endpoint === undefined ? THREAD_ENDPOINT_VARIABLE : THREAD_AUTHORIZATION_VARIABLE} is not set while ${endpoint === undefined ? THREAD_AUTHORIZATION_VARIABLE : THREAD_ENDPOINT_VARIABLE} is.`,
    };
  if (!isHttpUrl(endpoint))
    return { _tag: "invalid", detail: `${THREAD_ENDPOINT_VARIABLE} is not an http(s) URL.` };
  if (authorization.trim() === "")
    return { _tag: "invalid", detail: `${THREAD_AUTHORIZATION_VARIABLE} is empty.` };
  return { _tag: "present", endpoint, authorization };
};

/**
 * This process's thread environment, read from process.env itself: Effect's Config reads an
 * empty variable as unset, which would let a blanked credential fall through to a stored login.
 * A variable that is set, even to "", counts.
 */
export const threadEnvironment: Effect.Effect<ThreadEnvironment> = Effect.sync(() =>
  threadEnvironmentFrom(process.env),
);

/** What `goat login` stores: an mcp-client session on the local server. */
export const CliLogin = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  token: Schema.String,
  label: Schema.String,
  expiresAt: Schema.String,
});
export type CliLogin = typeof CliLogin.Type;

export type CliCredential =
  | {
      readonly source: "thread";
      readonly endpoint: string;
      readonly authorization: string;
    }
  | {
      readonly source: "login";
      readonly endpoint: string;
      readonly authorization: string;
      readonly login: CliLogin;
    };

export class CliCredentialError extends Schema.TaggedError<CliCredentialError>()(
  "CliCredentialError",
  {
    reason: Schema.Literals([
      "thread_credential_invalid",
      "not_logged_in",
      "login_expired",
      "login_unreadable",
      "server_not_running",
    ]),
    detail: Schema.String,
  },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const invalidThreadCredential = (detail: string) =>
  new CliCredentialError({
    reason: "thread_credential_invalid",
    detail: `This shell's GOAT thread credential is unusable: ${detail} The CLI does not fall back to another credential.`,
  });

/** A stored login and the endpoint of the server it belongs to, when there is one. */
export interface StoredLogin {
  readonly endpoint: string;
  readonly login: CliLogin;
}

/**
 * The thread's own credential first. When it is set but unusable the CLI stops: a stored
 * login could carry more authority than the thread has, so it is never the fallback.
 */
export const resolveCliCredential = Effect.fn("cliCredential.resolve")(function* <E, R>(
  thread: ThreadEnvironment,
  loadLogin: Effect.Effect<Option.Option<StoredLogin>, E, R>,
): Effect.fn.Return<CliCredential, CliCredentialError | E, R> {
  if (thread._tag === "present")
    return {
      source: "thread",
      endpoint: thread.endpoint,
      authorization: thread.authorization,
    };
  if (thread._tag === "invalid") return yield* invalidThreadCredential(thread.detail);
  const stored = yield* loadLogin;
  if (Option.isNone(stored))
    return yield* new CliCredentialError({
      reason: "not_logged_in",
      detail: "Not signed in to GOAT. Run goat login, or run this inside a GOAT thread.",
    });
  const expiresAt = DateTime.make(stored.value.login.expiresAt);
  const now = yield* DateTime.now;
  if (Option.isNone(expiresAt) || DateTime.isLessThanOrEqualTo(expiresAt.value, now))
    return yield* new CliCredentialError({
      reason: "login_expired",
      detail: "Your goat login has expired. Run goat login again.",
    });
  return {
    source: "login",
    endpoint: stored.value.endpoint,
    authorization: `Bearer ${stored.value.login.token}`,
    login: stored.value.login,
  };
});

/** The message a credential-minting command refuses with inside a thread. */
const mintingRefusal = (command: string) =>
  `${command} mints a GOAT credential, and this shell holds a GOAT thread credential (${THREAD_AUTHORIZATION_VARIABLE}). Run it from your own terminal.`;

/**
 * Stops mistakes, not a determined agent: a shell with full access can read the state
 * directory itself, so the runtime-mode sandbox is the boundary.
 */
export const refuseInThread = Effect.fn("cliCredential.refuseInThread")(function* (
  command: string,
) {
  const thread = yield* threadEnvironment;
  if (thread._tag !== "absent")
    return yield* new CliError.UserError({ cause: command, userMessage: mintingRefusal(command) });
});
