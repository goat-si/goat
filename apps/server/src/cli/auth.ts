import {
  AuthOrchestrationApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  RuntimeMode,
} from "@goat/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import * as ServerConfig from "../config.ts";
import { MCP_CLIENT_SUBJECT } from "../auth/mcpClientSubject.ts";
import { authScopesFlag } from "./authScopes.ts";
import { refuseInThread } from "./cliCredential.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

const runWithEnvironmentAuth = Effect.fn("auth.runWithEnvironmentAuth")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* run(environmentAuth);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const runtimeModeCeilingFlag = Flag.Literals("runtime-mode-ceiling", RuntimeMode.literals).pipe(
  Flag.withDescription(
    "Most an mcp-client session may run the threads it starts or changes with. Defaults to approval-required.",
  ),
  Flag.optional,
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    refuseInThread("goat auth pairing create").pipe(
      Effect.andThen(
        runWithEnvironmentAuth(
          flags,
          (environmentAuth) =>
            Effect.gen(function* () {
              const issued = yield* environmentAuth.createPairingLink({
                scopes: flags.scopes,
                subject: "one-time-token",
                ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
                ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
              });
              const output = formatIssuedPairingCredential(issued, {
                json: flags.json,
                ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
              });
              yield* Console.log(output);
            }),
          {
            quietLogs: flags.json,
          },
        ),
      ),
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const pairingLinks = yield* environmentAuth.listPairingLinks({
            excludeSubjects: [EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT],
          });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* environmentAuth.revokePairingLink(flags.id);
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
  runtimeModeCeiling: runtimeModeCeilingFlag,
}).pipe(
  Command.withDescription("Issue a scoped bearer access token for headless or remote clients."),
  Command.withHandler((flags) =>
    refuseInThread("goat auth session issue").pipe(
      Effect.andThen(
        runWithEnvironmentAuth(
          flags,
          (environmentAuth) =>
            Effect.gen(function* () {
              const issued = yield* environmentAuth.issueSession({
                scopes: flags.scopes,
                ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
                ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
                ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
                ...(Option.isSome(flags.runtimeModeCeiling)
                  ? { runtimeModeCeiling: flags.runtimeModeCeiling.value }
                  : {}),
              });
              yield* Console.log(
                formatIssuedSession(issued, {
                  json: flags.json,
                  tokenOnly: flags.tokenOnly,
                }),
              );
            }),
          {
            quietLogs: flags.json || flags.tokenOnly,
          },
        ),
      ),
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const sessions = yield* environmentAuth.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(flags, (environmentAuth) =>
      Effect.gen(function* () {
        const revoked = yield* environmentAuth.revokeSession(flags.sessionId);
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

const MCP_CLIENT_TOKEN_TTL = Duration.days(90);

const clientCreateCommand = Command.make("create", {
  ...authLocationFlags,
  name: Flag.String("name").pipe(
    Flag.withDescription("Label shown in Settings → Connections and on answers it records."),
  ),
  scopes: Flag.Literals("scope", [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthOrchestrationApproveScope,
  ]).pipe(
    Flag.withDescription(
      `Repeat for multiple scopes; replaces the default ${AuthOrchestrationReadScope}, ${AuthOrchestrationOperateScope}. ${AuthOrchestrationApproveScope} lets the client accept or decline approvals and needs ${AuthOrchestrationOperateScope}.`,
    ),
    Flag.atLeast(0),
    Flag.map((scopes) => [
      ...new Set(
        scopes.length > 0 ? scopes : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      ),
    ]),
  ),
  ttl: Flag.String("ttl").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Token lifetime, for example `30d`. Defaults to 90 days."),
    Flag.optional,
  ),
  runtimeModeCeiling: runtimeModeCeilingFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Issue a long-lived, revocable MCP client token for an outside orchestrator.",
  ),
  Command.withHandler((flags) =>
    refuseInThread("goat auth client create").pipe(
      Effect.andThen(
        Effect.gen(function* () {
          if (
            flags.scopes.includes(AuthOrchestrationApproveScope) &&
            !flags.scopes.includes(AuthOrchestrationOperateScope)
          ) {
            return yield* new CliError.UserError({
              cause: flags.scopes,
              userMessage: `${AuthOrchestrationApproveScope} needs ${AuthOrchestrationOperateScope}.`,
            });
          }
          return yield* runWithEnvironmentAuth(
            flags,
            (environmentAuth) =>
              Effect.gen(function* () {
                const issued = yield* environmentAuth.issueSession({
                  subject: MCP_CLIENT_SUBJECT,
                  scopes: flags.scopes,
                  label: flags.name,
                  ttl: Option.getOrElse(flags.ttl, () => MCP_CLIENT_TOKEN_TTL),
                  ...(Option.isSome(flags.runtimeModeCeiling)
                    ? { runtimeModeCeiling: flags.runtimeModeCeiling.value }
                    : {}),
                });
                yield* Console.log(
                  formatIssuedSession(issued, { json: flags.json, tokenOnly: flags.tokenOnly }),
                );
              }),
            { quietLogs: flags.json || flags.tokenOnly },
          );
        }),
      ),
    ),
  ),
);

const clientListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List MCP client tokens without revealing them."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const sessions = yield* environmentAuth.listSessions();
          yield* Console.log(
            formatSessionList(
              sessions.filter((session) => session.subject === MCP_CLIENT_SUBJECT),
              { json: flags.json },
            ),
          );
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const clientCommand = Command.make("client").pipe(
  Command.withDescription("Manage long-lived MCP client tokens for outside orchestrators."),
  Command.withSubcommands([clientCreateCommand, clientListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand, clientCommand]),
);
