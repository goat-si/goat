// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous, fixed-length secret name for a client-supplied id.
import * as NodeCrypto from "node:crypto";

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthEnvironmentScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  HUB_PROXY_NODE_SCOPE_CEILING,
  type EnvironmentId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { parseLinkTarget } from "../linkedHosts/LinkedHosts.ts";
import { SshRemoteDispatch } from "../sshRemote/SshRemoteDispatch.ts";
import { HubProxyNodes, routeKey, type HubProxyNode, type HubProxyRoute } from "./HubProxyNodes.ts";
import { makeSnapshotBuffer } from "./snapshotBuffer.ts";

export class HubProxyError extends Data.TaggedError("HubProxyError")<{
  /**
   * not_found: no such node on this hub. unavailable: the node or its runtime could not be
   * reached. enrollment_required: a linked node has no usable hub session. refused: the node
   * answered and refused, or the client's rights on it are empty.
   */
  readonly reason: "not_found" | "unavailable" | "enrollment_required" | "refused";
  readonly message: string;
}> {}

const fail = (reason: HubProxyError["reason"], message: string) =>
  Effect.fail(new HubProxyError({ reason, message }));

/** A node session the hub holds for one exact scope set. It never leaves this process. */
export interface HubProxyUpstream {
  readonly nodeId: string;
  readonly generation: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly token: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export interface HubProxyCachedSnapshot {
  readonly capturedAt: string;
  readonly body: string;
}

/** Bounded so one large node cannot grow the hub's memory without limit. */
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_REFRESH_INTERVAL = Duration.seconds(60);
/** Uploads at once per node: anyone holding the URL can post, and the hub cannot check the token. */
const UPLOADS_PER_NODE = 4;
const SESSION_REFRESH_MARGIN_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT = Duration.seconds(20);
const LAST_REFRESH_TIMEOUT = Duration.seconds(5);

interface CachedSession {
  readonly token: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly expiresAtMs: number;
}

interface NodeState {
  generation: number;
  routeKey: string | undefined;
  revoked: Deferred.Deferred<void>;
  readonly sessions: Map<string, CachedSession & HubProxyUpstream>;
  /** By granted scope set, so a read-only refresh never evicts the session uploads rely on. */
  readonly linkedSessions: Map<string, CachedSession & HubProxyUpstream>;
  enrollmentRejected: boolean;
  readonly lock: Semaphore.Semaphore;
  readonly uploads: Semaphore.Semaphore;
  snapshot: HubProxyCachedSnapshot | undefined;
  relays: number;
  refresher: Fiber.Fiber<void> | undefined;
}

const Enrollment = Schema.Struct({
  version: Schema.Literal(1),
  nodeId: Schema.String,
  baseUrl: Schema.String,
  token: Schema.String,
  scopes: Schema.Array(AuthEnvironmentScope),
  expiresAt: Schema.NullOr(Schema.String),
});
type Enrollment = typeof Enrollment.Type;
const decodeEnrollment = Schema.decodeUnknownEffect(Schema.fromJsonString(Enrollment));
const encodeEnrollment = Schema.encodeEffect(Schema.fromJsonString(Enrollment));

const TokenExchangeResult = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.optionalKey(Schema.Number),
  scope: Schema.String,
});
const NodeDescriptor = Schema.Struct({ environmentId: Schema.String });

/** Descriptors and token answers are small; a node cannot make the hub buffer more. */
const SMALL_JSON_MAX_BYTES = 64 * 1024;

const readSmallJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) =>
  Effect.gen(function* () {
    const buffer = makeSnapshotBuffer(SMALL_JSON_MAX_BYTES);
    yield* response.stream.pipe(
      Stream.takeUntil((chunk) => !buffer.append(chunk)),
      Stream.runDrain,
    );
    const body = buffer.body();
    if (body === undefined)
      return yield* new HubProxyError({
        reason: "unavailable",
        message: "The node answered with too much data.",
      });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body);
  });

