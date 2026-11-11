import {
  AuthEnvironmentScope,
  AuthMcpClientAccess,
  HUB_PROXY_NODE_SCOPE_CEILING,
  type AuthEnvironmentScope as AuthEnvironmentScopeType,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { PenConnection } from "../auth/connectionContext.ts";
import { mcpClientScopes } from "../auth/mcpClientScopes.ts";
import { MCP_CLIENT_SUBJECT } from "../auth/mcpClientSubject.ts";
import { PEN_PROXY_SUBJECT, PEN_SESSION_MAX_TTL } from "../auth/sessionBinding.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { PenEnablement } from "./PenEnablement.ts";

/** Bounds of the mesh link security review's P3-1 for member session issue. */
export const PEN_SESSION_LIMITS = {
  concurrentIssues: 4,
  perMember: 64,
  total: 512,
  bodyBytes: 4_096,
} as const;

const AgentRequest = Schema.Struct({
  kind: Schema.Literal("agent"),
  access: AuthMcpClientAccess,
  memory: Schema.Literals(["none", "read", "read_write"]),
  providersManage: Schema.Boolean,
  settingsWrite: Schema.Boolean,
  label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
});
const ProxyRequest = Schema.Struct({
  kind: Schema.Literal("proxy"),
  scopes: Schema.Array(AuthEnvironmentScope).check(Schema.isMinLength(1)),
});
export const PenSessionRequest = Schema.Union([AgentRequest, ProxyRequest]);
export type PenSessionRequest = typeof PenSessionRequest.Type;
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(PenSessionRequest));

export class PenSessionRefusal extends Data.TaggedError("PenSessionRefusal")<{
  readonly code: "overloaded" | "unavailable" | "refused";
  readonly message: string;
}> {}
const refusal = (code: PenSessionRefusal["code"], message: string) =>
  new PenSessionRefusal({ code, message });

/**
 * Exactly what an agent request asks for: its access and memory, with settings write and provider
 * management only when asked. Approvals and Child setup cannot be expressed.
 */
const agentScopes = (
  request: typeof AgentRequest.Type,
): ReadonlyArray<AuthEnvironmentScopeType> => {
  const memory: ReadonlyArray<"memory:read" | "memory:write"> =
    request.memory === "none"
      ? []
      : request.memory === "read"
        ? ["memory:read"]
        : ["memory:read", "memory:write"];
  const base = mcpClientScopes(request.access, memory).filter(
    (scope) =>
      scope !== "settings:write" &&
      scope !== "providers:manage" &&
      scope !== "orchestration:approve",
  );
  return [
    ...base,
    ...(request.settingsWrite ? (["settings:write"] as const) : []),
    ...(request.providersManage ? (["providers:manage"] as const) : []),
  ];
};

export interface IssuedPenSession {
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly scopes: ReadonlyArray<AuthEnvironmentScopeType>;
  readonly kind: "agent" | "proxy";
}

export interface PenMember {
  readonly nodeId: string;
  readonly signPub: string;
  readonly noisePub: string;
}

export class PenSessions extends Context.Service<
  PenSessions,
  {
    /** Issues for the connection's proven member; the body only picks the kind and narrows. */
    readonly issue: (
      connection: PenConnection,
      body: string,
    ) => Effect.Effect<IssuedPenSession, PenSessionRefusal>;
    /** Serializes trust-root changes with issue; the linearization point of design §7. */
    readonly withIssueLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The live generation; issue refuses a connection of any other. */
    readonly setGeneration: (generation: number | undefined) => Effect.Effect<void>;
    readonly revokeAll: Effect.Effect<number, PenSessionRefusal>;
    /** Revokes every Pen-bound session whose member is not one of `members`. */
    readonly revokeExcept: (
      members: ReadonlyArray<PenMember>,
    ) => Effect.Effect<number, PenSessionRefusal>;
  }
>()("goat/pen/PenSessions") {}

const memberKey = (member: PenMember) => `${member.nodeId} ${member.signPub} ${member.noisePub}`;

