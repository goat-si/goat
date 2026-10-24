import {
  EnvironmentAuthorizationError,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
  type MemoryTaskGrantCeiling,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as McpProviderSession from "@goat/provider-core/server/mcpSession";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { registerCredentialRunTag } from "./goatCredentialRedaction.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export interface McpMemoryPolicy {
  readonly grant: MemoryTaskGrantCeiling;
  readonly policyEpoch: number;
}

export interface McpCredentialRequest {
  readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly memoryPolicy?: McpMemoryPolicy;
  /** Reads only committed authority; never SQL or a settings lock. */
  readonly readCurrentPolicy?: () => Effect.Effect<McpMemoryPolicy | undefined>;
  readonly isLiveCaller?: Effect.Effect<boolean>;
  /** True while GOAT still holds the provider session this credential was issued to. */
  readonly isAttached?: Effect.Effect<boolean>;
  readonly readOnly?: boolean;

  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * When false, the credential is minted without the "preview" capability so
   * the user's choice to withhold agent browser access holds everywhere the
   * token is honored (#7083). Defaults to full access.
   */
  readonly browserToolsAvailable?: boolean;
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig & {
    readonly grantedScopes?: ReadonlyArray<AuthEnvironmentScope>;
  };
  /** True when the presented credential kept its token and only its authority changed. */
  readonly renewed?: boolean;
}

/**
 * Why a presented bearer token did not resolve. `earlier_server` covers a
 * token minted by a previous run of this server (restart or update): tokens
 * carry a per-run tag, and nothing secret is persisted to recognize them.
 */
export type McpCredentialRefusalReason =
  | "missing"
  | "expired"
  | "revoked"
  | "earlier_server"
  | "unknown";

export interface McpCredentialRefusal {
  readonly reason: McpCredentialRefusalReason;
  readonly threadId?: ThreadId;
  readonly providerSessionId?: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly endedAt?: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (
    request: McpCredentialRequest & {
      /**
       * Keep this token and credential id and replace only its authority. Honored
       * only for a credential this registry run still retains (live or idle-expired)
       * for the same thread, provider instance and id; a revoked one mints anew.
       */
      readonly renew?: {
        readonly authorizationHeader: string;
        readonly providerSessionId: string;
      };
    },
  ) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpThreadInvocationScope | undefined>;
  /** Explains a token resolve refused. Never echoes the token. */
  readonly explainRefusal?: (rawToken: string) => Effect.Effect<McpCredentialRefusal>;
  /** Whether a token has the shape this registry mints, from any server run. */
  readonly isRegistryToken?: (rawToken: string) => boolean;
  /** SQL-free snapshot policy for an issued credential; stale handles deny. */
  readonly currentMemoryPolicy?: (
    providerSessionId: string,
  ) => Effect.Effect<McpMemoryPolicy | undefined>;
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (
    threadId: ThreadId,
    options?: { readonly exceptProviderSessionId?: string },
  ) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("goat/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  /** Bumped whenever authority is replaced under the same token. */
  readonly generation: number;
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly lastAliveAt: number;
  readonly memoryPolicy: McpMemoryPolicy | undefined;
  readonly readCurrentPolicy: (() => Effect.Effect<McpMemoryPolicy | undefined>) | undefined;
  readonly isLiveCaller: Effect.Effect<boolean> | undefined;
  readonly isAttached: Effect.Effect<boolean> | undefined;
}

interface Tombstone {
  readonly reason: "expired" | "revoked";
  readonly endedAt: number;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** Kept for idle expiry only, so a still-attached session can be renewed. */
  readonly record: CredentialRecord | undefined;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
  readonly recordsById: ReadonlyMap<string, CredentialRecord>;
  readonly tombstones: ReadonlyMap<string, Tombstone>;
}

/** Bounds refusal diagnostics and renewable idle records; the oldest go first. */
const MAX_TOMBSTONES = 512;

// Both record keys reference the same records and are published together,
// including after refresh, prune and revoke.
const registryState = (
  records: ReadonlyMap<string, CredentialRecord>,
  tombstones: ReadonlyMap<string, Tombstone>,
): RegistryState => ({
  records,
  recordsById: new Map(
    Array.from(records.values(), (record) => [record.scope.thread.providerSessionId, record]),
  ),
  tombstones,
});

const withTombstones = (
  tombstones: ReadonlyMap<string, Tombstone>,
  entries: ReadonlyArray<readonly [string, Tombstone]>,
): ReadonlyMap<string, Tombstone> => {
  if (entries.length === 0) return tombstones;
  const next = new Map(tombstones);
  for (const [tokenHash, tombstone] of entries) {
    next.delete(tokenHash);
    next.set(tokenHash, tombstone);
  }
  for (const tokenHash of next.keys()) {
    if (next.size <= MAX_TOMBSTONES) break;
    next.delete(tokenHash);
  }
  return next;
};

const tombstoneOf = (
  record: CredentialRecord,
  reason: Tombstone["reason"],
  endedAt: number,
): Tombstone => ({
  reason,
  endedAt,
  threadId: record.scope.thread.threadId,
  providerSessionId: record.scope.thread.providerSessionId,
  providerInstanceId: record.scope.thread.providerInstanceId,
  record: reason === "expired" ? record : undefined,
});

/** Memory authority follows the committed policy; the rest of the credential does not. */
const withoutMemoryAuthority = (
  scope: McpInvocationContext.McpThreadInvocationScope,
): McpInvocationContext.McpThreadInvocationScope => ({
  ...scope,
  ...(scope.grantedScopes === undefined
    ? {}
    : {
        grantedScopes: scope.grantedScopes.filter(
          (granted) => granted !== "memory:read" && granted !== "memory:write",
        ),
      }),
  ...(scope.memoryPolicy === undefined
    ? {}
    : { memoryPolicy: { grant: "none" as const, policyEpoch: scope.memoryPolicy.policyEpoch } }),
  capabilities: new Set(Array.from(scope.capabilities).filter((c) => c !== "memory")),
});

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * The bound matters because /mcp is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the goat toolkits on a remote-reachable server. A
 * session GOAT still holds renews past it; a detached one expires.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// Current tokens are an 8-character run tag plus a 43-character secret; tokens
// from builds before the tag are the bare secret.
const RUN_TAG_LENGTH = 8;
const SECRET_LENGTH = 43;
const REGISTRY_TOKEN = /^[A-Za-z0-9_-]+$/;
const isRegistryToken = (token: string) =>
  (token.length === SECRET_LENGTH || token.length === RUN_TAG_LENGTH + SECRET_LENGTH) &&
  REGISTRY_TOKEN.test(token);

const rawTokenOf = (authorizationHeader: string) => authorizationHeader.replace(/^Bearer\s+/, "");

const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make(registryState(new Map(), new Map()));
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const runTag = yield* crypto.randomBytes(6).pipe(Effect.map(tokenFromBytes), Effect.orDie);
  registerCredentialRunTag(runTag);
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? "http://" +
      getHttpMcpEndpointHost(httpServer.address.address) +
      ":" +
      httpServer.address.port +
      "/mcp"
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const isIdle = (record: CredentialRecord, timestamp: number) =>
    timestamp - record.lastAliveAt > livenessWindowMs;

