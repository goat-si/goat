import { AuthMcpClientAccess, AuthSessionId } from "@goat/contracts";
import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import {
  CliCredentialError,
  CliLogin,
  type CliCredential,
  refuseInThread,
  resolveCliCredential,
  type StoredLogin,
  threadEnvironment,
} from "./cliCredential.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * `goat login` signs this terminal in to the local server as an mcp-client, the only outside
 * subject /mcp accepts, and keeps the session beside the server's state (a 0700 directory).
 * `goat call` and the commands generated from the registry use it outside a thread.
 */
const LOGIN_FILE = "cli-login.json";
const LOGIN_LABEL = "goat CLI";

type Paths = Pick<ServerConfig.ServerConfig["Service"], "stateDir" | "serverRuntimeStatePath">;

const loginFilePath = (paths: Paths) =>
  Effect.map(Path.Path, (path) => path.join(paths.stateDir, LOGIN_FILE));

const decodeLogin = Schema.decodeUnknownEffect(Schema.fromJsonString(CliLogin));
const encodeLogin = Schema.encodeSync(Schema.fromJsonString(CliLogin));

const readStoredLogin = Effect.fn("cli.login.read")(function* (paths: Paths) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* loginFilePath(paths);
  if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))))
    return Option.none<CliLogin>();
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  return yield* decodeLogin(text).pipe(
    Effect.asSome,
    Effect.mapError(
      () =>
        new CliCredentialError({
          reason: "not_logged_in",
          detail: `${file} is not a goat login. Run goat login again.`,
        }),
    ),
  );
});

/** A stored login with the endpoint of the server it was issued by, read fresh each call. */
const loadStoredLogin = Effect.fn("cli.login.load")(function* (paths: Paths) {
  const login = yield* readStoredLogin(paths);
  if (Option.isNone(login)) return Option.none<StoredLogin>();
  const runtime = yield* readPersistedServerRuntimeState(paths.serverRuntimeStatePath).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(runtime))
    return yield* new CliCredentialError({
      reason: "server_not_running",
      detail: "No GOAT server is running for this login. Start GOAT, then retry.",
    });
  return Option.some({
    endpoint: new URL("/mcp", runtime.value.origin).href,
    login: login.value,
  });
});

/**
 * The credential for this shell: the thread's own when set, otherwise the stored login. Paths
 * resolve only when the login is needed.
 */
export const resolveShellCredential = <E, R>(paths: Effect.Effect<Paths, E, R>) =>
  Effect.flatMap(threadEnvironment, (thread) =>
    resolveCliCredential(thread, Effect.flatMap(paths, loadStoredLogin)),
  );

const withEnvironmentAuth = Effect.fn("cli.login.withEnvironmentAuth")(function* <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
    readonly paths: Paths;
  }) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.flatMap(EnvironmentAuth.EnvironmentAuth, (auth) =>
    run({ auth, paths: config }),
  ).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
});

const decodeSessionId = Schema.decodeUnknownEffect(AuthSessionId);

const revokeStored = (auth: EnvironmentAuth.EnvironmentAuth["Service"], login: CliLogin) =>
  decodeSessionId(login.sessionId).pipe(
    Effect.flatMap(auth.revokeSession),
    Effect.ignore({ log: true }),
  );

export const loginCommand = Command.make("login", {
  ...authLocationFlags,
  access: Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "What the session may do, and the most it may run the threads it starts or changes with. Defaults to approval-required.",
    ),
    Flag.withDefault("approval-required" as const),
  ),
}).pipe(
  Command.withDescription(
    "Sign this terminal in to the local GOAT server for goat call and the registry commands.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* refuseInThread("goat login");
      yield* withEnvironmentAuth(flags, ({ auth, paths }) =>
        Effect.gen(function* () {
          const previous = yield* readStoredLogin(paths).pipe(
            Effect.orElseSucceed(() => Option.none<CliLogin>()),
          );
          const issued = yield* auth.issueMcpClientSession({
            label: LOGIN_LABEL,
            access: flags.access,
            client: { deviceType: "bot" },
          });
          const file = yield* loginFilePath(paths);
          const fs = yield* FileSystem.FileSystem;
          // The old login keeps working until the new one is on disk; a new one that could
          // not be saved is revoked rather than left valid and unreachable.
          yield* writeFileStringAtomically({
            filePath: file,
            contents: `${encodeLogin({
              version: 1,
              sessionId: issued.sessionId,
              token: issued.token,
              label: LOGIN_LABEL,
              expiresAt: DateTime.formatIso(issued.expiresAt),
            })}\n`,
          }).pipe(
            Effect.andThen(fs.chmod(file, 0o600)),
            Effect.tapError(() => auth.revokeSession(issued.sessionId).pipe(Effect.ignore)),
          );
          if (Option.isSome(previous)) yield* revokeStored(auth, previous.value);
          yield* Console.log(
            `Signed in as ${LOGIN_LABEL} (${flags.access}) until ${DateTime.formatIso(issued.expiresAt)}. goat logout or Settings → Connections revokes it.`,
          );
        }),
      );
    }),
  ),
);

export const logoutCommand = Command.make("logout", { ...authLocationFlags }).pipe(
  Command.withDescription("Revoke this terminal's goat login and forget it."),
  Command.withHandler((flags) =>
    withEnvironmentAuth(flags, ({ auth, paths }) =>
      Effect.gen(function* () {
        const login = yield* readStoredLogin(paths).pipe(
          Effect.orElseSucceed(() => Option.none<CliLogin>()),
        );
        const fs = yield* FileSystem.FileSystem;
        if (Option.isSome(login)) yield* revokeStored(auth, login.value);
        yield* fs.remove(yield* loginFilePath(paths), { force: true });
        yield* Console.log(Option.isSome(login) ? "Signed out." : "Not signed in.");
      }),
    ),
  ),
);

const describeCredential = (credential: CliCredential) =>
  credential.source === "thread"
    ? `GOAT thread credential from this shell's environment\nEndpoint: ${credential.endpoint}`
    : `${credential.login.label} (session ${credential.login.sessionId}, expires ${credential.login.expiresAt})\nEndpoint: ${credential.endpoint}`;

export const whoamiCommand = Command.make("whoami", { ...authLocationFlags }).pipe(
  Command.withDescription(
    "Show which credential goat call uses here, and check the server accepts it.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const credential = yield* resolveShellCredential(resolveCliAuthConfig(flags, logLevel));
      yield* Console.log(describeCredential(credential));
      yield* mcpToolSession({
        endpoint: credential.endpoint,
        authorization: credential.authorization,
        clientName: "goat-whoami",
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new CliError.UserError({
              cause,
              userMessage: `The server did not accept it: ${cause.message}`,
            }),
        ),
      );
      yield* Console.log("The server accepts it.");
    }).pipe(
      Effect.catchTags({
        CliCredentialError: (error) =>
          Effect.fail(new CliError.UserError({ cause: error, userMessage: error.message })),
      }),
    ),
  ),
);