const make = Effect.gen(function* () {
  const enablement = yield* PenEnablement;
  const sessions = yield* SessionStore.SessionStore;
  const repository = yield* AuthSessions.AuthSessionRepository;
  const waiting = yield* Semaphore.make(PEN_SESSION_LIMITS.concurrentIssues);
  const lock = yield* Semaphore.make(1);
  const generation = yield* Ref.make<number | undefined>(undefined);
  const unavailable = () => refusal("unavailable", "Pen sessions are unavailable right now.");

  const revokeRows = (rows: ReadonlyArray<AuthSessions.PenBoundSession>) =>
    Effect.forEach(rows, (row) => sessions.revoke(row.sessionId)).pipe(
      Effect.map((revoked) => revoked.filter(Boolean).length),
      Effect.mapError(unavailable),
    );
  const listBound = DateTime.now.pipe(
    Effect.flatMap((now) => repository.listPenBound({ now })),
    Effect.mapError(unavailable),
  );

  const issueLocked = Effect.fn("PenSessions.issueLocked")(function* (
    connection: PenConnection,
    request: PenSessionRequest,
  ) {
    if (!connection.alive() || (yield* Ref.get(generation)) !== connection.generation)
      return yield* refusal("refused", "This Pen connection has ended.");
    const now = yield* DateTime.now;
    yield* repository.deleteInactivePenBound({ now }).pipe(Effect.mapError(unavailable));
    const counts = yield* repository
      .countActivePenBound({ now, nodeId: connection.peer.nodeId })
      .pipe(Effect.mapError(unavailable));
    if (counts.member >= PEN_SESSION_LIMITS.perMember || counts.total >= PEN_SESSION_LIMITS.total)
      return yield* refusal("overloaded", "Too many Pen sessions; try again later.");
    const { meshId, nodeId, signPub, noisePub, name } = connection.peer;
    const penBinding = { meshId, nodeId, signPub, noisePub };
    if (request.kind === "proxy") {
      if (!request.scopes.every((scope) => HUB_PROXY_NODE_SCOPE_CEILING.includes(scope)))
        return yield* refusal("refused", "A member proxy session asks only for proxy scopes.");
      const issued = yield* sessions
        .issue({
          subject: PEN_PROXY_SUBJECT,
          method: "bearer-access-token",
          scopes: [...new Set(request.scopes)],
          principalKind: "proxied_person",
          penBinding,
          ttl: PEN_SESSION_MAX_TTL,
          client: { label: `Pen member ${name}`, deviceType: "unknown" },
        })
        .pipe(Effect.mapError(unavailable));
      return {
        token: issued.token,
        expiresAt: DateTime.toUtc(issued.expiresAt),
        scopes: issued.scopes,
        kind: "proxy",
      } satisfies IssuedPenSession;
    }
    const issued = yield* sessions
      .issue({
        subject: MCP_CLIENT_SUBJECT,
        method: "bearer-access-token",
        scopes: agentScopes(request),
        principalKind: "outside_client",
        penBinding,
        ttl: PEN_SESSION_MAX_TTL,
        ...(request.access === "read-only" ? {} : { runtimeModeCeiling: request.access }),
        client: { label: `${request.label ?? "Pen member agent"} (${name})`, deviceType: "bot" },
      })
      .pipe(Effect.mapError(unavailable));
    return {
      token: issued.token,
      expiresAt: DateTime.toUtc(issued.expiresAt),
      scopes: issued.scopes,
      kind: "agent",
    } satisfies IssuedPenSession;
  });

  const issue: PenSessions["Service"]["issue"] = Effect.fn("PenSessions.issue")(
    function* (connection, body) {
      if (!enablement.enabled)
        return yield* refusal("refused", "Pen is not enabled in this build.");
      if (Buffer.byteLength(body, "utf8") > PEN_SESSION_LIMITS.bodyBytes)
        return yield* refusal("refused", "The request body is too large.");
      const request = yield* decodeRequest(body, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => refusal("refused", "The request does not describe a Pen session.")),
      );
      const issued = yield* lock
        .withPermits(1)(issueLocked(connection, request))
        .pipe(waiting.withPermitsIfAvailable(1));
      return yield* Effect.fromOption(issued).pipe(
        Effect.mapError(() => refusal("overloaded", "Too many Pen session requests at once.")),
      );
    },
  );

  return PenSessions.of({
    issue,
    withIssueLock: lock.withPermits(1),
    setGeneration: Effect.fn("PenSessions.setGeneration")(function* (next) {
      yield* Ref.set(generation, next);
    }),
    revokeAll: listBound.pipe(Effect.flatMap(revokeRows)),
    revokeExcept: Effect.fn("PenSessions.revokeExcept")(function* (members) {
      const current = new Set(members.map(memberKey));
      const rows = yield* listBound;
      return yield* revokeRows(rows.filter((row) => !current.has(memberKey(row))));
    }),
  });
});

export const layer = Layer.effect(PenSessions, make);