  /**
   * Moves idle records to tombstones. One whose session may still be attached
   * stays live until a probe says otherwise: the bounded tombstones must never
   * evict a credential a provider process still holds.
   */
  const pruneIdle = (current: RegistryState, timestamp: number): RegistryState => {
    const idle = Array.from(current.records).filter(
      ([, record]) => record.isAttached === undefined && isIdle(record, timestamp),
    );
    if (idle.length === 0) return current;
    const records = new Map(current.records);
    for (const [tokenHash] of idle) records.delete(tokenHash);
    return registryState(
      records,
      withTombstones(
        current.tombstones,
        idle.map(([tokenHash, record]) => [tokenHash, tombstoneOf(record, "expired", timestamp)]),
      ),
    );
  };

  /** Expires the record unless it was replaced or touched meanwhile. */
  const expire = (record: CredentialRecord, timestamp: number) =>
    SynchronizedRef.modify(state, (current) => {
      if (current.records.get(record.tokenHash) !== record) return [false, current] as const;
      const records = new Map(current.records);
      records.delete(record.tokenHash);
      return [
        true,
        registryState(
          records,
          withTombstones(current.tombstones, [
            [record.tokenHash, tombstoneOf(record, "expired", timestamp)],
          ]),
        ),
      ] as const;
    });

