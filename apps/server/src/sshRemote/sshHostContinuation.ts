import { SshForceReplaceTarget, SshHostAddInput, SshHostAlias } from "@goat/contracts";
import * as Schema from "effect/Schema";

const Endpoint = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  user: Schema.String,
  hostKey: Schema.String,
  proxyJump: Schema.optionalKey(Schema.String),
  proxyCommand: Schema.optionalKey(Schema.String),
});
export const Challenge = Schema.Struct({
  input: SshHostAddInput,
  host: SshHostAlias,
  endpoint: Endpoint,
  fingerprint: Schema.String,
  algorithm: Schema.optionalKey(Schema.String),
  identityFile: Schema.optionalKey(Schema.String),
  expiresAt: Schema.Number,
  aliasGeneration: Schema.Int,
  includeRequired: Schema.Boolean,
});
export type Challenge = typeof Challenge.Type;
/** What an SSH setup approval carries until a person answers it. */
export const Continuation = Schema.Struct({
  version: Schema.Literal(1),
  step: Schema.Literals(["runtime_update", "host_trust", "key_auth"]),
  host: SshHostAlias,
  operationId: Schema.String,
  aliasGeneration: Schema.Int,
  requestedVersion: Schema.optionalKey(Schema.String),
  /** The runtime process the person approved stopping if it cannot hand over. */
  replace: Schema.optionalKey(SshForceReplaceTarget),
  aliasRevision: Schema.optionalKey(Schema.String),
  challenge: Schema.optional(Challenge),
});
export const decodeContinuation = Schema.decodeUnknownEffect(Continuation);

/** The runtime update approval a person reads; it names the process the host may stop. */
export const runtimeUpdateApproval = (host: string, replace: SshForceReplaceTarget | undefined) =>
  replace === undefined
    ? {
        title: `Update runtime on ${host}?`,
        reason:
          "Running agent work gets up to a minute to finish, then continues on the new version.",
      }
    : {
        title: `Update runtime on ${host}, stopping PID ${replace.pid} if needed?`,
        reason: `Running agent work gets up to a minute to finish, then continues on the new version. If the running runtime cannot hand over, GOAT stops PID ${replace.pid} (started ${replace.startedAt} UTC, port ${replace.port}) on ${host}: SIGTERM, then SIGKILL after that minute. Its child processes are not signalled: any still running are named in that host's GOAT log for you to check. If the new version then fails to start, GOAT starts the stopped version again when it can; when it cannot, no runtime runs on ${host} until you update again.`,
      };

/** Why an approved forced update must not run: the named process is no longer the live one. */
export const approvedProcessGone = (
  host: string,
  approved: SshForceReplaceTarget | undefined,
  live: SshForceReplaceTarget | undefined,
) =>
  approved === undefined ||
  (live?.pid === approved.pid &&
    live.port === approved.port &&
    live.startedAt === approved.startedAt)
    ? undefined
    : `GOAT did not update ${host}: PID ${approved.pid} (started ${approved.startedAt} UTC), the runtime you approved stopping, is no longer the one running there. Ask again.`;
