import {
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  OrchestratorMcpFailure,
  hasCloudMachineAliasPrefix,
  type AuthEnvironmentScope,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- opaque grant ids, never credentials.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type * as SessionStore from "../auth/SessionStore.ts";
import { SAFE_ALIAS } from "../hub/HubOcx.ts";
import type { HubPerson } from "../hub/HubMembership.ts";
import type { SshAliasRevision } from "../sshRemote/SshAliasEvents.ts";
import { authorizeSshHost, type SshHostCaller } from "../sshRemote/SshHostAuthorization.ts";

/**
 * A person's standing consent to join one SSH host as this hub's OpenCodex Child. It names the
 * session that gave it and the alias revision it was given for: a Forget, a new Add or a changed
 * pinned key voids it, and so does that session being signed out, expiring or losing
 * settings:write. Agents never write it.
 */
const Grant = Schema.Struct({
  grantId: Schema.String,
  revision: Schema.String,
  sessionId: AuthSessionId,
  grantedAt: Schema.Number,
});
export type SshChildGrant = typeof Grant.Type;
const Grants = Schema.Record(Schema.String, Grant);
const decodeGrants = Schema.decodeUnknownOption(Schema.fromJsonString(Grants));
const encodeGrants = Schema.encodeSync(Schema.fromJsonString(Grants));

export type SshChildConsent =
  | { readonly state: "none" }
  | { readonly state: "granted"; readonly grant: SshChildGrant; readonly person: HubPerson }
  /** `dropped`: the grant is void and gone; otherwise it could not be checked and stays. */
  | { readonly state: "revoked"; readonly dropped: boolean; readonly message: string };

const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "GOAT could not save the SSH host's OpenCodex Child setting. Try again.",
  });

export const makeSshChildConsent = Effect.fn("SshChildConsent.make")(function* (options: {
  readonly directory: string;
  readonly file: string;
  readonly sessions: SessionStore.SessionStore["Service"];
  readonly revision: SshAliasRevision;
}) {
  const fs = yield* FileSystem.FileSystem;
  const stored = yield* fs.readFileString(options.file).pipe(
    Effect.map((text) => Option.getOrElse(decodeGrants(text), () => ({}))),
    Effect.orElseSucceed((): Readonly<Record<string, SshChildGrant>> => ({})),
  );
  const grants = yield* Ref.make<Readonly<Record<string, SshChildGrant>>>(stored);
  const writing = yield* Semaphore.make(1);
  const persist = Effect.fn("SshChildConsent.persist")(function* (
    next: Readonly<Record<string, SshChildGrant>>,
  ) {
    yield* fs.makeDirectory(options.directory, { recursive: true });
    yield* fs.writeFileString(`${options.file}.tmp`, encodeGrants(next));
    yield* fs.rename(`${options.file}.tmp`, options.file);
  }, Effect.mapError(storageFailure));

  /**
   * Removes the grant, in memory before on disk so this process stops using it at once. With a
   * grantId, only that grant: a check that read an older one never removes a newer one. Without
   * one it always writes, so a removal whose earlier write failed succeeds only once it is on disk.
   */
  const drop = (alias: string, grantId?: string) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(grants);
        if (grantId !== undefined && current[alias]?.grantId !== grantId) return;
        const { [alias]: _gone, ...rest } = current;
        yield* Ref.set(grants, rest);
        yield* persist(rest);
      }),
    );
  /** Expiry counts: listActive still lists a connected session past it, this does not. */
  const scopesOf = (sessionId: AuthSessionId) =>
    options.sessions
      .readActiveScopes(sessionId)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<AuthEnvironmentScope> => []));

  /** A person's own consent: a live client session with settings:write, for an alias GOAT set up. */
  const set = Effect.fn("SshChildConsent.set")(function* (
    alias: string,
    enabled: boolean,
    caller: SshHostCaller,
  ) {
    if (caller.kind !== "client")
      return yield* new EnvironmentAuthorizationError({
        requiredScope: AuthSettingsWriteScope,
        message: "Only a person in a GOAT client can change this.",
      });
    yield* authorizeSshHost(options.sessions, caller, AuthSettingsWriteScope);
    if (!(yield* scopesOf(caller.sessionId)).includes(AuthSettingsWriteScope))
      return yield* new EnvironmentAuthorizationError({
        requiredScope: AuthSettingsWriteScope,
        message: "This session has expired or lost settings permission.",
      });
    if (!SAFE_ALIAS.test(alias) || hasCloudMachineAliasPrefix(alias))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Only an SSH host GOAT set up has this setting; cloud machines follow the hub's.",
      });
    if (!enabled) return yield* drop(alias);
    const revision = yield* options.revision(alias).pipe(Effect.mapError(storageFailure));
    if (revision === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `${alias} is not an SSH host GOAT set up. Add it in Settings → Connections first.`,
      });
    const grant: SshChildGrant = {
      grantId: NodeCrypto.randomUUID(),
      revision,
      sessionId: caller.sessionId,
      grantedAt: yield* Clock.currentTimeMillis,
    };
    yield* writing.withPermits(1)(
      Effect.gen(function* () {
        const next = { ...(yield* Ref.get(grants)), [alias]: grant };
        yield* persist(next);
        yield* Ref.set(grants, next);
      }),
    );
  });

  const check = Effect.fn("SshChildConsent.check")(function* (alias: string) {
    const grant = (yield* Ref.get(grants))[alias];
    if (grant === undefined) return { state: "none" } satisfies SshChildConsent;
    const unchecked = (message: string): SshChildConsent => ({
      state: "revoked",
      dropped: false,
      message,
    });
    const revision = yield* options.revision(alias).pipe(Effect.option);
    if (Option.isNone(revision))
      return unchecked(`GOAT could not read ${alias}'s SSH settings; it tries again next time.`);
    if (revision.value !== grant.revision) {
      // Forgotten, added again or re-pinned: consent given for the old alias does not carry over.
      yield* drop(alias, grant.grantId).pipe(Effect.ignore({ log: true }));
      return { state: "none" } satisfies SshChildConsent;
    }
    // The file read above yields: a withdrawal or a new grant made meanwhile wins over this one.
    return yield* confirm(alias, grant.grantId);
  });

  /**
   * The grant still held and its session's live authority, from memory only, so a caller can
   * read it last, after every read that waits.
   */
  const confirm = Effect.fn("SshChildConsent.confirm")(function* (alias: string, grantId: string) {
    const grant = (yield* Ref.get(grants))[alias];
    if (grant?.grantId !== grantId) return { state: "none" } satisfies SshChildConsent;
    const scopes = yield* scopesOf(grant.sessionId);
    if (!scopes.includes(AuthSettingsWriteScope)) {
      yield* drop(alias, grant.grantId).pipe(Effect.ignore({ log: true }));
      return {
        state: "revoked",
        dropped: true,
        message: `The session that turned this on is signed out or lost settings permission, so GOAT turned it off. Turn it on again to keep joining ${alias}.`,
      } satisfies SshChildConsent;
    }
    return {
      state: "granted",
      grant,
      person: { sessionId: grant.sessionId, scopes },
    } satisfies SshChildConsent;
  });

  return {
    set,
    check,
    confirm,
    /** Durable before it returns; a failure means the grant may still be on disk. */
    forget: (alias: string) => drop(alias),
    held: (alias: string) => Ref.get(grants).pipe(Effect.map((current) => current[alias])),
  };
});