  /** Eventually removes idle records whose session GOAT no longer holds. */
  const expireDetached = Effect.fn("McpSessionRegistry.expireDetached")(function* (
    timestamp: number,
  ) {
    const idle = Array.from((yield* SynchronizedRef.get(state)).records.values()).filter(
      (record) => record.isAttached !== undefined && isIdle(record, timestamp),
    );
    for (const record of idle) if (!(yield* record.isAttached!)) yield* expire(record, timestamp);
  });

  const liveRecord = (tokenHash: string) =>
    SynchronizedRef.get(state).pipe(Effect.map((current) => current.records.get(tokenHash)));

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      yield* expireDetached(issuedAt);
      const freshId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const freshToken =
        runTag + (yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie));
      const renewToken =
        request.renew === undefined ? undefined : rawTokenOf(request.renew.authorizationHeader);
      const renewHash =
        renewToken === undefined || !renewToken.startsWith(runTag)
          ? undefined
          : yield* hashToken(renewToken);
      const freshHash = yield* hashToken(freshToken);
      const browserToolsAvailable = request.browserToolsAvailable ?? true;

      const makeRecord = (
        tokenHash: string,
        providerSessionId: string,
        generation: number,
      ): CredentialRecord => {
        const scope: McpInvocationContext.McpThreadInvocationScope = {
          environmentId,
          ...(request.grantedScopes === undefined
            ? {}
            : { grantedScopes: [...request.grantedScopes] }),
          ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
          ...(request.memoryPolicy === undefined ? {} : { memoryPolicy: request.memoryPolicy }),
          reauthorize: (required) =>
            Effect.gen(function* () {
              const resolved = yield* resolveHash(tokenHash);
              const denied =
                !resolved ||
                (required.some((scope) => scope === "memory:read" || scope === "memory:write") &&
                  (!request.memoryPolicy ||
                    !request.readCurrentPolicy ||
                    !request.isLiveCaller ||
                    request.memoryPolicy.grant === "none" ||
                    (required.includes("memory:write") &&
                      request.memoryPolicy.grant !== "read_write"))) ||
                (request.isLiveCaller && !(yield* request.isLiveCaller)) ||
                required.some((scope) => !resolved.grantedScopes?.includes(scope)) ||
                (request.readOnly && required.includes("memory:write"));
              // A permit taken under replaced authority must not pass under the
              // replacement's grants: the token is the same, the generation is not.
              // Checked last, after every suspension above.
              if (denied || (yield* liveRecord(tokenHash))?.generation !== generation)
                return yield* new EnvironmentAuthorizationError({
                  message: "The provider credential no longer grants this operation.",
                  requiredScope:
                    required.find((scope) => !resolved?.grantedScopes?.includes(scope)) ??
                    required[0] ??
                    "memory:read",
                });
            }),
          requestNamespace: providerSessionId,
          thread: {
            threadId: ThreadId.make(request.threadId),
            providerSessionId,
            providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
          },
          client: undefined,
          capabilities: new Set<McpInvocationContext.McpCapability>([
            "orchestration",
            "worktree",
            "pull-requests",
            ...(request.capabilities ?? (browserToolsAvailable ? (["preview"] as const) : [])),
          ]),
          issuedAt,
        };
        return {
          tokenHash,
          generation,
          scope,
          lastAliveAt: issuedAt,
          memoryPolicy: request.memoryPolicy,
          readCurrentPolicy: request.readCurrentPolicy,
          isLiveCaller: request.isLiveCaller,
          isAttached: request.isAttached,
        };
      };