/** Secret names are fixed-length hashes: node ids come from clients and must not shape paths. */
export const enrollmentSecretName = (nodeId: string) =>
  `hub-proxy-node-${NodeCrypto.createHash("sha256").update(nodeId).digest("hex").slice(0, 24)}`;

const scopeKey = (scopes: ReadonlyArray<AuthEnvironmentScope>) => [...scopes].sort().join(" ");

const sameScopes = (
  a: ReadonlyArray<AuthEnvironmentScope>,
  b: ReadonlyArray<AuthEnvironmentScope>,
) => scopeKey(a) === scopeKey(b);

const toWsBase = (httpBaseUrl: string) => httpBaseUrl.replace(/^http/u, "ws");

const isScope = Schema.is(AuthEnvironmentScope);

export class HubProxySessions extends Context.Service<
  HubProxySessions,
  {
    /** A node session holding exactly `scopes` (within what the node granted the hub). */
    readonly open: (
      nodeId: string,
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Effect.Effect<HubProxyUpstream, HubProxyError>;
    /** Rejected SSH sessions are refreshed; a linked 401 requires a new enrollment. */
    readonly invalidate: (
      nodeId: string,
      token: string,
      unauthorized?: boolean,
    ) => Effect.Effect<void>;
    /**
     * What a client holding `scopes` may do on the node without issuing anything: for a linked node
     * also within the enrollment's grant, so session state never advertises what the node refuses.
     */
    readonly limit: (
      nodeId: string,
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => Effect.Effect<ReadonlyArray<AuthEnvironmentScope>>;
    /** Reads current in-memory authority only; never issues or loads a credential. */
    readonly peek: (
      nodeId: string,
      requiredScope?: AuthEnvironmentScope,
    ) => Effect.Effect<Option.Option<HubProxyUpstream>>;
    /** Completes when this generation of the node's access ends: removal, unenrollment, route change. */
    readonly revoked: (nodeId: string, generation: number) => Effect.Effect<void>;
    readonly isCurrent: (nodeId: string, generation: number) => Effect.Effect<boolean>;
    /** Starts the node's GOAT runtime over SSH so the hub learns its identity. */
    readonly prepare: (nodeId: string) => Effect.Effect<void, HubProxyError>;
    readonly enroll: (input: {
      readonly nodeId: string;
      readonly pairingUrl: string;
    }) => Effect.Effect<{ readonly scopes: ReadonlyArray<AuthEnvironmentScope> }, HubProxyError>;
    readonly unenroll: (nodeId: string) => Effect.Effect<boolean, HubProxyError>;
    readonly snapshot: (nodeId: string) => Effect.Effect<Option.Option<HubProxyCachedSnapshot>>;
    readonly recordSnapshot: (
      nodeId: string,
      body: string,
      generation: number,
    ) => Effect.Effect<void>;
    /** Counts an open relay; while any is open the hub refreshes its snapshot of the node. */
    readonly trackRelay: (nodeId: string) => Effect.Effect<void, never, Scope.Scope>;
    /** Bounds uploads streaming to one node at a time. */
    readonly uploadSlots: (nodeId: string) => Effect.Effect<Semaphore.Semaphore>;
  }
>()("goat/hubProxy/HubProxySessions") {}

export const make = Effect.gen(function* () {
  const nodes = yield* HubProxyNodes;
  const ssh = yield* SshRemoteDispatch;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const layerScope = yield* Effect.scope;
  const states = new Map<string, NodeState>();

  const stateFor = Effect.fn("HubProxySessions.stateFor")(function* (nodeId: string) {
    const existing = states.get(nodeId);
    if (existing !== undefined) return existing;
    const created: NodeState = {
      generation: 0,
      routeKey: undefined,
      revoked: yield* Deferred.make<void>(),
      sessions: new Map(),
      linkedSessions: new Map(),
      enrollmentRejected: false,
      lock: yield* Semaphore.make(1),
      uploads: yield* Semaphore.make(UPLOADS_PER_NODE),
      snapshot: undefined,
      relays: 0,
      refresher: undefined,
    };
    states.set(nodeId, created);
    return created;
  });

  const revoke = Effect.fn("HubProxySessions.revoke")(function* (state: NodeState) {
    const previous = state.revoked;
    state.generation += 1;
    state.revoked = yield* Deferred.make<void>();
    state.sessions.clear();
    state.linkedSessions.clear();
    state.snapshot = undefined;
    yield* Deferred.succeed(previous, undefined);
  });

  const requireNode = (nodeId: string) =>
    nodes
      .get(nodeId)
      .pipe(
        Effect.flatMap((node) =>
          Option.isSome(node)
            ? Effect.succeed(node.value)
            : fail("not_found", "No such node on this hub."),
        ),
      );

  const preferredRoute = (node: HubProxyNode): HubProxyRoute | undefined => node.routes[0];

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      // Requests and bodies carry node credentials: never trace or follow them elsewhere.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      }),
      Effect.timeout(UPSTREAM_TIMEOUT),
    );

  /**
   * Like send, but the response lives only as long as the caller's scope, so a branch that never
   * reads the body (a refused exchange) still releases the connection when it returns.
   */
  const sendScoped = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClient.withScope(http)
      .execute(request)
      .pipe(
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
        }),
      );

  const readEnrollment = (nodeId: string) =>
    secrets.get(enrollmentSecretName(nodeId)).pipe(
      Effect.flatMap((stored) =>
        Option.isNone(stored)
          ? Effect.succeed(Option.none<Enrollment>())
          : decodeEnrollment(new TextDecoder().decode(stored.value)).pipe(Effect.map(Option.some)),
      ),
      Effect.mapError(
        () =>
          new HubProxyError({
            reason: "unavailable",
            message: "The hub could not read this node's enrollment.",
          }),
      ),
    );

  const changed = () =>
    fail("unavailable", "This node changed while the hub was connecting. Try again.");

  const checkAdmission = (nodeId: string, state: NodeState, key: string, generation: number) =>
    nodes.get(nodeId).pipe(
      Effect.flatMap((node) => {
        const route = Option.isSome(node) ? preferredRoute(node.value) : undefined;
        return state.generation === generation &&
          state.routeKey === key &&
          route !== undefined &&
          routeKey(route) === key
          ? Effect.void
          : changed();
      }),
    );

  const openSsh = Effect.fn("HubProxySessions.openSsh")(function* (
    state: NodeState,
    nodeId: string,
    route: Extract<HubProxyRoute, { kind: "ssh" }>,
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    generation: number,
  ) {
    const endpoint = yield* ssh
      .proxyEndpoint(route.target)
      .pipe(
        Effect.mapError(
          (error) => new HubProxyError({ reason: "unavailable", message: error.message }),
        ),
      );
    const key = scopeKey(scopes);
    const now = yield* Clock.currentTimeMillis;
    const cached = state.sessions.get(key);
    const session =
      cached !== undefined && cached.expiresAtMs - SESSION_REFRESH_MARGIN_MS > now
        ? cached
        : yield* ssh.issueProxySession(route.target, scopes).pipe(
            Effect.mapError(
              (error) => new HubProxyError({ reason: "unavailable", message: error.message }),
            ),
            Effect.flatMap((issued) => {
              if (!sameScopes(issued.scopes, scopes))
                return fail("refused", "The node granted different rights than the hub asked for.");
              const expiresAtMs =
                issued.expiresAt === null ? Number.NaN : Date.parse(issued.expiresAt);
              return Effect.succeed({
                token: issued.token,
                scopes: issued.scopes,
                expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : now + 12 * 3_600_000,
              } satisfies CachedSession);
            }),
          );
    yield* checkAdmission(nodeId, state, routeKey(route), generation);
    // A cached session outlives its forward: a relaunched node gets a new local port.
    const upstream = {
      token: session.token,
      scopes: session.scopes,
      expiresAtMs: session.expiresAtMs,
      nodeId,
      generation,
      httpBaseUrl: endpoint.httpBaseUrl,
      wsBaseUrl: endpoint.wsBaseUrl,
    };
    state.sessions.set(key, upstream);
    return upstream;
  });

  const openLinked = Effect.fn("HubProxySessions.openLinked")(function* (
    state: NodeState,
    nodeId: string,
    route: Extract<HubProxyRoute, { kind: "linked" }>,
    scopes: ReadonlyArray<AuthEnvironmentScope>,
    generation: number,
  ) {
    if (state.enrollmentRejected)
      return yield* fail(
        "enrollment_required",
        "The node rejected the hub's access. Allow it again.",
      );
    const enrollment = yield* readEnrollment(nodeId);
    yield* checkAdmission(nodeId, state, routeKey(route), generation);
    if (Option.isNone(enrollment) || enrollment.value.baseUrl !== route.baseUrl)
      return yield* fail(
        "enrollment_required",
        "Allow phone access to this node on the hub first (Settings → Connections).",
      );
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = enrollment.value.expiresAt;
    if (expiresAt !== null && Date.parse(expiresAt) <= now)
      return yield* fail(
        "enrollment_required",
        "The hub's access to this node expired. Allow it again.",
      );
    // The node enforces what it granted the hub; the hub narrows that to this client.
    const granted = scopes.filter((scope) => enrollment.value.scopes.includes(scope));
    if (granted.length === 0)
      return yield* fail("refused", "The hub's access to this node does not cover this client.");
    const upstream = {
      nodeId,
      generation,
      httpBaseUrl: `${route.baseUrl.replace(/\/+$/u, "")}/`,
      wsBaseUrl: toWsBase(`${route.baseUrl.replace(/\/+$/u, "")}/`),
      token: enrollment.value.token,
      scopes: granted,
    } satisfies HubProxyUpstream;
    state.linkedSessions.set(scopeKey(granted), {
      ...upstream,
      expiresAtMs: expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(expiresAt),
    });
    return upstream;
  });

  const limit: HubProxySessions["Service"]["limit"] = (nodeId, scopes) =>
    Effect.gen(function* () {
      const node = yield* nodes.get(nodeId);
      const route = Option.isSome(node) ? preferredRoute(node.value) : undefined;
      if (route === undefined) return [];
      if (route.kind === "ssh") return scopes;
      if (states.get(nodeId)?.enrollmentRejected === true) return [];
      const enrollment = yield* readEnrollment(nodeId).pipe(
        Effect.orElseSucceed(() => Option.none<Enrollment>()),
      );
      if (Option.isNone(enrollment) || enrollment.value.baseUrl !== route.baseUrl) return [];
      // Same rule as opening it, so session state never offers a grant that has run out.
      const expiresAt = enrollment.value.expiresAt;
      if (expiresAt !== null && Date.parse(expiresAt) <= (yield* Clock.currentTimeMillis))
        return [];
      return scopes.filter((scope) => enrollment.value.scopes.includes(scope));
    });

  const open: HubProxySessions["Service"]["open"] = (nodeId, scopes) =>
    Effect.gen(function* () {
      if (scopes.length === 0)
        return yield* fail("refused", "This client has no rights on hub nodes.");
      const node = yield* requireNode(nodeId);
      const route = preferredRoute(node);
      if (route === undefined)
        return yield* fail("unavailable", "This node has no route the hub can use.");
      const state = yield* stateFor(nodeId);
      const key = routeKey(route);
      if (state.routeKey !== undefined && state.routeKey !== key) yield* revoke(state);
      state.routeKey = key;
      const generation = state.generation;
      return yield* Effect.gen(function* () {
        yield* checkAdmission(nodeId, state, key, generation);
        return yield* route.kind === "ssh"
          ? openSsh(state, nodeId, route, scopes, generation)
          : openLinked(state, nodeId, route, scopes, generation);
      }).pipe(state.lock.withPermit);
    });

  const invalidate: HubProxySessions["Service"]["invalidate"] = (
    nodeId,
    token,
    unauthorized = true,
  ) =>
    Effect.gen(function* () {
      const state = states.get(nodeId);
      if (state === undefined) return;
      if (
        unauthorized &&
        [...state.linkedSessions.values()].some((session) => session.token === token)
      ) {
        state.enrollmentRejected = true;
        yield* revoke(state);
      }
      for (const [key, session] of state.sessions)
        if (session.token === token) state.sessions.delete(key);
    });

  const peek: HubProxySessions["Service"]["peek"] = (
    nodeId,
    requiredScope = AuthOrchestrationReadScope,
  ) =>
    Effect.gen(function* () {
      const node = yield* nodes.get(nodeId);
      const route = Option.isSome(node) ? preferredRoute(node.value) : undefined;
      const now = yield* Clock.currentTimeMillis;
      const state = states.get(nodeId);
      if (state === undefined || route === undefined || state.routeKey !== routeKey(route))
        return Option.none();
      for (const session of [...state.sessions.values(), ...state.linkedSessions.values()]) {
        if (
          session.generation === state.generation &&
          session.expiresAtMs > now &&
          session.scopes.includes(requiredScope)
        )
          return Option.some(session);
      }
      return Option.none();
    });

  const revoked: HubProxySessions["Service"]["revoked"] = (nodeId, generation) =>
    Effect.suspend(() => {
      const state = states.get(nodeId);
      return state === undefined || state.generation !== generation
        ? Effect.void
        : Deferred.await(state.revoked);
    });

  const isCurrent: HubProxySessions["Service"]["isCurrent"] = (nodeId, generation) =>
    Effect.sync(() => states.get(nodeId)?.generation === generation);

  const prepare: HubProxySessions["Service"]["prepare"] = (nodeId) =>
    Effect.gen(function* () {
      const node = yield* requireNode(nodeId);
      const route = node.routes.find((candidate) => candidate.kind === "ssh");
      if (route === undefined || route.kind !== "ssh")
        return yield* fail("refused", "Only SSH nodes are set up from the hub.");
      yield* ssh
        .proxyEndpoint(route.target)
        .pipe(
          Effect.mapError(
            (error) => new HubProxyError({ reason: "unavailable", message: error.message }),
          ),
        );
      yield* nodes.refreshIdentity(nodeId);
    });

  const enroll: HubProxySessions["Service"]["enroll"] = (input) =>
    Effect.gen(function* () {
      const node = yield* requireNode(input.nodeId);
      // The hub proxies through a node's preferred route only, so enrolling another route could
      // never be used and would end the sockets open over the preferred one.
      const route = preferredRoute(node);
      if (route === undefined || route.kind !== "linked")
        return yield* fail(
          "refused",
          "The hub reaches this node over SSH, which needs no pairing link.",
        );
      if (node.environmentId === null)
        return yield* fail(
          "refused",
          "The hub has not learned this node's identity yet. Check it first.",
        );
      const target = parseLinkTarget(input.pairingUrl, undefined);
      if (typeof target === "string") return yield* fail("refused", target);
      if (new URL(target.baseUrl).origin !== new URL(route.baseUrl).origin)
        return yield* fail(
          "refused",
          `The pairing link is for ${target.baseUrl}, not ${route.baseUrl}.`,
        );
      const state = yield* stateFor(input.nodeId);
      const key = routeKey(route);
      if (state.routeKey !== undefined && state.routeKey !== key) yield* revoke(state);
      state.routeKey = key;
      const generation = state.generation;
      const unreachable = () =>
        new HubProxyError({ reason: "unavailable", message: `${target.baseUrl} did not answer.` });
      const descriptor = yield* sendScoped(
        HttpClientRequest.get(new URL("/.well-known/goat/environment", target.baseUrl).toString()),
      ).pipe(
        Effect.flatMap((response) => readSmallJson(response, NodeDescriptor)),
        Effect.scoped,
        Effect.timeout(UPSTREAM_TIMEOUT),
        Effect.mapError(unreachable),
      );
      if (descriptor.environmentId !== (node.environmentId satisfies EnvironmentId))
        return yield* fail("refused", "That pairing link belongs to another machine.");
      return yield* Effect.gen(function* () {
        yield* checkAdmission(input.nodeId, state, key, generation);
        const response = yield* sendScoped(
          HttpClientRequest.post(new URL("/oauth/token", target.baseUrl).toString()).pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: AuthTokenExchangeGrantType,
              subject_token: target.code,
              subject_token_type: AuthEnvironmentBootstrapTokenType,
              requested_token_type: AuthAccessTokenType,
              scope: HUB_PROXY_NODE_SCOPE_CEILING.join(" "),
              client_label: "GOAT hub proxy",
            }),
          ),
        ).pipe(
          // Headers and body share one deadline, so a node trickling its answer cannot hold
          // this node's permit and block an administrator removing access.
          Effect.flatMap((response) =>
            response.status === 200
              ? readSmallJson(response, TokenExchangeResult).pipe(Effect.map(Option.some))
              : Effect.succeed(Option.none()),
          ),
          Effect.scoped,
          Effect.timeout(UPSTREAM_TIMEOUT),
          Effect.mapError(unreachable),
        );
        if (Option.isNone(response))
          return yield* fail(
            "refused",
            "The node refused that pairing link. Create a new one there.",
          );
        const exchanged = response.value;
        const scopes = exchanged.scope
          .split(" ")
          .filter(isScope)
          .filter((scope) => HUB_PROXY_NODE_SCOPE_CEILING.includes(scope));
        if (scopes.length === 0)
          return yield* fail("refused", "That pairing link grants nothing the hub can proxy.");
        const now = yield* DateTime.now;
        const record: Enrollment = {
          version: 1,
          nodeId: input.nodeId,
          baseUrl: route.baseUrl,
          token: exchanged.access_token,
          scopes,
          expiresAt:
            exchanged.expires_in === undefined
              ? null
              : DateTime.formatIso(DateTime.add(now, { seconds: exchanged.expires_in })),
        };
        const encoded = yield* encodeEnrollment(record).pipe(Effect.mapError(unreachable));
        yield* checkAdmission(input.nodeId, state, key, generation);
        yield* secrets
          .set(enrollmentSecretName(input.nodeId), new TextEncoder().encode(encoded))
          .pipe(
            Effect.mapError(
              () =>
                new HubProxyError({
                  reason: "unavailable",
                  message: "The hub could not save this enrollment.",
                }),
            ),
          );
        yield* checkAdmission(input.nodeId, state, key, generation).pipe(
          Effect.tapError(() =>
            secrets.remove(enrollmentSecretName(input.nodeId)).pipe(Effect.ignore),
          ),
        );
        // Sockets opened under a previous enrollment end with it.
        yield* revoke(state);
        state.enrollmentRejected = false;
        return { scopes };
      }).pipe(state.lock.withPermit);
    });

  const unenroll: HubProxySessions["Service"]["unenroll"] = (nodeId) =>
    Effect.gen(function* () {
      const state = yield* stateFor(nodeId);
      return yield* Effect.gen(function* () {
        const existing = yield* readEnrollment(nodeId);
        yield* secrets.remove(enrollmentSecretName(nodeId)).pipe(
          Effect.mapError(
            () =>
              new HubProxyError({
                reason: "unavailable",
                message: "The hub could not remove this enrollment.",
              }),
          ),
        );
        yield* revoke(state);
        return Option.isSome(existing);
      }).pipe(state.lock.withPermit);
    });

  const snapshot: HubProxySessions["Service"]["snapshot"] = (nodeId) =>
    Effect.sync(() => Option.fromNullishOr(states.get(nodeId)?.snapshot));

  const recordSnapshot: HubProxySessions["Service"]["recordSnapshot"] = (
    nodeId,
    body,
    generation,
  ) =>
    Effect.gen(function* () {
      if (new TextEncoder().encode(body).byteLength > SNAPSHOT_MAX_BYTES) return;
      const capturedAt = DateTime.formatIso(yield* DateTime.now);
      // No asynchronous boundary between checking authority and publishing the copy.
      const state = states.get(nodeId);
      if (state?.generation === generation) state.snapshot = { capturedAt, body };
    });

  /** One read of the node's shell, kept as the hub's offline copy. */
  const refreshSnapshot = (nodeId: string) =>
    Effect.gen(function* () {
      const upstream = yield* open(nodeId, [AuthOrchestrationReadScope]);
      const response = yield* send(
        HttpClientRequest.get(
          new URL("api/orchestration/shell", upstream.httpBaseUrl).toString(),
        ).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${upstream.token}`,
            "x-goat-orchestration-protocol": "1001",
          }),
        ),
      );
      if (response.status !== 200) return;
      const buffer = makeSnapshotBuffer(SNAPSHOT_MAX_BYTES);
      yield* response.stream.pipe(
        Stream.takeUntil((chunk) => !buffer.append(chunk)),
        Stream.runDrain,
      );
      const body = buffer.body();
      if (body !== undefined) yield* recordSnapshot(nodeId, body, upstream.generation);
    }).pipe(Effect.timeout(UPSTREAM_TIMEOUT), Effect.ignore);

  const trackRelay: HubProxySessions["Service"]["trackRelay"] = (nodeId) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const state = yield* stateFor(nodeId);
        state.relays += 1;
        if (state.relays === 1)
          state.refresher = yield* refreshSnapshot(nodeId).pipe(
            Effect.andThen(Effect.sleep(SNAPSHOT_REFRESH_INTERVAL)),
            Effect.forever,
            Effect.forkIn(layerScope),
          );
        return state;
      }),
      (state) =>
        Effect.gen(function* () {
          state.relays -= 1;
          if (state.relays > 0 || state.refresher === undefined) return;
          const refresher = state.refresher;
          state.refresher = undefined;
          yield* Fiber.interrupt(refresher);
          // The last look before the node possibly went away; it may well fail.
          yield* refreshSnapshot(nodeId).pipe(
            Effect.timeout(LAST_REFRESH_TIMEOUT),
            Effect.ignore,
            Effect.forkIn(layerScope),
          );
        }),
    ).pipe(Effect.asVoid);

  // Removal or a route change ends every session and socket of that node.
  yield* nodes.changes.pipe(
    Stream.runForEach(() =>
      Effect.forEach(
        [...states.entries()],
        ([nodeId, state]) =>
          nodes.get(nodeId).pipe(
            Effect.flatMap((node) => {
              const route = Option.isSome(node) ? preferredRoute(node.value) : undefined;
              const key = route === undefined ? undefined : routeKey(route);
              if (state.routeKey === undefined || key === state.routeKey) return Effect.void;
              state.routeKey = key;
              return revoke(state);
            }),
          ),
        { discard: true },
      ),
    ),
    Effect.forkIn(layerScope),
  );

  return HubProxySessions.of({
    open,
    invalidate,
    peek,
    limit,
    revoked,
    isCurrent,
    prepare,
    enroll,
    unenroll,
    snapshot,
    recordSnapshot,
    trackRelay,
    uploadSlots: (nodeId) => Effect.map(stateFor(nodeId), (state) => state.uploads),
  });
});

export const layer = Layer.effect(HubProxySessions, make);