      const { record, renewed } = yield* SynchronizedRef.modify(state, (before) => {
        const current = pruneIdle(before, issuedAt);
        const retained =
          renewHash === undefined
            ? undefined
            : (current.records.get(renewHash) ?? current.tombstones.get(renewHash)?.record);
        const renewable =
          retained !== undefined &&
          retained.scope.thread.threadId === request.threadId &&
          retained.scope.thread.providerInstanceId === request.providerInstanceId &&
          retained.scope.thread.providerSessionId === request.renew?.providerSessionId;
        const next = renewable
          ? makeRecord(
              retained.tokenHash,
              retained.scope.thread.providerSessionId,
              retained.generation + 1,
            )
          : makeRecord(freshHash, freshId, 0);
        const records = new Map(current.records).set(next.tokenHash, next);
        const tombstones = new Map(current.tombstones);
        tombstones.delete(next.tokenHash);
        return [{ record: next, renewed: renewable }, registryState(records, tombstones)] as const;
      });
      const scope = record.scope;
      return {
        renewed,
        config: {
          environmentId,
          grantedScopes: [...(request.grantedScopes ?? [])],
          threadId: scope.thread.threadId,
          providerSessionId: scope.thread.providerSessionId,
          providerInstanceId: scope.thread.providerInstanceId,
          endpoint,
          authorizationHeader: "Bearer " + (renewed && renewToken ? renewToken : freshToken),
          credentialGeneration: record.generation,
          browserToolsAvailable: scope.capabilities.has("preview"),
          capabilities: scope.capabilities,
        },
      };
    },
  );

  /** A still-attached session renews its idle-expired credential instead of losing it. */
  const renewIdle = Effect.fn("McpSessionRegistry.renewIdle")(function* (
    tokenHash: string,
    tombstone: Tombstone,
    timestamp: number,
  ) {
    const record = tombstone.record;
    if (!record?.isAttached || !(yield* record.isAttached)) return undefined;
    const renewed = yield* SynchronizedRef.modify(state, (current) => {
      // A concurrent renewal or replacement already restored the token; a
      // revocation or eviction during the probe wins.
      const live = current.records.get(tokenHash);
      if (live) return [live, current] as const;
      if (current.tombstones.get(tokenHash) !== tombstone) return [undefined, current] as const;
      const next = { ...record, lastAliveAt: timestamp };
      const tombstones = new Map(current.tombstones);
      tombstones.delete(tokenHash);
      return [
        next,
        registryState(new Map(current.records).set(tokenHash, next), tombstones),
      ] as const;
    });
    if (renewed)
      yield* Effect.logDebug("renewed an idle MCP credential its session still holds", {
        threadId: record.scope.thread.threadId,
        providerSessionId: record.scope.thread.providerSessionId,
      });
    return renewed;
  });

  const resolveHash = Effect.fn("McpSessionRegistry.resolveHash")(function* (
    tokenHash: string,
  ): Effect.fn.Return<McpInvocationContext.McpThreadInvocationScope | undefined> {
    const timestamp = yield* currentTimeMillis;
    const pruned = yield* SynchronizedRef.modify(state, (before) => {
      const current = pruneIdle(before, timestamp);
      return [current, current] as const;
    });
    let record = pruned.records.get(tokenHash);
    while (record?.isAttached && isIdle(record, timestamp)) {
      if (yield* record.isAttached) break;
      if (yield* expire(record, timestamp)) return undefined;
      // Replaced or touched during the probe; judge the current record instead.
      record = yield* liveRecord(tokenHash);
    }
    if (!record) {
      const tombstone = pruned.tombstones.get(tokenHash);
      if (tombstone?.reason !== "expired") return undefined;
      record = yield* renewIdle(tokenHash, tombstone, timestamp);
      if (!record) return undefined;
    }
    let scope = record.scope;
    if (record.readCurrentPolicy && record.memoryPolicy) {
      const current = yield* record.readCurrentPolicy();
      if (
        !current ||
        current.policyEpoch !== record.memoryPolicy.policyEpoch ||
        current.grant !== record.memoryPolicy.grant
      )
        scope = withoutMemoryAuthority(scope);
    }
    const generation = record.generation;
    return yield* SynchronizedRef.modify(state, (current) => {
      const latest = current.records.get(tokenHash);
      if (!latest) return [undefined, current] as const;
      const records = new Map(current.records).set(tokenHash, {
        ...latest,
        lastAliveAt: timestamp,
      });
      // Authority replaced while the policy was read: answer with the
      // replacement's scope, never the superseded one.
      return [
        latest.generation === generation ? scope : withoutMemoryAuthority(latest.scope),
        registryState(records, current.tombstones),
      ] as const;
    });
  });

  const resolve: McpSessionRegistryShape["resolve"] = (rawToken) =>
    rawToken.length === 0
      ? Effect.undefined
      : hashToken(rawToken).pipe(Effect.flatMap(resolveHash));

  const explainRefusal: NonNullable<McpSessionRegistryShape["explainRefusal"]> = Effect.fn(
    "McpSessionRegistry.explainRefusal",
  )(function* (rawToken) {
    if (rawToken.length === 0) return { reason: "missing" as const };
    const tokenHash = yield* hashToken(rawToken);
    const tombstone = (yield* SynchronizedRef.get(state)).tombstones.get(tokenHash);
    if (tombstone)
      return {
        reason: tombstone.reason,
        threadId: tombstone.threadId,
        providerSessionId: tombstone.providerSessionId,
        providerInstanceId: tombstone.providerInstanceId,
        endedAt: tombstone.endedAt,
      };
    return {
      reason:
        isRegistryToken(rawToken) && !rawToken.startsWith(runTag)
          ? ("earlier_server" as const)
          : ("unknown" as const),
    };
  });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, (before) => {
        const current = pruneIdle(before, timestamp);
        const records = new Map(current.records);
        const tombstones = new Map(current.tombstones);
        for (const [tokenHash, tombstone] of current.tombstones) {
          if (
            tombstone.reason === "expired" &&
            tombstone.record?.scope.thread.threadId === threadId
          ) {
            records.set(tokenHash, { ...tombstone.record, lastAliveAt: timestamp });
            tombstones.delete(tokenHash);
          }
        }
        for (const [tokenHash, record] of current.records) {
          if (record.scope.thread.threadId === threadId) {
            records.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return registryState(records, tombstones);
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    Effect.flatMap(currentTimeMillis, (timestamp) =>
      SynchronizedRef.update(state, (current) => {
        const revoked = [
          ...Array.from(current.records).filter(([, record]) => predicate(record)),
          // An idle-expired record must not be renewable once its session ends.
          ...Array.from(current.tombstones).flatMap(([tokenHash, tombstone]) =>
            tombstone.record && predicate(tombstone.record)
              ? [[tokenHash, tombstone.record] as const]
              : [],
          ),
        ];
        if (revoked.length === 0) return current;
        const records = new Map(current.records);
        for (const [tokenHash] of revoked) records.delete(tokenHash);
        return registryState(
          records,
          withTombstones(
            current.tombstones,
            revoked.map(([tokenHash, record]) => [
              tokenHash,
              tombstoneOf(record, "revoked", timestamp),
            ]),
          ),
        );
      }),
    );

  return McpSessionRegistry.of({
    issue,
    resolve,
    explainRefusal,
    isRegistryToken,
    currentMemoryPolicy: (providerSessionId) =>
      Effect.gen(function* () {
        const record = (yield* SynchronizedRef.get(state)).recordsById.get(providerSessionId);
        if (!record?.readCurrentPolicy || !record.memoryPolicy || !record.isLiveCaller)
          return undefined;
        if ((yield* currentTimeMillis) - record.lastAliveAt > livenessWindowMs) return undefined;
        const current = yield* record.readCurrentPolicy();
        const latest = (yield* SynchronizedRef.get(state)).records.get(record.tokenHash);
        return latest?.generation === record.generation &&
          current?.policyEpoch === record.memoryPolicy.policyEpoch &&
          current.grant === record.memoryPolicy.grant
          ? current
          : undefined;
      }),
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.thread.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId, options) {
      yield* revokeWhere(
        (record) =>
          record.scope.thread.threadId === threadId &&
          record.scope.thread.providerSessionId !== options?.exceptProviderSessionId,
      );
    }),
    revokeAll: revokeWhere(() => true),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const __testing = {
  make: makeWithOptions,
};
